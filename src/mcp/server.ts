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

/**
 * How long the MCP server reuses a read.
 *
 * Longer than the library default because this process is long-lived and the
 * expensive reads — the whole transaction list, the whole category list —
 * barely change. Writes invalidate regardless, so a stale row is not a risk;
 * the only cost is that a change made in the phone app takes a few minutes to
 * appear.
 */
const CACHE_SECONDS = 300;

export function createMcpServer(options: ClientOptions = {}): McpServer {
  const client: MoneyLover = createClient({ cacheSeconds: CACHE_SECONDS, ...options });

  /**
   * Warm the caches at startup, off the critical path.
   *
   * The first tool call otherwise pays for the login plus the wallet and
   * category lists — measured at 28s cold, which a 30s gateway timeout kills.
   * Failures are ignored: this is an optimisation, and the real call will
   * report a genuine problem properly.
   */
  void Promise.all([client.wallets(), client.categories(), client.transactions()]).catch(() => {});
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
