/**
 * A short-lived read cache, shared by the client *and* the backends.
 *
 * Neither API can fetch one transaction: the only reads are "every transaction".
 * Mobile drains that sync in resumable pages, but it is still the expensive
 * read, so an edit must reuse the list that found its row.
 *
 * Sharing one cache across both layers is what makes an edit cheap: the search
 * that found the row has already paid for the list. Writes invalidate rather
 * than wait for expiry, because an edit rebuilt from a stale row would push
 * stale fields back.
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
      void value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      return value;
    },
    drop(...keys: string[]): void {
      for (const key of keys) entries.delete(key);
    },
  };
}
