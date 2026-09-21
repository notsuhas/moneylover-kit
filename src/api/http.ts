import { MoneyLoverError } from "../core/types.js";

/**
 * Cloudflare sits in front of both APIs and rejects non-browser User-Agents
 * before the request reaches Money Lover, in a way that reads as an auth
 * failure. Every request sends one.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NETWORK_CODES = ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"];

function isNetworkError(err: unknown): boolean {
  const name = String((err as { name?: string })?.name ?? "");
  if (name === "TimeoutError" || name === "AbortError") return true;
  if (err instanceof TypeError) return true;
  const code = String((err as { code?: string; cause?: { code?: string } })?.code ?? "");
  const causeCode = String((err as { cause?: { code?: string } })?.cause?.code ?? "");
  return NETWORK_CODES.includes(code) || NETWORK_CODES.includes(causeCode);
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Sent as JSON unless `form` is set. */
  body?: unknown;
  form?: Record<string, string>;
  attempts?: number;
  timeoutMs?: number;
}

/**
 * POST and decode.
 *
 * Retries 429/5xx and thrown network errors. That second half matters: `fetch`
 * throws rather than returning a response on a reset connection, and Money
 * Lover resets under concurrency — so a status-only retry misses it entirely.
 * Keep calls sequential.
 */
export async function post<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { headers = {}, body, form, attempts = 4, timeoutMs = 60_000 } = options;
  const payload = form ? new URLSearchParams(form).toString() : JSON.stringify(body ?? {});
  const contentType = form
    ? "application/x-www-form-urlencoded"
    : "application/json; charset=utf-8";

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": contentType, "user-agent": BROWSER_UA, ...headers },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const text = await res.text();
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new MoneyLoverError(`${url} returned non-JSON: ${text.slice(0, 200)}`);
        }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw new MoneyLoverError(
        `${url} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        res.status,
      );
    } catch (err) {
      if (err instanceof MoneyLoverError || !isNetworkError(err) || attempt === attempts) throw err;
      await sleep(2 ** attempt * 1000);
    }
  }
}

/**
 * Unwrap Money Lover's envelope.
 *
 * HTTP is always 200 — the real status is in the body, and there are four
 * shapes. The normal one is `{error, msg, data}`. A rejected token comes back
 * as `{s, e, msg, router}` with *abbreviated* keys, so code checking only
 * `error` sails straight past it. A missing Authorization header returns a
 * normal envelope with `error: 0` and empty `data`, which is silent — an empty
 * result is not proof of an empty account. A malformed body returns an Express
 * stack trace.
 */
export function unwrap<T>(payload: unknown): T {
  const p = payload as {
    error?: number;
    e?: number;
    msg?: string;
    message?: string;
    data?: T;
  };
  const code = p?.error ?? p?.e ?? 0;
  if (code) {
    throw new MoneyLoverError(p?.msg ?? p?.message ?? "Money Lover API error", code, payload);
  }
  return (p?.data ?? null) as T;
}
