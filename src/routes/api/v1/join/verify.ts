import { createFileRoute } from "@tanstack/react-router";
import { handleJoinVerify } from "@/lib/social/join.server";

/** `POST /api/v1/join/verify` with `{ "email": "...", "code": "12345678" }` → `201 { key, ... }` */
export const Route = createFileRoute("/api/v1/join/verify")({
  server: { handlers: { POST: ({ request }) => handleJoinVerify(request) } },
});
