import type { Category, Transaction, TransactionQuery, Wallet } from "./types.js";
import { MoneyLoverError } from "./types.js";

/** Case-insensitive name or exact id match, so callers can pass either. */
function matches(value: string, name: string, id: string): boolean {
  return value === id || value.toLowerCase() === name.toLowerCase();
}

export function findWallet(wallets: Wallet[], value: string): Wallet {
  const hit = wallets.find((w) => matches(value, w.name, w.id));
  if (!hit) throw new MoneyLoverError(`no wallet ${JSON.stringify(value)}`);
  return hit;
}

/**
 * Find a category by name or id, optionally within one wallet.
 *
 * The wallet filter is what the mobile API needs and the web API must not have:
 * mobile stores one category row per wallet, so a transaction only accepts the
 * id belonging to *its own* wallet.
 */
export function findCategory(categories: Category[], value: string, walletId?: string): Category {
  const scoped = walletId
    ? categories.filter((c) => !c.walletId || c.walletId === walletId)
    : categories;
  const hit = scoped.find((c) => matches(value, c.name, c.id));
  if (!hit) {
    throw new MoneyLoverError(
      `no category ${JSON.stringify(value)}${walletId ? " in that wallet" : ""}`,
    );
  }
  return hit;
}

/**
 * Look categories up by id *or* name.
 *
 * Needed because neither backend gives a transaction an id you can match
 * directly against the category list. The web API's `transaction/list-all`
 * returns a wallet-scoped category id while `category/list-all` returns a
 * global one, so an id comparison matches nothing at all — but the transaction
 * carries the category name. The mobile API is the mirror: ids match, names
 * are absent. Indexing both covers either.
 */
export function categoryIndex(categories: Category[]): (t: Transaction) => Category | undefined {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const byName = new Map<string, Category>();
  for (const c of categories) {
    const key = c.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, c);
  }
  return (t) =>
    byId.get(t.categoryId) ??
    (t.categoryName ? byName.get(t.categoryName.toLowerCase()) : undefined);
}

/** Apply a query. Backend-agnostic: both return the same normalised rows. */
export function filterTransactions(
  transactions: Transaction[],
  query: TransactionQuery = {},
): Transaction[] {
  const needle = query.note?.toLowerCase();
  const hits = transactions.filter((t) => {
    if (needle && !t.note.toLowerCase().includes(needle)) return false;
    if (query.from && t.date < query.from) return false;
    if (query.to && t.date > query.to) return false;
    const size = Math.abs(t.amount);
    if (query.minAmount !== undefined && size < query.minAmount) return false;
    if (query.maxAmount !== undefined && size > query.maxAmount) return false;
    return true;
  });
  hits.sort((a, b) =>
    a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date),
  );
  return query.limit ? hits.slice(0, query.limit) : hits;
}

/**
 * Reject an amount whose sign disagrees with the category.
 *
 * Money Lover stores the sign in the category's type, not the amount, so the
 * wire value is always positive. A caller passing +500 against an expense
 * category means something different from what they wrote, and silently
 * flipping it would be worse than failing.
 */
export function signedAmount(amount: number, type: "income" | "expense"): number {
  if (amount === 0) throw new MoneyLoverError("amount cannot be zero");
  const wantsIncome = amount > 0;
  if (wantsIncome !== (type === "income")) {
    throw new MoneyLoverError(
      `amount ${amount} is ${wantsIncome ? "positive" : "negative"} but the category is ${type}`,
    );
  }
  return Math.abs(amount);
}
