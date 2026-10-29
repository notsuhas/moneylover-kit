import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthOptions } from "../../auth.js";
import type { PullOptions, PullResult } from "./sync.js";
import type { RawTransaction } from "./transactions.js";

interface StoredTransactions {
  version?: 2;
  timestamp: number;
  rows: RawTransaction[];
}

function storePath(email: string): string {
  const base =
    process.env.MONEYLOVER_CONFIG_DIR ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const who = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);
  return join(base, "moneylover-kit", `mobile-transactions-${who}.json`);
}

function write(path: string | undefined, state: StoredTransactions): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...state, version: 2 }), { mode: 0o600 });
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

  let inFlight: Promise<RawTransaction[]> | undefined;

  async function sync(): Promise<RawTransaction[]> {
    const update = await pull(0, { skip: 0 });
    const rows = mergeTransactions([], update.data);
    write(path, { timestamp: update.timestamp, rows });
    return rows;
  }

  return {
    sync() {
      inFlight ??= sync().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
