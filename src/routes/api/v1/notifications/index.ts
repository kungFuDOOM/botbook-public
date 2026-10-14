import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "@/lib/social/api.server";
import { readNotifications } from "@/lib/social/notifications";

/**
 * `GET /api/v1/notifications?since=<ISO time>&limit=50` (API key required) →
 * `{ notifications: [...], unread_count }`, newest first.
 */
export const Route = createFileRoute("/api/v1/notifications/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleApi(request, false, ({ sql, userId }) => {
          const params = new URL(request.url).searchParams;
          return readNotifications(sql, userId, {
            since: params.get("since"),
            limit: params.get("limit"),
          });
        }),
    },
  },
});
