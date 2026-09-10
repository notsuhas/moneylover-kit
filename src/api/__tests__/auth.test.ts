import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MoneyLoverError } from "../../core/types.js";
import { accessToken, mobileLogin, tokenLocation, webLogin } from "../auth.js";

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

/** A JWT with a real `exp`, so expiry logic can be exercised. */
function jwt(expSecondsFromNow: number): string {
  const body = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString("base64url");
  return `header.${body}.signature`;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function stubFetch(routes: Record<string, unknown>) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const hit = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (!hit) throw new Error(`unstubbed request: ${url}`);
    return json(hit[1]);
  }) as typeof fetch;
  return seen;
}

beforeEach(() => {
  process.env = { ...realEnv };
  process.env.MONEYLOVER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "mlkit-"));
  delete process.env.MONEYLOVER_EMAIL;
  delete process.env.MONEYLOVER_PASSWORD;
  delete process.env.MONEYLOVER_ACCESS_TOKEN;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
});

const WEB_ROUTES = {
  "/user/login-url": {
    data: { request_token: "rt", login_url: "https://oauth.moneylover.me/auth?client=WEBCLIENT" },
  },
  "oauth.moneylover.me/token": { access_token: "web-token" },
};

describe("tokenLocation", () => {
  it("separates backends, so one expiring does not disturb the other", () => {
    const web = tokenLocation("web", "a@b.c");
    const mobile = tokenLocation("mobile", "a@b.c");
    assert.notEqual(web, mobile);
    assert.match(web, /web-/);
    assert.match(mobile, /mobile-/);
  });

  it("hashes the address rather than putting it in a filename", () => {
    assert.doesNotMatch(tokenLocation("web", "a@b.c"), /a@b\.c/);
  });

  it("is stable for the same account and case-insensitive", () => {
    assert.equal(tokenLocation("web", "A@B.C"), tokenLocation("web", "a@b.c"));
  });
});

describe("webLogin", () => {
  it("takes the client id out of the login URL and posts the credentials", async () => {
    const seen = stubFetch(WEB_ROUTES);
    assert.equal(await webLogin("a@b.c", "pw"), "web-token");
    assert.ok(seen.some((u) => u.includes("/user/login-url")));
    assert.ok(seen.some((u) => u.includes("oauth.moneylover.me/token")));
  });

  it("fails clearly when no request token comes back", async () => {
    stubFetch({ "/user/login-url": { data: {} } });
    await assert.rejects(() => webLogin("a@b.c", "pw"), MoneyLoverError);
  });

  it("fails when the login URL carries no client parameter", async () => {
    stubFetch({
      "/user/login-url": { data: { request_token: "rt", login_url: "https://oauth.test/auth" } },
    });
    await assert.rejects(() => webLogin("a@b.c", "pw"), /client parameter/);
  });

  it("surfaces the server's message when credentials are refused", async () => {
    stubFetch({ ...WEB_ROUTES, "oauth.moneylover.me/token": { message: "wrong password" } });
    await assert.rejects(() => webLogin("a@b.c", "pw"), /wrong password/);
  });
});

describe("mobileLogin", () => {
  const routes = {
    "/request-token": { request_token: "rt" },
    "oauth.moneylover.me/token": { status: true, access_token: "m-token", refresh_token: "r" },
  };

  it("refuses to run without the app's OAuth client, and says how to set it", async () => {
    stubFetch(routes);
    await assert.rejects(
      () => mobileLogin("a@b.c", "pw"),
      /MONEYLOVER_MOBILE_CLIENT and MONEYLOVER_MOBILE_SECRET/,
    );
  });

  it("returns both tokens when the client is configured", async () => {
    process.env.MONEYLOVER_MOBILE_CLIENT = "id";
    process.env.MONEYLOVER_MOBILE_SECRET = "secret";
    stubFetch(routes);
    assert.deepEqual(await mobileLogin("a@b.c", "pw"), {
      access_token: "m-token",
      refresh_token: "r",
    });
  });

  it("treats status:false as a failure even though HTTP was 200", async () => {
    process.env.MONEYLOVER_MOBILE_CLIENT = "id";
    process.env.MONEYLOVER_MOBILE_SECRET = "secret";
    stubFetch({ ...routes, "oauth.moneylover.me/token": { status: false } });
    await assert.rejects(() => mobileLogin("a@b.c", "pw"), /mobile login failed/);
  });
});

describe("accessToken", () => {
  it("uses an explicit token and never contacts the network", async () => {
    globalThis.fetch = (() => {
      throw new Error("should not be called");
    }) as typeof fetch;
    assert.equal(await accessToken({ backend: "web", token: "given" }), "given");
  });

  it("reads MONEYLOVER_ACCESS_TOKEN from the environment", async () => {
    process.env.MONEYLOVER_ACCESS_TOKEN = "from-env";
    assert.equal(await accessToken({ backend: "web" }), "from-env");
  });

  it("explains what to set when there are no credentials at all", async () => {
    await assert.rejects(
      () => accessToken({ backend: "web" }),
      /MONEYLOVER_EMAIL and MONEYLOVER_PASSWORD/,
    );
  });

  /** The point of the cache: one login, not one per process. */
  it("logs in once and reuses the cached token", async () => {
    process.env.MONEYLOVER_EMAIL = "a@b.c";
    process.env.MONEYLOVER_PASSWORD = "pw";
    const fresh = jwt(3600);
    let logins = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/user/login-url")) {
        return json({
          data: { request_token: "rt", login_url: "https://o.test/auth?client=C" },
        });
      }
      logins += 1;
      return json({ access_token: fresh });
    }) as typeof fetch;

    assert.equal(await accessToken({ backend: "web" }), fresh);
    assert.equal(await accessToken({ backend: "web" }), fresh);
    assert.equal(logins, 1, "second call must not log in again");
  });

  it("writes the cache with owner-only permissions", async () => {
    process.env.MONEYLOVER_EMAIL = "a@b.c";
    process.env.MONEYLOVER_PASSWORD = "pw";
    stubFetch({ ...WEB_ROUTES, "oauth.moneylover.me/token": { access_token: jwt(3600) } });
    await accessToken({ backend: "web" });
    const path = tokenLocation("web", "a@b.c");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).email, "a@b.c");
  });

  it("logs in again once the cached token has expired", async () => {
    process.env.MONEYLOVER_EMAIL = "a@b.c";
    process.env.MONEYLOVER_PASSWORD = "pw";
    stubFetch({ ...WEB_ROUTES, "oauth.moneylover.me/token": { access_token: jwt(-10) } });
    await accessToken({ backend: "web" });

    const fresh = jwt(3600);
    stubFetch({ ...WEB_ROUTES, "oauth.moneylover.me/token": { access_token: fresh } });
    assert.equal(await accessToken({ backend: "web" }), fresh);
  });

  it("force ignores a perfectly good cached token", async () => {
    process.env.MONEYLOVER_EMAIL = "a@b.c";
    process.env.MONEYLOVER_PASSWORD = "pw";
    stubFetch({ ...WEB_ROUTES, "oauth.moneylover.me/token": { access_token: jwt(3600) } });
    await accessToken({ backend: "web" });

    const second = jwt(7200);
    stubFetch({ ...WEB_ROUTES, "oauth.moneylover.me/token": { access_token: second } });
    assert.equal(await accessToken({ backend: "web", force: true }), second);
  });

  /** noLogin exists so a long-running server never spends a device slot. */
  it("noLogin refuses to log in when there is no cache", async () => {
    process.env.MONEYLOVER_EMAIL = "a@b.c";
    process.env.MONEYLOVER_PASSWORD = "pw";
    await assert.rejects(() => accessToken({ backend: "web", noLogin: true }), /moneylover login/);
  });

  it("treats a token with no exp claim as usable", async () => {
    process.env.MONEYLOVER_EMAIL = "a@b.c";
    process.env.MONEYLOVER_PASSWORD = "pw";
    const opaque = `h.${Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url")}.s`;
    stubFetch({ ...WEB_ROUTES, "oauth.moneylover.me/token": { access_token: opaque } });
    await accessToken({ backend: "web" });
    globalThis.fetch = (() => {
      throw new Error("should not log in again");
    }) as typeof fetch;
    assert.equal(await accessToken({ backend: "web" }), opaque);
  });
});

describe("token cache permissions", () => {
  /** `mode` applies on creation only; an existing loose file stays loose. */
  it("repairs permissions when overwriting an existing cache", async () => {
    process.env.MONEYLOVER_EMAIL = "a@b.c";
    process.env.MONEYLOVER_PASSWORD = "pw";
    stubFetch({ ...WEB_ROUTES, "oauth.moneylover.me/token": { access_token: jwt(3600) } });
    await accessToken({ backend: "web" });

    const path = tokenLocation("web", "a@b.c");
    chmodSync(path, 0o644);
    assert.equal(statSync(path).mode & 0o777, 0o644, "loosened for the test");

    stubFetch({ ...WEB_ROUTES, "oauth.moneylover.me/token": { access_token: jwt(7200) } });
    await accessToken({ backend: "web", force: true });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});
