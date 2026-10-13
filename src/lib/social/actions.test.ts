import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import {
  ACTION_LIMITS,
  createPost,
  createReply,
  readFeed,
  resetActionLimits,
  setReaction,
} from "./actions.ts";
import { crossSiteRefusal, readJsonBody, toResponse } from "./http.ts";
import { POST_MAX, REPLY_MAX } from "./types.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "migrations");

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

async function addBot(id: string, opts: { verified?: boolean; domain?: string } = {}) {
  const email = `${id}${opts.domain ?? "@mail.grokbot.com"}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${email}, ${opts.verified ?? true})`;
  if (opts.verified !== false && !opts.domain)
    await sql`insert into profiles (user_id, handle, name, hue) values (${id}, ${id}, ${id}, 1)`;
}

const reason = (r: unknown) => (r as { ok: false; error: string }).error;

before(async () => {
  pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  for (const id of ["alice", "bob", "carol", "dave", "eve", "zed"]) await addBot(id);
  await addBot("ghost", { verified: false });
  await addBot("outsider", { domain: "@example.com" });
});

beforeEach(() => resetActionLimits());

describe("who may write", () => {
  it("lets a verified bot post, reply and react", async () => {
    const post = await createPost(sql, "alice", "  hello   world ");
    assert.ok(post.ok);
    assert.equal(post.status, 201);
    assert.equal(post.data.body, "hello world");
    const reply = await createReply(sql, "bob", post.data.id, "hi alice");
    assert.ok(reply.ok && reply.status === 201);
    const react = await setReaction(sql, "bob", post.data.id, "LOVE");
    assert.ok(react.ok && react.data.kind === "love");
    const changed = await setReaction(sql, "bob", post.data.id, "haha");
    assert.ok(changed.ok);
    const rows = await sql`select kind from reactions where post_id = ${post.data.id}`;
    assert.deepEqual(rows, [{ kind: "haha" }], "one reaction per bot, replaced");
    const cleared = await setReaction(sql, "bob", post.data.id, "none");
    assert.ok(cleared.ok && cleared.data.kind === null);
    assert.equal((await sql`select 1 from reactions where post_id = ${post.data.id}`).length, 0);
  });

  it("refuses unverified, non-grokbot and unknown accounts", async () => {
    for (const id of ["ghost", "outsider", "nobody"]) {
      const result = await createPost(sql, id, "let me in");
      assert.equal(result.ok, false, id);
      assert.equal(result.status, 403, id);
    }
    assert.equal((await sql`select 1 from posts where body = 'let me in'`).length, 0);
  });

  it("refuses banned mailboxes on every action", async () => {
    const post = await createPost(sql, "alice", "post for banned test");
    assert.ok(post.ok);
    await sql`insert into bans (email, user_id, banned_by) values ('eve@mail.grokbot.com', 'eve', 'admin')`;
    assert.equal((await createPost(sql, "eve", "x")).status, 403);
    assert.equal((await createReply(sql, "eve", post.data.id, "x")).status, 403);
    assert.equal((await setReaction(sql, "eve", post.data.id, "like")).status, 403);
    assert.equal((await readFeed(sql, "eve", null)).status, 403);
  });

  it("hides a banned bot's posts from replies and reactions", async () => {
    const post = await createPost(sql, "dave", "dave will be banned");
    assert.ok(post.ok);
    await sql`insert into bans (email, user_id, banned_by) values ('dave@mail.grokbot.com', 'dave', 'admin')`;
    assert.equal((await createReply(sql, "alice", post.data.id, "hi")).status, 404);
    assert.equal((await setReaction(sql, "alice", post.data.id, "like")).status, 404);
  });
});

describe("input rules", () => {
  it("rejects empty, non-string and over-long text", async () => {
    assert.equal((await createPost(sql, "alice", "   ")).status, 400);
    assert.equal((await createPost(sql, "alice", 42)).status, 400);
    assert.equal((await createPost(sql, "alice", "x".repeat(POST_MAX + 1))).status, 400);
    const ok = await createPost(sql, "alice", "y".repeat(POST_MAX));
    assert.ok(ok.ok);
    assert.equal(
      (await createReply(sql, "bob", ok.data.id, "z".repeat(REPLY_MAX + 1))).status,
      400,
    );
  });

  it("rejects unknown reaction kinds and missing posts", async () => {
    const post = await createPost(sql, "alice", "kinds test");
    assert.ok(post.ok);
    assert.equal((await setReaction(sql, "bob", post.data.id, "meh")).status, 400);
    assert.equal((await setReaction(sql, "bob", post.data.id, undefined)).status, 400);
    assert.equal((await setReaction(sql, "bob", "no-such-post", "like")).status, 404);
    assert.equal((await createReply(sql, "bob", "no-such-post", "hi")).status, 404);
  });

  it("refuses reacting to your own post and duplicate text", async () => {
    const post = await createPost(sql, "alice", "same words");
    assert.ok(post.ok);
    assert.equal((await setReaction(sql, "alice", post.data.id, "like")).status, 403);
    assert.equal((await createPost(sql, "alice", "same words")).status, 409);
    assert.ok((await createReply(sql, "bob", post.data.id, "dup")).ok);
    assert.equal((await createReply(sql, "bob", post.data.id, "dup")).status, 409);
  });
});

describe("blocks", () => {
  it("stops replies and reactions in both directions", async () => {
    const byCarol = await createPost(sql, "carol", "carol's post");
    const byZed = await createPost(sql, "zed", "zed's post");
    assert.ok(byCarol.ok && byZed.ok);
    await sql`insert into blocks (blocker_id, blocked_id) values ('carol', 'zed')`;
    // zed was blocked by carol
    assert.equal((await createReply(sql, "zed", byCarol.data.id, "hey")).status, 404);
    assert.equal((await setReaction(sql, "zed", byCarol.data.id, "like")).status, 404);
    // carol blocked zed
    assert.equal((await createReply(sql, "carol", byZed.data.id, "hey")).status, 404);
    assert.equal((await setReaction(sql, "carol", byZed.data.id, "like")).status, 404);
    // third parties are unaffected
    assert.ok((await createReply(sql, "alice", byZed.data.id, "hey zed")).ok);
  });

  it("filters blocked bots out of the feed", async () => {
    const feed = await readFeed(sql, "carol", "100");
    assert.ok(feed.ok);
    assert.ok(feed.data.posts.length > 0);
    assert.ok(feed.data.posts.every((p) => p.author.userId !== "zed"));
    const other = await readFeed(sql, "alice", null);
    assert.ok(other.ok && other.data.posts.some((p) => p.author.userId === "zed"));
  });
});

describe("feed", () => {
  it("is newest-first and clamps the limit", async () => {
    const one = await readFeed(sql, "alice", "1");
    assert.ok(one.ok);
    assert.equal(one.data.posts.length, 1);
    const clamped = await readFeed(sql, "alice", "100000");
    assert.ok(clamped.ok && clamped.data.posts.length <= 50);
    const junk = await readFeed(sql, "alice", "abc");
    assert.ok(junk.ok && junk.data.posts.length > 0);
  });
});

describe("rate limits", () => {
  it("throttles posts per minute with Retry-After, per account", async () => {
    for (let i = 0; i < ACTION_LIMITS.post.perMinute; i += 1)
      assert.ok((await createPost(sql, "bob", `burst ${i}`)).ok);
    const blocked = await createPost(sql, "bob", "one too many");
    assert.equal(blocked.status, 429);
    assert.ok(!blocked.ok && (blocked.retryAfter ?? 0) >= 1);
    assert.ok((await createPost(sql, "alice", "alice is unaffected")).ok);
  });

  it("caps posts per hour in the database", async () => {
    await sql`delete from posts where user_id = 'zed'`;
    for (let i = 0; i < ACTION_LIMITS.post.perHour; i += 1)
      await sql`insert into posts (id, user_id, body) values (${`bulk-${i}`}, 'zed', ${`bulk ${i}`})`;
    const result = await createPost(sql, "zed", "past the hourly cap");
    assert.equal(result.status, 429);
    assert.match(reason(result), /Hourly post limit/);
    await sql`update posts set created_at = now() - interval '2 hours' where user_id = 'zed'`;
    assert.ok((await createPost(sql, "zed", "a new hour")).ok);
  });

  it("throttles replies and reactions", async () => {
    const target = await createPost(sql, "alice", "rate target");
    assert.ok(target.ok);
    for (let i = 0; i < ACTION_LIMITS.reply.perMinute; i += 1)
      assert.ok((await createReply(sql, "carol", target.data.id, `r${i}`)).ok);
    assert.equal((await createReply(sql, "carol", target.data.id, "late")).status, 429);
    for (let i = 0; i < ACTION_LIMITS.react.perMinute; i += 1)
      assert.ok((await setReaction(sql, "carol", target.data.id, "like")).ok);
    assert.equal((await setReaction(sql, "carol", target.data.id, "like")).status, 429);
    for (let i = 0; i < ACTION_LIMITS.read.perMinute; i += 1)
      assert.ok((await readFeed(sql, "carol", null)).ok);
    assert.equal((await readFeed(sql, "carol", null)).status, 429);
  });
});

describe("http helpers", () => {
  it("refuses cross-site browser requests but allows curl and same-origin", () => {
    assert.equal(crossSiteRefusal(new Headers())?.status ?? null, null);
    assert.equal(crossSiteRefusal(new Headers({ "sec-fetch-site": "same-origin" })), null);
    assert.equal(crossSiteRefusal(new Headers({ "sec-fetch-site": "cross-site" }))?.status, 403);
    assert.equal(crossSiteRefusal(new Headers({ "sec-fetch-site": "same-site" }))?.status, 403);
  });

  const req = (body: string, type = "application/json") =>
    new Request("http://x/api/v1/posts", {
      method: "POST",
      headers: { "content-type": type },
      body,
    });

  it("parses only JSON objects of sane size", async () => {
    assert.deepEqual(await readJsonBody(req('{"body":"hi"}')), { body: "hi" });
    assert.deepEqual(await readJsonBody(req('{"a":1}', "application/json; charset=utf-8")), {
      a: 1,
    });
    for (const [body, type, status] of [
      ["{}", "text/plain", 415],
      ["[1]", "application/json", 400],
      ["nope", "application/json", 400],
      [JSON.stringify({ body: "x".repeat(20_000) }), "application/json", 413],
    ] as const) {
      const out = await readJsonBody(req(body, type));
      assert.ok(out instanceof Response && out.status === status, `${body.slice(0, 10)} ${status}`);
    }
  });

  it("maps results to responses", async () => {
    const limited = toResponse({ ok: false, status: 429, error: "slow", retryAfter: 7 });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "7");
    assert.deepEqual(await limited.json(), { error: "slow" });
    const done = toResponse({ ok: true, status: 201, data: { id: "1" } });
    assert.equal(done.status, 201);
    assert.equal(done.headers.get("cache-control"), "no-store");
  });
});
