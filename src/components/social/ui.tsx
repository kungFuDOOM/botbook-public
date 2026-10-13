import type { ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import {
  REACTION_EMOJI,
  REACTIONS,
  type CommentView,
  type PostCard,
  type Profile,
  type ReactionKind,
} from "@/lib/social/types";

import { ago } from "@/lib/social/format";
import { ReactionBar } from "./write-controls";

const FILL = [
  "bg-blob-0",
  "bg-blob-1",
  "bg-blob-2",
  "bg-blob-3",
  "bg-blob-4",
  "bg-blob-5",
] as const;

const SIZES = {
  xs: { box: "size-6", eye: "h-1.5 w-0.5", gap: "gap-0.5" },
  sm: { box: "size-8", eye: "h-2 w-1", gap: "gap-0.5" },
  md: { box: "size-11", eye: "h-3 w-1.5", gap: "gap-1" },
  lg: { box: "size-24", eye: "h-5 w-2", gap: "gap-1.5" },
} as const;

/** A bot's face: the blob with two eyes, in the bot's color. */
export function Mark({ profile, size = "md" }: { profile: Profile; size?: keyof typeof SIZES }) {
  const s = SIZES[size];
  return (
    <span
      data-hue={profile.hue % 6}
      className={`blob relative grid shrink-0 place-items-center ${s.box} ${FILL[profile.hue % 6]}`}
      aria-hidden="true"
    >
      <span className={`flex ${s.gap}`}>
        <span className={`${s.eye} rounded-full bg-bg`} />
        <span className={`${s.eye} rounded-full bg-bg`} />
      </span>
    </span>
  );
}

export function BotLink({
  profile,
  className = "",
  children,
}: {
  profile: Profile;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link to="/bots/$handle" params={{ handle: profile.handle }} className={className}>
      {children}
    </Link>
  );
}

function topKinds(reactions: PostCard["reactions"]): ReactionKind[] {
  return REACTIONS.filter((k) => (reactions[k] ?? 0) > 0)
    .sort((a, b) => (reactions[b] ?? 0) - (reactions[a] ?? 0))
    .slice(0, 3);
}

export function ReactionStack({
  reactions,
  total,
}: {
  reactions: PostCard["reactions"];
  total: number;
}) {
  const kinds = topKinds(reactions);
  if (total === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={`${total} reactions`}>
      <span className="flex">
        {kinds.map((kind, i) => (
          <span
            key={kind}
            className={`grid size-5 place-items-center rounded-full bg-elevated text-[13px] ring-2 ring-elevated ${i ? "-ml-1" : ""}`}
          >
            {REACTION_EMOJI[kind]}
          </span>
        ))}
      </span>
      <span>{total}</span>
    </span>
  );
}

export function CommentRow({ comment }: { comment: CommentView }) {
  return (
    <li className="flex gap-2">
      <BotLink profile={comment.author} className="mt-0.5">
        <Mark profile={comment.author} size="sm" />
      </BotLink>
      <div className="min-w-0">
        <div className="rounded-2xl bg-subtle px-3 py-2">
          <BotLink profile={comment.author} className="text-sm font-medium hover:underline">
            {comment.author.name}
          </BotLink>
          <p className="text-sm break-words">{comment.body}</p>
        </div>
        <p className="mt-0.5 pl-3 text-xs text-muted">{ago(comment.createdAt)}</p>
      </div>
    </li>
  );
}

export function PostCardView({ post, full = false }: { post: PostCard; full?: boolean }) {
  const hidden = post.commentCount - post.comments.length;
  return (
    <article className="rounded-2xl border border-line/60 bg-elevated">
      <header className="flex items-center gap-3 px-4 pt-4">
        <BotLink profile={post.author}>
          <Mark profile={post.author} />
        </BotLink>
        <div className="min-w-0">
          <BotLink profile={post.author} className="block truncate font-medium hover:underline">
            {post.author.name}
          </BotLink>
          <p className="truncate text-sm text-muted">
            @{post.author.handle} ·{" "}
            <Link to="/posts/$postId" params={{ postId: post.id }} className="hover:underline">
              {ago(post.createdAt)}
            </Link>
          </p>
        </div>
      </header>
      {full ? (
        <p className="px-4 pt-3 text-lg leading-snug break-words">{post.body}</p>
      ) : (
        <Link
          to="/posts/$postId"
          params={{ postId: post.id }}
          className="block px-4 pt-3 text-[15px] break-words"
        >
          {post.body}
        </Link>
      )}
      {post.reactionTotal > 0 || post.commentCount > 0 ? (
        <div className="mx-4 mt-3 flex items-center justify-between border-b border-line pb-2.5 text-sm text-muted">
          <ReactionStack reactions={post.reactions} total={post.reactionTotal} />
          {post.commentCount > 0 ? (
            <Link
              to="/posts/$postId"
              params={{ postId: post.id }}
              className="ml-auto hover:underline"
            >
              {post.commentCount} {post.commentCount === 1 ? "comment" : "comments"}
            </Link>
          ) : null}
        </div>
      ) : null}
      {post.comments.length > 0 ? (
        <div className="px-4 pt-3">
          {hidden > 0 && !full ? (
            <Link
              to="/posts/$postId"
              params={{ postId: post.id }}
              className="mb-2 block text-sm font-medium text-muted hover:underline"
            >
              View {hidden} more {hidden === 1 ? "comment" : "comments"}
            </Link>
          ) : null}
          <ul className="flex flex-col gap-2">
            {post.comments.map((comment) => (
              <CommentRow key={comment.id} comment={comment} />
            ))}
          </ul>
        </div>
      ) : null}
      <ReactionBar postId={post.id} authorId={post.author.userId} />
    </article>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children ? <p className="mt-2 text-sm text-muted">{children}</p> : null}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-36 animate-pulse rounded-2xl bg-elevated" />
      ))}
    </div>
  );
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>
      {sub ? <p className="mt-1 text-sm text-muted">{sub}</p> : null}
    </div>
  );
}

export function BackHeader({ title }: { title: string }) {
  const router = useRouter();
  return (
    <div className="mb-3 flex items-center gap-2">
      <button
        type="button"
        onClick={() =>
          window.history.length > 1 ? router.history.back() : void router.navigate({ to: "/" })
        }
        className="grid size-10 place-items-center rounded-full bg-elevated"
        aria-label="Back"
      >
        <ChevronLeft className="size-5" />
      </button>
      <h1 className="text-lg font-semibold">{title}</h1>
    </div>
  );
}
