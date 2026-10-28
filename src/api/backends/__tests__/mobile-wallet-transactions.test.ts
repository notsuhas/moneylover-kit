import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCache } from "../../../core/cache.js";
import { createMobileBackend } from "../mobile/index.js";
import type { RawTransaction } from "../mobile/transactions.js";

function transaction(id: string, wallet = "yen", amount = 1): RawTransaction {
  return {
    _id: id,
    amount,
    displayDate: "2026-01-01",
    account: { _id: wallet },
    category: { _id: `food-${wallet}`, name: "Food", type: 2 },
  };
}

function fixture() {
  const previousFetch = globalThis.fetch;
  const previousDirectory = process.env.MONEYLOVER_CONFIG_DIR;
  const directory = mkdtempSync(join(tmpdir(), "wallet-sync-"));
  process.env.MONEYLOVER_CONFIG_DIR = directory;
  const cache = createCache(60);
  const backend = createMobileBackend(
    { token: "test", email: "wallet-test@example.invalid" },
    cache,
  );
  const state = {
    rows: [
      ...Array.from({ length: 302 }, (_, index) => transaction(`yen-${index}`)),
      transaction("bank-1", "bank", 20),
    ],
    failure: "",
    ignoreFilter: false,
    rejectPush: false,
  };
  const requests: { wallet?: string; skip: number; lastUpdate: number }[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path === "/api/sync/pull/account")
      return Response.json({
        data: [
          { _id: "yen", name: "Yen", currency_id: 6 },
          { _id: "bank", name: "Bank", currency_id: 11 },
        ],
      });
    if (path === "/api/sync/pull/category/v2")
      return Response.json({
        data: ["yen", "bank"].map((wallet) => ({
          _id: `food-${wallet}`,
          name: "Food",
          type: 2,
          account: { _id: wallet },
        })),
      });
    if (path === "/api/sync/pull/transaction/v2") {
      requests.push({
        ...(body.account_id ? { wallet: body.account_id } : {}),
        skip: body.skip,
        lastUpdate: body.last_update,
      });
      if (body.account_id && state.failure && body.skip === 300)
        return Response.json({ status: false, message: state.failure });
      const selected =
        body.account_id && !state.ignoreFilter
          ? state.rows.filter((row) => row.account._id === body.account_id)
          : state.rows;
      return Response.json({
        status: true,
        data: selected.slice(body.skip, body.skip + body.limit),
        timestamp: 42,
      });
    }
    if (path === "/api/sync/push/transaction/v2") {
      const items = JSON.parse(body.data).d;
      for (const item of items)
        state.rows.push({ ...transaction(item.gid, item.ac, Math.abs(item.a)), note: item.n });
      return Response.json({ status: !state.rejectPush, failedItems: [] });
    }
    throw new Error(`Unexpected path ${path}`);
  }) as typeof fetch;
  return {
    backend,
    cache,
    state,
    requests,
    mirror: join(
      directory,
      "moneylover-kit",
      `mobile-transactions-${createHash("sha256").update("wallet-test@example.invalid").digest("hex").slice(0, 12)}.json`,
    ),
    close() {
      globalThis.fetch = previousFetch;
      if (previousDirectory === undefined) delete process.env.MONEYLOVER_CONFIG_DIR;
      else process.env.MONEYLOVER_CONFIG_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("wallet pulls paginate freshly and share exact balance snapshots without fetching other wallets", async () => {
  const f = fixture();
  try {
    await f.cache.scope(async () => {
      assert.equal((await f.backend.transactionsInWallet?.("yen"))?.length, 302);
      assert.equal((await f.backend.wallets(["yen", "yen"]))[0]?.balance?.JPY, "-302");
      assert.deepEqual(f.requests, [
        { wallet: "yen", skip: 0, lastUpdate: 0 },
        { wallet: "yen", skip: 300, lastUpdate: 0 },
      ]);
      assert.equal((await f.backend.wallets(["bank"]))[0]?.balance?.INR, "-20.00");
    });
    f.state.rows = f.state.rows.filter((row) => row._id !== "yen-0");
    const changed = f.state.rows.find((row) => row._id === "yen-1");
    assert.ok(changed);
    changed.amount = 3;
    await f.cache.scope(async () => {
      const rows = await f.backend.transactionsInWallet?.("yen");
      assert.equal(rows?.length, 301);
      assert.equal(rows?.find((row) => row.id === "yen-1")?.amount, -3);
      assert.ok(!rows?.some((row) => row.id === "yen-0"));
      assert.equal((await f.backend.wallets(["yen"]))[0]?.balance?.JPY, "-303");
    });
    assert.equal(f.requests.length, 5);
    assert.ok(f.requests.every((request) => request.wallet));
    await assert.rejects(() => f.backend.wallets(["missing"]), /no wallet/);
  } finally {
    f.close();
  }
});

test("transaction writes invalidate both scoped snapshots and the global snapshot", async () => {
  const f = fixture();
  try {
    await f.cache.scope(async () => {
      assert.equal((await f.backend.transactions()).length, 303);
      assert.equal((await f.backend.transactionsInWallet?.("yen"))?.length, 302);
      await f.backend.addTransaction({
        wallet: "Yen",
        category: "food-yen",
        amount: -7,
        date: "2026-01-01",
      });
      assert.equal((await f.backend.transactionsInWallet?.("yen"))?.length, 303);
      assert.equal((await f.backend.wallets(["yen"]))[0]?.balance?.JPY, "-309");
      assert.equal((await f.backend.transactions()).length, 304);
      assert.equal(f.requests.filter((request) => request.wallet === "yen").length, 4);
      assert.equal(f.requests.filter((request) => !request.wallet).length, 4);
      f.state.rejectPush = true;
      await assert.rejects(() =>
        f.backend.addTransaction({ wallet: "Yen", category: "food-yen", amount: -8 }),
      );
      assert.equal((await f.backend.transactionsInWallet?.("yen"))?.length, 304);
      assert.equal((await f.backend.transactions()).length, 305);
    });
  } finally {
    f.close();
  }
});

test("failed and unfiltered wallet pulls cannot overwrite the global mirror or checkpoint", async () => {
  const f = fixture();
  try {
    await f.cache.scope(() => f.backend.transactions());
    const before = readFileSync(f.mirror, "utf8");
    f.state.failure = "failed second page";
    await assert.rejects(
      () => f.cache.scope(() => f.backend.transactionsInWallet?.("yen") ?? Promise.resolve([])),
      /failed second page/,
    );
    assert.equal(readFileSync(f.mirror, "utf8"), before);
    f.state.failure = "";
    f.state.ignoreFilter = true;
    await assert.rejects(
      () => f.cache.scope(() => f.backend.transactionsInWallet?.("yen") ?? Promise.resolve([])),
      /ignored.*wallet/,
    );
    assert.equal(readFileSync(f.mirror, "utf8"), before);
    f.state.ignoreFilter = false;
    assert.equal(
      (await f.cache.scope(() => f.backend.transactionsInWallet?.("yen") ?? Promise.resolve([])))
        .length,
      302,
    );
    assert.equal(readFileSync(f.mirror, "utf8"), before);
    assert.equal(JSON.parse(before).timestamp, 42);
  } finally {
    f.close();
  }
});
