import { AsyncLocalStorage } from "node:async_hooks";
import { MoneyLoverError } from "../core/types.js";

/**
 * Cloudflare sits in front of both APIs and rejects non-browser User-Agents
 * before the request reaches Money Lover, in a way that reads as an auth
 * failure. Every request sends one.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const readDeadlines = new AsyncLocalStorage<AbortSignal>();

export async function withReadDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs = 20_000,
): Promise<T> {
  if (readDeadlines.getStore()) return operation();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Read deadline exceeded", "TimeoutError")),
    timeoutMs,
  );
  try {
    return await readDeadlines.run(controller.signal, operation);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

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
  signal?: AbortSignal;
}

/** Retry reads, but never replay an uncertain financial push. */
export async function post<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const mutation =
    /\/api\/sync\/push\/|\/(?:transaction|wallet|category)\/(?:add|edit|delete)(?:$|\?)/.test(url);
  const {
    headers = {},
    body,
    form,
    attempts = mutation ? 1 : 2,
    timeoutMs = mutation ? 60_000 : 8_000,
  } = options;
  const deadline = mutation ? undefined : readDeadlines.getStore();
  const signal =
    options.signal && deadline
      ? AbortSignal.any([options.signal, deadline])
      : (options.signal ?? deadline);
  const payload = form ? new URLSearchParams(form).toString() : JSON.stringify(body ?? {});
  const contentType = form
    ? "application/x-www-form-urlencoded"
    : "application/json; charset=utf-8";

  for (let attempt = 1; ; attempt++) {
    try {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": contentType, "user-agent": BROWSER_UA, ...headers },
        body: payload,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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
      if (res.status === 401 || res.status === 403) {
        void res.body?.cancel().catch(() => undefined);
        throw new MoneyLoverError(`${url} -> HTTP ${res.status}`, res.status);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await res.body?.cancel();
        await sleep(2 ** attempt * 1000, signal);
        continue;
      }
      throw new MoneyLoverError(
        `${url} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        res.status,
      );
    } catch (err) {
      if (
        signal?.aborted ||
        err instanceof MoneyLoverError ||
        !isNetworkError(err) ||
        attempt === attempts
      )
        throw err;
      await sleep(2 ** attempt * 1000, signal);
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
