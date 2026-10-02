import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createMobileBackend } from "../mobile/index.js";

it("serializes a linked collection using the receiving wallet's category and native pi", async () => {
  const oldFetch = globalThis.fetch;
  const oldDirectory = process.env.MONEYLOVER_CONFIG_DIR;
  const directory = mkdtempSync(join(tmpdir(), "loan-wire-"));
  process.env.MONEYLOVER_CONFIG_DIR = directory;
  let item: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    let data: unknown = [];
    if (url.includes("/pull/account"))
      data = [{ _id: "receiving", name: "Receiving", currency_id: 11 }];
    if (url.includes("/pull/category"))
      data = [
        {
          _id: "receiving-collect",
          name: "Collection",
          type: 1,
          metadata: "IS_DEBT_COLLECTION",
          account: { _id: "receiving" },
        },
      ];
    if (url.includes("/push/transaction")) {
      const body = JSON.parse(String(init.body));
      item = JSON.parse(body.data).d[0];
      return new Response(JSON.stringify({ status: true, failedItems: [] }));
    }
    return new Response(JSON.stringify({ status: true, data, timestamp: 1 }));
  }) as typeof fetch;
  try {
    await createMobileBackend({
      token: "test-token",
      email: "loan-test@example.invalid",
    }).addTransaction({
      wallet: "Receiving",
      category: "receiving-collect",
      amount: 140,
      parentId: "origin-loan",
      date: "2026-09-16",
      people: ["Sam"],
      excludeReport: true,
      eventId: "trip",
    });
    assert.equal(item?.pi, "origin-loan");
    assert.equal(item?.ac, "receiving");
    assert.equal(item?.c, "receiving-collect");
    assert.equal(item?.a, 140);
    assert.equal(item?.er, true);
    assert.deepEqual(item?.cp, ["trip"]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDirectory === undefined) delete process.env.MONEYLOVER_CONFIG_DIR;
    else process.env.MONEYLOVER_CONFIG_DIR = oldDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
});
