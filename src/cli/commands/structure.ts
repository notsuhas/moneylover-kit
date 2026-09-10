/**
 * Wallet and category management.
 *
 * These change the shape of the account rather than its contents, so each one
 * says what it did. Deleting a wallet takes its transactions with it, which is
 * why `rm-wallet` requires the name spelled out rather than accepting an id.
 */

import type { Command } from "../context.js";
import { fail } from "../fail.js";

export const addWallet: Command = async ({ client, flags, show, number, defined }) => {
  const name = flags.name ?? flags.wallet;
  const currency = number(flags.currency, "currency");
  if (!name || currency === undefined) {
    fail("add-wallet needs --name and --currency (a numeric currency id, e.g. 11 for INR)");
  }
  const made = await client.addWallet({
    name,
    currencyId: currency,
    ...defined({ icon: flags.icon }),
  });
  show(made, () => console.log(`created wallet ${made.name}`));
};

export const editWallet: Command = async ({ client, flags, show, number, defined }) => {
  if (!flags.wallet) fail("edit-wallet needs --wallet to say which one");
  const patch = defined({
    name: flags.name,
    icon: flags.icon,
    currencyId: number(flags.currency, "currency"),
  });
  if (Object.keys(patch).length === 0)
    fail("nothing to change — pass --name, --icon or --currency");
  const updated = await client.editWallet(flags.wallet, patch);
  show(updated, () => console.log(`updated wallet ${updated.name}`));
};

export const removeWallet: Command = async ({ client, flags, show }) => {
  if (!flags.wallet) fail("rm-wallet needs --wallet");
  const gone = await client.deleteWallet(flags.wallet);
  show({ deleted: gone }, () =>
    console.log(`deleted wallet ${gone.name} — its transactions went with it`),
  );
};

export const addCategory: Command = async ({ client, flags, show, defined }) => {
  const name = flags.name ?? flags.category;
  if (!name) fail("add-category needs --name");
  const type = flags.type ?? "expense";
  if (type !== "income" && type !== "expense") fail("--type must be income or expense");
  // No wallet means every wallet, which is what the app itself does.
  const wallet = flags["all-wallets"] ? undefined : flags.wallet;
  if (!wallet && !client.can.labels) {
    fail(
      `the ${client.backend} backend needs --wallet for a new category. ` +
        "Use --backend mobile for an all-wallet category.",
    );
  }
  const made = await client.addCategory({
    name,
    type,
    ...defined({ wallet, icon: flags.icon, parent: flags.parent }),
  });
  show(made, () => {
    const scope = wallet ? `in ${wallet}` : "in every wallet";
    console.log(
      `created category ${made.name} ${scope}${flags.parent ? ` under ${flags.parent}` : ""}`,
    );
  });
};

export const editCategory: Command = async ({ client, flags, show, defined }) => {
  if (!flags.category) fail("edit-category needs --category to say which one");
  const patch = defined({ name: flags.name, icon: flags.icon });
  if (Object.keys(patch).length === 0) fail("nothing to change — pass --name or --icon");
  const updated = await client.editCategory(flags.category, patch);
  show(updated, () => console.log(`updated category ${updated.name}`));
};

export const removeCategory: Command = async ({ client, flags, show }) => {
  if (!flags.category) fail("rm-category needs --category");
  const gone = await client.deleteCategory(flags.category);
  show({ deleted: gone }, () =>
    console.log(`deleted category ${gone.name} — transactions using it were left alone`),
  );
};
