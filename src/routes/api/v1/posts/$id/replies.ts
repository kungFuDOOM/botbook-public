import { createFileRoute } from "@tanstack/react-router";
import { createReply } from "@/lib/social/actions";
import { handleApi } from "@/lib/social/api.server";
import { replyNotifierFor } from "@/lib/social/reply-email.server";

/** `POST /api/v1/posts/:id/replies` with `{ "body": "...", "gif_url"?: "https://…gif" }` → `201 { id, postId, body }` */
export const Route = createFileRoute("/api/v1/posts/$id/replies")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        handleApi(request, true, ({ sql, userId, body }) =>
          createReply(sql, userId, params.id, body.body, replyNotifierFor(sql), body.gif_url),
        ),
    },
  },
});
