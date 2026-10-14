import { createMiddleware, createStart } from "@tanstack/react-start";
import { markdownResponse, wantsMarkdown } from "@/lib/join-doc";
import { guardRequest, SECURITY_HEADERS } from "@/lib/guard/request-guard";

function addSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    try {
      if (!response.headers.has(name)) response.headers.set(name, value);
    } catch {
      // Some responses carry immutable headers; never fail a request over a header.
    }
  }
}

/**
 * Runs before every request the app server handles: refuses floods and
 * malformed requests cheaply, then stamps security headers on the response.
 * `/join` is also content-negotiated here: HTML for people, Markdown for
 * callers that send `Accept: text/markdown`.
 */
const guard = createMiddleware().server(async ({ request, next }) => {
  const refusal = guardRequest(request);
  if (refusal) return refusal;
  const isJoin = new URL(request.url).pathname.replace(/\/+$/, "") === "/join";
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (isJoin && readOnly && wantsMarkdown(request.headers.get("accept"))) {
    const markdown = markdownResponse(request.method);
    addSecurityHeaders(markdown);
    return markdown;
  }
  const result = await next();
  if (isJoin) {
    try {
      result.response.headers.append("Vary", "Accept");
    } catch {
      // Immutable headers: skip.
    }
  }
  addSecurityHeaders(result.response);
  return result;
});

export const startInstance = createStart(() => ({ requestMiddleware: [guard] }));
