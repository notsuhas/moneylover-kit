import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient } from "../../client/index.js";
import {
  aCategory,
  aTransaction,
  aWallet,
  lendingCategories,
  WEB_CAN,
} from "../../core/__tests__/fixtures.js";
import { Ledger } from "../../core/ledger.js";
import type { Backend, Transaction } from "../../core/types.js";
import { createLocalReads } from "../ledger.js";
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
    const invalidated = await search();
    assert.equal(invalidated.sync.stale, true);
    assert.equal(invalidated.sync.invalidated, true);
    assert.equal((await search({ fresh: true })).matched, 2);
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

test("new person filters derive currency-separated lending from shared snapshots offline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lending-ledger-"));
  const ledger = new Ledger(join(directory, "ledger.sqlite"));
  let offline = false;
  let calls = 0;
  const read = <T>(value: T): Promise<T> => {
    calls++;
    return offline ? Promise.reject(Error("offline")) : Promise.resolve(value);
  };
  const backend: Backend = {
    name: "web",
    can: WEB_CAN,
    account: async () => ({ id: "user", email: "test@example.com", deviceLimit: 5 }),
    wallets: () =>
      read([
        aWallet({ id: "inr", name: "Card", currencyId: 11 }),
        aWallet({ id: "jpy", name: "Cash", currencyId: 22 }),
      ]),
    categories: () => read(lendingCategories),
    transactions: () =>
      read([
        aTransaction({
          id: "loan",
          walletId: "inr",
          categoryId: "loan",
          amount: -123.45,
          people: ["Casey"],
        }),
        aTransaction({
          id: "debt",
          walletId: "jpy",
          categoryId: "debt",
          type: "income",
          amount: 700.11,
          people: ["Casey"],
        }),
        aTransaction({
          id: "other",
          walletId: "inr",
          categoryId: "loan",
          amount: -20,
          people: ["Taylor"],
        }),
      ]),
    addTransaction: async () => "new",
    editTransaction: async () => {},
    deleteTransaction: async () => {},
  };
  const client = createClient({ use: backend, cacheSeconds: 0 });
  const reads = createLocalReads(
    client,
    async (rows) => rows.map((row) => ({ id: row.id })),
    ledger,
  );
  try {
    await reads.search({}, 10, true);
    await reads.value("reference:wallet-catalog", () => client.walletCatalog(), true);
    const before = calls;
    offline = true;
    const saved = await reads.lending("Casey", false);
    assert.deepEqual(
      saved.value.map(({ currencyId, outstanding, owing }) => ({ currencyId, outstanding, owing })),
      [
        { currencyId: 11, outstanding: 123.45, owing: 0 },
        { currencyId: 22, outstanding: 0, owing: 700.11 },
      ],
    );
    assert.equal((await reads.lending("Taylor", false)).value[0]?.outstanding, 20);
    assert.equal(calls, before);
    const db = new DatabaseSync(join(directory, "ledger.sqlite"));
    try {
      const row = db.prepare("SELECT metadata FROM snapshots WHERE scope='account'").get();
      const metadata = JSON.parse(String(row?.metadata));
      const { wallets: _wallets, ...legacy } = metadata;
      const update = db.prepare("UPDATE snapshots SET metadata=? WHERE scope='account'");
      update.run(JSON.stringify(legacy));
      assert.deepEqual((await reads.lending("Casey", false)).value, saved.value);
      assert.equal(calls, before);
      update.run(JSON.stringify({ ...metadata, wallets: [] }));
      await assert.rejects(reads.lending("Casey", false), /wallet currency is unavailable/);
      update.run(JSON.stringify(metadata));
    } finally {
      db.close();
    }
    ledger.invalidate();
    const stale = await reads.lending("Casey", false);
    assert.equal(stale.sync.stale, true);
    assert.equal(stale.sync.invalidated, true);
    await assert.rejects(reads.lending("Casey", true), /offline/);
  } finally {
    await ledger.drain();
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
