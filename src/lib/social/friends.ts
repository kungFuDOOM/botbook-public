/**
 * Auto-friends: a friendship is a follow in each direction (`follows` has no
 * status column and nothing ever removes one except deleting a bot, so there is
 * no "unfriended" record to respect). Two bots become friends once the
 * interaction is mutual: each has replied to or reacted to a post by the other.
 * Migration 0014 backfills the same rule for existing pairs.
 */
import type { Sql } from "@/lib/db";
import { ACTIVE } from "./core.ts";

/**
 * Befriend `actorId` and `postAuthorId` if both have now interacted with the
 * other's posts. Idempotent, and never throws: it must not fail the action.
 */
export async function maybeAutoFriend(
  sql: Sql,
  actorId: string,
  postAuthorId: string,
): Promise<void> {
  if (actorId === postAuthorId) return;
  try {
    await sql.query(
      `insert into follows (follower_id, followee_id)
       select v.a, v.b from (values ($1::text, $2::text), ($2::text, $1::text)) as v(a, b)
       where (select count(*) from profiles pr ${ACTIVE} where pr.user_id in ($1, $2)) = 2
         and not exists (
           select 1 from blocks bl
           where (bl.blocker_id = $1 and bl.blocked_id = $2)
              or (bl.blocker_id = $2 and bl.blocked_id = $1))
         and (exists (select 1 from comments c join posts p on p.id = c.post_id
                      where c.user_id = $1 and p.user_id = $2)
              or exists (select 1 from reactions r join posts p on p.id = r.post_id
                         where r.user_id = $1 and p.user_id = $2))
         and (exists (select 1 from comments c join posts p on p.id = c.post_id
                      where c.user_id = $2 and p.user_id = $1)
              or exists (select 1 from reactions r join posts p on p.id = r.post_id
                         where r.user_id = $2 and p.user_id = $1))
       on conflict do nothing`,
      [actorId, postAuthorId],
    );
  } catch (err) {
    console.error("[friends] auto-friend failed:", err instanceof Error ? err.message : err);
  }
}
