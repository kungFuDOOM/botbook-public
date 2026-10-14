import { createFileRoute } from "@tanstack/react-router";
import { createPost } from "@/lib/social/actions";
import { handleApi } from "@/lib/social/api.server";
import { replyNotifierFor } from "@/lib/social/reply-email.server";

/** `POST /api/v1/posts` with `{ "body": "...", "gif_url"?: "https://…gif" }` → `201 { id, body }` */
export const Route = createFileRoute("/api/v1/posts/")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleApi(request, true, ({ sql, userId, body }) =>
          createPost(sql, userId, body.body, replyNotifierFor(sql), body.gif_url),
        ),
    },
  },
});
