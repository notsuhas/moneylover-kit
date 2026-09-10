/**
 * The MCP tool surface.
 *
 * Transactions and lending are always available. Wallet and category writes
 * are registered only when MONEYLOVER_MCP_ALLOW_STRUCTURE=1, because they
 * reshape the account — deleting a wallet takes its transactions with it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ClientOptions, createClient, type MoneyLover } from "../client/index.js";
import type { Transaction } from "../core/types.js";
import { INSTRUCTIONS, naming } from "./present.js";
import { registerLendingTools } from "./tools/lending.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerStructureTools, structureAllowed } from "./tools/structure.js";
import { type Rendering, registerTransactionTools } from "./tools/transactions.js";

export function createMcpServer(options: ClientOptions = {}): McpServer {
  const client: MoneyLover = createClient(options);
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
      client.wallets(),
      client.events(),
      client.categories(),
    ]);
    const name = naming(wallets, events, categories);
    return rows.map(name);
  };

  registerReferenceTools(server, client);
  registerTransactionTools(server, client, show);
  registerLendingTools(server, client, show);
  // Reshaping the account is opt-in; see tools/structure.ts.
  if (structureAllowed()) registerStructureTools(server, client);

  return server;
}
