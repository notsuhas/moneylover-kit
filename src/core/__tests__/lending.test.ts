import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lendingCategory, lendingKindOf, lendingSummary } from "../lending.js";
import { MoneyLoverError } from "../types.js";
import { aCategory, aTransaction, lendingCategories as cats } from "./fixtures.js";

describe("lendingCategory", () => {
  it("resolves each verb to its system category", () => {
    assert.equal(lendingCategory(cats, "lend").metadata, "IS_LOAN");
    assert.equal(lendingCategory(cats, "collect").metadata, "IS_DEBT_COLLECTION");
    assert.equal(lendingCategory(cats, "borrow").metadata, "IS_DEBT");
    assert.equal(lendingCategory(cats, "repay").metadata, "IS_REPAYMENT");
  });

  /** The display name is localised; the metadata is not. */
  it("ignores the display name, so a non-English account still works", () => {
    const vietnamese = [aCategory({ id: "x", name: "Cho vay", metadata: "IS_LOAN" })];
    assert.equal(lendingCategory(vietnamese, "lend").id, "x");
  });

  it("scopes to a wallet, because a category id is per-wallet on mobile", () => {
    const perWallet = [
      aCategory({ id: "loan-w1", name: "Loan", metadata: "IS_LOAN", walletId: "w1" }),
      aCategory({ id: "loan-w2", name: "Loan", metadata: "IS_LOAN", walletId: "w2" }),
    ];
    assert.equal(lendingCategory(perWallet, "lend", "w2").id, "loan-w2");
  });

  it("explains itself when the account has no such category", () => {
    assert.throws(() => lendingCategory([], "lend"), MoneyLoverError);
  });
});

describe("lendingKindOf", () => {
  it("classifies a lending transaction", () => {
    assert.equal(lendingKindOf(aTransaction({ id: "t", categoryId: "loan" }), cats), "lend");
    assert.equal(lendingKindOf(aTransaction({ id: "t", categoryId: "collect" }), cats), "collect");
  });

  it("returns null for an ordinary transaction", () => {
    assert.equal(lendingKindOf(aTransaction({ id: "t", categoryId: "food" }), cats), null);
  });

  it("classifies by name when the id is from another scope", () => {
    const t = aTransaction({ id: "t", categoryId: "scoped", categoryName: "Loan" });
    assert.equal(lendingKindOf(t, cats), "lend");
  });

  it("returns null for an unknown category", () => {
    assert.equal(lendingKindOf(aTransaction({ id: "t", categoryId: "???" }), cats), null);
  });
});

describe("lendingSummary", () => {
  /** The point of the whole module: the two legs need not share a wallet. */
  it("nets a loan against a repayment received into a different wallet", () => {
    const rows = [
      aTransaction({
        id: "1",
        categoryId: "loan",
        amount: -5000,
        walletId: "savings",
        people: ["Sam"],
      }),
      aTransaction({
        id: "2",
        categoryId: "collect",
        amount: 3000,
        walletId: "current",
        people: ["Sam"],
      }),
    ];
    const [sam] = lendingSummary(rows, cats);
    assert.equal(sam?.lent, 5000);
    assert.equal(sam?.collected, 3000);
    assert.equal(sam?.outstanding, 2000);
    assert.equal(sam?.transactionCount, 2);
  });

  it("keeps what you owe separate from what you are owed", () => {
    const rows = [
      aTransaction({ id: "1", categoryId: "debt", amount: 800, people: ["Sam"] }),
      aTransaction({ id: "2", categoryId: "repay", amount: -300, people: ["Sam"] }),
    ];
    const [sam] = lendingSummary(rows, cats);
    assert.equal(sam?.owing, 500);
    assert.equal(sam?.outstanding, 0);
  });

  it("reports a negative balance when someone overpaid, rather than clamping", () => {
    const rows = [
      aTransaction({ id: "1", categoryId: "loan", amount: -100, people: ["Sam"] }),
      aTransaction({ id: "2", categoryId: "collect", amount: 150, people: ["Sam"] }),
    ];
    assert.equal(lendingSummary(rows, cats)[0]?.outstanding, -50);
  });

  it("ignores transactions that are not lending", () => {
    const rows = [aTransaction({ id: "1", categoryId: "food", amount: -400, people: ["Sam"] })];
    assert.deepEqual(lendingSummary(rows, cats), []);
  });

  it("splits a shared row evenly between the named people", () => {
    const rows = [
      aTransaction({ id: "1", categoryId: "loan", amount: -900, people: ["Ann", "Bob", "Cal"] }),
    ];
    const summary = lendingSummary(rows, cats);
    assert.equal(summary.length, 3);
    assert.deepEqual(
      summary.map((r) => r.lent),
      [300, 300, 300],
    );
  });

  it("keeps an untagged loan visible instead of dropping it", () => {
    const rows = [aTransaction({ id: "1", categoryId: "loan", amount: -100, people: [] })];
    assert.equal(lendingSummary(rows, cats)[0]?.person, "(unnamed)");
  });

  /** One human is often several free-text tags; a search finds them, unmerged. */
  it("filters by substring without merging similar tags", () => {
    const rows = [
      aTransaction({ id: "1", categoryId: "loan", amount: -100, people: ["Sam"] }),
      aTransaction({ id: "2", categoryId: "loan", amount: -50, people: ["Sam Fielding"] }),
      aTransaction({ id: "3", categoryId: "loan", amount: -25, people: ["Someone Else"] }),
    ];
    assert.deepEqual(
      lendingSummary(rows, cats, "sam").map((r) => r.person),
      ["Sam", "Sam Fielding"],
    );
  });

  it("sorts by the largest balance, either direction", () => {
    const rows = [
      aTransaction({ id: "1", categoryId: "loan", amount: -10, people: ["Small"] }),
      aTransaction({ id: "2", categoryId: "loan", amount: -9000, people: ["Big"] }),
    ];
    assert.deepEqual(
      lendingSummary(rows, cats).map((r) => r.person),
      ["Big", "Small"],
    );
  });

  it("rounds to paise rather than leaking float error", () => {
    const rows = [
      aTransaction({ id: "1", categoryId: "loan", amount: -0.1, people: ["A"] }),
      aTransaction({ id: "2", categoryId: "loan", amount: -0.2, people: ["A"] }),
    ];
    assert.equal(lendingSummary(rows, cats)[0]?.lent, 0.3);
  });

  it("returns nothing for an empty account", () => {
    assert.deepEqual(lendingSummary([], cats), []);
  });
});
