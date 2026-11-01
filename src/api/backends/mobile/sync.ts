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
const PAGE = 300;
const BATCH = 50;

export interface PullResult<T> {
  data: T[];
  timestamp: number;
}

export interface PullOptions<T> {
  accountId?: string;
  skip?: number;
  concurrency?: number;
  onPage?: (rows: T[], state: { nextSkip: number; timestamp: number }) => void | Promise<void>;
}

export type PushKind = "transaction" | "category" | "label" | "campaign" | "account";

export interface Sync {
  call<T>(path: string, body?: unknown): Promise<T>;
  /** Drain a paginated pull endpoint. */
  pull<T>(path: string): Promise<T[]>;
  /** Drain changes since a sync timestamp. */
  pullSince<T>(path: string, lastUpdate: number, options?: PullOptions<T>): Promise<PullResult<T>>;
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

  const window = (lastUpdate: number, skip: number, accountId?: string) => ({
    last_update: lastUpdate,
    ...(accountId ? { account_id: accountId } : {}),
    skip,
    limit: PAGE,
    av: AV,
    pl: 1,
  });

  const page = async <T>(path: string): Promise<T[]> =>
    (await call<{ data?: T[] }>(path, window(0, 0))).data ?? [];

  async function pullSince<T>(
    path: string,
    lastUpdate: number,
    options: PullOptions<T> = {},
  ): Promise<PullResult<T>> {
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new MoneyLoverError("Pull concurrency must be an integer between 1 and 8");
    const out: T[] = [];
    const start = options.skip ?? 0;
    type Page = {
      status?: boolean;
      error?: number;
      message?: string;
      data?: T[];
      timestamp?: number;
    };
    async function read(skip: number): Promise<Page> {
      const response = await call<Page>(path, window(lastUpdate, skip, options.accountId));
      if (response.status === false)
        throw new MoneyLoverError(
          response.message ?? `${path} pull failed`,
          response.error,
          response,
        );
      return response;
    }
    const first = await read(start);
    const timestamp = first.timestamp ?? lastUpdate;
    async function append(response: Page, skip: number): Promise<boolean> {
      const chunk = response.data ?? [];
      out.push(...chunk);
      await options.onPage?.(chunk, { nextSkip: skip + chunk.length, timestamp });
      return chunk.length < PAGE;
    }
    if (await append(first, start)) return { data: out, timestamp };
    let width = 1;
    for (let skip = start + PAGE; ; ) {
      const pages = await Promise.allSettled(
        Array.from({ length: width }, (_, index) => read(skip + index * PAGE)),
      );
      for (const [index, page] of pages.entries()) {
        if (page.status === "rejected") throw page.reason;
        if (await append(page.value, skip + index * PAGE)) return { data: out, timestamp };
      }
      skip += PAGE * width;
      width = concurrency;
    }
  }

  const pull = async <T>(path: string): Promise<T[]> => (await pullSince<T>(path, 0)).data;

  /**
   * The response is `{status, data:[{gid, syncFlag}], failedItems}` — a
   * malformed item comes back in `failedItems` instead of being applied, so
   * this fails safe. Anything rejected is raised rather than swallowed.
   */
  async function push(kind: PushKind, items: unknown[]): Promise<number> {
    const path =
      kind === "label" || kind === "campaign" || kind === "account"
        ? `/api/sync/push/${kind}`
        : `/api/sync/push/${kind}/v2`;
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

  return { call, pull, pullSince, push, page };
}
