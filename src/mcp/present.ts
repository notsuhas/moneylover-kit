/**
 * How tool results are shaped for a model, and the input pieces every tool
 * group shares. Kept apart from the tool definitions so the wording of a
 * result can change without touching what the tools do.
 */

import { z } from "zod";
import { categoryIndex } from "../core/query.js";
import type { Category, Event, Transaction, Wallet } from "../core/types.js";

export const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

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
    amount: t.amount,
    note: t.note,
    category: lookup(t)?.name ?? t.categoryName ?? t.categoryId,
    wallet: walletName.get(t.walletId) ?? t.walletId,
    people: t.people,
    events: t.eventIds.map((id) => eventName.get(id) ?? id),
    excludeReport: t.excludeReport,
    ...(t.relatedId ? { transferPair: t.relatedId } : {}),
  });
}

export const INSTRUCTIONS = `Read and write transactions in a live Money Lover account.

Amounts are signed: negative is an expense, positive is income. Money Lover
stores the sign in the category's type rather than the amount, so an amount
whose sign disagrees with the category is rejected instead of being corrected.

Wallets and categories are named, not numbered; ids are resolved for you. Use a
category that already exists — list_categories shows them — because this server
cannot create one.

Editing changes only the fields you pass and preserves the rest of the row.
Deleting cannot be undone; confirm with the user first.`;
