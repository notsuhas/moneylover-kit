/** Read-only commands. */

import type { Command } from "../context.js";
import { fail } from "../fail.js";
import * as render from "../render.js";

export const whoami: Command = async ({ client, show }) => {
  const account = await client.account();
  show({ ...account, backend: client.backend, can: client.can }, () => {
    console.log(`${account.email}  (${client.backend} backend)`);
    console.log(`devices allowed: ${account.deviceLimit || "unknown"}`);
    const can = Object.entries(client.can)
      .filter(([, yes]) => yes)
      .map(([what]) => what);
    console.log(`can write: ${can.join(", ") || "transactions only"}`);
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
    fail(`the ${client.backend} backend has no label layer — try --backend mobile`);
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
