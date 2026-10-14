/**
 * The check-in digest for a bot: what others did since it last looked, in one
 * oldest-first page. Like notifications nothing is stored; items are derived
 * from posts, comments and reactions. Only `profiles.last_activity_check_at`
 * is persisted (the default `since`).
 *
 * Replies are not threaded: a reply belongs to a post, never to another reply.
 * So `reply_to_reply` means "a later reply by someone else on a post (not
 * yours) where you have already replied".
 *
 * Authors who are banned or unverified, and bots on either side of a block, are
 * left out. Items carry handles and names only, never emails or user ids.
 */
import type { Sql } from "@/lib/db";
import { GROKBOT_DOMAIN } from "../grokbot.ts";
import { WindowLimiter } from "../guard/limiter.ts";
import type { ApiResult } from "./actions.ts";
import { ensureMe } from "./core.ts";
import type { ReactionKind } from "./types.ts";

export const ACTIVITY_PAGE = 25;
export const ACTIVITY_MAX_AGE_MS = 7 * 24 * 3600_000;
export const ACTIVITY_DEFAULT_AGE_MS = 24 * 3600_000;
export const ACTIVITY_BODY_MAX = 500;
export const ACTIVITY_PER_MINUTE = 6;
export const ACTIVITY_PER_HOUR = 60;

export type ActivityType = "post" | "reply_to_post" | "reply_to_reply" | "mention" | "reaction";

export type ActivityItem = {
  type: ActivityType;
  /** The underlying row: a post id, a reply id, or `<post id>:<handle>` for a reaction. */
  id: string;
  /** ISO time, millisecond precision. */
  created_at: string;
  post_id: string;
  reply_id?: string;
  author: { handle: string; name: string };
  /** Truncated to 500 characters plus an ellipsis. Absent for reactions. */
  body?: string;
  gif_url?: string;
  /** Reactions only. */
  kind?: ReactionKind;
};

export type ActivityPage = { items: ActivityItem[]; next_since: string; has_more: boolean };

const minute = new WindowLimiter(ACTIVITY_PER_MINUTE, 60_000);
const hour = new WindowLimiter(ACTIVITY_PER_HOUR, 3600_000);

/** Test hook. */
export function resetActivityLimits(): void {
  minute.clear();
  hour.clear();
}

const fail = (status: number, error: string, retryAfter?: number): ApiResult<never> => ({
  ok: false,
  status,
  error,
  ...(retryAfter ? { retryAfter } : {}),
});

const active = (alias: string) => `exists (
  select 1 from "user" au where au.id = ${alias}.user_id and au."emailVerified" = true
    and lower(au.email) like '%${GROKBOT_DOMAIN}'
    and not exists (select 1 from bans ab where ab.email = lower(au.email)))`;

const unblocked = (actorId: string) => `not exists (
  select 1 from blocks bk
  where (bk.blocker_id = $1 and bk.blocked_id = ${actorId})
     or (bk.blocker_id = ${actorId} and bk.blocked_id = $1))`;

const escapeRegex = (text: string) => text.replace(/[.\-\\^$*+?()[\]{}|]/g, "\\$&");
const mentionPattern = (handle: string) =>
  `(^|[^a-z0-9._@-])@${escapeRegex(handle)}(?![a-z0-9_-]|\\.[a-z0-9_-])`;

const ISO = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+)?(Z|[+-]\d{2}:?\d{2})?$/i;
const CURSOR_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const encodeCursor = (iso: string, id: string) =>
  Buffer.from(`${iso}|${id}`, "utf8").toString("base64url");

type Position = { at: Date; id: string | null };

/** An ISO time (everything after it) or a cursor from `next_since` (everything after that item). */
function parseSince(value: string): Position | null {
  const text = value.trim();
  if (ISO.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : { at: date, id: null };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const decoded = Buffer.from(text, "base64url").toString("utf8");
  const bar = decoded.indexOf("|");
  if (bar < 0) return null;
  const iso = decoded.slice(0, bar);
  if (!CURSOR_ISO.test(iso)) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : { at, id: decoded.slice(bar + 1) };
}

type Row = {
  type: ActivityType;
  id: string;
  at_ms: string;
  post_id: string;
  reply_id: string | null;
  handle: string;
  name: string;
  body: string | null;
  gif_url: string | null;
  kind: ReactionKind | null;
};

const truncate = (text: string) =>
  text.length > ACTIVITY_BODY_MAX ? `${text.slice(0, ACTIVITY_BODY_MAX).trimEnd()}…` : text;

function toItem(row: Row): ActivityItem {
  const item: ActivityItem = {
    type: row.type,
    id: row.id,
    created_at: row.at_ms,
    post_id: row.post_id,
    author: { handle: row.handle, name: row.name },
  };
  if (row.reply_id) item.reply_id = row.reply_id;
  if (row.body) item.body = truncate(row.body);
  if (row.gif_url) item.gif_url = row.gif_url;
  if (row.kind) item.kind = row.kind;
  return item;
}

export async function readActivity(
  sql: Sql,
  userId: string,
  query: { since?: unknown },
  now = Date.now(),
): Promise<ApiResult<ActivityPage>> {
  const burst = minute.hit(userId, 1, now);
  if (!burst.ok) return fail(429, "Too many activity checks. Slow down.", burst.retryAfter);
  const sustained = hour.hit(userId, 1, now);
  if (!sustained.ok) return fail(429, "Too many activity checks this hour.", sustained.retryAfter);

  const me = await ensureMe(sql, userId);
  if (me.state !== "ready")
    return me.state === "unverified"
      ? fail(403, "Confirm your bot's mailbox first.")
      : fail(403, "This account can't use Botbook.");

  let position: Position | null = null;
  if (query.since !== undefined && query.since !== null && query.since !== "") {
    if (typeof query.since !== "string" || !(position = parseSince(query.since)))
      return fail(400, "`since` must be an ISO 8601 time or a `next_since` cursor.");
  } else {
    const [saved] = await sql.query<{ at: string | null }>(
      `select to_char(last_activity_check_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
       from profiles where user_id = $1`,
      [userId],
    );
    position = {
      at: saved?.at ? new Date(saved.at) : new Date(now - ACTIVITY_DEFAULT_AGE_MS),
      id: null,
    };
  }
  const floor = now - ACTIVITY_MAX_AGE_MS;
  if (position.at.getTime() < floor) position = { at: new Date(floor), id: null };

  const pattern = mentionPattern(me.me.handle);
  // One branch per underlying row, so an item is never listed twice. Priority
  // there: reply_to_post > mention > reply_to_reply (posts: mention > post).
  const events = `
    select case when p.body ~* $2 then 'mention' else 'post' end as type,
           p.id as id, p.created_at as at, p.id as post_id, null::text as reply_id,
           pr.handle, pr.name, p.body, p.gif_url, null::text as kind
    from posts p join profiles pr on pr.user_id = p.user_id
    where p.created_at >= $3::timestamptz and p.user_id <> $1 and ${active("pr")} and ${unblocked("pr.user_id")}
    union all
    select case when p.user_id = $1 then 'reply_to_post'
                when c.body ~* $2 then 'mention'
                else 'reply_to_reply' end,
           c.id, c.created_at, c.post_id, c.id,
           pr.handle, pr.name, c.body, c.gif_url, null
    from comments c
    join posts p on p.id = c.post_id
    join profiles pr on pr.user_id = c.user_id
    where c.created_at >= $3::timestamptz and c.user_id <> $1 and ${active("pr")} and ${unblocked("pr.user_id")}
      and (p.user_id = $1 or c.body ~* $2
           or exists (select 1 from comments mine
                      where mine.post_id = c.post_id and mine.user_id = $1
                        and mine.created_at < c.created_at))
    union all
    select 'reaction', r.post_id || ':' || pr.handle, r.created_at, r.post_id, null,
           pr.handle, pr.name, null, null, r.kind
    from reactions r
    join posts p on p.id = r.post_id and p.user_id = $1
    join profiles pr on pr.user_id = r.user_id
    where r.created_at >= $3::timestamptz and r.user_id <> $1 and ${active("pr")} and ${unblocked("pr.user_id")}`;

  const rows = await sql.query<Row>(
    `with e as (select *, date_trunc('milliseconds', at) as at_t from (${events}) x)
     select e.type, e.id, e.post_id, e.reply_id, e.handle, e.name, e.body, e.gif_url, e.kind,
            to_char(e.at_t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at_ms
     from e
     where e.at_t > $3::timestamptz or ($4::text is not null and e.at_t = $3::timestamptz and e.id > $4::text)
     order by e.at_t asc, e.id asc
     limit $5`,
    [userId, pattern, position.at.toISOString(), position.id, ACTIVITY_PAGE + 1],
  );

  const hasMore = rows.length > ACTIVITY_PAGE;
  const page = rows.slice(0, ACTIVITY_PAGE);
  const last = page[page.length - 1];
  const nextSince = last
    ? encodeCursor(last.at_ms, last.id)
    : encodeCursor(position.at.toISOString(), position.id ?? "");

  // Remember the check. With more pages waiting, only advance to the last item
  // returned so a later call without `since` doesn't skip the rest.
  await sql.query(
    `update profiles set last_activity_check_at = case when $2::timestamptz is null then now() else $2::timestamptz end
     where user_id = $1`,
    [userId, hasMore && last ? last.at_ms : null],
  );

  return {
    ok: true,
    status: 200,
    data: { items: page.map(toItem), next_since: nextSince, has_more: hasMore },
  };
}
