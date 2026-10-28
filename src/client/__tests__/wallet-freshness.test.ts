import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_CAN, aCategory, aTransaction, aWallet } from "../../core/__tests__/fixtures.js";
import type { Backend, Transaction } from "../../core/types.js";
import { createClient } from "../index.js";

test("scoped client caches refresh after uncertain writes and wallet changes", async () => {
  let name = "Cash";
  let deleted = false;
  let rows: Transaction[] = [];
  const backend: Backend = {
    name: "mobile",
    can: ALL_CAN,
    account: async () => ({ id: "user", email: "test@example.com", deviceLimit: 5 }),
    wallets: async () =>
      deleted ? [] : [aWallet({ id: "w1", name, balance: { USD: String(-rows.length) } })],
    walletCatalog: async () => (deleted ? [] : [aWallet({ id: "w1", name })]),
    categories: async () => [aCategory({ id: "c1", name: "Food" })],
    transactions: async () => rows,
    transactionsInWallet: async () => rows,
    addTransaction: async () => {
      rows = [aTransaction({ id: "saved", walletId: "w1", amount: -1 })];
      throw new Error("response lost after save");
    },
    editTransaction: async () => {},
    deleteTransaction: async () => {},
    editWallet: async (_id, patch) => {
      name = patch.name ?? name;
    },
    deleteWallet: async () => {
      deleted = true;
      rows = [];
    },
  };
  const client = createClient({ use: backend });
  await client.withFreshReads(async () => {
    assert.equal((await client.transactions({ wallet: "w1" })).length, 0);
    assert.equal((await client.wallets(["w1"]))[0]?.balance?.USD, "0");
    await assert.rejects(
      client.addTransaction({ wallet: "w1", category: "c1", amount: -1, date: "2026-10-28" }),
      /response lost/,
    );
    assert.equal((await client.transactions({ wallet: "w1" })).length, 1);
    assert.equal((await client.wallets(["w1"]))[0]?.balance?.USD, "-1");
    await client.editWallet("w1", { name: "Renamed" });
    assert.equal((await client.wallets(["w1"]))[0]?.name, "Renamed");
    await client.deleteWallet("w1");
    assert.deepEqual(await client.wallets(["w1"]), []);
    await assert.rejects(client.transactions({ wallet: "w1" }), /no wallet/);
  });
});
