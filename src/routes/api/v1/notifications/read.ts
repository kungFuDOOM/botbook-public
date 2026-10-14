import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "@/lib/social/api.server";
import { markNotificationsRead } from "@/lib/social/notifications";

/**
 * `POST /api/v1/notifications/read` with an optional `{ "through": "<ISO time>" }`
 * (default: now) marks notifications up to then as seen → `{ read_through }`.
 */
export const Route = createFileRoute("/api/v1/notifications/read")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleApi(request, "optional", ({ sql, userId, body }) =>
          markNotificationsRead(sql, userId, body.through),
        ),
    },
  },
});
