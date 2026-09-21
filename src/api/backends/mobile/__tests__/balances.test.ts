import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WireWallet } from "../../../../core/normalise.js";
import { walletsWithBalances } from "../balances.js";
import type { RawTransaction } from "../transactions.js";

const wallet = (id: string, currencyId = 11): WireWallet => ({
  _id: id,
  name: id,
  currency_id: currencyId,
});

const transaction = (
  walletId: string,
  amount: number,
  type: 1 | 2,
  date = "2026-09-21T00:00:00.000Z",
): RawTransaction => ({
  _id: crypto.randomUUID(),
  amount,
  displayDate: date,
  account: { _id: walletId },
  category: { _id: "category", type },
});

describe("mobile wallet balances", () => {
  it("sums income and expense in integer minor units", () => {
    const rows = [
      transaction("inr", 100.1, 1),
      transaction("inr", 40.05, 2),
      transaction("myr", 12.34, 1),
    ];
    const result = walletsWithBalances([wallet("inr"), wallet("myr", 52)], rows);
    assert.deepEqual(
      result.map((row) => row.balance),
      [{ INR: "60.05" }, { MYR: "12.34" }],
    );
  });

  it("excludes future, deleted and soft-deleted-wallet rows", () => {
    const deleted = transaction("live", 20, 1);
    deleted.isDelete = true;
    const result = walletsWithBalances(
      [wallet("live"), { ...wallet("gone"), isDelete: true }],
      [transaction("live", 10, 1), transaction("live", 99, 1, "2026-09-22"), deleted],
      "2026-09-21",
    );
    assert.deepEqual(result, [
      { id: "live", name: "live", currencyId: 11, archived: false, balance: { INR: "10.00" } },
    ]);
  });

  it("uses each currency's own precision", () => {
    const result = walletsWithBalances(
      [wallet("jpy", 6), wallet("jod", 46)],
      [transaction("jpy", 10.4, 1), transaction("jod", 1.234, 1)],
    );
    assert.deepEqual(
      result.map((row) => row.balance),
      [{ JPY: "10" }, { JOD: "1.234" }],
    );
  });
});
