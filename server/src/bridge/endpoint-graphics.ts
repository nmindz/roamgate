import { deflate } from "node:zlib";
import type { SurfaceReader } from "./endpoint-surface";

/**
 * Nominal cell size announced to Herdr. Herdr builds no graphics scene for a
 * client with an unknown cell size; browsers rescale to their own cells.
 */
export const ENDPOINT_CELL_PX = { width: 8, height: 16 } as const;

const MAX_SCENE_ITEMS = 65_536;
const MAX_SCENE_ASSETS = 4_096;
const FORMATS = ["rgb", "rgba", "png"] as const;
export type GraphicsFormat = (typeof FORMATS)[number];

export type GraphicsTarget =
  | { kind: "pane"; paneId: string }
  | { kind: "popup"; terminalId: string }
  | { kind: "layer"; paneId: string };

export interface GraphicsKey {
  /** Herdr's complete key; equal ids denote the same image bytes. */
  id: string;
  target: GraphicsTarget;
  width: number;
  height: number;
  format: GraphicsFormat;
  dataLength: number;
}

export interface GraphicsPlacement {
  key: GraphicsKey;
  x: number;
  y: number;
  cols: number;
  rows: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  xOffset: number;
  yOffset: number;
  z: number;
}

/**
 * Placements and retained keys are complete; assets are only the bytes this
 * connection has not received before.
 */
export interface GraphicsScene {
  assets: { key: GraphicsKey; data: Buffer }[];
  placements: GraphicsPlacement[];
  retained: GraphicsKey[];
}

export const EMPTY_GRAPHICS: GraphicsScene = {
  assets: [],
  placements: [],
  retained: [],
};

export function graphicsKey(
  target: GraphicsTarget,
  imageId: string,
  width: number,
  height: number,
  format: GraphicsFormat,
  dataLength: number,
  fingerprint: string,
): GraphicsKey {
  const owner = target.kind === "popup" ? target.terminalId : target.paneId;
  const id = JSON.stringify([
    target.kind,
    owner,
    imageId,
    width,
    height,
    format,
    dataLength,
    fingerprint,
  ]);
  return { id, target, width, height, format, dataLength };
}

export function graphicsFormat(index: number): GraphicsFormat {
  const format = FORMATS[index];
  if (!format) throw new Error("Invalid endpoint surface: graphics format");
  return format;
}

function readKey(r: SurfaceReader): GraphicsKey {
  let target: GraphicsTarget;
  let imageId: string;
  if (r.number(1) === 0) {
    const pane = r.number(1) === 0;
    const owner = r.string();
    imageId = String(r.number(0xffffffff));
    target = pane
      ? { kind: "pane", paneId: owner }
      : { kind: "popup", terminalId: owner };
  } else {
    target = { kind: "layer", paneId: r.string() };
    imageId = r.string();
  }
  const width = r.number(0xffffffff);
  const height = r.number(0xffffffff);
  const format = graphicsFormat(r.number(2));
  const dataLength = r.number();
  const fingerprint = r.varintBig().toString();
  return graphicsKey(
    target,
    imageId,
    width,
    height,
    format,
    dataLength,
    fingerprint,
  );
}

function zigzag(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

/** Decodes SurfaceGraphicsScene, the last field of every full surface. */
export function readGraphicsScene(
  r: SurfaceReader,
  metadata: boolean,
): GraphicsScene {
  const assets: GraphicsScene["assets"] = [];
  const assetCount = r.count(metadata ? MAX_SCENE_ASSETS : MAX_SCENE_ITEMS);
  for (let i = 0; i < assetCount; i++) {
    const key = readKey(r);
    const data = r.bytes();
    // Herdr's own client drops bytes that disagree with their key.
    if (data.length === key.dataLength) assets.push({ key, data });
  }
  const placements: GraphicsPlacement[] = [];
  const placementCount = r.count(MAX_SCENE_ITEMS);
  for (let i = 0; i < placementCount; i++) {
    const key = readKey(r);
    r.number(0xffffffff); // logical placement id
    placements.push({
      key,
      x: r.number(65535),
      y: r.number(65535),
      cols: r.number(0xffffffff),
      rows: r.number(0xffffffff),
      sourceX: r.number(0xffffffff),
      sourceY: r.number(0xffffffff),
      sourceWidth: r.number(0xffffffff),
      sourceHeight: r.number(0xffffffff),
      xOffset: r.number(0xffffffff),
      yOffset: r.number(0xffffffff),
      z: zigzag(r.number(0xffffffff)),
    });
    r.number(0xffffffff); // scrollback offset: change detection only
  }
  const retained: GraphicsKey[] = [];
  const retainedCount = r.count(MAX_SCENE_ITEMS);
  for (let i = 0; i < retainedCount; i++) retained.push(readKey(r));
  return { assets, placements, retained };
}

export function hasGraphics(scene: GraphicsScene): boolean {
  return (
    scene.assets.length + scene.placements.length + scene.retained.length > 0
  );
}

/** Pane-relative placement sent to browsers; field names are the wire contract. */
export interface ViewPlacement {
  asset: string;
  x: number;
  y: number;
  cols: number;
  rows: number;
  source_x: number;
  source_y: number;
  source_width: number;
  source_height: number;
  x_offset: number;
  y_offset: number;
  z: number;
}

export interface EncodedAsset {
  id: string;
  width: number;
  height: number;
  /** base64 PNG */
  png: string;
}

/** Cell bounding box of a pane's images, sent instead of them when disabled. */
export interface SuppressedArea {
  x: number;
  y: number;
  cols: number;
  rows: number;
}

export interface PaneGraphicsView {
  placements: ViewPlacement[];
  assets: EncodedAsset[];
  keep: string[];
  suppressed: SuppressedArea | null;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(
    Bun.hash.crc32(out.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return out;
}

/** RGB/RGBA pixels to PNG; zlib runs off the event loop. */
export async function encodePng(
  key: Pick<GraphicsKey, "width" | "height" | "format">,
  data: Buffer,
): Promise<Buffer> {
  if (key.format === "png") return data;
  const channels = key.format === "rgba" ? 4 : 3;
  const stride = key.width * channels;
  if (key.width < 1 || key.height < 1 || data.length !== stride * key.height)
    throw new Error("image size does not match its pixel data");
  const rows = Buffer.allocUnsafe(key.height * (stride + 1));
  for (let y = 0; y < key.height; y++) {
    const at = y * (stride + 1);
    rows[at] = 0; // filter: none
    data.copy(rows, at + 1, y * stride, (y + 1) * stride);
  }
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  deflate(rows, (error, compressed) =>
    error ? reject(error) : resolve(compressed),
  );
  const header = Buffer.alloc(13);
  header.writeUInt32BE(key.width, 0);
  header.writeUInt32BE(key.height, 4);
  header[8] = 8; // bit depth
  header[9] = channels === 4 ? 6 : 2; // RGBA / RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", await promise),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Process-unique so a restarted stream never reuses an id a browser cached.
const ASSET_ID_PREFIX = crypto.randomUUID().slice(0, 8);
let assetSequence = 0;

const EMPTY_SIGNATURE = "[[],[],null]";
// Kitty programs delete an image before placing its replacement, and Herdr
// publishes that instant (~100 ms for herdr-browser). Viewers keep the old
// image unless the scene stays empty this long.
const EMPTY_GRACE_MS = 500;

/**
 * Tracks one pane's images across a stream: keeps raw bytes until they are
 * PNG-encoded (one at a time, newest scene first), drops images Herdr no
 * longer places or retains, and reports a view only when it changes.
 */
export class PaneGraphics {
  private raw = new Map<string, { key: GraphicsKey; data: Buffer }>();
  private encoded = new Map<string, EncodedAsset>();
  private encoding = false;
  private wanted: string[] = [];
  private signature = EMPTY_SIGNATURE;
  private forcePending = false;
  private emptySince: number | null = null;
  private emptyTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  /** `onChange` re-runs `update` with the latest scene. */
  constructor(
    private onChange: () => void,
    private now = () => performance.now(),
  ) {}

  update(
    scene: GraphicsScene,
    paneId: string,
    rect: { x: number; y: number } | null,
    force: boolean,
    enabled = true,
  ): PaneGraphicsView | null {
    this.forcePending ||= force;
    const owns = (key: GraphicsKey) =>
      key.target.kind === "pane" && key.target.paneId === paneId;
    for (const asset of scene.assets)
      if (owns(asset.key) && !this.encoded.has(asset.key.id))
        this.raw.set(asset.key.id, asset);
    const placed = rect
      ? scene.placements.filter(
          (p) => owns(p.key) && p.x >= rect.x && p.y >= rect.y,
        )
      : [];
    const live = new Set(placed.map((p) => p.key.id));
    for (const key of scene.retained) if (owns(key)) live.add(key.id);
    for (const id of this.raw.keys()) if (!live.has(id)) this.raw.delete(id);
    for (const id of this.encoded.keys())
      if (!live.has(id)) this.encoded.delete(id);
    // Disabled panes keep raw bytes: Herdr never resends a delivered image.
    this.wanted = enabled ? placed.map((p) => p.key.id) : [];
    this.pump();
    // Swap scenes whole: never drop to fewer images while one still encodes.
    if (enabled && placed.some((p) => this.raw.has(p.key.id))) return null;

    const placements: ViewPlacement[] = [];
    const assets = new Map<string, EncodedAsset>();
    for (const p of enabled ? placed.toSorted((a, b) => a.z - b.z) : []) {
      const asset = this.encoded.get(p.key.id);
      if (!asset) continue;
      assets.set(asset.id, asset);
      placements.push({
        asset: asset.id,
        x: p.x - rect!.x,
        y: p.y - rect!.y,
        cols: p.cols,
        rows: p.rows,
        source_x: p.sourceX,
        source_y: p.sourceY,
        source_width: p.sourceWidth,
        source_height: p.sourceHeight,
        x_offset: p.xOffset,
        y_offset: p.yOffset,
        z: p.z,
      });
    }
    const keep = enabled
      ? [...this.encoded.values()].map((asset) => asset.id)
      : [];
    const suppressed =
      !enabled && placed.length > 0 ? boundingBox(placed, rect!) : null;
    const signature = JSON.stringify([placements, keep, suppressed]);
    if (
      placements.length > 0 ||
      suppressed ||
      this.signature === EMPTY_SIGNATURE
    ) {
      this.emptySince = null;
      clearTimeout(this.emptyTimer);
      this.emptyTimer = undefined;
    } else {
      this.emptySince ??= this.now();
      const wait = this.emptySince + EMPTY_GRACE_MS - this.now();
      if (wait > 0) {
        this.emptyTimer ??= setTimeout(() => {
          this.emptyTimer = undefined;
          if (!this.disposed) this.onChange();
        }, wait);
        return null;
      }
    }
    if (
      signature === this.signature &&
      (!this.forcePending || signature === EMPTY_SIGNATURE)
    )
      return null;
    this.signature = signature;
    this.forcePending = false;
    return { placements, assets: [...assets.values()], keep, suppressed };
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.emptyTimer);
    this.raw.clear();
    this.encoded.clear();
  }

  private pump() {
    if (this.encoding || this.disposed) return;
    const id = this.wanted.find((key) => this.raw.has(key));
    const asset = id === undefined ? undefined : this.raw.get(id);
    if (!asset) return;
    this.encoding = true;
    void encodePng(asset.key, asset.data)
      .then(
        (png) => {
          if (this.disposed || this.raw.get(asset.key.id) !== asset) return;
          this.raw.delete(asset.key.id);
          this.encoded.set(asset.key.id, {
            id: `${ASSET_ID_PREFIX}-${++assetSequence}`,
            width: asset.key.width,
            height: asset.key.height,
            png: png.toString("base64"),
          });
          this.onChange();
        },
        () => {
          // Herdr never resends a delivered key, so a retry would spin forever.
          if (this.raw.get(asset.key.id) !== asset) return;
          this.raw.delete(asset.key.id);
          if (!this.disposed) this.onChange();
        },
      )
      .finally(() => {
        this.encoding = false;
        this.pump();
      });
  }
}

function boundingBox(
  placed: GraphicsPlacement[],
  rect: { x: number; y: number },
): SuppressedArea {
  const left = Math.min(...placed.map((p) => p.x));
  const top = Math.min(...placed.map((p) => p.y));
  const right = Math.max(...placed.map((p) => p.x + Math.max(1, p.cols)));
  const bottom = Math.max(...placed.map((p) => p.y + Math.max(1, p.rows)));
  return {
    x: left - rect.x,
    y: top - rect.y,
    cols: right - left,
    rows: bottom - top,
  };
}
