/**
 * The full-replace contract.
 *
 * Both APIs replace a whole record on write, so anything the payload omits is
 * destroyed. Every case here corresponds to a field that was being silently
 * erased: receipt images, locations, addresses, reminders, and the metadata
 * the official client owns.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { itemFrom } from "../mobile/transactions.js";
import { createWebBackend } from "../web/index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A row as the web API returns it, with every auxiliary field populated. */
const LIVE_ROW = {
  _id: "t1",
  note: "Dinner",
  amount: 480,
  displayDate: "2026-01-01T00:00:00.000Z",
  account: { _id: "w1" },
  category: { _id: "c1", name: "Restaurants", type: 2 as const },
  with: ["Sam"],
  campaign: ["e1"],
  exclude_report: true,
  images: ["receipt.jpg"],
  address: { name: "Toit", details: "100 Feet Road", icon: "pin" },
  latitude: 12.97,
  longtitude: 77.59,
  remind: 1700000000,
  metadata: '{"transfer_fee":true}',
};

/** Capture the body of the edit call the backend makes. */
function captureEdit(): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    if (url.includes("/transaction/list-all")) {
      return new Response(JSON.stringify({ error: 0, data: [LIVE_ROW] }), { status: 200 });
    }
    if (url.includes("/category/list-all")) {
      // The global id, which is the only one a write accepts.
      return new Response(
        JSON.stringify({
          error: 0,
          data: [{ _id: "global-restaurants", name: "Restaurants", icon: "ic", type: 2 }],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/transaction/edit")) captured = body;
    return new Response(JSON.stringify({ error: 0, data: {} }), { status: 200 });
  }) as typeof fetch;
  return { body: () => captured };
}

describe("web transaction edit", () => {
  it("changes only the named field", async () => {
    const capture = captureEdit();
    const backend = createWebBackend({ token: "t" });
    await backend.editTransaction("t1", { note: "Dinner, split" });
    assert.equal(capture.body().note, "Dinner, split");
    assert.equal(capture.body().amount, 480, "amount untouched");
  });

  it("resends the receipt image rather than clearing it", async () => {
    const capture = captureEdit();
    await createWebBackend({ token: "t" }).editTransaction("t1", { note: "x" });
    assert.equal(capture.body().image, "receipt.jpg");
  });

  it("resends the location and address", async () => {
    const capture = captureEdit();
    await createWebBackend({ token: "t" }).editTransaction("t1", { note: "x" });
    const body = capture.body();
    assert.equal(body.latitude, 12.97);
    assert.equal(body.longtitude, 77.59);
    assert.equal(body.addressName, "Toit");
    assert.equal(body.addressDetails, "100 Feet Road");
  });

  it("resends the reminder and the app's own metadata", async () => {
    const capture = captureEdit();
    await createWebBackend({ token: "t" }).editTransaction("t1", { note: "x" });
    assert.equal(capture.body().remind, 1700000000);
    assert.equal(capture.body().metadata, '{"transfer_fee":true}');
  });

  /**
   * `transaction/list-all` returns the wallet-scoped category id, and a write
   * carrying it hangs for two minutes instead of erroring. So an edit that
   * isn't changing the category still has to re-resolve it by name.
   */
  it("re-resolves the category through category/list-all instead of reusing the row's id", async () => {
    const capture = captureEdit();
    await createWebBackend({ token: "t" }).editTransaction("t1", { note: "x" });
    assert.equal(capture.body().category, "global-restaurants");
    assert.notEqual(capture.body().category, "c1", "the row's wallet-scoped id would hang");
  });

  it("keeps people and the event", async () => {
    const capture = captureEdit();
    await createWebBackend({ token: "t" }).editTransaction("t1", { note: "x" });
    assert.deepEqual(capture.body().with, ["Sam"]);
    assert.equal(capture.body().event, "e1");
    assert.equal(capture.body().exclude_report, true);
  });
});

describe("mobile itemFrom", () => {
  it("carries the app's metadata through verbatim", () => {
    const item = itemFrom(LIVE_ROW, "c1", 2);
    assert.equal(item.md, '{"transfer_fee":true}');
  });

  it("falls back to an empty object only when the row has none", () => {
    const { metadata: _drop, ...bare } = LIVE_ROW;
    assert.equal(itemFrom(bare, "c1", 2).md, "{}");
  });

  it("preserves images, location, reminder and people", () => {
    const item = itemFrom(LIVE_ROW, "c1", 2);
    assert.deepEqual(item.im, ["receipt.jpg"]);
    assert.equal(item.la, 12.97);
    assert.equal(item.lo, 77.59);
    assert.equal(item.rd, 1700000000);
    assert.deepEqual(item.p, ["Sam"]);
    assert.deepEqual(item.cp, ["e1"]);
    assert.equal(item.er, true);
  });

  it("reduces the date to a plain day", () => {
    assert.equal(itemFrom(LIVE_ROW, "c1", 2).dd, "2026-01-01");
  });

  it("takes the category id it is given, not the row's", () => {
    assert.equal(itemFrom(LIVE_ROW, "other-wallet-id", 2).c, "other-wallet-id");
  });
});
