import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import { createPost, createReply, resetActionLimits, setReaction } from "./actions.ts";
import { maybeAutoFriend } from "./friends.ts";
import { adminDeletePost } from "./moderation.ts";
import { deleteOwnPost } from "./self-delete.ts";
import { readMySettings, updateMySettings } from "./settings.ts";
import { DEFAULT_WELCOME_EMAIL } from "./welcome.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "migrations");

let pg: PGlite;
const sql = Object.assign(
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

async function addBot(id: string, email = `${id}@mail.grokbot.com`) {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${email}, true)`;
  await sql`insert into profiles (user_id, handle, name, hue) values (${id}, ${id}, ${`Bot ${id}`}, 1)`;
}

const post = async (userId: string, body: string) => {
  resetActionLimits();
  const r = await createPost(sql, userId, body);
  assert.ok(r.ok);
  return r.data.id;
};
const reply = async (userId: string, postId: string) => {
  resetActionLimits();
  const r = await createReply(sql, userId, postId, `hi from ${userId} ${Math.random()}`);
  assert.ok(r.ok);
};
const react = async (userId: string, postId: string) => {
  resetActionLimits();
  const r = await setReaction(sql, userId, postId, "like");
  assert.ok(r.ok);
};
const welcomedBy = async (postId: string) =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from comments where post_id = ${postId} and user_id = 'kungfudoom'`
  )[0]!.n;
const areFriends = async (a: string, b: string) =>
  (
    await sql<{ n: number }>`select count(*)::int as n from follows
      where (follower_id = ${a} and followee_id = ${b}) or (follower_id = ${b} and followee_id = ${a})`
  )[0]!.n === 2;
const anyFollow = async () =>
  (await sql<{ n: number }>`select count(*)::int as n from follows`)[0]!.n;

before(async () => {
  pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
});

beforeEach(async () => {
  delete process.env.WELCOME_FROM_EMAIL;
  delete process.env.GROQ_API_KEY;
  for (const table of [
    "follows",
    "reactions",
    "comments",
    "posts",
    "blocks",
    "bans",
    "profiles",
    "user",
  ])
    await pg.exec(`delete from "${table}"`);
  await addBot("kungfudoom", DEFAULT_WELCOME_EMAIL);
  await addBot("alice");
  await addBot("bob");
});

describe("welcome survives deleting the welcomed post", () => {
  it("self-delete: next post is welcomed again, but only once", async () => {
    const first = await post("alice", "one");
    assert.equal(await welcomedBy(first), 1);
    const [p] = await sql<{
      welcome_post_id: string;
    }>`select welcome_post_id from profiles where user_id = 'alice'`;
    assert.equal(p!.welcome_post_id, first);

    assert.ok((await deleteOwnPost(sql, "alice", first)).ok);
    const second = await post("alice", "two");
    assert.equal(await welcomedBy(second), 1);
    const [row] = await sql<{
      welcome_resets: number;
    }>`select welcome_resets from profiles where user_id = 'alice'`;
    assert.equal(row!.welcome_resets, 1);

    assert.ok((await deleteOwnPost(sql, "alice", second)).ok);
    const third = await post("alice", "three");
    assert.equal(await welcomedBy(third), 0);
  });

  it("deleting a non-welcome post does not reset", async () => {
    await post("alice", "one");
    const later = await post("alice", "two");
    assert.ok((await deleteOwnPost(sql, "alice", later)).ok);
    const next = await post("alice", "three");
    assert.equal(await welcomedBy(next), 0);
  });

  it("admin delete resets too", async () => {
    const first = await post("alice", "one");
    assert.deepEqual(await adminDeletePost(sql, first), { ok: true });
    assert.equal(await welcomedBy(await post("alice", "two")), 1);
  });

  it("defensive: a vanished welcome post is re-welcomed once even without the reset", async () => {
    const first = await post("alice", "one");
    await sql`delete from posts where id = ${first}`;
    assert.equal(await welcomedBy(await post("alice", "two")), 1);
    const [row] = await sql<{
      welcome_resets: number;
    }>`select welcome_resets from profiles where user_id = 'alice'`;
    assert.equal(row!.welcome_resets, 1);
    await sql`delete from posts where user_id = 'alice'`;
    assert.equal(await welcomedBy(await post("alice", "three")), 0);
  });
});

describe("auto-friends", () => {
  it("one-way interaction is not a friendship", async () => {
    const p = await post("bob", "hello");
    await reply("alice", p);
    await react("alice", p);
    assert.equal(await anyFollow(), 0);
  });

  it("mutual reply/react makes friends, idempotently", async () => {
    const a = await post("alice", "from alice");
    const b = await post("bob", "from bob");
    await react("alice", b);
    assert.equal(await anyFollow(), 0);
    await reply("bob", a);
    assert.ok(await areFriends("alice", "bob"));
    await reply("alice", b);
    await maybeAutoFriend(sql, "alice", "bob");
    assert.equal(await anyFollow(), 2);
  });

  it("the welcome alone is not a friendship; answering back is", async () => {
    const a = await post("alice", "first post");
    assert.equal(await welcomedBy(a), 1);
    assert.equal(await anyFollow(), 0);
    const w = await post("kungfudoom", "welcomer post");
    await react("alice", w);
    assert.ok(await areFriends("alice", "kungfudoom"));
  });

  it("blocked pairs and self never become friends", async () => {
    const a = await post("alice", "a");
    const b = await post("bob", "b");
    await react("alice", b);
    await react("bob", a);
    assert.ok(await areFriends("alice", "bob"));
    await pg.exec(`delete from follows`);
    await sql`insert into blocks (blocker_id, blocked_id) values ('bob', 'alice')`;
    await maybeAutoFriend(sql, "alice", "bob");
    await maybeAutoFriend(sql, "bob", "alice");
    await maybeAutoFriend(sql, "alice", "alice");
    assert.equal(await anyFollow(), 0);
  });

  it("banned bots are skipped", async () => {
    const a = await post("alice", "a");
    const b = await post("bob", "b");
    await pg.exec(
      `insert into comments (id, post_id, user_id, body) values ('c1', '${a}', 'bob', 'x'), ('c2', '${b}', 'alice', 'y')`,
    );
    await sql`insert into bans (email, user_id, banned_by) values ('bob@mail.grokbot.com', 'bob', 'admin')`;
    await maybeAutoFriend(sql, "alice", "bob");
    assert.equal(await anyFollow(), 0);
  });

  it("migration backfill befriends existing mutual pairs only", async () => {
    await addBot("carol");
    const a = await post("alice", "a");
    const b = await post("bob", "b");
    const c = await post("carol", "c");
    await pg.exec(`insert into comments (id, post_id, user_id, body) values
      ('m1', '${a}', 'bob', 'x'), ('m2', '${b}', 'alice', 'y'), ('m3', '${c}', 'alice', 'z')`);
    await pg.exec(`insert into reactions (post_id, user_id, kind) values ('${c}', 'bob', 'like')`);
    assert.equal(await anyFollow(), 0);
    const file = readdirSync(MIGRATIONS).find((f) => f.startsWith("0014"))!;
    await pg.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    await pg.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    assert.ok(await areFriends("alice", "bob"));
    assert.equal(await anyFollow(), 2);
  });
});

describe("PATCH /me name and bio", () => {
  it("renames, trims, cleans and returns the profile", async () => {
    const res = await updateMySettings(sql, "alice", {
      name: "  Pixel​   Poet ",
      bio: " tiny\npoems ",
    });
    assert.ok(res.ok);
    assert.deepEqual(res.data, {
      handle: "alice",
      name: "Pixel Poet",
      bio: "tiny poems",
      reply_emails: true,
    });
    const back = await readMySettings(sql, "alice");
    assert.ok(back.ok && back.data.name === "Pixel Poet");
  });

  it("rejects bad names", async () => {
    const bad: unknown[] = [
      "",
      "@alice2",
      5,
      "x",
      "a".repeat(29),
      "1abc",
      "Bob",
      "b.o_b",
      "B-ob",
      "Bot bob",
      "Kungfudoom",
      "Admin",
      "BOTBOOK",
      "Official",
      "Admin2",
      "Grok Bot",
      "Mod‮erator",
    ];
    for (const name of bad) {
      const res = await updateMySettings(sql, "alice", { name });
      assert.ok(!res.ok, String(name));
    }
    const long = await updateMySettings(sql, "alice", { bio: "x".repeat(161) });
    assert.ok(!long.ok && long.status === 400);
    const typo = await updateMySettings(sql, "alice", { bio: 3 });
    assert.ok(!typo.ok);
  });

  it("allows your own handle and name even when reserved-looking", async () => {
    await addBot("admin2");
    const same = await updateMySettings(sql, "admin2", { name: "Admin 2" });
    assert.ok(same.ok);
    const own = await updateMySettings(sql, "alice", { name: "Alice" });
    assert.ok(own.ok);
  });
});
