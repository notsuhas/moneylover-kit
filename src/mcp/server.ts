/**
 * The MCP tool surface.
 *
 * Transactions and lending are always available. Creating and editing wallets
 * and categories needs MONEYLOVER_MCP_ALLOW_STRUCTURE=1, because those reshape
 * the account. Deleting one is a separate flag again,
 * MONEYLOVER_MCP_ALLOW_DELETE=1, because it is the only thing here that cannot
 * be walked back.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ClientOptions, createClient, type MoneyLover } from "../client/index.js";
import type { Transaction } from "../core/types.js";
import { INSTRUCTIONS, json, naming } from "./present.js";
import { deletionsAllowed, registerDeletionTools } from "./tools/deletions.js";
import { registerLendingTools } from "./tools/lending.js";
import { registerRecordingTool } from "./tools/recording.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerStructureTools, structureAllowed } from "./tools/structure.js";
import { type Rendering, registerTransactionTools } from "./tools/transactions.js";

export function createMcpServer(options: ClientOptions = {}): McpServer {
  const client: MoneyLover = createClient({ cacheSeconds: 0, ...options });

  const server = new McpServer(
    { name: "moneylover", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  /**
   * Names are resolved against the account rather than the row, because
   * neither backend gives a transaction everything needed to name itself.
   */
  const show: Rendering = async (rows: Transaction[]) => {
    const [wallets, events, categories] = await Promise.all([
      client.walletCatalog(),
      client.events(),
      client.categories(),
    ]);
    const name = naming(wallets, events, categories);
    return rows.map(name);
  };

  server.registerTool(
    "get_transactions",
    {
      title: "Get saved transactions by ID",
      description:
        "Return only the requested saved records, using one fresh reconciliation. Pass wallet when known to refresh only that wallet; omitting wallet reconciles the whole account. Prefer record_transactions for new receipts; its verified response needs no extra lookup.",
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).max(50),
        wallet: z.string().optional().describe("Payment wallet name or ID, when known"),
      },
    },
    async ({ ids, wallet }) =>
      client.withFreshReads(async () => {
        let rows: Transaction[];
        if (wallet) {
          const scoped = await client.transactions({ wallet });
          rows = ids.map((id) => {
            const row = scoped.find((candidate) => candidate.id === id);
            if (!row) throw new Error(`No transaction ${id} in the requested wallet`);
            return row;
          });
        } else rows = await Promise.all(ids.map((id) => client.transaction(id)));
        return json({ transactions: await show(rows) });
      }),
  );
  registerRecordingTool(
    server,
    client,
    show,
    options.email?.toLowerCase() ??
      process.env.MONEYLOVER_EMAIL?.toLowerCase() ??
      options.mobileToken ??
      options.token ??
      process.env.MONEYLOVER_MOBILE_TOKEN ??
      process.env.MONEYLOVER_ACCESS_TOKEN,
  );
  registerReferenceTools(server, client);
  registerTransactionTools(server, client, show);
  registerLendingTools(server, client, show);
  // Both opt-in, and independently; see tools/structure.ts and tools/deletions.ts.
  if (structureAllowed()) registerStructureTools(server, client);
  if (deletionsAllowed()) registerDeletionTools(server, client);

  return server;
}
