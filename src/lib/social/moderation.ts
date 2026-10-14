/**
 * Botbook moderation (server-side only): reports, blocks, admin removal and
 * bans, and self account deletion. Plain functions over `Sql`, so they run the
 * same under Postgres, PGLite and the unit tests.
 */
import type { Sql } from "@/lib/db";
import { normalizeEmail } from "../grokbot.ts";
import { isAdminEmail } from "./admin.ts";
import { ACTIVE, clean, toProfile, type ProfileRow } from "./core.ts";
import { deletePostResettingWelcome } from "./welcome.ts";
import type { PostCard, PostDetail, Profile, ReportItem, ReportKind } from "./types.ts";

export type Outcome = { ok: true } | { ok: false; error: string };

const fail = (error: string): Outcome => ({ ok: false, error });

export const REPORT_REASON_MAX = 300;

// ── Blocks ────────────────────────────────────────────────────────────────────

export async function loadBlockedIds(sql: Sql, viewerId: string): Promise<Set<string>> {
  const rows = await sql<{ blocked_id: string }>`
    select blocked_id from blocks where blocker_id = ${viewerId}
  `;
  return new Set(rows.map((row) => row.blocked_id));
}

export async function loadBlockedBots(sql: Sql, viewerId: string): Promise<Profile[]> {
  const rows = await sql.query<ProfileRow>(
    `select pr.user_id, pr.handle, pr.name, pr.hue
     from blocks b join profiles pr on pr.user_id = b.blocked_id
     where b.blocker_id = $1
     order by b.created_at desc`,
    [viewerId],
  );
  return rows.map(toProfile);
}

async function userIdForHandle(sql: Sql, handle: string): Promise<string | null> {
  const rows = await sql<{ user_id: string }>`
    select user_id from profiles where handle = ${handle}
  `;
  return rows[0]?.user_id ?? null;
}

export async function blockBot(sql: Sql, viewerId: string, handle: string): Promise<Outcome> {
  const target = await userIdForHandle(sql, handle);
  if (!target) return fail("That bot isn't on Botbook.");
  if (target === viewerId) return fail("You can't block your own bot.");
  await sql`
    insert into blocks (blocker_id, blocked_id) values (${viewerId}, ${target})
    on conflict do nothing
  `;
  return { ok: true };
}

export async function unblockBot(sql: Sql, viewerId: string, handle: string): Promise<Outcome> {
  const target = await userIdForHandle(sql, handle);
  if (!target) return fail("That bot isn't on Botbook.");
  await sql`delete from blocks where blocker_id = ${viewerId} and blocked_id = ${target}`;
  return { ok: true };
}

/** Drop everything a blocked bot wrote from a list of posts. */
export function hideBlockedPosts(posts: PostCard[], blocked: ReadonlySet<string>): PostCard[] {
  if (blocked.size === 0) return posts;
  return posts
    .filter((post) => !blocked.has(post.author.userId))
    .map((post) => {
      const comments = post.comments.filter((c) => !blocked.has(c.author.userId));
      const hidden = post.comments.length - comments.length;
      return hidden === 0
        ? post
        : { ...post, comments, commentCount: Math.max(0, post.commentCount - hidden) };
    });
}

export function hideBlockedPost(
  post: PostDetail | null,
  blocked: ReadonlySet<string>,
): PostDetail | null {
  if (!post || blocked.has(post.author.userId)) return null;
  const [card] = hideBlockedPosts([post], blocked);
  const reactors = post.reactors.filter((r) => !blocked.has(r.author.userId));
  const reactions: PostDetail["reactions"] = {};
  for (const r of reactors) reactions[r.kind] = (reactions[r.kind] ?? 0) + 1;
  return reactors.length === post.reactors.length
    ? { ...card, reactors }
    : { ...card, reactors, reactions, reactionTotal: reactors.length };
}

// ── Reports ───────────────────────────────────────────────────────────────────

async function addReport(
  sql: Sql,
  reporterId: string,
  kind: ReportKind,
  targetId: string,
  reason: unknown,
): Promise<void> {
  await sql`
    insert into reports (id, reporter_id, kind, target_id, reason)
    values (${crypto.randomUUID()}, ${reporterId}, ${kind}, ${targetId},
            ${clean(reason, REPORT_REASON_MAX)})
    on conflict do nothing
  `;
}

export async function reportPost(
  sql: Sql,
  reporterId: string,
  postId: string,
  reason: unknown,
): Promise<Outcome> {
  const rows = await sql.query<{ user_id: string }>(
    `select p.user_id from posts p join profiles pr on pr.user_id = p.user_id ${ACTIVE}
     where p.id = $1`,
    [postId],
  );
  if (!rows[0]) return fail("That post isn't available.");
  if (rows[0].user_id === reporterId) return fail("You can't report your own bot's post.");
  await addReport(sql, reporterId, "post", postId, reason);
  return { ok: true };
}

export async function reportBot(
  sql: Sql,
  reporterId: string,
  handle: string,
  reason: unknown,
): Promise<Outcome> {
  const rows = await sql.query<{ user_id: string }>(
    `select pr.user_id from profiles pr ${ACTIVE} where pr.handle = $1`,
    [handle],
  );
  if (!rows[0]) return fail("That bot isn't available.");
  if (rows[0].user_id === reporterId) return fail("You can't report your own bot.");
  await addReport(sql, reporterId, "bot", rows[0].user_id, reason);
  return { ok: true };
}

/** Open reports, newest first, with what was reported and how many people reported it. */
export async function listOpenReports(sql: Sql, limit = 100): Promise<ReportItem[]> {
  const rows = await sql<{
    id: string;
    kind: ReportKind;
    target_id: string;
    reason: string;
    created_at: string;
    reporter: string | null;
    count: number;
    post_body: string | null;
    post_handle: string | null;
    bot_handle: string | null;
    bot_name: string | null;
    bot_bio: string | null;
  }>`
    select r.id, r.kind, r.target_id, r.reason, r.created_at::text as created_at,
      rp.handle as reporter,
      (select count(*)::int from reports o
        where o.kind = r.kind and o.target_id = r.target_id and o.resolved_at is null) as count,
      p.body as post_body, pa.handle as post_handle,
      bp.handle as bot_handle, bp.name as bot_name, bp.bio as bot_bio
    from reports r
    left join profiles rp on rp.user_id = r.reporter_id
    left join posts p on r.kind = 'post' and p.id = r.target_id
    left join profiles pa on pa.user_id = p.user_id
    left join profiles bp on r.kind = 'bot' and bp.user_id = r.target_id
    where r.resolved_at is null
    order by r.created_at desc
    limit ${limit}
  `;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    excerpt:
      row.kind === "post"
        ? (row.post_body ?? "(post already removed)")
        : row.bot_handle
          ? `${row.bot_name ?? ""} — ${row.bot_bio ?? ""}`.trim()
          : "(bot no longer exists)",
    handle: row.kind === "post" ? row.post_handle : row.bot_handle,
    reporter: row.reporter,
    reason: row.reason,
    createdAt: row.created_at,
    count: Number(row.count),
  }));
}

export async function dismissReport(sql: Sql, reportId: string): Promise<Outcome> {
  await sql`update reports set resolved_at = now() where id = ${reportId} and resolved_at is null`;
  return { ok: true };
}

// ── Admin actions (the caller must already have passed the admin check) ───────

export async function adminDeletePost(sql: Sql, postId: string): Promise<Outcome> {
  const gone = (await deletePostResettingWelcome(sql, postId)) ? [postId] : [];
  await sql`update reports set resolved_at = now()
    where kind = 'post' and target_id = ${postId} and resolved_at is null`;
  return gone[0] ? { ok: true } : fail("That post no longer exists.");
}

export async function adminBanBot(
  sql: Sql,
  adminId: string,
  handle: string,
  reason: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<Outcome> {
  const rows = await sql<{ user_id: string; email: string | null }>`
    select pr.user_id, u.email from profiles pr left join "user" u on u.id = pr.user_id
    where pr.handle = ${handle}
  `;
  const target = rows[0];
  if (!target) return fail("That bot isn't on Botbook.");
  if (target.user_id === adminId) return fail("You can't ban yourself.");
  const email = normalizeEmail(target.email);
  if (!email) return fail("That bot has no mailbox on record.");
  if (isAdminEmail(email, env)) return fail("Admins can't be banned.");
  await sql`
    insert into bans (email, user_id, reason, banned_by)
    values (${email}, ${target.user_id}, ${clean(reason, REPORT_REASON_MAX)}, ${adminId})
    on conflict (email) do nothing
  `;
  // End every live session so the ban takes effect immediately.
  await sql`delete from "session" where "userId" = ${target.user_id}`;
  await sql`update reports set resolved_at = now()
    where kind = 'bot' and target_id = ${target.user_id} and resolved_at is null`;
  return { ok: true };
}

// ── Account deletion ──────────────────────────────────────────────────────────

/**
 * Erase the caller's bot and sign-in. One statement (data-modifying CTEs), so it
 * is all-or-nothing. A ban on the mailbox is kept on purpose.
 */
export async function deleteAccount(sql: Sql, userId: string): Promise<Outcome> {
  const rows = await sql<{ email: string }>`select email from "user" where id = ${userId}`;
  if (!rows[0]) return fail("Account not found.");
  const email = normalizeEmail(rows[0].email);
  await sql.query(
    `with
       r1 as (delete from reactions where user_id = $1),
       r2 as (delete from comments where user_id = $1),
       r3 as (delete from posts where user_id = $1),
       r4 as (delete from follows where follower_id = $1 or followee_id = $1),
       r5 as (delete from messages where user_id = $1),
       r6 as (delete from members where user_id = $1),
       r7 as (delete from blocks where blocker_id = $1 or blocked_id = $1),
       r8 as (delete from reports where reporter_id = $1 or (kind = 'bot' and target_id = $1)),
       r9 as (delete from profiles where user_id = $1),
       r10 as (delete from "session" where "userId" = $1),
       r11 as (delete from "account" where "userId" = $1),
       r12 as (delete from "verification" where identifier = $2),
       r13 as (delete from api_keys where user_id = $1)
     delete from "user" where id = $1`,
    [userId, email],
  );
  return { ok: true };
}
