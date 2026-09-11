/**
 * The web backend — `web.moneylover.me/api`.
 *
 * The default: it needs nothing but an email and password, and it is the only
 * one that reports wallet balances. Its writes carry a sharp edge documented on
 * `resolveCategory` below, and its structure writes live in structure.ts.
 */

import { type Cache, createCache } from "../../../core/cache.js";
import {
  day,
  kind,
  normaliseTransaction,
  normaliseWallet,
  type WireTransaction,
  type WireWallet,
} from "../../../core/normalise.js";
import { findCategory, findWallet, signedAmount } from "../../../core/query.js";
import {
  type Account,
  type Backend,
  type Category,
  MoneyLoverError,
  type NewTransaction,
  type Transaction,
  type TransactionPatch,
  type Wallet,
} from "../../../core/types.js";
import type { AuthOptions } from "../../auth.js";
import { createCall } from "./call.js";
import { createStructure } from "./structure.js";

interface RawCategory {
  _id: string;
  name: string;
  icon: string;
  type: 1 | 2;
  metadata?: string;
}

export function createWebBackend(
  auth: Omit<AuthOptions, "backend">,
  /**
   * Shared with the client, so an edit reuses the list the search already
   * fetched. Neither API can read one transaction, so without this every
   * single-row write refetches the whole account.
   */
  cache: Cache = createCache(60),
): Backend {
  const call = createCall(auth);
  const rows = () =>
    cache.read("web:transactions", () => call<WireTransaction[]>("/transaction/list-all"));
  const cats = () => cache.read("web:categories", () => call<RawCategory[]>("/category/list-all"));

  /**
   * Resolve a category id for a write.
   *
   * It has to come from `category/list-all`, never `category/list`. Those return
   * *different* ids for the same category, and the per-wallet one from
   * `category/list` makes `transaction/add|edit` hold the connection until
   * Cloudflare 524s at ~120 seconds — it never returns an error. Worse, a
   * successful response echoes the per-wallet id back, so the value that fails
   * is the one you see in your own results.
   */
  async function resolveCategory(value: string): Promise<Category> {
    return findCategory(await backend.categories(), value);
  }

  /** A write changed the account, so the cached lists are stale. */
  const invalidate = () => cache.drop("web:transactions");

  /** `transaction/edit` is a full replace, so an edit must resend the whole row. */
  async function rowFor(id: string): Promise<WireTransaction> {
    const row = (await rows()).find((t) => t._id === id);
    if (!row) throw new MoneyLoverError(`no transaction ${id}`);
    return row;
  }

  const backend: Backend = {
    name: "web",
    can: {
      balances: true,
      wallets: true,
      categories: true,
      labels: false,
      // Every web route for events 404s, and `/event/list/full` answers
      // `sync_error_have_not_permission`. Verified against a live account.
      events: false,
      batchWrites: false,
    },

    async account(): Promise<Account> {
      const info = await call<{ _id: string; email: string; limitDevice?: number }>("/user/info");
      return { id: info._id, email: info.email, deviceLimit: info.limitDevice ?? 0 };
    },

    async wallets(): Promise<Wallet[]> {
      return (await call<WireWallet[]>("/wallet/list")).map(normaliseWallet);
    },

    async categories(): Promise<Category[]> {
      const raw = await cats();
      return raw.map((c) => ({
        id: c._id,
        name: c.name,
        icon: c.icon,
        type: kind(c.type),
        metadata: c.metadata,
      }));
    },

    async transactions(): Promise<Transaction[]> {
      return (await rows()).map(normaliseTransaction);
    },

    async addTransaction(input: NewTransaction): Promise<string> {
      const wallet = findWallet(await backend.wallets(), input.wallet);
      const category = await resolveCategory(input.category);
      const created = await call<{ _id: string }>("/transaction/add", {
        // `account` and `category`, not walletId/categoryId as every read uses.
        account: wallet.id,
        category: category.id,
        amount: signedAmount(input.amount, category.type),
        note: input.note ?? "",
        displayDate: input.date ?? new Date().toISOString().slice(0, 10),
        event: input.eventId ?? "",
        exclude_report: Boolean(input.excludeReport),
        with: input.people ?? [],
        latitude: 0,
        longtitude: 0, // sic — the API misspells it
        addressName: "",
        addressDetails: "",
        addressIcon: "",
        image: "",
      });
      invalidate();
      return created._id;
    },

    /**
     * `transaction/edit` is a full replace, so anything not resent is erased.
     * The read returns `images`, `address`, `latitude`, `longtitude`, `remind`
     * and `metadata`, and the official app populates them — a receipt photo
     * attached on a phone would vanish on a note change. Note the asymmetry:
     * the read field is `images` (a list) while the write field is `image`.
     */
    async editTransaction(id: string, patch: TransactionPatch): Promise<void> {
      const row = await rowFor(id);
      /**
       * Never reuse the row's own category id.
       *
       * `transaction/list-all` returns the **wallet-scoped** id, and a write
       * carrying that holds the connection until Cloudflare 524s at ~120s
       * instead of erroring. So even when the category isn't changing, it has
       * to be re-resolved through `category/list-all` by name.
       */
      const category = await resolveCategory(
        patch.category ?? row.category.name ?? row.category._id,
      );
      const type = category.type;
      await call("/transaction/edit", {
        _id: id,
        account: row.account._id,
        category: category.id,
        amount: patch.amount !== undefined ? signedAmount(patch.amount, type) : row.amount,
        note: patch.note ?? row.note ?? "",
        displayDate: patch.date ?? day(row.displayDate),
        event: patch.eventId !== undefined ? (patch.eventId ?? "") : (row.campaign?.[0] ?? ""),
        exclude_report: patch.excludeReport ?? Boolean(row.exclude_report),
        with: patch.people ?? row.with ?? [],
        latitude: row.latitude ?? 0,
        longtitude: row.longtitude ?? 0,
        addressName: row.address?.name ?? "",
        addressDetails: row.address?.details ?? "",
        addressIcon: row.address?.icon ?? "",
        image: row.images?.[0] ?? "",
        remind: row.remind ?? 0,
        metadata: row.metadata ?? "",
      });
      invalidate();
    },

    async deleteTransaction(id: string): Promise<void> {
      await rowFor(id);
      await call("/transaction/delete", { _id: id, delRelated: false });
      invalidate();
    },

    ...createStructure({
      call,
      wallets: () => backend.wallets(),
      categories: () => backend.categories(),
    }),
  };

  return backend;
}
