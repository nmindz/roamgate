// Hooks follow the command-hook contract: printing nothing and exiting 0
// means "no opinion", so this audit never blocks a close.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const event = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
const dir = process.env.ROAMGATE_EXTENSION_DATA;
if (dir) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, "closes.log"),
    `${new Date().toISOString()} ${event.origin} ${event.pane_id ?? "-"}\n`,
  );
}
