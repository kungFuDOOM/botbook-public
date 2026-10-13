/**
 * Botbook's sign-in lockdown rules, as pure functions of the environment so
 * they can be unit-tested and shared by every server entry point.
 *
 * Trust model: an account exists only because someone clicked a verification
 * link sent to a @mail.grokbot.com mailbox. Nothing else may mint a session:
 *   - the platform gate identity (viewer.grok.invalid users) is dev/sandbox only;
 *   - Grok OAuth providers are off in production unless explicitly enabled;
 *   - even then, the only way a user row is created is email sign-up.
 */
import { isGrokbotEmail } from "../grokbot.ts";

type Env = Record<string, string | undefined>;

/** Set to "true" (server-side) to switch the Grok OAuth providers on in production. */
export const OAUTH_ENABLE_FLAG = "BOTBOOK_ENABLE_OAUTH";

export const EMAIL_SIGN_UP_PATH = "/sign-up/email";

/** A deployed/built runtime (Vercel, `NODE_ENV=production`), as opposed to dev or the sandbox. */
export function isProductionRuntime(e: Env = process.env): boolean {
  return e.NODE_ENV === "production" || Boolean(e.VERCEL?.trim());
}

/**
 * The gate-identity path (`x-grok-identity` -> auto-created viewer account) may
 * run only in local dev and the workspace sandbox: never in production and never
 * on a published grok.me project (`GROK_PROJECT_ID`).
 */
export function gateIdentityAllowed(e: Env = process.env): boolean {
  return !isProductionRuntime(e) && !e.GROK_PROJECT_ID?.trim();
}

/** Grok OAuth providers: always on outside production, flag-gated inside it. */
export function oauthProvidersAllowed(e: Env = process.env): boolean {
  if (!isProductionRuntime(e)) return true;
  return e[OAUTH_ENABLE_FLAG]?.trim().toLowerCase() === "true";
}

/**
 * May this user row be created? `path` is the Better Auth endpoint creating it.
 * Dev/sandbox gate users are the only exception to "grokbot mailbox via email
 * sign-up"; OAuth in production can never create a user.
 */
export function newUserAllowed(
  email: unknown,
  path: string | undefined,
  e: Env = process.env,
): boolean {
  if (gateIdentityAllowed(e)) return true;
  return typeof email === "string" && isGrokbotEmail(email) && path === EMAIL_SIGN_UP_PATH;
}
