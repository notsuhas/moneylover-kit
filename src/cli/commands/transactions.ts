/** Transaction create, edit and delete. */

import type { Command, Ctx } from "../context.js";
import { fail } from "../fail.js";
import * as render from "../render.js";

/** The fields `add` and `edit` share, with only what was supplied. */
const fields = ({ flags, number, list, defined }: Ctx) =>
  defined({
    category: flags.category,
    amount: number(flags.amount, "amount"),
    note: flags.note,
    date: flags.date,
    people: list(flags.with),
    excludeReport: flags["exclude-report"],
  });

export const add: Command = async (ctx) => {
  const { client, flags, show, walletNames } = ctx;
  const supplied = fields(ctx);
  if (!flags.wallet || !supplied.category || supplied.amount === undefined) {
    fail("add needs --wallet, --category and --amount");
  }
  const created = await client.addTransaction({
    ...supplied,
    wallet: flags.wallet,
    category: supplied.category,
    amount: supplied.amount,
  });
  const names = await walletNames();
  show(created, () => {
    console.log("added");
    render.transactions([created], names);
  });
};

export const edit: Command = async (ctx) => {
  const { client, args, show, walletNames } = ctx;
  const [id] = args;
  if (!id) fail("edit needs a transaction id — find one with `moneylover list`");
  const patch = fields(ctx);
  if (Object.keys(patch).length === 0) fail("nothing to change — pass at least one field");

  const before = await client.transaction(id);
  const after = await client.editTransaction(id, patch);
  const names = await walletNames();
  show({ before, after }, () => {
    console.log("before");
    render.transactions([before], names);
    console.log("\nafter");
    render.transactions([after], names);
  });
};

export const remove: Command = async ({ client, args, show, walletNames }) => {
  const [id] = args;
  if (!id) fail("rm needs a transaction id");
  const deleted = await client.deleteTransaction(id);
  const names = await walletNames();
  show({ deleted }, () => {
    console.log("deleted");
    render.transactions([deleted], names);
  });
};
