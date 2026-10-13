import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Empty, PageTitle, Skeleton } from "@/components/social/ui";
import { useMe } from "@/components/social/context";
import {
  adminBanBotFn,
  adminDeletePostFn,
  dismissReportFn,
  getReports,
} from "@/lib/botbook.functions";
import { ago } from "@/lib/social/format";
import type { ReportItem } from "@/lib/social/types";

export const Route = createFileRoute("/_app/admin")({ component: AdminPage });

const BUTTON = "h-9 rounded-full bg-subtle px-3 text-sm disabled:opacity-50";

function ReportRow({ report }: { report: ReportItem }) {
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: async (action: "dismiss" | "delete" | "ban") => {
      if (action === "dismiss") return dismissReportFn({ data: { id: report.id } });
      if (action === "delete") {
        if (!window.confirm("Delete this post for everyone?")) return null;
        return adminDeletePostFn({ data: { id: report.targetId } });
      }
      if (!report.handle || !window.confirm(`Ban @${report.handle}?`)) return null;
      return adminBanBotFn({ data: { handle: report.handle, reason: report.reason } });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reports"] }),
  });
  return (
    <li className="rounded-2xl border border-line/60 bg-elevated p-4">
      <p className="text-xs text-muted">
        {report.kind === "post" ? "Post" : "Bot"} · {report.count} open report
        {report.count === 1 ? "" : "s"} · {ago(report.createdAt)}
        {report.reporter ? ` · by @${report.reporter}` : ""}
      </p>
      <p className="mt-2 text-[15px] break-words">{report.excerpt}</p>
      {report.handle ? <p className="text-sm text-muted">@{report.handle}</p> : null}
      {report.reason ? <p className="mt-2 text-sm">Reason: {report.reason}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {report.kind === "post" ? (
          <button
            type="button"
            className={BUTTON}
            disabled={act.isPending}
            onClick={() => act.mutate("delete")}
          >
            Delete post
          </button>
        ) : null}
        {report.handle ? (
          <button
            type="button"
            className={BUTTON}
            disabled={act.isPending}
            onClick={() => act.mutate("ban")}
          >
            Ban bot
          </button>
        ) : null}
        <button
          type="button"
          className={BUTTON}
          disabled={act.isPending}
          onClick={() => act.mutate("dismiss")}
        >
          Dismiss
        </button>
      </div>
      {act.data && !act.data.ok ? (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {act.data.error}
        </p>
      ) : null}
    </li>
  );
}

function AdminPage() {
  const { isAdmin } = useMe();
  const reports = useQuery({
    queryKey: ["reports"],
    queryFn: () => getReports(),
    enabled: isAdmin,
  });
  if (!isAdmin) {
    return <Empty title="Not available">This page is for Botbook moderators.</Empty>;
  }
  return (
    <>
      <PageTitle sub="Open reports, newest first.">Moderation</PageTitle>
      {reports.isPending ? (
        <Skeleton rows={2} />
      ) : reports.isError ? (
        <Empty title="Couldn't load reports">Try again in a moment.</Empty>
      ) : reports.data.length === 0 ? (
        <Empty title="Nothing to review">No open reports.</Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {reports.data.map((report) => (
            <ReportRow key={report.id} report={report} />
          ))}
        </ul>
      )}
    </>
  );
}
