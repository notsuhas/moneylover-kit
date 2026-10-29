import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";

test("every MCP write path requires native settlement links and receipt retries retain them", async () => {
  const previousFetch = globalThis.fetch;
  const previousDirectory = process.env.MONEYLOVER_CONFIG_DIR;
  const directory = mkdtempSync(join(tmpdir(), "settlement-links-"));
  process.env.MONEYLOVER_CONFIG_DIR = directory;
  const categories = [
    { _id: "loan", name: "Loan", type: 2, metadata: "IS_LOAN" },
    { _id: "debt", name: "Debt", type: 1, metadata: "IS_DEBT" },
    { _id: "collect", name: "Collection", type: 1, metadata: "IS_DEBT_COLLECTION" },
    { _id: "repay", name: "Repayment", type: 2, metadata: "IS_REPAYMENT" },
    { _id: "food", name: "Food", type: 2 },
  ].map((category) => ({ ...category, account: { _id: "wallet" } }));
  const rows = ["loan", "debt", "food"].map((id) => ({
    _id: id,
    amount: 100,
    category: categories.find((category) => category._id === id),
    account: { _id: "wallet" },
    displayDate: "2026-01-01",
    with: ["Sam"],
  }));
  const originals = structuredClone(rows);
  const written: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/sync/pull/account")
      return Response.json({ data: [{ _id: "wallet", name: "Bank", currency_id: 11 }] });
    if (path === "/api/sync/pull/category/v2") return Response.json({ data: categories });
    if (path === "/api/sync/pull/campaign/v2") return Response.json({ data: [] });
    if (path === "/api/sync/pull/transaction/v2")
      return Response.json({ data: rows, timestamp: 1 });
    if (path === "/api/sync/push/transaction/v2") {
      const items = JSON.parse(JSON.parse(String(init?.body)).data).d;
      for (const item of items) {
        written.push(item);
        rows.push({
          _id: item.gid,
          amount: Math.abs(item.a),
          category: categories.find((category) => category._id === item.c),
          account: { _id: item.ac },
          displayDate: item.dd,
          with: item.p,
          ...{ parent: { _id: item.pi }, metadata: item.md, note: item.n, exclude_report: item.er },
        });
      }
      return Response.json({ status: true, failedItems: [] });
    }
    throw new Error(`Unexpected path ${path}`);
  }) as typeof fetch;
  const server = createMcpServer({
    ledgerPath: false,
    backend: "mobile",
    token: "test",
    email: "test@example.invalid",
  });
  const client = new Client({ name: "settlement-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const entry = {
    wallet: "Bank",
    person: "Sam",
    amount: 30,
    note: "Offset",
    dateTime: "2026-01-02T12:00:00+09:00",
  };
  try {
    for (const kind of ["collect", "repay"])
      assert.equal((await call("record_lending", { ...entry, kind })).isError, true);
    assert.equal(
      (await call("add_transaction", { wallet: "Bank", category: "Collection", amount: 30 }))
        .isError,
      true,
    );
    assert.equal(
      (await call("edit_transaction", { id: "food", category: "Repayment" })).isError,
      true,
    );
    assert.equal(
      (
        await call("record_transactions", {
          receiptId: "unlinked",
          entries: [{ ...entry, kind: "repay" }],
        })
      ).isError,
      true,
    );
    assert.equal(written.length, 0);
    const collected = await call("record_lending", { ...entry, kind: "collect", parentId: "loan" });
    assert.ok(!collected.isError, JSON.stringify(collected));
    assert.equal(written[0]?.pi, "loan");
    assert.equal(written[0]?.er, true);
    const receipt = {
      receiptId: "linked-offset",
      entries: [{ ...entry, note: "Debt offset", kind: "repay", parentId: "debt" }],
    };
    const repaid = await call("record_transactions", receipt);
    assert.ok(!repaid.isError, JSON.stringify(repaid));
    assert.match(JSON.stringify(repaid), /verified/);
    assert.equal(written[1]?.pi, "debt");
    assert.equal(written[1]?.c, "repay");
    const retry = await call("record_transactions", receipt);
    assert.ok(!retry.isError, JSON.stringify(retry));
    assert.equal(written.length, 2, "retry must not duplicate linked offsets");
    assert.equal(
      (await call("record_lending", { ...entry, kind: "repay", parentId: "debt", amount: 70.01 }))
        .isError,
      true,
    );
    assert.equal(
      (await call("record_lending", { ...entry, kind: "repay", parentId: "debt", person: "Other" }))
        .isError,
      true,
    );
    assert.equal(written.length, 2);
    assert.deepEqual(rows.slice(0, 3), originals);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = previousFetch;
    if (previousDirectory === undefined) delete process.env.MONEYLOVER_CONFIG_DIR;
    else process.env.MONEYLOVER_CONFIG_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
});
