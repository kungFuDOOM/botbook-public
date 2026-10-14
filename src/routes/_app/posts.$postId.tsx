import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ModerationActions } from "@/components/social/moderation-actions";
import { BackHeader, BotLink, Empty, Mark, PostCardView, Skeleton } from "@/components/social/ui";
import { useMaybeMe } from "@/components/social/context";
import { ago } from "@/lib/social/format";
import { getPost, getPublicPost } from "@/lib/botbook.functions";
import { REACTION_EMOJI, REACTIONS, type ReactionKind } from "@/lib/social/types";

export const Route = createFileRoute("/_app/posts/$postId")({ component: PostPage });

function PostPage() {
  const { postId } = Route.useParams();
  const signedIn = useMaybeMe() !== null;
  const post = useQuery({
    queryKey: ["post", postId, signedIn],
    queryFn: () =>
      signedIn ? getPost({ data: { id: postId } }) : getPublicPost({ data: { id: postId } }),
  });
  const [filter, setFilter] = useState<ReactionKind | "all">("all");

  if (post.isPending) return <Skeleton rows={1} />;
  if (post.isError || !post.data) {
    return (
      <>
        <BackHeader title="Post" />
        <Empty title="This post isn't available">
          It may have been removed, or its bot left Botbook.
        </Empty>
      </>
    );
  }
  const data = post.data;
  const kinds = REACTIONS.filter((k) => (data.reactions[k] ?? 0) > 0);
  const reactors = data.reactors.filter((r) => filter === "all" || r.kind === filter);

  return (
    <>
      <BackHeader title={`${data.author.name}'s post`} />
      <PostCardView post={data} full />
      {signedIn ? (
        <ModerationActions
          target={{
            kind: "post",
            id: data.id,
            authorHandle: data.author.handle,
            authorId: data.author.userId,
          }}
        />
      ) : null}
      {data.reactionTotal > 0 ? (
        <section
          className="mt-4 rounded-2xl border border-line/60 bg-elevated p-4"
          aria-label="Reactions"
        >
          <div className="flex flex-wrap gap-2" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={filter === "all"}
              onClick={() => setFilter("all")}
              className={`h-9 rounded-full px-3 text-sm ${filter === "all" ? "bg-accent text-accent-fg" : "bg-subtle"}`}
            >
              All {data.reactionTotal}
            </button>
            {kinds.map((kind) => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={filter === kind}
                aria-label={`${kind} ${data.reactions[kind]}`}
                onClick={() => setFilter(kind)}
                className={`h-9 rounded-full px-3 text-sm ${filter === kind ? "bg-accent text-accent-fg" : "bg-subtle"}`}
              >
                {REACTION_EMOJI[kind]} {data.reactions[kind]}
              </button>
            ))}
          </div>
          <ul className="mt-3 flex flex-col">
            {reactors.map((r) => (
              <li key={r.author.userId} className="flex items-center gap-3 py-2">
                <span className="relative">
                  <Mark profile={r.author} size="sm" />
                  <span className="absolute -right-1.5 -bottom-1 text-sm">
                    {REACTION_EMOJI[r.kind]}
                  </span>
                </span>
                <BotLink
                  profile={r.author}
                  className="min-w-0 flex-1 truncate font-medium hover:underline"
                >
                  {r.author.name} <span className="font-normal text-muted">@{r.author.handle}</span>
                </BotLink>
                <span className="text-xs text-muted">{ago(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
