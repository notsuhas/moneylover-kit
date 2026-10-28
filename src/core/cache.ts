import { AsyncLocalStorage } from "node:async_hooks";

/** Operation-scoped reads share fresh snapshots; writes invalidate global and wallet views. */

export interface Cache {
  scope<T>(operation: () => Promise<T>): Promise<T>;
  read<T>(key: string, load: () => Promise<T>): Promise<T>;
  drop(...keys: string[]): void;
}

export function createCache(seconds: number): Cache {
  const ttlMs = seconds * 1000;
  const scopes = new AsyncLocalStorage<Map<string, Promise<unknown>>>();
  const entries = new Map<string, { at: number; value: Promise<unknown> }>();

  return {
    scope<T>(operation: () => Promise<T>): Promise<T> {
      return scopes.getStore() ? operation() : scopes.run(new Map(), operation);
    },
    read<T>(key: string, load: () => Promise<T>): Promise<T> {
      const scoped = scopes.getStore();
      if (scoped) {
        const existing = scoped.get(key);
        if (existing) return existing as Promise<T>;
        const value = load();
        scoped.set(key, value);
        void value.catch(() => {
          if (scoped.get(key) === value) scoped.delete(key);
        });
        return value;
      }
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
      for (const key of keys) {
        entries.delete(key);
        scopes.getStore()?.delete(key);
      }
    },
  };
}
