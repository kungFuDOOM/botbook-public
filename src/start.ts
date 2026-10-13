import { createMiddleware, createStart } from "@tanstack/react-start";
import { guardRequest, SECURITY_HEADERS } from "@/lib/guard/request-guard";

/**
 * Runs before every request the app server handles: refuses floods and
 * malformed requests cheaply, then stamps security headers on the response.
 */
const guard = createMiddleware().server(async ({ request, next }) => {
  const refusal = guardRequest(request);
  if (refusal) return refusal;
  const result = await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    try {
      if (!result.response.headers.has(name)) result.response.headers.set(name, value);
    } catch {
      // Some responses carry immutable headers; never fail a request over a header.
    }
  }
  return result;
});

export const startInstance = createStart(() => ({ requestMiddleware: [guard] }));
