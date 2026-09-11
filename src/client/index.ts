/**
 * The composition root: one object that hides which backend is in use.
 *
 * The CLI and the MCP server are both thin layers over this, so neither can do
 * anything the library cannot.
 */

import type { AuthOptions } from "../api/auth.js";
import { createCompositeBackend, describeRouting } from "../api/backends/composite.js";
import { createMobileBackend } from "../api/backends/mobile/index.js";
import { createWebBackend } from "../api/backends/web/index.js";
import { type Cache, createCache } from "../core/cache.js";
import {
  type LendingInput,
  type LendingKind,
  lendingCategory,
  lendingSummary,
  type PersonBalance,
} from "../core/lending.js";
import { categoryIndex, filterTransactions, findCategory, findWallet } from "../core/query.js";
import type {
  Backend,
  BackendName,
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
  TransactionQuery,
  Wallet,
  WalletPatch,
} from "../core/types.js";
import { MoneyLoverError } from "../core/types.js";
import { createStructureApi } from "./structure.js";

export interface ClientOptions extends Omit<AuthOptions, "backend"> {
  /**
   * Force one API instead of routing per operation.
   *
   * The default composes both and sends each call to whichever can do it, so
   * this is an escape hatch — for reproducing a backend-specific behaviour, or
   * for pinning a pipeline whose output must not move.
   */
  backend?: BackendName;
  /** Use this backend instead of constructing one. The seam for testing. */
  use?: Backend;
  /**
   * Per-API tokens. Each API issues its own and rejects the other's, so a
   * single `token` is only unambiguous when `backend` forces one.
   */
  webToken?: string;
  mobileToken?: string;
  /** Seconds to reuse a read. Writes invalidate regardless. 0 disables. */
  cacheSeconds?: number;
}

export interface MoneyLover {
  readonly backend: BackendName;
  /**
   * What is reachable with the credentials given. Every operation is routed
   * to whichever API can do it, so this is for diagnostics — not something a
   * caller should have to branch on.
   */
  readonly can: Capabilities;
  /** Which API served each kind of call. For `whoami` and for bug reports. */
  readonly routing: Record<string, string>;

  account(): ReturnType<Backend["account"]>;
  wallets(): Promise<Wallet[]>;
  categories(): Promise<Category[]>;
  events(): Promise<Event[]>;
  /** Global, nestable category records. Empty where the backend has no such layer. */
  labels(): Promise<Label[]>;

  transactions(query?: TransactionQuery): Promise<Transaction[]>;
  /** One row by id. Throws if it does not exist. */
  transaction(id: string): Promise<Transaction>;
  addTransaction(input: NewTransaction): Promise<Transaction>;
  editTransaction(id: string, patch: TransactionPatch): Promise<Transaction>;
  deleteTransaction(id: string): Promise<Transaction>;
  /**
   * Recategorise many transactions. Batched into few requests where the
   * backend supports it, otherwise one edit at a time.
   */
  retag(plan: RetagEntry[]): Promise<number>;

  addWallet(input: NewWallet): Promise<Wallet>;
  editWallet(wallet: string, patch: WalletPatch): Promise<Wallet>;
  deleteWallet(wallet: string): Promise<Wallet>;
  /** Omit `wallet` to create it in every wallet; pass `parent` to nest it. */
  addCategory(input: NewCategory): Promise<Category>;
  editCategory(category: string, patch: CategoryPatch): Promise<Category>;
  deleteCategory(category: string): Promise<Category>;

  /** Record a loan, collection, borrowing or repayment against a person. */
  recordLending(kind: LendingKind, input: LendingInput): Promise<Transaction>;
  /** Net position per person, across every wallet. */
  lending(person?: string): Promise<PersonBalance[]>;
}

/** The mobile API needs the Android app's OAuth client, which not everyone has. */
const mobileConfigured = (): boolean =>
  Boolean(process.env.MONEYLOVER_MOBILE_CLIENT && process.env.MONEYLOVER_MOBILE_SECRET);

interface Resolved {
  backend: Backend;
  /** Which API serves each kind of call, for diagnostics. */
  routing: Record<string, string>;
}

function resolveBackend(options: ClientOptions, cache: Cache): Resolved {
  if (options.use) return { backend: options.use, routing: { all: options.use.name } };

  const forced = options.backend ?? (process.env.MONEYLOVER_BACKEND as BackendName | undefined);
  if (forced === "mobile") {
    return { backend: createMobileBackend(options, cache), routing: { all: "mobile (forced)" } };
  }
  if (forced === "web") {
    return { backend: createWebBackend(options, cache), routing: { all: "web (forced)" } };
  }
  if (forced) {
    throw new MoneyLoverError(`unknown backend ${JSON.stringify(forced)} — use "web" or "mobile"`);
  }

  /**
   * Nothing forced: compose whatever is reachable and route per operation.
   *
   * A bare `token` is deliberately not passed on here — it belongs to one API
   * and would be rejected by the other. Each backend takes its own token if
   * given one, and otherwise uses its own cache or logs in.
   */
  const shared = { ...options, token: undefined };
  const parts = {
    web: createWebBackend(
      { ...shared, ...(options.webToken ? { token: options.webToken } : {}) },
      cache,
    ),
    ...(mobileConfigured()
      ? {
          mobile: createMobileBackend(
            { ...shared, ...(options.mobileToken ? { token: options.mobileToken } : {}) },
            cache,
          ),
        }
      : {}),
  };
  return { backend: createCompositeBackend(parts), routing: describeRouting(parts) };
}

export function createClient(options: ClientOptions = {}): MoneyLover {
  const cache: Cache = createCache(options.cacheSeconds ?? 60);
  const { backend, routing } = resolveBackend(options, cache);

  // The backends cache the raw lists under their own keys; these memoise the
  // normalised view on top, and a write drops both.
  const wallets = () => cache.read("wallets", () => backend.wallets());
  const categories = () => cache.read("categories", () => backend.categories());
  const allTransactions = () => cache.read("transactions", () => backend.transactions());

  /** A transaction write invalidates the normalised view and both raw lists. */
  const forgetTransactions = () =>
    cache.drop("transactions", "web:transactions", "mobile:transactions");

  async function transaction(id: string): Promise<Transaction> {
    const row = (await allTransactions()).find((t) => t.id === id);
    if (!row) throw new MoneyLoverError(`no transaction ${id}`);
    return row;
  }

  /**
   * Describe a written row without reading it back.
   *
   * Reading it back would be more honest, but there is no get-by-id on either
   * API — the only read is the whole account — so a re-read costs 10-18s and
   * pushed every write past a 30s gateway timeout. The push already succeeded
   * or threw, so the fields are known; this reports them and drops the cache
   * so the next read is fresh.
   */
  function described(row: Transaction): Transaction {
    forgetTransactions();
    return row;
  }

  const structure = createStructureApi({ backend, cache, wallets, categories });

  return {
    backend: backend.name,
    can: backend.can,
    routing,
    account: () => cache.read("account", () => backend.account()),
    wallets,
    categories,
    events: () => cache.read("events", () => backend.events?.() ?? Promise.resolve([])),
    labels: () => cache.read("labels", () => backend.labels?.() ?? Promise.resolve([])),
    ...structure,

    async transactions(query: TransactionQuery = {}): Promise<Transaction[]> {
      const { wallet, category, ...rest } = query;
      let scoped = await allTransactions();

      if (wallet) {
        const id = findWallet(await wallets(), wallet).id;
        scoped = scoped.filter((t) => t.walletId === id);
      }
      if (category) {
        const all = await categories();
        const wanted = new Set(
          all
            .filter((c) => c.id === category || c.name.toLowerCase() === category.toLowerCase())
            .map((c) => c.name.toLowerCase()),
        );
        if (wanted.size === 0) {
          throw new MoneyLoverError(`no category ${JSON.stringify(category)}`);
        }
        const lookup = categoryIndex(all);
        scoped = scoped.filter((t) => {
          const name = lookup(t)?.name ?? t.categoryName;
          return name ? wanted.has(name.toLowerCase()) : false;
        });
      }
      return filterTransactions(scoped, rest);
    },

    transaction,

    async addTransaction(input: NewTransaction): Promise<Transaction> {
      const [wallet, category] = await Promise.all([
        findWallet(await wallets(), input.wallet),
        findCategory(await categories(), input.category),
      ]);
      const id = await backend.addTransaction(input);
      return described({
        id,
        date: input.date ?? new Date().toISOString().slice(0, 10),
        amount: input.amount,
        note: input.note ?? "",
        walletId: wallet.id,
        categoryId: category.id,
        categoryName: category.name,
        type: category.type,
        people: input.people ?? [],
        eventIds: input.eventId ? [input.eventId] : [],
        excludeReport: Boolean(input.excludeReport),
      });
    },

    async editTransaction(id: string, patch: TransactionPatch): Promise<Transaction> {
      const before = await transaction(id);
      const category = patch.category ? findCategory(await categories(), patch.category) : null;
      await backend.editTransaction(id, patch);
      return described({
        ...before,
        ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.date !== undefined ? { date: patch.date } : {}),
        ...(patch.people !== undefined ? { people: patch.people } : {}),
        ...(patch.excludeReport !== undefined ? { excludeReport: patch.excludeReport } : {}),
        ...(patch.eventId !== undefined ? { eventIds: patch.eventId ? [patch.eventId] : [] } : {}),
        ...(category
          ? { categoryId: category.id, categoryName: category.name, type: category.type }
          : {}),
      });
    },

    async deleteTransaction(id: string): Promise<Transaction> {
      const row = await transaction(id);
      await backend.deleteTransaction(id);
      return described(row);
    },

    async retag(plan: RetagEntry[]): Promise<number> {
      if (plan.length === 0) return 0;
      const batched = backend.retagTransactions;
      if (batched) {
        const written = await batched.call(backend, plan);
        forgetTransactions();
        return written;
      }
      // No batching here, so this is thousands of round trips. Sequential on
      // purpose: the API resets the connection under concurrency.
      for (const { id, category } of plan) {
        await backend.editTransaction(id, { category });
      }
      forgetTransactions();
      return plan.length;
    },

    async recordLending(kind: LendingKind, input: LendingInput): Promise<Transaction> {
      if (input.amount <= 0) {
        throw new MoneyLoverError(
          `amount must be positive — \`${kind}\` already sets the direction`,
        );
      }
      const wallet = findWallet(await wallets(), input.wallet);
      const category = lendingCategory(await categories(), kind, wallet.id);
      const amount = category.type === "expense" ? -input.amount : input.amount;
      const id = await backend.addTransaction({
        wallet: wallet.id,
        category: category.id,
        amount,
        people: [input.person],
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.date !== undefined ? { date: input.date } : {}),
      });
      return described({
        id,
        date: input.date ?? new Date().toISOString().slice(0, 10),
        amount,
        note: input.note ?? "",
        walletId: wallet.id,
        categoryId: category.id,
        categoryName: category.name,
        type: category.type,
        people: [input.person],
        eventIds: [],
        excludeReport: false,
      });
    },

    async lending(person?: string): Promise<PersonBalance[]> {
      const currencyOf = new Map((await wallets()).map((w) => [w.id, w.currencyId]));
      return lendingSummary(await allTransactions(), await categories(), person, currencyOf);
    },
  };
}
