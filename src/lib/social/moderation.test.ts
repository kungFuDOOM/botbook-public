import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import { adminEmails, isAdminEmail } from "./admin.ts";
import { ensureMe, loadBot, loadFeed, loadPost } from "./core.ts";
import {
  adminBanBot,
  adminDeletePost,
  blockBot,
  deleteAccount,
  dismissReport,
  hideBlockedPost,
  hideBlockedPosts,
  listOpenReports,
  loadBlockedBots,
  loadBlockedIds,
  reportBot,
  reportPost,
  unblockBot,
} from "./moderation.ts";

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

const ADMIN = "boss@mail.grokbot.com";
const ENV = { ADMIN_EMAILS: ` ${ADMIN.toUpperCase()} , other@mail.grokbot.com ` };

async function addBot(
  id: string,
  handle: string,
  opts: { verified?: boolean; domain?: string } = {},
) {
  const email = `${handle}${opts.domain ?? "@mail.grokbot.com"}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${handle}, ${email}, ${opts.verified ?? true})`;
  await sql`insert into profiles (user_id, handle, name, hue) values (${id}, ${handle}, ${handle}, 1)`;
}
const addPost = (id: string, userId: string, body = "hello") =>
  sql`insert into posts (id, user_id, body) values (${id}, ${userId}, ${body})`;

before(async () => {
  pg = new PGlite();
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) await pg.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  await addBot("u-alice", "alice");
  await addBot("u-bob", "bob");
  await addBot("u-carol", "carol");
  await addBot("u-boss", "boss");
  await addBot("u-ghost", "ghost", { verified: false });
  await addBot("u-viewer", "viewer", { domain: "@viewer.grok.invalid" });
  await addPost("p-alice", "u-alice", "alice post");
  await addPost("p-bob", "u-bob", "bob post");
  await addPost("p-carol", "u-carol", "carol post");
  await sql`insert into comments (id, post_id, user_id, body) values ('c1', 'p-carol', 'u-bob', 'bob says hi')`;
  await sql`insert into reactions (post_id, user_id, kind) values ('p-carol', 'u-bob', 'like')`;
});

describe("admin allowlist", () => {
  it("parses a comma-separated list case-insensitively", () => {
    assert.deepEqual([...adminEmails(ENV)], [ADMIN, "other@mail.grokbot.com"]);
    assert.equal(isAdminEmail("BOSS@mail.grokbot.com", ENV), true);
  });
  it("is empty by default", () => {
    assert.equal(adminEmails({}).size, 0);
    assert.equal(isAdminEmail("boss@mail.grokbot.com", {}), false);
    assert.equal(isAdminEmail("", { ADMIN_EMAILS: "," }), false);
  });
});

describe("ensureMe and the gate/viewer rule", () => {
  it("denies a non-grokbot account and holds back an unverified one", async () => {
    assert.deepEqual(await ensureMe(sql, "u-viewer"), { state: "denied" });
    assert.equal((await ensureMe(sql, "u-ghost")).state, "unverified");
  });
  it("never shows unverified or non-grokbot bots", async () => {
    const authors = (await loadFeed(sql)).map((p) => p.author.handle);
    assert.ok(!authors.includes("ghost") && !authors.includes("viewer"));
  });
});

describe("blocks", () => {
  it("records, lists and removes a block", async () => {
    assert.deepEqual(await blockBot(sql, "u-alice", "bob"), { ok: true });
    assert.deepEqual(await blockBot(sql, "u-alice", "bob"), { ok: true }); // idempotent
    assert.deepEqual([...(await loadBlockedIds(sql, "u-alice"))], ["u-bob"]);
    assert.deepEqual(
      (await loadBlockedBots(sql, "u-alice")).map((p) => p.handle),
      ["bob"],
    );
    assert.equal((await loadBlockedIds(sql, "u-bob")).size, 0, "blocking is one-way");
  });
  it("hides the blocked bot's posts and comments from the blocker only", async () => {
    const blocked = await loadBlockedIds(sql, "u-alice");
    const feed = await loadFeed(sql);
    const seen = hideBlockedPosts(feed, blocked);
    assert.ok(!seen.some((p) => p.author.handle === "bob"));
    const carol = seen.find((p) => p.id === "p-carol");
    assert.equal(carol?.comments.length, 0);
    assert.equal(carol?.commentCount, 0);
    assert.ok(hideBlockedPosts(feed, new Set()).some((p) => p.author.handle === "bob"));
  });
  it("hides a blocked author's post page and their reactions", async () => {
    const blocked = await loadBlockedIds(sql, "u-alice");
    assert.equal(hideBlockedPost(await loadPost(sql, "p-bob"), blocked), null);
    const carol = hideBlockedPost(await loadPost(sql, "p-carol"), blocked);
    assert.equal(carol?.reactors.length, 0);
    assert.equal(carol?.reactionTotal, 0);
  });
  it("marks the profile page as blocked and withholds its posts", async () => {
    const page = await loadBot(sql, "bob", "u-alice");
    assert.equal(page?.isBlocked, true);
    assert.equal(page?.posts.length, 0);
    assert.equal((await loadBot(sql, "bob", "u-carol"))?.isBlocked, false);
  });
  it("refuses self-blocks and unknown bots, and unblocks", async () => {
    assert.equal((await blockBot(sql, "u-alice", "alice")).ok, false);
    assert.equal((await blockBot(sql, "u-alice", "nobody")).ok, false);
    assert.deepEqual(await unblockBot(sql, "u-alice", "bob"), { ok: true });
    assert.equal((await loadBlockedIds(sql, "u-alice")).size, 0);
  });
});

describe("reports", () => {
  it("files a post report once per reporter", async () => {
    assert.deepEqual(await reportPost(sql, "u-alice", "p-bob", "spam  ‮ link"), { ok: true });
    assert.deepEqual(await reportPost(sql, "u-alice", "p-bob", "again"), { ok: true });
    await reportPost(sql, "u-carol", "p-bob", "rude");
    const open = await listOpenReports(sql);
    const forBob = open.filter((r) => r.targetId === "p-bob");
    assert.equal(forBob.length, 2);
    assert.equal(forBob[0].count, 2);
    assert.equal(forBob[0].excerpt, "bob post");
    assert.equal(forBob[0].handle, "bob");
    assert.ok(forBob.every((r) => !r.reason.includes("‮")));
  });
  it("files a bot report and rejects bad targets", async () => {
    assert.deepEqual(await reportBot(sql, "u-alice", "carol", "impersonation"), { ok: true });
    assert.equal((await reportBot(sql, "u-alice", "alice", "")).ok, false);
    assert.equal(
      (await reportBot(sql, "u-alice", "ghost", "")).ok,
      false,
      "unverified is invisible",
    );
    assert.equal((await reportPost(sql, "u-bob", "p-bob", "")).ok, false, "own post");
    assert.equal((await reportPost(sql, "u-bob", "nope", "")).ok, false);
    const bot = (await listOpenReports(sql)).find((r) => r.kind === "bot");
    assert.equal(bot?.handle, "carol");
  });
  it("lets a report be dismissed", async () => {
    const [first] = await listOpenReports(sql);
    await dismissReport(sql, first.id);
    assert.ok(!(await listOpenReports(sql)).some((r) => r.id === first.id));
  });
});

describe("admin actions", () => {
  it("deletes a post, with its comments, and closes its reports", async () => {
    assert.deepEqual(await adminDeletePost(sql, "p-carol"), { ok: true });
    assert.equal(await loadPost(sql, "p-carol"), null);
    const left = await sql`select 1 from comments where post_id = 'p-carol'`;
    assert.equal(left.length, 0);
    assert.equal((await adminDeletePost(sql, "p-carol")).ok, false);
  });
  it("bans a bot: hidden everywhere, sessions ended, ban survives re-signup", async () => {
    await sql`insert into "session" (id, "expiresAt", token, "updatedAt", "userId")
      values ('s1', now() + interval '1 day', 't1', now(), 'u-bob')`;
    assert.deepEqual(await adminBanBot(sql, "u-boss", "bob", "abuse", ENV), { ok: true });
    assert.equal((await sql`select 1 from "session" where "userId" = 'u-bob'`).length, 0);
    assert.deepEqual(await ensureMe(sql, "u-bob"), { state: "denied" });
    assert.ok(!(await loadFeed(sql)).some((p) => p.author.handle === "bob"));
    assert.equal(await loadBot(sql, "bob", "u-alice"), null);
    assert.equal((await reportBot(sql, "u-alice", "bob", "")).ok, false);
    // Delete the account and sign up again under the same mailbox: still banned.
    await deleteAccount(sql, "u-bob");
    await addBot("u-bob2", "bob");
    assert.deepEqual(await ensureMe(sql, "u-bob2"), { state: "denied" });
  });
  it("refuses to ban yourself, an admin, or an unknown bot", async () => {
    assert.equal((await adminBanBot(sql, "u-boss", "boss", "", ENV)).ok, false);
    assert.equal((await adminBanBot(sql, "u-alice", "boss", "", ENV)).ok, false);
    assert.equal((await adminBanBot(sql, "u-boss", "nobody", "", ENV)).ok, false);
  });
  it("marks only allowlisted verified mailboxes as admin", async () => {
    process.env.ADMIN_EMAILS = ADMIN;
    try {
      const boss = await ensureMe(sql, "u-boss");
      const alice = await ensureMe(sql, "u-alice");
      assert.equal(boss.state === "ready" && boss.isAdmin, true);
      assert.equal(alice.state === "ready" && alice.isAdmin, false);
    } finally {
      delete process.env.ADMIN_EMAILS;
    }
  });
});

describe("account deletion", () => {
  it("erases the bot, its content, relations and sign-in, and leaves others intact", async () => {
    await sql`insert into follows (follower_id, followee_id) values ('u-carol', 'u-alice'), ('u-alice', 'u-carol')`;
    await sql`insert into reactions (post_id, user_id, kind) values ('p-alice', 'u-carol', 'love')`;
    await sql`insert into comments (id, post_id, user_id, body) values ('c2', 'p-alice', 'u-carol', 'hi')`;
    await sql`insert into conversations (id) values ('conv')`;
    await sql`insert into members (conversation_id, user_id) values ('conv', 'u-carol'), ('conv', 'u-alice')`;
    await sql`insert into messages (id, conversation_id, user_id, body) values ('m1', 'conv', 'u-carol', 'yo')`;
    await sql`insert into "account" (id, "accountId", "providerId", "userId", "updatedAt")
      values ('a1', 'u-carol', 'credential', 'u-carol', now())`;
    await sql`insert into "verification" (id, identifier, value, "expiresAt")
      values ('v1', 'carol@mail.grokbot.com', 'x', now() + interval '1 day')`;
    await sql`insert into blocks (blocker_id, blocked_id) values ('u-carol', 'u-alice'), ('u-alice', 'u-carol')`;
    await addPost("p-carol2", "u-carol");
    await sql`insert into reactions (post_id, user_id, kind) values ('p-carol2', 'u-alice', 'like')`;

    assert.deepEqual(await deleteAccount(sql, "u-carol"), { ok: true });

    for (const [table, col] of [
      ["profiles", "user_id"],
      ["posts", "user_id"],
      ["comments", "user_id"],
      ["reactions", "user_id"],
      ["messages", "user_id"],
      ["members", "user_id"],
      ["follows", "follower_id"],
      ["follows", "followee_id"],
      ["blocks", "blocker_id"],
      ["blocks", "blocked_id"],
      ["reports", "reporter_id"],
      ['"session"', '"userId"'],
      ['"account"', '"userId"'],
      ['"user"', "id"],
    ]) {
      const rows = await pg.query(`select 1 from ${table} where ${col} = 'u-carol'`);
      assert.equal(rows.rows.length, 0, `${table}.${col}`);
    }
    assert.equal(
      (await pg.query(`select 1 from reactions where post_id = 'p-carol2'`)).rows.length,
      0,
    );
    assert.equal(
      (await pg.query(`select 1 from "verification" where identifier = 'carol@mail.grokbot.com'`))
        .rows.length,
      0,
    );
    // Others untouched.
    assert.ok((await loadFeed(sql)).some((p) => p.author.handle === "alice"));
    assert.equal((await pg.query(`select 1 from "user" where id = 'u-alice'`)).rows.length, 1);
    assert.equal((await deleteAccount(sql, "u-carol")).ok, false);
  });
});
