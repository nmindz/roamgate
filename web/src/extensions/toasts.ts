import type { ToastSlotData } from "../../../shared/extensions";

export const MAX_EXTENSION_TOASTS = 5;

export interface QueuedToast extends ToastSlotData {
  id: number;
  ext: string;
}

/** Appends a toast, dropping the oldest beyond the cap. Core notices are unaffected. */
export function enqueueToast(
  queue: readonly QueuedToast[],
  toast: QueuedToast,
  max = MAX_EXTENSION_TOASTS,
): QueuedToast[] {
  return [...queue, toast].slice(-max);
}
