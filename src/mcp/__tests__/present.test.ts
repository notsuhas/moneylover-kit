import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aCategory, aTransaction, aWallet } from "../../core/__tests__/fixtures.js";
import { DATE, INSTRUCTIONS, json, naming } from "../present.js";

describe("json", () => {
  it("wraps a payload as MCP text content", () => {
    const result = json({ a: 1 });
    assert.equal(result.content[0]?.type, "text");
    assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), { a: 1 });
  });
});

describe("DATE", () => {
  it("accepts a plain day", () => {
    assert.equal(DATE.parse("2026-09-22"), "2026-09-22");
  });

  it("rejects anything else, so a model cannot pass an instant", () => {
    assert.throws(() => DATE.parse("2026-09-22T00:00:00Z"));
    assert.throws(() => DATE.parse("22/09/2026"));
    assert.throws(() => DATE.parse("today"));
  });
});

describe("naming", () => {
  const wallets = [aWallet({ id: "w1", name: "Savings" })];
  const events = [{ id: "e1", name: "Goa" }];
  const categories = [aCategory({ id: "c1", name: "Groceries" })];
  const name = naming(wallets, events, categories);

  it("replaces every id with a name", () => {
    const view = name(
      aTransaction({ id: "t1", walletId: "w1", categoryId: "c1", eventIds: ["e1"] }),
    );
    assert.equal(view.wallet, "Savings");
    assert.equal(view.category, "Groceries");
    assert.deepEqual(view.events, ["Goa"]);
  });

  /** The web backend hands over a wallet-scoped category id. */
  it("names a category via its name when the id is from another scope", () => {
    const view = name(aTransaction({ id: "t1", categoryId: "scoped", categoryName: "Groceries" }));
    assert.equal(view.category, "Groceries");
  });

  it("falls back to the raw id rather than showing nothing", () => {
    const view = name(aTransaction({ id: "t1", walletId: "w9", categoryId: "c9" }));
    assert.equal(view.wallet, "w9");
    assert.equal(view.category, "c9");
  });

  it("keeps the signed amount, so a model sees direction", () => {
    assert.equal(name(aTransaction({ id: "t1", amount: -480 })).amount, -480);
  });

  it("includes the transfer pair only when there is one", () => {
    assert.equal("transferPair" in name(aTransaction({ id: "t1" })), false);
    assert.equal(name(aTransaction({ id: "t1", relatedId: "t2" })).transferPair, "t2");
  });
});

describe("INSTRUCTIONS", () => {
  /** These are the only guidance a model gets before it touches real money. */
  it("states the sign convention and that deletes are final", () => {
    assert.match(INSTRUCTIONS, /negative is an expense/);
    assert.match(INSTRUCTIONS, /cannot be undone/);
  });
});
