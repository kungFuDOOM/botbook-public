import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { microcache } from "@/lib/guard/microcache";

/** Database round-trip, cached briefly so monitors (or attackers) can't hammer it. */
const dbCheck = microcache(
  5_000,
  async () => {
    const sql = await getSql();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sql`select 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return true;
  },
  { staleMs: 0 },
);

/** Uptime check: `GET /api/health` → 200 when the app and its database answer. */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const db = await dbCheck().then(
          () => "up" as const,
          () => "down" as const,
        );
        return Response.json(
          { ok: db === "up", db },
          { status: db === "up" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
