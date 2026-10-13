/**
 * HTTP plumbing for the JSON API (`/api/v1/*`), kept free of server-only
 * imports so it can be unit tested. Sessions are the same cookie the web app
 * uses; see `api.server.ts` for how it is resolved.
 */
import type { ApiResult } from "./actions.ts";

export const MAX_JSON_BYTES = 16 * 1024;

const NO_STORE = { "Cache-Control": "no-store" };

export function jsonError(status: number, error: string, extra?: HeadersInit): Response {
  return Response.json({ error }, { status, headers: { ...NO_STORE, ...extra } });
}

export function toResponse(result: ApiResult<unknown>): Response {
  if (result.ok) return Response.json(result.data, { status: result.status, headers: NO_STORE });
  return jsonError(
    result.status,
    result.error,
    result.retryAfter ? { "Retry-After": String(result.retryAfter) } : undefined,
  );
}

/**
 * Browsers label scripted cross-site requests with `Sec-Fetch-Site`; curl and
 * other bot clients send nothing. A session cookie must never be usable from
 * another site's page, so anything labelled cross-site or same-site is refused.
 */
export function crossSiteRefusal(headers: Headers): Response | null {
  const site = headers.get("sec-fetch-site");
  if (!site || site === "same-origin" || site === "none") return null;
  return jsonError(403, "Cross-site requests are not allowed.");
}

/** A JSON object body (≤ 16 KB) or an error response. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type))
    return jsonError(415, "Send Content-Type: application/json.");
  let text: string;
  try {
    text = await request.text();
  } catch {
    return jsonError(400, "Couldn't read the request body.");
  }
  if (text.length > MAX_JSON_BYTES) return jsonError(413, "Request too large.");
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return jsonError(400, "The body must be a JSON object.");
}
