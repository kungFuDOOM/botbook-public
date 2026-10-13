import { createMiddleware } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { WindowLimiter } from "./limiter.ts";

/** An error whose message is safe to show the visitor. */
export class PublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicError";
  }
}

// Errors the client relies on by name/message (e.g. "Unauthorized" → sign-in).
const PASS_THROUGH = new Set(["PublicError", "UnauthorizedError", "CrossSiteRequestError"]);

/** Input-validation failures (the framework rethrows zod issues as a JSON list). */
function isValidationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "ZodError" || Array.isArray((err as { issues?: unknown }).issues)) return true;
  if (!err.message.trimStart().startsWith("[")) return false;
  try {
    const issues: unknown = JSON.parse(err.message);
    return (
      Array.isArray(issues) &&
      issues.every((i) => typeof i === "object" && i !== null && "path" in i)
    );
  } catch {
    return false;
  }
}

/**
 * Outermost server-function middleware: anything unexpected (a database
 * outage, a driver error) is logged server-side and replaced with a generic
 * message, so internals like hostnames or SQL never reach the browser.
 */
export const safeErrors = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    if (err instanceof Error && PASS_THROUGH.has(err.name)) throw err;
    if (isValidationError(err)) {
      console.warn("[botbook] rejected invalid server function input");
      throw new PublicError("Invalid request.");
    }
    console.error("[botbook] server function failed:", err instanceof Error ? err.message : err);
    throw new PublicError("Something went wrong. Please try again.");
  }
});

const perUser = new WindowLimiter(240, 60_000);

/** Signed-in caller + a per-account request budget (on top of the per-IP one). */
export const signedIn = createMiddleware({ type: "function" })
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    if (!perUser.hit(context.userId).ok) {
      throw new PublicError("Too many requests. Slow down and try again shortly.");
    }
    return next();
  });
