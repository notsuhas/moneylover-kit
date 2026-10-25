import { currencyInfo } from "./currencies.js";
import { lendingCategory } from "./lending.js";
import { categoryIndex, findWallet } from "./query.js";
import type { Category, NewTransaction, Transaction, Wallet } from "./types.js";

export function validateCollections(
  inputs: NewTransaction[],
  rows: Transaction[],
  categories: Category[],
  wallets: Wallet[],
): void {
  const categoryOf = categoryIndex(categories);
  for (const loanId of new Set(
    inputs.flatMap((input) => (input.parentId ? [input.parentId] : [])),
  )) {
    const loan = rows.find((row) => row.id === loanId);
    if (
      !loan ||
      loan.amount >= 0 ||
      categoryOf(loan)?.metadata !== "IS_LOAN" ||
      loan.people.length !== 1
    )
      throw new Error("Original transaction must be a single-person loan");
    const currencyId = findWallet(wallets, loan.walletId).currencyId;
    const factor = 10 ** currencyInfo(currencyId).decimals;
    const linked = rows.filter((row) => row.parentId === loanId);
    if (
      linked.some(
        (row) =>
          row.amount <= 0 ||
          categoryOf(row)?.metadata !== "IS_DEBT_COLLECTION" ||
          findWallet(wallets, row.walletId).currencyId !== currencyId,
      )
    )
      throw new Error("Loan has an unexpected linked collection");
    const requested = inputs.filter(
      (input) =>
        input.parentId === loanId &&
        !linked.some(
          (row) =>
            row.walletId === input.wallet &&
            row.categoryId === input.category &&
            row.amount === input.amount &&
            row.note === input.note &&
            Date.parse(row.dateTime ?? "") === Date.parse(input.dateTime ?? ""),
        ),
    );
    if (
      requested.some(
        (input) =>
          input.amount <= 0 ||
          findWallet(wallets, input.wallet).currencyId !== currencyId ||
          !categories.some(
            (category) =>
              category.id === input.category && category.metadata === "IS_DEBT_COLLECTION",
          ),
      )
    )
      throw new Error("Collection must use the original loan currency and collection category");
    const available =
      Math.round(-loan.amount * factor) -
      linked.reduce((sum, row) => sum + Math.round(row.amount * factor), 0);
    if (requested.reduce((sum, input) => sum + Math.round(input.amount * factor), 0) > available)
      throw new Error("Collection exceeds the loan's remaining amount");
  }
}

export function crossCurrencyCollection(
  input: {
    loanId: string;
    amount: number;
    receivedAmount: number;
    wallet: string;
    dateTime: string;
    note: string;
  },
  rows: Transaction[],
  categories: Category[],
  wallets: Wallet[],
): NewTransaction[] {
  const loan = rows.find((row) => row.id === input.loanId);
  if (!loan) throw new Error("Original loan not found");
  const origin = findWallet(wallets, loan.walletId);
  const receiving = findWallet(wallets, input.wallet);
  if (origin.archived || receiving.archived || origin.currencyId === receiving.currencyId)
    throw new Error("Cross-currency collection requires active wallets with different currencies");
  for (const [amount, currencyId] of [
    [input.amount, origin.currencyId],
    [input.receivedAmount, receiving.currencyId],
  ]) {
    if (amount === undefined || currencyId === undefined || !Number.isFinite(amount) || amount <= 0)
      throw new Error("Both actual amounts are required");
    const scaled = amount * 10 ** currencyInfo(currencyId).decimals;
    if (Math.abs(Math.round(scaled) - scaled) > 1e-8)
      throw new Error("Amount has too many decimal places for its currency");
  }
  const transfer = (metadata: string, wallet: Wallet) => {
    const category = categories.find(
      (row) => row.metadata === metadata && (!row.walletId || row.walletId === wallet.id),
    );
    if (!category) throw new Error("Wallet is missing its system transfer category");
    return category.id;
  };
  const base = {
    dateTime: input.dateTime,
    excludeReport: true,
    ...(loan.eventIds.length === 1 ? { eventId: loan.eventIds[0] } : {}),
  };
  return [
    {
      ...base,
      wallet: origin.id,
      category: lendingCategory(categories, "collect", origin.id).id,
      amount: input.amount,
      parentId: loan.id,
      people: loan.people,
      note: `${input.note} — loan collected`,
    },
    {
      ...base,
      wallet: origin.id,
      category: transfer("IS_OUTGOING_TRANSFER", origin),
      amount: -input.amount,
      note: `${input.note} — currency transfer out`,
    },
    {
      ...base,
      wallet: receiving.id,
      category: transfer("IS_INCOMING_TRANSFER", receiving),
      amount: input.receivedAmount,
      note: `${input.note} — currency transfer in`,
    },
  ];
}
