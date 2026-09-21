import type { WireWallet } from "../../../core/normalise.js";
import type { NewWallet, WalletPatch } from "../../../core/types.js";

export interface WalletPushItem {
  ar: boolean;
  at: number;
  b?: number;
  c: number;
  et: boolean;
  f: 1 | 2 | 3;
  gid: string;
  ic: string;
  md: string;
  n: string;
  si: number;
  tn: boolean;
  version: number;
}

export function newWalletItem(id: string, input: NewWallet, sortIndex: number): WalletPushItem {
  return {
    ar: false,
    at: 0,
    b: 0,
    c: input.currencyId,
    et: false,
    f: 1,
    gid: id,
    ic: input.icon ?? "icon",
    md: "",
    n: input.name,
    si: sortIndex,
    tn: true,
    version: 0,
  };
}

export function walletItem(
  wallet: WireWallet,
  flag: 2 | 3,
  patch: WalletPatch = {},
): WalletPushItem {
  return {
    ar: Boolean(wallet.archived),
    at: wallet.account_type ?? 0,
    c: patch.currencyId ?? wallet.currency_id,
    et: Boolean(wallet.exclude_total),
    f: flag,
    gid: wallet._id,
    ic: patch.icon ?? wallet.icon ?? "icon",
    md: wallet.metadata ?? "",
    n: patch.name ?? wallet.name,
    si: wallet.sort_index ?? 0,
    tn: wallet.transaction_notification ?? true,
    version: (wallet.version ?? 0) + 1,
  };
}
