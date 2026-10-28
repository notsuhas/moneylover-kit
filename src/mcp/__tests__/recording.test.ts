import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";

test("receipt tool batches expense and loan, verifies fresh rows, returns balance and reuses retries", async () => {
  const fetchBefore = globalThis.fetch;
  const directoryBefore = process.env.MONEYLOVER_CONFIG_DIR;
  const directory = mkdtempSync(join(tmpdir(), "receipt-mcp-"));
  process.env.MONEYLOVER_CONFIG_DIR = directory;
  let historyReads = 0;
  const historyScopes: string[] = [];
  let pushes = 0;
  let pushedCount = 0;
  const rows: unknown[] = [];
  const categories = [
    { _id: "debt", name: "Debt", type: 1, metadata: "IS_DEBT", account: { _id: "wallet" } },
    {
      _id: "collect",
      name: "Collect",
      type: 1,
      metadata: "IS_DEBT_COLLECTION",
      account: { _id: "wallet" },
    },
    {
      _id: "out",
      name: "Outgoing transfer",
      type: 2,
      metadata: "IS_OUTGOING_TRANSFER",
      account: { _id: "wallet" },
    },
    {
      _id: "in",
      name: "Incoming transfer",
      type: 1,
      metadata: "IS_INCOMING_TRANSFER",
      account: { _id: "jpy" },
    },
    { _id: "food", name: "Food", type: 2, account: { _id: "wallet" } },
    { _id: "loan", name: "Loan", type: 2, metadata: "IS_LOAN", account: { _id: "wallet" } },
  ];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/user/info")
      return Response.json({ data: { _id: "user", email: "test@example.com" } });
    if (path === "/api/sync/pull/account")
      return Response.json({
        data: [
          { _id: "wallet", name: "Cash", currency_id: 11 },
          { _id: "jpy", name: "Yen", currency_id: 6 },
        ],
      });
    if (path === "/api/sync/pull/category/v2") return Response.json({ data: categories });
    if (path === "/api/sync/pull/campaign/v2") return Response.json({ data: [] });
    if (path === "/api/sync/pull/transaction/v2") {
      historyReads++;
      const body = JSON.parse(String(init?.body));
      historyScopes.push(body.account_id ?? "*");
      const data = body.account_id
        ? rows.filter(
            (row) => (row as { account: { _id: string } }).account._id === body.account_id,
          )
        : rows;
      return Response.json({ data, timestamp: 1 });
    }
    if (path === "/api/sync/push/transaction/v2") {
      pushes++;
      const items = JSON.parse(JSON.parse(String(init?.body)).data).d;
      pushedCount += items.length;
      for (const item of items)
        rows.push({
          _id: item.gid,
          amount: Math.abs(item.a),
          displayDate: item.dd,
          note: item.n,
          metadata: item.md,
          account: { _id: item.ac },
          category: categories.find((category) => category._id === item.c),
          with: item.p,
          campaign: item.cp,
          exclude_report: item.er,
          ...(item.pi ? { parent: { _id: item.pi } } : {}),
        });
      return Response.json({ status: true });
    }
    throw new Error(`Unexpected API path ${path}`);
  }) as typeof fetch;
  const server = createMcpServer({ backend: "mobile", token: "test-token" });
  const caller = new Client({ name: "receipt-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await caller.connect(b);
  const entries = [
    {
      wallet: "Cash",
      category: "Food",
      amount: -60,
      note: "Lunch — my share",
      dateTime: "2026-10-20T12:00:00+09:00",
    },
    {
      wallet: "Cash",
      kind: "lend",
      person: "Bob",
      amount: 40,
      note: "Lunch — Bob's share",
      dateTime: "2026-10-20T12:00:00+09:00",
    },
  ];
  try {
    const call = (items = entries) =>
      caller.callTool({
        name: "record_transactions",
        arguments: { receiptId: "lunch-123", entries: items },
      });
    const result = await call();
    assert.ok(!result.isError, JSON.stringify(result));
    assert.match(JSON.stringify(result), /verified/);
    assert.equal(pushes, 1);
    assert.equal(pushedCount, 2);
    assert.equal(historyReads, 2);
    assert.deepEqual(
      historyScopes,
      ["wallet", "wallet"],
      "receipt duplicate check and server verification refresh only the payment wallet",
    );
    assert.ok(!(await call()).isError);
    assert.equal(pushes, 1);
    assert.equal(historyReads, 3);
    assert.equal(
      (await call(entries.map((entry) => ({ ...entry, amount: entry.amount * 2 })))).isError,
      true,
    );
    assert.equal(pushes, 1);
    const renamed = await caller.callTool({
      name: "record_transactions",
      arguments: {
        receiptId: "renamed-receipt",
        entries: entries.map((entry) => ({ ...entry, note: `${entry.note} renamed` })),
      },
    });
    assert.equal(renamed.isError, true);
    assert.equal(pushes, 1);
    const otherPaid = await caller.callTool({
      name: "record_transactions",
      arguments: {
        receiptId: "other-paid",
        entries: [
          {
            wallet: "Cash",
            category: "Food",
            amount: -50,
            note: "Dinner — mine",
            dateTime: "2026-10-20T19:00:00+09:00",
          },
          {
            wallet: "Cash",
            kind: "borrow",
            person: "Bob",
            amount: 50,
            note: "Dinner — paid by Bob",
            dateTime: "2026-10-20T19:00:00+09:00",
          },
        ],
      },
    });
    assert.ok(!otherPaid.isError, JSON.stringify(otherPaid));
    const paid = JSON.parse((otherPaid.content as { text: string }[])[0]?.text ?? "{}");
    assert.equal(paid.wallets[0].balance.INR, "-100.00");
    const initial = JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}");
    const loanId = initial.transactions.find(
      (row: { category: string }) => row.category === "Loan",
    ).id;
    const collect = () =>
      caller.callTool({
        name: "collect_loan_cross_currency",
        arguments: {
          receiptId: "collection-1",
          loanId,
          wallet: "Yen",
          amount: 20,
          receivedAmount: 33,
          dateTime: "2026-10-21T12:00:00+09:00",
          note: "Repayment",
        },
      });
    const collected = await collect();
    assert.ok(!collected.isError, JSON.stringify(collected));
    const saved = JSON.parse((collected.content as { text: string }[])[0]?.text ?? "{}");
    assert.equal(saved.transactions.length, 3);
    assert.equal(
      saved.wallets.find((wallet: { id: string }) => wallet.id === "wallet").balance.INR,
      "-100.00",
    );
    assert.equal(
      saved.wallets.find((wallet: { id: string }) => wallet.id === "jpy").balance.JPY,
      "33",
    );
    assert.equal(pushes, 3);
    assert.ok(!(await collect()).isError);
    assert.equal(pushes, 3);
  } finally {
    await caller.close();
    await server.close();
    globalThis.fetch = fetchBefore;
    if (directoryBefore === undefined) delete process.env.MONEYLOVER_CONFIG_DIR;
    else process.env.MONEYLOVER_CONFIG_DIR = directoryBefore;
    rmSync(directory, { recursive: true, force: true });
  }
});
