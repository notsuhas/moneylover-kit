import assert from "node:assert/strict";
import { test } from "node:test";
import { createSync } from "../sync.js";

test("pagination refills a completed slot while a later page is still pending", async () => {
  const previous = globalThis.fetch;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested: number[] = [];
  const rows = Array.from({ length: 1501 }, (_, index) => index);
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requested.push(body.skip);
    if (body.skip === 900) {
      enter();
      await slow;
    }
    return Response.json({
      status: true,
      timestamp: body.skip === 0 ? 777 : 999,
      data: rows.slice(body.skip, body.skip + body.limit),
    });
  }) as typeof fetch;
  const stamps: number[] = [];
  const reading = createSync({ token: "test" }).pullSince<number>(
    "/api/sync/pull/transaction/v2",
    0,
    {
      concurrency: 2,
      onPage: (_rows, state) => {
        stamps.push(state.timestamp);
      },
    },
  );
  try {
    await entered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(
      requested.includes(1200),
      "a free slot must start the next page before the slow page finishes",
    );
    release();
    const result = await reading;
    assert.deepEqual(result.data, rows);
    assert.equal(result.timestamp, 777);
    assert.ok(stamps.every((stamp) => stamp === 777));
  } finally {
    release();
    await reading;
    globalThis.fetch = previous;
  }
});

test("stale size estimates cannot truncate or replace a fresh reconciliation", async () => {
  const previous = globalThis.fetch;
  const rows = Array.from({ length: 901 }, (_, index) => index);
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.last_update, 0);
    return Response.json({
      status: true,
      timestamp: 123,
      data: rows.slice(body.skip, body.skip + body.limit),
    });
  }) as typeof fetch;
  try {
    const sync = createSync({ token: "test" });
    for (const estimatedRows of [0, 300, 600, 901, 3000]) {
      const result = await sync.pullSince<number>("/api/sync/pull/transaction/v2", 0, {
        concurrency: 8,
        estimatedRows,
      });
      assert.deepEqual(result.data, rows);
    }
  } finally {
    globalThis.fetch = previous;
  }
});
