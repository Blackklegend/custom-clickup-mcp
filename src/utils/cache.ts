interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class MemoryCache {
  readonly #entries = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  deletePrefix(prefix: string): void {
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}
