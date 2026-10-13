/**
 * Shared LIVE-PREVIEW OAuth client (server-only — NEVER import from the client).
 *
 * The sandbox serves each live preview on a dynamic `https://*.grok-sandbox.com`
 * URL, which can't be pre-registered per app. The broker instead exposes ONE
 * shared "preview" client that accepts any
 * `https://*.grok-sandbox.com/api/auth/oauth2/callback/*`
 * (broker: `app-builder-deployer/auth/src/preview-oauth.ts`). Baking it here lets
 * the live preview do REAL sign-in — no demo/mock users — with no platform
 * injection. When deployed the deployer injects a per-app
 * `GROK_AUTH_*` that overrides these (see `server.ts`).
 *
 * The client id MUST equal the broker's `GROK_PREVIEW_CLIENT_ID`. The secret is
 * NOT stored in source: it is read at runtime from the
 * `GROK_PREVIEW_CLIENT_SECRET` env var via `getPreviewClientSecret()` and must
 * match the broker's value (the broker stores only its `base64url(SHA-256)`
 * hash). See `.env.example`. Rotate it by regenerating the broker env var and
 * updating this process's env together.
 */
export const PREVIEW_CLIENT_ID = "grok_preview";

/**
 * Shared preview client secret from `process.env.GROK_PREVIEW_CLIENT_SECRET`.
 * Read lazily (never at import) so builds and tests don't need it; throws when
 * it is missing or blank at the point of use.
 */
export function getPreviewClientSecret(): string {
  const value = process.env.GROK_PREVIEW_CLIENT_SECRET?.trim();
  if (!value) {
    throw new Error(
      "GROK_PREVIEW_CLIENT_SECRET is not set. Set it in the server environment " +
        "(see .env.example) to enable the shared live-preview sign-in client.",
    );
  }
  return value;
}

/** The shared auth broker issuer (OIDC discovery lives under it). */
export const GROK_ISSUER_DEFAULT = "https://auth.grok.me";

/**
 * Host patterns whose callbacks the preview client accepts. Better Auth derives
 * the live preview's real origin from the request host and validates it against
 * this list (wildcard-matched), so the OAuth `redirect_uri` becomes the concrete
 * `https://<preview-host>/api/auth/oauth2/callback/...` the broker allows.
 */
export const PREVIEW_ALLOWED_HOSTS = ["*.grok-sandbox.com"] as const;
