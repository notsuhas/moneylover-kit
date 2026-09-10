/**
 * The transaction wire shape, and the rebuild every write goes through.
 *
 * A push is a **full replace**, not a patch: omit a field and it is cleared. A
 * hand-rolled payload therefore silently wipes people, events, the
 * exclude-from-report flag and reminders — so every write starts from the live
 * row rather than from the caller's intent.
 */

import type { WireTransaction } from "../../../core/normalise.js";
import { day } from "../../../core/normalise.js";

/**
 * The pull carries more than the normalised shape needs, and a push is a full
 * replace, so these extras have to survive an edit rather than be dropped.
 */
interface RawTransaction extends WireTransaction {
  /** Owned by the official client. Resent verbatim, never regenerated. */
  metadata?: string;
}

export type { RawTransaction };

/** A pushed transaction item. Short keys; `f` is the sync flag. */
export interface PushItem {
  a: number;
  ac: string;
  c: string;
  cp: string[];
  dd: string;
  er: boolean;
  f: 1 | 2 | 3;
  gid: string;
  im: string[];
  la: number;
  lo: number;
  md: string;
  mr: boolean;
  n: string;
  p: string[];
  rd: number;
  version: number;
  isDelete?: boolean;
}

/**
 * Rebuild the full wire item from a live row.
 *
 * A push is a **full replace**, not a patch: omit a field and it is cleared. A
 * hand-rolled payload therefore silently wipes people, events, the
 * exclude-from-report flag and reminders. Every write goes through here.
 */
export function itemFrom(row: RawTransaction, categoryId: string, f: 1 | 2 | 3): PushItem {
  return {
    a: row.amount,
    ac: row.account._id,
    c: categoryId,
    cp: row.campaign ?? [],
    dd: day(row.displayDate),
    er: Boolean(row.exclude_report),
    f,
    gid: row._id,
    im: row.images ?? [],
    la: row.latitude ?? 0,
    lo: row.longtitude ?? 0,
    // Whatever the official client put here, unchanged. Rebuilding this as
    // "{}" silently destroyed anything the app was tracking on the row.
    // "{}" is only the fallback when the row genuinely has none.
    md: row.metadata ?? "{}",
    mr: Boolean(row.mark_report),
    n: row.note ?? "",
    p: row.with ?? [],
    rd: row.remind ?? 0,
    version: 0,
  };
}
