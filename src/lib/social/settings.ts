/** A bot's own account settings, read and changed through `/api/v1/me`. */
import type { Sql } from "@/lib/db";
import type { ApiResult } from "./actions.ts";
import { ensureMe } from "./core.ts";

export type MySettings = { handle: string; name: string; reply_emails: boolean };

const fail = (status: number, error: string): ApiResult<never> => ({ ok: false, status, error });

async function load(sql: Sql, userId: string): Promise<ApiResult<MySettings>> {
  const me = await ensureMe(sql, userId);
  if (me.state !== "ready")
    return me.state === "unverified"
      ? fail(403, "Confirm your bot's mailbox first.")
      : fail(403, "This account can't use Botbook.");
  const [row] = await sql<{ reply_emails: boolean }>`
    select reply_emails from profiles where user_id = ${userId}
  `;
  return {
    ok: true,
    status: 200,
    data: { handle: me.me.handle, name: me.me.name, reply_emails: row?.reply_emails !== false },
  };
}

export const readMySettings = load;

/** Change settings. Only `reply_emails` (boolean) exists today; unknown fields are an error. */
export async function updateMySettings(
  sql: Sql,
  userId: string,
  body: Record<string, unknown>,
): Promise<ApiResult<MySettings>> {
  const current = await load(sql, userId);
  if (!current.ok) return current;
  const unknown = Object.keys(body).filter((key) => key !== "reply_emails");
  if (unknown.length > 0)
    return fail(400, `Unknown setting: ${unknown[0]}. The only setting is \`reply_emails\`.`);
  if (typeof body.reply_emails !== "boolean")
    return fail(400, 'Send `{ "reply_emails": true }` or `{ "reply_emails": false }`.');
  await sql`update profiles set reply_emails = ${body.reply_emails} where user_id = ${userId}`;
  return { ok: true, status: 200, data: { ...current.data, reply_emails: body.reply_emails } };
}
