import { expect, jest, test } from "bun:test";
import {
  type GraphicsKey,
  type GraphicsScene,
  graphicsKey,
  PaneGraphics,
} from "./endpoint-graphics";

const PNG_SIGNATURE = "89504e470d0a1a0a";

function image(
  fingerprint: string,
  target: GraphicsKey["target"] = { kind: "pane", paneId: "w1:p1" },
) {
  return graphicsKey(target, "1", 2, 1, "rgba", 8, fingerprint);
}

function scene(...keys: GraphicsKey[]): GraphicsScene {
  return {
    assets: keys.map((key) => ({ key, data: Buffer.alloc(8, 255) })),
    placements: keys.map((key) => ({
      key,
      x: 3,
      y: 4,
      cols: 5,
      rows: 2,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 0,
      sourceHeight: 0,
      xOffset: 0,
      yOffset: 0,
      z: 0,
    })),
    retained: [],
  };
}

test("swaps whole scenes and rides out the delete-then-place gap", async () => {
  jest.useFakeTimers();
  try {
    let clock = 0;
    let wake = () => {};
    const changed = () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      wake = resolve;
      return promise;
    };
    const graphics = new PaneGraphics(
      () => wake(),
      () => clock,
    );
    const rect = { x: 1, y: 1 };
    const update = (next: GraphicsScene, force = false) =>
      graphics.update(next, "w1:p1", rect, force);

    // Another pane's or a popup's image never reaches this pane's viewers.
    const first = image("1");
    const foreign = image("9", { kind: "pane", paneId: "w1:p2" });
    const popup = image("8", { kind: "popup", terminalId: "term" });
    let encoded = changed();
    expect(update(scene(first, foreign, popup))).toBeNull();
    await encoded;
    const shown = update(scene(first, foreign, popup))!;
    expect(shown.placements).toEqual([
      expect.objectContaining({ asset: shown.assets[0]!.id, x: 2, y: 3 }),
    ]);
    expect(
      Buffer.from(shown.assets[0]!.png, "base64")
        .subarray(0, 8)
        .toString("hex"),
    ).toBe(PNG_SIGNATURE);
    expect(update(scene(first))).toBeNull();
    expect(update(scene(first), true)).toEqual(shown);

    // A Kitty program deletes before placing the replacement; viewers keep
    // the old image until the new one is encoded.
    expect(update(scene())).toBeNull();
    const second = image("2");
    encoded = changed();
    expect(update(scene(second))).toBeNull();
    await encoded;
    const replaced = update(scene(second))!;
    expect(replaced.placements).toHaveLength(1);
    expect(replaced.keep).toEqual([replaced.assets[0]!.id]);
    expect(replaced.assets[0]!.id).not.toBe(shown.assets[0]!.id);

    // A scene that stays empty clears once the grace period ends.
    expect(update(scene())).toBeNull();
    const cleared = changed();
    clock += 500;
    jest.advanceTimersByTime(500);
    await cleared;
    expect(update(scene())).toEqual({ placements: [], assets: [], keep: [] });
    graphics.dispose();
  } finally {
    jest.useRealTimers();
  }
});
