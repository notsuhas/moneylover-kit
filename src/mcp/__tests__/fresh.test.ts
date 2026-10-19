import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { aCategory, aTransaction, aWallet, WEB_CAN } from "../../core/__tests__/fixtures.js";
import type { Backend, Transaction } from "../../core/types.js";
import { createMcpServer } from "../server.js";

test("consecutive MCP reads see external edits and deletions without waiting", async () => {
  let rows: Transaction[] = [aTransaction({ id: "receipt", amount: -10 })];
  const backend: Backend = {
    name: "web",
    can: WEB_CAN,
    account: async () => ({ id: "user", email: "a@b.c", deviceLimit: 5 }),
    wallets: async () => [aWallet({ id: "w1", name: "Savings" })],
    categories: async () => [aCategory({ id: "c1", name: "Food" })],
    transactions: async () => rows,
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
  } finally {
    await caller.close();
    await server.close();
  }
});
