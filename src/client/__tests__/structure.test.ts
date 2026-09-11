import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_CAN, aCategory, aWallet, NO_CAN } from "../../core/__tests__/fixtures.js";
import { createCache } from "../../core/cache.js";
import type { Backend, Capabilities, Category, Wallet } from "../../core/types.js";
import { createStructureApi } from "../structure.js";

const WALLETS: Wallet[] = [aWallet({ id: "w1", name: "Savings", icon: "icon_1" })];
const CATEGORIES: Category[] = [aCategory({ id: "c1", name: "Groceries" })];

const ALL = ALL_CAN;
const NONE = NO_CAN;

function api(can: Capabilities = ALL) {
  const calls: string[] = [];
  const backend = {
    name: "web",
    can,
    addWallet: async () => {
      calls.push("addWallet");
      return "w1";
    },
    editWallet: async () => void calls.push("editWallet"),
    deleteWallet: async () => void calls.push("deleteWallet"),
    addCategory: async () => {
      calls.push("addCategory");
      return "new-id";
    },
    editCategory: async () => void calls.push("editCategory"),
    deleteCategory: async () => void calls.push("deleteCategory"),
  } as unknown as Backend;

  return {
    calls,
    structure: createStructureApi({
      backend,
      cache: createCache(60),
      wallets: async () => WALLETS,
      categories: async () => CATEGORIES,
    }),
  };
}

describe("createStructureApi — capability guards", () => {
  const { structure } = api(NONE);

  it("refuses a wallet write and names the other backend", async () => {
    await assert.rejects(
      () => structure.addWallet({ name: "X", currencyId: 11 }),
      /cannot write wallets — try the mobile backend/,
    );
  });

  it("refuses a category write", async () => {
    await assert.rejects(
      () => structure.addCategory({ name: "X", type: "expense" }),
      /cannot write categories/,
    );
  });
});

describe("createStructureApi — wallets", () => {
  it("returns the created wallet, read back", async () => {
    const { structure, calls } = api();
    assert.equal((await structure.addWallet({ name: "Savings", currencyId: 11 })).name, "Savings");
    assert.deepEqual(calls, ["addWallet"]);
  });

  it("resolves a wallet by name before editing", async () => {
    const { structure, calls } = api();
    assert.equal((await structure.editWallet("savings", { name: "Savings" })).id, "w1");
    assert.deepEqual(calls, ["editWallet"]);
  });

  it("returns the wallet as it was before deleting it", async () => {
    const { structure } = api();
    assert.equal((await structure.deleteWallet("Savings")).id, "w1");
  });

  it("throws on an unknown wallet without calling the backend", async () => {
    const { structure, calls } = api();
    await assert.rejects(() => structure.editWallet("Nope", { name: "x" }), /no wallet/);
    assert.deepEqual(calls, []);
  });
});

describe("createStructureApi — categories", () => {
  /**
   * A created category is not immediately visible: the web API's provisional
   * id is absent from the list for a few seconds and the mobile API returns a
   * label id that never appears there. Re-reading would fail a write that
   * actually worked.
   */
  it("reports a created category from the input when it is not yet visible", async () => {
    const { structure } = api();
    const made = await structure.addCategory({ name: "Supplements", type: "expense" });
    assert.equal(made.name, "Supplements");
    assert.equal(made.id, "new-id");
    assert.equal(made.type, "expense");
  });

  it("prefers the real row when the backend does show it", async () => {
    const { structure } = api();
    const made = await structure.addCategory({ name: "Groceries", type: "expense" });
    assert.equal(made.id, "c1");
  });

  it("reports the intended state after an edit", async () => {
    const { structure } = api();
    const updated = await structure.editCategory("Groceries", { name: "Food shopping" });
    assert.equal(updated.name, "Food shopping");
    assert.equal(updated.id, "c1");
  });

  it("returns the category as it was before deleting it", async () => {
    const { structure } = api();
    assert.equal((await structure.deleteCategory("groceries")).name, "Groceries");
  });

  it("throws on an unknown category", async () => {
    const { structure } = api();
    await assert.rejects(() => structure.deleteCategory("Nope"), /no category/);
  });
});

describe("createStructureApi — cache invalidation", () => {
  /** Deleting a wallet deletes its transactions server-side. */
  it("drops the transaction cache too, not just the structure entries", async () => {
    const dropped: string[] = [];
    const cache = {
      read: <T>(_k: string, load: () => Promise<T>) => load(),
      drop: (...keys: string[]) => dropped.push(...keys),
    };
    const backend = {
      name: "web",
      can: ALL,
      deleteWallet: async () => {},
    } as unknown as Backend;

    await createStructureApi({
      backend,
      cache,
      wallets: async () => WALLETS,
      categories: async () => CATEGORIES,
    }).deleteWallet("Savings");

    assert.ok(dropped.includes("transactions"), "transactions must be invalidated");
    assert.ok(dropped.includes("wallets"));
  });
});
