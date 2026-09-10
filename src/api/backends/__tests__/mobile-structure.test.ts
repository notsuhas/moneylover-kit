/**
 * The two-layer category writes.
 *
 * Money Lover stores a category once per wallet plus a global label, and both
 * pushes are full replacements. Each case here corresponds to a way the two
 * layers were drifting out of agreement.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Category, Label, Wallet } from "../../../core/types.js";
import { createStructure } from "../mobile/structure.js";

const WALLETS: Wallet[] = [
  { id: "w1", name: "Savings", currencyId: 11, archived: false },
  { id: "w2", name: "Current", currencyId: 11, archived: false },
];

const CATEGORIES: Category[] = [
  { id: "food-w1", name: "Food", icon: "ic_food", type: "expense", walletId: "w1", group: 3 },
  { id: "food-w2", name: "Food", icon: "ic_food", type: "expense", walletId: "w2", group: 3 },
  {
    id: "groc-w1",
    name: "Groceries",
    icon: "ic_groc",
    type: "expense",
    walletId: "w1",
    parentId: "food-w1",
    metadata: "keep-me",
  },
  {
    id: "groc-w2",
    name: "Groceries",
    icon: "ic_groc",
    type: "expense",
    walletId: "w2",
    parentId: "food-w2",
  },
];

const LABELS: Label[] = [
  {
    id: "food-label",
    name: "Food",
    icon: "ic_food",
    type: "expense",
    categoryIds: ["food-w1", "food-w2"],
    excludedWalletIds: [],
  },
  {
    id: "groc-label",
    name: "Groceries",
    icon: "ic_groc",
    type: "expense",
    categoryIds: ["groc-w1", "groc-w2"],
    excludedWalletIds: [],
    parentId: "food-label",
  },
];

interface Pushed {
  kind: string;
  items: Record<string, unknown>[];
}

function harness() {
  const pushes: Pushed[] = [];
  const structure = createStructure({
    push: async (kind, items) => {
      pushes.push({ kind, items: items as Record<string, unknown>[] });
      return items.length;
    },
    wallets: async () => WALLETS,
    categories: async () => CATEGORIES,
    labels: async () => LABELS,
  });
  const of = (kind: string) => pushes.filter((p) => p.kind === kind).flatMap((p) => p.items);
  return { structure, pushes, of };
}

describe("addCategory", () => {
  it("writes one row per wallet plus one label when no wallet is named", async () => {
    const { structure, of } = harness();
    await structure.addCategory({ name: "Supplements", type: "expense" });
    assert.equal(of("category").length, 2);
    assert.equal(of("label").length, 1);
  });

  /** An empty exclusion list means "every wallet", so it must not be empty here. */
  it("excludes the other wallets when only one is targeted", async () => {
    const { structure, of } = harness();
    await structure.addCategory({ name: "Supplements", type: "expense", wallet: "Savings" });
    assert.equal(of("category").length, 1);
    assert.deepEqual(of("label")[0]?.eac, ["w2"]);
  });

  it("leaves the exclusion list empty for an all-wallet category", async () => {
    const { structure, of } = harness();
    await structure.addCategory({ name: "Supplements", type: "expense" });
    assert.deepEqual(of("label")[0]?.eac, []);
  });

  it("points each row at its parent in its own wallet", async () => {
    const { structure, of } = harness();
    await structure.addCategory({ name: "Supplements", type: "expense", parent: "Food" });
    const rows = of("category");
    assert.equal(rows.find((r) => r.ac === "w1")?.pi, "food-w1");
    assert.equal(rows.find((r) => r.ac === "w2")?.pi, "food-w2");
    assert.equal(of("label")[0]?.pi, "food-label", "and the label at the parent label");
  });

  it("refuses when the parent is missing from a target wallet", async () => {
    const { structure } = harness();
    await assert.rejects(
      () => structure.addCategory({ name: "X", type: "expense", parent: "Nowhere" }),
      /no category/,
    );
  });

  it("refuses to duplicate a name inside a wallet", async () => {
    const { structure } = harness();
    await assert.rejects(
      () => structure.addCategory({ name: "Groceries", type: "expense", wallet: "Savings" }),
      /already exists/,
    );
  });
});

describe("editCategory", () => {
  /** The caller resolves through the per-wallet list, so that is what arrives. */
  it("accepts a per-wallet category id, not just a label id", async () => {
    const { structure, of } = harness();
    await structure.editCategory("groc-w1", { name: "Food shopping" });
    assert.equal(of("category").length, 2, "both wallets updated");
    assert.equal(of("label")[0]?.n, "Food shopping");
  });

  it("accepts a label id", async () => {
    const { structure, of } = harness();
    await structure.editCategory("groc-label", { name: "Food shopping" });
    assert.equal(of("label")[0]?.gid, "groc-label");
  });

  it("accepts a name", async () => {
    const { structure, of } = harness();
    await structure.editCategory("groceries", { icon: "ic_new" });
    assert.equal(of("label")[0]?.ic, "ic_new");
  });

  /** A category push is a full replace, so dropping `pi` unnests the row. */
  it("keeps the per-wallet parent link", async () => {
    const { structure, of } = harness();
    await structure.editCategory("groc-label", { name: "Food shopping" });
    const rows = of("category");
    assert.equal(rows.find((r) => r.gid === "groc-w1")?.pi, "food-w1");
    assert.equal(rows.find((r) => r.gid === "groc-w2")?.pi, "food-w2");
  });

  it("keeps the group and the app's own metadata", async () => {
    const { structure, of } = harness();
    await structure.editCategory("groc-label", { name: "X" });
    const row = of("category").find((r) => r.gid === "groc-w1");
    assert.equal(row?.md, "keep-me");
    assert.equal(of("category").find((r) => r.gid === "food-w1")?.gr, undefined);
  });

  it("keeps the label's parent", async () => {
    const { structure, of } = harness();
    await structure.editCategory("groc-label", { name: "X" });
    assert.equal(of("label")[0]?.pi, "food-label");
  });
});

describe("deleteCategory", () => {
  it("removes every wallet row and the label", async () => {
    const { structure, of } = harness();
    await structure.deleteCategory("groc-label");
    assert.equal(of("category").length, 2);
    assert.ok(of("category").every((r) => r.isDelete === true && r.f === 3));
    assert.equal(of("label")[0]?.isDelete, true);
  });

  /** Deleting a parent would leave its children pointing at nothing. */
  it("refuses to delete a category that is a parent", async () => {
    const { structure } = harness();
    await assert.rejects(() => structure.deleteCategory("food-label"), /is a parent/);
  });

  it("resolves a per-wallet id for deletion too", async () => {
    const { structure, of } = harness();
    await structure.deleteCategory("groc-w2");
    assert.equal(of("label")[0]?.gid, "groc-label");
  });
});
