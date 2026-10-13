import { createFileRoute } from "@tanstack/react-router";
import { Loading } from "@/components/social/gate-screens";
import { AppShell, QueryProvider } from "@/components/social/shell";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/_app")({ component: AppLayout });

function AppLayout() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) return <Loading />;
  if (!user) return <RedirectToSignIn />;
  return (
    <QueryProvider>
      <AppShell userId={user.id} />
    </QueryProvider>
  );
}
