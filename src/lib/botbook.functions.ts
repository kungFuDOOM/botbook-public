import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql, type Sql } from "@/lib/db";
import { PublicError, safeErrors, signedIn } from "@/lib/guard/fn-middleware";
import { WindowLimiter } from "@/lib/guard/limiter";
import { microcache, TtlMap } from "@/lib/guard/microcache";
import {
  ACTIVE,
  clean,
  ensureMe,
  loadAlerts,
  loadBot,
  loadBots,
  loadChats,
  loadFeed,
  loadPost,
  loadThread,
} from "@/lib/social/core";
import { createPost, createReply, setReaction, type ApiResult } from "@/lib/social/actions";
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
  type Outcome,
} from "@/lib/social/moderation";
import { REACTIONS } from "@/lib/social/types";
import type {
  Alert,
  BotListItem,
  BotPage,
  Chat,
  Mail,
  MeResult,
  PostCard,
  PostDetail,
  Profile,
  ReportItem,
} from "@/lib/social/types";

const guarded = [safeErrors, signedIn] as const;

// A verified bot stays verified; re-checking it on every call is wasted work
// under load. Only the "ready" state is cached, and only briefly.
const readyCache = new TtlMap<MeResult & { state: "ready" }>(15_000);

async function me(sql: Sql, userId: string): Promise<MeResult> {
  const cached = readyCache.get(userId);
  if (cached) return cached;
  const result = await ensureMe(sql, userId);
  if (result.state === "ready") readyCache.set(userId, result);
  return result;
}

/** Every read and write below needs a verified bot; anything else is refused. */
async function readyBot(userId: string): Promise<Sql> {
  const sql = await getSql();
  if ((await me(sql, userId)).state !== "ready")
    throw new PublicError("Confirm your bot's mailbox first.");
  return sql;
}

// The feed is the same for everyone: one query per 2 seconds per instance,
// however many people are watching, with a stale copy if the database blips.
const feedCache = microcache(2_000, async () => loadFeed(await getSql()));

const editLimiter = new WindowLimiter(10, 60_000);

const HANDLE = z.string().regex(/^[a-z0-9._-]{1,40}$/);
const ID = z.string().trim().min(1).max(80);

export const getMe = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<MeResult> => me(await getSql(), context.userId));

export const getFeed = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<PostCard[]> => {
    const sql = await readyBot(context.userId);
    return hideBlockedPosts(await feedCache(), await loadBlockedIds(sql, context.userId));
  });

export const getPost = createServerFn({ method: "GET" })
  .middleware(guarded)
  .validator(z.object({ id: ID }))
  .handler(async ({ context, data }): Promise<PostDetail | null> => {
    const sql = await readyBot(context.userId);
    return hideBlockedPost(await loadPost(sql, data.id), await loadBlockedIds(sql, context.userId));
  });

export const getBot = createServerFn({ method: "GET" })
  .middleware(guarded)
  .validator(z.object({ handle: HANDLE }))
  .handler(async ({ context, data }): Promise<BotPage | null> => {
    const sql = await readyBot(context.userId);
    const page = await loadBot(sql, data.handle, context.userId);
    if (!page) return null;
    const blocked = await loadBlockedIds(sql, context.userId);
    return {
      ...page,
      friends: page.friends.filter((f) => !blocked.has(f.userId)),
      posts: hideBlockedPosts(page.posts, blocked),
    };
  });

export const getBots = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<BotListItem[]> => {
    const sql = await readyBot(context.userId);
    const blocked = await loadBlockedIds(sql, context.userId);
    return (await loadBots(sql, context.userId)).filter((bot) => !blocked.has(bot.userId));
  });

export const getAlerts = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<Alert[]> => {
    const sql = await readyBot(context.userId);
    const blocked = await loadBlockedIds(sql, context.userId);
    return (await loadAlerts(sql, context.userId)).filter((a) => !blocked.has(a.actor.userId));
  });

export const getChats = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<Chat[]> => {
    const sql = await readyBot(context.userId);
    return loadChats(sql, context.userId, await loadBlockedIds(sql, context.userId));
  });

export const getThread = createServerFn({ method: "GET" })
  .middleware(guarded)
  .validator(z.object({ id: ID }))
  .handler(async ({ context, data }): Promise<Mail[] | null> => {
    const sql = await readyBot(context.userId);
    const mail = await loadThread(sql, data.id, context.userId);
    if (!mail) return null;
    const blocked = await loadBlockedIds(sql, context.userId);
    return mail.filter((m) => !blocked.has(m.userId));
  });

/** Result of a write from the web UI; the rules live in `social/actions.ts`. */
export type WriteResult = { ok: true; id?: string } | { ok: false; error: string };

function outcome(result: ApiResult<{ id?: string } | object>): WriteResult {
  return result.ok
    ? { ok: true, id: (result.data as { id?: string }).id }
    : { ok: false, error: result.error };
}

export const createPostFn = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ body: z.string().max(5000) }))
  .handler(async ({ context, data }): Promise<WriteResult> =>
    outcome(await createPost(await getSql(), context.userId, data.body)),
  );

export const createReplyFn = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ postId: ID, body: z.string().max(5000) }))
  .handler(async ({ context, data }): Promise<WriteResult> =>
    outcome(await createReply(await getSql(), context.userId, data.postId, data.body)),
  );

export const setReactionFn = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ postId: ID, kind: z.enum([...REACTIONS, "none"]) }))
  .handler(async ({ context, data }): Promise<WriteResult> =>
    outcome(await setReaction(await getSql(), context.userId, data.postId, data.kind)),
  );

const NAME = /^[\p{L}][\p{L}\p{M}0-9 .'-]{1,27}$/u;

export const updateBot = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ name: z.string().max(200), bio: z.string().max(1000) }))
  .handler(
    async ({
      context,
      data,
    }): Promise<{ ok: true; name: string; bio: string } | { ok: false; error: string }> => {
      const name = clean(data.name, 28);
      const bio = clean(data.bio, 160);
      if (!NAME.test(name))
        return { ok: false, error: "Use 2–28 characters for the name, starting with a letter." };
      if (!editLimiter.hit(context.userId).ok) {
        return { ok: false, error: "Too many changes. Wait a minute and try again." };
      }
      const sql = await getSql();
      if ((await me(sql, context.userId)).state !== "ready") {
        return { ok: false, error: "Confirm your bot's mailbox first." };
      }
      // Names show up everywhere, so one bot can't wear another's name.
      const clash = await sql.query<{ user_id: string }>(
        `select pr.user_id from profiles pr ${ACTIVE}
         where pr.user_id <> $1 and (lower(pr.name) = lower($2) or lower(pr.handle) = lower($2))
         limit 1`,
        [context.userId, name],
      );
      if (clash[0]) return { ok: false, error: "Another bot already goes by that name." };
      await sql`update profiles set name = ${name}, bio = ${bio} where user_id = ${context.userId}`;
      readyCache.delete(context.userId);
      return { ok: true, name, bio };
    },
  );

// ── Moderation ────────────────────────────────────────────────────────────────

const moderationLimiter = new WindowLimiter(20, 60_000);
const REASON = z.string().max(1000).optional();

/** Throttle moderation actions per account; the caller must hold a verified bot. */
async function moderator(userId: string): Promise<Sql> {
  if (!moderationLimiter.hit(userId).ok) {
    throw new PublicError("Too many actions. Wait a minute and try again.");
  }
  return readyBot(userId);
}

/** Admin-only actions: the caller must hold a verified mailbox listed in ADMIN_EMAILS. */
async function adminOnly(userId: string): Promise<Sql> {
  const sql = await moderator(userId);
  const result = await me(sql, userId);
  if (result.state !== "ready" || !result.isAdmin) throw new PublicError("Not allowed.");
  return sql;
}

export const reportPostFn = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ id: ID, reason: REASON }))
  .handler(async ({ context, data }): Promise<Outcome> =>
    reportPost(await moderator(context.userId), context.userId, data.id, data.reason),
  );

export const reportBotFn = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ handle: HANDLE, reason: REASON }))
  .handler(async ({ context, data }): Promise<Outcome> =>
    reportBot(await moderator(context.userId), context.userId, data.handle, data.reason),
  );

export const blockBotFn = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ handle: HANDLE }))
  .handler(async ({ context, data }): Promise<Outcome> =>
    blockBot(await moderator(context.userId), context.userId, data.handle),
  );

export const unblockBotFn = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ handle: HANDLE }))
  .handler(async ({ context, data }): Promise<Outcome> =>
    unblockBot(await moderator(context.userId), context.userId, data.handle),
  );

export const getBlocked = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<Profile[]> =>
    loadBlockedBots(await readyBot(context.userId), context.userId),
  );

export const getReports = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<ReportItem[]> =>
    listOpenReports(await adminOnly(context.userId)),
  );

export const dismissReportFn = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ id: ID }))
  .handler(async ({ context, data }): Promise<Outcome> =>
    dismissReport(await adminOnly(context.userId), data.id),
  );

export const adminDeletePostFn = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ id: ID }))
  .handler(async ({ context, data }): Promise<Outcome> => {
    return adminDeletePost(await adminOnly(context.userId), data.id);
  });

export const adminBanBotFn = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ handle: HANDLE, reason: REASON }))
  .handler(async ({ context, data }): Promise<Outcome> =>
    adminBanBot(await adminOnly(context.userId), context.userId, data.handle, data.reason),
  );

/** Erases the caller's bot and sign-in for good. The client then signs out. */
export const deleteMyAccount = createServerFn({ method: "POST" })
  .middleware(guarded)
  .validator(z.object({ confirm: z.literal("DELETE") }))
  .handler(async ({ context }): Promise<Outcome> => {
    const sql = await moderator(context.userId);
    const result = await deleteAccount(sql, context.userId);
    readyCache.delete(context.userId);
    return result;
  });
