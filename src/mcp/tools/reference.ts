/** Read-only lookups a model needs before it can write anything. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MoneyLover } from "../../client/index.js";
import type { createLocalReads } from "../ledger.js";
import { json } from "../present.js";

export function registerReferenceTools(
  server: McpServer,
  client: MoneyLover,
  reads: ReturnType<typeof createLocalReads>,
): void {
  server.registerTool(
    "list_wallets",
    {
      title: "List wallets",
      description:
        "Every wallet by name. Set balances=false for fast wallet-name lookups without scanning transaction history; leave it true when current balances are needed.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        fresh: z.boolean().default(false).describe("Wait for API reconciliation"),
        balances: z
          .boolean()
          .default(true)
          .describe("False skips transaction scans when only wallet names are needed"),
      },
    },
    async ({ fresh, balances }) => {
      const saved = await reads.value(
        balances ? "reference:wallets" : "reference:wallet-catalog",
        () => (balances ? client.wallets() : client.walletCatalog()),
        fresh,
      );
      return json({
        wallets: saved.value.map((w) => ({
          name: w.name,
          archived: w.archived,
          ...(balances && w.balance ? { balance: w.balance } : {}),
        })),
        sync: saved.sync,
      });
    },
  );

  server.registerTool(
    "list_events",
    {
      title: "List events",
      description: "Existing events with IDs for tagging transactions and lending.",
      inputSchema: { fresh: z.boolean().default(false).describe("Wait for API reconciliation") },
    },
    async ({ fresh }) => {
      const saved = await reads.value("reference:events", () => client.events(), fresh);
      return json({ events: saved.value, sync: saved.sync });
    },
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description:
        "Category names valid for writing, with whether each is income or expense. " +
        "Deduplicated by name, because one category may exist per wallet internally.",
      inputSchema: { fresh: z.boolean().default(false).describe("Wait for API reconciliation") },
    },
    async ({ fresh }) => {
      const saved = await reads.value(
        "reference:categories",
        async () => {
          const seen = new Map<string, { name: string; type: string }>();
          for (const c of await client.categories())
            if (!seen.has(c.name)) seen.set(c.name, { name: c.name, type: c.type });
          return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
        },
        fresh,
      );
      return json({ categories: saved.value, sync: saved.sync });
    },
  );
}
