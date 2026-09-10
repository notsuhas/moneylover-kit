/**
 * moneylover-kit — unofficial Money Lover client.
 *
 * ```ts
 * import { createClient } from "moneylover-kit";
 *
 * const ml = createClient();               // MONEYLOVER_EMAIL / MONEYLOVER_PASSWORD
 * await ml.wallets();
 * await ml.addTransaction({ wallet: "Cash", category: "Groceries", amount: -480 });
 * ```
 *
 * The CLI and the MCP server are both thin layers over this, so anything they
 * can do is available here.
 */

export { accessToken, mobileLogin, tokenLocation, webLogin } from "./api/auth.js";
export { createMobileBackend } from "./api/backends/mobile/index.js";
export { createWebBackend } from "./api/backends/web/index.js";
export { type ClientOptions, createClient, type MoneyLover } from "./client/index.js";
export {
  type LendingInput,
  type LendingKind,
  lendingCategory,
  lendingKindOf,
  lendingSummary,
  type PersonBalance,
} from "./core/lending.js";
export { categoryIndex, filterTransactions, findCategory, findWallet } from "./core/query.js";
export {
  type Account,
  type Backend,
  type BackendName,
  type Category,
  type Event,
  type Label,
  MoneyLoverError,
  type NewTransaction,
  type RetagEntry,
  type Transaction,
  type TransactionPatch,
  type TransactionQuery,
  type Wallet,
} from "./core/types.js";
export { createMcpServer } from "./mcp/server.js";
