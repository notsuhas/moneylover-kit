/**
 * Routing.
 *
 * The two APIs are not equivalent and neither is a superset, so the client
 * composes both and sends each operation to whichever can do it. These cases
 * pin the routing table down, including how it degrades when only one API is
 * configured.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MOBILE_CAN, WEB_CAN } from "../../../core/__tests__/fixtures.js";
import type { Backend, Capabilities } from "../../../core/types.js";
import { MoneyLoverError } from "../../../core/types.js";
import { createCompositeBackend, describeRouting } from "../composite.js";

/** A backend that records which of its methods were called. */
function spy(name: "web" | "mobile", can: Capabilities) {
  const calls: string[] = [];
  const note =
    <T>(op: string, value: T) =>
    async () => {
      calls.push(op);
      return value;
    };
  const backend: Backend = {
    name,
    can,
    account: note("account", { id: name, email: `${name}@test`, deviceLimit: 5 }),
    wallets: note("wallets", []),
    categories: note("categories", []),
    transactions: note("transactions", []),
    ...(can.events ? { events: note("events", []) } : {}),
    ...(can.labels ? { labels: note("labels", []) } : {}),
    addTransaction: async () => {
      calls.push("addTransaction");
      return name;
    },
    editTransaction: async () => void calls.push("editTransaction"),
    deleteTransaction: async () => void calls.push("deleteTransaction"),
    ...(can.batchWrites
      ? {
          retagTransactions: async (plan: unknown[]) => {
            calls.push("retagTransactions");
            return plan.length;
          },
        }
      : {}),
    ...(can.wallets
      ? {
          addWallet: async () => {
            calls.push("addWallet");
            return name;
          },
          editWallet: async () => void calls.push("editWallet"),
          deleteWallet: async () => void calls.push("deleteWallet"),
        }
      : {}),
    addCategory: async () => {
      calls.push("addCategory");
      return name;
    },
    editCategory: async () => void calls.push("editCategory"),
    deleteCategory: async () => void calls.push("deleteCategory"),
  };
  return { backend, calls };
}

function both() {
  const web = spy("web", WEB_CAN);
  const mobile = spy("mobile", MOBILE_CAN);
  return {
    web,
    mobile,
    composite: createCompositeBackend({ web: web.backend, mobile: mobile.backend }),
  };
}

describe("createCompositeBackend — reads", () => {
  it("takes wallets from web, the only source of balances", async () => {
    const { web, mobile, composite } = both();
    await composite.wallets();
    assert.deepEqual(web.calls, ["wallets"]);
    assert.deepEqual(mobile.calls, []);
  });

  it("takes transactions from web — one request instead of paginated pulls", async () => {
    const { web, mobile, composite } = both();
    await composite.transactions();
    assert.deepEqual(web.calls, ["transactions"]);
    assert.deepEqual(mobile.calls, []);
  });

  /**
   * Transaction rows reference per-wallet category ids on *both* APIs, and
   * those are mobile's ids. Web's `category/list-all` returns a different,
   * global set that matches no transaction.
   */
  it("takes categories from mobile, whose ids transactions actually use", async () => {
    const { web, mobile, composite } = both();
    await composite.categories();
    assert.deepEqual(mobile.calls, ["categories"]);
    assert.deepEqual(web.calls, []);
  });

  it("takes events and labels from mobile — web has neither", async () => {
    const { mobile, composite } = both();
    await composite.events?.();
    await composite.labels?.();
    assert.deepEqual(mobile.calls, ["events", "labels"]);
  });
});

describe("createCompositeBackend — writes", () => {
  /**
   * Single writes go to web so the read the search already paid for is reused;
   * routing them to mobile meant a second 45-page pull and a 30s+ edit.
   */
  it("sends single transaction writes to web", async () => {
    const { web, mobile, composite } = both();
    await composite.addTransaction({ wallet: "w", category: "c", amount: -1 });
    await composite.editTransaction("t", { note: "x" });
    await composite.deleteTransaction("t");
    assert.deepEqual(web.calls, ["addTransaction", "editTransaction", "deleteTransaction"]);
    assert.deepEqual(mobile.calls, []);
  });

  /** Batching 50 items per request is worth the one-off read. */
  it("sends a bulk retag to mobile, where batching pays for itself", async () => {
    const { web, mobile, composite } = both();
    await composite.retagTransactions?.([{ id: "t", category: "c" }]);
    assert.deepEqual(mobile.calls, ["retagTransactions"]);
    assert.deepEqual(web.calls, []);
  });

  it("sends wallet writes to web, the only one whose payloads are known", async () => {
    const { web, mobile, composite } = both();
    await composite.addWallet?.({ name: "W", currencyId: 11 });
    await composite.editWallet?.("w", { name: "W2" });
    await composite.deleteWallet?.("w");
    assert.deepEqual(web.calls, ["addWallet", "editWallet", "deleteWallet"]);
    assert.deepEqual(mobile.calls, []);
  });

  it("sends category writes to mobile, which writes both layers", async () => {
    const { web, mobile, composite } = both();
    await composite.addCategory?.({ name: "C", type: "expense", wallet: "w" });
    assert.deepEqual(mobile.calls, ["addCategory"]);
    assert.deepEqual(web.calls, []);
  });
});

describe("createCompositeBackend — degrading to one API", () => {
  it("falls back to web for reads when mobile is absent", async () => {
    const web = spy("web", WEB_CAN);
    const composite = createCompositeBackend({ web: web.backend });
    await composite.categories();
    await composite.transactions();
    assert.deepEqual(web.calls, ["categories", "transactions"]);
  });

  it("reports labels and events as unavailable rather than pretending", async () => {
    const web = spy("web", WEB_CAN);
    const composite = createCompositeBackend({ web: web.backend });
    assert.equal(composite.can.labels, false);
    assert.equal(composite.can.events, false);
    assert.deepEqual(await composite.labels?.(), []);
    assert.deepEqual(await composite.events?.(), []);
  });

  it("names the missing API and how to configure it", async () => {
    const mobile = spy("mobile", MOBILE_CAN);
    const composite = createCompositeBackend({ mobile: mobile.backend });
    await assert.rejects(
      async () => composite.addWallet?.({ name: "W", currencyId: 11 }),
      /needs the web backend/,
    );
  });

  it("routes an all-wallet category to mobile even if web could make a plain one", async () => {
    const web = spy("web", WEB_CAN);
    const composite = createCompositeBackend({ web: web.backend });
    await assert.rejects(
      async () => composite.addCategory?.({ name: "C", type: "expense" }),
      /needs the mobile backend/,
    );
  });

  it("falls back to web for transaction writes when mobile is absent", async () => {
    const web = spy("web", WEB_CAN);
    const composite = createCompositeBackend({ web: web.backend });
    await composite.addTransaction({ wallet: "w", category: "c", amount: -1 });
    assert.deepEqual(web.calls, ["addTransaction"]);
  });

  it("refuses to be built with nothing", () => {
    assert.throws(() => createCompositeBackend({}), MoneyLoverError);
  });
});

describe("describeRouting", () => {
  it("reports where each call goes with both configured", () => {
    const web = spy("web", WEB_CAN);
    const mobile = spy("mobile", MOBILE_CAN);
    const routing = describeRouting({ web: web.backend, mobile: mobile.backend });
    assert.equal(routing.wallets, "web");
    assert.equal(routing.categories, "mobile");
    assert.equal(routing.transactionWrites, "web");
    assert.equal(routing.batchedWrites, "mobile");
    assert.equal(routing.walletWrites, "web");
  });

  it("marks the mobile-only calls unavailable with web alone", () => {
    const web = spy("web", WEB_CAN);
    const routing = describeRouting({ web: web.backend });
    assert.equal(routing.labels, "unavailable");
    assert.equal(routing.events, "unavailable");
    assert.equal(routing.transactionWrites, "web");
  });
});

describe("createCompositeBackend — mobile failing over to web", () => {
  /** A mobile token cannot be refreshed, so failure has to degrade, not error. */
  function failingMobile() {
    const mobile = spy("mobile", MOBILE_CAN);
    const broken: Backend = {
      ...mobile.backend,
      categories: async () => {
        throw new Error("e:717 token_device_not_found");
      },
      addTransaction: async () => {
        throw new Error("e:717 token_device_not_found");
      },
      events: async () => {
        throw new Error("e:717 token_device_not_found");
      },
      labels: async () => {
        throw new Error("e:717 token_device_not_found");
      },
    };
    const web = spy("web", WEB_CAN);
    return { web, composite: createCompositeBackend({ web: web.backend, mobile: broken }) };
  }

  const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
    const real = console.error;
    console.error = () => {};
    try {
      return await run();
    } finally {
      console.error = real;
    }
  };

  it("serves categories from web when mobile's token is rejected", async () => {
    const { web, composite } = failingMobile();
    await quiet(() => composite.categories());
    assert.deepEqual(web.calls, ["categories"]);
  });

  it("keeps transaction writes working — they were already on web", async () => {
    const { web, composite } = failingMobile();
    await quiet(() => composite.addTransaction({ wallet: "w", category: "c", amount: -1 }));
    assert.deepEqual(web.calls, ["addTransaction"]);
  });

  /** Web has no route for these at all, so empty is the honest answer. */
  it("returns empty for events and labels rather than throwing", async () => {
    const { composite } = failingMobile();
    assert.deepEqual(await quiet(() => composite.events?.() ?? Promise.resolve([])), []);
    assert.deepEqual(await quiet(() => composite.labels?.() ?? Promise.resolve([])), []);
  });

  it("stops retrying mobile once it is known bad", async () => {
    const { web, composite } = failingMobile();
    await quiet(() => composite.categories());
    await quiet(() => composite.categories());
    assert.deepEqual(web.calls, ["categories", "categories"]);
  });

  /** A real bug must not be mistaken for an expired token. */
  it("does not swallow a non-auth error", async () => {
    const mobile = spy("mobile", MOBILE_CAN);
    const broken: Backend = {
      ...mobile.backend,
      categories: async () => {
        throw new Error("something genuinely wrong");
      },
    };
    const web = spy("web", WEB_CAN);
    const composite = createCompositeBackend({ web: web.backend, mobile: broken });
    await assert.rejects(() => composite.categories(), /something genuinely wrong/);
    assert.deepEqual(web.calls, [], "must not retry a genuine error on the other API");
  });
});
