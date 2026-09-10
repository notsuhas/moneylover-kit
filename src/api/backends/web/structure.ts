/**
 * Wallet and category writes on the web API.
 *
 * Both `wallet/edit` and `category/edit` are **full replaces**: they reject a
 * payload carrying only the id and the field you want to change. So every edit
 * here reads the live row first and resends all of it. Verified against a live
 * account — `{_id, name}` alone answers `sync_error_data_invalid`.
 */

import { findWallet } from "../../../core/query.js";
import type {
  Category,
  CategoryPatch,
  NewCategory,
  NewWallet,
  Wallet,
  WalletPatch,
} from "../../../core/types.js";
import { MoneyLoverError } from "../../../core/types.js";
import type { Call } from "./call.js";

interface Created {
  _id: string;
}

export interface StructureDeps {
  call: Call;
  wallets: () => Promise<Wallet[]>;
  categories: () => Promise<Category[]>;
}

export function createStructure({ call, wallets, categories }: StructureDeps) {
  async function wallet(id: string): Promise<Wallet> {
    const hit = (await wallets()).find((w) => w.id === id);
    if (!hit) throw new MoneyLoverError(`no wallet ${id}`);
    return hit;
  }

  async function category(id: string): Promise<Category> {
    const hit = (await categories()).find((c) => c.id === id);
    if (!hit) throw new MoneyLoverError(`no category ${id}`);
    return hit;
  }

  return {
    async addWallet(input: NewWallet): Promise<string> {
      const made = await call<Created>("/wallet/add", {
        name: input.name,
        currency_id: input.currencyId,
        icon: input.icon ?? "icon",
      });
      return made._id;
    },

    /** Resends name, icon and currency together — the API requires all three. */
    async editWallet(id: string, patch: WalletPatch): Promise<void> {
      const live = await wallet(id);
      await call("/wallet/edit", {
        _id: id,
        name: patch.name ?? live.name,
        icon: patch.icon ?? live.icon ?? "icon",
        currency_id: patch.currencyId ?? live.currencyId,
      });
    },

    async deleteWallet(id: string): Promise<void> {
      await wallet(id);
      await call("/wallet/delete", { _id: id });
    },

    async addCategory(input: NewCategory): Promise<string> {
      if (input.parent) {
        throw new MoneyLoverError(
          "the web backend cannot nest a category — `parent` needs the mobile backend, " +
            "which writes the label layer. See docs/traps.md.",
        );
      }
      if (!input.wallet) {
        throw new MoneyLoverError(
          "the web backend needs a wallet for a new category — it has no all-wallet " +
            "layer. Name one, or use the mobile backend.",
        );
      }
      const target = findWallet(await wallets(), input.wallet);
      const made = await call<Created>("/category/add", {
        // `walletId` here, while transaction writes use `account`. Not a typo.
        walletId: target.id,
        name: input.name,
        icon: input.icon ?? "ic_category_other",
        type: input.type === "income" ? 1 : 2,
      });
      return made._id;
    },

    /** `{_id, name, icon}` — all three, even to change only the name. */
    async editCategory(id: string, patch: CategoryPatch): Promise<void> {
      const live = await category(id);
      await call("/category/edit", {
        _id: id,
        name: patch.name ?? live.name,
        icon: patch.icon ?? live.icon,
      });
    },

    async deleteCategory(id: string): Promise<void> {
      await category(id);
      await call("/category/delete", { _id: id });
    },
  };
}
