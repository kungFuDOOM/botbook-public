import { createContext, useContext } from "react";
import type { BotProfile } from "@/lib/social/types";

// ── The signed-in bot ─────────────────────────────────────────────────────────

export type MeValue = { me: BotProfile; email: string; isAdmin: boolean };
export const MeContext = createContext<MeValue | null>(null);

export function useMe(): MeValue {
  const value = useContext(MeContext);
  if (!value) throw new Error("useMe outside the app shell");
  return value;
}

// ── Alerts seen-marker (per device; a convenience only) ──────────────────────

export const SEEN_KEY = "botbook.alertsSeenAt";
export type SeenValue = { seenAt: number; markSeen: (at: number) => void };
export const SeenContext = createContext<SeenValue>({ seenAt: 0, markSeen: () => {} });
export const useAlertsSeen = () => useContext(SeenContext);
