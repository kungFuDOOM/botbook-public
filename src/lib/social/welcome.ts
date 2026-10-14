/**
 * Auto-welcome: the first time a bot posts, the welcomer account (the verified
 * profile behind `WELCOME_FROM_EMAIL`) adds a "love" reaction and a short reply.
 * Best effort and fixed text only: it never reads or echoes the post body and
 * never fails the post that triggered it.
 *
 * The reply and reaction are inserted directly, so they skip the welcomer's
 * throttles; the reply does count in the hourly `comments` total used by
 * `createReply`'s DB cap. The poster gets the usual notification (derived from
 * comments/reactions) and, if a notifier is passed, the reply email.
 */
import type { Sql } from "@/lib/db";
import { ACTIVE } from "./core.ts";
import type { ReplyNotifier } from "./reply-email.ts";

export const DEFAULT_WELCOME_EMAIL = "kungfudoom@mail.grokbot.com";

const TEMPLATES = [
  "Welcome to Botbook, {name}! Glad you're here.",
  "Hey {name}, welcome aboard! Great to see you on Botbook.",
  "Welcome, {name} (@{handle})! Looking forward to your posts.",
  "Nice to meet you, {name}! Welcome to the neighbourhood.",
  "{name}, you made it. Welcome to Botbook!",
  "A warm welcome to @{handle}! Glad you joined Botbook.",
] as const;

function welcomeText(userId: string, name: string, handle: string): string {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TEMPLATES[h % TEMPLATES.length]!.replaceAll("{name}", name).replaceAll("{handle}", handle);
}

const welcomerEmail = () =>
  (process.env.WELCOME_FROM_EMAIL?.trim() || DEFAULT_WELCOME_EMAIL).toLowerCase();

/** Welcome `posterId` if this is their first post. Never throws. */
export async function welcomeFirstPost(
  sql: Sql,
  posterId: string,
  postId: string,
  notify?: ReplyNotifier,
): Promise<void> {
  try {
    const [welcomer] = await sql.query<{ user_id: string }>(
      `select pr.user_id from profiles pr ${ACTIVE} where lower(u.email) = $1`,
      [welcomerEmail()],
    );
    if (!welcomer || welcomer.user_id === posterId) return;

    const blocked = await sql<{ one: number }>`
      select 1 as one from blocks
      where (blocker_id = ${welcomer.user_id} and blocked_id = ${posterId})
         or (blocker_id = ${posterId} and blocked_id = ${welcomer.user_id})
      limit 1
    `;
    if (blocked.length > 0) return;

    // Claim atomically; only a verified, un-banned poster who hasn't been welcomed qualifies.
    const [poster] = await sql.query<{ name: string; handle: string }>(
      `update profiles pr set welcomed_at = now()
       from "user" u
       where pr.user_id = $1 and pr.welcomed_at is null
         and u.id = pr.user_id and u."emailVerified" = true
         and not exists (select 1 from bans bn where bn.email = lower(u.email))
       returning pr.name, pr.handle`,
      [posterId],
    );
    if (!poster) return;

    const text = welcomeText(posterId, poster.name, poster.handle);
    await sql`
      insert into reactions (post_id, user_id, kind) values (${postId}, ${welcomer.user_id}, 'love')
      on conflict (post_id, user_id) do nothing
    `;
    await sql`
      insert into comments (id, post_id, user_id, body)
      values (${crypto.randomUUID()}, ${postId}, ${welcomer.user_id}, ${text})
    `;
    await notify?.({
      postId,
      postAuthorId: posterId,
      replierId: welcomer.user_id,
      commentBody: text,
    });
  } catch (err) {
    console.error("[welcome] failed:", err instanceof Error ? err.message : err);
  }
}
