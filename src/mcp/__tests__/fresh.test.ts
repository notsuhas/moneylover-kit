import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { aCategory, aTransaction, aWallet, WEB_CAN } from "../../core/__tests__/fixtures.js";
import type { Backend, Transaction } from "../../core/types.js";
import { createMcpServer } from "../server.js";

test("consecutive MCP reads see external edits and deletions without waiting", async () => {
  let reads = 0;
  let rows: Transaction[] = [aTransaction({ id: "receipt", amount: -10 })];
  const backend: Backend = {
    name: "web",
    can: WEB_CAN,
    account: async () => ({ id: "user", email: "a@b.c", deviceLimit: 5 }),
    wallets: async () => [aWallet({ id: "w1", name: "Savings" })],
    categories: async () => [aCategory({ id: "c1", name: "Food" })],
    transactions: async () => {
      reads++;
      return rows;
    },
    events: async () => [],
    addTransaction: async () => "new",
    editTransaction: async () => {},
    deleteTransaction: async () => {},
  };
  const server = createMcpServer({ use: backend });
  const caller = new Client({ name: "fresh-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await caller.connect(b);
  const search = async () => caller.callTool({ name: "search_transactions", arguments: {} });
  try {
    assert.match(JSON.stringify(await search()), /-10/);
    rows = [aTransaction({ id: "receipt", amount: -20 })];
    assert.match(JSON.stringify(await search()), /-20/);
    rows = [];
    const result = await search();
    assert.ok(!result.isError);
    const [content] = result.content as { text: string }[];
    assert.ok(content);
    assert.equal(JSON.parse(content.text).matched, 0);
    rows = [aTransaction({ id: "receipt", amount: -20 })];
    reads = 0;
    const edited = await caller.callTool({
      name: "edit_transaction",
      arguments: { id: "receipt", note: "Corrected" },
    });
    assert.ok(!edited.isError, JSON.stringify(edited));
    assert.equal(reads, 1, "one fresh snapshot is reused within an edit");
  } finally {
    await caller.close();
    await server.close();
  }
});

test("expense writes and rendering skip balance history while explicit balances stay fresh", async () => {
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "moneylover-wallet-test-"));
  const previousDirectory = process.env.MONEYLOVER_CONFIG_DIR;
  process.env.MONEYLOVER_CONFIG_DIR = directory;
  let historyReads = 0;
  let walletName = "Savings";
  let rejected = false;
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/sync/pull/account")
      return Response.json({ data: [{ _id: "w1", name: walletName, currency_id: 11 }] });
    if (path === "/api/sync/pull/category/v2")
      return Response.json({
        data: [{ _id: "c1", name: "Food", type: 2, account: { _id: "w1" } }],
      });
    if (path === "/api/sync/pull/campaign/v2") return Response.json({ data: [] });
    if (path === "/api/sync/push/transaction/v2") return Response.json({ status: !rejected });
    if (path === "/api/sync/pull/transaction/v2") {
      historyReads++;
      return Response.json({
        data: [
          {
            _id: "receipt",
            amount: 10,
            displayDate: "2026-10-25",
            account: { _id: "w1" },
            category: { _id: "c1", type: 2 },
          },
        ],
        timestamp: 1,
      });
    }
    throw new Error("unexpected API path: " + path);
  }) as typeof fetch;
  const server = createMcpServer({ backend: "mobile", token: "test-token" });
  const caller = new Client({ name: "wallet-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await caller.connect(b);
  try {
    const add = () =>
      caller.callTool({
        name: "add_transaction",
        arguments: { wallet: walletName, category: "Food", amount: -10 },
      });
    assert.match(JSON.stringify(await add()), /Savings/);
    walletName = "Renamed";
    assert.match(JSON.stringify(await add()), /Renamed/);
    rejected = true;
    assert.equal((await add()).isError, true);
    assert.equal(historyReads, 0, "names and writes do not calculate balances");
    const balances = await caller.callTool({ name: "list_wallets", arguments: {} });
    assert.ok(!balances.isError, JSON.stringify(balances));
    assert.match(JSON.stringify(balances), /balance/);
    assert.equal(historyReads, 1, "explicit balance reads still reconcile history");
    rejected = false;
    const edited = await caller.callTool({
      name: "edit_transaction",
      arguments: { id: "receipt", note: "Changed" },
    });
    assert.ok(!edited.isError, JSON.stringify(edited));
    assert.equal(historyReads, 2, "editing reads history once, rendering does not read it again");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDirectory === undefined) delete process.env.MONEYLOVER_CONFIG_DIR;
    else process.env.MONEYLOVER_CONFIG_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
    await caller.close();
    await server.close();
  }
});
