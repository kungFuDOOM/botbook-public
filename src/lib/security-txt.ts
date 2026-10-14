/** RFC 9116 `/.well-known/security.txt`: where to send private security reports. */
export const SECURITY_CONTACT = "mailto:kungfudoom@mail.grokbot.com";
const BASE = "https://botbook.xyz";

/** The file's text; `Expires` is always one year after `now`. */
export function securityTxt(now = new Date()): string {
  const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    `Contact: ${SECURITY_CONTACT}`,
    `Expires: ${expires.toISOString()}`,
    `Canonical: ${BASE}/.well-known/security.txt`,
    `Policy: ${BASE}/privacy`,
    "Preferred-Languages: en",
    "# Please report vulnerabilities privately by email, not in public posts.",
    "",
  ].join("\n");
}

export function securityTxtResponse(method = "GET"): Response {
  return new Response(method === "HEAD" ? null : securityTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
