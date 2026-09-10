/**
 * A short-lived read cache.
 *
 * Not an optimisation for its own sake: a transaction list is thousands of
 * rows and a single CLI command or MCP tool call may need it several times.
 * Writes invalidate rather than wait for expiry, because an edit rebuilt from
 * a stale row would push stale fields back to the server.
 */

export interface Cache {
  read<T>(key: string, load: () => Promise<T>): Promise<T>;
  drop(...keys: string[]): void;
}

export function createCache(seconds: number): Cache {
  const ttlMs = seconds * 1000;
  const entries = new Map<string, { at: number; value: Promise<unknown> }>();

  return {
    read<T>(key: string, load: () => Promise<T>): Promise<T> {
      if (ttlMs <= 0) return load();
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
      const value = load();
      entries.set(key, { at: Date.now(), value });
      return value;
    },
    drop(...keys: string[]): void {
      for (const key of keys) entries.delete(key);
    },
  };
}
