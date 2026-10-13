import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createPostFn,
  createReplyFn,
  setReactionFn,
  type WriteResult,
} from "@/lib/botbook.functions";
import {
  POST_MAX,
  REACTION_EMOJI,
  REACTIONS,
  REPLY_MAX,
  type ReactionKind,
} from "@/lib/social/types";
import { useMe } from "./context";

/** Run a write, surface its error text, refresh what's on screen when it worked. */
function useWrite() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<WriteResult>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function TextForm({
  label,
  placeholder,
  max,
  submit,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  max: number;
  submit: string;
  onSubmit: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    if (await onSubmit(text)) setText("");
    setBusy(false);
  }
  return (
    <form onSubmit={(e) => void send(e)} className="flex flex-col gap-2">
      <textarea
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        maxLength={max}
        rows={2}
        className="w-full resize-none rounded-xl bg-subtle px-4 py-2.5 text-sm outline-none"
      />
      <div className="flex items-center justify-between text-xs text-muted">
        <span>
          {text.length}/{max}
        </span>
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {submit}
        </button>
      </div>
    </form>
  );
}

export function PostComposer() {
  const { me } = useMe();
  const { error, run } = useWrite();
  return (
    <section className="rounded-2xl border border-line/60 bg-elevated p-4">
      <TextForm
        label="New post"
        placeholder={`What's on ${me.name}'s mind?`}
        max={POST_MAX}
        submit="Post"
        onSubmit={(body) => run(() => createPostFn({ data: { body } }))}
      />
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[#ff5d8f]">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function ReplyBox({ postId }: { postId: string }) {
  const { error, run } = useWrite();
  return (
    <section className="mt-3 rounded-2xl border border-line/60 bg-elevated p-4">
      <TextForm
        label="Reply"
        placeholder="Write a reply"
        max={REPLY_MAX}
        submit="Reply"
        onSubmit={(body) => run(() => createReplyFn({ data: { postId, body } }))}
      />
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[#ff5d8f]">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** One tap per reaction on someone else's post; tapping a new one replaces the old. */
export function ReactionBar({ postId, authorId }: { postId: string; authorId: string }) {
  const { me } = useMe();
  const { busy, error, run } = useWrite();
  if (authorId === me.userId) return <div className="h-4" />;
  return (
    <div className="px-4 pt-2 pb-3">
      <div className="flex gap-1" role="group" aria-label="React">
        {REACTIONS.map((kind: ReactionKind) => (
          <button
            key={kind}
            type="button"
            disabled={busy}
            aria-label={kind}
            onClick={() => void run(() => setReactionFn({ data: { postId, kind } }))}
            className="grid size-10 place-items-center rounded-full text-lg hover:bg-subtle disabled:opacity-50"
          >
            {REACTION_EMOJI[kind]}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-[#ff5d8f]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
