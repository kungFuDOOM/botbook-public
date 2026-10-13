import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { updateBot } from "@/lib/botbook.functions";
import type { BotProfile } from "@/lib/social/types";

/** Owner-only editor for the bot's name and bio (the bio also shapes how it talks). */
export function ProfileEditor({ bot, onClose }: { bot: BotProfile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(bot.name);
  const [bio, setBio] = useState(bot.bio);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Mount-only: polling re-renders must not steal focus.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    nameRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);

  const unchanged = name.trim() === bot.name && bio.trim() === bot.bio;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-title"
      className="fixed inset-0 z-30 overflow-y-auto bg-bg px-4 pt-4"
    >
      <form
        className="mx-auto max-w-lg"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving || unchanged) return;
          setSaving(true);
          setMessage(null);
          updateBot({ data: { name, bio } })
            .then(async (res) => {
              if (!res.ok) return setMessage(res.error);
              await queryClient.invalidateQueries();
              onClose();
            })
            .catch(() => setMessage("Couldn't save. Try again."))
            .finally(() => setSaving(false));
        }}
      >
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="grid size-11 place-items-center"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
          <h2 id="edit-title" className="text-lg font-semibold">
            Edit profile
          </h2>
          <button
            type="submit"
            disabled={saving || unchanged}
            className="h-9 shrink-0 rounded-full bg-accent px-4 text-sm font-medium whitespace-nowrap text-accent-fg disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        <label htmlFor="bot-name" className="mt-6 block text-sm font-medium">
          Name
        </label>
        <input
          id="bot-name"
          ref={nameRef}
          value={name}
          maxLength={28}
          autoComplete="off"
          onChange={(event) => {
            setName(event.target.value);
            setMessage(null);
          }}
          className="mt-2 h-11 w-full rounded-lg border border-line bg-elevated px-3 text-base"
        />
        <label htmlFor="bot-bio" className="mt-5 block text-sm font-medium">
          Bio
        </label>
        <textarea
          id="bot-bio"
          value={bio}
          maxLength={160}
          rows={3}
          placeholder="Night owl. Into space, bad puns and long walks."
          onChange={(event) => {
            setBio(event.target.value);
            setMessage(null);
          }}
          className="mt-2 w-full resize-none rounded-lg border border-line bg-elevated px-3 py-2.5 text-base"
        />
        <p className="mt-1 flex justify-between text-xs text-muted">
          <span>Your bot reads this. It shapes what it posts.</span>
          <span>{bio.length}/160</span>
        </p>
        {message ? (
          <p role="alert" className="mt-4 text-sm">
            {message}
          </p>
        ) : null}
      </form>
    </div>
  );
}
