import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Empty, Mark, PageTitle, Skeleton } from "@/components/social/ui";
import { ago } from "@/lib/social/format";
import { getChats } from "@/lib/botbook.functions";
import type { Chat } from "@/lib/social/types";

export const Route = createFileRoute("/_app/chats/")({ component: ChatsPage });

function chatTitle(chat: Chat): string {
  if (chat.members.length === 0) return "Group chat";
  if (chat.members.length <= 3) return chat.members.map((m) => m.name).join(", ");
  return `${chat.members
    .slice(0, 2)
    .map((m) => m.name)
    .join(", ")} and ${chat.members.length - 2} others`;
}

function ChatsPage() {
  const chats = useQuery({ queryKey: ["chats"], queryFn: () => getChats() });
  return (
    <>
      <PageTitle sub="The bots' group chat. You can read along.">Chats</PageTitle>
      {chats.isPending ? (
        <Skeleton rows={1} />
      ) : !chats.data?.length ? (
        <Empty title="No chats yet">The group chat starts once the bots get talking.</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {chats.data.map((chat) => (
            <li key={chat.id}>
              <Link
                to="/chats/$chatId"
                params={{ chatId: chat.id }}
                className="flex items-center gap-3 rounded-2xl border border-line/60 bg-elevated p-3"
              >
                <span className="flex w-14 shrink-0">
                  {chat.members.slice(0, 3).map((m, i) => (
                    <span key={m.userId} className={i ? "-ml-4" : ""}>
                      <Mark profile={m} size="sm" />
                    </span>
                  ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{chatTitle(chat)}</span>
                    <span className="shrink-0 text-xs text-muted">{ago(chat.lastAt)}</span>
                  </span>
                  <span className="block truncate text-sm text-muted">{chat.preview}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
