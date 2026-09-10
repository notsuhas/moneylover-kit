/** Builders so a test states only the fields it cares about. */

import type { Category, Transaction, Wallet } from "../types.js";

export const aCategory = (over: Partial<Category> & { id: string; name: string }): Category => ({
  icon: "icon_1",
  type: "expense",
  ...over,
});

export const aTransaction = (over: Partial<Transaction> & { id: string }): Transaction => ({
  date: "2026-01-01",
  amount: -100,
  note: "",
  walletId: "w1",
  categoryId: "c1",
  type: "expense",
  people: [],
  eventIds: [],
  excludeReport: false,
  ...over,
});

export const aWallet = (over: Partial<Wallet> & { id: string; name: string }): Wallet => ({
  currencyId: 11,
  archived: false,
  ...over,
});

/** The four lending system categories, plus one ordinary one. */
export const lendingCategories: Category[] = [
  aCategory({ id: "loan", name: "Loan", metadata: "IS_LOAN" }),
  aCategory({
    id: "collect",
    name: "Debt Collection",
    metadata: "IS_DEBT_COLLECTION",
    type: "income",
  }),
  aCategory({ id: "debt", name: "Debt", metadata: "IS_DEBT", type: "income" }),
  aCategory({ id: "repay", name: "Repayment", metadata: "IS_REPAYMENT" }),
  aCategory({ id: "food", name: "Groceries" }),
];
