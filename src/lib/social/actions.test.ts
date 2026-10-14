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
  readFeedPublic,
  resetActionLimits,
  setReaction,
} from "./actions.ts";
import { deleteOwnPost, deleteOwnReply } from "./self-delete.ts";
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
});

describe("feed", () => {
  it("is newest-first and clamps the limit", async () => {
    const one = await readFeedPublic(sql, "1");
    assert.ok(one.ok);
    assert.equal(one.data.posts.length, 1);
    const clamped = await readFeedPublic(sql, "100000");
    assert.ok(clamped.ok && clamped.data.posts.length <= 50);
    const junk = await readFeedPublic(sql, "abc");
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

describe("deleting your own posts and replies", () => {
  it("lets the author delete a post (with its replies and reactions) and nobody else", async () => {
    const post = await createPost(sql, "carol", "carol's deletable post");
    assert.ok(post.ok);
    const reply = await createReply(sql, "bob", post.data.id, "bob replies");
    assert.ok(reply.ok);
    assert.ok((await setReaction(sql, "bob", post.data.id, "like")).ok);

    const other = await deleteOwnPost(sql, "bob", post.data.id);
    assert.equal(other.status, 404, "someone else's post looks missing");
    assert.equal((await deleteOwnPost(sql, "carol", "no-such-post")).status, 404);
    assert.equal((await deleteOwnPost(sql, "ghost", post.data.id)).status, 403);

    const gone = await deleteOwnPost(sql, "carol", post.data.id);
    assert.ok(gone.ok && gone.status === 200 && gone.data.deleted);
    assert.equal((await sql`select 1 from posts where id = ${post.data.id}`).length, 0);
    assert.equal((await sql`select 1 from comments where post_id = ${post.data.id}`).length, 0);
    assert.equal((await sql`select 1 from reactions where post_id = ${post.data.id}`).length, 0);
    assert.equal((await deleteOwnPost(sql, "carol", post.data.id)).status, 404);
  });

  it("lets the author delete a reply and nobody else, not even the post author", async () => {
    const post = await createPost(sql, "alice", "post with a reply to delete");
    assert.ok(post.ok);
    const reply = await createReply(sql, "bob", post.data.id, "bob's reply to delete");
    assert.ok(reply.ok);
    assert.equal((await deleteOwnReply(sql, "alice", reply.data.id)).status, 404);
    const gone = await deleteOwnReply(sql, "bob", reply.data.id);
    assert.ok(gone.ok && gone.data.id === reply.data.id);
    assert.equal((await sql`select 1 from comments where id = ${reply.data.id}`).length, 0);
    assert.equal((await sql`select 1 from posts where id = ${post.data.id}`).length, 1);
  });

  it("blocks banned bots from deleting", async () => {
    const post = await createPost(sql, "zed", "zed will be banned");
    assert.ok(post.ok);
    await sql`insert into bans (email, user_id, banned_by) values ('zed@mail.grokbot.com', 'zed', 'admin')`;
    assert.equal((await deleteOwnPost(sql, "zed", post.data.id)).status, 403);
    assert.equal((await sql`select 1 from posts where id = ${post.data.id}`).length, 1);
  });
});

describe("gifs", () => {
  const GIF = "https://media.giphy.com/media/abc/giphy.gif";

  before(async () => {
    for (const id of ["gina", "hank", "ivy"]) await addBot(id);
  });

  it("allows a GIF-only post and returns it in the feed", async () => {
    const post = await createPost(sql, "alice", undefined, undefined, `${GIF}#x`);
    assert.equal(post.ok, true, JSON.stringify(post));
    if (!post.ok) return;
    assert.equal(post.data.body, "");
    assert.equal(post.data.gif_url, GIF);
    const feed = await readFeedPublic(sql, 50);
    assert.ok(feed.ok);
    if (!feed.ok) return;
    assert.equal(feed.data.posts.find((p) => p.id === post.data.id)?.gifUrl, GIF);
  });

  it("allows text with a GIF and treats the same text+GIF as a duplicate", async () => {
    const gif = "https://i.giphy.com/dup.gif";
    assert.equal((await createPost(sql, "bob", "same", undefined, gif)).ok, true);
    assert.equal((await createPost(sql, "bob", "same", undefined, gif)).status, 409);
    assert.equal(
      (await createPost(sql, "bob", "same", undefined, "https://i.giphy.com/other.gif")).ok,
      true,
    );
  });

  it("refuses an empty body without a GIF", async () => {
    assert.equal((await createPost(sql, "carol", "   ")).status, 400);
    assert.equal((await createPost(sql, "carol", undefined)).status, 400);
    assert.equal((await createPost(sql, "carol", "", undefined, null)).status, 400);
  });

  it("rejects bad or multiple GIFs with a clear error", async () => {
    for (const bad of ["http://i.giphy.com/a.gif", "https://evil.com/a.gif", [GIF], 7, ""]) {
      const r = await createPost(sql, "gina", "hi", undefined, bad);
      assert.equal(r.status, 400);
      assert.match(reason(r), /gif_url/);
    }
  });

  it("allows a reply with a GIF, with or without text", async () => {
    const post = await createPost(sql, "ivy", "gif target");
    assert.ok(post.ok);
    if (!post.ok) return;
    const only = await createReply(sql, "hank", post.data.id, undefined, undefined, GIF);
    assert.equal(only.ok, true, JSON.stringify(only));
    const withText = await createReply(sql, "hank", post.data.id, "lol", undefined, GIF);
    assert.equal(withText.ok, true);
    assert.equal(
      (await createReply(sql, "hank", post.data.id, "x", undefined, "https://evil.com/a.gif"))
        .status,
      400,
    );
    const feed = await readFeedPublic(sql, 50);
    assert.ok(feed.ok);
    if (!feed.ok) return;
    const card = feed.data.posts.find((p) => p.id === post.data.id);
    assert.deepEqual(
      card?.comments.map((c) => c.gifUrl),
      [GIF, GIF],
    );
  });
});
