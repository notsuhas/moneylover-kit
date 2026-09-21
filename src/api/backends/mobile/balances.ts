import { currencyInfo } from "../../../core/currencies.js";
import { normaliseWallet, type WireWallet } from "../../../core/normalise.js";
import type { Wallet } from "../../../core/types.js";
import type { RawTransaction } from "./transactions.js";

function localDay(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function walletsWithBalances(
  source: WireWallet[],
  transactions: RawTransaction[],
  today = localDay(),
): Wallet[] {
  const wallets = source.filter((wallet) => !wallet.isDelete).map(normaliseWallet);
  const byId = new Map(wallets.map((wallet) => [wallet.id, wallet]));
  const totals = new Map<string, number>();

  for (const transaction of transactions) {
    if (transaction.isDelete || transaction.displayDate.slice(0, 10) > today) continue;
    const wallet = byId.get(transaction.account._id);
    if (!wallet) continue;
    const factor = 10 ** currencyInfo(wallet.currencyId).decimals;
    const signed = transaction.category.type === 1 ? transaction.amount : -transaction.amount;
    totals.set(wallet.id, (totals.get(wallet.id) ?? 0) + Math.round(signed * factor));
  }

  return wallets.map((wallet) => {
    const { code, decimals } = currencyInfo(wallet.currencyId);
    const factor = 10 ** decimals;
    return {
      ...wallet,
      balance: { [code]: ((totals.get(wallet.id) ?? 0) / factor).toFixed(decimals) },
    };
  });
}
