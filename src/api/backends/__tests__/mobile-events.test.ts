import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEvents } from "../mobile/events.js";

describe("addEvent", () => {
  it("creates a campaign with an end date", async () => {
    const pushes: { kind: string; items: Record<string, unknown>[] }[] = [];
    const api = createEvents({
      events: async () => [],
      push: async (kind, items) => {
        pushes.push({ kind, items: items as Record<string, unknown>[] });
        return items.length;
      },
    });
    const id = await api.addEvent({ name: "Japan", endDate: "2026-11-09", currencyId: 11 });
    assert.equal(pushes[0]?.kind, "campaign");
    assert.deepEqual(pushes[0]?.items[0], {
      gid: id,
      n: "Japan",
      ic: "icon_5",
      sa: 0,
      ga: 0,
      t: 6,
      s: true,
      ed: "2026-11-09T00:00:00.000Z",
      ci: 11,
      f: 1,
      version: 0,
    });
  });

  it("refuses a duplicate name", async () => {
    const api = createEvents({
      events: async () => [{ id: "e1", name: "Japan" }],
      push: async () => 0,
    });
    await assert.rejects(
      () => api.addEvent({ name: "japan", endDate: "2026-11-09", currencyId: 11 }),
      /already exists/,
    );
  });

  it("requires an ISO calendar date", async () => {
    const api = createEvents({ events: async () => [], push: async () => 0 });
    await assert.rejects(
      () => api.addEvent({ name: "Japan", endDate: "09/11/2026", currencyId: 11 }),
      /YYYY-MM-DD/,
    );
  });
});
