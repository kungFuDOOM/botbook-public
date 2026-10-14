import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowLimiter } from "./limiter.ts";
import { microcache, TtlMap } from "./microcache.ts";
import { clientIp, guardRequest, LIMITS, MAX_BODY_BYTES } from "./request-guard.ts";

test("limiter allows up to the limit, then refuses until the window resets", () => {
  const limiter = new WindowLimiter(3, 1000);
  assert.equal(limiter.hit("a", 1, 0).ok, true);
  assert.equal(limiter.hit("a", 1, 1).ok, true);
  assert.equal(limiter.hit("a", 1, 2).ok, true);
  const blocked = limiter.hit("a", 1, 3);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfter, 1);
  assert.equal(limiter.hit("b", 1, 3).ok, true, "other keys unaffected");
  assert.equal(limiter.hit("a", 1, 1001).ok, true, "new window");
});

test("limiter memory stays bounded under a wide flood", () => {
  const limiter = new WindowLimiter(5, 60_000, 100);
  for (let i = 0; i < 10_000; i += 1) limiter.hit(`ip-${i}`, 1, i);
  assert.ok(limiter.size <= 100, `size ${limiter.size}`);
});

test("microcache shares one load across concurrent callers and serves stale on failure", async () => {
  let loads = 0;
  let fail = false;
  let clock = 0;
  const get = microcache(
    1000,
    async () => {
      loads += 1;
      if (fail) throw new Error("db down");
      return loads;
    },
    { now: () => clock, staleMs: 5000 },
  );
  const results = await Promise.all([get(), get(), get()]);
  assert.deepEqual(results, [1, 1, 1]);
  assert.equal(loads, 1);
  clock = 2000;
  fail = true;
  assert.equal(await get(), 1, "stale value while the database is failing");
  clock = 10_000;
  await assert.rejects(get(), /db down/, "too stale: the error surfaces");
});

test("TtlMap expires entries and stays bounded", () => {
  const map = new TtlMap<number>(100, 3);
  map.set("a", 1, 0);
  assert.equal(map.get("a", 50), 1);
  assert.equal(map.get("a", 150), undefined);
  for (const k of ["b", "c", "d", "e"]) map.set(k, 1, 0);
  assert.equal(map.get("b", 1), undefined, "oldest evicted");
  assert.equal(map.get("e", 1), 1);
});

test("guard refuses oversized bodies, odd methods and long URLs", () => {
  const big = new Request("http://x/_serverFn/abc", {
    method: "POST",
    headers: { "content-length": String(MAX_BODY_BYTES + 1) },
  });
  assert.equal(guardRequest(big)?.status, 413);
  assert.equal(guardRequest(new Request("http://x/", { method: "DELETE" }))?.status, 405);
  assert.equal(guardRequest(new Request(`http://x/?q=${"a".repeat(5000)}`))?.status, 414);
  assert.equal(
    guardRequest(new Request("http://x/", { headers: { "x-real-ip": "9.9.9.9" } })),
    null,
  );
});

test("guard rate-limits auth floods per IP with Retry-After", () => {
  const headers = { "x-real-ip": "203.0.113.50", "content-length": "10" };
  let last: Response | null = null;
  for (let i = 0; i <= LIMITS.authWrites.limit; i += 1) {
    last = guardRequest(
      new Request("http://x/api/auth/sign-in/email", { method: "POST", headers }),
    );
  }
  assert.equal(last?.status, 429);
  assert.ok(Number(last?.headers.get("retry-after")) >= 1);
  const other = new Request("http://x/api/auth/sign-in/email", {
    method: "POST",
    headers: { "x-real-ip": "203.0.113.51", "content-length": "10" },
  });
  assert.equal(guardRequest(other), null, "a different client is unaffected");
});

test("client IP prefers the edge-set headers", () => {
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" })), "1.1.1.1");
  assert.equal(
    clientIp(new Headers({ "x-real-ip": "3.3.3.3", "x-forwarded-for": "1.1.1.1" })),
    "3.3.3.3",
  );
  assert.equal(clientIp(new Headers()), "local");
});

test("guard lets PATCH and DELETE through only for the bot API", () => {
  const h = { "x-real-ip": "198.51.100.7" };
  assert.equal(
    guardRequest(new Request("http://x/api/v1/me", { method: "PATCH", headers: h })),
    null,
  );
  assert.equal(
    guardRequest(new Request("http://x/api/v1/posts/abc", { method: "DELETE", headers: h })),
    null,
  );
  assert.equal(
    guardRequest(new Request("http://x/feed", { method: "DELETE", headers: h }))?.status,
    405,
  );
  assert.equal(
    guardRequest(new Request("http://x/api/auth/x", { method: "PATCH", headers: h }))?.status,
    405,
  );
  assert.equal(
    guardRequest(new Request("http://x/api/v1/me", { method: "PUT", headers: h }))?.status,
    405,
  );
  const big = new Request("http://x/api/v1/me", {
    method: "PATCH",
    headers: { ...h, "content-length": String(MAX_BODY_BYTES + 1) },
  });
  assert.equal(guardRequest(big)?.status, 413);
});
