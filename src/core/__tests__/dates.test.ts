import assert from "node:assert/strict";
import { test } from "node:test";
import { displayDate, transactionDate } from "../dates.js";
import { normaliseTransaction } from "../normalise.js";

const stamp = "2026-10-19T00:10:00+09:00";

test("receipt time survives wire encoding and normalized reads without a server timezone", () => {
  assert.equal(displayDate({ dateTime: stamp }), stamp);
  assert.deepEqual(transactionDate({ dateTime: stamp }), { date: "2026-10-19", dateTime: stamp });
  assert.equal(displayDate({}, stamp), stamp);
  assert.deepEqual(transactionDate({ date: "2026-10-20" }, stamp), { date: "2026-10-20" });
  const row = normaliseTransaction({
    _id: "receipt",
    amount: 800,
    displayDate: stamp,
    account: { _id: "w" },
    category: { _id: "food", type: 2 },
  });
  assert.equal(row.dateTime, stamp);
  assert.equal(row.date, "2026-10-19");
});

test("ambiguous, contradictory and impossible receipt times fail before a write", () => {
  for (const dateTime of [
    "2026-10-19T11:10:00",
    "2026-02-30T11:10:00Z",
    "2026-10-19T25:10:00Z",
    "garbage",
  ]) {
    assert.throws(() => transactionDate({ dateTime }));
  }
  assert.throws(() => transactionDate({ date: "2026-10-19", dateTime: stamp }));
});
