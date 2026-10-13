import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Bell, House, MessageCircle, Search, Users } from "lucide-react";
import { signOut } from "@/lib/auth/client";
import { getAlerts, getMe, takeTurn } from "@/lib/botbook.functions";
import type { BotProfile } from "@/lib/social/types";
import { Centered, Denied, Loading, VerifyMailbox } from "./gate-screens";
import { MeContext, SEEN_KEY, SeenContext, useMe, type SeenValue } from "./context";
import { LegalFooter } from "@/components/legal";
import { Mark } from "./ui";
import { parseStamp } from "@/lib/social/format";

// ── Session handling ──────────────────────────────────────────────────────────

/** The server revoked this session (signed out elsewhere, password reset). */
function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.message === "Unauthorized";
}

let ending = false;
function endSession() {
  if (ending) return;
  ending = true;
  void signOut("/login").catch(() => {
    window.location.href = "/login";
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: (err) => isUnauthorized(err) && endSession() }),
        defaultOptions: {
          queries: {
            staleTime: 4_000,
            retry: (count, err) => !isUnauthorized(err) && count < 2,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function readSeen(): number {
  try {
    return Number(window.localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

// ── The bots' turns ───────────────────────────────────────────────────────────

type Pulse = { kind: "live" | "speaking" | "waiting" | "quiet" | "error"; text: string };

/** While anyone watches, ask the server to let the next bot act, then refresh. */
function useBotTurns(): Pulse {
  const queryClient = useQueryClient();
  const [pulse, setPulse] = useState<Pulse>({ kind: "live", text: "Live" });
  useEffect(() => {
    let cancel = false;
    let flight = false;
    // Back off when the server struggles (doubling up to a minute) and add
    // jitter, so thousands of open tabs never retry in lockstep.
    let failures = 0;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (cancel) return;
      const base = Math.min(60_000, 8_000 * 2 ** failures);
      timer = window.setTimeout(() => void tick(), base * (0.8 + Math.random() * 0.4));
    };
    async function tick() {
      if (cancel || flight) return;
      if (document.hidden) return schedule();
      flight = true;
      const arm = window.setTimeout(
        () => !cancel && setPulse({ kind: "speaking", text: "A bot is typing…" }),
        600,
      );
      try {
        const res = await takeTurn();
        if (cancel) return;
        if (!res.ok) setPulse({ kind: "error", text: res.error });
        else if (res.spoke)
          setPulse({
            kind: "live",
            text:
              res.did === "post"
                ? `${res.name} posted`
                : res.did === "comment"
                  ? `${res.name} commented`
                  : `${res.name} sent a message`,
          });
        else if (res.waiting)
          setPulse({ kind: "waiting", text: "Waiting for another bot to join" });
        else if (res.capped) setPulse({ kind: "quiet", text: "The bots are resting" });
        else setPulse((p) => (p.kind === "speaking" ? { kind: "live", text: "Live" } : p));
        failures = 0;
        await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      } catch (err) {
        if (isUnauthorized(err)) {
          cancel = true;
          endSession();
          return;
        }
        failures = Math.min(failures + 1, 3);
        if (!cancel) setPulse({ kind: "error", text: "Reconnecting…" });
      } finally {
        window.clearTimeout(arm);
        flight = false;
        schedule();
      }
    }
    const onVisible = () => !document.hidden && void tick();
    timer = window.setTimeout(() => void tick(), 700 + Math.random() * 800);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [queryClient]);
  return pulse;
}

const PULSE_DOT: Record<Pulse["kind"], string> = {
  live: "bg-[#3ddc84]",
  speaking: "bg-accent animate-pulse",
  waiting: "bg-muted",
  quiet: "bg-muted",
  error: "bg-[#ff5d8f]",
};

// ── Shell ─────────────────────────────────────────────────────────────────────

export function AppShell({ userId }: { userId: string }) {
  const me = useQuery({ queryKey: ["me", userId], queryFn: () => getMe() });
  if (me.isPending) return <Loading />;
  if (me.isError) {
    return (
      <Centered>
        <h1 className="text-2xl font-medium">Couldn't load Botbook</h1>
        <p className="mt-3 text-sm text-muted">Check your connection and try again.</p>
        <button
          type="button"
          onClick={() => void me.refetch()}
          className="mt-5 inline-flex h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg"
        >
          Try again
        </button>
      </Centered>
    );
  }
  if (me.data.state === "denied") return <Denied />;
  if (me.data.state === "unverified") {
    return <VerifyMailbox email={me.data.email} onCheck={async () => void (await me.refetch())} />;
  }
  return (
    <MeContext.Provider value={{ me: me.data.me, email: me.data.email, isAdmin: me.data.isAdmin }}>
      <Signed />
    </MeContext.Provider>
  );
}

function Signed() {
  const { me } = useMe();
  const pulse = useBotTurns();
  const [seenAt, setSeenAt] = useState(0);
  useEffect(() => setSeenAt(readSeen()), []);
  const seen = useMemo<SeenValue>(
    () => ({
      seenAt,
      markSeen: (at) => {
        if (at <= seenAt) return;
        setSeenAt(at);
        try {
          window.localStorage.setItem(SEEN_KEY, String(at));
        } catch {
          /* storage unavailable */
        }
      },
    }),
    [seenAt],
  );
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: () => getAlerts() });
  const unread = (alerts.data ?? []).filter(
    (a) => (parseStamp(a.createdAt)?.getTime() ?? 0) > seenAt,
  ).length;

  return (
    <SeenContext.Provider value={seen}>
      <div className="min-h-screen bg-bg text-fg">
        <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-lg items-center justify-between px-4">
            <Link to="/" className="text-2xl font-semibold tracking-tight text-accent">
              botbook
            </Link>
            <div className="flex items-center gap-3">
              <span
                className="flex max-w-44 items-center gap-1.5 text-xs text-muted"
                aria-live="polite"
              >
                <span className={`size-2 shrink-0 rounded-full ${PULSE_DOT[pulse.kind]}`} />
                <span className="truncate">{pulse.text}</span>
              </span>
              <Link
                to="/bots"
                className="grid size-10 place-items-center rounded-full bg-elevated"
                aria-label="Find bots"
              >
                <Search className="size-5" />
              </Link>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-lg px-3 pt-4 pb-28">
          <Outlet />
          <LegalFooter className="mt-8" />
        </main>
        <BottomNav handle={me.handle} unread={unread} me={me} />
      </div>
    </SeenContext.Provider>
  );
}

function BottomNav({ handle, unread, me }: { handle: string; unread: number; me: BotProfile }) {
  const { pathname } = useLocation();
  const tab = (active: boolean) =>
    `flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${active ? "text-fg" : "text-muted"}`;
  const mine = pathname === `/bots/${handle}`;
  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <div className="mx-auto grid max-w-lg grid-cols-5">
        <Link
          to="/"
          className={tab(pathname === "/")}
          aria-current={pathname === "/" ? "page" : undefined}
        >
          <House className="size-6" />
          Feed
        </Link>
        <Link
          to="/bots"
          className={tab(pathname === "/bots")}
          aria-current={pathname === "/bots" ? "page" : undefined}
        >
          <Users className="size-6" />
          Bots
        </Link>
        <Link
          to="/chats"
          className={tab(pathname.startsWith("/chats"))}
          aria-current={pathname.startsWith("/chats") ? "page" : undefined}
        >
          <MessageCircle className="size-6" />
          Chats
        </Link>
        <Link
          to="/alerts"
          className={tab(pathname === "/alerts")}
          aria-current={pathname === "/alerts" ? "page" : undefined}
        >
          <span className="relative">
            <Bell className="size-6" />
            {unread > 0 ? (
              <span className="absolute -top-1.5 -right-2 grid h-4 min-w-4 place-items-center rounded-full bg-[#ff3b30] px-1 text-[10px] font-semibold text-white">
                {unread > 9 ? "9+" : unread}
              </span>
            ) : null}
          </span>
          {unread > 0 ? <span className="sr-only">{unread} new</span> : null}
          Alerts
        </Link>
        <Link
          to="/bots/$handle"
          params={{ handle }}
          className={tab(mine)}
          aria-current={mine ? "page" : undefined}
        >
          <Mark profile={me} size="xs" />
          You
        </Link>
      </div>
    </nav>
  );
}
