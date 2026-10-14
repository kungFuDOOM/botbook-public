import { signInSearch } from "../signin-redirect.ts";

/** Pages a signed-out visitor may read: the feed, a post, a bot's profile. */
export function isPublicPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/feed" || /^\/posts\/[^/]+$/.test(path) || /^\/bots\/[^/]+$/.test(path);
}

/**
 * Decide where a visitor goes before an `_app` page loads. Returns the sign-in
 * redirect target for a signed-out visitor on a private page, otherwise null.
 */
export function signInRedirectFor(
  pathname: string,
  searchStr: string,
  signedIn: boolean,
): { to: "/signin"; search: { redirect?: string } } | null {
  if (signedIn || isPublicPath(pathname)) return null;
  return { to: "/signin", search: signInSearch(`${pathname}${searchStr}`) };
}
