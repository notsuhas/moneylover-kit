/**
 * Wallet and category writes, as the client exposes them.
 *
 * Everything here takes names and returns the committed row, so a caller never
 * handles an id it did not ask for. The backends differ in what they support,
 * so a missing capability fails with the reason and the alternative rather
 * than a TypeError.
 */

import type { Cache } from "../core/cache.js";
import { findCategory, findWallet } from "../core/query.js";
import type {
  Backend,
  Capabilities,
  Category,
  CategoryPatch,
  NewCategory,
  NewWallet,
  Wallet,
  WalletPatch,
} from "../core/types.js";
import { MoneyLoverError } from "../core/types.js";

export interface StructureDeps {
  backend: Backend;
  cache: Cache;
  wallets: () => Promise<Wallet[]>;
  categories: () => Promise<Category[]>;
}

export function createStructureApi({ backend, cache, wallets, categories }: StructureDeps) {
  function need<T>(method: T | undefined, what: keyof Capabilities): NonNullable<T> {
    if (!method || !backend.can[what]) {
      const other = backend.name === "web" ? "mobile" : "web";
      throw new MoneyLoverError(
        `the ${backend.name} backend cannot write ${what} — try the ${other} backend`,
      );
    }
    return method as NonNullable<T>;
  }

  /**
   * Structure writes change wallets, categories and labels together — and
   * deleting a wallet deletes its transactions server-side, so a cached
   * transaction list would keep returning rows that no longer exist.
   */
  const invalidate = () =>
    cache.drop(
      "wallets",
      "categories",
      "labels",
      "transactions",
      "web:transactions",
      "web:categories",
      "mobile:transactions",
    );

  async function walletById(id: string): Promise<Wallet> {
    const hit = (await wallets()).find((w) => w.id === id);
    if (!hit) throw new MoneyLoverError(`wallet ${id} not found after the write`);
    return hit;
  }

  return {
    async addWallet(input: NewWallet): Promise<Wallet> {
      const id = await need(backend.addWallet, "wallets")(input);
      invalidate();
      return walletById(id);
    },

    async editWallet(wallet: string, patch: WalletPatch): Promise<Wallet> {
      const target = findWallet(await wallets(), wallet);
      await need(backend.editWallet, "wallets")(target.id, patch);
      invalidate();
      return walletById(target.id);
    },

    async deleteWallet(wallet: string): Promise<Wallet> {
      const target = findWallet(await wallets(), wallet);
      await need(backend.deleteWallet, "wallets")(target.id);
      invalidate();
      return target;
    },

    /**
     * Returns the category as created, not as read back.
     *
     * A new category is not immediately visible: the web API hands back a
     * provisional `web…` id that `category/list-all` does not show for a few
     * seconds, and the mobile API returns a label id that never appears in the
     * per-wallet list at all. Re-reading here would fail on a write that
     * actually succeeded, so the created row is reported from what went in.
     */
    async addCategory(input: NewCategory): Promise<Category> {
      const id = await need(backend.addCategory, "categories")(input);
      invalidate();
      const visible = (await categories()).find(
        (c) => c.id === id || c.name.toLowerCase() === input.name.toLowerCase(),
      );
      if (visible) return visible;
      return {
        id,
        name: input.name,
        type: input.type,
        icon: input.icon ?? "",
        ...(input.wallet ? { walletId: input.wallet } : {}),
      };
    },

    async editCategory(category: string, patch: CategoryPatch): Promise<Category> {
      const target = findCategory(await categories(), category);
      await need(backend.editCategory, "categories")(target.id, patch);
      invalidate();
      // Same visibility lag as a create; report the intended state.
      return {
        ...target,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.icon ? { icon: patch.icon } : {}),
      };
    },

    async deleteCategory(category: string): Promise<Category> {
      const target = findCategory(await categories(), category);
      await need(backend.deleteCategory, "categories")(target.id);
      invalidate();
      return target;
    },
  };
}
