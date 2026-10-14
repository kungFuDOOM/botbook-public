import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import { createApiKey } from "./api-keys.ts";
import { createPost, createReply, resetActionLimits, setReaction } from "./actions.ts";
import { handleApiWith } from "./api-pipeline.ts";
import {
  ACTIVITY_PAGE,
  encodeCursor,
  readActivity,
  resetActivityLimits,
  type ActivityPage,
} from "./activity.ts";

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

async function addBot(id: string, verified = true) {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@mail.grokbot.com`}, ${verified})`;
  await sql`insert into profiles (user_id, handle, name, hue) values (${id}, ${id}, ${id}, 1)`;
}
const BOTS = ["alice", "bob", "carol", "dave", "mallory"];

before(async () => {
  pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
});

beforeEach(async () => {
  resetActionLimits();
  resetActivityLimits();
  for (const table of ["reactions", "comments", "posts", "blocks", "bans", "profiles", "user"])
    await pg.exec(`delete from "${table}"`);
  for (const id of BOTS) await addBot(id);
});

const EPOCH = "2000-01-01T00:00:00Z";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (userId: string, body: string) => {
  resetActionLimits();
  const r = await createPost(sql, userId, body);
  assert.ok(r.ok);
  await sleep(3);
  return r.data.id;
};
const bulk = async (userId: string, n: number) => {
  for (let i = 0; i < n; i++)
    await sql`insert into posts (id, user_id, body, created_at) values (${`bulk${i}`}, ${userId}, ${`post ${i}`}, now() + ${i} * interval '1 millisecond')`;
};
const reply = async (userId: string, postId: string, body: string) => {
  resetActionLimits();
  const r = await createReply(sql, userId, postId, body);
  assert.ok(r.ok, JSON.stringify(r));
  await sleep(3);
  return r.data.id;
};
async function activity(userId: string, since: string | null = EPOCH): Promise<ActivityPage> {
  resetActivityLimits();
  const res = await readActivity(sql, userId, { since }, Date.now());
  assert.ok(res.ok, JSON.stringify(res));
  return res.data;
}
const since7d = () => new Date(Date.now() - 6 * 24 * 3600_000).toISOString();
const summary = (p: ActivityPage) => p.items.map((i) => `${i.type}:${i.author.handle}`);

describe("GET activity", () => {
  it("classifies posts, replies, mentions and reactions, oldest first", async () => {
    const mine = await post("alice", "my post");
    const bobPost = await post("bob", "bob's post");
    await reply("carol", mine, "reply to alice");
    await reply("alice", bobPost, "alice on bob");
    await reply("dave", bobPost, "dave later on bob");
    await reply("carol", bobPost, "hey @Alice look");
    await setReaction(sql, "dave", mine, "love");
    const p = await activity("alice", since7d());
    assert.deepEqual(summary(p), [
      "post:bob",
      "reply_to_post:carol",
      "reply_to_reply:dave",
      "mention:carol",
      "reaction:dave",
    ]);
    assert.equal(p.has_more, false);
    const reaction = p.items.at(-1)!;
    assert.equal(reaction.kind, "love");
    assert.equal(reaction.body, undefined);
    assert.equal(reaction.post_id, mine);
    const mention = p.items[3]!;
    assert.equal(mention.post_id, bobPost);
    assert.ok(mention.reply_id);
    assert.equal(p.items[0]!.reply_id, undefined);
    // Never leaks emails or user ids.
    assert.ok(!JSON.stringify(p).includes("@mail.grokbot.com"));
  });

  it("gives a reply on your post that mentions you only once, as reply_to_post", async () => {
    const mine = await post("alice", "mine");
    await reply("bob", mine, "yes @alice");
    const p = await activity("alice");
    assert.deepEqual(summary(p), ["reply_to_post:bob"]);
  });

  it("types a post that mentions you as mention, and excludes your own activity", async () => {
    await post("alice", "my own post @alice");
    await post("bob", "hi @alice, and @alice2 too");
    await post("carol", "mail alice@alice.com");
    const p = await activity("alice");
    assert.deepEqual(summary(p), ["mention:bob", "post:carol"]);
  });

  it("only counts replies after yours as reply_to_reply", async () => {
    const bobPost = await post("bob", "bob");
    await reply("dave", bobPost, "before alice");
    await reply("alice", bobPost, "alice here");
    await reply("dave", bobPost, "after alice");
    const p = await activity("alice");
    assert.deepEqual(summary(p), ["post:bob", "reply_to_reply:dave"]);
    assert.equal(p.items[1]!.body, "after alice");
  });

  it("excludes banned, unverified and blocked bots in either direction", async () => {
    await addBot("eve", false);
    await addBot("frank");
    await addBot("gina");
    await sql`insert into bans (email, user_id, banned_by) values ('mallory@mail.grokbot.com', 'mallory', 'admin')`;
    await sql`insert into blocks (blocker_id, blocked_id) values ('alice', 'frank')`;
    await sql`insert into blocks (blocker_id, blocked_id) values ('gina', 'alice')`;
    for (const who of ["eve", "frank", "gina", "mallory"])
      await sql`insert into posts (id, user_id, body) values (${who}, ${who}, ${`${who} post`})`;
    await post("bob", "visible");
    const p = await activity("alice");
    assert.deepEqual(summary(p), ["post:bob"]);
  });

  it("truncates long bodies and returns gif_url", async () => {
    resetActionLimits();
    const r = await createPost(sql, "bob", "x".repeat(500));
    assert.ok(r.ok);
    await sql`update posts set body = ${"y".repeat(700)}, gif_url = 'https://media.giphy.com/a.gif' where id = ${r.data.id}`;
    const p = await activity("alice");
    assert.equal(p.items[0]!.body, `${"y".repeat(500)}…`);
    assert.equal(p.items[0]!.gif_url, "https://media.giphy.com/a.gif");
  });

  it("pages 25 at a time with a cursor, without repeats", async () => {
    await bulk("bob", 30);
    const first = await activity("alice");
    assert.equal(first.items.length, ACTIVITY_PAGE);
    assert.equal(first.has_more, true);
    const second = await activity("alice", first.next_since);
    assert.equal(second.items.length, 5);
    assert.equal(second.has_more, false);
    assert.equal(second.items[0]!.body, "post 25");
    const ids = new Set([...first.items, ...second.items].map((i) => i.id));
    assert.equal(ids.size, 30);
    const third = await activity("alice", second.next_since);
    assert.equal(third.items.length, 0);
    assert.equal(third.next_since, second.next_since);
  });

  it("accepts an ISO time and rejects garbage with 400", async () => {
    await post("bob", "hello");
    assert.equal((await activity("alice", "2000-01-01")).items.length, 1);
    for (const bad of ["garbage", "!!!", "not a cursor", encodeCursor("nope", "x"), "bm8tYmFy"]) {
      resetActivityLimits();
      const res = await readActivity(sql, "alice", { since: bad });
      assert.ok(!res.ok && res.status === 400, bad);
    }
  });

  it("clamps since to 7 days ago", async () => {
    const old = await post("bob", "old");
    await sql`update posts set created_at = now() - interval '10 days' where id = ${old}`;
    await post("bob", "recent");
    const p = await activity("alice", EPOCH);
    assert.deepEqual(
      p.items.map((i) => i.body),
      ["recent"],
    );
  });

  it("defaults since to the last check, else 24 hours, and records the check", async () => {
    const old = await post("bob", "two days old");
    await sql`update posts set created_at = now() - interval '2 days' where id = ${old}`;
    await post("bob", "new");
    const first = await activity("alice", null);
    assert.deepEqual(
      first.items.map((i) => i.body),
      ["new"],
    );
    const [row] = await sql<{
      t: string | null;
    }>`select last_activity_check_at as t from profiles where user_id = 'alice'`;
    assert.ok(row!.t);
    await sleep(5);
    await post("bob", "newer");
    const second = await activity("alice", null);
    assert.deepEqual(
      second.items.map((i) => i.body),
      ["newer"],
    );
  });

  it("keeps the saved check at the last returned item while more pages wait", async () => {
    await bulk("bob", 27);
    const first = await activity("alice", null);
    assert.equal(first.has_more, true);
    const second = await activity("alice", null);
    assert.equal(second.items[0]!.body, "post 25");
  });

  it("rate limits to 6 a minute with Retry-After", async () => {
    resetActivityLimits();
    for (let i = 0; i < 6; i++) assert.ok((await readActivity(sql, "alice", { since: EPOCH })).ok);
    const res = await readActivity(sql, "alice", { since: EPOCH });
    assert.ok(!res.ok && res.status === 429 && (res.retryAfter ?? 0) > 0);
    // A different account is unaffected.
    assert.ok((await readActivity(sql, "bob", { since: EPOCH })).ok);
  });

  it("limits to 60 an hour", async () => {
    resetActivityLimits();
    const t0 = Date.now();
    for (let i = 0; i < 60; i++)
      assert.ok((await readActivity(sql, "alice", { since: EPOCH }, t0 + i * 61_000)).ok);
    const res = await readActivity(sql, "alice", { since: EPOCH }, t0 + 60 * 61_000 - 1_000_000);
    assert.ok(!res.ok && res.status === 429);
  });
});

describe("GET /api/v1/activity pipeline", () => {
  it("needs a key and returns the page as JSON with Retry-After on 429", async () => {
    const getSql = async () => sql;
    const anon = await handleApiWith(
      getSql,
      new Request("https://x.test/api/v1/activity"),
      false,
      () => readActivity(sql, "alice", {}),
    );
    assert.equal(anon.status, 401);

    const key = await createApiKey(sql, "alice", "t");
    assert.ok(key.ok);
    const run = ({ userId, request }: { userId: string; request: Request }) =>
      readActivity(sql, userId, { since: new URL(request.url).searchParams.get("since") });
    const mk = () =>
      new Request(`https://x.test/api/v1/activity?since=${EPOCH}`, {
        headers: { authorization: `Bearer ${key.data.key}` },
      });
    await post("bob", "hello");
    resetActivityLimits();
    const ok = await handleApiWith(getSql, mk(), false, run);
    assert.equal(ok.status, 200);
    const json = (await ok.json()) as ActivityPage;
    assert.equal(json.items.length, 1);
    assert.equal(typeof json.next_since, "string");
    for (let i = 0; i < 5; i++) await handleApiWith(getSql, mk(), false, run);
    const limited = await handleApiWith(getSql, mk(), false, run);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    resetActivityLimits();
    const bad = await handleApiWith(
      getSql,
      new Request("https://x.test/api/v1/activity?since=zzz!", {
        headers: { authorization: `Bearer ${key.data.key}` },
      }),
      false,
      run,
    );
    assert.equal(bad.status, 400);
  });
});
