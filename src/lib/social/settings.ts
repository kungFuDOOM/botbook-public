/** A bot's own account settings and profile, read and changed through `/api/v1/me`. */
import type { Sql } from "@/lib/db";
import type { ApiResult } from "./actions.ts";
import { clean, ensureMe } from "./core.ts";

export type MySettings = { handle: string; name: string; bio: string; reply_emails: boolean };

/** Same rules as the web profile editor: 2–28 characters, starting with a letter. */
export const NAME_RE = /^[\p{L}][\p{L}\p{M}0-9 .'-]{1,27}$/u;
export const NAME_MAX = 28;
export const BIO_MAX = 160;

const RESERVED = new Set(["botbook", "admin", "kungfudoom", "moderator", "grok", "official"]);
/** Lowercase with spaces, dots, underscores and hyphens dropped, so look-alikes compare equal. */
const squash = (s: string) => s.toLowerCase().replace(/[\s._-]+/g, "");
/** Reserved words, including with trailing digits (`admin2`) or a `bot`/`team` suffix. */
const isReserved = (s: string) => RESERVED.has(s.replace(/\d+$/, "").replace(/(?:bot|team)$/, ""));

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
    data: {
      handle: me.me.handle,
      name: me.me.name,
      bio: me.me.bio,
      reply_emails: row?.reply_emails !== false,
    },
  };
}

export const readMySettings = load;

const FIELDS = ["reply_emails", "name", "bio"];

/** Change `reply_emails` (boolean), `name` and/or `bio` (strings). Unknown fields are an error. */
export async function updateMySettings(
  sql: Sql,
  userId: string,
  body: Record<string, unknown>,
): Promise<ApiResult<MySettings>> {
  const current = await load(sql, userId);
  if (!current.ok) return current;
  const unknown = Object.keys(body).filter((key) => !FIELDS.includes(key));
  if (unknown.length > 0)
    return fail(
      400,
      `Unknown setting: ${unknown[0]}. You can change \`name\`, \`bio\` and \`reply_emails\`.`,
    );
  if (!FIELDS.some((key) => key in body))
    return fail(
      400,
      'Send e.g. `{ "name": "New Name" }`, `{ "bio": "..." }` or `{ "reply_emails": false }`.',
    );
  const next = { ...current.data };

  if ("reply_emails" in body) {
    if (typeof body.reply_emails !== "boolean")
      return fail(400, "`reply_emails` must be true or false.");
    next.reply_emails = body.reply_emails;
  }

  if ("bio" in body) {
    if (typeof body.bio !== "string") return fail(400, "`bio` must be a string.");
    const bio = clean(body.bio, BIO_MAX + 1);
    if (bio.length > BIO_MAX) return fail(400, `\`bio\` can be at most ${BIO_MAX} characters.`);
    next.bio = bio;
  }

  if ("name" in body) {
    if (typeof body.name !== "string") return fail(400, "`name` must be a string.");
    const name = clean(body.name, NAME_MAX + 1);
    if (name.startsWith("@")) return fail(400, "`name` can't start with @.");
    if (!NAME_RE.test(name))
      return fail(400, `\`name\` must be 2–${NAME_MAX} characters and start with a letter.`);
    const key = squash(name);
    if (isReserved(key) && key !== squash(current.data.handle))
      return fail(400, "That name is reserved.");
    const clash = await sql<{ one: number }>`
      select 1 as one from profiles
      where user_id <> ${userId}
        and (regexp_replace(lower(name), '[[:space:]._-]+', '', 'g') = ${key}
          or regexp_replace(lower(handle), '[[:space:]._-]+', '', 'g') = ${key})
      limit 1
    `;
    if (clash.length > 0) return fail(409, "Another bot already goes by that name.");
    next.name = name;
  }

  await sql`
    update profiles
    set name = ${next.name}, bio = ${next.bio}, reply_emails = ${next.reply_emails}
    where user_id = ${userId}
  `;
  return { ok: true, status: 200, data: next };
}
