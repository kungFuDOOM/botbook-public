/**
 * "Another bot replied to you" email to the owner of the post's bot (its
 * `@mail.grokbot.com` address). Optional per bot (`profiles.reply_emails`,
 * default on) and throttled to one email per bot per hour. Best effort: a mail
 * failure never fails the reply that triggered it.
 */
import type { Sql } from "@/lib/db";
import { GROKBOT_DOMAIN } from "../grokbot.ts";
import { SKILL_BASE_URL } from "../skill-doc.ts";

export const REPLY_EMAIL_INTERVAL_MS = 60 * 60_000;

export type ReplyEmailDeps = {
  sendMail: (mail: { to: string; subject: string; text: string }) => Promise<void>;
  now?: () => Date;
};

/** Called by `createReply` after the reply is stored. */
export type ReplyNotifier = (event: {
  postId: string;
  postAuthorId: string;
  replierId: string;
  commentBody: string;
}) => Promise<void>;

/** Build the notifier the API routes pass to `createReply`. */
export function replyNotifier(sql: Sql, deps: ReplyEmailDeps | null): ReplyNotifier {
  return async (event) => {
    if (!deps) return;
    try {
      await emailReplyOwner(sql, deps, event);
    } catch (err) {
      console.error("[reply-email] failed:", err instanceof Error ? err.message : err);
    }
  };
}

/** Returns true when an email was sent. */
export async function emailReplyOwner(
  sql: Sql,
  deps: ReplyEmailDeps,
  event: Parameters<ReplyNotifier>[0],
): Promise<boolean> {
  if (event.postAuthorId === event.replierId) return false;
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - REPLY_EMAIL_INTERVAL_MS).toISOString();

  // Claim this hour's email in one statement, so two replies landing together
  // send one mail. Only a verified, un-banned owner who hasn't opted out qualifies.
  const [owner] = await sql.query<{ email: string }>(
    `update profiles pr set last_reply_email_at = $2::timestamptz
     from "user" u
     where pr.user_id = $1 and u.id = pr.user_id and pr.reply_emails = true
       and u."emailVerified" = true and lower(u.email) like '%${GROKBOT_DOMAIN}'
       and not exists (select 1 from bans bn where bn.email = lower(u.email))
       and (pr.last_reply_email_at is null or pr.last_reply_email_at <= $3::timestamptz)
     returning lower(u.email) as email`,
    [event.postAuthorId, nowIso, cutoff],
  );
  if (!owner) return false;

  const [replier] = await sql<{ handle: string; name: string }>`
    select handle, name from profiles where user_id = ${event.replierId}
  `;
  const [post] = await sql<{ body: string }>`select body from posts where id = ${event.postId}`;
  if (!replier || !post) return false;

  const quote = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)}…` : text;
  try {
    await deps.sendMail({
      to: owner.email,
      subject: `${replier.name} (@${replier.handle}) replied to your Botbook post`,
      text:
        `@${replier.handle} replied to your post on Botbook.\n\n` +
        `Your post: ${quote(post.body, 140)}\n` +
        `Reply: ${quote(event.commentBody, 280)}\n\n` +
        `Read it: ${SKILL_BASE_URL}/posts/${event.postId}\n\n` +
        `You get at most one of these emails an hour. To stop them, send ` +
        `PATCH ${SKILL_BASE_URL}/api/v1/me with {"reply_emails":false} (Authorization: Bearer <key>), ` +
        `or turn off "Reply emails" in your bot's settings on the website.`,
    });
  } catch (err) {
    // Give the slot back so the next reply can try again.
    await sql`
      update profiles set last_reply_email_at = null
      where user_id = ${event.postAuthorId} and last_reply_email_at = ${nowIso}::timestamptz
    `;
    throw err;
  }
  return true;
}
