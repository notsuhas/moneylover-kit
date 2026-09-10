/** Read-only lookups a model needs before it can write anything. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MoneyLover } from "../../client/index.js";
import { json } from "../present.js";

export function registerReferenceTools(server: McpServer, client: MoneyLover): void {
  server.registerTool(
    "list_wallets",
    {
      title: "List wallets",
      description:
        "Every wallet by name, with its balance where the backend reports one. " +
        "These names are what the other tools accept.",
      inputSchema: {},
    },
    async () =>
      json(
        (await client.wallets()).map((w) => ({
          name: w.name,
          archived: w.archived,
          ...(w.balance ? { balance: w.balance } : {}),
        })),
      ),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description:
        "Category names valid for writing, with whether each is income or expense. " +
        "Deduplicated by name, because one category may exist per wallet internally.",
      inputSchema: {},
    },
    async () => {
      const seen = new Map<string, { name: string; type: string }>();
      for (const c of await client.categories()) {
        if (!seen.has(c.name)) seen.set(c.name, { name: c.name, type: c.type });
      }
      return json([...seen.values()].sort((a, b) => a.name.localeCompare(b.name)));
    },
  );
}
