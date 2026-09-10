/**
 * One backend over both APIs.
 *
 * Money Lover's web and mobile clients grew separately and neither is a
 * superset of the other. Passing that inconsistency on to the caller would
 * mean they have to know that a nested category needs one API and a wallet
 * balance needs the other — which is not a client, it is a pair of clients
 * with a table. So every operation is routed here to whichever backend can
 * actually do it.
 *
 * The routing below is not preference, it is measured against a live account:
 *
 *   wallets       web     the only source of balances; all 13 ids identical
 *   transactions  web     one request vs 45 paginated pulls; all 11,194 ids identical
 *   categories    mobile  its per-wallet ids are the ones transaction rows
 *                         reference on *both* APIs (11,194/11,194). Web's
 *                         `category/list-all` returns a different, global set
 *                         that matches no transaction at all.
 *   events        mobile  every web route for these 404s
 *   labels        mobile  the web API does not model the layer
 *   txn writes    mobile  rejected items come back in `failedItems` instead of
 *                         being applied, batches, and has no wrong-id hang
 *   cat writes    mobile  writes both layers, so nesting and all-wallet work
 *   wallet writes web     the only one whose payloads are known
 *
 * With only one backend available this degrades to it, and the capabilities
 * reported shrink to match — so a caller still gets a real error naming what
 * is missing rather than a silent wrong answer.
 */

import type {
  Account,
  Backend,
  Capabilities,
  Category,
  CategoryPatch,
  Event,
  Label,
  NewCategory,
  NewTransaction,
  NewWallet,
  RetagEntry,
  Transaction,
  TransactionPatch,
  Wallet,
  WalletPatch,
} from "../../core/types.js";
import { MoneyLoverError } from "../../core/types.js";

export interface CompositeParts {
  web?: Backend;
  mobile?: Backend;
}

/** Which backend each capability needs, for the error message when it is absent. */
const OWNER: Record<keyof Capabilities, "web" | "mobile"> = {
  balances: "web",
  wallets: "web",
  categories: "mobile",
  labels: "mobile",
  events: "mobile",
  batchWrites: "mobile",
};

export function createCompositeBackend(parts: CompositeParts): Backend {
  const { web, mobile } = parts;
  if (!web && !mobile) throw new MoneyLoverError("composite backend needs at least one backend");

  /**
   * Pick the backend for an operation: the one that does it best, else the
   * other, else a message naming what is missing and why.
   */
  function route(
    preferred: Backend | undefined,
    other: Backend | undefined,
    what: string,
  ): Backend {
    const chosen = preferred ?? other;
    if (!chosen) throw new MoneyLoverError(`no backend available for ${what}`);
    return chosen;
  }

  function require(backend: Backend | undefined, capability: keyof Capabilities): Backend {
    if (!backend) {
      const owner = OWNER[capability];
      throw new MoneyLoverError(
        `${capability} needs the ${owner} backend, which is not configured.` +
          (owner === "mobile"
            ? " Set MONEYLOVER_MOBILE_CLIENT and MONEYLOVER_MOBILE_SECRET — see docs/api.md."
            : " Provide credentials for the web API."),
      );
    }
    return backend;
  }

  // Only claim what is actually reachable.
  const can: Capabilities = {
    balances: Boolean(web?.can.balances),
    wallets: Boolean(web?.can.wallets),
    categories: Boolean(mobile?.can.categories || web?.can.categories),
    labels: Boolean(mobile?.can.labels),
    events: Boolean(mobile?.can.events),
    batchWrites: Boolean(mobile?.can.batchWrites),
  };

  const reads = {
    wallets: route(web, mobile, "wallets"),
    transactions: route(web, mobile, "transactions"),
    categories: route(mobile, web, "categories"),
    account: route(web, mobile, "account"),
  };

  const writes = {
    transactions: route(mobile, web, "transaction writes"),
    categories: route(mobile, web, "category writes"),
  };

  const backend: Backend = {
    name: (mobile ? "mobile" : "web") as Backend["name"],
    can,

    account: async (): Promise<Account> => reads.account.account(),
    wallets: async (): Promise<Wallet[]> => reads.wallets.wallets(),
    transactions: async (): Promise<Transaction[]> => reads.transactions.transactions(),
    categories: async (): Promise<Category[]> => reads.categories.categories(),

    async events(): Promise<Event[]> {
      const source = mobile?.events;
      // Not an error: an account can simply have none, and the web API has no
      // route at all. An empty list is the honest answer either way.
      return source && mobile ? source.call(mobile) : [];
    },

    async labels(): Promise<Label[]> {
      const source = mobile?.labels;
      return source && mobile ? source.call(mobile) : [];
    },

    addTransaction: async (input: NewTransaction): Promise<string> =>
      writes.transactions.addTransaction(input),
    editTransaction: async (id: string, patch: TransactionPatch): Promise<void> =>
      writes.transactions.editTransaction(id, patch),
    deleteTransaction: async (id: string): Promise<void> =>
      writes.transactions.deleteTransaction(id),

    async retagTransactions(plan: RetagEntry[]): Promise<number> {
      const batched = writes.transactions.retagTransactions;
      if (!batched) {
        throw new MoneyLoverError("this backend cannot batch writes");
      }
      return batched.call(writes.transactions, plan);
    },

    // `async` on purpose: these can fail because a capability is missing, and
    // a method typed as returning a promise must reject rather than throw
    // synchronously, or a caller's `.catch()` misses it.
    async addWallet(input: NewWallet): Promise<string> {
      const target = require(web, "wallets");
      if (!target.addWallet) return unreachable("addWallet");
      return target.addWallet(input);
    },

    async editWallet(id: string, patch: WalletPatch): Promise<void> {
      const target = require(web, "wallets");
      if (!target.editWallet) return unreachable("editWallet");
      return target.editWallet(id, patch);
    },

    async deleteWallet(id: string): Promise<void> {
      const target = require(web, "wallets");
      if (!target.deleteWallet) return unreachable("deleteWallet");
      return target.deleteWallet(id);
    },

    async addCategory(input: NewCategory): Promise<string> {
      // Nesting and all-wallet live in the label layer, so they need mobile
      // even though the web API can create a plain per-wallet category.
      const needsLabels = input.parent !== undefined || input.wallet === undefined;
      const target = needsLabels ? require(mobile, "labels") : writes.categories;
      const add = target.addCategory;
      if (!add) throw new MoneyLoverError("no backend available for category writes");
      return add.call(target, input);
    },

    async editCategory(id: string, patch: CategoryPatch): Promise<void> {
      const edit = writes.categories.editCategory;
      if (!edit) throw new MoneyLoverError("no backend available for category writes");
      return edit.call(writes.categories, id, patch);
    },

    async deleteCategory(id: string): Promise<void> {
      const remove = writes.categories.deleteCategory;
      if (!remove) throw new MoneyLoverError("no backend available for category writes");
      return remove.call(writes.categories, id);
    },
  };

  // `require` already threw if the capability is missing, so a missing method
  // past that point is a bug in a backend, not bad input.
  function unreachable(operation: string): never {
    throw new MoneyLoverError(`backend claims wallet writes but has no ${operation}`);
  }

  return backend;
}

/** Which backend actually served each kind of call. For diagnostics and docs. */
export function describeRouting(parts: CompositeParts): Record<string, string> {
  const name = (b: Backend | undefined, fallback: Backend | undefined) =>
    (b ?? fallback)?.name ?? "unavailable";
  const { web, mobile } = parts;
  return {
    wallets: name(web, mobile),
    transactions: name(web, mobile),
    categories: name(mobile, web),
    events: mobile ? "mobile" : "unavailable",
    labels: mobile ? "mobile" : "unavailable",
    transactionWrites: name(mobile, web),
    categoryWrites: name(mobile, web),
    walletWrites: web ? "web" : "unavailable",
  };
}
