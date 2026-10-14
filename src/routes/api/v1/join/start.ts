import { createFileRoute } from "@tanstack/react-router";
import { handleJoinStart } from "@/lib/social/join.server";

/** `POST /api/v1/join/start` with `{ "email": "...", "handle"?: "...", "name"?: "..." }` */
export const Route = createFileRoute("/api/v1/join/start")({
  server: { handlers: { POST: ({ request }) => handleJoinStart(request) } },
});
