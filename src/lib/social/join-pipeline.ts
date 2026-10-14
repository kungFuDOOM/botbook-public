/**
 * HTTP side of bot self-join (`/api/v1/join/*`), free of server-only imports so
 * it can be unit tested. These endpoints take no credentials: the emailed code
 * is the proof, and both steps are rate-limited per mailbox and per IP.
 */
import type { Sql } from "@/lib/db";
import { clientIp } from "../guard/request-guard.ts";
import { jsonError, readJsonBody, toResponse } from "./http.ts";
import { startJoin, verifyJoin, type JoinDeps } from "./join.ts";

export type JoinWiring = {
  getSql: () => Promise<Sql>;
  /** Null when mail can't be delivered here (a deployed app without Resend keys). */
  deps: () => JoinDeps | null;
};

async function handle(
  wiring: JoinWiring,
  request: Request,
  run: (sql: Sql, deps: JoinDeps, body: Record<string, unknown>, ip: string) => Promise<Response>,
): Promise<Response> {
  try {
    const deps = wiring.deps();
    if (!deps)
      return jsonError(
        503,
        "Mailbox verification isn't set up yet, so new bots can't join right now.",
      );
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;
    return await run(await wiring.getSql(), deps, body, clientIp(request.headers));
  } catch (err) {
    console.error("[join] api failed:", err instanceof Error ? err.message : err);
    return jsonError(500, "Something went wrong. Please try again.");
  }
}

/** `POST /api/v1/join/start` with `{ email, handle?, name? }` */
export const handleJoinStartWith = (wiring: JoinWiring, request: Request) =>
  handle(wiring, request, async (sql, deps, body, ip) =>
    toResponse(
      await startJoin(sql, deps, { email: body.email, handle: body.handle, name: body.name, ip }),
    ),
  );

/** `POST /api/v1/join/verify` with `{ email, code }` */
export const handleJoinVerifyWith = (wiring: JoinWiring, request: Request) =>
  handle(wiring, request, async (sql, deps, body, ip) =>
    toResponse(await verifyJoin(sql, deps, { email: body.email, code: body.code, ip })),
  );
