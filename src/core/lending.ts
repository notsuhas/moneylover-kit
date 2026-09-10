/**
 * Lending and borrowing.
 *
 * Money Lover models this with four *system* categories, which it marks in
 * `metadata` rather than by name. Keying on the metadata means this works on a
 * Vietnamese or Indonesian account exactly as well as an English one, which
 * keying on "Loan" would not.
 *
 * The person is carried in a transaction's `with` list, not the wallet, so
 * lending from one account and collecting into another reconciles on its own —
 * that pair nets to zero for the person regardless of which wallets moved.
 */

import { categoryIndex } from "./query.js";
import type { Category, Transaction } from "./types.js";
import { MoneyLoverError } from "./types.js";

export type LendingKind = "lend" | "collect" | "borrow" | "repay";

export interface LendingInput {
  /** Who the money went to or came from. */
  person: string;
  /** Always positive: the direction comes from the lending kind. */
  amount: number;
  /** Wallet the money moved through. It need not match the other leg's. */
  wallet: string;
  note?: string;
  date?: string;
}

/** Which system category each verb writes to. */
const CATEGORY_METADATA: Record<LendingKind, string> = {
  lend: "IS_LOAN",
  collect: "IS_DEBT_COLLECTION",
  borrow: "IS_DEBT",
  repay: "IS_REPAYMENT",
};

const KIND_BY_METADATA = new Map<string, LendingKind>(
  Object.entries(CATEGORY_METADATA).map(([kind, meta]) => [meta, kind as LendingKind]),
);

export interface PersonBalance {
  person: string;
  /**
   * Money Lover's numeric currency id for this balance.
   *
   * A person gets one row per currency. Adding INR 5,000 to USD 100 to make
   * 5,100 would be worse than useless, and there is no exchange rate here to
   * convert with.
   */
  currencyId: number;
  /** Money you handed over. */
  lent: number;
  /** How much of it has come back. */
  collected: number;
  /** Still owed to you. Negative would mean they overpaid. */
  outstanding: number;
  /** Money you took from them. */
  borrowed: number;
  /** How much of that you have paid back. */
  repaid: number;
  /** Still owed by you. */
  owing: number;
  transactionCount: number;
}

/**
 * Find a lending system category, optionally within one wallet.
 *
 * The wallet filter exists for the mobile backend, where a transaction only
 * accepts the category id belonging to its own wallet.
 */
export function lendingCategory(
  categories: Category[],
  kind: LendingKind,
  walletId?: string,
): Category {
  const metadata = CATEGORY_METADATA[kind];
  const scoped = walletId
    ? categories.filter((c) => !c.walletId || c.walletId === walletId)
    : categories;
  const hit = scoped.find((c) => c.metadata === metadata);
  if (!hit) {
    throw new MoneyLoverError(
      `this account has no ${metadata} category, so \`${kind}\` cannot be recorded. ` +
        "Money Lover creates these itself — check that lending is enabled in the app.",
    );
  }
  return hit;
}

/** The lending kind a transaction represents, or null if it isn't one. */
export function lendingKindOf(
  transaction: Transaction,
  categories: Category[],
): LendingKind | null {
  const category = categoryIndex(categories)(transaction);
  return category?.metadata ? (KIND_BY_METADATA.get(category.metadata) ?? null) : null;
}

/**
 * Net position per person, across every wallet.
 *
 * A transaction naming several people splits evenly between them, which is the
 * only defensible reading: the wire format records who was involved, not who
 * owes what share.
 */
/**
 * Split an amount between people without losing minor units.
 *
 * Rounding each share independently loses money: 100 across three people
 * becomes three lots of 33.33, totalling 99.99, and the gap compounds over
 * thousands of rows. So the split happens in paise/cents and the remainder is
 * handed out one unit at a time, which makes the shares sum to the original
 * exactly.
 */
export function splitMinorUnits(amount: number, ways: number): number[] {
  const total = Math.round(Math.abs(amount) * 100);
  const base = Math.floor(total / ways);
  const remainder = total - base * ways;
  return Array.from({ length: ways }, (_, i) => base + (i < remainder ? 1 : 0));
}

export function lendingSummary(
  transactions: Transaction[],
  categories: Category[],
  person?: string,
  /** Wallet id to currency id. Balances are grouped per currency. */
  currencyOf?: Map<string, number>,
): PersonBalance[] {
  const lookup = categoryIndex(categories);
  const kindOf = (t: Transaction): LendingKind | null => {
    const metadata = lookup(t)?.metadata;
    return metadata ? (KIND_BY_METADATA.get(metadata) ?? null) : null;
  };
  // One bucket per (person, currency), not per person.
  const byPerson = new Map<string, PersonBalance>();
  const blank = (name: string, currencyId: number): PersonBalance => ({
    person: name,
    currencyId,
    lent: 0,
    collected: 0,
    outstanding: 0,
    borrowed: 0,
    repaid: 0,
    owing: 0,
    transactionCount: 0,
  });

  for (const t of transactions) {
    const kind = kindOf(t);
    if (!kind) continue;
    // An unnamed loan still belongs somewhere, or it silently vanishes.
    const names = t.people.length > 0 ? t.people : ["(unnamed)"];
    const currencyId = currencyOf?.get(t.walletId) ?? 0;
    const shares = splitMinorUnits(t.amount, names.length);

    for (const [index, name] of names.entries()) {
      const key = `${name}\u241f${currencyId}`;
      const entry = byPerson.get(key) ?? blank(name, currencyId);
      const share = shares[index] ?? 0;
      if (kind === "lend") entry.lent += share;
      if (kind === "collect") entry.collected += share;
      if (kind === "borrow") entry.borrowed += share;
      if (kind === "repay") entry.repaid += share;
      entry.transactionCount += 1;
      byPerson.set(key, entry);
    }
  }

  // Accumulated in minor units; converted once, at the end.
  const major = (minor: number) => minor / 100;
  const rows = [...byPerson.values()].map((e) => ({
    ...e,
    lent: major(e.lent),
    collected: major(e.collected),
    borrowed: major(e.borrowed),
    repaid: major(e.repaid),
    outstanding: major(e.lent - e.collected),
    owing: major(e.borrowed - e.repaid),
  }));

  // Substring, not equality: people are free text, so one human is often
  // several tags ("Sam", "Sam Fielding"). Each stays its own row so nothing
  // is silently merged, but one search finds them all.
  const filtered = person
    ? rows.filter((r) => r.person.toLowerCase().includes(person.toLowerCase()))
    : rows;
  return filtered.sort((a, b) => Math.abs(b.outstanding) - Math.abs(a.outstanding));
}
