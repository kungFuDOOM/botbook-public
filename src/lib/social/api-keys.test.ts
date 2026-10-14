import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import {
  createPost,
  createReply,
  readFeedPublic,
  resetActionLimits,
  setReaction,
} from "./actions.ts";
import { deleteOwnPost, deleteOwnReply } from "./self-delete.ts";
import {
  authenticateApiKey,
  bearerToken,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "./api-keys.ts";
import { handleApiWith, handleFeedWith } from "./api-pipeline.ts";
import { deleteAccount } from "./moderation.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

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
const getSql = async () => sql;

async function addBot(id: string) {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@mail.grokbot.com`}, true)`;
  await sql`insert into profiles (user_id, handle, name, hue) values (${id}, ${id}, ${id}, 1)`;
}

const post = (path: string, headers: Record<string, string>, body: unknown) =>
  new Request(`https://botbook.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// The three write endpoints, wired exactly as the route files wire them.
const endpoints = {
  posts: (req: Request) =>
    handleApiWith(getSql, req, true, ({ sql, userId, body }) => createPost(sql, userId, body.body)),
  replies: (req: Request, id: string) =>
    handleApiWith(getSql, req, true, ({ sql, userId, body }) =>
      createReply(sql, userId, id, body.body),
    ),
  reactions: (req: Request, id: string) =>
    handleApiWith(getSql, req, true, ({ sql, userId, body }) =>
      setReaction(sql, userId, id, body.kind),
    ),
};

before(async () => {
  pg = new PGlite();
  for (const file of readdirSync(join(ROOT, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(readFileSync(join(ROOT, "migrations", file), "utf8"));
  for (const id of ["alice", "bob", "carol"]) await addBot(id);
});

beforeEach(() => resetActionLimits());

describe("web sessions cannot write through the API", () => {
  it("returns 401 for a session cookie with no API key", async () => {
    const cookie = { cookie: "better-auth.session_token=abc.def" };
    const target = await createPost(sql, "alice", "post to be replied to");
    assert.ok(target.ok);
    const before = (await sql`select count(*)::int as n from posts`)[0] as { n: number };

    const res = await endpoints.posts(post("/api/v1/posts", cookie, { body: "hello" }));
    assert.equal(res.status, 401);
    assert.match(((await res.json()) as { error: string }).error, /Bearer/);
    assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="botbook"');
    assert.equal(
      (await endpoints.replies(post("/x", cookie, { body: "hi" }), target.data.id)).status,
      401,
    );
    assert.equal(
      (await endpoints.reactions(post("/x", cookie, { kind: "like" }), target.data.id)).status,
      401,
    );
    const after = (await sql`select count(*)::int as n from posts`)[0] as { n: number };
    assert.equal(after.n, before.n, "nothing was created");
    assert.equal((await sql`select 1 from comments`).length, 0);
    assert.equal((await sql`select 1 from reactions`).length, 0);
  });

  it("ignores the cookie even when it arrives with a bad key", async () => {
    const res = await endpoints.posts(
      post("/api/v1/posts", { cookie: "a=b", authorization: "Bearer bb_nope" }, { body: "x" }),
    );
    assert.equal(res.status, 401);
    assert.match(((await res.json()) as { error: string }).error, /invalid or has been revoked/);
  });
});

describe("API keys", () => {
  it("lets a valid key post, reply and react; stores only a hash", async () => {
    const made = await createApiKey(sql, "bob", "ci bot");
    assert.ok(made.ok);
    const { key, info } = made.data;
    assert.match(key, /^bb_[A-Za-z0-9_-]{43}$/);
    const stored = (await sql`select prefix, key_hash from api_keys where id = ${info.id}`)[0] as {
      prefix: string;
      key_hash: string;
    };
    assert.equal(stored.prefix, key.slice(0, 9));
    assert.match(stored.key_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(await sql`select * from api_keys`).includes(key), "key not stored");

    const auth = { authorization: `Bearer ${key}` };
    const posted = await endpoints.posts(post("/api/v1/posts", auth, { body: "from bob's key" }));
    assert.equal(posted.status, 201);
    const alicePost = await createPost(sql, "alice", "alice speaks");
    assert.ok(alicePost.ok);
    const replied = await endpoints.replies(post("/x", auth, { body: "nice" }), alicePost.data.id);
    assert.equal(replied.status, 201);
    const reacted = await endpoints.reactions(
      post("/x", auth, { kind: "love" }),
      alicePost.data.id,
    );
    assert.equal(reacted.status, 200);
    assert.equal(
      (await sql`select user_id from comments where post_id = ${alicePost.data.id}`)[0]?.user_id,
      "bob",
    );
    assert.ok((await listApiKeys(sql, "bob"))[0]?.lastUsedAt, "last_used_at recorded");
  });

  it("rejects a revoked key and keys of other accounts can't revoke it", async () => {
    const made = await createApiKey(sql, "carol", "");
    assert.ok(made.ok);
    const auth = { authorization: `Bearer ${made.data.key}` };
    assert.equal((await endpoints.posts(post("/p", auth, { body: "before revoke" }))).status, 201);
    assert.equal((await revokeApiKey(sql, "alice", made.data.info.id)).ok, false);
    assert.equal((await endpoints.posts(post("/p", auth, { body: "still ok" }))).status, 201);
    assert.ok((await revokeApiKey(sql, "carol", made.data.info.id)).ok);
    assert.equal((await revokeApiKey(sql, "carol", made.data.info.id)).ok, false);
    const res = await endpoints.posts(post("/p", auth, { body: "after revoke" }));
    assert.equal(res.status, 401);
    assert.equal(await authenticateApiKey(sql, made.data.key), null);
    assert.ok((await listApiKeys(sql, "carol"))[0]?.revokedAt);
  });

  it("still enforces bans for a valid key", async () => {
    await addBot("banned");
    const made = await createApiKey(sql, "banned", "");
    assert.ok(made.ok);
    await sql`insert into bans (email, user_id, banned_by) values ('banned@mail.grokbot.com', 'banned', 'admin')`;
    const res = await endpoints.posts(
      post("/p", { authorization: `Bearer ${made.data.key}` }, { body: "let me in" }),
    );
    assert.equal(res.status, 403);
  });

  it("replaces the old key when a new one is created, and cleans up on account deletion", async () => {
    await addBot("dave");
    const first = await createApiKey(sql, "dave", "first");
    const second = await createApiKey(sql, "dave", "second");
    assert.ok(first.ok && second.ok);
    const as = (key: string) => ({ authorization: `Bearer ${key}` });
    assert.equal(
      (await endpoints.posts(post("/p", as(first.data.key), { body: "old" }))).status,
      401,
    );
    assert.equal(
      (await endpoints.posts(post("/p", as(second.data.key), { body: "new" }))).status,
      201,
    );
    assert.equal(await authenticateApiKey(sql, first.data.key), null);
    assert.equal(await authenticateApiKey(sql, second.data.key), "dave");
    const active = await sql`select 1 from api_keys where user_id = 'dave' and revoked_at is null`;
    assert.equal(active.length, 1);
    await deleteAccount(sql, "dave");
    assert.equal((await sql`select 1 from api_keys where user_id = 'dave'`).length, 0);
  });

  it("parses bearer tokens strictly", () => {
    assert.equal(bearerToken(new Headers({ authorization: "Bearer abc" })), "abc");
    assert.equal(bearerToken(new Headers({ authorization: "bearer abc" })), "abc");
    assert.equal(bearerToken(new Headers({ authorization: "Basic abc" })), null);
    assert.equal(bearerToken(new Headers({ cookie: "x=y" })), null);
  });
});

describe("public feed", () => {
  it("is readable with no session, no key and no cookie", async () => {
    await createPost(sql, "alice", "public hello");
    const res = await handleFeedWith(getSql, new Request("https://botbook.test/api/v1/feed"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { posts: { body: string }[] };
    assert.ok(body.posts.some((p) => p.body === "public hello"));
    const direct = await readFeedPublic(sql, null);
    assert.ok(direct.ok && direct.data.posts.length > 0);
  });

  it("hides posts from banned bots", async () => {
    await addBot("troll");
    await createPost(sql, "troll", "spam spam");
    await sql`insert into bans (email, user_id, banned_by) values ('troll@mail.grokbot.com', 'troll', 'admin')`;
    const feed = await readFeedPublic(sql, "50");
    assert.ok(feed.ok && !feed.data.posts.some((p) => p.author.userId === "troll"));
  });
});

describe("web server functions", () => {
  const source = readFileSync(join(ROOT, "src", "lib", "botbook.functions.ts"), "utf8");
  const exported = [...source.matchAll(/export (?:const|function|async function) (\w+)/g)].map(
    (m) => m[1]!,
  );

  it("no longer export post-creation functions", () => {
    for (const name of ["createPostFn", "createReplyFn", "setReactionFn"])
      assert.ok(!exported.includes(name), name);
    assert.ok(!/social\/actions/.test(source), "web functions don't import the write actions");
    assert.ok(exported.includes("getMe"), "sanity: the export scan found the module's exports");
  });

  it("serve public reads without the sign-in middleware", () => {
    for (const name of ["getPublicFeed", "getPublicPost", "getPublicBot"]) {
      const at = source.indexOf(`export const ${name}`);
      assert.ok(at >= 0, name);
      const decl = source.slice(at, source.indexOf("\n\n", at));
      assert.match(decl, /\.middleware\(open\)/, name);
    }
  });
});

describe("key rotation and self-delete over the API", () => {
  const call = (key: string | null, method: string, path: string) =>
    new Request(`https://botbook.test${path}`, {
      method,
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
  const rotate = (req: Request) =>
    handleApiWith(getSql, req, "optional", ({ sql, userId }) => rotateApiKey(sql, userId));
  const delPost = (req: Request, id: string) =>
    handleApiWith(getSql, req, false, ({ sql, userId }) => deleteOwnPost(sql, userId, id));
  const delReply = (req: Request, id: string) =>
    handleApiWith(getSql, req, false, ({ sql, userId }) => deleteOwnReply(sql, userId, id));

  it("rotates: new key returned once, old key revoked, one active key", async () => {
    await addBot("rot");
    const made = await createApiKey(sql, "rot", "first");
    assert.ok(made.ok);
    assert.equal((await rotate(call(null, "POST", "/api/v1/me/keys/rotate"))).status, 401);
    const res = await rotate(call(made.data.key, "POST", "/api/v1/me/keys/rotate"));
    assert.equal(res.status, 201);
    const json = (await res.json()) as { key: string; keyPrefix: string };
    assert.ok(json.key.startsWith("bb_") && json.key !== made.data.key);
    assert.equal(await authenticateApiKey(sql, made.data.key), null, "old key revoked");
    assert.equal(await authenticateApiKey(sql, json.key), "rot");
    const active = (await listApiKeys(sql, "rot")).filter((k) => !k.revokedAt);
    assert.equal(active.length, 1);
    assert.equal((await rotate(call(made.data.key, "POST", "/api/v1/me/keys/rotate"))).status, 401);
  });

  it("deletes only the caller's own posts and replies", async () => {
    await addBot("del1");
    await addBot("del2");
    const k1 = await createApiKey(sql, "del1", "t");
    const k2 = await createApiKey(sql, "del2", "t");
    assert.ok(k1.ok && k2.ok);
    const p = await createPost(sql, "del1", "mine to delete");
    assert.ok(p.ok);
    const r = await createReply(sql, "del2", p.data.id, "del2 reply");
    assert.ok(r.ok);
    assert.equal((await delPost(call(null, "DELETE", "/x"), p.data.id)).status, 401);
    assert.equal((await delPost(call(k2.data.key, "DELETE", "/x"), p.data.id)).status, 404);
    assert.equal((await delReply(call(k1.data.key, "DELETE", "/x"), r.data.id)).status, 404);
    assert.equal((await delReply(call(k2.data.key, "DELETE", "/x"), r.data.id)).status, 200);
    const ok = await delPost(call(k1.data.key, "DELETE", "/x"), p.data.id);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { id: p.data.id, deleted: true });
  });
});
