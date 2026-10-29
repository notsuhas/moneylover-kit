import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { aCategory, aTransaction, aWallet, WEB_CAN } from "../../core/__tests__/fixtures.js";
import type { Backend, Transaction } from "../../core/types.js";
import { createMcpServer } from "../server.js";

test("MCP local reads survive restart, reuse changed filters, and invalidate after an uncertain write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ledger-mcp-"));
  let rows: Transaction[] = [
    aTransaction({
      id: "one",
      walletId: "w1",
      categoryId: "c1",
      categoryName: "Food",
      amount: -10,
      note: "Coffee",
    }),
  ];
  let reads = 0;
  let failWrite = false;
  let offline = false;
  let pendingRead: Promise<void> | undefined;
  const backend: Backend = {
    name: "web",
    can: WEB_CAN,
    account: async () => ({ id: "user", email: "test@example.com", deviceLimit: 5 }),
    wallets: async () => [aWallet({ id: "w1", name: "Cash" })],
    categories: async () => [aCategory({ id: "c1", name: "Food" })],
    events: async () => [],
    transactions: async () => {
      reads++;
      await pendingRead;
      if (offline) throw Error("offline");
      return rows;
    },
    addTransaction: async () => {
      rows = [
        ...rows,
        aTransaction({
          id: "two",
          walletId: "w1",
          categoryId: "c1",
          categoryName: "Food",
          amount: -20,
          note: "Lunch",
        }),
      ];
      if (failWrite) throw Error("response lost");
      return "two";
    },
    editTransaction: async () => {},
    deleteTransaction: async () => {},
  };
  const start = async () => {
    const server = createMcpServer({ use: backend, ledgerPath: join(directory, "ledger.sqlite") });
    const caller = new Client({ name: "ledger-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await caller.connect(b);
    return {
      caller,
      close: async () => {
        await caller.close();
        await server.close();
      },
    };
  };
  let session = await start();
  const search = async (args: Record<string, unknown> = {}) => {
    const result = await session.caller.callTool({
      name: "search_transactions",
      arguments: { wallet: "Cash", ...args },
    });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}");
  };
  try {
    assert.equal((await search()).sync.source, "api");
    const count = reads;
    assert.equal((await search({ note: "coffee" })).matched, 1);
    assert.equal(reads, count);
    await session.close();
    session = await start();
    offline = true;
    assert.equal((await search()).sync.source, "ledger");
    assert.equal(reads, count);
    const forced = await session.caller.callTool({
      name: "search_transactions",
      arguments: { wallet: "Cash", fresh: true },
    });
    assert.equal(forced.isError, true);
    offline = false;
    const first = rows[0];
    assert.ok(first);
    rows = [{ ...first, amount: -15 }];
    assert.equal((await search({ fresh: true })).transactions[0].amount, -15);
    failWrite = true;
    const failed = await session.caller.callTool({
      name: "add_transaction",
      arguments: { wallet: "Cash", category: "Food", amount: -20, note: "Lunch" },
    });
    assert.equal(failed.isError, true);
    assert.equal((await search()).matched, 2);
    rows = [];
    assert.equal((await search({ fresh: true })).matched, 0);
    assert.equal((await search()).matched, 0);
    const db = new DatabaseSync(join(directory, "ledger.sqlite"));
    db.exec("UPDATE snapshots SET synced_at=0");
    db.close();
    let release!: () => void;
    pendingRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    assert.equal((await search()).sync.stale, true);
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const prematurelyClosed = closed;
    release();
    await closing;
    assert.equal(prematurelyClosed, false);
    session = await start();
    offline = true;
    assert.equal((await search()).sync.stale, false);
  } finally {
    await session.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
