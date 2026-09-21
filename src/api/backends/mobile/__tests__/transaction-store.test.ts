import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

  it("persists the checkpoint and only pulls changes next time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moneylover-store-"));
    const before = process.env.MONEYLOVER_CONFIG_DIR;
    process.env.MONEYLOVER_CONFIG_DIR = directory;
    const checkpoints: number[] = [];
    try {
      const store = createTransactionStore({ email: "a@b.c" }, async (lastUpdate, options) => {
        checkpoints.push(lastUpdate);
        const result =
          lastUpdate === 0
            ? { timestamp: 10, data: [row("a", 1), row("b", 2)] }
            : { timestamp: 20, data: [row("a", 3), { ...row("b", 2), isDelete: true }] };
        await options.onPage?.(result.data, {
          nextSkip: (options.skip ?? 0) + result.data.length,
          timestamp: result.timestamp,
        });
        return result;
      });
      assert.deepEqual(await store.sync(), [row("a", 1), row("b", 2)]);
      assert.deepEqual(await store.sync(), [row("a", 3)]);
      assert.deepEqual(checkpoints, [0, 10]);
    } finally {
      if (before === undefined) delete process.env.MONEYLOVER_CONFIG_DIR;
      else process.env.MONEYLOVER_CONFIG_DIR = before;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resumes the first sync from the last persisted page", async () => {
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
      assert.deepEqual(await store.sync(), [row("a", 1), row("b", 2)]);
      assert.deepEqual(skips, [0, 300]);
    } finally {
      if (before === undefined) delete process.env.MONEYLOVER_CONFIG_DIR;
      else process.env.MONEYLOVER_CONFIG_DIR = before;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
