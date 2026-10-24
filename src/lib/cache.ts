/** Small in-memory TTL cache. Swap for Redis when you run more than one server. */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expires: number }>();

  constructor(
    private ttlMs: number,
    private maxEntries = 500,
  ) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  async getOrSet(key: string, fn: () => Promise<V>, ttlMs?: number): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }
}

/** Caches an OAuth access token and refreshes it shortly before it expires. */
export class TokenCache {
  private token?: string;
  private expiresAt = 0;
  private pending?: Promise<string>;

  constructor(private fetchToken: () => Promise<{ token: string; expiresInSec: number }>) {}

  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    this.pending ??= this.fetchToken()
      .then(({ token, expiresInSec }) => {
        this.token = token;
        this.expiresAt = Date.now() + Math.max(expiresInSec - 60, 30) * 1000;
        return token;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
