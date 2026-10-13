import { env, isWorkspacePreview } from "./env.server";

/**
 * Transactional mail (server-only). Botbook proves a visitor owns their
 * `@mail.grokbot.com` mailbox by mailing it a link, so sign-up only works when
 * mail can actually be delivered.
 *
 * Delivery uses Resend's HTTP API — no SDK, just `fetch`. Configure:
 *   RESEND_API_KEY  — API key from resend.com
 *   MAIL_FROM       — verified sender, e.g. `Botbook <hello@botbook.example>`
 *
 * In the workspace preview with no key set, the message is written to the
 * server log instead so the flow can still be exercised. A deployed app never
 * falls back: without a key it refuses to send (and `/api/auth/*` refuses the
 * requests that would need mail, see `routes/api/auth/$.ts`).
 */

export type Mail = { to: string; subject: string; text: string };

export function mailConfigured(): boolean {
  return Boolean(env("RESEND_API_KEY") && env("MAIL_FROM"));
}

/** True when flows that need mail can run here (real delivery or preview log). */
export function mailAvailable(): boolean {
  return mailConfigured() || isWorkspacePreview();
}

export async function sendMail(mail: Mail): Promise<void> {
  const apiKey = env("RESEND_API_KEY");
  const from = env("MAIL_FROM");
  if (!apiKey || !from) {
    if (isWorkspacePreview()) {
      console.info(
        `[mail] (preview, not sent) to=${mail.to} subject=${mail.subject}\n${mail.text}`,
      );
      return;
    }
    throw new Error("Mail delivery is not configured (RESEND_API_KEY / MAIL_FROM).");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Never log the key or the message body (it carries a one-time token).
    throw new Error(`Mail delivery failed with status ${res.status}.`);
  }
}
