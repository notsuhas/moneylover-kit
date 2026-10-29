import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createTransactionStore, mergeTransactions } from "../transaction-store.js";
import type { RawTransaction } from "../transactions.js";

const row = (id: string, amount: number): RawTransaction => ({
  _id: id,
  amount,
  displayDate: "2026-09-21",
  account: { _id: "wallet" },
  category: { _id: "category", type: 1 },
});

describe("mobile transaction store", () => {
  it("replaces changed rows and removes tombstones", () => {
    assert.deepEqual(
      mergeTransactions(
        [row("keep", 1), row("replace", 2), row("delete", 3)],
        [row("replace", 20), { ...row("delete", 3), isDelete: true }, row("add", 4)],
      ),
      [row("keep", 1), row("replace", 20), row("add", 4)],
    );
  });

  it("rebuilds each completed snapshot so missing writes and deletions are reconciled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moneylover-store-"));
    const before = process.env.MONEYLOVER_CONFIG_DIR;
    process.env.MONEYLOVER_CONFIG_DIR = directory;
    const checkpoints: number[] = [];
    try {
      let reads = 0;
      const store = createTransactionStore({ email: "a@b.c" }, async (lastUpdate, options) => {
        checkpoints.push(lastUpdate);
        const result =
          reads++ === 0
            ? { timestamp: 10, data: [row("a", 1), row("b", 2)] }
            : { timestamp: 20, data: [row("a", 3), row("new-write", 4)] };
        await options.onPage?.(result.data, {
          nextSkip: (options.skip ?? 0) + result.data.length,
          timestamp: result.timestamp,
        });
        return result;
      });
      assert.deepEqual(await store.sync(), [row("a", 1), row("b", 2)]);
      assert.deepEqual(await store.sync(), [row("a", 3), row("new-write", 4)]);
      assert.deepEqual(checkpoints, [0, 0]);
    } finally {
      if (before === undefined) delete process.env.MONEYLOVER_CONFIG_DIR;
      else process.env.MONEYLOVER_CONFIG_DIR = before;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds legacy snapshots instead of resuming a corrupted incremental cursor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moneylover-legacy-"));
    const before = process.env.MONEYLOVER_CONFIG_DIR;
    process.env.MONEYLOVER_CONFIG_DIR = directory;
    try {
      const base = join(directory, "moneylover-kit");
      mkdirSync(base);
      const who = createHash("sha256").update("a@b.c").digest("hex").slice(0, 12);
      writeFileSync(
        join(base, `mobile-transactions-${who}.json`),
        JSON.stringify({
          timestamp: 1792379239894,
          rows: [row("stale", 1)],
          pending: { nextSkip: 300, timestamp: 1792379239894 },
        }),
      );
      const store = createTransactionStore({ email: "a@b.c" }, async (lastUpdate, options) => {
        assert.equal(lastUpdate, 0);
        assert.equal(options.skip, 0);
        const data = [row("server-write", 2)];
        await options.onPage?.(data, { nextSkip: 1, timestamp: 1792380000000 });
        return { data, timestamp: 1792380000000 };
      });
      assert.deepEqual(await store.sync(), [row("server-write", 2)]);
    } finally {
      if (before === undefined) delete process.env.MONEYLOVER_CONFIG_DIR;
      else process.env.MONEYLOVER_CONFIG_DIR = before;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restarts a failed full reconciliation instead of publishing partial pages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moneylover-store-"));
    const before = process.env.MONEYLOVER_CONFIG_DIR;
    process.env.MONEYLOVER_CONFIG_DIR = directory;
    let attempt = 0;
    const skips: number[] = [];
    try {
      const store = createTransactionStore({ email: "a@b.c" }, async (_lastUpdate, options) => {
        attempt += 1;
        skips.push(options.skip ?? 0);
        if (attempt === 1) {
          await options.onPage?.([row("a", 1)], { nextSkip: 300, timestamp: 10 });
          throw new Error("network reset");
        }
        const data = [row("b", 2)];
        await options.onPage?.(data, { nextSkip: 301, timestamp: 11 });
        return { data, timestamp: 11 };
      });
      await assert.rejects(() => store.sync(), /network reset/);
      assert.deepEqual(await store.sync(), [row("b", 2)]);
      assert.deepEqual(skips, [0, 0]);
    } finally {
      if (before === undefined) delete process.env.MONEYLOVER_CONFIG_DIR;
      else process.env.MONEYLOVER_CONFIG_DIR = before;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
