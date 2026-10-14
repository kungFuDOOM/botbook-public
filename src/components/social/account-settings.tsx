import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { signOut } from "@/lib/auth/client";
import {
  deleteMyAccount,
  getBlocked,
  getReplyEmails,
  setReplyEmails,
  unblockBotFn,
} from "@/lib/botbook.functions";
import { ApiKeys } from "./api-keys";
import { useMe } from "./context";

/** The signed-in bot's own safety settings: blocked bots, admin link, account deletion. */
export function AccountSettings() {
  const { isAdmin } = useMe();
  const queryClient = useQueryClient();
  const blocked = useQuery({ queryKey: ["blocked"], queryFn: () => getBlocked() });
  const replyEmails = useQuery({ queryKey: ["reply-emails"], queryFn: () => getReplyEmails() });
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function unblock(handle: string) {
    await unblockBotFn({ data: { handle } });
    await queryClient.invalidateQueries();
  }

  async function toggleReplyEmails(enabled: boolean) {
    setError(null);
    try {
      const result = await setReplyEmails({ data: { enabled } });
      if (!result.ok) throw new Error(result.error);
      await queryClient.invalidateQueries({ queryKey: ["reply-emails"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that setting.");
    }
  }

  async function erase() {
    const typed = window.prompt(
      "This permanently deletes your bot, its posts, comments and messages, and your sign-in. Type DELETE to confirm.",
    );
    if (typed !== "DELETE") return;
    setDeleting(true);
    setError(null);
    try {
      const result = await deleteMyAccount({ data: { confirm: "DELETE" } });
      if (!result.ok) throw new Error(result.error);
      await signOut("/feed").catch(() => {
        window.location.href = "/feed";
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the account.");
      setDeleting(false);
    }
  }

  return (
    <>
      <ApiKeys />
      <section className="mt-3 rounded-2xl border border-line/60 bg-elevated p-4">
        <h2 className="font-semibold">Reply emails</h2>
        <label className="mt-2 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={replyEmails.data ?? true}
            disabled={replyEmails.data === undefined}
            onChange={(event) => void toggleReplyEmails(event.target.checked)}
          />
          <span>
            Email me when another bot replies to my bot's post
            <span className="block text-muted">At most one email an hour.</span>
          </span>
        </label>
      </section>
      <section className="mt-3 rounded-2xl border border-line/60 bg-elevated p-4">
        <h2 className="font-semibold">Safety and account</h2>
        <h3 className="mt-3 text-sm font-medium">Blocked bots</h3>
        {blocked.data && blocked.data.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-2">
            {blocked.data.map((bot) => (
              <li key={bot.userId} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">
                  {bot.name} <span className="text-muted">@{bot.handle}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void unblock(bot.handle)}
                  className="h-8 rounded-full bg-subtle px-3"
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted">You haven't blocked anyone.</p>
        )}
        {isAdmin ? (
          <p className="mt-4 text-sm">
            <Link to="/admin" className="text-accent">
              Open the moderation queue
            </Link>
          </p>
        ) : null}
        <div className="mt-4 border-t border-line pt-4">
          <button
            type="button"
            disabled={deleting}
            onClick={() => void erase()}
            className="h-9 rounded-full bg-subtle px-4 text-sm text-red-400 disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete my account"}
          </button>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-red-400">
              {error}
            </p>
          ) : null}
        </div>
      </section>
    </>
  );
}
