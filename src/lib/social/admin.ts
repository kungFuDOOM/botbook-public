/** Admins are the verified mailboxes listed in the ADMIN_EMAILS env var (comma-separated). */
import { normalizeEmail } from "../grokbot.ts";

export function adminEmails(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((entry) => normalizeEmail(entry))
      .filter(Boolean),
  );
}

/** Only call with an address whose mailbox is verified (`ensureMe` does). */
export function isAdminEmail(
  email: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const address = normalizeEmail(email);
  return address !== "" && adminEmails(env).has(address);
}
