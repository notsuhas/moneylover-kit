import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  aCategory,
  aTransaction,
  aWallet,
  lendingCategories,
  WEB_CAN,
} from "../../core/__tests__/fixtures.js";
import type { Backend, NewTransaction, TransactionPatch } from "../../core/types.js";
import { createMcpServer } from "../server.js";

it("MCP exposes event IDs and forwards tags on expenses, edits and loans", async () => {
  const creates: NewTransaction[] = [];
  const edits: TransactionPatch[] = [];
  const backend: Backend = {
    name: "web",
    can: WEB_CAN,
    account: async () => ({ id: "u1", email: "a@b.c", deviceLimit: 5 }),
    wallets: async () => [aWallet({ id: "w1", name: "Savings" })],
    categories: async () => [...lendingCategories, aCategory({ id: "c1", name: "Groceries" })],
    transactions: async () => [
      aTransaction({ id: "t1", walletId: "w1", categoryId: "c1", eventIds: ["e1"] }),
    ],
    events: async () => [{ id: "e1", name: "Japan" }],
    addTransaction: async (input) => {
      creates.push(input);
      return "new";
    },
    editTransaction: async (_id, patch) => {
      edits.push(patch);
    },
    deleteTransaction: async () => {},
  };
  const server = createMcpServer({ use: backend });
  const client = new Client({ name: "test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const events = await client.callTool({ name: "list_events", arguments: {} });
    assert.match(JSON.stringify(events), /Japan/);
    assert.match(JSON.stringify(events), /e1/);
    for (const [name, args] of [
      ["add_transaction", { wallet: "Savings", category: "Groceries", amount: -10, eventId: "e1" }],
      ["edit_transaction", { id: "t1", eventId: "e1" }],
      ["edit_transaction", { id: "t1", note: "Preserve tag" }],
      ["edit_transaction", { id: "t1", eventId: null }],
      [
        "record_lending",
        { kind: "lend", person: "Friend", amount: 10, wallet: "Savings", eventId: "e1" },
      ],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      if (name === "record_lending") assert.match(JSON.stringify(result), /Japan/);
    }
    assert.equal(creates.length, 2);
    assert.ok(creates.every((input) => input.eventId === "e1"));
    assert.equal(edits[0]?.eventId, "e1");
    assert.equal(edits[1]?.eventId, undefined);
    assert.equal(edits[2]?.eventId, null);
  } finally {
    await client.close();
    await server.close();
  }
});
