import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientOptions, MoneyLover } from "../client/index.js";
import { Ledger } from "../core/ledger.js";
import { filterCategory, filterTransactions } from "../core/query.js";
import type { Category, Transaction, TransactionQuery } from "../core/types.js";
import type { Rendering } from "./tools/transactions.js";

export interface ILedgerOptions extends ClientOptions {
  ledgerPath?: string | false;
}

interface IRow {
  id: string;
  raw: Transaction;
  view: Record<string, unknown>;
}

export function createLedger(options: ILedgerOptions): Ledger | undefined {
  if (options.ledgerPath === false || (options.use && !options.ledgerPath)) return undefined;
  const email = options.email ?? process.env.MONEYLOVER_EMAIL;
  const token =
    options.mobileToken ??
    options.token ??
    process.env.MONEYLOVER_MOBILE_TOKEN ??
    process.env.MONEYLOVER_ACCESS_TOKEN;
  const path = options.ledgerPath ?? process.env.MONEYLOVER_LEDGER_PATH;
  if (!path && !email && !token) return undefined;
  const identity = JSON.stringify([
    options.backend ?? process.env.MONEYLOVER_BACKEND ?? "mobile",
    email?.toLowerCase(),
    token,
  ]);
  const key = createHash("sha256").update(identity).digest("hex");
  return new Ledger(
    path ??
      join(
        process.env.MONEYLOVER_CONFIG_DIR ??
          process.env.XDG_CONFIG_HOME ??
          join(homedir(), ".config"),
        "moneylover-kit",
        "ledgers",
        `${key}.sqlite`,
      ),
    30_000,
    Date.now,
    key,
  );
}

export function observeWrites(client: MoneyLover, ledger?: Ledger): MoneyLover {
  if (!ledger) return client;
  const writes = new Set<keyof MoneyLover>([
    "addTransaction",
    "addTransactions",
    "editTransaction",
    "deleteTransaction",
    "retag",
    "recordLending",
    "collectLoan",
    "addWallet",
    "editWallet",
    "deleteWallet",
    "addCategory",
    "editCategory",
    "deleteCategory",
    "addEvent",
  ]);
  return new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function" || !writes.has(key as keyof MoneyLover)) return value;
      return async (...args: unknown[]) => {
        ledger.invalidate();
        try {
          return await Reflect.apply(value, target, args);
        } finally {
          ledger.invalidate();
        }
      };
    },
  });
}

export function createLocalReads(client: MoneyLover, show: Rendering, ledger?: Ledger) {
  async function snapshot(wallet: string | undefined, fresh: boolean) {
    const load = () =>
      client.withFreshReads(async () => {
        const rows = await client.transactions(wallet ? { wallet } : {});
        const views = await show(rows);
        const categories = await client.categories(wallet);
        return {
          rows: rows.map((raw, index) => ({ id: raw.id, raw, view: views[index] ?? {} })),
          metadata: { categories },
        };
      });
    if (ledger)
      return ledger.read<IRow, { categories: Category[] }>(
        wallet ? `wallet:${wallet}` : "account",
        load,
        fresh,
      );
    return {
      ...(await load()),
      sync: {
        source: "api" as const,
        lastSyncedAt: new Date().toISOString(),
        stale: false,
        refreshing: false,
      },
    };
  }
  return {
    async value<T>(scope: string, load: () => Promise<T>, fresh: boolean) {
      if (ledger) return ledger.value(scope, () => client.withFreshReads(load), fresh);
      return {
        value: await client.withFreshReads(load),
        sync: {
          source: "api" as const,
          lastSyncedAt: new Date().toISOString(),
          stale: false,
          refreshing: false,
        },
      };
    },
    async search(query: TransactionQuery, limit: number, fresh: boolean) {
      const saved = await snapshot(query.wallet, fresh);
      const { category, wallet: _wallet, ...filters } = query;
      let rows = saved.rows.map((row) => row.raw);
      if (category) rows = filterCategory(rows, saved.metadata.categories, category);
      const all = filterTransactions(rows, filters);
      const views = new Map(saved.rows.map((row) => [row.id, row.view]));
      return {
        matched: all.length,
        returned: Math.min(all.length, limit),
        transactions: all.slice(0, limit).map((row) => views.get(row.id)),
        sync: saved.sync,
      };
    },
    async get(ids: string[], wallet: string | undefined, fresh: boolean) {
      let saved = await snapshot(wallet, fresh);
      if (
        !fresh &&
        saved.sync.source === "ledger" &&
        ids.some((id) => !saved.rows.some((row) => row.id === id))
      )
        saved = await snapshot(wallet, true);
      return {
        transactions: ids.map((id) => {
          const row = saved.rows.find((candidate) => candidate.id === id);
          if (!row) throw new Error(`No transaction ${id} in the requested scope`);
          return row.view;
        }),
        sync: saved.sync,
      };
    },
  };
}
