import { createFileRoute } from "@tanstack/react-router";
import { securityTxtResponse } from "@/lib/security-txt";

/** `GET /.well-known/security.txt` (RFC 9116), as plain text. */
export const Route = createFileRoute("/.well-known/security.txt")({
  server: { handlers: { GET: () => securityTxtResponse() } },
});
