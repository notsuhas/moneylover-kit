import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aCategory,
  aTransaction,
  aWallet,
  lendingCategories,
  WEB_CAN,
} from "../../core/__tests__/fixtures.js";
import type { Backend } from "../../core/types.js";
import { createMcpServer } from "../server.js";

const backend: Backend = {
  name: "web",
  can: WEB_CAN,
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
  const toolsOf = (env: Record<string, string>): string[] => {
    const before = { ...process.env };
    Object.assign(process.env, env);
    try {
      const server = createMcpServer({ use: backend });
      return Object.keys(
        (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
      ).sort();
    } finally {
      process.env = before;
    }
  };

  const ALWAYS = [
    "add_transaction",
    "delete_transaction",
    "edit_transaction",
    "lending_summary",
    "list_categories",
    "list_wallets",
    "record_lending",
    "search_transactions",
  ];
  const STRUCTURE = [
    "add_category",
    "add_wallet",
    "edit_category",
    "edit_wallet",
    "list_currencies_hint",
  ];
  const DELETIONS = ["delete_category", "delete_wallet"];

  it("registers exactly the documented tool surface", () => {
    assert.deepEqual(toolsOf({}), ALWAYS);
  });

  it("adds wallet and category writes only when the structure flag is set", () => {
    assert.deepEqual(
      toolsOf({ MONEYLOVER_MCP_ALLOW_STRUCTURE: "1" }),
      [...ALWAYS, ...STRUCTURE].sort(),
    );
  });

  it("keeps deleting a wallet or category behind its own flag", () => {
    // The point of the split: everything reshaping the account, none of the
    // two things that cannot be undone.
    const structureOnly = toolsOf({ MONEYLOVER_MCP_ALLOW_STRUCTURE: "1" });
    assert.equal(
      DELETIONS.some((t) => structureOnly.includes(t)),
      false,
    );
    assert.deepEqual(
      toolsOf({ MONEYLOVER_MCP_ALLOW_STRUCTURE: "1", MONEYLOVER_MCP_ALLOW_DELETE: "1" }),
      [...ALWAYS, ...STRUCTURE, ...DELETIONS].sort(),
    );
  });

  it("treats any value other than 1 as off", () => {
    assert.deepEqual(
      toolsOf({ MONEYLOVER_MCP_ALLOW_STRUCTURE: "true", MONEYLOVER_MCP_ALLOW_DELETE: "yes" }),
      ALWAYS,
    );
  });
});
