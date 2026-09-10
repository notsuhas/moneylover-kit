/**
 * What every command needs: the client, the parsed flags, and the small
 * helpers that turn strings from a terminal into typed arguments.
 */

import type { MoneyLover } from "../client/index.js";
import type { WalletNames } from "./render.js";

export interface Flags {
  json?: boolean;
  backend?: string;
  wallet?: string;
  category?: string;
  amount?: string;
  note?: string;
  person?: string;
  date?: string;
  with?: string;
  "exclude-report"?: boolean;
  from?: string;
  to?: string;
  min?: string;
  max?: string;
  limit?: string;
  force?: boolean;
  name?: string;
  icon?: string;
  currency?: string;
  parent?: string;
  type?: string;
  "all-wallets"?: boolean;
}

export interface Ctx {
  client: MoneyLover;
  flags: Flags;
  /** Positional arguments after the command name. */
  args: string[];
  /** Print JSON or a table, depending on `--json`. */
  show(data: unknown, table?: () => void): void;
  /** Parse a numeric flag, failing with the flag's name. */
  number(value: string | undefined, name: string): number | undefined;
  /** Split a comma-separated list, dropping blanks. */
  list(value: string | undefined): string[] | undefined;
  /** Keep only the keys whose value was actually supplied. */
  defined<T extends object>(input: T): Partial<T>;
  walletNames(): Promise<WalletNames>;
}

export type Command = (ctx: Ctx) => Promise<void>;
