import type { Logger } from "./logger";

const CHECK_INTERVAL_MS = 250;
// Herdr closes control connections that send nothing for five seconds, so a
// stall of one second is already visible as slow navigation.
const STALL_THRESHOLD_MS = 1_000;

/** Browser RPCs between dispatch and settlement, for stall reports. */
export function createInFlightRpcs() {
  const active = new Map<number, { method: string; startedAt: number }>();
  let sequence = 0;
  return {
    begin(method: string | null): () => void {
      const id = ++sequence;
      active.set(id, {
        method: method ?? "unknown",
        startedAt: performance.now(),
      });
      return () => {
        active.delete(id);
      };
    },
    snapshot() {
      const at = performance.now();
      const methods: Record<string, number> = {};
      let oldest = 0;
      for (const { method, startedAt } of active.values()) {
        methods[method] = (methods[method] ?? 0) + 1;
        oldest = Math.max(oldest, at - startedAt);
      }
      return {
        rpcs_in_flight: active.size,
        rpc_methods: methods,
        oldest_rpc_ms: Math.round(oldest),
      };
    },
  };
}

/** Warn once the event loop resumes after being blocked past the threshold. */
export function startEventLoopStallMonitor(options: {
  logger: Logger;
  context: () => Record<string, unknown>;
}): () => void {
  let last = performance.now();
  const timer = setInterval(() => {
    const at = performance.now();
    const stalled = at - last - CHECK_INTERVAL_MS;
    last = at;
    if (stalled < STALL_THRESHOLD_MS) return;
    options.logger.warn("event loop stalled", {
      stall_ms: Math.round(stalled),
      rss_mb: Math.round(process.memoryUsage().rss / 1_048_576),
      ...options.context(),
    });
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
