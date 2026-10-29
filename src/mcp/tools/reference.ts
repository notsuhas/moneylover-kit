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
        "Every wallet by name, with its balance where the backend reports one. " +
        "These names are what the other tools accept.",
      inputSchema: { fresh: z.boolean().default(false).describe("Wait for API reconciliation") },
    },
    async ({ fresh }) => {
      const saved = await reads.value("reference:wallets", () => client.wallets(), fresh);
      return json({
        wallets: saved.value.map((w) => ({
          name: w.name,
          archived: w.archived,
          ...(w.balance ? { balance: w.balance } : {}),
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
