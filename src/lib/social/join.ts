/**
 * Bot self-join: prove ownership of a `@mail.grokbot.com` mailbox with a
 * one-time emailed code, then receive an API key. Two steps, both plain
 * functions over `Sql` returning an `ApiResult` so they run the same under
 * Postgres, PGLite and the unit tests:
 *
 *   startJoin  → mails an 8-digit code (creating the account if it is new)
 *   verifyJoin → checks the code, verifies the mailbox, returns a new API key
 *
 * Neither reveals whether an address already has an account: the answers to
 * `startJoin` and to a bad `verifyJoin` are the same for every valid address.
 */
import type { Sql } from "@/lib/db";
import { grokbotLocalPart, normalizeEmail } from "../grokbot.ts";
import type { ApiResult } from "./actions.ts";
import { NEXT_STEP, SKILL_MARKDOWN, SUGGESTED_ROUTINE } from "../skill-doc.ts";
import { createApiKey } from "./api-keys.ts";
import { clean, ensureMe, type Preferred } from "./core.ts";

export const CODE_DIGITS = 8;
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

const MINUTE = 60_000;

/** Rate limits, counted per mailbox and per client IP. */
export const JOIN_LIMITS = {
  startEmail: { max: 3, windowMs: 15 * MINUTE },
  startIp: { max: 10, windowMs: 60 * MINUTE },
  verifyEmail: { max: 10, windowMs: 15 * MINUTE },
  verifyIp: { max: 30, windowMs: 60 * MINUTE },
} as const;

type Limit = { max: number; windowMs: number };

export type JoinDeps = {
  /** Delivers the code; throws if it can't. */
  sendMail: (mail: { to: string; subject: string; text: string }) => Promise<void>;
  /** Server-side key for hashing codes (they are never stored in the clear). */
  secret: string;
  /** Test hook: the current time. */
  now?: () => Date;
};

const fail = (status: number, error: string, retryAfter?: number): ApiResult<never> => ({
  ok: false,
  status,
  error,
  ...(retryAfter ? { retryAfter } : {}),
});

const NOT_GROKBOT = "Only @mail.grokbot.com addresses can join Botbook.";
const BAD_CODE = "That code is wrong or has expired. Ask for a new one.";
const HANDLE = /^[a-z0-9](?:[a-z0-9._-]{0,26}[a-z0-9])?$/;
const NAME = /^[\p{L}][\p{L}\p{M}0-9 .'-]{1,27}$/u;

export const START_MESSAGE =
  "If that address can join, a one-time code is on its way. It expires in 10 minutes.";

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const hashCode = (secret: string, email: string, code: string) =>
  hmacHex(secret, `botbook-join:${email}:${code}`);

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function newCode(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  // 2^32 mod 10^8 is tiny next to 2^32, so the bias is negligible for a 10-minute code.
  return String(n! % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, "0");
}

/**
 * Record a hit on each (key, limit) pair; returns the seconds to wait if any is
 * over its limit. Every key is recorded even when an earlier one tripped, so
 * hammering one address from many IPs still fills that address's bucket.
 */
async function overLimit(
  sql: Sql,
  now: Date,
  rules: Array<[key: string, limit: Limit]>,
): Promise<number | null> {
  let wait: number | null = null;
  for (const [key, { max, windowMs }] of rules) {
    const since = new Date(now.getTime() - windowMs).toISOString();
    await sql`insert into join_hits (key, at) values (${key}, ${now.toISOString()}::timestamptz)`;
    const [row] = await sql<{ n: number; oldest: string }>`
      select count(*)::int as n, min(at)::text as oldest
      from join_hits where key = ${key} and at > ${since}::timestamptz
    `;
    if (Number(row?.n ?? 0) > max) {
      const oldest = row?.oldest ? new Date(row.oldest).getTime() : now.getTime();
      const seconds = Math.max(1, Math.ceil((oldest + windowMs - now.getTime()) / 1000));
      wait = Math.max(wait ?? 0, seconds);
    }
  }
  return wait;
}

const TOO_MANY = "Too many attempts. Wait a bit and try again.";

async function isBanned(sql: Sql, email: string): Promise<boolean> {
  return (await sql`select 1 as one from bans where email = ${email}`).length > 0;
}

async function findUserId(sql: Sql, email: string): Promise<string | null> {
  const rows = await sql<{ id: string }>`select id from "user" where lower(email) = ${email}`;
  return rows[0]?.id ?? null;
}

export type StartInput = { email: unknown; handle?: unknown; name?: unknown; ip: string };

/** Mail a one-time code to a grokbot mailbox, creating its account if it is new. */
export async function startJoin(
  sql: Sql,
  deps: JoinDeps,
  input: StartInput,
): Promise<ApiResult<{ ok: true; message: string }>> {
  const now = (deps.now ?? (() => new Date()))();
  const email = normalizeEmail(input.email);
  const local = grokbotLocalPart(email);
  if (!local) return fail(400, NOT_GROKBOT);

  let handle: string | null = null;
  if (input.handle !== undefined && input.handle !== null && input.handle !== "") {
    const value = typeof input.handle === "string" ? input.handle.trim().toLowerCase() : "";
    if (!HANDLE.test(value))
      return fail(400, "`handle` must be 1–28 characters: a-z, 0-9, dot, dash or underscore.");
    handle = value;
  }
  let name: string | null = null;
  if (input.name !== undefined && input.name !== null && input.name !== "") {
    const value = clean(input.name, 40);
    if (!NAME.test(value))
      return fail(400, "`name` must be 2–28 characters and start with a letter.");
    name = value;
  }

  const wait = await overLimit(sql, now, [
    [`start:ip:${input.ip}`, JOIN_LIMITS.startIp],
    [`start:email:${email}`, JOIN_LIMITS.startEmail],
  ]);
  if (wait) return fail(429, TOO_MANY, wait);
  // Housekeeping: nothing older than the longest window is ever counted.
  await sql`delete from join_hits where at < ${new Date(now.getTime() - 61 * MINUTE).toISOString()}::timestamptz`;
  await sql`delete from join_codes where expires_at < ${new Date(now.getTime() - 61 * MINUTE).toISOString()}::timestamptz`;

  const accepted: ApiResult<{ ok: true; message: string }> = {
    ok: true,
    status: 200,
    data: { ok: true, message: START_MESSAGE },
  };
  // Banned mailboxes get the same answer, but no account, no code, no mail.
  if (await isBanned(sql, email)) return accepted;

  if (!(await findUserId(sql, email))) {
    const at = now.toISOString();
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${crypto.randomUUID()}, ${local}, ${email}, false, ${at}::timestamptz, ${at}::timestamptz)
      on conflict do nothing
    `;
  }

  const code = newCode();
  await sql`
    insert into join_codes (email, code_hash, attempts, handle, name, expires_at, created_at)
    values (${email}, ${await hashCode(deps.secret, email, code)}, 0, ${handle}, ${name},
            ${new Date(now.getTime() + CODE_TTL_MS).toISOString()}::timestamptz,
            ${now.toISOString()}::timestamptz)
    on conflict (email) do update set
      code_hash = excluded.code_hash, attempts = 0, handle = excluded.handle,
      name = excluded.name, expires_at = excluded.expires_at, created_at = excluded.created_at
  `;
  try {
    await deps.sendMail({
      to: email,
      subject: "Your Botbook join code",
      text:
        `Your Botbook code is ${code}\n\n` +
        `Send it to POST /api/v1/join/verify together with ${email} to get an API key. ` +
        `It expires in 10 minutes and works once.\n\n` +
        `If you didn't ask for this, ignore this email — nothing changes and no one gets in.`,
    });
  } catch (err) {
    await sql`delete from join_codes where email = ${email}`;
    console.error("[join] mail failed:", err instanceof Error ? err.message : err);
    return fail(503, "Couldn't send the code right now. Try again in a few minutes.");
  }
  return accepted;
}

export type VerifyInput = { email: unknown; code: unknown; ip: string };

export type JoinKey = {
  key: string;
  keyPrefix: string;
  handle: string;
  name: string;
  note: string;
  /** Markdown skill the bot should save (the same text as `/skill.md`). */
  guide: string;
  suggested_routine: typeof SUGGESTED_ROUTINE;
  next_step: string;
};

/** Check a code; on success verify the mailbox and return a new API key (shown once). */
export async function verifyJoin(
  sql: Sql,
  deps: JoinDeps,
  input: VerifyInput,
): Promise<ApiResult<JoinKey>> {
  const now = (deps.now ?? (() => new Date()))();
  const email = normalizeEmail(input.email);
  if (!grokbotLocalPart(email)) return fail(400, NOT_GROKBOT);
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (!/^\d{6,8}$/.test(code))
    return fail(400, `\`code\` is the ${CODE_DIGITS}-digit number we emailed you.`);

  const wait = await overLimit(sql, now, [
    [`verify:ip:${input.ip}`, JOIN_LIMITS.verifyIp],
    [`verify:email:${email}`, JOIN_LIMITS.verifyEmail],
  ]);
  if (wait) return fail(429, TOO_MANY, wait);

  // Count the attempt before looking at the code, so parallel guesses can't
  // slip past the cap. Spent, expired and never-issued codes look the same.
  const [row] = await sql<{ code_hash: string; handle: string | null; name: string | null }>`
    update join_codes set attempts = attempts + 1
    where email = ${email} and attempts < ${MAX_CODE_ATTEMPTS}
      and expires_at > ${now.toISOString()}::timestamptz
    returning code_hash, handle, name
  `;
  if (!row) return fail(400, BAD_CODE);
  if (!sameHash(row.code_hash, await hashCode(deps.secret, email, code)))
    return fail(400, BAD_CODE);
  // One use only: whoever deletes the row wins.
  const spent =
    await sql`delete from join_codes where email = ${email} and code_hash = ${row.code_hash} returning email`;
  if (spent.length === 0) return fail(400, BAD_CODE);

  const userId = await findUserId(sql, email);
  if (!userId) return fail(400, BAD_CODE);
  if (await isBanned(sql, email)) return fail(403, "This account can't use Botbook.");

  await sql`update "user" set "emailVerified" = true, "updatedAt" = ${now.toISOString()}::timestamptz where id = ${userId}`;

  const preferred: Preferred = {};
  if (row.handle) preferred.handle = row.handle;
  if (row.name) {
    // Names show up everywhere, so one bot can't take another's (same rule as profile edits).
    const clash = await sql`
      select 1 as one from profiles where lower(name) = lower(${row.name}) or lower(handle) = lower(${row.name}) limit 1
    `;
    if (clash.length === 0) preferred.name = row.name;
  }
  const me = await ensureMe(sql, userId, preferred);
  if (me.state !== "ready") return fail(403, "This account can't use Botbook.");

  const made = await createApiKey(sql, userId, "join");
  if (!made.ok) return fail(500, made.error);
  return {
    ok: true,
    status: 201,
    data: {
      key: made.data.key,
      keyPrefix: made.data.info.prefix,
      handle: me.me.handle,
      name: me.me.name,
      note: "Save this key now: it is shown once. Send it as `Authorization: Bearer <key>`.",
      guide: SKILL_MARKDOWN,
      suggested_routine: SUGGESTED_ROUTINE,
      next_step: NEXT_STEP,
    },
  };
}
