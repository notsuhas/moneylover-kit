/**
 * Authentication for both APIs, and the token cache that keeps it to one login.
 *
 * Read the device warning below before changing anything here.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type BackendName, MoneyLoverError } from "../core/types.js";
import { post } from "./http.js";

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
        "See docs/api.md for what they are and how to obtain them, or use the\n" +
        "default web backend, which needs nothing but your email and password.",
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
  // 0600: this token is equivalent to the account password for reads and writes.
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** True when the JWT is absent, unparseable, or within a minute of expiry. */
function expired(jwt: string | undefined): boolean {
  if (!jwt) return true;
  try {
    const body = jwt.split(".")[1];
    if (!body) return true;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { exp?: number };
    if (!claims.exp) return false;
    return claims.exp - 60 < Date.now() / 1000;
  } catch {
    return true;
  }
}

/**
 * Web password login. No captcha, despite what you may read elsewhere.
 *
 * The browser posts to `oauth.moneylover.me/web/token` with an invisible
 * `g-recaptcha-response`, which cannot be scripted. This is a *different*
 * endpoint — plain `/token`, form-encoded, with the client id from the login
 * URL — and it has no captcha at all.
 */
export async function webLogin(email: string, password: string): Promise<string> {
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

  const grant = await post<{ access_token?: string; message?: string }>(`${OAUTH}/token`, {
    headers: { authorization: `Bearer ${requestToken}`, client },
    form: { email, password },
  });
  if (!grant?.access_token) {
    throw new MoneyLoverError(grant?.message ?? "web login failed", undefined, grant);
  }
  return grant.access_token;
}

/**
 * Mobile password login, via the Android app's OAuth client. Also captcha-free.
 * Returns a 7-day access token and a long-lived refresh token — though the
 * refresh grant is not usable, see docs/traps.md.
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

function fromEnv(options: AuthOptions): AuthOptions {
  return {
    ...options,
    email: options.email ?? process.env.MONEYLOVER_EMAIL,
    password: options.password ?? process.env.MONEYLOVER_PASSWORD,
    token: options.token ?? process.env.MONEYLOVER_ACCESS_TOKEN,
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
export async function accessToken(options: AuthOptions): Promise<string> {
  const opts = fromEnv(options);
  if (opts.token) return opts.token;

  if (!opts.email || !opts.password) {
    throw new MoneyLoverError(
      "No credentials. Set MONEYLOVER_EMAIL and MONEYLOVER_PASSWORD, or pass\n" +
        "MONEYLOVER_ACCESS_TOKEN to skip logging in entirely.",
    );
  }

  const path = cachePath(opts.backend, opts.email);
  if (!opts.force) {
    const hit = readCache(path);
    if (hit && !expired(hit.access_token)) return hit.access_token;
    if (hit && opts.noLogin) {
      throw new MoneyLoverError(
        `Cached ${opts.backend} token has expired. Run \`moneylover login\` to mint a new one.\n` +
          "That registers a device, and an account allows only a few at once.",
      );
    }
  }
  if (opts.noLogin) {
    throw new MoneyLoverError(
      `No cached ${opts.backend} token. Run \`moneylover login\` first.\n` +
        "That registers a device, and an account allows only a few at once.",
    );
  }

  const grant =
    opts.backend === "mobile"
      ? await mobileLogin(opts.email, opts.password)
      : { access_token: await webLogin(opts.email, opts.password) };

  writeCache(path, { ...grant, email: opts.email });
  return grant.access_token;
}

/** Where a backend's token for this account is cached. Useful in errors and docs. */
export function tokenLocation(backend: BackendName, email: string): string {
  return cachePath(backend, email);
}
