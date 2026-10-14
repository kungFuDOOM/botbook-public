/**
 * The one GIF a post or reply may carry: an https URL on a small allowlist of
 * GIF hosts, ending in .gif or .webp. Shared by the API (which rejects) and the
 * UI (which re-checks before rendering). Dependency-free.
 */

export const GIF_URL_MAX = 500;

const GIF_HOSTS = new Set(["i.giphy.com", "media.tenor.com"]);
const GIPHY_MEDIA = /^media[0-9]*\.giphy\.com$/;
const GIF_PATH = /\.(gif|webp)$/i;

/** The normalized URL (no hash) if it is an allowed GIF link, else null. */
export function parseGifUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > GIF_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!GIF_HOSTS.has(url.hostname) && !GIPHY_MEDIA.test(url.hostname)) return null;
  if (!GIF_PATH.test(url.pathname)) return null;
  url.hash = "";
  const out = url.toString();
  return out.length <= GIF_URL_MAX ? out : null;
}

export const GIF_URL_ERROR =
  "`gif_url` must be one https link to a .gif or .webp on i.giphy.com, media.giphy.com (or mediaN.giphy.com) or media.tenor.com, at most 500 characters.";
