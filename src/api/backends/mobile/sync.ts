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
  /** Scheduling hint only; live pages always determine where reconciliation ends. */
  estimatedRows?: number;
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

  async function call<T>(path: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
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
      ...(signal ? { signal } : {}),
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
    const controller = new AbortController();
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
      const response = await call<Page>(
        path,
        window(lastUpdate, skip, options.accountId),
        controller.signal,
      );
      if (response.status === false)
        throw new MoneyLoverError(
          response.message ?? `${path} pull failed`,
          response.error,
          response,
        );
      return response;
    }
    if (
      options.estimatedRows !== undefined &&
      (!Number.isSafeInteger(options.estimatedRows) || options.estimatedRows < 0)
    )
      throw new MoneyLoverError("Estimated row count must be a nonnegative safe integer");
    const hintedPages =
      options.estimatedRows === undefined
        ? 2
        : Math.max(1, Math.floor(Math.max(0, options.estimatedRows - start) / PAGE) + 1);
    let horizon = options.estimatedRows === undefined ? Infinity : start + hintedPages * PAGE;
    let width = hintedPages > 2 ? concurrency : 1;
    let nextSkip = start;
    let timestamp = lastUpdate;
    const pending = new Map<number, Promise<PromiseSettledResult<Page>>>();
    function fill(skip: number): void {
      while (nextSkip < Math.min(skip + PAGE * width, horizon)) {
        const result = read(nextSkip).then(
          (value): PromiseFulfilledResult<Page> => ({ status: "fulfilled", value }),
          (reason): PromiseRejectedResult => ({ status: "rejected", reason }),
        );
        pending.set(nextSkip, result);
        nextSkip += PAGE;
      }
    }
    try {
      for (let skip = start; ; skip += PAGE) {
        fill(skip);
        const result = pending.get(skip);
        if (!result) throw new MoneyLoverError("Missing scheduled sync page");
        const page = await result;
        pending.delete(skip);
        if (page.status === "rejected") throw page.reason;
        if (skip === start) timestamp = page.value.timestamp ?? lastUpdate;
        const chunk = page.value.data ?? [];
        out.push(...chunk);
        await options.onPage?.(chunk, { nextSkip: skip + chunk.length, timestamp });
        if (chunk.length < PAGE) return { data: out, timestamp };
        if (skip + PAGE >= start + PAGE * 2) width = concurrency;
        if (skip + PAGE >= horizon) horizon = Infinity;
      }
    } finally {
      controller.abort();
      await Promise.allSettled(pending.values());
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
