/**
 * Fixed-window rate limiter held in memory (per server instance). It is the
 * cheap first line of defence: it costs no database work, so a flood is
 * turned away before it can reach Postgres. Memory is bounded: at most
 * `maxKeys` counters, oldest evicted first. Dependency-free.
 */
export type LimitResult = { ok: boolean; retryAfter: number; remaining: number };

type Bucket = { count: number; resetAt: number };

export class WindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  readonly limit: number;
  readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(limit: number, windowMs: number, maxKeys = 20_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  hit(key: string, cost = 1, now = Date.now()): LimitResult {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && this.buckets.size >= this.maxKeys) this.evict(now);
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    }
    bucket.count += cost;
    const ok = bucket.count <= this.limit;
    return {
      ok,
      retryAfter: ok ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      remaining: Math.max(0, this.limit - bucket.count),
    };
  }

  get size(): number {
    return this.buckets.size;
  }

  private evict(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    // Still full (a wide flood): drop the oldest tenth. Map keeps insertion order.
    if (this.buckets.size >= this.maxKeys) {
      let drop = Math.ceil(this.maxKeys / 10);
      for (const key of this.buckets.keys()) {
        if (drop-- <= 0) break;
        this.buckets.delete(key);
      }
    }
  }
}
