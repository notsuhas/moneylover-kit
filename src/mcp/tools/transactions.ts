/** Transaction CRUD. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MoneyLover } from "../../client/index.js";
import type { Transaction } from "../../core/types.js";
import type { createLocalReads } from "../ledger.js";
import { DATE, DATE_TIME, json } from "../present.js";

export type Rendering = (rows: Transaction[]) => Promise<Record<string, unknown>[]>;

export function registerTransactionTools(
  server: McpServer,
  client: MoneyLover,
  show: Rendering,
  reads: ReturnType<typeof createLocalReads>,
): void {
  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      description:
        "Find transactions to read, or to get an id for editing or deleting. " +
        "Filters combine; newest first. Reads the local ledger immediately and returns lastSyncedAt/stale/refreshing. Background refresh retains the last complete snapshot on failure. Pass fresh=true for audits; include the payment wallet to scope reconciliation.",
      inputSchema: {
        note: z.string().optional().describe("Case-insensitive substring of the note"),
        wallet: z.string().optional().describe("Wallet name"),
        category: z.string().optional().describe("Category name"),
        from: DATE.optional().describe("Earliest date, inclusive"),
        to: DATE.optional().describe("Latest date, inclusive"),
        minAmount: z.number().optional().describe("Compared to the absolute value"),
        maxAmount: z.number().optional().describe("Compared to the absolute value"),
        limit: z.number().int().min(1).max(200).default(25),
        fresh: z
          .boolean()
          .default(false)
          .describe("Wait for API reconciliation; use for audits and latest-state checks"),
      },
    },
    async ({ limit, fresh, ...query }) => json(await reads.search(query, limit, fresh)),
  );

  server.registerTool(
    "add_transaction",
    {
      title: "Add a transaction",
      description: "Create one transaction. Negative amount for an expense, positive for income.",
      inputSchema: {
        wallet: z.string().describe("Wallet name, from list_wallets"),
        category: z.string().describe("Existing category name, from list_categories"),
        amount: z.number().describe("Signed: negative expense, positive income"),
        note: z.string().optional(),
        date: DATE.optional().describe("Defaults to today"),
        dateTime: DATE_TIME.optional(),
        people: z.array(z.string()).optional().describe("Who it was with"),
        parentId: z
          .string()
          .min(1)
          .optional()
          .describe("Required for collection/repayment: original loan/debt ID"),
        eventId: z.string().min(1).optional().describe("Event ID from list_events"),
        excludeReport: z.boolean().optional().describe("Keep it out of spending reports"),
      },
    },
    async (args) =>
      client.withFreshReads(async () => {
        const created = await client.addTransaction(args);
        return json({ created: created.id, transaction: (await show([created]))[0] });
      }),
  );

  server.registerTool(
    "edit_transaction",
    {
      title: "Edit a transaction",
      description:
        "Change only the fields you pass. Everything else on the row — people, events, " +
        "the exclude-from-report flag, reminders — is preserved.",
      inputSchema: {
        id: z.string().describe("Transaction id from search_transactions"),
        category: z.string().optional(),
        amount: z.number().optional().describe("Signed, same rule as add_transaction"),
        note: z.string().optional(),
        date: DATE.optional(),
        dateTime: DATE_TIME.optional(),
        people: z.array(z.string()).optional().describe("Replaces the existing list"),
        eventId: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe("Event ID from list_events; null clears the event"),
        excludeReport: z.boolean().optional(),
      },
    },
    async ({ id, ...patch }) =>
      client.withFreshReads(async () => {
        if (Object.values(patch).every((v) => v === undefined)) {
          throw new Error("nothing to change — pass at least one field");
        }
        const before = await client.transaction(id);
        const after = await client.editTransaction(id, patch);
        const rendered = await show([before, after]);
        return json({ before: rendered[0], after: rendered[1] });
      }),
  );

  server.registerTool(
    "delete_transaction",
    {
      title: "Delete a transaction",
      description: "Permanently delete one transaction. There is no undo — confirm first.",
      inputSchema: { id: z.string().describe("Transaction id from search_transactions") },
    },
    async ({ id }) =>
      client.withFreshReads(async () =>
        json({ deleted: (await show([await client.deleteTransaction(id)]))[0] }),
      ),
  );
}
