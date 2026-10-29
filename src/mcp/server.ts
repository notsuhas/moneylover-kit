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
import { createClient, type MoneyLover } from "../client/index.js";
import type { Ledger } from "../core/ledger.js";
import type { Transaction } from "../core/types.js";
import { createLedger, createLocalReads, type ILedgerOptions, observeWrites } from "./ledger.js";
import { INSTRUCTIONS, json, naming } from "./present.js";
import { deletionsAllowed, registerDeletionTools } from "./tools/deletions.js";
import { registerLendingTools } from "./tools/lending.js";
import { registerRecordingTool } from "./tools/recording.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerStructureTools, structureAllowed } from "./tools/structure.js";
import { type Rendering, registerTransactionTools } from "./tools/transactions.js";

export function createMcpServer(options: ILedgerOptions = {}): McpServer {
  const ledger: Ledger | undefined = createLedger(options);
  const client: MoneyLover = observeWrites(createClient({ cacheSeconds: 0, ...options }), ledger);

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
      rows.every((row) => row.categoryName)
        ? Promise.resolve([])
        : Promise.all(
            [...new Set(rows.map((row) => row.walletId))].map((wallet) =>
              client.categories(wallet),
            ),
          ).then((groups) => groups.flat()),
    ]);
    const name = naming(wallets, events, categories);
    return rows.map(name);
  };

  const reads = createLocalReads(client, show, ledger);
  const close = server.close.bind(server);
  server.close = async () => {
    try {
      await close();
    } finally {
      await ledger?.drain();
      ledger?.close();
    }
  };

  server.registerTool(
    "get_transactions",
    {
      title: "Get saved transactions by ID",
      description:
        "Return saved records from the persistent local ledger with explicit sync freshness. Pass fresh=true for API reconciliation; pass wallet to avoid whole-account refreshes. Prefer record_transactions for new receipts; its verified response needs no extra lookup.",
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).max(50),
        fresh: z
          .boolean()
          .default(false)
          .describe(
            "Wait for API reconciliation; required for audits or latest-state verification",
          ),
        wallet: z.string().optional().describe("Payment wallet name or ID, when known"),
      },
    },
    async ({ ids, wallet, fresh }) => json(await reads.get(ids, wallet, fresh)),
  );
  if (ledger)
    server.registerTool(
      "ledger_status",
      {
        title: "Local ledger sync status",
        annotations: { readOnlyHint: true },
        description:
          "Local snapshot timestamps, invalidation and reconciliation errors. No provider calls. Use fresh=true on reads for an API audit.",
        inputSchema: {},
      },
      async () => json({ snapshots: ledger.status() }),
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
  registerReferenceTools(server, client, reads);
  registerTransactionTools(server, client, show, reads);
  registerLendingTools(server, client, show, reads);
  // Both opt-in, and independently; see tools/structure.ts and tools/deletions.ts.
  if (structureAllowed()) registerStructureTools(server, client);
  if (deletionsAllowed()) registerDeletionTools(server, client);

  return server;
}
