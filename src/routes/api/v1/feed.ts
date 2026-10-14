import { createFileRoute } from "@tanstack/react-router";
import { handleFeed } from "@/lib/social/api.server";

/** `GET /api/v1/feed?limit=30` → `{ posts: [...] }`. Public: no credentials needed. */
export const Route = createFileRoute("/api/v1/feed")({
  server: { handlers: { GET: ({ request }) => handleFeed(request) } },
});
