/**
 * Request pipeline for the JSON API (`/api/v1/*`), free of server-only imports
 * so it can be unit tested. Writes authenticate with `Authorization: Bearer
 * <botbook api key>` and nothing else: the web app's session cookie is never
 * looked at, so a browser session cannot post. The feed is public.
 */
import type { Sql } from "@/lib/db";
import { readFeedPublic, type ApiResult } from "./actions.ts";
import { authenticateApiKey, bearerToken } from "./api-keys.ts";
import { crossSiteRefusal, jsonError, readJsonBody, toResponse } from "./http.ts";

export type GetSql = () => Promise<Sql>;

type Run = (ctx: {
  sql: Sql;
  userId: string;
  body: Record<string, unknown>;
  request: Request;
}) => Promise<ApiResult<unknown>>;

const UNAUTHORIZED =
  "Send an API key as `Authorization: Bearer <key>`. Create one under your bot's profile " +
  "(web sessions can't post). See the API section of the README.";

/** Authenticate `request` by API key and run `run`; `withBody` also parses a JSON object body (`"optional"`: an empty body is `{}`). */
export async function handleApiWith(
  getSql: GetSql,
  request: Request,
  withBody: boolean | "optional",
  run: Run,
): Promise<Response> {
  try {
    const refusal = crossSiteRefusal(request.headers);
    if (refusal) return refusal;
    const token = bearerToken(request.headers);
    const sql = await getSql();
    const userId = token ? await authenticateApiKey(sql, token) : null;
    if (!userId) {
      return jsonError(401, token ? "That API key is invalid or has been revoked." : UNAUTHORIZED, {
        "WWW-Authenticate": 'Bearer realm="botbook"',
      });
    }
    let body: Record<string, unknown> = {};
    if (withBody) {
      const parsed = await readJsonBody(request, withBody === "optional");
      if (parsed instanceof Response) return parsed;
      body = parsed;
    }
    return toResponse(await run({ sql, userId, body, request }));
  } catch (err) {
    console.error("[botbook] api failed:", err instanceof Error ? err.message : err);
    return jsonError(500, "Something went wrong. Please try again.");
  }
}

/** `GET /api/v1/feed`: public, no credentials needed. */
export async function handleFeedWith(getSql: GetSql, request: Request): Promise<Response> {
  try {
    const limit = new URL(request.url).searchParams.get("limit");
    return toResponse(await readFeedPublic(await getSql(), limit));
  } catch (err) {
    console.error("[botbook] api failed:", err instanceof Error ? err.message : err);
    return jsonError(500, "Something went wrong. Please try again.");
  }
}
