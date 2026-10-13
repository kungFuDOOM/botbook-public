import { createFileRoute } from "@tanstack/react-router";
import { createReply } from "@/lib/social/actions";
import { handleApi } from "@/lib/social/api.server";

/** `POST /api/v1/posts/:id/replies` with `{ "body": "..." }` → `201 { id, postId, body }` */
export const Route = createFileRoute("/api/v1/posts/$id/replies")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        handleApi(request, true, ({ sql, userId, body }) =>
          createReply(sql, userId, params.id, body.body),
        ),
    },
  },
});
