/**
 * Front-door checks for every request the app server handles (pages, server
 * functions, /api/*). Pure function of the request so it is easy to test; it
 * returns a ready-made refusal, or null to let the request through.
 *
 * Volumetric DDoS is absorbed at Vercel's edge before it reaches us; this
 * layer stops the application-level floods that get through, cheaply and
 * without touching the database.
 */
import { WindowLimiter } from "./limiter.ts";

const MINUTE = 60_000;

/** Caps per client IP per server instance. Generous: carrier NAT puts many people on one IP. */
export const LIMITS = {
  all: new WindowLimiter(1200, MINUTE),
  pages: new WindowLimiter(300, MINUTE),
  serverFns: new WindowLimiter(600, MINUTE),
  authWrites: new WindowLimiter(30, MINUTE),
};

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 4096;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "OPTIONS"]);

/** The client's IP as set by the hosting edge (Vercel overwrites these headers). */
export function clientIp(headers: Headers): string {
  const direct = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0];
  return (direct ?? forwarded ?? "local").trim().slice(0, 64) || "local";
}

function refuse(status: number, message: string, retryAfter?: number): Response {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  if (retryAfter) headers.set("Retry-After", String(retryAfter));
  return new Response(JSON.stringify({ message }), { status, headers });
}

export function guardRequest(request: Request): Response | null {
  if (!ALLOWED_METHODS.has(request.method)) return refuse(405, "Method not allowed.");
  if (request.url.length > MAX_URL_LENGTH) return refuse(414, "Request URL too long.");

  if (request.method === "POST") {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(length) || length > MAX_BODY_BYTES)
      return refuse(413, "Request too large.");
  }

  const ip = clientIp(request.headers);
  const { pathname } = new URL(request.url);
  const checks: WindowLimiter[] = [LIMITS.all];
  if (pathname.startsWith("/_serverFn")) checks.push(LIMITS.serverFns);
  else if (pathname.startsWith("/api/auth")) {
    if (request.method === "POST") checks.push(LIMITS.authWrites);
  } else if (!pathname.startsWith("/api/")) checks.push(LIMITS.pages);

  for (const limiter of checks) {
    const result = limiter.hit(ip);
    if (!result.ok)
      return refuse(429, "Too many requests. Slow down and try again shortly.", result.retryAfter);
  }
  return null;
}

/** Security headers added to every response the app server produces (if not already set). */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  // Locked down where it can't break the app or Grok's preview embed.
  "Content-Security-Policy": "object-src 'none'; base-uri 'self'; form-action 'self'",
};
