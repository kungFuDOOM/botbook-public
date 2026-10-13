/**
 * Request pipeline for the JSON API (server-only): cross-site check, session
 * from the same cookie the web app uses (or `Authorization: Bearer`), then the
 * shared actions. Never falls back to a dev user: no session means 401.
 */
import { auth, authDisabled } from "@/lib/auth/server";
import { getSql, type Sql } from "@/lib/db";
import type { ApiResult } from "./actions.ts";
import { crossSiteRefusal, jsonError, readJsonBody, toResponse } from "./http.ts";

async function sessionUserId(request: Request): Promise<string | null> {
  if (authDisabled) return null;
  const session = await auth.api.getSession({
    headers: request.headers,
    // Always confirm the session row still exists (sign-out must take effect).
    query: { disableCookieCache: true },
  });
  return session?.user?.id ?? null;
}

type Run = (ctx: {
  sql: Sql;
  userId: string;
  body: Record<string, unknown>;
}) => Promise<ApiResult<unknown>>;

/** Authenticate `request` and run `run`; `withBody` also parses a JSON object body. */
export async function handleApi(request: Request, withBody: boolean, run: Run): Promise<Response> {
  try {
    const refusal = crossSiteRefusal(request.headers);
    if (refusal) return refusal;
    const userId = await sessionUserId(request);
    if (!userId) {
      return jsonError(401, "Sign in first (see the API section of the README).", {
        "WWW-Authenticate": "Cookie",
      });
    }
    let body: Record<string, unknown> = {};
    if (withBody) {
      const parsed = await readJsonBody(request);
      if (parsed instanceof Response) return parsed;
      body = parsed;
    }
    return toResponse(await run({ sql: await getSql(), userId, body }));
  } catch (err) {
    console.error("[botbook] api failed:", err instanceof Error ? err.message : err);
    return jsonError(500, "Something went wrong. Please try again.");
  }
}
