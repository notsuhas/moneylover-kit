import { MoneyLoverError } from "./types.js";

/** Resolve receipt time without borrowing the server's timezone. */
export function transactionDate(
  input: { date?: string; dateTime?: string },
  fallback?: string,
): { date: string; dateTime?: string } {
  if (input.dateTime !== undefined) {
    if (input.date !== undefined) throw new MoneyLoverError("pass date or dateTime, not both");
    const value = input.dateTime;
    const parsed = Date.parse(value);
    const zone = value.endsWith("Z") ? "+00:00" : value.slice(-6);
    const minutes =
      (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) * (zone[0] === "-" ? -1 : 1);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(parsed) ||
      Number(zone.slice(1, 3)) > 23 ||
      Number(zone.slice(4)) > 59 ||
      new Date(parsed + minutes * 60000).toISOString().slice(0, 19) !== value.slice(0, 19)
    ) {
      throw new MoneyLoverError("dateTime must be a valid ISO timestamp with Z or a UTC offset");
    }
    return { date: value.slice(0, 10), dateTime: value };
  }
  const value = input.date ?? fallback ?? new Date().toISOString().slice(0, 10);
  return { date: value.slice(0, 10), ...(value.includes("T") ? { dateTime: value } : {}) };
}

/** Keep the full timestamp when the API supplied one. */
export function displayDate(
  input: { date?: string; dateTime?: string },
  fallback?: string,
): string {
  const value = transactionDate(input, fallback);
  return value.dateTime ?? value.date;
}
