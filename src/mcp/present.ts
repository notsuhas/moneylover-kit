/**
 * How tool results are shaped for a model, and the input pieces every tool
 * group shares. Kept apart from the tool definitions so the wording of a
 * result can change without touching what the tools do.
 */

import { z } from "zod";
import { categoryIndex } from "../core/query.js";
import type { Category, Event, Transaction, Wallet } from "../core/types.js";

export const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const DATE_TIME = z.iso
  .datetime({ offset: true })
  .describe(
    "ISO timestamp with Z or UTC offset, e.g. 2026-10-19T11:10:00+09:00. Do not combine with date.",
  );

export const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }],
});

/** Resolves ids to the names a person would actually use. */
export type Naming = (transaction: Transaction) => Record<string, unknown>;

export function naming(wallets: Wallet[], events: Event[], categories: Category[]): Naming {
  const walletName = new Map(wallets.map((w) => [w.id, w.name]));
  const eventName = new Map(events.map((e) => [e.id, e.name]));
  const lookup = categoryIndex(categories);

  return (t) => ({
    id: t.id,
    date: t.date,
    ...(t.dateTime ? { dateTime: t.dateTime } : {}),
    amount: t.amount,
    note: t.note,
    category: lookup(t)?.name ?? t.categoryName ?? t.categoryId,
    wallet: walletName.get(t.walletId) ?? t.walletId,
    people: t.people,
    events: t.eventIds.map((id) => eventName.get(id) ?? id),
    excludeReport: t.excludeReport,
    ...(t.relatedId ? { transferPair: t.relatedId } : {}),
    ...(t.parentId ? { parentId: t.parentId, loanId: t.parentId } : {}),
  });
}

export const INSTRUCTIONS = `Read and write transactions in a live Money Lover account.

MCP read tools use persistent SQLite snapshots and include sync metadata. Treat
lastSyncedAt as the as-of time. Pass fresh=true for audits, current balances and
settlement decisions. Cached results are not independent write verification.
Stale reads return immediately and trigger background reconciliation; writes
invalidate snapshots, and receipt verification always reads upstream directly.

For new receipts prefer record_transactions: it performs duplicate checks, batches all
expense and lending/borrowing legs, and returns verified saved records and balances.
Keep a stable receiptId. Do not search before record_transactions or repeat search_transactions or list_wallets after verified=true. Include wallet on searches and ID lookups when known to avoid a whole-account refresh.
Run independent apps in parallel and reuse known wallet/category IDs and loaded schemas.

Amounts are signed: negative is an expense, positive is income. Money Lover
stores the sign in the category's type rather than the amount, so an amount
whose sign disagrees with the category is rejected instead of being corrected.

Wallets and categories are named, not numbered; ids are resolved for you. Use a
category that already exists — list_categories shows them — because this server
cannot create one.

Editing changes only the fields you pass and preserves the rest of the row.
Deleting cannot be undone; confirm with the user first.`;
