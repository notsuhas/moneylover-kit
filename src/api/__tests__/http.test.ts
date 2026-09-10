import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { MoneyLoverError } from "../../core/types.js";
import { post, unwrap } from "../http.js";

/** Replace fetch for one test; every case restores it afterwards. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.reset();
});

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("post", () => {
  it("sends JSON with a browser User-Agent, because Cloudflare blocks others", async () => {
    const calls = stubFetch(() => ok({ error: 0 }));
    await post("https://example.test/x", { body: { a: 1 } });
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.match(headers["user-agent"] ?? "", /Mozilla/);
    assert.equal(headers["content-type"], "application/json; charset=utf-8");
    assert.equal(calls[0]?.init.body, '{"a":1}');
  });

  it("form-encodes when asked, which the web login requires", async () => {
    const calls = stubFetch(() => ok({}));
    await post("https://example.test/token", { form: { email: "a@b.c", password: "p w" } });
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(calls[0]?.init.body, "email=a%40b.c&password=p+w");
  });

  it("defaults the body to an empty object", async () => {
    const calls = stubFetch(() => ok({}));
    await post("https://example.test/x");
    assert.equal(calls[0]?.init.body, "{}");
  });

  it("merges caller headers over the defaults", async () => {
    const calls = stubFetch(() => ok({}));
    await post("https://example.test/x", { headers: { authorization: "Bearer t" } });
    const first = calls[0];
    assert.ok(first, "expected one request");
    assert.equal((first.init.headers as Record<string, string>).authorization, "Bearer t");
  });

  it("returns an empty object for an empty body rather than failing to parse", async () => {
    stubFetch(() => new Response("", { status: 200 }));
    assert.deepEqual(await post("https://example.test/x"), {});
  });

  it("raises a MoneyLoverError on a non-JSON body", async () => {
    stubFetch(() => new Response("<html>nope</html>", { status: 200 }));
    await assert.rejects(() => post("https://example.test/x"), MoneyLoverError);
  });

  it("raises on a 4xx without retrying", async () => {
    const calls = stubFetch(() => new Response("bad", { status: 400 }));
    await assert.rejects(() => post("https://example.test/x", { attempts: 3 }), MoneyLoverError);
    assert.equal(calls.length, 1);
  });

  it("retries a 429 and succeeds", async () => {
    let n = 0;
    stubFetch(() => (++n === 1 ? new Response("slow down", { status: 429 }) : ok({ error: 0 })));
    assert.deepEqual(await post("https://example.test/x", { attempts: 3 }), { error: 0 });
    assert.equal(n, 2);
  });

  /**
   * fetch *throws* on a reset connection rather than returning a response, so
   * a retry that only inspects res.status misses it entirely.
   */
  it("retries a thrown network error", async () => {
    let n = 0;
    stubFetch(() => {
      if (++n === 1) throw new TypeError("fetch failed");
      return ok({ error: 0 });
    });
    assert.deepEqual(await post("https://example.test/x", { attempts: 3 }), { error: 0 });
    assert.equal(n, 2);
  });

  it("gives up after the last attempt", async () => {
    const calls = stubFetch(() => new Response("boom", { status: 500 }));
    await assert.rejects(() => post("https://example.test/x", { attempts: 2 }), MoneyLoverError);
    assert.equal(calls.length, 2);
  });
});

describe("unwrap", () => {
  it("returns the data on success", () => {
    assert.deepEqual(unwrap<{ a: number }>({ error: 0, data: { a: 1 } }), { a: 1 });
  });

  it("throws on a non-zero error", () => {
    assert.throws(() => unwrap({ error: 1, msg: "nope" }), /nope/);
  });

  /** A rejected token uses abbreviated keys, so code reading `error` misses it. */
  it("throws on the abbreviated rejected-token shape", () => {
    assert.throws(
      () => unwrap({ s: false, e: 706, msg: "Oauth expire" }),
      (err: unknown) => err instanceof MoneyLoverError && err.code === 706,
    );
  });

  it("carries the code and the raw payload for debugging", () => {
    try {
      unwrap({ error: 717, msg: "token_device_not_found" });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof MoneyLoverError);
      assert.equal(err.code, 717);
      assert.deepEqual(err.detail, { error: 717, msg: "token_device_not_found" });
    }
  });

  /**
   * A missing Authorization header returns a *successful* envelope with no
   * data. Silent, and not distinguishable here — hence the null.
   */
  it("returns null for the silent empty-data shape", () => {
    assert.equal(unwrap({ error: 0 }), null);
  });

  it("falls back to a generic message when none is given", () => {
    assert.throws(() => unwrap({ error: 5 }), /Money Lover API error/);
  });
});
