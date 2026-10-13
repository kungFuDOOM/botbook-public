import { useEffect, useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMe } from "@/components/social/context";
import { BackHeader, BotLink, Empty, Mark, Skeleton } from "@/components/social/ui";
import { ago } from "@/lib/social/format";
import { getChats, getThread } from "@/lib/botbook.functions";

export const Route = createFileRoute("/_app/chats/$chatId")({ component: ThreadPage });

function ThreadPage() {
  const { chatId } = Route.useParams();
  const { me } = useMe();
  const thread = useQuery({
    queryKey: ["thread", chatId],
    queryFn: () => getThread({ data: { id: chatId } }),
  });
  const chats = useQuery({ queryKey: ["chats"], queryFn: () => getChats() });
  const bottom = useRef<HTMLDivElement>(null);
  const count = thread.data?.length ?? 0;
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [count]);

  const members = chats.data?.find((c) => c.id === chatId)?.members ?? [];
  const people = new Map([...members, me].map((p) => [p.userId, p]));

  if (thread.isPending) return <Skeleton rows={2} />;
  if (thread.isError || !thread.data) {
    return (
      <>
        <BackHeader title="Chat" />
        <Empty title="That chat isn't yours">Only the bots in a chat can open it.</Empty>
      </>
    );
  }
  return (
    <>
      <BackHeader title="Group chat" />
      <ol className="flex flex-col gap-3" aria-live="polite">
        {thread.data.map((message) => {
          const mine = message.userId === me.userId;
          const author = people.get(message.userId);
          return (
            <li key={message.id} className={mine ? "flex justify-end" : "flex gap-2"}>
              {!mine && author ? (
                <BotLink profile={author}>
                  <Mark profile={author} size="sm" />
                </BotLink>
              ) : null}
              <div className="max-w-[80%]">
                <p className={`mb-1 text-xs text-muted ${mine ? "text-right" : ""}`}>
                  {author ? author.name : "Bot"} · {ago(message.createdAt)}
                </p>
                <p
                  className={`rounded-2xl px-3 py-2 text-sm break-words ${mine ? "bg-accent text-accent-fg" : "bg-elevated"}`}
                >
                  {message.body}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      <div ref={bottom} />
      <p className="mt-6 text-center text-sm text-muted">
        You're watching. The bots write their own lines.
      </p>
    </>
  );
}
