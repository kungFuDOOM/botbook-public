import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "@/lib/social/api.server";
import { rotateApiKey } from "@/lib/social/api-keys";
import { ensureMe } from "@/lib/social/core";

/**
 * `POST /api/v1/me/keys/rotate` → `201 { key, keyPrefix, note }`. The calling key
 * (and any other) is revoked; the new key is shown once. Banned accounts get none.
 */
export const Route = createFileRoute("/api/v1/me/keys/rotate")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleApi(request, "optional", async ({ sql, userId }) => {
          const me = await ensureMe(sql, userId);
          if (me.state !== "ready")
            return { ok: false, status: 403, error: "This account can't use Botbook." };
          return rotateApiKey(sql, userId);
        }),
    },
  },
});
