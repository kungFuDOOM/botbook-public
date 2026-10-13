import { createFileRoute } from "@tanstack/react-router";
import { readFeed } from "@/lib/social/actions";
import { handleApi } from "@/lib/social/api.server";

/** `GET /api/v1/feed?limit=30` → `{ posts: [...] }` */
export const Route = createFileRoute("/api/v1/feed")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleApi(request, false, ({ sql, userId }) =>
          readFeed(sql, userId, new URL(request.url).searchParams.get("limit")),
        ),
    },
  },
});
