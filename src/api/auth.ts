/**
 * Authentication for both APIs, and the token cache that keeps it to one login.
 *
 * Read the device warning below before changing anything here.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type BackendName, MoneyLoverError } from "../core/types.js";
import { post, unwrap } from "./http.js";

const WEB_API = "https://web.moneylover.me/api";
const OAUTH = "https://oauth.moneylover.me";

/**
 * The Android app's OAuth client, which is what makes mobile login work without
 * a captcha. Not shipped here: it is embedded in every APK, but publishing it
 * in a searchable repo invites Money Lover to rotate it and break every user.
 * Set MONEYLOVER_MOBILE_CLIENT and MONEYLOVER_MOBILE_SECRET to enable the
 * mobile backend — see docs/api.md.
 */
function mobileClient(): { id: string; secret: string } {
  const id = process.env.MONEYLOVER_MOBILE_CLIENT;
  const secret = process.env.MONEYLOVER_MOBILE_SECRET;
  if (!id || !secret) {
    throw new MoneyLoverError(
      "The mobile backend needs MONEYLOVER_MOBILE_CLIENT and MONEYLOVER_MOBILE_SECRET.\n" +
        "See docs/api.md for what they are and how to obtain them.",
    );
  }
  return { id, secret };
}

export const MOBILE_APPVERSION = 7146;

function cacheDir(): string {
  const base =
    process.env.MONEYLOVER_CONFIG_DIR ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "moneylover-kit");
}

function cachePath(backend: BackendName, email: string): string {
  const who = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);
  return join(cacheDir(), `${backend}-${who}.json`);
}

interface Cached {
  access_token: string;
  refresh_token?: string;
  email: string;
}

function readCache(path: string): Cached | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Cached;
  } catch {
    return null;
  }
}

function writeCache(path: string, value: Cached): void {
  mkdirSync(dirname(path), { recursive: true });
  // This token is equivalent to the account password for reads and writes, so
  // keep it owner-only. `mode` applies on creation only, so an existing file
  // that was copied or chmodded stays as it was — chmod after writing repairs
  // it rather than leaving a world-readable token in place.
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** A JWT's claims, or undefined when it is not a readable JWT at all. */
function claimsOf(jwt: string): { exp?: number } | undefined {
  try {
    const body = jwt.split(".")[1];
    if (!body) return undefined;
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { exp?: number };
  } catch {
    return undefined;
  }
}

/** True when an `exp` claim is within a minute of now. No claim never expires. */
const lapsed = (claims: { exp?: number }): boolean =>
  claims.exp !== undefined && claims.exp - 60 < Date.now() / 1000;

/**
 * True when a token that we *know* is past its expiry.
 *
 * Unparseable is not expired: a caller may hand over an opaque token, and
 * refusing it because it is not a readable JWT would reject something that
 * works. Only used for supplied tokens — a cached one we minted is always a
 * JWT, and there `expired` errs the other way.
 */
function definitelyExpired(jwt: string): boolean {
  const claims = claimsOf(jwt);
  return claims !== undefined && lapsed(claims);
}

/** True when the JWT is absent, unparseable, or within a minute of expiry. */
function expired(jwt: string | undefined): boolean {
  if (!jwt) return true;
  const claims = claimsOf(jwt);
  return claims === undefined || lapsed(claims);
}

/**
 * Web password login. No captcha, despite what you may read elsewhere.
 *
 * The browser posts to `oauth.moneylover.me/web/token` with an invisible
 * `g-recaptcha-response`, which cannot be scripted. This is a *different*
 * endpoint — plain `/token`, form-encoded, with the client id from the login
 * URL — and it has no captcha at all.
 */
export async function webLogin(
  email: string,
  password: string,
): Promise<{ access_token: string; refresh_token?: string }> {
  const init = await post<{ data?: { request_token?: string; login_url?: string } }>(
    `${WEB_API}/user/login-url`,
  );
  const requestToken = init?.data?.request_token;
  const loginUrl = init?.data?.login_url;
  if (!requestToken || !loginUrl) {
    throw new MoneyLoverError("login-url did not return a request_token", undefined, init);
  }
  const client = new URL(loginUrl).searchParams.get("client");
  if (!client) throw new MoneyLoverError(`login_url has no client parameter: ${loginUrl}`);

  const grant = await post<{
    access_token?: string;
    refresh_token?: string;
    message?: string;
  }>(`${OAUTH}/token`, {
    headers: { authorization: `Bearer ${requestToken}`, client },
    form: { email, password },
  });
  if (!grant?.access_token) {
    throw new MoneyLoverError(grant?.message ?? "web login failed", undefined, grant);
  }
  // The refresh token is the whole point: it renews the access token without
  // registering another device. Losing it means logging in again every week.
  return { access_token: grant.access_token, refresh_token: grant.refresh_token };
}

/** Renew a web access token without consuming another device slot. */
async function webRefresh(
  refreshToken: string,
): Promise<{ access_token: string; refresh_token?: string }> {
  const payload = await post<unknown>(`${WEB_API}/user/refresh-token`, {
    body: { refreshToken },
  });
  const grant = unwrap<{ status?: boolean; access_token?: string; refresh_token?: string }>(
    payload,
  );
  if (!grant?.access_token) {
    throw new MoneyLoverError("web token refresh failed", undefined, grant);
  }
  return { access_token: grant.access_token, refresh_token: grant.refresh_token };
}

/** Renew exactly as the Android app does: an empty body and the token as Bearer auth. */
async function mobileRefresh(
  refreshToken: string,
): Promise<{ access_token: string; refresh_token?: string }> {
  const { id } = mobileClient();
  const grant = await post<{
    status?: boolean;
    access_token?: string;
    refresh_token?: string;
  }>(`${OAUTH}/refresh-token`, {
    headers: {
      authorization: `Bearer ${refreshToken}`,
      client: id,
      apiversion: "4",
      dataformat: "json",
      platform: "1",
      appversion: String(MOBILE_APPVERSION),
    },
  });
  if (!grant?.status || !grant.access_token) {
    throw new MoneyLoverError("mobile token refresh failed", undefined, grant);
  }
  return { access_token: grant.access_token, refresh_token: grant.refresh_token };
}

/**
 * Mobile password login, via the Android app's OAuth client. Also captcha-free.
 * Returns a 7-day access token and a long-lived rotating refresh token.
 */
export async function mobileLogin(
  email: string,
  password: string,
): Promise<{ access_token: string; refresh_token?: string }> {
  const { id, secret } = mobileClient();
  const basic = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  const req = await post<{ request_token?: string }>(`${OAUTH}/request-token`, {
    headers: { authorization: basic, client: id, apiversion: "4" },
  });
  if (!req?.request_token) {
    throw new MoneyLoverError("request-token failed", undefined, req);
  }
  const grant = await post<{ status?: boolean; access_token?: string; refresh_token?: string }>(
    `${OAUTH}/token`,
    {
      headers: { authorization: `Bearer ${req.request_token}`, client: id, apiversion: "4" },
      body: {
        email,
        password,
        grant_type: "password",
        did: "moneylover-kit",
        na: "moneylover-kit",
        v: MOBILE_APPVERSION,
        pl: 1,
        lang: "en",
        aid: 1,
        script: "kb0",
      },
    },
  );
  if (!grant?.status || !grant.access_token) {
    throw new MoneyLoverError("mobile login failed", undefined, grant);
  }
  return { access_token: grant.access_token, refresh_token: grant.refresh_token };
}

export interface AuthOptions {
  backend: BackendName;
  email?: string;
  password?: string;
  /** Use this token verbatim and never log in. */
  token?: string;
  /** Ignore any cached token and mint a fresh one. Registers a device. */
  force?: boolean;
  /** Fail instead of logging in when there's no usable cached token. */
  noLogin?: boolean;
}

/**
 * A token belongs to one API, not both.
 *
 * The two clients issue separate tokens and each rejects the other's, so a
 * single `MONEYLOVER_ACCESS_TOKEN` cannot serve a client that talks to both.
 * `MONEYLOVER_WEB_TOKEN` and `MONEYLOVER_MOBILE_TOKEN` are checked first; the
 * generic one is a convenience for the single-backend case.
 */
function fromEnv(options: AuthOptions): AuthOptions {
  const specific =
    options.backend === "mobile"
      ? process.env.MONEYLOVER_MOBILE_TOKEN
      : process.env.MONEYLOVER_WEB_TOKEN;
  return {
    ...options,
    email: options.email ?? process.env.MONEYLOVER_EMAIL,
    password: options.password ?? process.env.MONEYLOVER_PASSWORD,
    token: options.token ?? specific ?? process.env.MONEYLOVER_ACCESS_TOKEN,
  };
}

/**
 * Get a usable access token, logging in only if there isn't one.
 *
 * ## Why the caching is not an optimisation
 *
 * A Money Lover account allows a fixed number of devices to hold a token at
 * once — five, at the time of writing — and **every login registers another
 * one**. Nothing is evicted when you hit the limit: the new login is simply
 * refused, with "Maximum device limit reached. Please log out to continue."
 *
 * So burning slots doesn't lose you data, it locks you out — including out of
 * signing in on a new phone, until you log out somewhere else. Hence the token
 * is cached on disk and reused until it expires. Logging in per process, per
 * container start, or per tool call would exhaust the slots for no reason.
 */
/** Refreshes in flight, so concurrent callers share one renewal. */
const renewals = new Map<string, Promise<string>>();

/**
 * Get a usable access token, renewing it without human involvement.
 *
 * ## The device budget is why this is careful
 *
 * An account allows a fixed number of devices to hold a token — five, reported
 * as `limitDevice` — and **every login registers another**. Once they are used
 * up Money Lover refuses further logins until you sign out somewhere. A server
 * that logged in weekly would exhaust the account in about a month; verified
 * against a live account, a repeat login creates a new `tokenDevice` even when
 * the same `did` is sent, so there is no way to pin a slot.
 *
 * So renewal is ordered by what it costs:
 *
 *   1. an explicit token, if it has not expired — a *seed*, not an override,
 *      or a stale one could never be recovered from
 *   2. the cached token, if it has not expired
 *   3. refresh. Costs nothing: the renewed token keeps the same registered
 *      device, and the refresh token rotates so this continues forever
 *   4. a login, which spends a device slot
 */
export async function accessToken(options: AuthOptions): Promise<string> {
  const opts = fromEnv(options);
  const supplied = opts.token;

  // A supplied token is a seed: honoured unless demonstrably stale, so an
  // opaque token still works and an expired one can still be recovered from.
  if (supplied && !definitelyExpired(supplied)) return supplied;

  if (!opts.email || !opts.password) {
    if (supplied) {
      throw new MoneyLoverError(
        "The supplied token has expired and there are no credentials to renew it.\n" +
          "Set MONEYLOVER_EMAIL and MONEYLOVER_PASSWORD so it can renew itself.",
      );
    }
    throw new MoneyLoverError(
      "No credentials. Set MONEYLOVER_EMAIL and MONEYLOVER_PASSWORD, or pass\n" +
        "MONEYLOVER_ACCESS_TOKEN to skip logging in entirely.",
    );
  }

  const path = cachePath(opts.backend, opts.email);
  const inFlight = renewals.get(path);
  if (inFlight) return inFlight;

  const renewal = renew(opts, path, supplied).finally(() => renewals.delete(path));
  renewals.set(path, renewal);
  return renewal;
}

async function renew(opts: AuthOptions, path: string, supplied?: string): Promise<string> {
  const cached = readCache(path);

  if (!opts.force && cached && !expired(cached.access_token)) return cached.access_token;

  // Seed the cache from a supplied token's refresh token if that is all we have.
  const refreshToken = cached?.refresh_token;

  if (!opts.force && refreshToken) {
    try {
      const grant =
        opts.backend === "mobile"
          ? await mobileRefresh(refreshToken)
          : await webRefresh(refreshToken);
      writeCache(path, { ...grant, email: opts.email as string });
      return grant.access_token;
    } catch (err) {
      if (opts.backend === "mobile") throw err;
      // Refresh tokens can be revoked. Fall through to a login rather than
      // failing: that costs a device slot, but it is recoverable and a hard
      // failure is not.
    }
  }

  if (opts.noLogin) {
    throw new MoneyLoverError(
      `Cannot renew the ${opts.backend} token without logging in, and that is disabled.\n` +
        `Run \`moneylover login --backend ${opts.backend}\`.`,
    );
  }

  if (opts.backend === "mobile" && supplied) {
    throw new MoneyLoverError(
      "The supplied mobile token has expired and there is no cached refresh token.\n" +
        "Remove MONEYLOVER_MOBILE_TOKEN, run `moneylover login --backend mobile` once,\n" +
        "and keep the token cache so future renewals reuse the same device.",
    );
  }

  const grant =
    opts.backend === "mobile"
      ? await mobileLogin(opts.email as string, opts.password as string)
      : await webLogin(opts.email as string, opts.password as string);

  writeCache(path, { ...grant, email: opts.email as string });
  return grant.access_token;
}

/** Where a backend's token for this account is cached. Useful in errors and docs. */
export function tokenLocation(backend: BackendName, email: string): string {
  return cachePath(backend, email);
}
