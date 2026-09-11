import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCache } from "../cache.js";

describe("createCache", () => {
  it("loads once and reuses the result", async () => {
    const cache = createCache(60);
    let loads = 0;
    const load = async () => ++loads;
    assert.equal(await cache.read("k", load), 1);
    assert.equal(await cache.read("k", load), 1);
    assert.equal(loads, 1);
  });

  it("keeps keys apart", async () => {
    const cache = createCache(60);
    assert.equal(await cache.read("a", async () => "A"), "A");
    assert.equal(await cache.read("b", async () => "B"), "B");
  });

  it("loads every time when disabled", async () => {
    const cache = createCache(0);
    let loads = 0;
    const load = async () => ++loads;
    await cache.read("k", load);
    await cache.read("k", load);
    assert.equal(loads, 2);
  });

  it("reloads after the entry expires", async () => {
    const cache = createCache(-1);
    let loads = 0;
    const load = async () => ++loads;
    await cache.read("k", load);
    await cache.read("k", load);
    assert.equal(loads, 2);
  });

  it("drops named keys and leaves the rest", async () => {
    const cache = createCache(60);
    let a = 0;
    let b = 0;
    await cache.read("a", async () => ++a);
    await cache.read("b", async () => ++b);
    cache.drop("a");
    await cache.read("a", async () => ++a);
    await cache.read("b", async () => ++b);
    assert.equal(a, 2, "a reloaded");
    assert.equal(b, 1, "b was untouched");
  });

  /** Caching the promise, not the value, means concurrent readers share one load. */
  it("shares one in-flight load between concurrent readers", async () => {
    const cache = createCache(60);
    let loads = 0;
    const slow = async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 10));
      return loads;
    };
    const [x, y] = await Promise.all([cache.read("k", slow), cache.read("k", slow)]);
    assert.equal(loads, 1);
    assert.equal(x, y);
  });
});
