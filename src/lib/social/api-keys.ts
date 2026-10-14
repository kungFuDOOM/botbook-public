/**
 * Bot API keys: the only credential the write endpoints of `/api/v1` accept.
 * A key looks like `bb_<43 url-safe characters>`; only its SHA-256 hash and a
 * short prefix are stored, so a leaked database does not leak working keys.
 */
import type { Sql } from "@/lib/db";

export const KEY_PREFIX = "bb_";
export const MAX_ACTIVE_KEYS = 5;
/** How often `last_used_at` is refreshed at most, to keep reads from writing every call. */
const TOUCH_AFTER_MS = 60_000;

export type ApiKeyInfo = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type KeyResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return KEY_PREFIX + Buffer.from(bytes).toString("base64url");
}

/** The token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(headers: Headers): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

const COLS = `id, name, prefix, created_at::text as created_at,
  last_used_at::text as last_used_at, revoked_at::text as revoked_at`;

const toInfo = (r: KeyRow): ApiKeyInfo => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

/** Make a key for `userId`. The full key is returned once and never stored. */
export async function createApiKey(
  sql: Sql,
  userId: string,
  name: unknown,
): Promise<KeyResult<{ key: string; info: ApiKeyInfo }>> {
  const label = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  const [{ n } = { n: 0 }] = await sql<{ n: number }>`
    select count(*)::int as n from api_keys where user_id = ${userId} and revoked_at is null
  `;
  if (Number(n) >= MAX_ACTIVE_KEYS)
    return {
      ok: false,
      error: `You can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`,
    };
  const key = newKey();
  const id = crypto.randomUUID();
  const rows = await sql.query<KeyRow>(
    `insert into api_keys (id, user_id, name, prefix, key_hash) values ($1, $2, $3, $4, $5)
     returning ${COLS}`,
    [id, userId, label, key.slice(0, KEY_PREFIX.length + 6), await hashKey(key)],
  );
  return { ok: true, data: { key, info: toInfo(rows[0]!) } };
}

export async function listApiKeys(sql: Sql, userId: string): Promise<ApiKeyInfo[]> {
  const rows = await sql.query<KeyRow>(
    `select ${COLS} from api_keys where user_id = $1 order by created_at desc limit 50`,
    [userId],
  );
  return rows.map(toInfo);
}

export async function revokeApiKey(sql: Sql, userId: string, id: string): Promise<KeyResult<null>> {
  const rows = await sql<{ id: string }>`
    update api_keys set revoked_at = now()
    where id = ${id} and user_id = ${userId} and revoked_at is null
    returning id
  `;
  return rows[0] ? { ok: true, data: null } : { ok: false, error: "That key isn't active." };
}

/** The account an unrevoked key belongs to, or null. Bans are enforced by the actions. */
export async function authenticateApiKey(sql: Sql, token: string): Promise<string | null> {
  if (!token.startsWith(KEY_PREFIX) || token.length > 100) return null;
  const rows = await sql.query<{ id: string; user_id: string; stale: boolean }>(
    `select id, user_id,
            (last_used_at is null or last_used_at < now() - interval '${TOUCH_AFTER_MS / 1000} seconds') as stale
     from api_keys where key_hash = $1 and revoked_at is null`,
    [await hashKey(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.stale) await sql`update api_keys set last_used_at = now() where id = ${row.id}`;
  return row.user_id;
}
