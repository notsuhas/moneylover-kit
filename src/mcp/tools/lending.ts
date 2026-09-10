/** Money between people: lending, collecting, borrowing, repaying. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MoneyLover } from "../../client/index.js";
import { DATE, json } from "../present.js";
import type { Rendering } from "./transactions.js";

export function registerLendingTools(server: McpServer, client: MoneyLover, show: Rendering): void {
  server.registerTool(
    "record_lending",
    {
      title: "Record lending or borrowing",
      description:
        "Record money lent, collected, borrowed or repaid, against Money Lover's own " +
        "lending categories so its debt tracking sees it. The amount is always positive — " +
        "the kind sets the direction. The wallet is per leg, so lending from one account " +
        "and collecting into another is expected and reconciles by person.",
      inputSchema: {
        kind: z
          .enum(["lend", "collect", "borrow", "repay"])
          .describe(
            "lend: you gave money out. collect: it came back. " +
              "borrow: you took money. repay: you paid it back.",
          ),
        person: z.string().describe("Who the money went to or came from"),
        amount: z.number().positive().describe("Positive; the kind sets the direction"),
        wallet: z.string().describe("Wallet this leg moved through"),
        note: z.string().optional(),
        date: DATE.optional().describe("Defaults to today"),
      },
    },
    async ({ kind, ...input }) => {
      const row = await client.recordLending(kind, input);
      return json({ recorded: kind, transaction: (await show([row]))[0] });
    },
  );

  server.registerTool(
    "lending_summary",
    {
      title: "Who owes what",
      description:
        "Net lending position per person across every wallet: lent, collected, still " +
        "outstanding, and separately what you owe them. Sorted by largest balance.",
      inputSchema: {
        person: z.string().optional().describe("Substring match on the person tag"),
      },
    },
    async ({ person }) => {
      const rows = await client.lending(person);
      return json({
        people: rows,
        totalOwedToYou: rows.reduce((sum, r) => sum + r.outstanding, 0),
        totalYouOwe: rows.reduce((sum, r) => sum + r.owing, 0),
      });
    },
  );
}
