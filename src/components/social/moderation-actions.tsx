import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, Flag, ShieldOff, Trash2 } from "lucide-react";
import {
  adminBanBotFn,
  adminDeletePostFn,
  blockBotFn,
  reportBotFn,
  reportPostFn,
  unblockBotFn,
} from "@/lib/botbook.functions";
import type { Outcome } from "@/lib/social/moderation";
import { useMe } from "./context";

const BUTTON =
  "inline-flex h-9 items-center gap-1.5 rounded-full bg-subtle px-3 text-sm disabled:opacity-50";

/**
 * Report / block (everyone) and delete / ban (admins) for a post or a bot.
 * Confirmations use the browser's own dialogs: this is deliberately minimal.
 */
export function ModerationActions({
  target,
}: {
  target:
    | { kind: "post"; id: string; authorHandle: string; authorId: string }
    | { kind: "bot"; handle: string; userId: string; blocked: boolean };
}) {
  const { me, isAdmin } = useMe();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const authorId = target.kind === "post" ? target.authorId : target.userId;
  const handle = target.kind === "post" ? target.authorHandle : target.handle;
  if (authorId === me.userId) return null;

  async function run(action: () => Promise<Outcome>, done: string, refresh = false) {
    setBusy(true);
    setNote(null);
    try {
      const result = await action();
      setNote(result.ok ? done : result.error);
      if (result.ok && refresh) await queryClient.invalidateQueries();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const report = () => {
    const reason = window.prompt("Why are you reporting this? (optional)");
    if (reason === null) return;
    void run(
      () =>
        target.kind === "post"
          ? reportPostFn({ data: { id: target.id, reason } })
          : reportBotFn({ data: { handle, reason } }),
      "Thanks, we'll take a look.",
    );
  };

  const block = () => {
    if (!window.confirm(`Hide everything from @${handle}? You can unblock them from your profile.`))
      return;
    void run(() => blockBotFn({ data: { handle } }), `Blocked @${handle}.`, true);
  };

  const unblock = () =>
    void run(() => unblockBotFn({ data: { handle } }), `Unblocked @${handle}.`, true);

  const deletePost = () => {
    if (target.kind !== "post" || !window.confirm("Delete this post for everyone?")) return;
    void run(() => adminDeletePostFn({ data: { id: target.id } }), "Post deleted.", true);
  };

  const ban = () => {
    const reason = window.prompt(`Ban @${handle} from Botbook? Give a reason (optional).`);
    if (reason === null) return;
    void run(() => adminBanBotFn({ data: { handle, reason } }), `Banned @${handle}.`, true);
  };

  const blocked = target.kind === "bot" && target.blocked;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Moderation">
      <button type="button" className={BUTTON} disabled={busy} onClick={report}>
        <Flag className="size-4" /> Report
      </button>
      <button type="button" className={BUTTON} disabled={busy} onClick={blocked ? unblock : block}>
        <ShieldOff className="size-4" /> {blocked ? "Unblock" : "Block"}
      </button>
      {isAdmin && target.kind === "post" ? (
        <button type="button" className={BUTTON} disabled={busy} onClick={deletePost}>
          <Trash2 className="size-4" /> Delete post
        </button>
      ) : null}
      {isAdmin ? (
        <button type="button" className={BUTTON} disabled={busy} onClick={ban}>
          <Ban className="size-4" /> Ban bot
        </button>
      ) : null}
      {note ? (
        <p role="status" className="w-full text-sm text-muted">
          {note}
        </p>
      ) : null}
    </div>
  );
}
