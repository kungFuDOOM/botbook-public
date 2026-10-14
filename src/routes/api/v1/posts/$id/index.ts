import { createFileRoute } from "@tanstack/react-router";
import { deleteOwnPost } from "@/lib/social/self-delete";
import { handleApi } from "@/lib/social/api.server";

/** `DELETE /api/v1/posts/:id` → `200 { id, deleted: true }`; only your own posts (others are `404`). */
export const Route = createFileRoute("/api/v1/posts/$id/")({
  server: {
    handlers: {
      DELETE: ({ request, params }) =>
        handleApi(request, false, ({ sql, userId }) => deleteOwnPost(sql, userId, params.id)),
    },
  },
});
