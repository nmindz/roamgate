import { trackSshProcess } from "../bridge/ssh-metrics";
import { runSshCommand } from "../bridge/ssh-sessions";

export async function runProcess(
  argv: string[],
  input?: string,
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { code, stdout, stderr } =
    options.timeoutMs !== undefined && input === undefined
      ? await runProcessWithCodeTimeout(argv, options.timeoutMs)
      : await runProcessWithCode(argv, input);
  if (code !== 0) {
    throw new Error(
      `${argv[0]} exited ${code}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return { stdout, stderr };
}

export async function runProcessWithCode(
  argv: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runSshCommand(argv, (argv) => spawnWithCode(argv, input));
}

async function spawnWithCode(
  argv: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrText = new Response(proc.stderr).text();
  trackSshProcess(argv, proc.exited, stderrText);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    stderrText,
  ]);
  return { code, stdout, stderr };
}

export type ProcessRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is otherwise closed. */
  input?: string;
  /** Past this many bytes on stdout or stderr the process is killed. */
  maxOutputBytes?: number;
};

export type ProcessRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when output hit maxOutputBytes; the text is cut at the cap. */
  truncated?: boolean;
};

export async function runProcessWithCodeTimeout(
  argv: string[],
  timeoutMs: number,
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  return runSshCommand(
    argv,
    (argv, remainingMs) =>
      spawnWithCodeTimeout(argv, remainingMs ?? timeoutMs, options),
    { timeoutMs },
  );
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onOverflow: () => void,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (size + chunk.byteLength > limit) {
      chunks.push(chunk.subarray(0, limit - size));
      onOverflow();
      return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
    }
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

async function spawnWithCodeTimeout(
  argv: string[],
  timeoutMs: number,
  { input, maxOutputBytes, ...spawnOptions }: ProcessRunOptions,
): Promise<ProcessRunResult> {
  const proc = Bun.spawn(argv, {
    ...spawnOptions,
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = () => {
    try {
      proc.kill();
    } catch {}
  };
  const read = (stream: ReadableStream<Uint8Array>) =>
    maxOutputBytes === undefined
      ? new Response(stream).text().then((text) => ({ text, truncated: false }))
      : readCapped(stream, maxOutputBytes, kill);
  const stderrRead = read(proc.stderr);
  trackSshProcess(
    argv,
    proc.exited,
    stderrRead.then(({ text }) => text),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const output = Promise.all([proc.exited, read(proc.stdout), stderrRead]).then(
    ([code, stdout, stderr]) => {
      clearTimeout(timer);
      const truncated = stdout.truncated || stderr.truncated;
      return {
        code,
        stdout: stdout.text,
        stderr: stderr.text,
        ...(truncated ? { truncated } : {}),
      };
    },
  );
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      kill();
      reject(new Error(`${argv[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([output, timeout]);
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
