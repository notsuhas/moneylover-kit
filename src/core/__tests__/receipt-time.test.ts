import assert from "node:assert/strict";
import { test } from "node:test";
import { normaliseTransaction } from "../normalise.js";
import { receiptMetadata, receiptTime } from "../receipt-time.js";

test("an early Japan receipt retains its calendar day after the API converts it to UTC", () => {
  const stamp = "2026-10-19T06:23:00+09:00";
  const metadata = receiptMetadata('{"transfer_fee":true,"moneyloverKit":{"keep":"value"}}', stamp);
  const raw = {
    _id: "receipt",
    amount: 625,
    displayDate: "2026-10-18T21:23:00.000Z",
    metadata,
    account: { _id: "w" },
    category: { _id: "c", type: 2 as const },
  };
  const result = normaliseTransaction(raw);
  assert.equal(result.date, "2026-10-19");
  assert.equal(result.dateTime, stamp);
  assert.equal(JSON.parse(metadata).transfer_fee, true);
  assert.equal(JSON.parse(metadata).moneyloverKit.keep, "value");
  assert.equal(receiptTime("2026-10-20T00:00:00.000Z", metadata), undefined);
});

test("opaque app metadata is not overwritten", () => {
  for (const metadata of ["opaque", "[]", '{"moneyloverKit":"owned elsewhere"}']) {
    assert.throws(() => receiptMetadata(metadata, "2026-10-19T06:23:00+09:00"));
  }
});
