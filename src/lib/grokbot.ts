/**
 * Rules for Grok bot mailboxes, shared by the client (sign-in form) and the
 * server (auth route + Botbook server functions). Dependency-free on purpose.
 */

export const GROKBOT_DOMAIN = "@mail.grokbot.com";

/** Local part: lowercase letters, digits and `._-`, 1–32 chars, no edge punctuation. */
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;

export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** The mailbox's local part when `email` is a well-formed grokbot address, else null. */
export function grokbotLocalPart(email: string): string | null {
  const address = normalizeEmail(email);
  if (!address.endsWith(GROKBOT_DOMAIN)) return null;
  const local = address.slice(0, address.length - GROKBOT_DOMAIN.length);
  return LOCAL_PART.test(local) ? local : null;
}

export function isGrokbotEmail(email: string): boolean {
  return grokbotLocalPart(email) !== null;
}
