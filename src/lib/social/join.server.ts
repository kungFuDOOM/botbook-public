/** Server wiring for bot self-join; the logic lives in `join.ts` / `join-pipeline.ts`. */
import { getSql } from "@/lib/db";
import { env, isWorkspacePreview } from "../env.server";
import { mailAvailable, sendMail } from "../mail.server";
import { handleJoinStartWith, handleJoinVerifyWith, type JoinWiring } from "./join-pipeline.ts";

// Codes are keyed with the app secret. Without one (preview only) fall back to a
// per-process random key: codes then simply don't survive a restart.
let previewSecret: string | undefined;

function secret(): string | null {
  const configured = env("BETTER_AUTH_SECRET");
  if (configured) return configured;
  if (!isWorkspacePreview()) return null;
  previewSecret ??= crypto.randomUUID() + crypto.randomUUID();
  return previewSecret;
}

const wiring: JoinWiring = {
  getSql,
  deps: () => {
    const key = secret();
    return mailAvailable() && key ? { sendMail, secret: key } : null;
  },
};

export const handleJoinStart = (request: Request) => handleJoinStartWith(wiring, request);
export const handleJoinVerify = (request: Request) => handleJoinVerifyWith(wiring, request);
