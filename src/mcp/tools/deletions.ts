/**
 * Deleting a wallet or a category over MCP.
 *
 * Behind its own flag, separate from the rest of the structure tools, because
 * these two are the only ones nothing can walk back: deleting a wallet takes
 * every transaction in it, and neither API has an undo. Set
 * MONEYLOVER_MCP_ALLOW_DELETE=1 to register them.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MoneyLover } from "../../client/index.js";
import { json } from "../present.js";

/** Whether the delete tools should be registered at all. */
export const deletionsAllowed = (): boolean => process.env.MONEYLOVER_MCP_ALLOW_DELETE === "1";

export function registerDeletionTools(server: McpServer, client: MoneyLover): void {
  server.registerTool(
    "delete_wallet",
    {
      title: "Delete a wallet",
      description:
        "Delete a wallet AND every transaction in it. This cannot be undone and it is not " +
        "a small change — confirm the wallet and its balance with the user first.",
      inputSchema: { wallet: z.string().describe("Wallet name, spelled out") },
    },
    async ({ wallet }) => json({ deleted: await client.deleteWallet(wallet) }),
  );

  server.registerTool(
    "delete_category",
    {
      title: "Delete a category",
      description:
        "Delete a category. Transactions that used it are left alone and will show as " +
        "uncategorised, so retag them first if that matters.",
      inputSchema: { category: z.string() },
    },
    async ({ category }) => json({ deleted: await client.deleteCategory(category) }),
  );
}
