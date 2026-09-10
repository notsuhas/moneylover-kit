import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  categoryIndex,
  filterTransactions,
  findCategory,
  findWallet,
  signedAmount,
} from "../query.js";
import { MoneyLoverError } from "../types.js";
import { aCategory, aTransaction, aWallet } from "./fixtures.js";

const wallets = [
  aWallet({ id: "w1", name: "Savings" }),
  aWallet({ id: "w2", name: "Current", archived: true }),
];

describe("findWallet", () => {
  it("finds by name, case-insensitively", () => {
    assert.equal(findWallet(wallets, "savings").id, "w1");
  });

  it("finds by id, so callers can pass either", () => {
    assert.equal(findWallet(wallets, "w2").name, "Current");
  });

  it("finds an archived wallet — hiding it would silently drop history", () => {
    assert.equal(findWallet(wallets, "Current").id, "w2");
  });

  it("throws rather than returning a wrong wallet", () => {
    assert.throws(() => findWallet(wallets, "Nope"), MoneyLoverError);
  });
});

describe("findCategory", () => {
  const categories = [
    aCategory({ id: "c1", name: "Groceries", walletId: "w1" }),
    aCategory({ id: "c2", name: "Groceries", walletId: "w2" }),
    aCategory({ id: "c3", name: "Salary", type: "income" }),
  ];

  /** The whole reason the wallet argument exists on the mobile backend. */
  it("scopes to a wallet, because a category id is per-wallet there", () => {
    assert.equal(findCategory(categories, "Groceries", "w2").id, "c2");
    assert.equal(findCategory(categories, "Groceries", "w1").id, "c1");
  });

  it("keeps categories that belong to no particular wallet in scope", () => {
    assert.equal(findCategory(categories, "Salary", "w1").id, "c3");
  });

  it("ignores the wallet when none is given", () => {
    assert.equal(findCategory(categories, "Groceries").id, "c1");
  });

  it("throws when the name is not in that wallet", () => {
    assert.throws(() => findCategory(categories, "Rent", "w1"), MoneyLoverError);
  });
});

describe("categoryIndex", () => {
  const categories = [
    aCategory({ id: "global-1", name: "Groceries" }),
    aCategory({ id: "global-2", name: "Loan", metadata: "IS_LOAN" }),
  ];
  const lookup = categoryIndex(categories);

  it("matches on id", () => {
    assert.equal(lookup(aTransaction({ id: "t", categoryId: "global-1" }))?.name, "Groceries");
  });

  /**
   * The web API returns a wallet-scoped category id on a transaction and a
   * global one on the category list, so an id comparison matches nothing at all.
   * This fallback is the only reason lending and category filters work there.
   */
  it("falls back to the name when the id is from a different scope", () => {
    const hit = lookup(aTransaction({ id: "t", categoryId: "scoped", categoryName: "Loan" }));
    assert.equal(hit?.metadata, "IS_LOAN");
  });

  it("matches the name case-insensitively", () => {
    const hit = lookup(aTransaction({ id: "t", categoryId: "x", categoryName: "gRoCeRiEs" }));
    assert.equal(hit?.id, "global-1");
  });

  it("returns undefined rather than guessing", () => {
    assert.equal(
      lookup(aTransaction({ id: "t", categoryId: "x", categoryName: "Nope" })),
      undefined,
    );
  });

  it("returns undefined when there is no name to fall back to", () => {
    assert.equal(lookup(aTransaction({ id: "t", categoryId: "x" })), undefined);
  });

  it("keeps the first category for a duplicated name", () => {
    const dupes = [
      aCategory({ id: "first", name: "Uncategorized", metadata: "IS_UNCATEGORIZED_EXPENSE" }),
      aCategory({ id: "second", name: "Uncategorized", metadata: "IS_UNCATEGORIZED_INCOME" }),
    ];
    const hit = categoryIndex(dupes)(
      aTransaction({ id: "t", categoryId: "x", categoryName: "Uncategorized" }),
    );
    assert.equal(hit?.id, "first");
  });
});

describe("filterTransactions", () => {
  const rows = [
    aTransaction({ id: "a", date: "2026-01-01", amount: -100, note: "Coffee at Blue Tokai" }),
    aTransaction({ id: "b", date: "2026-06-15", amount: -2500, note: "DMart groceries" }),
    aTransaction({ id: "c", date: "2026-12-31", amount: 45000, note: "Salary" }),
  ];
  const ids = (q = {}) => filterTransactions(rows, q).map((t) => t.id);

  it("returns everything when there are no filters", () => {
    assert.equal(ids().length, 3);
  });

  it("matches a note case-insensitively, as a substring", () => {
    assert.deepEqual(ids({ note: "dmart" }), ["b"]);
  });

  it("treats the date range as inclusive at both ends", () => {
    assert.deepEqual(ids({ from: "2026-01-01", to: "2026-06-15" }), ["b", "a"]);
  });

  it("compares amounts by absolute value, so income and expense filter alike", () => {
    assert.deepEqual(ids({ minAmount: 2000 }), ["c", "b"]);
    assert.deepEqual(ids({ maxAmount: 200 }), ["a"]);
  });

  it("combines filters", () => {
    assert.deepEqual(ids({ from: "2026-02-01", maxAmount: 3000 }), ["b"]);
  });

  it("returns newest first", () => {
    assert.deepEqual(ids(), ["c", "b", "a"]);
  });

  it("breaks a date tie on id, so the order is stable across calls", () => {
    const sameDay = [
      aTransaction({ id: "z", date: "2026-01-01" }),
      aTransaction({ id: "a", date: "2026-01-01" }),
    ];
    assert.deepEqual(
      filterTransactions(sameDay).map((t) => t.id),
      ["a", "z"],
    );
  });

  it("applies the limit after sorting, not before", () => {
    assert.deepEqual(ids({ limit: 1 }), ["c"]);
  });

  it("returns an empty array when nothing matches", () => {
    assert.deepEqual(ids({ note: "nothing here" }), []);
  });
});

describe("signedAmount", () => {
  it("strips the sign, because the wire amount is always positive", () => {
    assert.equal(signedAmount(-480, "expense"), 480);
    assert.equal(signedAmount(4500, "income"), 4500);
  });

  /** Flipping the sign silently would record something the caller didn't ask for. */
  it("rejects a sign that disagrees with the category", () => {
    assert.throws(() => signedAmount(480, "expense"), MoneyLoverError);
    assert.throws(() => signedAmount(-480, "income"), MoneyLoverError);
  });

  it("rejects zero", () => {
    assert.throws(() => signedAmount(0, "expense"), MoneyLoverError);
  });
});

describe("categoryIndex — income and expense namesakes", () => {
  /**
   * Money Lover ships two categories called "Uncategorized", one per
   * direction. Keying only on the name picked whichever was listed first,
   * which attaches the wrong metadata to a row.
   */
  const categories = [
    aCategory({ id: "exp", name: "Uncategorized", metadata: "IS_UNCATEGORIZED_EXPENSE" }),
    aCategory({
      id: "inc",
      name: "Uncategorized",
      type: "income",
      metadata: "IS_UNCATEGORIZED_INCOME",
    }),
  ];
  const lookup = categoryIndex(categories);

  it("picks the expense one for an expense row", () => {
    const hit = lookup(
      aTransaction({
        id: "t",
        categoryId: "scoped",
        categoryName: "Uncategorized",
        type: "expense",
      }),
    );
    assert.equal(hit?.metadata, "IS_UNCATEGORIZED_EXPENSE");
  });

  it("picks the income one for an income row", () => {
    const hit = lookup(
      aTransaction({
        id: "t",
        categoryId: "scoped",
        categoryName: "Uncategorized",
        type: "income",
        amount: 100,
      }),
    );
    assert.equal(hit?.metadata, "IS_UNCATEGORIZED_INCOME");
  });

  it("still prefers an exact id match over the name", () => {
    assert.equal(lookup(aTransaction({ id: "t", categoryId: "inc" }))?.id, "inc");
  });
});
