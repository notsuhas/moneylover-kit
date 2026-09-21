import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthOptions } from "../../auth.js";
import type { PullOptions, PullResult } from "./sync.js";
import type { RawTransaction } from "./transactions.js";

interface StoredTransactions {
  timestamp: number;
  rows: RawTransaction[];
  pending?: { nextSkip: number; timestamp: number };
}

function storePath(email: string): string {
  const base =
    process.env.MONEYLOVER_CONFIG_DIR ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const who = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);
  return join(base, "moneylover-kit", `mobile-transactions-${who}.json`);
}

function read(path: string | undefined): StoredTransactions {
  if (!path) return { timestamp: 0, rows: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredTransactions;
  } catch {
    return { timestamp: 0, rows: [] };
  }
}

function write(path: string | undefined, state: StoredTransactions): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function mergeTransactions(
  existing: RawTransaction[],
  changes: RawTransaction[],
): RawTransaction[] {
  const rows = new Map(existing.map((row) => [row._id, row]));
  for (const row of changes) {
    if (row.isDelete) rows.delete(row._id);
    else rows.set(row._id, row);
  }
  return [...rows.values()];
}

export function createTransactionStore(
  auth: Omit<AuthOptions, "backend">,
  pull: (
    lastUpdate: number,
    options: PullOptions<RawTransaction>,
  ) => Promise<PullResult<RawTransaction>>,
): { sync(): Promise<RawTransaction[]> } {
  const email = auth.email ?? process.env.MONEYLOVER_EMAIL;
  const path = email ? storePath(email) : undefined;

  return {
    async sync(): Promise<RawTransaction[]> {
      const current = read(path);
      let rows = current.rows;
      let checkpoint = current.pending?.timestamp;
      const update = await pull(current.timestamp, {
        skip: current.pending?.nextSkip ?? 0,
        onPage(chunk, state) {
          rows = mergeTransactions(rows, chunk);
          checkpoint ??= state.timestamp;
          write(path, {
            timestamp: current.timestamp,
            rows,
            pending: { nextSkip: state.nextSkip, timestamp: checkpoint },
          });
        },
      });
      if (!path) rows = mergeTransactions(rows, update.data);
      write(path, { timestamp: checkpoint ?? update.timestamp, rows });
      return rows;
    },
  };
}
