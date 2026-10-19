import { transactionDate } from "./dates.js";
import { MoneyLoverError } from "./types.js";

type Metadata = Record<string, unknown>;

function object(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Preserve app metadata while retaining the receipt offset that the API normalizes away. */
export function receiptMetadata(metadata: string | undefined, dateTime: string): string {
  const stamp = transactionDate({ dateTime }).dateTime;
  let before: unknown;
  try {
    before = metadata ? JSON.parse(metadata) : {};
  } catch {
    throw new MoneyLoverError("cannot preserve non-JSON metadata while recording receipt time");
  }
  if (!object(before)) throw new MoneyLoverError("cannot preserve non-object receipt metadata");
  const own = before.moneyloverKit;
  if (own !== undefined && !object(own))
    throw new MoneyLoverError("unexpected moneyloverKit metadata");
  return JSON.stringify({ ...before, moneyloverKit: { ...own, dateTime: stamp } });
}

/** An official-app date edit invalidates a saved offset if the instant no longer matches. */
export function receiptTime(displayDate: string, metadata?: string): string | undefined {
  try {
    const value: unknown = JSON.parse(metadata ?? "{}");
    if (!object(value) || !object(value.moneyloverKit)) return undefined;
    const stamp = value.moneyloverKit.dateTime;
    if (typeof stamp !== "string" || Date.parse(stamp) !== Date.parse(displayDate))
      return undefined;
    return transactionDate({ dateTime: stamp }).dateTime;
  } catch {
    return undefined;
  }
}
