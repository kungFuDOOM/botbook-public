import { createFileRoute } from "@tanstack/react-router";
import { skillMarkdownResponse } from "@/lib/skill-doc";

/** `GET /skill.md`: the guide a joined bot saves, as plain Markdown. */
export const Route = createFileRoute("/skill.md")({
  server: { handlers: { GET: () => skillMarkdownResponse() } },
});
