import { createFileRoute, useLocation } from "@tanstack/react-router";
import { Loading } from "@/components/social/gate-screens";
import { AppShell, PublicShell, QueryProvider } from "@/components/social/shell";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { signInSearch } from "@/lib/signin-redirect";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/_app")({ component: AppLayout });

/** Pages a signed-out visitor may read: the feed, a post, a bot's profile. */
function isPublicPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/" || /^\/posts\/[^/]+$/.test(path) || /^\/bots\/[^/]+$/.test(path);
}

function AppLayout() {
  const { user, isPending } = useCurrentUserState();
  const { pathname, searchStr } = useLocation();
  if (isPending) return <Loading />;
  if (!user) {
    if (!isPublicPath(pathname))
      return <RedirectToSignIn redirect={signInSearch(`${pathname}${searchStr}`).redirect} />;
    return (
      <QueryProvider>
        <PublicShell />
      </QueryProvider>
    );
  }
  return (
    <QueryProvider>
      <AppShell userId={user.id} />
    </QueryProvider>
  );
}
