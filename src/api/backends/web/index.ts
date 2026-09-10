/**
 * The web backend — `web.moneylover.me/api`.
 *
 * The default: it needs nothing but an email and password, and it is the only
 * one that reports wallet balances. Its writes carry a sharp edge documented on
 * `resolveCategory` below, and its structure writes live in structure.ts.
 */

import {
  day,
  kind,
  normaliseEvent,
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
  type Event,
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

export function createWebBackend(auth: Omit<AuthOptions, "backend">): Backend {
  const call = createCall(auth);

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

  /** `transaction/edit` is a full replace, so an edit must resend the whole row. */
  async function rowFor(id: string): Promise<WireTransaction> {
    const rows = await call<WireTransaction[]>("/transaction/list-all");
    const row = rows.find((t) => t._id === id);
    if (!row) throw new MoneyLoverError(`no transaction ${id}`);
    return row;
  }

  const backend: Backend = {
    name: "web",
    can: { balances: true, wallets: true, categories: true, labels: false },

    async account(): Promise<Account> {
      const info = await call<{ _id: string; email: string; limitDevice?: number }>("/user/info");
      return { id: info._id, email: info.email, deviceLimit: info.limitDevice ?? 0 };
    },

    async wallets(): Promise<Wallet[]> {
      return (await call<WireWallet[]>("/wallet/list")).map(normaliseWallet);
    },

    async categories(): Promise<Category[]> {
      const raw = await call<RawCategory[]>("/category/list-all");
      return raw.map((c) => ({
        id: c._id,
        name: c.name,
        icon: c.icon,
        type: kind(c.type),
        metadata: c.metadata,
      }));
    },

    async transactions(): Promise<Transaction[]> {
      return (await call<WireTransaction[]>("/transaction/list-all")).map(normaliseTransaction);
    },

    async events(): Promise<Event[]> {
      return (await call<{ _id: string; name: string }[]>("/event/list")).map(normaliseEvent);
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
      return created._id;
    },

    async editTransaction(id: string, patch: TransactionPatch): Promise<void> {
      const row = await rowFor(id);
      const category = patch.category ? await resolveCategory(patch.category) : null;
      const type = category?.type ?? kind(row.category.type);
      await call("/transaction/edit", {
        _id: id,
        account: row.account._id,
        category: category?.id ?? row.category._id,
        amount: patch.amount !== undefined ? signedAmount(patch.amount, type) : row.amount,
        note: patch.note ?? row.note ?? "",
        displayDate: patch.date ?? day(row.displayDate),
        event: patch.eventId !== undefined ? (patch.eventId ?? "") : (row.campaign?.[0] ?? ""),
        exclude_report: patch.excludeReport ?? Boolean(row.exclude_report),
        with: patch.people ?? row.with ?? [],
        latitude: 0,
        longtitude: 0,
        addressName: "",
        addressDetails: "",
        addressIcon: "",
        image: "",
      });
    },

    async deleteTransaction(id: string): Promise<void> {
      await rowFor(id);
      await call("/transaction/delete", { _id: id, delRelated: false });
    },

    ...createStructure({
      call,
      wallets: () => backend.wallets(),
      categories: () => backend.categories(),
    }),
  };

  return backend;
}
