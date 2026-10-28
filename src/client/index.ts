/**
 * The composition root: one object that hides which backend is in use.
 *
 * The CLI and the MCP server are both thin layers over this, so neither can do
 * anything the library cannot.
 */

import type { AuthOptions } from "../api/auth.js";
import { createMobileBackend } from "../api/backends/mobile/index.js";
import { createWebBackend } from "../api/backends/web/index.js";
import { type Cache, createCache } from "../core/cache.js";
import { validateCollections } from "../core/collection.js";
import { transactionDate } from "../core/dates.js";
import {
  type ILoanCollectionInput,
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
  NewEvent,
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
   * Force one API instead of using mobile when configured.
   *
   * This is an escape hatch for reproducing backend-specific behaviour, or for
   * pinning a pipeline whose output must not move.
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
  /** Share fresh reads only within one logical operation. */
  withFreshReads<T>(operation: () => Promise<T>): Promise<T>;
  readonly backend: BackendName;
  /**
   * What is reachable with the credentials given. Every operation is routed
   * to whichever API can do it, so this is for diagnostics — not something a
   * caller should have to branch on.
   */
  readonly can: Capabilities;
  /** Which API served the calls. For `whoami` and for bug reports. */
  readonly routing: Record<string, string>;

  account(): ReturnType<Backend["account"]>;
  wallets(walletIds?: string[]): Promise<Wallet[]>;
  /** Wallet identities and currency, without calculating balances. */
  walletCatalog(): Promise<Wallet[]>;
  categories(): Promise<Category[]>;
  events(): Promise<Event[]>;
  addEvent(input: NewEvent): Promise<Event>;
  /** Global, nestable category records. Empty where the backend has no such layer. */
  labels(): Promise<Label[]>;

  transactions(query?: TransactionQuery): Promise<Transaction[]>;
  /** One row by id. Throws if it does not exist. */
  transaction(id: string): Promise<Transaction>;
  addTransaction(input: NewTransaction): Promise<Transaction>;
  addTransactions(inputs: NewTransaction[]): Promise<Transaction[]>;
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
  collectLoan(loanId: string, input: ILoanCollectionInput): Promise<Transaction>;
  /** Net position per person, across every wallet. */
  lending(person?: string): Promise<PersonBalance[]>;
}

interface Resolved {
  backend: Backend;
  /** Which API serves calls, for diagnostics. */
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

  return {
    backend: createMobileBackend(
      { ...options, token: options.mobileToken ?? options.token },
      cache,
    ),
    routing: { all: "mobile" },
  };
}

function createdTransaction(
  id: string,
  input: NewTransaction,
  wallet: Wallet,
  category: Category,
): Transaction {
  return {
    id,
    ...transactionDate(input),
    amount: input.amount,
    note: input.note ?? "",
    walletId: wallet.id,
    categoryId: category.id,
    categoryName: category.name,
    type: category.type,
    people: input.people ?? [],
    eventIds: input.eventId ? [input.eventId] : [],
    excludeReport: Boolean(input.excludeReport),
    ...(input.parentId ? { parentId: input.parentId } : {}),
  };
}

export function createClient(options: ClientOptions = {}): MoneyLover {
  const cache: Cache = createCache(options.cacheSeconds ?? 60);
  const { backend, routing } = resolveBackend(options, cache);

  // The backends cache the raw lists under their own keys; these memoise the
  // normalised view on top, and a write drops both.
  const walletBalanceKeys = new Set<string>();
  const walletTransactionKeys = new Set<string>();
  const wallets = (walletIds?: string[]) => {
    if (!walletIds) return cache.read("wallets", () => backend.wallets());
    const ids = [...new Set(walletIds)].sort();
    if (!ids.length) return Promise.resolve([]);
    const key = `wallets:${JSON.stringify(ids)}`;
    walletBalanceKeys.add(key);
    return cache.read(key, async () =>
      (await backend.wallets(ids)).filter((wallet) => ids.includes(wallet.id)),
    );
  };
  const walletCatalog = () =>
    cache.read("wallet-catalog", () => backend.walletCatalog?.() ?? backend.wallets());
  const categories = () => cache.read("categories", () => backend.categories());
  const allTransactions = () => cache.read("transactions", () => backend.transactions());
  const walletTransactions = (walletId: string) => {
    const key = `transactions:wallet:${walletId}`;
    walletTransactionKeys.add(key);
    return cache.read(key, () =>
      backend.transactionsInWallet
        ? backend.transactionsInWallet(walletId)
        : allTransactions().then((rows) => rows.filter((row) => row.walletId === walletId)),
    );
  };
  const events = () => cache.read("events", () => backend.events?.() ?? Promise.resolve([]));

  /** A transaction write invalidates the normalised view and both raw lists. */
  const forgetTransactions = () =>
    cache.drop(
      "transactions",
      "web:transactions",
      "mobile:transactions",
      "wallets",
      ...walletBalanceKeys,
      ...walletTransactionKeys,
    );

  async function attemptWrite<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      forgetTransactions();
    }
  }

  async function transaction(id: string): Promise<Transaction> {
    const row = (await allTransactions()).find((t) => t.id === id);
    if (!row) throw new MoneyLoverError(`no transaction ${id}`);
    return row;
  }

  /** Return acknowledged input and invalidate reads; receipt tools perform server readback. */
  function described(row: Transaction): Transaction {
    forgetTransactions();
    return row;
  }

  async function validateSettlements(
    inputs: NewTransaction[],
    rows?: Transaction[],
  ): Promise<void> {
    const [cats, allWallets] = await Promise.all([categories(), walletCatalog()]);
    if (
      !inputs.some(
        (input) =>
          input.parentId ||
          ["IS_DEBT_COLLECTION", "IS_REPAYMENT"].includes(
            findCategory(cats, input.category, findWallet(allWallets, input.wallet).id).metadata ??
              "",
          ),
      )
    )
      return;
    if (backend.name !== "mobile") throw new MoneyLoverError("loan/debt linking requires mobile");
    if (!rows) forgetTransactions();
    validateCollections(inputs, rows ?? (await allTransactions()), cats, await walletCatalog());
  }

  async function recordLending(
    kind: LendingKind,
    input: LendingInput,
    rows?: Transaction[],
  ): Promise<Transaction> {
    if (!Number.isFinite(input.amount) || input.amount <= 0)
      throw new MoneyLoverError("amount must be positive and finite");
    if ((kind === "collect" || kind === "repay") && !input.parentId)
      throw new MoneyLoverError("collect/repay require parentId; split across original records");
    if ((kind === "lend" || kind === "borrow") && input.parentId)
      throw new MoneyLoverError("Only collect/repay accept parentId");
    const wallet = findWallet(await walletCatalog(), input.wallet);
    const category = lendingCategory(await categories(), kind, wallet.id);
    const entry: NewTransaction = {
      wallet: wallet.id,
      category: category.id,
      amount: category.type === "expense" ? -input.amount : input.amount,
      people: [input.person],
      ...(input.parentId ? { parentId: input.parentId, excludeReport: true } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
      ...(input.dateTime !== undefined ? { dateTime: input.dateTime } : {}),
      ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
    };
    transactionDate(entry);
    await validateSettlements([entry], rows);
    return described(
      createdTransaction(
        await attemptWrite(() => backend.addTransaction(entry)),
        entry,
        wallet,
        category,
      ),
    );
  }

  const structure = createStructureApi({
    backend,
    cache,
    wallets,
    categories,
    invalidateTransactions: forgetTransactions,
  });

  return {
    withFreshReads: cache.scope,
    backend: backend.name,
    can: backend.can,
    routing,
    account: () => cache.read("account", () => backend.account()),
    wallets,
    walletCatalog,
    categories,
    events,
    labels: () => cache.read("labels", () => backend.labels?.() ?? Promise.resolve([])),
    ...structure,

    async transactions(query: TransactionQuery = {}): Promise<Transaction[]> {
      const { wallet, category, ...rest } = query;
      const walletId = wallet ? findWallet(await walletCatalog(), wallet).id : undefined;
      let scoped = walletId ? await walletTransactions(walletId) : await allTransactions();
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
        walletCatalog().then((all) => findWallet(all, input.wallet)),
        categories().then((all) => findCategory(all, input.category)),
      ]);
      transactionDate(input);
      await validateSettlements([input]);
      const id = await attemptWrite(() => backend.addTransaction(input));
      return described(createdTransaction(id, input, wallet, category));
    },

    async addTransactions(inputs: NewTransaction[]): Promise<Transaction[]> {
      const [allWallets, allCategories] = await Promise.all([walletCatalog(), categories()]);
      const targets = inputs.map((input) => {
        transactionDate(input);
        const wallet = findWallet(allWallets, input.wallet);
        const category = findCategory(allCategories, input.category, wallet.id);
        if ((category.type === "expense") !== input.amount < 0)
          throw new MoneyLoverError("Amount sign disagrees with category");
        return { wallet, category };
      });
      await validateSettlements(inputs);
      let ids: string[];
      const batch = backend.addTransactions;
      if (batch) ids = await attemptWrite(() => batch.call(backend, inputs));
      else {
        ids = [];
        for (const input of inputs)
          ids.push(await attemptWrite(() => backend.addTransaction(input)));
      }
      if (ids.length !== inputs.length) throw new MoneyLoverError("Incomplete transaction batch");
      return inputs.map((input, index) => {
        const target = targets[index];
        const id = ids[index];
        if (!target || !id) throw new MoneyLoverError("Incomplete transaction batch");
        return described(createdTransaction(id, input, target.wallet, target.category));
      });
    },

    async editTransaction(id: string, patch: TransactionPatch): Promise<Transaction> {
      const before = await transaction(id);
      const category = patch.category ? findCategory(await categories(), patch.category) : null;
      const time = transactionDate(patch, before.dateTime ?? before.date);
      await validateSettlements(
        [
          {
            wallet: before.walletId,
            category: patch.category ?? before.categoryId,
            amount: patch.amount ?? before.amount,
            people: patch.people ?? before.people,
            ...(before.parentId ? { parentId: before.parentId } : {}),
          },
        ],
        (await allTransactions()).filter((row) => row.id !== id),
      );
      const children = (await allTransactions()).filter((row) => row.parentId === id);
      if (children.length) {
        const childIds = new Set(children.map((row) => row.id));
        const prospective = {
          ...before,
          amount: patch.amount ?? before.amount,
          people: patch.people ?? before.people,
          ...(category ? { categoryId: category.id, type: category.type } : {}),
        };
        await validateSettlements(
          children.map((row) => ({
            wallet: row.walletId,
            category: row.categoryId,
            amount: row.amount,
            people: row.people,
            parentId: id,
          })),
          [
            ...(await allTransactions()).filter((row) => row.id !== id && !childIds.has(row.id)),
            prospective,
          ],
        );
      }
      await attemptWrite(() => backend.editTransaction(id, patch));
      const { dateTime: _previousTime, ...unchanged } = before;
      return described({
        ...unchanged,
        ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...time,
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
      await attemptWrite(() => backend.deleteTransaction(id));
      return described(row);
    },

    async retag(plan: RetagEntry[]): Promise<number> {
      if (plan.length === 0) return 0;
      const batched = backend.retagTransactions;
      if (batched) {
        const written = await attemptWrite(() => batched.call(backend, plan));
        forgetTransactions();
        return written;
      }
      // No batching here, so this is thousands of round trips. Sequential on
      // purpose: the API resets the connection under concurrency.
      for (const { id, category } of plan) {
        await attemptWrite(() => backend.editTransaction(id, { category }));
      }
      forgetTransactions();
      return plan.length;
    },

    recordLending,

    async collectLoan(loanId: string, input: ILoanCollectionInput): Promise<Transaction> {
      forgetTransactions();
      const rows = await allTransactions();
      const loan = rows.find((row) => row.id === loanId);
      if (!loan || categoryIndex(await categories())(loan)?.metadata !== "IS_LOAN")
        throw new MoneyLoverError("original transaction must be an active loan");
      return recordLending(
        "collect",
        {
          ...input,
          parentId: loanId,
          person: loan.people[0] ?? "",
          ...(input.eventId === undefined && loan.eventIds.length === 1
            ? { eventId: loan.eventIds[0] }
            : {}),
        },
        rows,
      );
    },

    async lending(person?: string): Promise<PersonBalance[]> {
      const currencyOf = new Map((await walletCatalog()).map((w) => [w.id, w.currencyId]));
      return lendingSummary(await allTransactions(), await categories(), person, currencyOf);
    },
  };
}
