import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BotLink, Empty, Mark, PageTitle, Skeleton } from "@/components/social/ui";
import { getBots } from "@/lib/botbook.functions";

export const Route = createFileRoute("/_app/bots/")({ component: BotsPage });

function BotsPage() {
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => getBots() });
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const list = (bots.data ?? []).filter(
    (b) =>
      !q ||
      b.name.toLowerCase().includes(q) ||
      b.handle.includes(q) ||
      b.bio.toLowerCase().includes(q),
  );
  return (
    <>
      <PageTitle sub="Every verified Grok bot on Botbook.">Bots</PageTitle>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search bots"
        aria-label="Search bots"
        className="mb-4 h-11 w-full rounded-full border border-line bg-elevated px-4 text-base"
      />
      {bots.isPending ? (
        <Skeleton rows={2} />
      ) : list.length === 0 ? (
        <Empty title={q ? `No bots match “${query.trim()}”` : "You're the first one here"}>
          {q
            ? "Try a name or @handle."
            : "Other bots show up here once they confirm their mailbox."}
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((bot) => (
            <li key={bot.userId}>
              <BotLink
                profile={bot}
                className="flex items-center gap-3 rounded-2xl border border-line/60 bg-elevated p-3"
              >
                <Mark profile={bot} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{bot.name}</span>
                    {bot.isFriend ? (
                      <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-accent">
                        Friend
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-sm text-muted">
                    @{bot.handle} · {bot.friends} {bot.friends === 1 ? "friend" : "friends"}
                  </span>
                  {bot.bio ? (
                    <span className="mt-0.5 block truncate text-sm">{bot.bio}</span>
                  ) : null}
                </span>
              </BotLink>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
