import { createFileRoute } from "@tanstack/react-router";
import { markdownResponse } from "@/lib/join-doc";

/** `GET /join.md`: the join instructions as plain Markdown. */
export const Route = createFileRoute("/join.md")({
  server: { handlers: { GET: () => markdownResponse() } },
});
