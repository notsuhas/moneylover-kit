/** Normalised shapes. Both backends map onto these so callers never branch. */

export type BackendName = "web" | "mobile";

export interface Wallet {
  id: string;
  name: string;
  currencyId: number;
  archived: boolean;
  icon?: string;
  /** Only the web backend reports balances; the mobile pull has no such field. */
  balance?: Record<string, string>;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  type: "income" | "expense";
  /**
   * Which wallet this row belongs to. The mobile API models one category row
   * per wallet, so the same name appears many times with different ids. The web
   * API's `category/list-all` returns one id per name, and leaves this unset.
   */
  walletId?: string;
  /** `IS_LOAN`, `IS_REPAYMENT`, … marks a category the app special-cases. */
  metadata?: string;
  /**
   * The parent's id *in the same wallet*. Mobile only, and a full-replace
   * write must resend it or the category quietly stops being nested.
   */
  parentId?: string;
  /** Money Lover's own grouping number. Resent unchanged on an edit. */
  group?: number;
}

/** Global category record — the only layer that spans wallets and nests. Mobile only. */
export interface Label {
  id: string;
  name: string;
  icon: string;
  type: "income" | "expense";
  /** Per-wallet category ids this label groups. */
  categoryIds: string[];
  /** Wallets this label is hidden from. Empty means every wallet. */
  excludedWalletIds: string[];
  parentId?: string;
}

export interface Transaction {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Signed: negative expense, positive income. */
  amount: number;
  note: string;
  walletId: string;
  categoryId: string;
  categoryName?: string;
  type: "income" | "expense";
  people: string[];
  eventIds: string[];
  excludeReport: boolean;
  /** The other leg of a transfer, when there is one. */
  relatedId?: string;
  /** Reminder timestamp, in whatever units Money Lover stored it. 0 or absent means none. */
  remindAt?: number;
}

export interface NewTransaction {
  /** Wallet name or id. */
  wallet: string;
  /** Category name or id. */
  category: string;
  /** Signed: negative expense, positive income. */
  amount: number;
  note?: string;
  /** YYYY-MM-DD; defaults to today. */
  date?: string;
  people?: string[];
  eventId?: string;
  excludeReport?: boolean;
}

export interface TransactionPatch {
  category?: string;
  amount?: number;
  note?: string;
  date?: string;
  people?: string[];
  eventId?: string | null;
  excludeReport?: boolean;
}

export interface RetagEntry {
  /** Transaction id. */
  id: string;
  /** Target category name or id. */
  category: string;
}

export interface TransactionQuery {
  note?: string;
  wallet?: string;
  category?: string;
  from?: string;
  to?: string;
  minAmount?: number;
  maxAmount?: number;
  limit?: number;
}

export interface Event {
  id: string;
  name: string;
}

export interface NewWallet {
  name: string;
  /** Money Lover's numeric currency id — 11 is INR. See `currencies()`. */
  currencyId: number;
  icon?: string;
}

/**
 * A wallet edit is a full replace: the API rejects `{id, name}` alone, so every
 * field is resent. Anything omitted here is carried over from the live row.
 */
export interface WalletPatch {
  name?: string;
  icon?: string;
  currencyId?: number;
}

export interface NewCategory {
  name: string;
  /**
   * Wallet name or id. Omit to create the category in **every** wallet, which
   * is what the app does and what the mobile backend supports; the web backend
   * requires a single wallet.
   */
  wallet?: string;
  type: "income" | "expense";
  icon?: string;
  /**
   * Parent category name, for a nested category. Needs the mobile backend —
   * nesting lives in the label layer, which the web API does not model.
   */
  parent?: string;
}

export interface CategoryPatch {
  name?: string;
  icon?: string;
}

/** What a backend can actually do. The two differ, and callers need to know. */
export interface Capabilities {
  /** Wallet balances on reads. */
  balances: boolean;
  /** Create, edit and delete wallets. */
  wallets: boolean;
  /** Create, edit and delete categories. */
  categories: boolean;
  /** The global label layer: all-wallet categories and parent nesting. */
  labels: boolean;
}

export interface Account {
  id: string;
  email: string;
  /** How many devices may hold a token at once. A login past it is refused. */
  deviceLimit: number;
}

export interface Backend {
  readonly name: BackendName;
  readonly can: Capabilities;
  account(): Promise<Account>;
  wallets(): Promise<Wallet[]>;
  categories(): Promise<Category[]>;
  transactions(): Promise<Transaction[]>;
  events(): Promise<Event[]>;
  /** Global, nestable category records. Mobile only — the web API has no equivalent. */
  labels?(): Promise<Label[]>;
  addTransaction(input: NewTransaction): Promise<string>;
  editTransaction(id: string, patch: TransactionPatch): Promise<void>;
  deleteTransaction(id: string): Promise<void>;
  /**
   * Recategorise many transactions in as few requests as the API allows.
   * Present only where the backend can batch; callers should fall back to
   * `editTransaction` in a loop.
   */
  retagTransactions?(plan: RetagEntry[]): Promise<number>;

  // Structure. Present only where `can` says so.
  addWallet?(input: NewWallet): Promise<string>;
  editWallet?(id: string, patch: WalletPatch): Promise<void>;
  deleteWallet?(id: string): Promise<void>;
  addCategory?(input: NewCategory): Promise<string>;
  editCategory?(id: string, patch: CategoryPatch): Promise<void>;
  deleteCategory?(id: string): Promise<void>;
}

export class MoneyLoverError extends Error {
  constructor(
    message: string,
    readonly code?: number | string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "MoneyLoverError";
  }
}
