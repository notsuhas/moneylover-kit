import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aCategory,
  aTransaction,
  aWallet,
  lendingCategories,
} from "../../core/__tests__/fixtures.js";
import type { Backend } from "../../core/types.js";
import { createMcpServer } from "../server.js";

const backend: Backend = {
  name: "web",
  can: { balances: true, wallets: true, categories: true, labels: false },
  account: async () => ({ id: "u1", email: "a@b.c", deviceLimit: 5 }),
  wallets: async () => [aWallet({ id: "w1", name: "Savings", balance: { INR: "10.00" } })],
  categories: async () => [...lendingCategories, aCategory({ id: "c1", name: "Groceries" })],
  transactions: async () => [aTransaction({ id: "t1", walletId: "w1", categoryId: "c1" })],
  events: async () => [],
  addTransaction: async () => "new",
  editTransaction: async () => {},
  deleteTransaction: async () => {},
};

describe("createMcpServer", () => {
  it("registers exactly the documented tool surface", async () => {
    const server = createMcpServer({ use: backend });
    // The registry is the only place the tool list actually exists.
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    assert.deepEqual(registered.sort(), [
      "add_transaction",
      "delete_transaction",
      "edit_transaction",
      "lending_summary",
      "list_categories",
      "list_wallets",
      "record_lending",
      "search_transactions",
    ]);
  });

  it("keeps category and wallet creation off the surface on purpose", () => {
    const server = createMcpServer({ use: backend });
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    assert.equal(
      registered.some((t) => /create|add_category|add_wallet/.test(t)),
      false,
    );
  });
});
