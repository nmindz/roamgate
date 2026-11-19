// Idle resident memory per extension child against the 50 MB per-mod budget;
// exits 1 when the largest child is over it.
//   bun scripts/bench-extensions-memory.ts [--mods N] [--settle-ms MS] [--binary PATH]
import { resolve } from "node:path";
import { createExtensionSandbox } from "../server/src/extensions/test-fixtures";

const BUDGET_BYTES = 50 * 1000 * 1000;
const MIB = 1024 * 1024;

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} needs a positive integer`);
  return value;
}

const mods = flag("--mods", 5);
const settleMs = flag("--settle-ms", 3_000);
// A compiled roamgate measures release children; by default they run from source.
const binaryFlag = process.argv.indexOf("--binary");
const binary = binaryFlag < 0 ? undefined : process.argv[binaryFlag + 1];
if (binaryFlag >= 0 && !binary) throw new Error("--binary needs a path");

interface Child {
  pid: number;
  rssBytes: number;
}

async function output(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${stderr}`);
  return stdout;
}

/** This process's `__ext-host` children: RSS from ps, or the Windows working set. */
async function extensionChildren(): Promise<Child[]> {
  if (process.platform === "win32") {
    const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Select-Object ProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress`;
    const text = (
      await output([
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ])
    ).trim();
    if (!text) return [];
    type Entry = {
      ProcessId: number;
      WorkingSetSize: number;
      CommandLine: string | null;
    };
    const parsed = JSON.parse(text) as Entry | Entry[];
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((entry) => entry.CommandLine?.includes("__ext-host"))
      .map((entry) => ({
        pid: entry.ProcessId,
        rssBytes: Number(entry.WorkingSetSize),
      }));
  }
  const children: Child[] = [];
  for (const line of (
    await output(["ps", "-A", "-o", "pid=,ppid=,rss=,args="])
  ).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[2]) !== process.pid) continue;
    if (!match[4]!.includes("__ext-host")) continue;
    // ps reports rss in KiB.
    children.push({ pid: Number(match[1]), rssBytes: Number(match[3]) * 1024 });
  }
  return children;
}

const sandbox = createExtensionSandbox();
try {
  const registry = sandbox.registry();
  const ids = Array.from({ length: mods }, (_, index) => `bench.idle${index}`);
  for (const id of ids)
    sandbox.link(
      id,
      `export function register(on) { on("agent.status", () => undefined); }`,
      'activation = ["startup"]',
      registry,
    );
  const { host } = sandbox.host(registry, {
    ...(binary ? { hostCommand: [resolve(binary)] } : {}),
  });
  const running = () => ids.every((id) => host.isRunning(id));
  const started = Promise.withResolvers<void>();
  const off = host.onChange(() => {
    if (running()) started.resolve();
  });
  host.start();
  if (running()) started.resolve();
  await started.promise;
  off();
  await Bun.sleep(settleMs);

  const children = await extensionChildren();
  if (children.length !== mods)
    throw new Error(
      `found ${children.length} extension children, expected ${mods}`,
    );
  const sizes = children.map((child) => child.rssBytes);
  const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
  const max = Math.max(...sizes);
  const label = process.platform === "win32" ? "working set" : "RSS";
  for (const child of children)
    console.log(`  pid ${child.pid}: ${(child.rssBytes / MIB).toFixed(1)} MiB`);
  console.log(
    `${mods} idle mods on ${process.platform}-${process.arch}, Bun ${Bun.version}: ${label} average ${(average / MIB).toFixed(1)} MiB, max ${(max / MIB).toFixed(1)} MiB (budget 50 MB = ${(BUDGET_BYTES / MIB).toFixed(1)} MiB per mod)`,
  );
  if (max > BUDGET_BYTES) {
    console.log("over budget");
    process.exitCode = 1;
  }
} finally {
  await sandbox.cleanup();
}
