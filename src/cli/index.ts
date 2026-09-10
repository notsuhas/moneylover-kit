#!/usr/bin/env node
/**
 * Argument parsing and dispatch. Every command lives in `commands/` and
 * receives a context, so this file stays a table rather than a switch that
 * grows with the surface.
 */

import { parseArgs } from "node:util";
import { accessToken, tokenLocation } from "../api/auth.js";
import { createClient } from "../client/index.js";
import { type BackendName, MoneyLoverError } from "../core/types.js";
import * as lending from "./commands/lending.js";
import * as read from "./commands/read.js";
import * as structure from "./commands/structure.js";
import * as transactions from "./commands/transactions.js";
import type { Command, Ctx, Flags } from "./context.js";
import { fail } from "./fail.js";
import * as render from "./render.js";
import { USAGE } from "./usage.js";

const options = {
  help: { type: "boolean" },
  json: { type: "boolean" },
  backend: { type: "string" },
  wallet: { type: "string" },
  category: { type: "string" },
  amount: { type: "string" },
  note: { type: "string" },
  person: { type: "string" },
  date: { type: "string" },
  with: { type: "string" },
  "exclude-report": { type: "boolean" },
  from: { type: "string" },
  to: { type: "string" },
  min: { type: "string" },
  max: { type: "string" },
  limit: { type: "string" },
  force: { type: "boolean" },
  name: { type: "string" },
  icon: { type: "string" },
  currency: { type: "string" },
  parent: { type: "string" },
  type: { type: "string" },
  "all-wallets": { type: "boolean" },
} as const;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options,
  allowPositionals: true,
});

const flags = values as Flags & { help?: boolean };
const [command = "help", ...args] = positionals;

/** Minting a token is not a client operation, so it sits outside the table. */
const login: Command = async ({ flags: f }) => {
  const email = process.env.MONEYLOVER_EMAIL;
  if (!email) fail("set MONEYLOVER_EMAIL and MONEYLOVER_PASSWORD first");
  const backend = (f.backend ?? process.env.MONEYLOVER_BACKEND ?? "web") as BackendName;
  console.error(
    "Logging in registers a device on your Money Lover account, and an account\n" +
      "allows only a few at once. Once they are used up, further logins are\n" +
      "refused until you log out somewhere. The token is cached, so this is rare.\n",
  );
  await accessToken({ backend, force: Boolean(f.force) });
  console.log(`cached ${backend} token at ${tokenLocation(backend, email)}`);
};

const COMMANDS: Record<string, Command> = {
  login,
  whoami: read.whoami,
  wallets: read.listWallets,
  categories: read.listCategories,
  events: read.listEvents,
  labels: read.listLabels,
  list: read.listTransactions,

  add: transactions.add,
  edit: transactions.edit,
  rm: transactions.remove,

  lend: lending.record("lend"),
  collect: lending.record("collect"),
  borrow: lending.record("borrow"),
  repay: lending.record("repay"),
  lending: lending.summary,

  "add-wallet": structure.addWallet,
  "edit-wallet": structure.editWallet,
  "rm-wallet": structure.removeWallet,
  "add-category": structure.addCategory,
  "edit-category": structure.editCategory,
  "rm-category": structure.removeCategory,
};

function defined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function buildContext(): Ctx {
  const backend = (flags.backend ?? process.env.MONEYLOVER_BACKEND) as BackendName | undefined;
  const client = createClient(defined({ backend }));
  return {
    client,
    flags,
    args,
    show: (data, table) => render.output(Boolean(flags.json), data, table),
    number(value, name) {
      if (value === undefined) return undefined;
      const n = Number(value);
      if (Number.isNaN(n)) fail(`--${name} must be a number, got ${JSON.stringify(value)}`);
      return n;
    },
    list: (value) =>
      value === undefined
        ? undefined
        : value
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
    defined,
    walletNames: async () => new Map((await client.wallets()).map((w) => [w.id, w.name])),
  };
}

async function main(): Promise<void> {
  if (flags.help || command === "help") {
    console.log(USAGE);
    return;
  }
  const run = COMMANDS[command];
  if (!run) fail(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
  await run(buildContext());
}

try {
  await main();
} catch (error) {
  if (error instanceof MoneyLoverError) fail(error.message);
  throw error;
}
