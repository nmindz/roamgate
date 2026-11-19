import { describe, expect, test } from "bun:test";
import { enqueueToast, MAX_EXTENSION_TOASTS, type QueuedToast } from "./toasts";

const toast = (id: number): QueuedToast => ({
  id,
  ext: "acme.ci",
  kind: "info",
  message: `toast ${id}`,
});

describe("extension toast queue", () => {
  test("keeps arrival order below the cap", () => {
    let queue: QueuedToast[] = [];
    for (const id of [1, 2, 3]) queue = enqueueToast(queue, toast(id));
    expect(queue.map((item) => item.id)).toEqual([1, 2, 3]);
  });

  test("never holds more than five, dropping the oldest", () => {
    expect(MAX_EXTENSION_TOASTS).toBe(5);
    let queue: QueuedToast[] = [];
    for (let id = 1; id <= 8; id++) queue = enqueueToast(queue, toast(id));
    expect(queue.map((item) => item.id)).toEqual([4, 5, 6, 7, 8]);
  });

  test("does not mutate the previous queue", () => {
    const first = [toast(1)];
    enqueueToast(first, toast(2));
    expect(first).toHaveLength(1);
  });
});
