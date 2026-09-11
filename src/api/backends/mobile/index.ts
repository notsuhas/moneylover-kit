/**
 * The mobile backend — `revoapi.moneylover.me`, the Android app's own API.
 *
 * Opt-in, because it needs the app's OAuth client (see src/auth.ts). Worth the
 * setup: it is a sync protocol whose writes fail safe, it has no wrong-id hang,
 * and it exposes the `label` layer, which is the only way to make a category
 * global or nested. It does not report wallet balances.
 */

import { randomUUID } from "node:crypto";
import { type Cache, createCache } from "../../../core/cache.js";
import {
  kind,
  normaliseEvent,
  normaliseTransaction,
  normaliseWallet,
  type WireWallet,
} from "../../../core/normalise.js";
import { findCategory, findWallet, signedAmount } from "../../../core/query.js";
import type { RetagEntry } from "../../../core/types.js";
import {
  type Account,
  type Backend,
  type Category,
  type Event,
  type Label,
  MoneyLoverError,
  type NewTransaction,
  type Transaction,
  type TransactionPatch,
  type Wallet,
} from "../../../core/types.js";
import type { AuthOptions } from "../../auth.js";
import { unwrap } from "../../http.js";
import { createEvents } from "./events.js";
import { createStructure } from "./structure.js";
import { createSync } from "./sync.js";
import { itemFrom, type PushItem, type RawTransaction } from "./transactions.js";

interface RawCategory {
  _id: string;
  name: string;
  icon: string;
  type: 1 | 2;
  metadata?: string;
  account: { _id: string };
  isDelete?: boolean;
  /** Nesting, per wallet. A full-replace edit has to resend this. */
  parent?: { _id: string } | null;
  group?: number;
}

interface RawLabel {
  _id: string;
  name: string;
  icon: string;
  type: 1 | 2;
  categories?: string[];
  exclude_accounts?: string[];
  parent?: { _id: string } | null;
  isDelete?: boolean;
}

const gid = (): string => randomUUID().replace(/-/g, "");

export function createMobileBackend(
  auth: Omit<AuthOptions, "backend">,
  /** Shared with the client; see core/cache.ts for why this is load-bearing. */
  cache: Cache = createCache(60),
): Backend {
  const { call, pull, push, page } = createSync(auth);
  const rows = () =>
    cache.read("mobile:transactions", () => pull<RawTransaction>("/api/sync/pull/transaction/v2"));
  const invalidate = () => cache.drop("mobile:transactions");

  async function rowFor(id: string): Promise<RawTransaction> {
    const row = (await rows()).find((t) => t._id === id && !t.isDelete);
    if (!row) throw new MoneyLoverError(`no transaction ${id}`);
    return row;
  }

  const backend: Backend = {
    name: "mobile",
    can: {
      // No balance field in the pull, and the wallet push payload is unknown.
      balances: false,
      wallets: false,
      categories: true,
      labels: true,
      events: true,
      batchWrites: true,
    },

    async account(): Promise<Account> {
      const info = unwrap<{ _id: string; email: string; limitDevice?: number }>(
        await call<unknown>("/api/user/info"),
      );
      return { id: info._id, email: info.email, deviceLimit: info.limitDevice ?? 0 };
    },

    async wallets(): Promise<Wallet[]> {
      const raw = await page<WireWallet>("/api/sync/pull/account");
      return raw.filter((w) => !w.isDelete).map(normaliseWallet);
    },

    async categories(): Promise<Category[]> {
      const raw = await pull<RawCategory>("/api/sync/pull/category/v2");
      return raw
        .filter((c) => !c.isDelete)
        .map((c) => ({
          id: c._id,
          name: c.name,
          icon: c.icon,
          type: kind(c.type),
          // The id a transaction must use depends on this. See docs/traps.md.
          walletId: c.account._id,
          metadata: c.metadata,
          ...(c.parent?._id ? { parentId: c.parent._id } : {}),
          ...(c.group !== undefined ? { group: c.group } : {}),
        }));
    },

    async labels(): Promise<Label[]> {
      const raw = await pull<RawLabel>("/api/sync/pull/label");
      return raw
        .filter((l) => !l.isDelete)
        .map((l) => ({
          id: l._id,
          name: l.name,
          icon: l.icon,
          type: kind(l.type),
          categoryIds: l.categories ?? [],
          excludedWalletIds: l.exclude_accounts ?? [],
          parentId: l.parent?._id,
        }));
    },

    async transactions(): Promise<Transaction[]> {
      return (await rows()).filter((t) => !t.isDelete).map(normaliseTransaction);
    },

    async events(): Promise<Event[]> {
      return (
        await pull<{
          _id: string;
          name: string;
          icon?: string;
          end_date?: string;
          currency_id?: number;
        }>("/api/sync/pull/campaign/v2")
      ).map(normaliseEvent);
    },

    async addTransaction(input: NewTransaction): Promise<string> {
      const wallet = findWallet(await backend.wallets(), input.wallet);
      const category = findCategory(await backend.categories(), input.category, wallet.id);
      const id = gid();
      await push("transaction", [
        {
          a: signedAmount(input.amount, category.type),
          ac: wallet.id,
          c: category.id,
          cp: input.eventId ? [input.eventId] : [],
          dd: input.date ?? new Date().toISOString().slice(0, 10),
          er: Boolean(input.excludeReport),
          f: 1,
          gid: id,
          im: [],
          la: 0,
          lo: 0,
          md: "{}",
          mr: false,
          n: input.note ?? "",
          p: input.people ?? [],
          rd: 0,
          version: 0,
        } satisfies PushItem,
      ]);
      invalidate();
      return id;
    },

    async editTransaction(id: string, patch: TransactionPatch): Promise<void> {
      const row = await rowFor(id);
      const category = patch.category
        ? findCategory(await backend.categories(), patch.category, row.account._id)
        : null;
      const item = itemFrom(row, category?.id ?? row.category._id, 2);
      const type = category?.type ?? kind(row.category.type);
      if (patch.amount !== undefined) item.a = signedAmount(patch.amount, type);
      if (patch.note !== undefined) item.n = patch.note;
      if (patch.date !== undefined) item.dd = patch.date;
      if (patch.people !== undefined) item.p = patch.people;
      if (patch.eventId !== undefined) item.cp = patch.eventId ? [patch.eventId] : [];
      if (patch.excludeReport !== undefined) item.er = patch.excludeReport;
      await push("transaction", [item]);
      invalidate();
    },

    /**
     * One push for the whole plan, in batches. Editing thousands of rows one
     * request at a time takes hours; this is what a bulk recategorisation
     * actually needs.
     */
    async retagTransactions(plan: RetagEntry[]): Promise<number> {
      const byId = new Map((await rows()).filter((t) => !t.isDelete).map((t) => [t._id, t]));
      const cats = await backend.categories();
      const items = plan.map(({ id, category }) => {
        const row = byId.get(id);
        if (!row) throw new MoneyLoverError(`no transaction ${id}`);
        const target = findCategory(cats, category, row.account._id);
        return itemFrom(row, target.id, 2);
      });
      const written = await push("transaction", items);
      invalidate();
      return written;
    },

    async deleteTransaction(id: string): Promise<void> {
      const row = await rowFor(id);
      await push("transaction", [
        { ...itemFrom(row, row.category._id, 3), version: 1, isDelete: true },
      ]);
      invalidate();
    },

    ...createStructure({
      push,
      wallets: () => backend.wallets(),
      categories: () => backend.categories(),
      labels: () => backend.labels?.() ?? Promise.resolve([]),
    }),
    ...createEvents({
      push,
      events: () => backend.events?.() ?? Promise.resolve([]),
    }),
  };

  return backend;
}
