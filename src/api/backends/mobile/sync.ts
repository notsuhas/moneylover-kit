/**
 * The mobile sync transport: authenticated POSTs, paginated pulls, batched
 * pushes. Separate from the CRUD mapping because this is where the protocol
 * lives — how a request is framed and how a failure is surfaced — and it
 * changes for entirely different reasons than the field mapping does.
 */

import { MoneyLoverError } from "../../../core/types.js";
import { type AuthOptions, MOBILE_APPVERSION as AV, accessToken } from "../../auth.js";
import { post } from "../../http.js";

const API = "https://revoapi.moneylover.me";
const PAGE = 250;
const BATCH = 50;

export type PushKind = "transaction" | "category" | "label";

export interface Sync {
  call<T>(path: string, body?: unknown): Promise<T>;
  /** Drain a paginated pull endpoint. */
  pull<T>(path: string): Promise<T[]>;
  /** Push items in batches; raises anything the server rejected. */
  push(kind: PushKind, items: unknown[]): Promise<number>;
  /** The first page of a pull, for endpoints that never paginate. */
  page<T>(path: string): Promise<T[]>;
}

export function createSync(auth: Omit<AuthOptions, "backend">): Sync {
  const token = () => accessToken({ ...auth, backend: "mobile" });

  async function call<T>(path: string, body: unknown = {}): Promise<T> {
    return post<T>(`${API}${path}`, {
      headers: {
        authorization: `Bearer ${await token()}`,
        client: process.env.MONEYLOVER_MOBILE_CLIENT ?? "",
        // The only accepted value. 2, 3, 5 and 6 all answer 706.
        apiversion: "4",
        dataformat: "json",
        platform: "1",
        appversion: String(AV),
      },
      body,
    });
  }

  const window = (skip: number) => ({ last_update: 0, skip, limit: PAGE, av: AV, pl: 1 });

  const page = async <T>(path: string): Promise<T[]> =>
    (await call<{ data?: T[] }>(path, window(0))).data ?? [];

  async function pull<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let skip = 0; ; skip += PAGE) {
      const res = await call<{ data?: T[] }>(path, window(skip));
      const chunk = res.data ?? [];
      out.push(...chunk);
      if (chunk.length < PAGE) return out;
    }
  }

  /**
   * The response is `{status, data:[{gid, syncFlag}], failedItems}` — a
   * malformed item comes back in `failedItems` instead of being applied, so
   * this fails safe. Anything rejected is raised rather than swallowed.
   */
  async function push(kind: PushKind, items: unknown[]): Promise<number> {
    const path = kind === "label" ? "/api/sync/push/label" : `/api/sync/push/${kind}/v2`;
    const failed: unknown[] = [];
    for (let i = 0; i < items.length; i += BATCH) {
      const res = await call<{ status?: boolean; failedItems?: unknown[] }>(path, {
        data: JSON.stringify({ d: items.slice(i, i + BATCH) }),
        av: AV,
        pl: 1,
      });
      if (!res.status) throw new MoneyLoverError(`${path} rejected the batch`, undefined, res);
      failed.push(...(res.failedItems ?? []));
    }
    if (failed.length) {
      throw new MoneyLoverError(`${failed.length} item(s) rejected`, undefined, failed);
    }
    return items.length;
  }

  return { call, pull, push, page };
}
