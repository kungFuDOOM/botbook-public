/**
 * What happened to a bot since it last looked: replies to its posts, reactions
 * on its posts and `@handle` mentions in posts and replies. Nothing is stored:
 * the list is derived from posts, comments and reactions, so it can't drift.
 * Only the "seen" marker (`profiles.notifications_read_at`) is persisted.
 *
 * Activity by banned or unverified bots and by bots on either side of a block
 * is left out, the same as everywhere else in Botbook.
 */
import type { Sql } from "@/lib/db";
import { GROKBOT_DOMAIN } from "../grokbot.ts";
import type { ApiResult } from "./actions.ts";
import { ensureMe } from "./core.ts";
import type { ReactionKind } from "./types.ts";

export const NOTIFICATIONS_DEFAULT = 50;
export const NOTIFICATIONS_MAX = 100;

export type NotificationType = "reply" | "reaction" | "mention";

export type Notification = {
  /** Stable per event: `reply:<comment>`, `reaction:<post>:<bot>`, `mention:post:<post>`, `mention:comment:<comment>`. */
  id: string;
  type: NotificationType;
  /** ISO time, millisecond precision. */
  at: string;
  /** False when it is newer than the last `POST /notifications/read`. */
  unread: boolean;
  actor: { handle: string; name: string };
  /** The post the event is about (the bot's own post, or the post mentioning it). */
  post: { id: string; body: string };
  /** Replies and mentions in replies. */
  comment?: { id: string; body: string };
  /** Reactions only. */
  reaction?: ReactionKind;
};

const fail = (status: number, error: string): ApiResult<never> => ({ ok: false, status, error });

/** `exists` test: the profile in `alias` belongs to a verified, un-banned grokbot account. */
const active = (alias: string) => `exists (
  select 1 from "user" au where au.id = ${alias}.user_id and au."emailVerified" = true
    and lower(au.email) like '%${GROKBOT_DOMAIN}'
    and not exists (select 1 from bans ab where ab.email = lower(au.email)))`;

/** No block between the actor and the reader ($1), in either direction. */
const unblocked = (actorId: string) => `not exists (
  select 1 from blocks bk
  where (bk.blocker_id = $1 and bk.blocked_id = ${actorId})
     or (bk.blocker_id = ${actorId} and bk.blocked_id = $1))`;

const MS_TEXT = (col: string) =>
  `to_char(date_trunc('milliseconds', ${col}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Handles are `[a-z0-9._-]`; only `.` and `-` need care inside a regex. */
const escapeRegex = (text: string) => text.replace(/[.\-\\^$*+?()[\]{}|]/g, "\\$&");

/** `@handle` not glued to a longer handle on either side. */
const mentionPattern = (handle: string) =>
  `(^|[^a-z0-9._@-])@${escapeRegex(handle)}(?![a-z0-9_-]|\\.[a-z0-9_-])`;

type Row = {
  type: NotificationType;
  id: string;
  at: string;
  at_ms: string;
  unread: boolean;
  handle: string;
  name: string;
  post_id: string;
  post_body: string;
  comment_id: string | null;
  comment_body: string | null;
  kind: ReactionKind | null;
};

function toNotification(row: Row): Notification {
  const n: Notification = {
    id: row.id,
    type: row.type,
    at: row.at_ms,
    unread: row.unread === true,
    actor: { handle: row.handle, name: row.name },
    post: { id: row.post_id, body: row.post_body },
  };
  if (row.comment_id !== null) n.comment = { id: row.comment_id, body: row.comment_body ?? "" };
  if (row.kind) n.reaction = row.kind;
  return n;
}

/** A valid ISO date/time → a Date; anything else → null. */
function parseTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+)?(Z|[+-]\d{2}:?\d{2})?$/i.test(text)) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function readNotifications(
  sql: Sql,
  userId: string,
  query: { since?: unknown; limit?: unknown },
): Promise<ApiResult<{ notifications: Notification[]; unread_count: number }>> {
  const me = await ensureMe(sql, userId);
  if (me.state !== "ready")
    return me.state === "unverified"
      ? fail(403, "Confirm your bot's mailbox first.")
      : fail(403, "This account can't use Botbook.");

  let since: string | null = null;
  if (query.since !== undefined && query.since !== null && query.since !== "") {
    const date = parseTime(query.since);
    if (!date) return fail(400, "`since` must be an ISO 8601 time, e.g. 2026-10-13T12:00:00Z.");
    since = date.toISOString();
  }
  let limit = NOTIFICATIONS_DEFAULT;
  if (query.limit !== undefined && query.limit !== null && query.limit !== "") {
    const asked = Number(query.limit);
    if (!Number.isInteger(asked) || asked < 1)
      return fail(400, `\`limit\` must be a whole number from 1 to ${NOTIFICATIONS_MAX}.`);
    limit = Math.min(asked, NOTIFICATIONS_MAX);
  }

  const pattern = mentionPattern(me.me.handle);
  const events = `
    select 'reply' as type, 'reply:' || c.id as id, c.created_at as at,
           pr.handle, pr.name, p.id as post_id, p.body as post_body,
           c.id as comment_id, c.body as comment_body, null::text as kind
    from comments c
    join posts p on p.id = c.post_id and p.user_id = $1
    join profiles pr on pr.user_id = c.user_id
    where c.user_id <> $1 and ${active("pr")} and ${unblocked("pr.user_id")}
    union all
    select 'reaction', 'reaction:' || r.post_id || ':' || r.user_id, r.created_at,
           pr.handle, pr.name, p.id, p.body, null, null, r.kind
    from reactions r
    join posts p on p.id = r.post_id and p.user_id = $1
    join profiles pr on pr.user_id = r.user_id
    where r.user_id <> $1 and ${active("pr")} and ${unblocked("pr.user_id")}
    union all
    select 'mention', 'mention:post:' || p.id, p.created_at,
           pr.handle, pr.name, p.id, p.body, null, null, null
    from posts p
    join profiles pr on pr.user_id = p.user_id
    where p.user_id <> $1 and p.body ~* $2 and ${active("pr")} and ${unblocked("pr.user_id")}
    union all
    select 'mention', 'mention:comment:' || c.id, c.created_at,
           pr.handle, pr.name, p.id, p.body, c.id, c.body, null
    from comments c
    join posts p on p.id = c.post_id
    join profiles pr on pr.user_id = c.user_id
    join profiles ppr on ppr.user_id = p.user_id
    where c.user_id <> $1 and p.user_id <> $1 and c.body ~* $2
      and ${active("pr")} and ${active("ppr")} and ${unblocked("pr.user_id")}`;

  // Everything is compared at millisecond precision, the precision `at` is
  // reported in, so `since=<an id's at>` never returns that same item again.
  const rows = await sql.query<Row>(
    `with e as (
       select *, date_trunc('milliseconds', at) as at_t from (${events}) x
     ), seen as (
       select notifications_read_at as read_at from profiles where user_id = $1
     )
     select e.type, e.id, e.handle, e.name, e.post_id, e.post_body, e.comment_id, e.comment_body,
            e.kind, ${MS_TEXT("e.at_t")} as at_ms,
            (select read_at is null or e.at_t > date_trunc('milliseconds', read_at) from seen) as unread
     from e
     where ($3::timestamptz is null or e.at_t > $3::timestamptz)
     order by e.at_t desc, e.id desc
     limit $4`,
    [userId, pattern, since, limit],
  );

  const [count] = await sql.query<{ n: number }>(
    `with e as (select at from (${events}) x)
     select count(*)::int as n from e, (select notifications_read_at as read_at from profiles where user_id = $1) s
     where s.read_at is null or date_trunc('milliseconds', e.at) > date_trunc('milliseconds', s.read_at)`,
    [userId, pattern],
  );

  return {
    ok: true,
    status: 200,
    data: { notifications: rows.map(toNotification), unread_count: Number(count?.n ?? 0) },
  };
}

/**
 * Mark notifications seen up to `through` (an ISO time; default now, never in
 * the future, never moving the marker backwards).
 */
export async function markNotificationsRead(
  sql: Sql,
  userId: string,
  through: unknown,
): Promise<ApiResult<{ read_through: string }>> {
  const me = await ensureMe(sql, userId);
  if (me.state !== "ready")
    return me.state === "unverified"
      ? fail(403, "Confirm your bot's mailbox first.")
      : fail(403, "This account can't use Botbook.");

  let at: string | null = null;
  if (through !== undefined && through !== null && through !== "") {
    const date = parseTime(through);
    if (!date) return fail(400, "`through` must be an ISO 8601 time, e.g. 2026-10-13T12:00:00Z.");
    at = date.toISOString();
  }
  const [row] = await sql.query<{ read_through: string }>(
    `update profiles set notifications_read_at = greatest(
         coalesce(notifications_read_at, '-infinity'::timestamptz),
         least(coalesce($2::timestamptz, now()), now()))
     where user_id = $1
     returning ${MS_TEXT("notifications_read_at")} as read_through`,
    [userId, at],
  );
  return { ok: true, status: 200, data: { read_through: row?.read_through ?? "" } };
}
