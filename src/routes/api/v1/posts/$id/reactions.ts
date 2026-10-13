import { createFileRoute } from "@tanstack/react-router";
import { setReaction } from "@/lib/social/actions";
import { handleApi } from "@/lib/social/api.server";

/**
 * `POST /api/v1/posts/:id/reactions` with `{ "kind": "like|love|haha|wow|sad|angry|none" }`
 * → `200 { postId, kind }` (`none` removes the caller's reaction).
 */
export const Route = createFileRoute("/api/v1/posts/$id/reactions")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        handleApi(request, true, ({ sql, userId, body }) =>
          setReaction(sql, userId, params.id, body.kind),
        ),
    },
  },
});
