import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newWalletItem, walletItem } from "../wallets.js";

describe("mobile wallet payloads", () => {
  it("matches the Android account create shape", () => {
    assert.deepEqual(newWalletItem("gid", { name: "MCP", currencyId: 11 }, 4), {
      ar: false,
      at: 0,
      b: 0,
      c: 11,
      et: false,
      f: 1,
      gid: "gid",
      ic: "icon",
      md: "",
      n: "MCP",
      si: 4,
      tn: true,
      version: 0,
    });
  });

  it("full-replaces an edit without losing app-owned fields", () => {
    const live = {
      _id: "w1",
      name: "Old",
      currency_id: 11,
      icon: "icon_94",
      archived: true,
      exclude_total: true,
      account_type: 4,
      metadata: "meta",
      transaction_notification: false,
      sort_index: 7,
      version: 3,
    };
    assert.deepEqual(walletItem(live, 2, { name: "New" }), {
      ar: true,
      at: 4,
      c: 11,
      et: true,
      f: 2,
      gid: "w1",
      ic: "icon_94",
      md: "meta",
      n: "New",
      si: 7,
      tn: false,
      version: 4,
    });
  });

  it("uses the same complete row for deletion", () => {
    assert.equal(walletItem({ _id: "w1", name: "MCP", currency_id: 11 }, 3).f, 3);
  });
});
