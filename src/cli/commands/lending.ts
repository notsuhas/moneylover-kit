/** Money between people. */

import type { LendingKind } from "../../core/lending.js";
import type { Command, Ctx } from "../context.js";
import { fail } from "../fail.js";
import * as render from "../render.js";

/** `lend`, `collect`, `borrow` and `repay` differ only in the verb. */
export const record =
  (kind: LendingKind): Command =>
  async ({ client, flags, show, number, defined, walletNames }: Ctx) => {
    const { person, wallet } = flags;
    const amount = number(flags.amount, "amount");
    if (!person || !wallet || amount === undefined) {
      fail(`${kind} needs --person, --wallet and --amount`);
    }
    const row = await client.recordLending(kind, {
      person,
      wallet,
      amount,
      ...defined({ note: flags.note, date: flags.date }),
    });
    const names = await walletNames();
    show(row, () => {
      console.log(`recorded: ${kind} ${amount} — ${person}`);
      render.transactions([row], names);
    });
  };

export const summary: Command = async ({ client, flags, show }) => {
  const rows = await client.lending(flags.person);
  show(rows, () => render.lending(rows));
};
