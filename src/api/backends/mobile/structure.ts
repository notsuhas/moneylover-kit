/**
 * Category writes on the mobile API — the two-layer ones.
 *
 * Money Lover models a category twice, and both are required:
 *
 *   category  a per-wallet instance, one row per wallet with its own gid.
 *             Transactions reference *this* id, for their own wallet.
 *             `pi` is the parent's per-wallet gid IN THE SAME WALLET.
 *
 *   label     the global record grouping those rows — what the app shows as
 *             "active in 13 wallets". `eac` empty means every wallet, and `pi`
 *             is the parent *label* gid.
 *
 * Writing only the category layer is what leaves categories stranded in a few
 * wallets with no parent. Both fields were recovered by intercepting the
 * Android app creating a nested category: it emits one category item per
 * wallet plus a single label item.
 */

import { findWallet } from "../../../core/query.js";
import type { Category, CategoryPatch, Label, NewCategory, Wallet } from "../../../core/types.js";
import { MoneyLoverError } from "../../../core/types.js";
import type { Sync } from "./sync.js";

const DEFAULT_ICON = "ic_category_other_expense";

const gid = (): string => crypto.randomUUID().replace(/-/g, "");

/** A per-wallet category row on the wire. */
interface CategoryItem {
  ac: string;
  gid: string;
  n: string;
  ic: string;
  t: 1 | 2;
  md: string;
  gr: number;
  id: number;
  pi?: string;
  f: 1 | 2 | 3;
  version: number;
  isDelete?: boolean;
}

interface LabelItem {
  gid: string;
  n: string;
  ic: string;
  t: 1 | 2;
  md: string;
  pi?: string;
  c: string[];
  eac: string[];
  f: 1 | 2 | 3;
  v: number;
  isDelete?: boolean;
}

/** Every write touches the label layer, so all three build one of these. */
function labelItem(
  parts: {
    id: string;
    name: string;
    icon: string;
    type: 1 | 2;
    categoryIds: string[];
    excludedWalletIds?: string[];
    parentId?: string;
  },
  f: 1 | 2 | 3,
): LabelItem {
  return {
    gid: parts.id,
    n: parts.name,
    ic: parts.icon,
    t: parts.type,
    md: "",
    ...(parts.parentId ? { pi: parts.parentId } : {}),
    c: [...parts.categoryIds].sort(),
    // Empty means "not excluded from any wallet" — i.e. everywhere.
    eac: parts.excludedWalletIds ?? [],
    f,
    ...(f === 3 ? { v: 1, isDelete: true } : { v: 0 }),
  };
}

export interface StructureDeps {
  push: Sync["push"];
  wallets: () => Promise<Wallet[]>;
  categories: () => Promise<Category[]>;
  labels: () => Promise<Label[]>;
}

export function createStructure({ push, wallets, categories, labels }: StructureDeps) {
  /** Local ids only need to be unique within a batch; the gid is the identity. */
  let localId = 90_000;

  const byName = (all: Category[], name: string, wallet: string) =>
    all.find((c) => c.name.toLowerCase() === name.toLowerCase() && c.walletId === wallet);

  /**
   * Find the label for a name, a label id, **or** a per-wallet category id.
   *
   * The caller resolves a category through the per-wallet list, so what
   * arrives here is usually a per-wallet gid that no label is keyed on. Only
   * matching names and label ids made every mobile edit and delete fail.
   */
  async function labelFor(reference: string): Promise<Label> {
    const all = await labels();
    const byId = all.find((l) => l.id === reference);
    if (byId) return byId;
    const containing = all.find((l) => l.categoryIds.includes(reference));
    if (containing) return containing;
    const byName = all.find((l) => l.name.toLowerCase() === reference.toLowerCase());
    if (byName) return byName;
    throw new MoneyLoverError(`no category ${JSON.stringify(reference)}`);
  }

  /** Resolve which wallets a write targets: one named, or all of them. */
  async function targets(wallet?: string): Promise<string[]> {
    const all = await wallets();
    return wallet ? [findWallet(all, wallet).id] : all.filter((w) => !w.archived).map((w) => w.id);
  }

  return {
    async addCategory(input: NewCategory): Promise<string> {
      const walletIds = await targets(input.wallet);
      const all = await categories();
      const type: 1 | 2 = input.type === "income" ? 1 : 2;
      const icon = input.icon ?? DEFAULT_ICON;

      // A child points at its parent's row *in the same wallet*, so the parent
      // has to exist in every wallet being written.
      let parentLabelId: string | undefined;
      const parentPerWallet = new Map<string, string>();
      if (input.parent) {
        parentLabelId = (await labelFor(input.parent)).id;
        for (const walletId of walletIds) {
          const row = byName(all, input.parent, walletId);
          if (!row) {
            throw new MoneyLoverError(
              `parent ${JSON.stringify(input.parent)} does not exist in every target wallet — ` +
                "create it there first",
            );
          }
          parentPerWallet.set(walletId, row.id);
        }
      }

      /**
       * A label with no exclusions means "active in every wallet", so the
       * exclusion list must be exactly the wallets that got no row — whether
       * that is because one wallet was named, or because the rest are
       * archived. Deriving it from what was actually written keeps the two
       * layers from disagreeing.
       */
      const excluded = (await wallets()).map((w) => w.id).filter((id) => !walletIds.includes(id));

      const items: CategoryItem[] = [];
      const created: string[] = [];
      for (const walletId of walletIds) {
        if (byName(all, input.name, walletId)) {
          throw new MoneyLoverError(
            `a category named ${JSON.stringify(input.name)} already exists in that wallet`,
          );
        }
        const id = gid();
        created.push(id);
        const parent = parentPerWallet.get(walletId);
        items.push({
          ac: walletId,
          gid: id,
          n: input.name,
          ic: icon,
          t: type,
          md: "",
          gr: 0,
          id: ++localId,
          ...(parent ? { pi: parent } : {}),
          f: 1,
          version: 0,
        });
      }
      await push("category", items);

      const labelId = gid();
      await push("label", [
        labelItem(
          {
            id: labelId,
            name: input.name,
            icon,
            type,
            categoryIds: created,
            excludedWalletIds: excluded,
            ...(parentLabelId ? { parentId: parentLabelId } : {}),
          },
          1,
        ),
      ]);
      return labelId;
    },

    /** Renames or reicons every per-wallet row and the label together. */
    async editCategory(id: string, patch: CategoryPatch): Promise<void> {
      const label = await labelFor(id);
      const rows = (await categories()).filter((c) => label.categoryIds.includes(c.id));
      if (rows.length === 0) throw new MoneyLoverError(`category ${id} has no wallet rows`);
      const name = patch.name ?? label.name;
      const icon = patch.icon ?? label.icon;
      const type: 1 | 2 = label.type === "income" ? 1 : 2;

      // A category push is a full replace too, so the parent link and the
      // group have to be resent — rebuilding from name and icon alone silently
      // unnests every row while the label still claims the old parent.
      await push(
        "category",
        rows.map<CategoryItem>((row) => ({
          ac: row.walletId ?? "",
          gid: row.id,
          n: name,
          ic: icon,
          t: type,
          // Built-ins carry semantic markers here; blanking them changes how
          // the app treats the category.
          md: row.metadata ?? "",
          gr: row.group ?? 0,
          id: ++localId,
          ...(row.parentId ? { pi: row.parentId } : {}),
          f: 2,
          version: 0,
        })),
      );
      await push("label", [labelItem({ ...label, name, icon, type }, 2)]);
    },

    /** Removes every per-wallet row and the label. Transactions are not moved. */
    async deleteCategory(id: string): Promise<void> {
      const label = await labelFor(id);
      if ((await labels()).some((l) => l.parentId === label.id)) {
        throw new MoneyLoverError(
          `${label.name} is a parent of other categories — delete or reparent those first`,
        );
      }
      const rows = (await categories()).filter((c) => label.categoryIds.includes(c.id));
      const type: 1 | 2 = label.type === "income" ? 1 : 2;

      await push(
        "category",
        rows.map<CategoryItem>((row) => ({
          ac: row.walletId ?? "",
          gid: row.id,
          n: row.name,
          ic: row.icon,
          t: type,
          md: row.metadata ?? "",
          gr: row.group ?? 0,
          id: ++localId,
          ...(row.parentId ? { pi: row.parentId } : {}),
          f: 3,
          version: 1,
          isDelete: true,
        })),
      );
      await push("label", [labelItem({ ...label, type }, 3)]);
    },
  };
}
