import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "../client/index.js";
import { aCategory, aTransaction, aWallet, lendingCategories } from "../core/__tests__/fixtures.js";
import type { Backend, NewTransaction, Transaction, TransactionPatch } from "../core/types.js";

/** A backend that records what it was asked, so the composition is testable. */
function fakeBackend(seed: Transaction[] = []) {
  const rows = new Map(seed.map((t) => [t.id, t]));
  const calls = { transactions: 0, wallets: 0, add: 0, edit: 0, remove: 0 };
  let lastAdd: NewTransaction | undefined;

  const backend: Backend = {
    name: "web",
    can: { balances: true, wallets: true, categories: true, labels: false },
    account: async () => ({ id: "u1", email: "a@b.c", deviceLimit: 5 }),
    wallets: async () => {
      calls.wallets += 1;
      return [aWallet({ id: "w1", name: "Savings" }), aWallet({ id: "w2", name: "Current" })];
    },
    categories: async () => [
      ...lendingCategories,
      aCategory({ id: "c1", name: "Groceries" }),
      aCategory({ id: "c2", name: "Salary", type: "income" }),
    ],
    transactions: async () => {
      calls.transactions += 1;
      return [...rows.values()];
    },
    events: async () => [{ id: "e1", name: "Goa" }],
    addTransaction: async (input) => {
      calls.add += 1;
      lastAdd = input;
      const id = `new-${calls.add}`;
      rows.set(
        id,
        aTransaction({
          id,
          amount: input.amount,
          note: input.note ?? "",
          walletId: input.wallet,
          categoryId: input.category,
          people: input.people ?? [],
        }),
      );
      return id;
    },
    editTransaction: async (id, patch: TransactionPatch) => {
      calls.edit += 1;
      const row = rows.get(id);
      if (!row) throw new Error(`missing ${id}`);
      rows.set(id, { ...row, ...(patch.note !== undefined ? { note: patch.note } : {}) });
    },
    deleteTransaction: async (id) => {
      calls.remove += 1;
      rows.delete(id);
    },
  };
  return { backend, calls, rows, lastAdd: () => lastAdd };
}

describe("createClient — backend selection", () => {
  it("defaults to the web backend", () => {
    assert.equal(createClient({ token: "t" }).backend, "web");
  });

  it("rejects an unknown name rather than defaulting silently", () => {
    assert.throws(() => createClient({ backend: "pigeon" as never }), /unknown backend/);
  });

  it("honours MONEYLOVER_BACKEND", () => {
    const before = process.env.MONEYLOVER_BACKEND;
    process.env.MONEYLOVER_BACKEND = "mobile";
    try {
      assert.equal(createClient({ token: "t" }).backend, "mobile");
    } finally {
      if (before === undefined) delete process.env.MONEYLOVER_BACKEND;
      else process.env.MONEYLOVER_BACKEND = before;
    }
  });

  it("prefers an injected backend", () => {
    const { backend } = fakeBackend();
    assert.equal(createClient({ use: backend }).backend, "web");
  });
});

describe("createClient — caching", () => {
  it("reads the transaction list once within the window", async () => {
    const fake = fakeBackend([aTransaction({ id: "a" })]);
    const client = createClient({ use: fake.backend });
    await client.transactions();
    await client.transactions();
    assert.equal(fake.calls.transactions, 1);
  });

  it("does not cache at all when cacheSeconds is 0", async () => {
    const fake = fakeBackend([aTransaction({ id: "a" })]);
    const client = createClient({ use: fake.backend, cacheSeconds: 0 });
    await client.transactions();
    await client.transactions();
    assert.equal(fake.calls.transactions, 2);
  });

  /** An edit rebuilt from a stale row would push stale fields back. */
  it("invalidates the cache after a write", async () => {
    const fake = fakeBackend([aTransaction({ id: "a", note: "before" })]);
    const client = createClient({ use: fake.backend });
    await client.transactions();
    await client.editTransaction("a", { note: "after" });
    const rows = await client.transactions();
    assert.equal(rows.find((t) => t.id === "a")?.note, "after");
  });

  it("returns wallets from cache too", async () => {
    const fake = fakeBackend();
    const client = createClient({ use: fake.backend });
    await client.wallets();
    await client.wallets();
    assert.equal(fake.calls.wallets, 1);
  });
});

describe("createClient — transactions", () => {
  const seed = [
    aTransaction({ id: "a", walletId: "w1", categoryId: "c1", note: "DMart", amount: -500 }),
    aTransaction({ id: "b", walletId: "w2", categoryId: "c2", note: "Payslip", amount: 45000 }),
  ];

  it("filters by wallet name", async () => {
    const client = createClient({ use: fakeBackend(seed).backend });
    assert.deepEqual(
      (await client.transactions({ wallet: "Savings" })).map((t) => t.id),
      ["a"],
    );
  });

  it("throws on an unknown wallet rather than returning everything", async () => {
    const client = createClient({ use: fakeBackend(seed).backend });
    await assert.rejects(() => client.transactions({ wallet: "Nope" }), /no wallet/);
  });

  it("filters by category name", async () => {
    const client = createClient({ use: fakeBackend(seed).backend });
    assert.deepEqual(
      (await client.transactions({ category: "Salary" })).map((t) => t.id),
      ["b"],
    );
  });

  it("throws on an unknown category", async () => {
    const client = createClient({ use: fakeBackend(seed).backend });
    await assert.rejects(() => client.transactions({ category: "Nope" }), /no category/);
  });

  it("passes the remaining filters through", async () => {
    const client = createClient({ use: fakeBackend(seed).backend });
    assert.deepEqual(
      (await client.transactions({ note: "dmart" })).map((t) => t.id),
      ["a"],
    );
  });

  it("finds one row by id", async () => {
    const client = createClient({ use: fakeBackend(seed).backend });
    assert.equal((await client.transaction("b")).note, "Payslip");
  });

  it("throws for an id that is not there", async () => {
    const client = createClient({ use: fakeBackend(seed).backend });
    await assert.rejects(() => client.transaction("zzz"), /no transaction/);
  });
});

describe("createClient — writes", () => {
  it("returns the committed row after an add, not the input", async () => {
    const fake = fakeBackend();
    const client = createClient({ use: fake.backend });
    const created = await client.addTransaction({
      wallet: "w1",
      category: "c1",
      amount: -480,
      note: "DMart",
    });
    assert.equal(created.id, "new-1");
    assert.equal(created.note, "DMart");
  });

  it("returns the row as it now stands after an edit", async () => {
    const fake = fakeBackend([aTransaction({ id: "a", note: "before" })]);
    const client = createClient({ use: fake.backend });
    assert.equal((await client.editTransaction("a", { note: "after" })).note, "after");
  });

  /** The row has to be captured before it is gone, or there is nothing to report. */
  it("returns the deleted row, read before the delete", async () => {
    const fake = fakeBackend([aTransaction({ id: "a", note: "gone soon" })]);
    const client = createClient({ use: fake.backend });
    assert.equal((await client.deleteTransaction("a")).note, "gone soon");
    assert.equal(fake.rows.size, 0);
  });

  it("refuses to delete something that is not there", async () => {
    const client = createClient({ use: fakeBackend().backend });
    await assert.rejects(() => client.deleteTransaction("zzz"), /no transaction/);
  });
});

describe("createClient — lending", () => {
  it("records a loan as an expense against the loan category", async () => {
    const fake = fakeBackend();
    const client = createClient({ use: fake.backend });
    await client.recordLending("lend", { person: "Sam", amount: 5000, wallet: "Savings" });
    const input = fake.lastAdd();
    assert.equal(input?.amount, -5000, "a loan leaves the account");
    assert.equal(input?.category, "loan");
    assert.deepEqual(input?.people, ["Sam"]);
  });

  it("records a collection as income", async () => {
    const fake = fakeBackend();
    const client = createClient({ use: fake.backend });
    await client.recordLending("collect", { person: "Sam", amount: 3000, wallet: "Current" });
    assert.equal(fake.lastAdd()?.amount, 3000);
    assert.equal(fake.lastAdd()?.category, "collect");
  });

  it("insists the amount is positive, because the verb sets the direction", async () => {
    const client = createClient({ use: fakeBackend().backend });
    await assert.rejects(
      () => client.recordLending("lend", { person: "Sam", amount: -5000, wallet: "Savings" }),
      /must be positive/,
    );
  });

  it("throws on an unknown wallet before writing anything", async () => {
    const fake = fakeBackend();
    const client = createClient({ use: fake.backend });
    await assert.rejects(
      () => client.recordLending("lend", { person: "Sam", amount: 1, wallet: "Nope" }),
      /no wallet/,
    );
    assert.equal(fake.calls.add, 0);
  });

  it("summarises across wallets", async () => {
    const fake = fakeBackend([
      aTransaction({ id: "1", categoryId: "loan", amount: -5000, walletId: "w1", people: ["Sam"] }),
      aTransaction({
        id: "2",
        categoryId: "collect",
        amount: 3000,
        walletId: "w2",
        people: ["Sam"],
      }),
    ]);
    const [sam] = await createClient({ use: fake.backend }).lending();
    assert.equal(sam?.outstanding, 2000);
  });

  it("returns an empty label list on a backend without one", async () => {
    assert.deepEqual(await createClient({ use: fakeBackend().backend }).labels(), []);
  });
});

describe("createClient — retag", () => {
  it("does nothing for an empty plan", async () => {
    const fake = fakeBackend();
    assert.equal(await createClient({ use: fake.backend }).retag([]), 0);
    assert.equal(fake.calls.edit, 0);
  });

  /** Without batching this is thousands of round trips, so it must be used. */
  it("uses the backend's batch path when there is one", async () => {
    const fake = fakeBackend([aTransaction({ id: "a" }), aTransaction({ id: "b" })]);
    let batched: number | undefined;
    const backend = {
      ...fake.backend,
      retagTransactions: async (plan: { id: string; category: string }[]) => {
        batched = plan.length;
        return plan.length;
      },
    };
    const written = await createClient({ use: backend }).retag([
      { id: "a", category: "Groceries" },
      { id: "b", category: "Groceries" },
    ]);
    assert.equal(written, 2);
    assert.equal(batched, 2);
    assert.equal(fake.calls.edit, 0, "must not fall back to one-at-a-time");
  });

  it("falls back to sequential edits when the backend cannot batch", async () => {
    const fake = fakeBackend([aTransaction({ id: "a" }), aTransaction({ id: "b" })]);
    const written = await createClient({ use: fake.backend }).retag([
      { id: "a", category: "Groceries" },
      { id: "b", category: "Groceries" },
    ]);
    assert.equal(written, 2);
    assert.equal(fake.calls.edit, 2);
  });
});
