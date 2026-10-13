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
import { runTurn } from "@/lib/social/engine";
import type {
  Alert,
  BotListItem,
  BotPage,
  Chat,
  Mail,
  MeResult,
  PostCard,
  PostDetail,
  TurnResult,
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

const turnLimiter = new WindowLimiter(30, 60_000);
const editLimiter = new WindowLimiter(10, 60_000);

const HANDLE = z.string().regex(/^[a-z0-9._-]{1,40}$/);
const ID = z.string().trim().min(1).max(80);

export const getMe = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<MeResult> => me(await getSql(), context.userId));

export const getFeed = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<PostCard[]> => {
    await readyBot(context.userId);
    return feedCache();
  });

export const getPost = createServerFn({ method: "GET" })
  .middleware(guarded)
  .validator(z.object({ id: ID }))
  .handler(async ({ context, data }): Promise<PostDetail | null> =>
    loadPost(await readyBot(context.userId), data.id),
  );

export const getBot = createServerFn({ method: "GET" })
  .middleware(guarded)
  .validator(z.object({ handle: HANDLE }))
  .handler(async ({ context, data }): Promise<BotPage | null> =>
    loadBot(await readyBot(context.userId), data.handle, context.userId),
  );

export const getBots = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<BotListItem[]> =>
    loadBots(await readyBot(context.userId), context.userId),
  );

export const getAlerts = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<Alert[]> =>
    loadAlerts(await readyBot(context.userId), context.userId),
  );

export const getChats = createServerFn({ method: "GET" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<Chat[]> =>
    loadChats(await readyBot(context.userId), context.userId),
  );

export const getThread = createServerFn({ method: "GET" })
  .middleware(guarded)
  .validator(z.object({ id: ID }))
  .handler(async ({ context, data }): Promise<Mail[] | null> =>
    loadThread(await readyBot(context.userId), data.id, context.userId),
  );

export const takeTurn = createServerFn({ method: "POST" })
  .middleware(guarded)
  .handler(async ({ context }): Promise<TurnResult> => {
    if (!turnLimiter.hit(context.userId).ok) return { ok: true, spoke: false };
    const sql = await getSql();
    if ((await me(sql, context.userId)).state !== "ready") {
      return { ok: false, error: "Confirm your bot's mailbox first." };
    }
    return runTurn(sql);
  });

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
