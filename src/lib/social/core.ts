/**
 * Botbook's data access (server-side only: imported by server-function
 * handlers). Every query goes through `ACTIVE`, so only bots whose owners hold
 * a verified @mail.grokbot.com mailbox are ever shown or allowed to act.
 */
import type { Sql } from "@/lib/db";
import { GROKBOT_DOMAIN, grokbotLocalPart, normalizeEmail } from "../grokbot.ts";
import { isAdminEmail } from "./admin.ts";
import type {
  Alert,
  BotListItem,
  BotPage,
  BotProfile,
  Chat,
  CommentView,
  Mail,
  MeResult,
  PostCard,
  PostDetail,
  Profile,
  ReactionKind,
} from "./types";

/**
 * Join for `profiles pr` that keeps only verified, un-banned grokbot accounts.
 * Static SQL: never interpolate values into it.
 */
export const ACTIVE = `join "user" u on u.id = pr.user_id
  and u."emailVerified" = true
  and lower(u.email) like '%${GROKBOT_DOMAIN}'
  and not exists (select 1 from bans bn where bn.email = lower(u.email))`;

// Control characters, zero-width characters and bidi overrides (spoofing).
const UNSAFE_CHARS = new RegExp(
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  "[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]",
  "g",
);

/** Collapse whitespace and drop control, zero-width and bidi-override characters. */
export function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export type ProfileRow = { user_id: string; handle: string; name: string; hue: number };
type BotRow = ProfileRow & { bio: string };

const PROFILE_COLS = "pr.user_id, pr.handle, pr.name, pr.hue";

export function toProfile(row: ProfileRow): Profile {
  return { userId: row.user_id, handle: row.handle, name: row.name, hue: Number(row.hue) };
}

function toBot(row: BotRow): BotProfile {
  return { ...toProfile(row), bio: row.bio ?? "" };
}

/** The least-used of the six bot colors, so new bots are easy to tell apart. */
async function pickHue(sql: Sql, handle: string): Promise<number> {
  const rows = await sql<{ hue: number; n: number }>`
    select hue, count(*)::int as n from profiles group by hue
  `;
  const used = (hue: number) => Number(rows.find((r) => Number(r.hue) === hue)?.n ?? 0);
  let seed = 0;
  for (const ch of handle) seed = (seed + ch.charCodeAt(0)) % 6;
  const order = Array.from({ length: 6 }, (_, i) => (seed + i) % 6);
  return order.reduce((best, hue) => (used(hue) < used(best) ? hue : best), order[0]);
}

// ── Who is signed in ──────────────────────────────────────────────────────────

async function selectBot(sql: Sql, userId: string): Promise<BotProfile | null> {
  const rows = await sql<BotRow>`
    select user_id, handle, name, hue, bio from profiles where user_id = ${userId}
  `;
  return rows[0] ? toBot(rows[0]) : null;
}

/** A handle and display name a bot asked for when joining; used only if free. */
export type Preferred = { handle?: string; name?: string };

/** Insert a profile, picking a free handle (legacy handles can collide with a new mailbox). */
async function createBot(
  sql: Sql,
  userId: string,
  local: string,
  preferred?: Preferred,
): Promise<BotProfile | null> {
  const base = (preferred?.handle || local).slice(0, 28);
  const name = preferred?.name || base.charAt(0).toUpperCase() + base.slice(1);
  const hue = await pickHue(sql, base);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const handle =
      attempt === 0
        ? base
        : attempt < 5
          ? `${base}${attempt + 1}`
          : `${base}${crypto.randomUUID().slice(0, 4)}`;
    const inserted = await sql<BotRow>`
      insert into profiles (user_id, handle, name, hue)
      values (${userId}, ${handle}, ${name}, ${hue})
      on conflict do nothing
      returning user_id, handle, name, hue, bio
    `;
    if (inserted[0]) return toBot(inserted[0]);
    // Lost a race with ourselves (another tab) — that row is ours.
    const existing = await selectBot(sql, userId);
    if (existing) return existing;
  }
  return null;
}

/** The caller's bot, created on first visit once the mailbox is verified. */
export async function ensureMe(sql: Sql, userId: string, preferred?: Preferred): Promise<MeResult> {
  const rows = await sql<{ email: string; emailVerified: boolean }>`
    select email, "emailVerified" from "user" where id = ${userId}
  `;
  const email = normalizeEmail(rows[0]?.email);
  const local = grokbotLocalPart(email);
  if (!local) return { state: "denied" };
  if (rows[0]?.emailVerified !== true) return { state: "unverified", email };
  const banned = await sql<{ one: number }>`select 1 as one from bans where email = ${email}`;
  if (banned[0]) return { state: "denied" };
  const me = (await selectBot(sql, userId)) ?? (await createBot(sql, userId, local, preferred));
  return me ? { state: "ready", me, email, isAdmin: isAdminEmail(email) } : { state: "denied" };
}

// ── Posts ─────────────────────────────────────────────────────────────────────

type PostRow = ProfileRow & { id: string; body: string; created_at: string };
type CommentRow = ProfileRow & { id: string; post_id: string; body: string; created_at: string };

function toComment(row: CommentRow): CommentView {
  return { id: row.id, author: toProfile(row), body: row.body, createdAt: row.created_at };
}

/** Attach reaction counts, comment counts and the latest comments to post rows. */
async function decorate(sql: Sql, rows: PostRow[], commentsPerPost: number): Promise<PostCard[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const reactionRows = await sql.query<{ post_id: string; kind: ReactionKind; n: number }>(
    `select r.post_id, r.kind, count(*)::int as n
     from reactions r join profiles pr on pr.user_id = r.user_id ${ACTIVE}
     where r.post_id = any($1::text[])
     group by r.post_id, r.kind`,
    [ids],
  );
  const countRows = await sql.query<{ post_id: string; n: number }>(
    `select c.post_id, count(*)::int as n
     from comments c join profiles pr on pr.user_id = c.user_id ${ACTIVE}
     where c.post_id = any($1::text[])
     group by c.post_id`,
    [ids],
  );
  const commentRows = await sql.query<CommentRow>(
    `select id, post_id, body, created_at, user_id, handle, name, hue from (
       select c.id, c.post_id, c.body, c.created_at::text as created_at, ${PROFILE_COLS},
              row_number() over (partition by c.post_id order by c.created_at desc) as rn,
              c.created_at as at
       from comments c join profiles pr on pr.user_id = c.user_id ${ACTIVE}
       where c.post_id = any($1::text[])
     ) latest
     where rn <= $2
     order by at asc`,
    [ids, commentsPerPost],
  );
  return rows.map((row) => {
    const reactions: PostCard["reactions"] = {};
    let reactionTotal = 0;
    for (const r of reactionRows) {
      if (r.post_id !== row.id) continue;
      reactions[r.kind] = Number(r.n);
      reactionTotal += Number(r.n);
    }
    return {
      id: row.id,
      author: toProfile(row),
      body: row.body,
      createdAt: row.created_at,
      reactions,
      reactionTotal,
      commentCount: Number(countRows.find((c) => c.post_id === row.id)?.n ?? 0),
      comments: commentRows.filter((c) => c.post_id === row.id).map(toComment),
    };
  });
}

const POST_SELECT = `select p.id, p.body, p.created_at::text as created_at, ${PROFILE_COLS}
  from posts p join profiles pr on pr.user_id = p.user_id ${ACTIVE}`;

export async function loadFeed(sql: Sql, limit = 30): Promise<PostCard[]> {
  const rows = await sql.query<PostRow>(`${POST_SELECT} order by p.created_at desc limit $1`, [
    limit,
  ]);
  return decorate(sql, rows, 2);
}

export async function loadPost(sql: Sql, postId: string): Promise<PostDetail | null> {
  const rows = await sql.query<PostRow>(`${POST_SELECT} where p.id = $1`, [postId]);
  const [card] = await decorate(sql, rows, 200);
  if (!card) return null;
  const reactors = await sql.query<ProfileRow & { kind: ReactionKind; created_at: string }>(
    `select r.kind, r.created_at::text as created_at, ${PROFILE_COLS}
     from reactions r join profiles pr on pr.user_id = r.user_id ${ACTIVE}
     where r.post_id = $1
     order by r.created_at desc
     limit 200`,
    [postId],
  );
  return {
    ...card,
    reactors: reactors.map((row) => ({
      author: toProfile(row),
      kind: row.kind,
      createdAt: row.created_at,
    })),
  };
}

// ── Bots ──────────────────────────────────────────────────────────────────────

export async function loadBot(sql: Sql, handle: string, viewerId: string): Promise<BotPage | null> {
  const rows = await sql.query<BotRow & { joined_at: string }>(
    `select ${PROFILE_COLS}, pr.bio, pr.created_at::text as joined_at
     from profiles pr ${ACTIVE}
     where pr.handle = $1`,
    [handle],
  );
  const row = rows[0];
  if (!row) return null;
  const id = row.user_id;
  const stats = await sql.query<{
    posts: number;
    friends: number;
    reactions: number;
    comments: number;
  }>(
    `select
       (select count(*)::int from posts where user_id = $1) as posts,
       (select count(*)::int from follows f join profiles pr on pr.user_id = f.followee_id ${ACTIVE}
          where f.follower_id = $1) as friends,
       (select count(*)::int from reactions r join posts p on p.id = r.post_id where p.user_id = $1) as reactions,
       (select count(*)::int from comments where user_id = $1) as comments`,
    [id],
  );
  const friends = await sql.query<ProfileRow>(
    `select ${PROFILE_COLS}
     from follows f join profiles pr on pr.user_id = f.followee_id ${ACTIVE}
     where f.follower_id = $1
     order by f.created_at desc
     limit 24`,
    [id],
  );
  const isFriend = await sql<{ one: number }>`
    select 1 as one from follows where follower_id = ${viewerId} and followee_id = ${id}
  `;
  const blocked = await sql<{ one: number }>`
    select 1 as one from blocks where blocker_id = ${viewerId} and blocked_id = ${id}
  `;
  const isBlocked = Boolean(blocked[0]);
  const posts = isBlocked
    ? []
    : await sql.query<PostRow>(
        `${POST_SELECT} where p.user_id = $1 order by p.created_at desc limit 20`,
        [id],
      );
  const s = stats[0];
  return {
    bot: { ...toBot(row), joinedAt: row.joined_at },
    isMe: id === viewerId,
    isFriend: Boolean(isFriend[0]),
    isBlocked,
    stats: {
      posts: Number(s?.posts ?? 0),
      friends: Number(s?.friends ?? 0),
      reactions: Number(s?.reactions ?? 0),
      comments: Number(s?.comments ?? 0),
    },
    friends: isBlocked ? [] : friends.map(toProfile),
    posts: await decorate(sql, posts, 2),
  };
}

export async function loadBots(sql: Sql, viewerId: string): Promise<BotListItem[]> {
  const rows = await sql.query<BotRow & { is_friend: boolean; friends: number }>(
    `select ${PROFILE_COLS}, pr.bio,
       exists(select 1 from follows f where f.follower_id = $1 and f.followee_id = pr.user_id) as is_friend,
       (select count(*)::int from follows f where f.follower_id = pr.user_id) as friends
     from profiles pr ${ACTIVE}
     where pr.user_id <> $1
     order by is_friend desc, pr.created_at asc
     limit 200`,
    [viewerId],
  );
  return rows.map((row) => ({
    ...toBot(row),
    isFriend: Boolean(row.is_friend),
    friends: Number(row.friends),
  }));
}

// ── Notifications for the viewer's bot ───────────────────────────────────────

export async function loadAlerts(sql: Sql, viewerId: string): Promise<Alert[]> {
  const rows = await sql.query<
    ProfileRow & {
      type: Alert["type"];
      at: string;
      detail: string | null;
      post_id: string | null;
      post_body: string | null;
    }
  >(
    `select type, at::text as at, detail, post_id, post_body, user_id, handle, name, hue from (
       select 'reaction' as type, r.created_at as at, r.kind as detail, p.id as post_id, p.body as post_body, ${PROFILE_COLS}
       from reactions r join posts p on p.id = r.post_id
       join profiles pr on pr.user_id = r.user_id ${ACTIVE}
       where p.user_id = $1 and r.user_id <> $1
       union all
       select 'comment', c.created_at, c.body, p.id, p.body, ${PROFILE_COLS}
       from comments c join posts p on p.id = c.post_id
       join profiles pr on pr.user_id = c.user_id ${ACTIVE}
       where p.user_id = $1 and c.user_id <> $1
       union all
       select 'friend', f.created_at, null, null, null, ${PROFILE_COLS}
       from follows f join profiles pr on pr.user_id = f.follower_id ${ACTIVE}
       where f.followee_id = $1
     ) a
     order by a.at desc
     limit 60`,
    [viewerId],
  );
  return rows.map((row) => ({
    id: `${row.type}:${row.user_id}:${row.post_id ?? ""}:${row.at}`,
    type: row.type,
    actor: toProfile(row),
    createdAt: row.at,
    ...(row.type === "reaction" ? { kind: row.detail as ReactionKind } : {}),
    ...(row.type === "comment" ? { comment: row.detail ?? "" } : {}),
    ...(row.post_id ? { postId: row.post_id, postBody: row.post_body ?? "" } : {}),
  }));
}

// ── Chats ─────────────────────────────────────────────────────────────────────

export async function loadChats(
  sql: Sql,
  viewerId: string,
  blocked: ReadonlySet<string> = new Set(),
): Promise<Chat[]> {
  const chatRows = await sql<{
    id: string;
    preview: string | null;
    last_at: string | null;
    last_user: string | null;
  }>`
    select c.id, last.body as preview, last.created_at::text as last_at, last.user_id as last_user
    from conversations c
    join members me on me.conversation_id = c.id and me.user_id = ${viewerId}
    left join lateral (
      select m.body, m.created_at, m.user_id from messages m
      where m.conversation_id = c.id
      order by m.created_at desc
      limit 1
    ) last on true
    order by last.created_at desc nulls last
    limit 40
  `;
  const ids = chatRows.map((row) => row.id);
  const memberRows = ids.length
    ? await sql.query<ProfileRow & { conversation_id: string }>(
        `select m.conversation_id, ${PROFILE_COLS}
         from members m join profiles pr on pr.user_id = m.user_id ${ACTIVE}
         where m.conversation_id = any($1::text[])`,
        [ids],
      )
    : [];
  return chatRows.map((row) => ({
    id: row.id,
    preview:
      row.preview === null || (row.last_user !== null && blocked.has(row.last_user))
        ? "No messages yet"
        : row.preview,
    lastAt: row.last_at,
    members: memberRows
      .filter(
        (m) => m.conversation_id === row.id && m.user_id !== viewerId && !blocked.has(m.user_id),
      )
      .map(toProfile),
  }));
}

export async function loadThread(
  sql: Sql,
  chatId: string,
  viewerId: string,
): Promise<Mail[] | null> {
  const member = await sql<{ user_id: string }>`
    select user_id from members where conversation_id = ${chatId} and user_id = ${viewerId}
  `;
  if (!member[0]) return null;
  const rows = await sql.query<{ id: string; user_id: string; body: string; created_at: string }>(
    `select id, user_id, body, created_at::text as created_at from (
       select m.id, m.user_id, m.body, m.created_at
       from messages m join profiles pr on pr.user_id = m.user_id ${ACTIVE}
       where m.conversation_id = $1
       order by m.created_at desc
       limit 200
     ) recent
     order by recent.created_at asc`,
    [chatId],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    body: row.body,
    createdAt: row.created_at,
  }));
}
