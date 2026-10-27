import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MoneyLover } from "../../client/index.js";
import { crossCurrencyCollection, validateCollections } from "../../core/collection.js";
import { transactionDate } from "../../core/dates.js";
import { lendingCategory } from "../../core/lending.js";
import { findCategory, findWallet } from "../../core/query.js";
import { createRecorder } from "../../core/recording.js";
import type { NewTransaction, Transaction } from "../../core/types.js";
import { DATE_TIME, json } from "../present.js";
import type { Rendering } from "./transactions.js";

export function registerRecordingTool(
  server: McpServer,
  client: MoneyLover,
  show: Rendering,
  identity?: string,
): void {
  let tail = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  const record = createRecorder<NewTransaction, Transaction>({
    directory: async () => {
      const accountId = identity ?? (await client.account()).id;
      const key = createHash("sha256").update(accountId).digest("hex");
      return join(
        process.env.MONEYLOVER_CONFIG_DIR ??
          process.env.XDG_CONFIG_HOME ??
          join(homedir(), ".config"),
        "moneylover-kit",
        "receipts",
        key,
      );
    },
    list: () => client.transactions(),
    identity: (row, input) =>
      row.walletId === input.wallet &&
      (row.note === input.note ||
        (row.amount === input.amount && row.categoryId === input.category)) &&
      Date.parse(row.dateTime ?? "") === Date.parse(input.dateTime ?? ""),
    verify: (row, input) => {
      if (
        row.walletId !== input.wallet ||
        (row.categoryId !== input.category && row.categoryName !== input.category) ||
        row.amount !== input.amount ||
        row.note !== input.note ||
        Date.parse(row.dateTime ?? "") !== Date.parse(input.dateTime ?? "") ||
        JSON.stringify([...row.people].sort()) !==
          JSON.stringify([...(input.people ?? [])].sort()) ||
        JSON.stringify([...row.eventIds].sort()) !==
          JSON.stringify(input.eventId ? [input.eventId] : []) ||
        row.excludeReport !== Boolean(input.excludeReport) ||
        row.parentId !== input.parentId
      )
        throw new Error("Receipt fields conflict; no overwrite attempted");
    },
    validate: async (inputs, rows) => {
      const [categories, wallets] = await Promise.all([
        client.categories(),
        client.walletCatalog(),
      ]);
      validateCollections(inputs, rows, categories, wallets);
    },
    create: (inputs) => client.addTransactions(inputs),
  });
  server.registerTool(
    "collect_loan_cross_currency",
    {
      title: "Collect a loan in another currency",
      description:
        "Record repayment using both actual amounts: amount is cleared in the original loan currency; receivedAmount is what arrived in the receiving wallet currency. One batch records the linked collection and two excluded system transfer legs; origin wallet nets to zero. No guessed FX, income or new spending. Returns independently verified rows and balances. Stable receiptId protects retries. Transfer rows are separate system-category entries, not a native paired-transfer object.",
      inputSchema: {
        receiptId: z.string().min(3).max(128),
        loanId: z.string().min(1),
        amount: z.number().positive(),
        receivedAmount: z.number().positive(),
        wallet: z.string(),
        dateTime: DATE_TIME,
        note: z.string().min(1),
      },
    },
    async ({ receiptId, ...input }) =>
      exclusive(() =>
        client.withFreshReads(async () => {
          transactionDate(input);
          const [rows, categories, wallets] = await Promise.all([
            client.transactions(),
            client.categories(),
            client.walletCatalog(),
          ]);
          const entries = crossCurrencyCollection(input, rows, categories, wallets);
          const saved = await record(receiptId, entries);
          const balances = await client.wallets();
          return json({
            verified: true,
            transactions: await show(saved),
            wallets: balances.filter((wallet) => saved.some((row) => row.walletId === wallet.id)),
          });
        }),
      ),
  );
  server.registerTool(
    "record_transactions",
    {
      title: "Record and verify one receipt",
      description:
        "Preferred for a new receipt: checks duplicates, creates missing entries and verifies fresh server data in one call. Include own expense and lending or borrowing offsets together; use kind=borrow for someone paying for you. Reuse receiptId and identical inputs on retries. No separate search or verification is needed after verified=true. Never retry an uncertain write using a new receiptId.",
      inputSchema: {
        receiptId: z.string().min(3).max(128),
        entries: z
          .array(
            z.object({
              original: z
                .object({ amount: z.number().positive(), currency: z.string().length(3) })
                .optional(),
              wallet: z.string(),
              category: z.string().optional(),
              kind: z.enum(["lend", "borrow", "collect", "repay"]).optional(),
              person: z.string().min(1).optional(),
              parentId: z
                .string()
                .min(1)
                .optional()
                .describe("Required for collect/repay: original loan/debt ID"),
              amount: z
                .number()
                .finite()
                .refine((n) => n !== 0),
              note: z.string().min(1),
              dateTime: DATE_TIME,
              people: z.array(z.string()).optional(),
              eventId: z.string().min(1).optional(),
              excludeReport: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(10),
      },
    },
    async ({ receiptId, entries }) =>
      exclusive(() =>
        client.withFreshReads(async () => {
          const [wallets, categories] = await Promise.all([
            client.walletCatalog(),
            client.categories(),
          ]);
          const inputs = entries.map((entry) => {
            transactionDate(entry);
            const wallet = findWallet(wallets, entry.wallet);
            if (entry.kind && (entry.category || !entry.person || entry.amount <= 0))
              throw new Error("Lending kind requires person and positive amount, without category");
            if (!entry.kind && !entry.category) throw new Error("Expense category is required");
            const category = entry.kind
              ? lendingCategory(categories, entry.kind, wallet.id)
              : findCategory(categories, entry.category ?? "", wallet.id);
            const amount = entry.kind
              ? category.type === "expense"
                ? -entry.amount
                : entry.amount
              : entry.amount;
            if ((category.type === "expense") !== amount < 0)
              throw new Error("Amount sign disagrees with category");
            return {
              ...entry,
              wallet: wallet.id,
              amount,
              category: category.id,
              people: entry.kind ? [entry.person ?? ""] : [...(entry.people ?? [])].sort(),
              excludeReport: Boolean(entry.parentId || entry.excludeReport),
            };
          });
          const keys = inputs.map((input) =>
            JSON.stringify([input.wallet, input.note, Date.parse(input.dateTime)]),
          );
          if (new Set(keys).size !== keys.length)
            throw new Error("Receipt entries need distinct wallet, time or note");
          const rows = await record(receiptId, inputs);
          const walletsWithBalances = await client.wallets();
          return json({
            verified: true,
            transactions: await show(rows),
            wallets: walletsWithBalances.filter((wallet) =>
              rows.some((row) => row.walletId === wallet.id),
            ),
          });
        }),
      ),
  );
}
