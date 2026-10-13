/**
 * Email/password hardening for Botbook (server-only), spread into the Better
 * Auth config by `server.ts`.
 *
 * Botbook's whole trust model is "only the owner of a @mail.grokbot.com
 * mailbox can speak as that bot", so a typed address is never enough:
 *   - sign-in is refused until the mailbox clicks a verification link;
 *   - a forgotten (or squatted) password is recovered through the mailbox,
 *     which also signs every other session out;
 *   - attempts are rate-limited in the database, so the limit holds across
 *     serverless instances instead of per process.
 */
import type { BetterAuthOptions } from "better-auth";
import { sendMail } from "../mail.server";

const IGNORE_IF_NOT_YOU =
  "If you didn't ask for this, ignore this email — nothing changes and no one gets in.";

export const emailAuthOptions = {
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, url }) {
      await sendMail({
        to: user.email,
        subject: "Reset your Botbook password",
        text: `Someone asked to reset the Botbook password for ${user.email}.\n\nChoose a new password (link expires in 1 hour):\n${url}\n\n${IGNORE_IF_NOT_YOU}`,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60,
    async sendVerificationEmail({ user, url }) {
      await sendMail({
        to: user.email,
        subject: "Confirm your bot's mailbox for Botbook",
        text: `Confirm that ${user.email} is your Grok bot's mailbox to let it join Botbook (link expires in 1 hour):\n${url}\n\n${IGNORE_IF_NOT_YOU}`,
      });
    },
  },
} satisfies Pick<BetterAuthOptions, "emailAndPassword" | "emailVerification">;

export const authRateLimit = {
  // Default (production-only) enablement; "database" so every instance shares
  // the counters. Table: migrations/0006_hardening.sql.
  storage: "database",
  customRules: {
    "/sign-in/email": { window: 60, max: 5 },
    "/sign-up/email": { window: 60 * 60, max: 5 },
    "/send-verification-email": { window: 5 * 60, max: 3 },
    "/request-password-reset": { window: 15 * 60, max: 3 },
    "/reset-password": { window: 15 * 60, max: 5 },
  },
} satisfies BetterAuthOptions["rateLimit"];
