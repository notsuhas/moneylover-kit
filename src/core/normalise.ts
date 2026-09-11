/**
 * Wire shapes to normalised shapes.
 *
 * Both APIs return the same field names for a transaction — `_id`, `amount`,
 * `displayDate`, `account`, `category`, `with`, `campaign` — so the mapping
 * lives here once rather than in each backend. Where they differ is auth,
 * writes, and which extra fields exist; that is what the backends are for.
 */

import type { Event, Transaction, Wallet } from "./types.js";

/** Money Lover encodes direction in the category, where 1 is income and 2 expense. */
export type WireType = 1 | 2;

export const kind = (type: WireType): "income" | "expense" => (type === 1 ? "income" : "expense");

/** Dates come back as an ISO instant; everything above this layer speaks YYYY-MM-DD. */
export const day = (iso: string | undefined): string => (iso ?? "").slice(0, 10);

export interface WireWallet {
  _id: string;
  name: string;
  currency_id: number;
  icon?: string;
  archived?: boolean;
  /** Web only, and an array of single-key objects rather than a map. */
  balance?: Record<string, string>[];
  /** The mobile pull returns soft-deleted rows; the web list does not. */
  isDelete?: boolean;
}

export interface WireTransaction {
  _id: string;
  note?: string;
  amount: number;
  displayDate: string;
  account: { _id: string };
  category: { _id: string; name?: string; type: WireType };
  with?: string[];
  campaign?: string[];
  exclude_report?: boolean;
  related?: string;
  /** The mobile pull returns soft-deleted rows; the web list does not. */
  isDelete?: boolean;
  /**
   * Fields no consumer here reads, but which a **full-replace** write must
   * resend or destroy. The official apps populate them.
   */
  images?: string[];
  address?: { name?: string; details?: string; icon?: string };
  latitude?: number;
  longtitude?: number;
  remind?: number;
  metadata?: string;
  mark_report?: boolean;
}

export function normaliseWallet(w: WireWallet): Wallet {
  const balance = Object.assign({}, ...(w.balance ?? [])) as Record<string, string>;
  return {
    id: w._id,
    name: w.name,
    currencyId: w.currency_id,
    archived: Boolean(w.archived),
    ...(w.icon ? { icon: w.icon } : {}),
    ...(w.balance ? { balance } : {}),
  };
}

/**
 * The amount is stored unsigned, so the sign is reconstructed from the
 * category's type. Every caller above this point sees a signed amount.
 */
export function normaliseTransaction(t: WireTransaction): Transaction {
  return {
    id: t._id,
    date: day(t.displayDate),
    amount: t.category.type === 1 ? t.amount : -t.amount,
    note: t.note ?? "",
    walletId: t.account._id,
    categoryId: t.category._id,
    categoryName: t.category.name,
    type: kind(t.category.type),
    people: t.with ?? [],
    eventIds: t.campaign ?? [],
    excludeReport: Boolean(t.exclude_report),
    relatedId: t.related,
    remindAt: t.remind,
  };
}

export const normaliseEvent = (e: {
  _id: string;
  name: string;
  icon?: string;
  end_date?: string;
  currency_id?: number;
}): Event => ({
  id: e._id,
  name: e.name,
  ...(e.icon ? { icon: e.icon } : {}),
  ...(e.end_date ? { endDate: day(e.end_date) } : {}),
  ...(e.currency_id !== undefined ? { currencyId: e.currency_id } : {}),
});
