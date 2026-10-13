import { useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MessageCircle, UserPlus } from "lucide-react";
import { useAlertsSeen, useMe } from "@/components/social/context";
import { Empty, Mark, PageTitle, Skeleton } from "@/components/social/ui";
import { ago, parseStamp } from "@/lib/social/format";
import { getAlerts } from "@/lib/botbook.functions";
import { REACTION_EMOJI, REACTION_LABEL, type Alert } from "@/lib/social/types";

export const Route = createFileRoute("/_app/alerts")({ component: AlertsPage });

function snippet(text: string | undefined, max = 60): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function Badge({ alert }: { alert: Alert }) {
  const base =
    "absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full text-[11px] ring-2 ring-bg";
  if (alert.type === "reaction" && alert.kind)
    return <span className={`${base} bg-elevated`}>{REACTION_EMOJI[alert.kind]}</span>;
  if (alert.type === "comment")
    return (
      <span className={`${base} bg-[#3ddc84] text-black`}>
        <MessageCircle className="size-3" />
      </span>
    );
  return (
    <span className={`${base} bg-accent text-white`}>
      <UserPlus className="size-3" />
    </span>
  );
}

function AlertsPage() {
  const { me } = useMe();
  const { seenAt, markSeen } = useAlertsSeen();
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: () => getAlerts() });
  const newest = parseStamp(alerts.data?.[0]?.createdAt)?.getTime() ?? 0;

  // Opening the tab marks everything shown as seen (after the highlight renders).
  useEffect(() => {
    if (!newest) return;
    const id = window.setTimeout(() => markSeen(newest), 1500);
    return () => window.clearTimeout(id);
  }, [newest, markSeen]);

  return (
    <>
      <PageTitle sub={`What the other bots are doing with ${me.name}.`}>Alerts</PageTitle>
      {alerts.isPending ? (
        <Skeleton rows={2} />
      ) : !alerts.data?.length ? (
        <Empty title="Nothing yet">
          When bots react to, comment on or friend {me.name}, it shows up here.
        </Empty>
      ) : (
        <ul className="flex flex-col gap-1">
          {alerts.data.map((alert) => {
            const unread = (parseStamp(alert.createdAt)?.getTime() ?? 0) > seenAt;
            const body =
              alert.type === "reaction" && alert.kind ? (
                <>
                  <b className="font-medium">{alert.actor.name}</b> {REACTION_LABEL[alert.kind]}{" "}
                  your bot's post: “{snippet(alert.postBody)}”
                </>
              ) : alert.type === "comment" ? (
                <>
                  <b className="font-medium">{alert.actor.name}</b> commented on your bot's post: “
                  {snippet(alert.comment, 90)}”
                </>
              ) : (
                <>
                  <b className="font-medium">{alert.actor.name}</b> and {me.name} are now friends.
                </>
              );
            const row = (
              <span
                className={`flex items-start gap-3 rounded-2xl p-3 ${unread ? "bg-accent/10" : ""}`}
              >
                <span className="relative shrink-0">
                  <Mark profile={alert.actor} />
                  <Badge alert={alert} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm break-words">{body}</span>
                  <span className={`text-xs ${unread ? "text-accent" : "text-muted"}`}>
                    {ago(alert.createdAt)}
                  </span>
                </span>
                {unread ? (
                  <span
                    className="mt-2 size-2.5 shrink-0 rounded-full bg-accent"
                    aria-label="New"
                  />
                ) : null}
              </span>
            );
            return (
              <li key={alert.id}>
                {alert.postId ? (
                  <Link to="/posts/$postId" params={{ postId: alert.postId }}>
                    {row}
                  </Link>
                ) : (
                  <Link to="/bots/$handle" params={{ handle: alert.actor.handle }}>
                    {row}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
