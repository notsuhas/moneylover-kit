/**
 * Terminal output. Separate from the command dispatch because presentation
 * changes for entirely different reasons than behaviour does, and because
 * every command wants `--json` to bypass all of it.
 */

import type { PersonBalance } from "../core/lending.js";
import type { Category, Event, Label, Transaction, Wallet } from "../core/types.js";

/** Wallet id to name, so rows can show a name the user recognises. */
export type WalletNames = Map<string, string>;

const money = (n: number): string => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(2);

/** `--json` wins over any table; a command with no table is always JSON. */
export function output(json: boolean, data: unknown, table?: () => void): void {
  if (json || !table) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  table();
}

export function transactions(rows: Transaction[], names: WalletNames): void {
  if (rows.length === 0) {
    console.log("no matching transactions");
    return;
  }
  for (const t of rows) {
    const tags = [...t.people.map((p) => `with:${p}`), ...(t.excludeReport ? ["excluded"] : [])];
    console.log(
      [
        t.date,
        money(t.amount).padStart(12),
        (t.categoryName ?? t.categoryId).padEnd(22),
        (names.get(t.walletId) ?? "?").padEnd(18),
        t.note || "—",
        tags.length ? `(${tags.join(" ")})` : "",
      ]
        .join("  ")
        .trimEnd(),
    );
    console.log(`${" ".repeat(12)}id ${t.id}`);
  }
  console.log(`\n${rows.length} transaction(s)`);
}

export function wallets(rows: Wallet[]): void {
  for (const w of rows) {
    const balance = Object.entries(w.balance ?? {})
      .map(([code, value]) => `${value} ${code}`)
      .join(", ");
    console.log(`${w.name.padEnd(22)} ${balance.padStart(18)}${w.archived ? "  (archived)" : ""}`);
  }
}

export function categories(rows: Category[]): void {
  for (const c of rows) console.log(`${c.name.padEnd(28)} ${c.type}`);
}

export function events(rows: Event[]): void {
  for (const e of rows) console.log(e.name);
}

export function labels(rows: Label[]): void {
  const byId = new Map(rows.map((l) => [l.id, l.name]));
  for (const l of rows) {
    const scope = l.excludedWalletIds.length === 0 ? "all wallets" : "some wallets";
    const parent = l.parentId ? ` under ${byId.get(l.parentId) ?? l.parentId}` : "";
    console.log(`${l.name.padEnd(28)} ${l.type.padEnd(8)} ${scope}${parent}`);
  }
}

export function lending(rows: PersonBalance[]): void {
  if (rows.length === 0) {
    console.log("no lending activity found");
    return;
  }
  console.log(
    `${"person".padEnd(24)}${"lent".padStart(12)}${"collected".padStart(12)}` +
      `${"outstanding".padStart(14)}${"you owe".padStart(12)}`,
  );
  for (const r of rows) {
    console.log(
      r.person.padEnd(24) +
        r.lent.toFixed(2).padStart(12) +
        r.collected.toFixed(2).padStart(12) +
        r.outstanding.toFixed(2).padStart(14) +
        r.owing.toFixed(2).padStart(12),
    );
  }
  const owed = rows.reduce((sum, r) => sum + r.outstanding, 0);
  const owing = rows.reduce((sum, r) => sum + r.owing, 0);
  console.log(`\nowed to you ${owed.toFixed(2)}   you owe ${owing.toFixed(2)}`);
}
