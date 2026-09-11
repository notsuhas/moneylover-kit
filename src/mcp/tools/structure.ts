/**
 * Creating and editing wallets and categories over MCP.
 *
 * Off by default: these reshape the account rather than record something that
 * happened, and an edit is a full replace, so a wrong currency id reinterprets
 * every amount in a wallet. Set MONEYLOVER_MCP_ALLOW_STRUCTURE=1 to register
 * them. Deleting is gated separately again — see deletions.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MoneyLover } from "../../client/index.js";
import { json } from "../present.js";

/** Whether the structure tools should be registered at all. */
export const structureAllowed = (): boolean => process.env.MONEYLOVER_MCP_ALLOW_STRUCTURE === "1";

export function registerStructureTools(server: McpServer, client: MoneyLover): void {
  server.registerTool(
    "add_event",
    {
      title: "Create an event",
      description: "Create a trip/event with an end date. Money Lover does not store a start date.",
      inputSchema: {
        name: z.string().min(1),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("YYYY-MM-DD"),
        currencyId: z.number().int().describe("Money Lover's numeric currency id"),
        icon: z.string().optional(),
      },
    },
    async (args) => json({ created: await client.addEvent(args) }),
  );

  server.registerTool(
    "list_currencies_hint",
    {
      title: "How to name a currency",
      description:
        "Money Lover identifies a currency by a numeric id, not a code. This returns the " +
        "ids already in use on this account, which is the reliable way to pick one for a " +
        "new wallet.",
      inputSchema: {},
    },
    async () => {
      const seen = new Map<number, string[]>();
      for (const w of await client.wallets()) {
        const codes = Object.keys(w.balance ?? {});
        seen.set(w.currencyId, [...new Set([...(seen.get(w.currencyId) ?? []), ...codes])]);
      }
      return json([...seen].map(([currencyId, codes]) => ({ currencyId, codes })));
    },
  );

  server.registerTool(
    "add_wallet",
    {
      title: "Create a wallet",
      description:
        "Create an account/wallet. The currency is a numeric id — use " +
        "list_currencies_hint to find one already in use rather than guessing.",
      inputSchema: {
        name: z.string().min(1),
        currencyId: z.number().int().describe("Money Lover's numeric currency id"),
        icon: z.string().optional(),
      },
    },
    async (args) => json({ created: await client.addWallet(args) }),
  );

  server.registerTool(
    "edit_wallet",
    {
      title: "Rename or reicon a wallet",
      description:
        "Change a wallet's name, icon or currency. Balances and transactions are untouched.",
      inputSchema: {
        wallet: z.string().describe("Current wallet name"),
        name: z.string().optional(),
        icon: z.string().optional(),
        currencyId: z.number().int().optional(),
      },
    },
    async ({ wallet, ...patch }) => {
      if (Object.values(patch).every((v) => v === undefined)) {
        throw new Error("nothing to change — pass a name, icon or currencyId");
      }
      return json({ updated: await client.editWallet(wallet, patch) });
    },
  );

  server.registerTool(
    "add_category",
    {
      title: "Create a category",
      description:
        "Create a category. Omit `wallet` to create it in every wallet, and pass `parent` " +
        "to nest it under an existing one — both need the mobile backend, because that " +
        "shape lives in a layer the web API does not model.",
      inputSchema: {
        name: z.string().min(1),
        type: z.enum(["income", "expense"]),
        wallet: z.string().optional().describe("Omit for every wallet (mobile backend)"),
        parent: z.string().optional().describe("Parent category name (mobile backend)"),
        icon: z.string().optional(),
      },
    },
    async (args) => json({ created: await client.addCategory(args) }),
  );

  server.registerTool(
    "edit_category",
    {
      title: "Rename or reicon a category",
      description:
        "Rename a category, or change its icon. Transactions keep pointing at it. On the " +
        "mobile backend this updates every wallet's copy together.",
      inputSchema: {
        category: z.string().describe("Current category name"),
        name: z.string().optional(),
        icon: z.string().optional(),
      },
    },
    async ({ category, ...patch }) => {
      if (Object.values(patch).every((v) => v === undefined)) {
        throw new Error("nothing to change — pass a name or icon");
      }
      return json({ updated: await client.editCategory(category, patch) });
    },
  );
}
