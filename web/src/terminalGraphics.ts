import type {
  TerminalGraphicsAsset,
  TerminalGraphicsPayload,
  TerminalGraphicsPlacement,
  TerminalGraphicsSuppressedRect,
} from "./api";

export interface GraphicsSize {
  width: number;
  height: number;
}

export interface GraphicsRects {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Source and destination rectangles (destination in CSS px, relative to the
 * terminal grid) for one placement. `cell` is the browser's xterm cell size;
 * `graphicsCell` is the cell size Herdr measured the pixel offsets in.
 * Returns null when nothing visible remains.
 */
export function placementRects(
  placement: TerminalGraphicsPlacement,
  cell: GraphicsSize,
  graphicsCell: GraphicsSize,
  image: GraphicsSize,
  scrollRows = 0,
): GraphicsRects | null {
  const scaleX = cell.width / graphicsCell.width;
  const scaleY = cell.height / graphicsCell.height;
  const offsetX = placement.x_offset * scaleX;
  const offsetY = placement.y_offset * scaleY;
  const dw = placement.cols * cell.width - offsetX;
  const dh = placement.rows * cell.height - offsetY;
  const sx = placement.source_x;
  const sy = placement.source_y;
  const sw = placement.source_width || image.width - sx;
  const sh = placement.source_height || image.height - sy;
  if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return null;
  if (sx >= image.width || sy >= image.height) return null;
  return {
    sx,
    sy,
    sw,
    sh,
    dx: placement.x * cell.width + offsetX,
    dy: (placement.y + scrollRows) * cell.height + offsetY,
    dw,
    dh,
  };
}

export interface PlaceholderBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const PLACEHOLDER_MIN_COLS = 20;
const PLACEHOLDER_MIN_ROWS = 3;

/**
 * CSS-px box for the "graphics hidden" placeholder: the suppressed cell rect
 * clipped to the grid with the same cell math as images, or the whole screen
 * when the rect is too small to read. Null when it is scrolled out of view.
 */
export function suppressedBox(
  rect: TerminalGraphicsSuppressedRect,
  grid: { cols: number; rows: number },
  cell: GraphicsSize,
  scrollRows = 0,
): PlaceholderBox | null {
  if (rect.cols < PLACEHOLDER_MIN_COLS || rect.rows < PLACEHOLDER_MIN_ROWS) {
    return {
      left: 0,
      top: 0,
      width: grid.cols * cell.width,
      height: grid.rows * cell.height,
    };
  }
  const x0 = Math.max(0, rect.x);
  const x1 = Math.min(grid.cols, rect.x + rect.cols);
  const y0 = Math.max(0, rect.y + scrollRows);
  const y1 = Math.min(grid.rows, rect.y + scrollRows + rect.rows);
  if (x1 <= x0 || y1 <= y0) return null;
  return {
    left: x0 * cell.width,
    top: y0 * cell.height,
    width: (x1 - x0) * cell.width,
    height: (y1 - y0) * cell.height,
  };
}

/** Cached ids absent from `keep`. */
export function idsToEvict(
  cachedIds: Iterable<string>,
  keep: ReadonlySet<string>,
): string[] {
  const evict: string[] = [];
  for (const id of cachedIds) if (!keep.has(id)) evict.push(id);
  return evict;
}

interface Closable {
  close(): void;
}

/**
 * Decoded-image cache plus the latest placement set for one terminal view.
 * Decoding is asynchronous; `clear()` bumps a generation so a decode that
 * finishes afterwards is closed instead of resurrected.
 */
export class TerminalGraphicsStore<Image extends Closable> {
  placements: readonly TerminalGraphicsPlacement[] = [];
  /** Cell rect of images withheld because Kitty graphics are disabled. */
  suppressed: TerminalGraphicsSuppressedRect | null = null;
  graphicsCell: GraphicsSize = { width: 1, height: 1 };
  private readonly images = new Map<string, Image>();
  private readonly pending = new Set<string>();
  private keep: ReadonlySet<string> = new Set();
  private generation = 0;
  // Newest push, applied once its assets decode so the old images stay drawn.
  private staged: TerminalGraphicsPayload | null = null;

  constructor(
    private readonly decode: (png: string) => Promise<Image>,
    private readonly changed: () => void,
  ) {}

  get size(): number {
    return this.images.size;
  }

  image(id: string): Image | undefined {
    return this.images.get(id);
  }

  apply(push: TerminalGraphicsPayload): void {
    this.staged = push;
    this.keep = new Set(push.keep);
    for (const asset of push.assets) this.load(asset);
    this.commitIfReady();
  }

  private commitIfReady(): void {
    const push = this.staged;
    if (!push || push.placements.some((p) => this.pending.has(p.asset))) return;
    this.staged = null;
    this.placements = push.placements;
    this.suppressed = push.suppressed ?? null;
    this.graphicsCell = {
      width: push.cell_width_px,
      height: push.cell_height_px,
    };
    for (const id of idsToEvict(this.images.keys(), this.keep)) {
      this.images.get(id)?.close();
      this.images.delete(id);
    }
    this.changed();
  }

  clear(): void {
    this.generation++;
    for (const image of this.images.values()) image.close();
    this.images.clear();
    this.pending.clear();
    this.staged = null;
    this.keep = new Set();
    this.placements = [];
    this.suppressed = null;
    this.changed();
  }

  private load(asset: TerminalGraphicsAsset): void {
    const { id } = asset;
    if (!this.keep.has(id) || this.images.has(id) || this.pending.has(id)) {
      return;
    }
    const generation = this.generation;
    this.pending.add(id);
    this.decode(asset.png).then(
      (image) => {
        if (generation !== this.generation) {
          image.close();
          return;
        }
        this.pending.delete(id);
        if (!this.keep.has(id) || this.images.has(id)) image.close();
        else this.images.set(id, image);
        if (this.staged) this.commitIfReady();
        else this.changed();
      },
      () => {
        // An undecodable asset leaves its placements skipped.
        if (generation !== this.generation) return;
        this.pending.delete(id);
        this.commitIfReady();
      },
    );
  }
}

export async function decodePngBase64(png: string): Promise<ImageBitmap> {
  const binary = atob(png);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return createImageBitmap(new Blob([bytes], { type: "image/png" }));
}
