import { randomUUID } from "node:crypto";
import type { Event, NewEvent } from "../../../core/types.js";
import { MoneyLoverError } from "../../../core/types.js";
import type { Sync } from "./sync.js";

const DEFAULT_ICON = "icon_5";

interface CampaignItem {
  gid: string;
  n: string;
  ic: string;
  sa: number;
  ga: number;
  t: 6;
  s: true;
  ed: string;
  ci: number;
  f: 1;
  version: 0;
}

export interface EventDeps {
  push: Sync["push"];
  events: () => Promise<Event[]>;
}

export function createEvents({ push, events }: EventDeps) {
  return {
    async addEvent(input: NewEvent): Promise<string> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
        throw new MoneyLoverError("endDate must use YYYY-MM-DD");
      }
      if ((await events()).some((event) => event.name.toLowerCase() === input.name.toLowerCase())) {
        throw new MoneyLoverError(`an event named ${JSON.stringify(input.name)} already exists`);
      }
      const id = randomUUID().replace(/-/g, "");
      await push("campaign", [
        {
          gid: id,
          n: input.name,
          ic: input.icon ?? DEFAULT_ICON,
          sa: 0,
          ga: 0,
          t: 6,
          s: true,
          ed: `${input.endDate}T00:00:00.000Z`,
          ci: input.currencyId,
          f: 1,
          version: 0,
        } satisfies CampaignItem,
      ]);
      return id;
    },
  };
}
