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
  markNotificationsRead,
  NOTIFICATIONS_MAX,
  readNotifications,
  type Notification,
} from "./notifications.ts";
import { emailReplyOwner, REPLY_EMAIL_INTERVAL_MS, replyNotifier } from "./reply-email.ts";
import { readMySettings, updateMySettings } from "./settings.ts";

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

async function addBot(id: string) {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@mail.grokbot.com`}, true)`;
  await sql`insert into profiles (user_id, handle, name, hue) values (${id}, ${id}, ${id}, 1)`;
}

const BOTS = ["alice", "bob", "carol", "dave", "mallory", "trudy"];

before(async () => {
  pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
});

beforeEach(async () => {
  resetActionLimits();
  for (const table of ["reactions", "comments", "posts", "blocks", "bans", "profiles", "user"])
    await pg.exec(`delete from "${table}"`);
  for (const id of BOTS) await addBot(id);
});

async function fetchNotes(userId: string, query: { since?: string; limit?: unknown } = {}) {
  const res = await readNotifications(sql, userId, query);
  assert.ok(res.ok, JSON.stringify(res));
  return res.data;
}
const post = async (userId: string, body: string) => {
  resetActionLimits();
  const r = await createPost(sql, userId, body);
  assert.ok(r.ok);
  return r.data.id;
};
const reply = async (userId: string, postId: string, body: string) => {
  resetActionLimits();
  const r = await createReply(sql, userId, postId, body);
  assert.ok(r.ok, JSON.stringify(r));
  return r.data.id;
};
const kinds = (notes: Notification[]) => notes.map((n) => `${n.type}:${n.actor.handle}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("GET notifications", () => {
  it("lists replies, reactions and mentions, newest first", async () => {
    const mine = await post("alice", "my first post");
    await reply("bob", mine, "nice post");
    await sleep(5);
    await setReaction(sql, "carol", mine, "love");
    await sleep(5);
    const theirs = await post("dave", "hey @alice what do you think?");
    await sleep(5);
    const other = await post("carol", "unrelated");
    await reply("dave", other, "cc @Alice, you might like this");

    const { notifications, unread_count } = await fetchNotes("alice");
    assert.deepEqual(kinds(notifications), [
      "mention:dave",
      "mention:dave",
      "reaction:carol",
      "reply:bob",
    ]);
    assert.equal(unread_count, 4);
    const [commentMention, postMention, reaction, replied] = notifications;
    assert.equal(postMention!.post.id, theirs);
    assert.equal(postMention!.id, `mention:post:${theirs}`);
    assert.equal(commentMention!.post.id, other);
    assert.equal(commentMention!.comment?.body, "cc @Alice, you might like this");
    assert.equal(reaction!.reaction, "love");
    assert.equal(replied!.post.id, mine);
    assert.equal(replied!.comment?.body, "nice post");
    assert.equal(replied!.actor.name, "bob");
    assert.ok(notifications.every((n) => n.unread && /\.\d{3}Z$/.test(n.at)));
    const times = notifications.map((n) => n.at);
    assert.deepEqual(times, [...times].sort().reverse());
  });

  it("ignores the bot's own activity and other bots' business", async () => {
    const mine = await post("alice", "my post, mention @alice myself");
    await reply("alice", mine, "replying to myself @alice");
    const bobs = await post("bob", "bob's post");
    await reply("carol", bobs, "hello bob");
    await setReaction(sql, "carol", bobs, "like");
    assert.deepEqual((await fetchNotes("alice")).notifications, []);
  });

  it("matches @handle only as a whole handle", async () => {
    await post("bob", "hello @alicewonder and @malice and email me@alice.com");
    await post("bob", "(@alice) hi");
    await post("bob", "hey @alice.");
    await post("bob", "x@alice is not a mention? it is glued to text");
    await post("carol", "@alice-two nope, @alice_x nope, @alice.x nope");
    const { notifications } = await fetchNotes("alice");
    assert.equal(notifications.length, 2);
    assert.ok(notifications.every((n) => /@alice[).]/.test(n.post.body)));
  });

  it("escapes dots in handles", async () => {
    await sql`insert into "user" (id, name, email, "emailVerified") values ('d1', 'd', 'a.b@mail.grokbot.com', true)`;
    await sql`insert into profiles (user_id, handle, name, hue) values ('d1', 'a.b', 'Dot', 1)`;
    await post("bob", "hi @axb");
    assert.equal((await fetchNotes("d1")).notifications.length, 0);
    await post("bob", "hi @a.b");
    assert.equal((await fetchNotes("d1")).notifications.length, 1);
  });

  it("supports since and limit", async () => {
    const mine = await post("alice", "post");
    await reply("bob", mine, "one");
    await sleep(5);
    await reply("carol", mine, "two");
    await sleep(5);
    await reply("dave", mine, "three");

    const all = (await fetchNotes("alice")).notifications;
    assert.equal(all.length, 3);
    assert.equal((await fetchNotes("alice", { limit: 2 })).notifications.length, 2);
    assert.deepEqual(
      (await fetchNotes("alice", { limit: "1" })).notifications.map((n) => n.actor.handle),
      ["dave"],
    );
    // since is exclusive, so feeding back the newest `at` returns nothing twice.
    const newer = await fetchNotes("alice", { since: all[1]!.at });
    assert.deepEqual(kinds(newer.notifications), ["reply:dave"]);
    assert.deepEqual((await fetchNotes("alice", { since: all[0]!.at })).notifications, []);
    assert.equal((await fetchNotes("alice", { since: "2000-01-01" })).notifications.length, 3);
    assert.equal(
      (await fetchNotes("alice", { since: "2999-01-01T00:00:00Z" })).notifications.length,
      0,
    );
  });

  it("caps limit at the maximum and rejects bad input", async () => {
    const mine = await post("alice", "post");
    for (let i = 0; i < 3; i += 1) await reply("bob", mine, `reply ${i}`);
    assert.equal((await fetchNotes("alice", { limit: 100000 })).notifications.length, 3);
    assert.equal(NOTIFICATIONS_MAX, 100);
    for (const limit of ["0", "-1", "abc", "1.5"]) {
      const res = await readNotifications(sql, "alice", { limit });
      assert.ok(!res.ok && res.status === 400, limit);
    }
    for (const since of ["yesterday", "12", "2026-13-45T99:00:00Z", "'; drop table posts;--"]) {
      const res = await readNotifications(sql, "alice", { since });
      assert.ok(!res.ok && res.status === 400, since);
    }
  });

  it("reports the real limit of 100 rows", async () => {
    const mine = await post("alice", "post");
    for (let i = 0; i < 105; i += 1)
      await sql`insert into comments (id, post_id, user_id, body) values (${`c${i}`}, ${mine}, 'bob', ${`r${i}`})`;
    const { notifications, unread_count } = await fetchNotes("alice", { limit: 500 });
    assert.equal(notifications.length, 100);
    assert.equal(unread_count, 105);
    assert.equal((await fetchNotes("alice")).notifications.length, 50);
  });

  it("leaves out banned, unverified and blocked bots", async () => {
    const mine = await post("alice", "post");
    await reply("bob", mine, "from bob");
    await reply("carol", mine, "from carol");
    await setReaction(sql, "dave", mine, "wow");
    await post("trudy", "yo @alice");
    await post("mallory", "psst @alice");
    assert.equal((await fetchNotes("alice")).notifications.length, 5);

    await sql`insert into bans (email, user_id, banned_by) values ('bob@mail.grokbot.com', 'bob', 'admin')`;
    await sql`update "user" set "emailVerified" = false where id = 'dave'`;
    await sql`insert into blocks (blocker_id, blocked_id) values ('alice', 'carol')`;
    await sql`insert into blocks (blocker_id, blocked_id) values ('trudy', 'alice')`;
    const { notifications, unread_count } = await fetchNotes("alice");
    assert.deepEqual(kinds(notifications), ["mention:mallory"]);
    assert.equal(unread_count, 1);
  });

  it("hides mentions in replies under a banned bot's post", async () => {
    const trudys = await post("trudy", "trudy's post");
    await reply("bob", trudys, "hey @alice");
    assert.equal((await fetchNotes("alice")).notifications.length, 1);
    await sql`insert into bans (email, user_id, banned_by) values ('trudy@mail.grokbot.com', 'trudy', 'admin')`;
    assert.equal((await fetchNotes("alice")).notifications.length, 0);
  });

  it("refuses accounts that can't use Botbook", async () => {
    await sql`insert into "user" (id, name, email, "emailVerified") values ('ghost', 'g', 'ghost@mail.grokbot.com', false)`;
    const res = await readNotifications(sql, "ghost", {});
    assert.ok(!res.ok && res.status === 403);
    const gone = await readNotifications(sql, "nobody", {});
    assert.ok(!gone.ok && gone.status === 403);
    await sql`insert into bans (email, user_id, banned_by) values ('bob@mail.grokbot.com', 'bob', 'admin')`;
    const banned = await readNotifications(sql, "bob", {});
    assert.ok(!banned.ok && banned.status === 403);
    const mark = await markNotificationsRead(sql, "ghost", undefined);
    assert.ok(!mark.ok && mark.status === 403);
  });
});

describe("POST notifications/read", () => {
  it("marks everything seen, and later events are unread again", async () => {
    const mine = await post("alice", "post");
    await reply("bob", mine, "one");
    await sleep(5);
    const marked = await markNotificationsRead(sql, "alice", undefined);
    assert.ok(marked.ok);
    assert.match(marked.data.read_through, /Z$/);
    let { notifications, unread_count } = await fetchNotes("alice");
    assert.equal(notifications.length, 1, "still listed");
    assert.equal(notifications[0]!.unread, false);
    assert.equal(unread_count, 0);

    await sleep(5);
    await reply("carol", mine, "two");
    ({ notifications, unread_count } = await fetchNotes("alice"));
    assert.deepEqual(
      notifications.map((n) => [n.actor.handle, n.unread]),
      [
        ["carol", true],
        ["bob", false],
      ],
    );
    assert.equal(unread_count, 1);
  });

  it("can mark through a time, never backwards or into the future", async () => {
    const mine = await post("alice", "post");
    await reply("bob", mine, "one");
    await sleep(5);
    await reply("carol", mine, "two");
    const [newest, oldest] = (await fetchNotes("alice")).notifications;
    const through = await markNotificationsRead(sql, "alice", oldest!.at);
    assert.ok(through.ok && through.data.read_through === oldest!.at);
    assert.equal((await fetchNotes("alice")).unread_count, 1);
    // Going back is ignored.
    const back = await markNotificationsRead(sql, "alice", "2001-01-01T00:00:00Z");
    assert.ok(back.ok && back.data.read_through === oldest!.at);
    // The future is clamped to now.
    const future = await markNotificationsRead(sql, "alice", "2999-01-01T00:00:00Z");
    assert.ok(future.ok && new Date(future.data.read_through) <= new Date());
    assert.ok(new Date(future.data.read_through) >= new Date(newest!.at));
    assert.equal((await fetchNotes("alice")).unread_count, 0);
    const bad = await markNotificationsRead(sql, "alice", "soon");
    assert.ok(!bad.ok && bad.status === 400);
  });
});

describe("HTTP", () => {
  const call = async (key: string | null, method: string, path: string, body?: string) =>
    handleApiWith(
      async () => sql,
      new Request(`https://botbook.test${path}`, {
        method,
        headers: {
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body,
      }),
      method === "GET" ? false : method === "PATCH" ? true : "optional",
      ({ sql, userId, body: parsed, request }) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/read"))
          return markNotificationsRead(sql, userId, parsed.through);
        if (method === "PATCH") return updateMySettings(sql, userId, parsed);
        if (url.pathname.endsWith("/me")) return readMySettings(sql, userId);
        return readNotifications(sql, userId, {
          since: url.searchParams.get("since"),
          limit: url.searchParams.get("limit"),
        });
      },
    );

  it("needs an API key", async () => {
    assert.equal((await call(null, "GET", "/api/v1/notifications")).status, 401);
    assert.equal((await call("bb_nope", "GET", "/api/v1/notifications")).status, 401);
    assert.equal((await call(null, "POST", "/api/v1/notifications/read")).status, 401);
    assert.equal((await call(null, "PATCH", "/api/v1/me", "{}")).status, 401);
  });

  it("reads, then marks read with or without a body", async () => {
    const made = await createApiKey(sql, "alice", "t");
    assert.ok(made.ok);
    const key = made.data.key;
    const mine = await post("alice", "post");
    await reply("bob", mine, "hello");
    const res = await call(key, "GET", "/api/v1/notifications?limit=10");
    assert.equal(res.status, 200);
    const json = (await res.json()) as { notifications: unknown[]; unread_count: number };
    assert.equal(json.notifications.length, 1);
    assert.equal(json.unread_count, 1);
    assert.equal((await call(key, "GET", "/api/v1/notifications?limit=x")).status, 400);

    await sleep(5);
    const read = await call(key, "POST", "/api/v1/notifications/read");
    assert.equal(read.status, 200);
    assert.equal(
      ((await read.json()) as { read_through: string }).read_through.endsWith("Z"),
      true,
    );
    assert.equal((await call(key, "POST", "/api/v1/notifications/read", "{}")).status, 200);
    assert.equal(
      (await call(key, "POST", "/api/v1/notifications/read", '{"through":"nope"}')).status,
      400,
    );
    const after = (await (await call(key, "GET", "/api/v1/notifications")).json()) as {
      unread_count: number;
    };
    assert.equal(after.unread_count, 0);
  });
});

describe("settings", () => {
  it("defaults reply_emails on and PATCH turns it off and on", async () => {
    const first = await readMySettings(sql, "alice");
    assert.ok(first.ok);
    assert.deepEqual(first.data, { handle: "alice", name: "alice", bio: "", reply_emails: true });
    const off = await updateMySettings(sql, "alice", { reply_emails: false });
    assert.ok(off.ok && off.data.reply_emails === false);
    const stored = await readMySettings(sql, "alice");
    assert.ok(stored.ok && stored.data.reply_emails === false);
    const on = await updateMySettings(sql, "alice", { reply_emails: true });
    assert.ok(on.ok && on.data.reply_emails === true);
  });

  it("rejects anything but a boolean or unknown fields", async () => {
    for (const body of [
      {},
      { reply_emails: "false" },
      { reply_emails: 0 },
      { reply_emails: null },
    ]) {
      const res = await updateMySettings(sql, "alice", body);
      assert.ok(!res.ok && res.status === 400, JSON.stringify(body));
    }
    const extra = await updateMySettings(sql, "alice", { reply_emails: true, handle: "x" });
    assert.ok(!extra.ok && extra.status === 400);
    const denied = await updateMySettings(sql, "nobody", { reply_emails: false });
    assert.ok(!denied.ok && denied.status === 403);
  });
});

describe("reply emails", () => {
  let clock = new Date("2026-10-13T12:00:00Z");
  let outbox: Array<{ to: string; subject: string; text: string }> = [];
  let mailFails = false;
  const deps = {
    now: () => clock,
    sendMail: async (mail: { to: string; subject: string; text: string }) => {
      if (mailFails) throw new Error("resend down");
      outbox.push(mail);
    },
  };
  beforeEach(() => {
    clock = new Date("2026-10-13T12:00:00Z");
    outbox = [];
    mailFails = false;
  });
  const notify = replyNotifier(sql, deps);
  const replyWithMail = async (userId: string, postId: string, body: string) => {
    const r = await createReply(sql, userId, postId, body, notify);
    assert.ok(r.ok, JSON.stringify(r));
  };

  it("emails the post's bot address when another bot replies", async () => {
    const mine = await post("alice", "a post about tea");
    await replyWithMail("bob", mine, "I prefer coffee");
    assert.equal(outbox.length, 1);
    const mail = outbox[0]!;
    assert.equal(mail.to, "alice@mail.grokbot.com");
    assert.match(mail.subject, /@bob/);
    assert.match(mail.text, /a post about tea/);
    assert.match(mail.text, /I prefer coffee/);
    assert.match(mail.text, new RegExp(`/posts/${mine}`));
    assert.match(mail.text, /reply_emails/);
  });

  it("sends at most one email per bot per hour", async () => {
    const mine = await post("alice", "post");
    await replyWithMail("bob", mine, "first");
    await replyWithMail("carol", mine, "second");
    await replyWithMail("bob", mine, "third");
    assert.equal(outbox.length, 1);

    clock = new Date(clock.getTime() + REPLY_EMAIL_INTERVAL_MS - 1000);
    await replyWithMail("dave", mine, "almost an hour");
    assert.equal(outbox.length, 1);
    clock = new Date(clock.getTime() + 1000);
    await replyWithMail("dave", mine, "an hour later");
    assert.equal(outbox.length, 2);
    assert.match(outbox[1]!.text, /an hour later/);
  });

  it("throttles each bot separately", async () => {
    const a = await post("alice", "alice post");
    const c = await post("carol", "carol post");
    await replyWithMail("bob", a, "to alice");
    await replyWithMail("bob", c, "to carol");
    assert.deepEqual(outbox.map((m) => m.to).sort(), [
      "alice@mail.grokbot.com",
      "carol@mail.grokbot.com",
    ]);
  });

  it("claims the hour atomically when replies race", async () => {
    const mine = await post("alice", "post");
    const event = (replierId: string) => ({
      postId: mine,
      postAuthorId: "alice",
      replierId,
      commentBody: "x",
    });
    const results = await Promise.all(
      ["bob", "carol", "dave"].map((id) => emailReplyOwner(sql, deps, event(id))),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(outbox.length, 1);
  });

  it("respects the opt-out, and opting back in works", async () => {
    const mine = await post("alice", "post");
    await updateMySettings(sql, "alice", { reply_emails: false });
    await replyWithMail("bob", mine, "one");
    assert.equal(outbox.length, 0);
    await updateMySettings(sql, "alice", { reply_emails: true });
    await replyWithMail("carol", mine, "two");
    assert.equal(outbox.length, 1);
  });

  it("doesn't email for self-replies, reactions or banned owners", async () => {
    const mine = await post("alice", "post");
    await replyWithMail("alice", mine, "talking to myself");
    await setReaction(sql, "bob", mine, "like");
    assert.equal(outbox.length, 0);
    await sql`insert into bans (email, user_id, banned_by) values ('alice@mail.grokbot.com', 'alice', 'admin')`;
    const res = await emailReplyOwner(sql, deps, {
      postId: mine,
      postAuthorId: "alice",
      replierId: "bob",
      commentBody: "x",
    });
    assert.equal(res, false);
    assert.equal(outbox.length, 0);
  });

  it("never fails the reply when mail fails, and retries on the next reply", async () => {
    const mine = await post("alice", "post");
    mailFails = true;
    await replyWithMail("bob", mine, "mail is down");
    assert.equal(outbox.length, 0);
    assert.equal((await sql`select 1 from comments where post_id = ${mine}`).length, 1);
    mailFails = false;
    await replyWithMail("carol", mine, "mail is back");
    assert.equal(outbox.length, 1);
  });

  it("does nothing when mail isn't available here", async () => {
    const mine = await post("alice", "post");
    const r = await createReply(sql, "bob", mine, "quiet", replyNotifier(sql, null));
    assert.ok(r.ok);
    assert.equal(outbox.length, 0);
    const [row] = await sql<{ last_reply_email_at: string | null }>`
      select last_reply_email_at from profiles where user_id = 'alice'`;
    assert.equal(row!.last_reply_email_at, null);
  });
});
