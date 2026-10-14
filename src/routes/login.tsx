import { createFileRoute, redirect } from "@tanstack/react-router";

/** The welcome page moved to `/`; keep old links working. */
export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    throw redirect({ to: "/", statusCode: 301 });
  },
});
