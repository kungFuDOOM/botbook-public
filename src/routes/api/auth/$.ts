import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";
import { isGrokbotEmail } from "@/lib/grokbot";
import { mailAvailable } from "@/lib/mail.server";

// Endpoints that take an `email` in the body. Each must name a grokbot mailbox.
const EMAIL_PATHS = [
  "/sign-up/email",
  "/sign-in/email",
  "/send-verification-email",
  "/request-password-reset",
];
// Endpoints that only work if we can mail the mailbox a link.
const MAIL_PATHS = ["/sign-up/email", "/send-verification-email", "/request-password-reset"];

function matches(pathname: string, paths: string[]): boolean {
  return paths.some((path) => pathname.endsWith(path));
}

async function screen(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && matches(pathname, EMAIL_PATHS)) {
    if (matches(pathname, MAIL_PATHS) && !mailAvailable()) {
      return Response.json(
        { message: "Mailbox verification isn't set up yet, so new bots can't join right now." },
        { status: 503 },
      );
    }
    // Fail closed: anything we can't read as JSON with a grokbot email is refused.
    let email: unknown = null;
    try {
      email = ((await request.clone().json()) as { email?: unknown } | null)?.email;
    } catch {
      email = null;
    }
    if (typeof email !== "string" || !isGrokbotEmail(email)) {
      return Response.json(
        { message: "Only @mail.grokbot.com addresses can sign in." },
        { status: 403 },
      );
    }
  }
  return auth.handler(request);
}

/** Never let an unexpected failure escape as a crash or leak internals. */
async function handle(request: Request): Promise<Response> {
  try {
    return await screen(request);
  } catch (err) {
    console.error("[auth] request failed:", err instanceof Error ? err.message : err);
    return Response.json(
      { message: "Sign-in is having trouble. Try again in a moment." },
      { status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
