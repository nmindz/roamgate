import { describe, expect, test } from "bun:test";
import type {
  TerminalGraphicsAsset,
  TerminalGraphicsPayload,
  TerminalGraphicsPlacement,
} from "./api";
import {
  idsToEvict,
  placementRects,
  TerminalGraphicsStore,
} from "./terminalGraphics";

const placement: TerminalGraphicsPlacement = {
  asset: "a",
  x: 3,
  y: 2,
  cols: 10,
  rows: 4,
  source_x: 0,
  source_y: 0,
  source_width: 0,
  source_height: 0,
  x_offset: 0,
  y_offset: 0,
  z: 0,
};

describe("placementRects", () => {
  const cell = { width: 10, height: 20 };
  const herdrCell = { width: 8, height: 16 };
  const image = { width: 200, height: 100 };

  test("places the whole image on the cell rectangle", () => {
    expect(placementRects(placement, cell, herdrCell, image)).toEqual({
      sx: 0,
      sy: 0,
      sw: 200,
      sh: 100,
      dx: 30,
      dy: 40,
      dw: 100,
      dh: 80,
    });
  });

  test("scales in-cell pixel offsets from Herdr's cell size to the browser's", () => {
    const rects = placementRects(
      { ...placement, x_offset: 4, y_offset: 8 },
      cell,
      herdrCell,
      image,
    );
    expect(rects).toMatchObject({ dx: 35, dy: 50, dw: 95, dh: 70 });
  });

  test("crops the source and treats a zero extent as the rest of the image", () => {
    const cropped = placementRects(
      { ...placement, source_x: 50, source_y: 20, source_width: 100 },
      cell,
      herdrCell,
      image,
    );
    expect(cropped).toMatchObject({ sx: 50, sy: 20, sw: 100, sh: 80 });
  });

  test("shifts rows by the xterm scroll distance", () => {
    expect(placementRects(placement, cell, herdrCell, image, 3)?.dy).toBe(100);
  });

  test.each([
    ["offset consuming the whole width", { x_offset: 8 * 10 }],
    ["offset consuming the whole height", { y_offset: 16 * 4 }],
    ["crop origin outside the image", { source_x: 200 }],
    ["crop height outside the image", { source_y: 100 }],
  ])("skips a placement with %s", (_name, overrides) => {
    expect(
      placementRects({ ...placement, ...overrides }, cell, herdrCell, image),
    ).toBeNull();
  });
});

describe("idsToEvict", () => {
  test("returns cached ids that are not kept", () => {
    expect(idsToEvict(["a", "b", "c"], new Set(["b"]))).toEqual(["a", "c"]);
    expect(idsToEvict(["a"], new Set(["a"]))).toEqual([]);
  });
});

describe("TerminalGraphicsStore", () => {
  class FakeImage {
    closed = false;
    close() {
      this.closed = true;
    }
  }

  interface PendingDecode {
    promise: Promise<FakeImage>;
    resolve: (image: FakeImage) => void;
    calls: number;
  }

  function asset(id: string): TerminalGraphicsAsset {
    return { id, width: 1, height: 1, png: id };
  }

  function push(
    overrides: Partial<TerminalGraphicsPayload>,
  ): TerminalGraphicsPayload {
    return {
      terminal_id: "t",
      cell_width_px: 8,
      cell_height_px: 16,
      placements: [placement],
      assets: [],
      keep: [],
      ...overrides,
    };
  }

  function createStore() {
    const decodes = new Map<string, PendingDecode>();
    let changes = 0;
    const store = new TerminalGraphicsStore<FakeImage>(
      (png) => {
        const entry = decodes.get(png) ?? {
          ...Promise.withResolvers<FakeImage>(),
          calls: 0,
        };
        entry.calls++;
        decodes.set(png, entry);
        return entry.promise;
      },
      () => changes++,
    );
    const finish = async (id: string) => {
      const image = new FakeImage();
      decodes.get(id)?.resolve(image);
      await decodes.get(id)?.promise;
      await Promise.resolve();
      return image;
    };
    return { store, decodes, finish, changes: () => changes };
  }

  test("caches decoded assets, evicts dropped ids and closes their bitmaps", async () => {
    const { store, finish } = createStore();
    store.apply(push({ assets: [asset("a"), asset("b")], keep: ["a", "b"] }));
    const a = await finish("a");
    const b = await finish("b");
    expect(store.image("a")).toBe(a);

    store.apply(push({ keep: ["a"] }));
    expect(b.closed).toBe(true);
    expect(a.closed).toBe(false);
    expect(store.image("b")).toBeUndefined();
    expect(store.size).toBe(1);
  });

  test("does not decode an asset twice or one that is not kept", () => {
    const { store, decodes } = createStore();
    const payload = push({
      assets: [asset("a"), asset("skipped")],
      keep: ["a"],
    });
    store.apply(payload);
    store.apply(payload);
    expect(decodes.get("a")?.calls).toBe(1);
    expect(decodes.has("skipped")).toBe(false);
  });

  test("closes a decode that finishes after clear and never caches it", async () => {
    const { store, finish } = createStore();
    store.apply(push({ assets: [asset("a")], keep: ["a"] }));
    store.clear();
    const late = await finish("a");
    expect(late.closed).toBe(true);
    expect(store.image("a")).toBeUndefined();
    expect(store.placements).toEqual([]);
  });

  test("closes a decode whose asset was dropped before it finished", async () => {
    const { store, finish } = createStore();
    store.apply(push({ assets: [asset("a")], keep: ["a"] }));
    store.apply(push({ placements: [], keep: [] }));
    const late = await finish("a");
    expect(late.closed).toBe(true);
    expect(store.size).toBe(0);
  });

  test("an empty placement set clears drawing but keeps kept images", async () => {
    const { store, finish } = createStore();
    store.apply(push({ assets: [asset("a")], keep: ["a"] }));
    const a = await finish("a");
    store.apply(push({ placements: [], keep: ["a"] }));
    expect(store.placements).toEqual([]);
    expect(store.image("a")).toBe(a);
  });

  test("clear closes every cached image and a later push can decode again", async () => {
    const { store, finish, decodes } = createStore();
    store.apply(push({ assets: [asset("a")], keep: ["a"] }));
    const first = await finish("a");
    store.clear();
    expect(first.closed).toBe(true);
    expect(store.size).toBe(0);

    store.apply(push({ assets: [asset("a")], keep: ["a"] }));
    await decodes.get("a")?.promise;
    await Promise.resolve();
    expect(decodes.get("a")?.calls).toBe(2);
    expect(store.placements).toHaveLength(1);
  });

  test("keeps the previous scene drawn until the next scene's images decode", async () => {
    const { store, finish, changes } = createStore();
    store.apply(push({ assets: [asset("a")], keep: ["a"] }));
    const a = await finish("a");
    const shown = store.placements;
    store.apply(
      push({
        assets: [asset("b")],
        keep: ["b"],
        placements: [{ ...placement, asset: "b" }],
      }),
    );
    expect(store.placements).toBe(shown);
    expect(store.image("a")).toBe(a);
    expect(a.closed).toBe(false);
    const before = changes();
    const b = await finish("b");
    expect(store.placements[0]?.asset).toBe("b");
    expect(store.image("b")).toBe(b);
    expect(a.closed).toBe(true);
    expect(changes()).toBe(before + 1);
  });
});
