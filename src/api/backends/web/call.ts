/**
 * The authenticated request helper for the web API, and the one detail that
 * silently breaks everything: the scheme is `AuthJWT`, not `Bearer`. Sent as
 * Bearer, this API answers `error: 0` with empty data — accepted, but no rows.
 */

import { type AuthOptions, accessToken } from "../../auth.js";
import { post, unwrap } from "../../http.js";

const API = "https://web.moneylover.me/api";

export type Call = <T>(path: string, body?: unknown) => Promise<T>;

export function createCall(auth: Omit<AuthOptions, "backend">): Call {
  const token = () => accessToken({ ...auth, backend: "web" });
  return async <T>(path: string, body: unknown = {}): Promise<T> => {
    const payload = await post<unknown>(`${API}${path}`, {
      headers: { authorization: `AuthJWT ${await token()}` },
      body,
    });
    return unwrap<T>(payload);
  };
}
