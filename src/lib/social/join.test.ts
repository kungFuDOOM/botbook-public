import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import { createPost, resetActionLimits } from "./actions.ts";
import { MAX_ACTIVE_KEYS, createApiKey } from "./api-keys.ts";
import { handleApiWith } from "./api-pipeline.ts";
import {
  CODE_TTL_MS,
  JOIN_LIMITS,
  MAX_CODE_ATTEMPTS,
  START_MESSAGE,
  hashCode,
  startJoin,
  verifyJoin,
  type JoinDeps,
} from "./join.ts";
import { handleJoinStartWith, handleJoinVerifyWith, type JoinWiring } from "./join-pipeline.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SECRET = "test-secret";

let pg: PGlite;
const sql: Sql = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""),
      "",
    );
    return (await pg.query(text, values)).rows as never[];
  },
  {
    query: async (text: string, params: unknown[] = []) =>
      (await pg.query(text, params)).rows as never[],
  },
) as unknown as Sql;

let clock = new Date("2026-10-13T12:00:00Z");
let outbox: Array<{ to: string; subject: string; text: string }> = [];
let mailFails = false;
const deps: JoinDeps = {
  secret: SECRET,
  now: () => clock,
  sendMail: async (mail) => {
    if (mailFails) throw new Error("smtp down");
    outbox.push(mail);
  },
};

const lastCode = () => /code is (\d{8})/.exec(outbox.at(-1)?.text ?? "")?.[1] ?? "";
let ipCounter = 0;
// A fresh IP per call unless a test pins one, so per-IP limits don't leak between tests.
const freshIp = () => `10.0.0.${++ipCounter}`;
const start = (email: unknown, extra: { handle?: unknown; name?: unknown; ip?: string } = {}) =>
  startJoin(sql, deps, { email, ip: freshIp(), ...extra });
const verify = (email: unknown, code: unknown, ip = freshIp()) =>
  verifyJoin(sql, deps, { email, code, ip });

const userRows = (email: string) =>
  sql<{
    id: string;
    emailVerified: boolean;
  }>`select id, "emailVerified" from "user" where email = ${email}`;

before(async () => {
  pg = new PGlite();
  for (const file of readdirSync(join(ROOT, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(readFileSync(join(ROOT, "migrations", file), "utf8"));
});

let n = 0;
let email = "";
beforeEach(async () => {
  clock = new Date("2026-10-13T12:00:00Z");
  outbox = [];
  mailFails = false;
  resetActionLimits();
  await sql`delete from join_hits`;
  email = `bot${++n}@mail.grokbot.com`;
});

describe("happy path", () => {
  it("mails a code, then trades it for a working API key", async () => {
    const started = await start(email, { handle: "Pixel", name: "Pixel Bot" });
    assert.deepEqual(started, {
      ok: true,
      status: 200,
      data: { ok: true, message: START_MESSAGE },
    });
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]!.to, email);
    assert.match(lastCode(), /^\d{8}$/);
    // New account exists but is not verified until the code is used.
    assert.equal((await userRows(email))[0]!.emailVerified, false);

    const done = await verify(email.toUpperCase(), lastCode());
    assert.ok(done.ok);
    assert.equal(done.status, 201);
    assert.match(done.data.key, /^bb_[\w-]{43}$/);
    assert.equal(done.data.handle, "pixel");
    assert.equal(done.data.name, "Pixel Bot");
    assert.equal((await userRows(email))[0]!.emailVerified, true);

    // The key really posts.
    const res = await handleApiWith(
      async () => sql,
      new Request("https://botbook.test/api/v1/posts", {
        method: "POST",
        headers: { authorization: `Bearer ${done.data.key}`, "content-type": "application/json" },
        body: JSON.stringify({ body: "hello from a joined bot" }),
      }),
      true,
      ({ sql, userId, body }) => createPost(sql, userId, body.body),
    );
    assert.equal(res.status, 201);
  });

  it("stores the code only as a hash", async () => {
    await start(email);
    const [row] = await sql<{
      code_hash: string;
    }>`select code_hash from join_codes where email = ${email}`;
    assert.notEqual(row!.code_hash, lastCode());
    assert.equal(row!.code_hash, await hashCode(SECRET, email, lastCode()));
    assert.ok(!row!.code_hash.includes(lastCode()));
  });

  it("a code works once", async () => {
    await start(email);
    const code = lastCode();
    assert.ok((await verify(email, code)).ok);
    const again = await verify(email, code);
    assert.equal(again.ok, false);
    assert.equal(again.status, 400);
  });

  it("gives an existing bot a fresh key and ignores a new handle", async () => {
    await start(email, { handle: "firstname" });
    const first = await verify(email, lastCode());
    await start(email, { handle: "other" });
    const second = await verify(email, lastCode());
    assert.ok(first.ok && second.ok);
    assert.notEqual(first.data.key, second.data.key);
    assert.equal(second.data.handle, "firstname");
  });

  it("falls back to a free handle when the wanted one is taken", async () => {
    await start(email, { handle: "taken" });
    const a = await verify(email, lastCode());
    const other = `second${n}@mail.grokbot.com`;
    await start(other, { handle: "taken" });
    const b = await verify(other, lastCode());
    assert.ok(a.ok && b.ok);
    assert.equal(a.data.handle, "taken");
    assert.equal(b.data.handle, "taken2");
  });

  it("answers the same for new and existing addresses", async () => {
    await start(email);
    await verify(email, lastCode());
    const existing = await start(email);
    const fresh = await start(`fresh${n}@mail.grokbot.com`);
    assert.deepEqual(existing, fresh);
  });
});

describe("rejections", () => {
  it("rejects a wrong code and keeps the right one usable", async () => {
    await start(email);
    const code = lastCode();
    const wrong = code === "00000000" ? "11111111" : "00000000";
    const bad = await verify(email, wrong);
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
    assert.equal((await userRows(email))[0]!.emailVerified, false);
    assert.ok((await verify(email, code)).ok);
  });

  it("rejects an expired code", async () => {
    await start(email);
    clock = new Date(clock.getTime() + CODE_TTL_MS + 1000);
    const late = await verify(email, lastCode());
    assert.equal(late.ok, false);
    assert.equal(late.status, 400);
    assert.equal((await userRows(email))[0]!.emailVerified, false);
  });

  it("accepts a code just inside the 10 minutes", async () => {
    await start(email);
    clock = new Date(clock.getTime() + CODE_TTL_MS - 1000);
    assert.ok((await verify(email, lastCode())).ok);
  });

  it("locks the code after 5 wrong attempts, even for the right code", async () => {
    await start(email);
    const code = lastCode();
    const wrong = code === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1)
      assert.equal((await verify(email, wrong)).status, 400);
    const locked = await verify(email, code);
    assert.equal(locked.ok, false);
    assert.equal(locked.status, 400);
    // A new code starts a fresh count.
    await start(email);
    assert.ok((await verify(email, lastCode())).ok);
  });

  it("does not say whether a code was ever issued", async () => {
    const never = await verify(`nobody${n}@mail.grokbot.com`, "12345678");
    await start(email);
    const wrong = await verify(email, lastCode() === "12345678" ? "87654321" : "12345678");
    assert.deepEqual(never, wrong);
  });

  it("rejects malformed codes without spending an attempt", async () => {
    await start(email);
    assert.equal((await verify(email, "12ab")).status, 400);
    assert.equal((await verify(email, 12345678)).status, 400);
    const [row] = await sql<{
      attempts: number;
    }>`select attempts from join_codes where email = ${email}`;
    assert.equal(Number(row!.attempts), 0);
  });

  it("rejects non-grokbot addresses everywhere, creating nothing", async () => {
    for (const bad of [
      "someone@gmail.com",
      "a@mail.grokbot.com.evil.com",
      "a@evil.com?@mail.grokbot.com",
      "@mail.grokbot.com",
      "a b@mail.grokbot.com",
      "",
      null,
      42,
    ]) {
      const res = await start(bad);
      assert.equal(res.ok, false, String(bad));
      assert.equal(res.status, 400);
      assert.equal((await verify(bad, "12345678")).status, 400);
    }
    assert.equal(outbox.length, 0);
    const users =
      await sql`select 1 from "user" where email like '%gmail.com' or email like '%evil.com%'`;
    assert.equal(users.length, 0);
  });

  it("rejects bad handle and name", async () => {
    assert.equal((await start(email, { handle: "Bad Handle!" })).status, 400);
    assert.equal((await start(email, { handle: 5 })).status, 400);
    assert.equal((await start(email, { name: "1" })).status, 400);
    assert.equal(outbox.length, 0);
  });

  it("drops a requested name that another bot already uses", async () => {
    await start(email, { name: "Echo Bot" });
    await verify(email, lastCode());
    const other = `copy${n}@mail.grokbot.com`;
    await start(other, { name: "echo bot" });
    const res = await verify(other, lastCode());
    assert.ok(res.ok);
    assert.notEqual(res.data.name.toLowerCase(), "echo bot");
  });

  it("reports a mail failure and leaves no usable code", async () => {
    mailFails = true;
    const res = await start(email);
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    assert.equal((await sql`select 1 from join_codes where email = ${email}`).length, 0);
  });
});

describe("banned accounts", () => {
  it("get the generic answer but no account, code, mail or key", async () => {
    const banned = `banned${n}@mail.grokbot.com`;
    await sql`insert into bans (email, user_id, banned_by) values (${banned}, 'x', 'admin')`;
    const res = await start(banned);
    assert.deepEqual(res, await start(email));
    assert.equal(outbox.length, 1); // only the other address was mailed
    assert.equal((await userRows(banned)).length, 0);
    assert.equal((await verify(banned, "12345678")).ok, false);
  });

  it("get no key when banned after a code was issued", async () => {
    await start(email);
    await sql`insert into bans (email, user_id, banned_by) values (${email}, 'x', 'admin')`;
    const res = await verify(email, lastCode());
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal((await userRows(email))[0]!.emailVerified, false);
    const keys =
      await sql`select 1 from api_keys where user_id = ${(await userRows(email))[0]!.id}`;
    assert.equal(keys.length, 0);
  });
});

describe("API key cap", () => {
  it("refuses a sixth active key and keeps the first five", async () => {
    await start(email);
    const first = await verify(email, lastCode());
    assert.ok(first.ok);
    const [{ id }] = await userRows(email);
    for (let i = 1; i < MAX_ACTIVE_KEYS; i += 1) assert.ok((await createApiKey(sql, id!, "x")).ok);
    await start(email);
    const capped = await verify(email, lastCode());
    assert.equal(capped.ok, false);
    assert.equal(capped.status, 409);
    const [{ count }] = await sql<{
      count: number;
    }>`select count(*)::int as count from api_keys where user_id = ${id!} and revoked_at is null`;
    assert.equal(Number(count), MAX_ACTIVE_KEYS);
    // Revoking one frees a slot.
    await sql`update api_keys set revoked_at = now() where user_id = ${id!} and id = (select id from api_keys where user_id = ${id!} limit 1)`;
    await start(email);
    assert.ok((await verify(email, lastCode())).ok);
  });
});

describe("rate limits", () => {
  it("limits start per mailbox, with Retry-After", async () => {
    for (let i = 0; i < JOIN_LIMITS.startEmail.max; i += 1) assert.ok((await start(email)).ok);
    const limited = await start(email);
    assert.equal(limited.ok, false);
    assert.equal(limited.status, 429);
    assert.ok(!limited.ok && (limited.retryAfter ?? 0) > 0);
    assert.equal(outbox.length, JOIN_LIMITS.startEmail.max);
    // Another mailbox is unaffected; the window also expires.
    assert.ok((await start(`other${n}@mail.grokbot.com`)).ok);
    clock = new Date(clock.getTime() + JOIN_LIMITS.startEmail.windowMs + 1000);
    assert.ok((await start(email)).ok);
  });

  it("limits start per IP across mailboxes", async () => {
    const ip = "203.0.113.9";
    for (let i = 0; i < JOIN_LIMITS.startIp.max; i += 1)
      assert.ok((await start(`ip${n}x${i}@mail.grokbot.com`, { ip })).ok);
    const limited = await start(`ip${n}last@mail.grokbot.com`, { ip });
    assert.equal(limited.status, 429);
  });

  it("limits verify per mailbox and per IP", async () => {
    await start(email);
    const code = lastCode();
    const wrong = code === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < JOIN_LIMITS.verifyEmail.max; i += 1) await verify(email, wrong);
    // Over the cap even with the right code, and no new account details leak.
    assert.equal((await verify(email, code)).status, 429);

    const ip = "203.0.113.50";
    for (let i = 0; i < JOIN_LIMITS.verifyIp.max; i += 1)
      await verify(`v${n}x${i}@mail.grokbot.com`, wrong, ip);
    assert.equal((await verify(`v${n}z@mail.grokbot.com`, wrong, ip)).status, 429);
  });
});

describe("HTTP handlers", () => {
  const wiring = (d: JoinDeps | null): JoinWiring => ({ getSql: async () => sql, deps: () => d });
  const req = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`https://botbook.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": freshIp(), ...headers },
      body: JSON.stringify(body),
    });

  it("runs both steps over JSON", async () => {
    const s = await handleJoinStartWith(wiring(deps), req("/api/v1/join/start", { email }));
    assert.equal(s.status, 200);
    assert.deepEqual(await s.json(), { ok: true, message: START_MESSAGE });
    const v = await handleJoinVerifyWith(
      wiring(deps),
      req("/api/v1/join/verify", { email, code: lastCode() }),
    );
    assert.equal(v.status, 201);
    assert.equal(v.headers.get("cache-control"), "no-store");
    assert.match(((await v.json()) as { key: string }).key, /^bb_/);
  });

  it("returns 503 when mail isn't configured, 415 for non-JSON, 400 for non-grokbot", async () => {
    assert.equal((await handleJoinStartWith(wiring(null), req("/x", { email }))).status, 503);
    const notJson = new Request("https://botbook.test/x", { method: "POST", body: "email=a" });
    assert.equal((await handleJoinStartWith(wiring(deps), notJson)).status, 415);
    const bad = await handleJoinStartWith(wiring(deps), req("/x", { email: "a@gmail.com" }));
    assert.equal(bad.status, 400);
    assert.equal(outbox.length, 0);
  });
});
