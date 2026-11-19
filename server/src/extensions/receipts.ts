import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ApprovalReceipt } from "../../../shared/extensions";
import { assertSafeDataPath } from "../config/data-paths";

/**
 * Append-only record of every decided approval, in
 * `<data>/extensions/receipts.sqlite`. Pruned to 30 days and 10,000 rows
 * when opened and hourly.
 */

export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const RECEIPT_MAX_ROWS = 10_000;
export const RECEIPT_PRUNE_INTERVAL_MS = 60 * 60_000;
export const RECEIPT_QUERY_MAX = 1_000;

export interface ReceiptQuery {
  ext?: string;
  limit?: number;
  /** Only receipts decided before this time (ms), for paging back. */
  before?: number;
}

export interface ReceiptStore {
  append(receipt: ApprovalReceipt): void;
  list(query?: ReceiptQuery): ApprovalReceipt[];
  prune(): void;
  close(): void;
}

interface ReceiptRow {
  id: string;
  ext: string;
  event: string;
  title: string;
  decision: string;
  cause: string;
  device: string | null;
  origin: string;
  connection_id: string | null;
  workspace_id: string | null;
  pane_id: string | null;
  created_at: number;
  decided_at: number;
}

function fromRow(row: ReceiptRow): ApprovalReceipt {
  return {
    id: row.id,
    ext: row.ext,
    event: row.event,
    title: row.title,
    decision: row.decision === "allow" ? "allow" : "deny",
    cause: row.cause as ApprovalReceipt["cause"],
    device: row.device,
    origin: row.origin,
    connection_id: row.connection_id,
    workspace_id: row.workspace_id,
    pane_id: row.pane_id,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

/** Opens (creating when absent) the receipts database at `path`. */
export function openReceiptStore(
  path: string,
  options: { now?: () => number; pruneEveryMs?: number | null } = {},
): ReceiptStore {
  const now = options.now ?? Date.now;
  assertSafeDataPath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  if (existsSync(path)) chmodSync(path, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS receipts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    ext TEXT NOT NULL,
    event TEXT NOT NULL,
    title TEXT NOT NULL,
    decision TEXT NOT NULL,
    cause TEXT NOT NULL,
    device TEXT,
    origin TEXT NOT NULL,
    connection_id TEXT,
    workspace_id TEXT,
    pane_id TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS receipts_decided ON receipts (decided_at);
  CREATE INDEX IF NOT EXISTS receipts_ext ON receipts (ext, decided_at);`);
  const insert = db.query(
    `INSERT INTO receipts (id, ext, event, title, decision, cause, device, origin,
      connection_id, workspace_id, pane_id, created_at, decided_at)
     VALUES ($id, $ext, $event, $title, $decision, $cause, $device, $origin,
      $connection_id, $workspace_id, $pane_id, $created_at, $decided_at)`,
  );
  let closed = false;
  const prune = () => {
    if (closed) return;
    db.query("DELETE FROM receipts WHERE decided_at < ?").run(
      now() - RECEIPT_RETENTION_MS,
    );
    db.query(
      "DELETE FROM receipts WHERE seq <= (SELECT seq FROM receipts ORDER BY seq DESC LIMIT 1 OFFSET ?)",
    ).run(RECEIPT_MAX_ROWS);
  };
  prune();
  const interval = options.pruneEveryMs ?? RECEIPT_PRUNE_INTERVAL_MS;
  const timer = interval === null ? undefined : setInterval(prune, interval);
  timer?.unref?.();

  return {
    append(receipt) {
      if (closed) return;
      insert.run({
        id: receipt.id,
        ext: receipt.ext,
        event: receipt.event,
        title: receipt.title,
        decision: receipt.decision,
        cause: receipt.cause,
        device: receipt.device,
        origin: receipt.origin,
        connection_id: receipt.connection_id,
        workspace_id: receipt.workspace_id,
        pane_id: receipt.pane_id,
        created_at: receipt.created_at,
        decided_at: receipt.decided_at,
      });
    },
    list(query = {}) {
      if (closed) return [];
      const limit = Math.max(
        1,
        Math.min(Math.floor(query.limit ?? 100), RECEIPT_QUERY_MAX),
      );
      const rows = db
        .query<ReceiptRow, [string | null, string | null, number, number]>(
          `SELECT * FROM receipts
           WHERE (?1 IS NULL OR ext = ?2) AND decided_at < ?3
           ORDER BY decided_at DESC, seq DESC LIMIT ?4`,
        )
        .all(
          query.ext ?? null,
          query.ext ?? null,
          query.before ?? Number.MAX_SAFE_INTEGER,
          limit,
        );
      return rows.map(fromRow);
    },
    prune,
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      db.close();
    },
  };
}
