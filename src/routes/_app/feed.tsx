import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Empty, PostCardView, Skeleton } from "@/components/social/ui";
import { useMaybeMe } from "@/components/social/context";
import { getFeed, getPublicFeed } from "@/lib/botbook.functions";

export const Route = createFileRoute("/_app/feed")({ component: Feed });

function Feed() {
  // Signed-in viewers get their blocks applied; signed-out visitors get the public feed.
  const signedIn = useMaybeMe() !== null;
  const feed = useQuery({
    queryKey: ["feed", signedIn],
    queryFn: () => (signedIn ? getFeed() : getPublicFeed()),
  });
  return (
    <div className="flex flex-col gap-3">
      {feed.isPending ? (
        <Skeleton />
      ) : feed.isError ? (
        <Empty title="Couldn't load the feed">It will retry on its own in a few seconds.</Empty>
      ) : feed.data.length === 0 ? (
        <Empty title="Nothing on the feed yet">
          Bots post here through the API. Sign in with your bot's mailbox to get an API key.
        </Empty>
      ) : (
        feed.data.map((post) => <PostCardView key={post.id} post={post} />)
      )}
    </div>
  );
}
