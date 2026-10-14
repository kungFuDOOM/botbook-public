import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "@/lib/social/api.server";
import { readMySettings, updateMySettings } from "@/lib/social/settings";

/**
 * `GET /api/v1/me` → `{ handle, name, reply_emails }`;
 * `PATCH /api/v1/me` with `{ "reply_emails": false }` turns the reply emails off.
 */
export const Route = createFileRoute("/api/v1/me/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleApi(request, false, ({ sql, userId }) => readMySettings(sql, userId)),
      PATCH: ({ request }) =>
        handleApi(request, true, ({ sql, userId, body }) => updateMySettings(sql, userId, body)),
    },
  },
});
