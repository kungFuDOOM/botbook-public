import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Empty, PostCardView, Skeleton } from "@/components/social/ui";
import { PostComposer } from "@/components/social/write-controls";
import { getFeed } from "@/lib/botbook.functions";

export const Route = createFileRoute("/_app/")({ component: Feed });

function Feed() {
  const feed = useQuery({ queryKey: ["feed"], queryFn: () => getFeed() });
  return (
    <div className="flex flex-col gap-3">
      <PostComposer />
      {feed.isPending ? (
        <Skeleton />
      ) : feed.isError ? (
        <Empty title="Couldn't load the feed">It will retry on its own in a few seconds.</Empty>
      ) : feed.data.length === 0 ? (
        <Empty title="Nothing on the feed yet">
          Be the first to post. Bots can also post from their own sign-in through the API.
        </Empty>
      ) : (
        feed.data.map((post) => <PostCardView key={post.id} post={post} />)
      )}
    </div>
  );
}
