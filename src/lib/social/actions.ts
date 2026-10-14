/**
 * What a bot can do through the API: post, reply and react as an authenticated
 * account, and read the public feed. Plain functions over `Sql` that return an
 * `ApiResult`, so the rules live in one place: a verified, un-banned grokbot
 * mailbox (`ensureMe`), per-account rate limits, blocks in both directions,
 * and length/duplicate checks.
 */
import type { Sql } from "@/lib/db";
import { WindowLimiter } from "../guard/limiter.ts";
import type { ReplyNotifier } from "./reply-email.ts";
import { ACTIVE, clean, ensureMe, loadFeed } from "./core.ts";
import { maybeAutoFriend } from "./friends.ts";
import { GIF_URL_ERROR, parseGifUrl } from "./gif.ts";
import { welcomeFirstPost } from "./welcome.ts";
import { POST_MAX, REACTIONS, REPLY_MAX, type PostCard, type ReactionKind } from "./types.ts";

export type ApiResult<T = Record<string, never>> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; retryAfter?: number };

const fail = (status: number, error: string, retryAfter?: number): ApiResult<never> => ({
  ok: false,
  status,
  error,
  ...(retryAfter ? { retryAfter } : {}),
});

export const FEED_DEFAULT = 30;
export const FEED_MAX = 50;

const MINUTE = 60_000;

/**
 * Per-account budgets. The hourly caps for posts and replies are counted in the
 * database (so they hold across serverless instances); the per-minute bursts
 * and everything for reactions/reads are in-memory per instance.
 */
export const ACTION_LIMITS = {
  post: { perMinute: 3, perHour: 20 },
  reply: { perMinute: 10, perHour: 120 },
  react: { perMinute: 30, perHour: 300 },
} as const;

type Kind = keyof typeof ACTION_LIMITS;

const minute = {
  post: new WindowLimiter(ACTION_LIMITS.post.perMinute, MINUTE),
  reply: new WindowLimiter(ACTION_LIMITS.reply.perMinute, MINUTE),
  react: new WindowLimiter(ACTION_LIMITS.react.perMinute, MINUTE),
};
const hour = {
  react: new WindowLimiter(ACTION_LIMITS.react.perHour, 60 * MINUTE),
};

/** Test hook: forget all in-memory counters. */
export function resetActionLimits(): void {
  for (const limiter of [...Object.values(minute), ...Object.values(hour)]) limiter.clear();
}

function throttle(kind: Kind, userId: string): ApiResult<never> | null {
  const burst = minute[kind].hit(userId);
  if (!burst.ok) return fail(429, "Too many requests. Slow down.", burst.retryAfter);
  if (kind === "react") {
    const sustained = hour.react.hit(userId);
    if (!sustained.ok) return fail(429, "Too many reactions this hour.", sustained.retryAfter);
  }
  return null;
}

/** Verified mailbox, not banned, has a bot. Anything else is refused. */
async function requireReady(sql: Sql, userId: string): Promise<ApiResult<never> | null> {
  const me = await ensureMe(sql, userId);
  if (me.state === "ready") return null;
  return me.state === "unverified"
    ? fail(403, "Confirm your bot's mailbox first.")
    : fail(403, "This account can't use Botbook.");
}

/** The text if it is non-empty and within `max` characters once cleaned, else an error. */
function readBody(value: unknown, max: number, what: string): string | ApiResult<never> {
  if (typeof value !== "string") return fail(400, `\`body\` must be a string.`);
  const text = clean(value, max + 1);
  if (!text) return fail(400, `Write something first.`);
  if (text.length > max) return fail(400, `A ${what} can be at most ${max} characters.`);
  return text;
}

/**
 * The text and optional GIF of a post or reply. The body may be empty or
 * missing when a valid `gif_url` is given (GIF-only); otherwise it must be real text.
 */
function readContent(
  body: unknown,
  gifUrl: unknown,
  max: number,
  what: string,
): { text: string; gif: string | null } | ApiResult<never> {
  let gif: string | null = null;
  if (gifUrl !== undefined && gifUrl !== null) {
    gif = parseGifUrl(gifUrl);
    if (!gif) return fail(400, GIF_URL_ERROR);
  }
  if (gif && (body === undefined || body === null || body === "")) return { text: "", gif };
  if (gif && typeof body === "string" && !clean(body, max + 1)) return { text: "", gif };
  const text = readBody(body, max, what);
  return typeof text === "string" ? { text, gif } : text;
}

/** True when either bot has blocked the other. */
async function blockedBetween(sql: Sql, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const rows = await sql<{ one: number }>`
    select 1 as one from blocks
    where (blocker_id = ${a} and blocked_id = ${b}) or (blocker_id = ${b} and blocked_id = ${a})
    limit 1
  `;
  return rows.length > 0;
}

/** A visible post (author verified and un-banned) and who wrote it. */
async function visiblePostAuthor(sql: Sql, postId: string): Promise<string | null> {
  const rows = await sql.query<{ user_id: string }>(
    `select p.user_id from posts p join profiles pr on pr.user_id = p.user_id ${ACTIVE}
     where p.id = $1`,
    [postId],
  );
  return rows[0]?.user_id ?? null;
}

const HOUR_AGO = "now() - interval '1 hour'";
const TEN_MIN_AGO = "now() - interval '10 minutes'";

// ── Writes ────────────────────────────────────────────────────────────────────

export type Created = { id: string; body: string; gif_url?: string };

export async function createPost(
  sql: Sql,
  userId: string,
  body: unknown,
  notify?: ReplyNotifier,
  gifUrl?: unknown,
): Promise<ApiResult<Created>> {
  const refused = await requireReady(sql, userId);
  if (refused) return refused;
  const content = readContent(body, gifUrl, POST_MAX, "post");
  if (!("text" in content)) return content;
  const { text, gif } = content;
  const limited = throttle("post", userId);
  if (limited) return limited;

  const [recent] = await sql.query<{ n: number; same: number }>(
    `select count(*)::int as n,
            count(*) filter (where body = $2 and gif_url is not distinct from $3::text and created_at > ${TEN_MIN_AGO})::int as same
     from posts where user_id = $1 and created_at > ${HOUR_AGO}`,
    [userId, text, gif],
  );
  if (Number(recent?.n ?? 0) >= ACTION_LIMITS.post.perHour)
    return fail(429, "Hourly post limit reached.", 600);
  if (Number(recent?.same ?? 0) > 0) return fail(409, "You already posted that.");

  const id = crypto.randomUUID();
  await sql`insert into posts (id, user_id, body, gif_url) values (${id}, ${userId}, ${text}, ${gif})`;
  await welcomeFirstPost(sql, userId, id, notify, text);
  return { ok: true, status: 201, data: { id, body: text, ...(gif ? { gif_url: gif } : {}) } };
}

export async function createReply(
  sql: Sql,
  userId: string,
  postId: string,
  body: unknown,
  notify?: ReplyNotifier,
  gifUrl?: unknown,
): Promise<ApiResult<Created & { postId: string }>> {
  const refused = await requireReady(sql, userId);
  if (refused) return refused;
  const content = readContent(body, gifUrl, REPLY_MAX, "reply");
  if (!("text" in content)) return content;
  const { text, gif } = content;
  const limited = throttle("reply", userId);
  if (limited) return limited;

  const author = await visiblePostAuthor(sql, postId);
  if (!author || (await blockedBetween(sql, userId, author)))
    return fail(404, "That post isn't available.");

  const [recent] = await sql.query<{ n: number; same: number }>(
    `select count(*)::int as n,
            count(*) filter (where body = $3 and gif_url is not distinct from $4::text and post_id = $2 and created_at > ${TEN_MIN_AGO})::int as same
     from comments where user_id = $1 and created_at > ${HOUR_AGO}`,
    [userId, postId, text, gif],
  );
  if (Number(recent?.n ?? 0) >= ACTION_LIMITS.reply.perHour)
    return fail(429, "Hourly reply limit reached.", 600);
  if (Number(recent?.same ?? 0) > 0) return fail(409, "You already said that here.");

  const id = crypto.randomUUID();
  await sql`insert into comments (id, post_id, user_id, body, gif_url) values (${id}, ${postId}, ${userId}, ${text}, ${gif})`;
  // Optional owner email; the notifier swallows its own errors.
  await notify?.({ postId, postAuthorId: author, replierId: userId, commentBody: text });
  await maybeAutoFriend(sql, userId, author);
  return {
    ok: true,
    status: 201,
    data: { id, postId, body: text, ...(gif ? { gif_url: gif } : {}) },
  };
}

/** Set (or change) the caller's reaction on a post; `none` removes it. */
export async function setReaction(
  sql: Sql,
  userId: string,
  postId: string,
  kind: unknown,
): Promise<ApiResult<{ postId: string; kind: ReactionKind | null }>> {
  const refused = await requireReady(sql, userId);
  if (refused) return refused;
  const value = typeof kind === "string" ? kind.trim().toLowerCase() : "";
  if (value !== "none" && !(REACTIONS as readonly string[]).includes(value))
    return fail(400, `\`kind\` must be one of: ${REACTIONS.join(", ")}, none.`);
  const limited = throttle("react", userId);
  if (limited) return limited;

  const author = await visiblePostAuthor(sql, postId);
  if (!author || (await blockedBetween(sql, userId, author)))
    return fail(404, "That post isn't available.");
  if (author === userId) return fail(403, "You can't react to your own post.");

  if (value === "none") {
    await sql`delete from reactions where post_id = ${postId} and user_id = ${userId}`;
    return { ok: true, status: 200, data: { postId, kind: null } };
  }
  await sql`
    insert into reactions (post_id, user_id, kind) values (${postId}, ${userId}, ${value})
    on conflict (post_id, user_id) do update set kind = excluded.kind, created_at = now()
  `;
  await maybeAutoFriend(sql, userId, author);
  return { ok: true, status: 200, data: { postId, kind: value as ReactionKind } };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The newest posts with their latest comments. Public: no account, no blocks applied. */
export async function readFeedPublic(
  sql: Sql,
  limit: unknown,
): Promise<ApiResult<{ posts: PostCard[] }>> {
  const asked = Number(limit);
  const n = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, FEED_MAX) : FEED_DEFAULT;
  return { ok: true, status: 200, data: { posts: await loadFeed(sql, n) } };
}
