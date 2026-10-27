import { currencyInfo } from "./currencies.js";
import { lendingCategory } from "./lending.js";
import { categoryIndex, findCategory, findWallet } from "./query.js";
import type { Category, NewTransaction, Transaction, Wallet } from "./types.js";

export function validateCollections(
  inputs: NewTransaction[],
  rows: Transaction[],
  categories: Category[],
  wallets: Wallet[],
): void {
  const categoryOf = categoryIndex(categories);
  const settlements = inputs.filter((input) => {
    const category = findCategory(categories, input.category, findWallet(wallets, input.wallet).id);
    const settlement = ["IS_DEBT_COLLECTION", "IS_REPAYMENT"].includes(category.metadata ?? "");
    if (settlement && !input.parentId)
      throw new Error("Collections and repayments require parentId; split across original records");
    if (input.parentId && !settlement)
      throw new Error("Only collections and repayments can link to an original loan or debt");
    return settlement;
  });
  for (const parentId of new Set(settlements.map((input) => input.parentId))) {
    const original = rows.find((row) => row.id === parentId);
    const kind = original ? categoryOf(original)?.metadata : undefined;
    const loan = kind === "IS_LOAN";
    if (
      !original ||
      (!loan && kind !== "IS_DEBT") ||
      (loan ? original.amount >= 0 : original.amount <= 0) ||
      original.people.length !== 1
    )
      throw new Error("Original transaction must be an active loan or debt naming one person");
    const currencyId = findWallet(wallets, original.walletId).currencyId;
    const factor = 10 ** currencyInfo(currencyId).decimals;
    const metadata = loan ? "IS_DEBT_COLLECTION" : "IS_REPAYMENT";
    const linked = rows.filter((row) => row.parentId === parentId);
    if (
      linked.some(
        (row) =>
          (loan ? row.amount <= 0 : row.amount >= 0) ||
          categoryOf(row)?.metadata !== metadata ||
          findWallet(wallets, row.walletId).currencyId !== currencyId,
      )
    )
      throw new Error("Original has an unexpected linked settlement");
    const requested = settlements.filter((input) => input.parentId === parentId);
    for (const input of requested) {
      const wallet = findWallet(wallets, input.wallet);
      const category = findCategory(categories, input.category, wallet.id);
      const scaled = Math.abs(input.amount) * factor;
      if (
        !Number.isFinite(input.amount) ||
        (loan ? input.amount <= 0 : input.amount >= 0) ||
        Math.round(scaled) === 0 ||
        Math.abs(Math.round(scaled) - scaled) > 1e-8 ||
        wallet.archived ||
        wallet.currencyId !== currencyId ||
        category.metadata !== metadata ||
        input.people?.length !== 1 ||
        input.people[0] !== original.people[0]
      )
        throw new Error(
          "Settlement must match original person, currency, direction and currency precision in an active wallet",
        );
    }
    const available =
      Math.round(Math.abs(original.amount) * factor) -
      linked.reduce((sum, row) => sum + Math.round(Math.abs(row.amount) * factor), 0);
    if (
      requested.reduce((sum, input) => sum + Math.round(Math.abs(input.amount) * factor), 0) >
      available
    )
      throw new Error("Settlement exceeds the original remaining amount");
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
