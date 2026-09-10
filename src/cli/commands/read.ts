/** Read-only commands. */

import type { Command } from "../context.js";
import { fail } from "../fail.js";
import * as render from "../render.js";

export const whoami: Command = async ({ client, show }) => {
  const account = await client.account();
  show({ ...account, can: client.can, routing: client.routing }, () => {
    console.log(`${account.email}`);
    console.log(`devices allowed: ${account.deviceLimit || "unknown"}`);
    const missing = Object.entries(client.can)
      .filter(([, yes]) => !yes)
      .map(([what]) => what);
    console.log("\nrouting");
    for (const [what, where] of Object.entries(client.routing)) {
      console.log(`  ${what.padEnd(18)} ${where}`);
    }
    if (missing.length) console.log(`\nunavailable: ${missing.join(", ")}`);
  });
};

export const listWallets: Command = async ({ client, show }) => {
  const rows = await client.wallets();
  show(rows, () => render.wallets(rows));
};

export const listCategories: Command = async ({ client, show }) => {
  const rows = await client.categories();
  const seen = new Map<string, (typeof rows)[number]>();
  for (const c of rows) if (!seen.has(c.name)) seen.set(c.name, c);
  const unique = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  show(unique, () => render.categories(unique));
};

export const listEvents: Command = async ({ client, show }) => {
  const rows = await client.events();
  show(rows, () => render.events(rows));
};

export const listLabels: Command = async ({ client, show }) => {
  const rows = await client.labels();
  if (rows.length === 0 && !client.can.labels) {
    fail(
      "the label layer needs the mobile API — set MONEYLOVER_MOBILE_CLIENT and\n" +
        "MONEYLOVER_MOBILE_SECRET. See docs/api.md.",
    );
  }
  show(rows, () => render.labels(rows));
};

export const listTransactions: Command = async ({
  client,
  flags,
  show,
  number,
  defined,
  walletNames,
}) => {
  const rows = await client.transactions(
    defined({
      note: flags.note,
      wallet: flags.wallet,
      category: flags.category,
      from: flags.from,
      to: flags.to,
      minAmount: number(flags.min, "min"),
      maxAmount: number(flags.max, "max"),
      limit: number(flags.limit, "limit") ?? 25,
    }),
  );
  const names = await walletNames();
  show(rows, () => render.transactions(rows, names));
};
