import assert from "node:assert/strict";
import { test } from "node:test";
import { crossCurrencyCollection, validateCollections } from "../collection.js";
import { aCategory, aTransaction, aWallet } from "./fixtures.js";

const wallets = [
  aWallet({ id: "inr", name: "Bank", currencyId: 11 }),
  aWallet({ id: "jpy", name: "Cash", currencyId: 6 }),
];
const categories = [
  aCategory({ id: "loan", name: "Loan", metadata: "IS_LOAN", walletId: "inr" }),
  aCategory({
    id: "collect",
    name: "Collection",
    metadata: "IS_DEBT_COLLECTION",
    walletId: "inr",
    type: "income",
  }),
  aCategory({ id: "out", name: "Transfer out", metadata: "IS_OUTGOING_TRANSFER", walletId: "inr" }),
  aCategory({
    id: "in",
    name: "Transfer in",
    metadata: "IS_INCOMING_TRANSFER",
    walletId: "jpy",
    type: "income",
  }),
];
const loan = aTransaction({
  id: "loan-1",
  walletId: "inr",
  categoryId: "loan",
  amount: -600,
  people: ["Bob"],
  eventIds: ["trip"],
});
const input = {
  loanId: loan.id,
  amount: 300,
  receivedAmount: 500,
  wallet: "Cash",
  dateTime: "2026-10-25T12:00:00+09:00",
  note: "Repayment",
};

test("cross-currency collection preserves loan accounting, actual cash and excluded transfer legs", () => {
  const before = structuredClone(loan);
  const entries = crossCurrencyCollection(input, [loan], categories, wallets);
  validateCollections(entries, [loan], categories, wallets);
  assert.equal(
    entries.filter((row) => row.wallet === "inr").reduce((sum, row) => sum + row.amount, 0),
    0,
  );
  assert.equal(
    entries.filter((row) => row.wallet === "jpy").reduce((sum, row) => sum + row.amount, 0),
    500,
  );
  assert.equal(entries[0]?.parentId, loan.id);
  assert.deepEqual(entries[0]?.people, ["Bob"]);
  assert.ok(
    entries.every(
      (row) => row.excludeReport && row.eventId === "trip" && row.dateTime === input.dateTime,
    ),
  );
  assert.deepEqual(loan, before);
  const collected = aTransaction({
    id: "collection",
    walletId: "inr",
    categoryId: "collect",
    amount: 400,
    people: ["Bob"],
    parentId: loan.id,
  });
  assert.throws(
    () => validateCollections(entries, [loan, collected], categories, wallets),
    /exceeds/,
  );
  assert.throws(
    () => crossCurrencyCollection({ ...input, receivedAmount: 500.5 }, [loan], categories, wallets),
    /decimal/,
  );
  assert.throws(
    () => crossCurrencyCollection({ ...input, wallet: "Bank" }, [loan], categories, wallets),
    /different currencies/,
  );
  assert.throws(
    () =>
      crossCurrencyCollection(
        input,
        [loan],
        categories.filter((row) => row.id !== "in"),
        wallets,
      ),
    /transfer category/,
  );
});

test("repayments validate combined remaining debt, person and yen precision before any write", () => {
  const cats = [
    aCategory({ id: "debt", name: "Debt", type: "income", metadata: "IS_DEBT", walletId: "jpy" }),
    aCategory({ id: "repay", name: "Repayment", metadata: "IS_REPAYMENT", walletId: "jpy" }),
  ];
  const debt = aTransaction({
    id: "debt-1",
    walletId: "jpy",
    categoryId: "debt",
    amount: 100,
    people: ["Bob"],
  });
  const entry = {
    wallet: "jpy",
    category: "repay",
    parentId: debt.id,
    amount: -60,
    people: ["Bob"],
  };
  validateCollections([entry], [debt], cats, wallets);
  assert.throws(
    () => validateCollections([entry, { ...entry, amount: -41 }], [debt], cats, wallets),
    /exceeds/,
  );
  for (const patch of [
    { amount: -0.5 },
    { people: ["Other"] },
    { wallet: "inr" },
    { parentId: undefined },
  ])
    assert.throws(() => validateCollections([{ ...entry, ...patch }], [debt], cats, wallets));
});
