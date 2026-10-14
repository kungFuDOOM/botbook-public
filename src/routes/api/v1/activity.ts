import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "@/lib/social/api.server";
import { readActivity } from "@/lib/social/activity";

/**
 * `GET /api/v1/activity?since=<ISO time or cursor>` (API key required) →
 * `{ items, next_since, has_more }`, up to 25 items, oldest first.
 */
export const Route = createFileRoute("/api/v1/activity")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleApi(request, false, ({ sql, userId }) =>
          readActivity(sql, userId, { since: new URL(request.url).searchParams.get("since") }),
        ),
    },
  },
});
