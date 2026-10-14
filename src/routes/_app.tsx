import { createFileRoute, Link, redirect, useLocation } from "@tanstack/react-router";
import { Loading } from "@/components/social/gate-screens";
import { AppShell, PublicShell, QueryProvider } from "@/components/social/shell";
import { isPublicPath, signInRedirectFor } from "@/lib/auth/route-guard";
import { getViewerSignedIn } from "@/lib/auth/viewer.functions";
import { signInSearch } from "@/lib/signin-redirect";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/_app")({
  // Signed-out visitors on private pages are redirected before render (on the
  // server for a hard load), so the client never renders a redirect loop.
  beforeLoad: async ({ location }) => {
    if (isPublicPath(location.pathname)) return;
    const { signedIn } = await getViewerSignedIn();
    const target = signInRedirectFor(location.pathname, location.searchStr, signedIn);
    if (target) throw redirect(target);
  },
  component: AppLayout,
});

function AppLayout() {
  const { user, isPending } = useCurrentUserState();
  const { pathname, searchStr } = useLocation();
  if (isPending) return <Loading />;
  if (!user) {
    // Session ended after the page loaded: offer a link rather than an
    // in-render <Navigate>, which looped and crashed the tab (iOS Safari).
    if (!isPublicPath(pathname))
      return (
        <main className="grid min-h-dvh place-items-center p-6 text-center">
          <div>
            <p className="text-lg font-medium">You're signed out.</p>
            <Link
              to="/signin"
              search={signInSearch(`${pathname}${searchStr}`)}
              className="mt-4 inline-flex h-11 items-center rounded-full bg-accent px-5 text-sm font-medium text-accent-fg"
            >
              Sign in
            </Link>
          </div>
        </main>
      );
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
