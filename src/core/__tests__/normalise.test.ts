import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { day, kind, normaliseEvent, normaliseTransaction, normaliseWallet } from "../normalise.js";

describe("kind", () => {
  it("maps the wire type to a direction", () => {
    assert.equal(kind(1), "income");
    assert.equal(kind(2), "expense");
  });
});

describe("day", () => {
  it("takes the date out of an ISO instant", () => {
    assert.equal(day("2026-09-22T18:30:00.000Z"), "2026-09-22");
  });

  it("passes a plain date through", () => {
    assert.equal(day("2026-09-22"), "2026-09-22");
  });

  it("returns an empty string rather than throwing on a missing date", () => {
    assert.equal(day(undefined), "");
  });
});

describe("normaliseWallet", () => {
  it("flattens the balance array into a map", () => {
    const w = normaliseWallet({
      _id: "w1",
      name: "Savings",
      currency_id: 11,
      balance: [{ INR: "476189.19" }],
    });
    assert.deepEqual(w.balance, { INR: "476189.19" });
    assert.equal(w.id, "w1");
    assert.equal(w.currencyId, 11);
  });

  it("merges a multi-currency balance", () => {
    const w = normaliseWallet({
      _id: "w1",
      name: "Travel",
      currency_id: 11,
      balance: [{ INR: "100.00" }, { MYR: "20.00" }],
    });
    assert.deepEqual(w.balance, { INR: "100.00", MYR: "20.00" });
  });

  it("omits balance entirely when the backend does not report one", () => {
    assert.equal(normaliseWallet({ _id: "w1", name: "Cash", currency_id: 11 }).balance, undefined);
  });

  it("defaults archived to false rather than undefined", () => {
    assert.equal(normaliseWallet({ _id: "w1", name: "Cash", currency_id: 11 }).archived, false);
  });
});

describe("normaliseTransaction", () => {
  const wire = {
    _id: "t1",
    amount: 470,
    displayDate: "2026-09-22T00:00:00.000Z",
    account: { _id: "w1" },
    category: { _id: "c1", type: 2 as const },
  };

  /** The wire amount is always positive; only the category knows the direction. */
  it("makes an expense negative", () => {
    const t = normaliseTransaction(wire);
    assert.equal(t.amount, -470);
    assert.equal(t.type, "expense");
  });

  it("leaves income positive", () => {
    const t = normaliseTransaction({ ...wire, category: { _id: "c2", type: 1 } });
    assert.equal(t.amount, 470);
    assert.equal(t.type, "income");
  });

  it("reduces the date to a plain day", () => {
    assert.equal(normaliseTransaction(wire).date, "2026-09-22");
  });

  it("defaults every collection field so callers never handle undefined", () => {
    const t = normaliseTransaction(wire);
    assert.deepEqual(t.people, []);
    assert.deepEqual(t.eventIds, []);
    assert.equal(t.note, "");
    assert.equal(t.excludeReport, false);
  });

  it("carries people, events and the transfer pair through", () => {
    const t = normaliseTransaction({
      ...wire,
      note: "Dinner",
      with: ["Sam"],
      campaign: ["e1"],
      exclude_report: true,
      related: "t2",
    });
    assert.deepEqual(t.people, ["Sam"]);
    assert.deepEqual(t.eventIds, ["e1"]);
    assert.equal(t.excludeReport, true);
    assert.equal(t.relatedId, "t2");
  });

  it("keeps the category name when the backend supplies one", () => {
    const t = normaliseTransaction({ ...wire, category: { _id: "c1", name: "Loan", type: 2 } });
    assert.equal(t.categoryName, "Loan");
  });
});

describe("normaliseEvent", () => {
  it("renames the id field", () => {
    assert.deepEqual(normaliseEvent({ _id: "e1", name: "Goa" }), { id: "e1", name: "Goa" });
  });
});
