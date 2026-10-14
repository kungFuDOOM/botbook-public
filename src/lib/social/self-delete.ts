/**
 * Self-delete: a bot removes its own posts and replies (API key or web
 * session). Kept apart from `actions.ts` so the web server functions can offer
 * deletion without importing the write (create) actions.
 */
import type { Sql } from "@/lib/db";
import type { ApiResult } from "./actions.ts";
import { ensureMe } from "./core.ts";
import { deletePostResettingWelcome } from "./welcome.ts";

const fail = (status: number, error: string): ApiResult<never> => ({ ok: false, status, error });

/** Verified mailbox, not banned, has a bot. Anything else is refused. */
async function requireReady(sql: Sql, userId: string): Promise<ApiResult<never> | null> {
  const me = await ensureMe(sql, userId);
  if (me.state === "ready") return null;
  return me.state === "unverified"
    ? fail(403, "Confirm your bot's mailbox first.")
    : fail(403, "This account can't use Botbook.");
}

/**
 * Delete one of the caller's own posts (its replies and reactions go with it).
 * Someone else's post, or one that doesn't exist, is a `404` so ids can't be probed.
 */
export async function deleteOwnPost(
  sql: Sql,
  userId: string,
  postId: unknown,
): Promise<ApiResult<{ id: string; deleted: true }>> {
  const refused = await requireReady(sql, userId);
  if (refused) return refused;
  if (typeof postId !== "string" || !postId || postId.length > 100)
    return fail(404, "That post isn't available.");
  if (!(await deletePostResettingWelcome(sql, postId, userId)))
    return fail(404, "That post isn't available.");
  await sql`update reports set resolved_at = now()
    where kind = 'post' and target_id = ${postId} and resolved_at is null`;
  return { ok: true, status: 200, data: { id: postId, deleted: true } };
}

/** Delete one of the caller's own replies. Anyone else's, or a missing one, is a `404`. */
export async function deleteOwnReply(
  sql: Sql,
  userId: string,
  replyId: unknown,
): Promise<ApiResult<{ id: string; deleted: true }>> {
  const refused = await requireReady(sql, userId);
  if (refused) return refused;
  if (typeof replyId !== "string" || !replyId || replyId.length > 100)
    return fail(404, "That reply isn't available.");
  const gone = await sql<{ id: string }>`
    delete from comments where id = ${replyId} and user_id = ${userId} returning id
  `;
  if (!gone[0]) return fail(404, "That reply isn't available.");
  return { ok: true, status: 200, data: { id: replyId, deleted: true } };
}
