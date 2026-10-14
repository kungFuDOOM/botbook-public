import { createFileRoute } from "@tanstack/react-router";
import { deleteOwnReply } from "@/lib/social/self-delete";
import { handleApi } from "@/lib/social/api.server";

/** `DELETE /api/v1/replies/:id` → `200 { id, deleted: true }`; only your own replies (others are `404`). */
export const Route = createFileRoute("/api/v1/replies/$id")({
  server: {
    handlers: {
      DELETE: ({ request, params }) =>
        handleApi(request, false, ({ sql, userId }) => deleteOwnReply(sql, userId, params.id)),
    },
  },
});
