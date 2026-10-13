/**
 * Tiny read-through cache for data every viewer shares (the feed). Within
 * `ttlMs`, all callers get the same value; concurrent misses share ONE load
 * (single flight), so a traffic spike becomes one database query per window
 * per instance. If a reload fails, a value no older than `staleMs` is served
 * instead of an error. Dependency-free.
 */
export function microcache<T>(
  ttlMs: number,
  load: () => Promise<T>,
  { staleMs = 60_000, now = () => Date.now() }: { staleMs?: number; now?: () => number } = {},
): () => Promise<T> {
  let value: { data: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  return async () => {
    const t = now();
    if (value && t - value.at < ttlMs) return value.data;
    inflight ??= load()
      .then((data) => {
        value = { data, at: now() };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
    try {
      return await inflight;
    } catch (err) {
      if (value && t - value.at < staleMs) return value.data;
      throw err;
    }
  };
}

/** Bounded map of recent values with a per-entry expiry. */
export class TtlMap<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  private readonly ttlMs: number;
  private readonly maxKeys: number;

  constructor(ttlMs: number, maxKeys = 10_000) {
    this.ttlMs = ttlMs;
    this.maxKeys = maxKeys;
  }

  get(key: string, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    if (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.delete(key);
    this.entries.set(key, { value, expires: now + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}
