// Gate latency benchmark: 200 `pane.close` actions with one allowing gate,
// compared with the same actions ungated. Prints p50/p95 added latency and
// exits 1 when p95 exceeds 20 ms.
//   bun scripts/bench-extensions-gate.ts [--runs N]
import { gateRpcAction } from "../server/src/extensions/action-events";
import { createExtensionSandbox } from "../server/src/extensions/test-fixtures";

const BUDGET_MS = 20;
const runsFlag = process.argv.indexOf("--runs");
const runs = runsFlag > 0 ? Number(process.argv[runsFlag + 1]) : 200;

function percentile(sorted: number[], p: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ]!;
}

const sandbox = createExtensionSandbox();
try {
  const registry = sandbox.registry();
  sandbox.link(
    "bench.allow",
    `export function register(on) { on("pane.close", () => ({ decision: "allow" })); }`,
    'activation = ["event:pane.close"]\ncapabilities = ["gates"]',
    registry,
  );
  const { host, bus } = sandbox.host(registry);
  host.start();
  const connection = { id: "bench", generation: 1 };
  // Warm-up activates the mod; activation is not part of the per-action cost.
  await gateRpcAction(connection, "pane.close", { pane_id: "warm" }, { bus });

  const time = async (gated: boolean) => {
    const samples: number[] = [];
    for (let index = 0; index < runs; index++) {
      const started = performance.now();
      await gateRpcAction(
        connection,
        "pane.close",
        { pane_id: `p${index}` },
        { bus: gated ? bus : null },
      );
      samples.push(performance.now() - started);
    }
    return samples.sort((a, b) => a - b);
  };
  const baseline = await time(false);
  const gated = await time(true);
  const added = gated.map((value, index) => value - baseline[index]!);
  added.sort((a, b) => a - b);
  const p50 = percentile(added, 50);
  const p95 = percentile(added, 95);
  console.log(
    `pane.close x${runs}, one allowing gate: added latency p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms (budget ${BUDGET_MS} ms)`,
  );
  if (p95 > BUDGET_MS) process.exitCode = 1;
} finally {
  await sandbox.cleanup();
}
