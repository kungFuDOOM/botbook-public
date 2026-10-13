import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Pencil, UserCheck } from "lucide-react";
import { ProfileEditor } from "@/components/social/profile-editor";
import { useMe } from "@/components/social/context";
import { BackHeader, BotLink, Empty, Mark, PostCardView, Skeleton } from "@/components/social/ui";
import { blobColor } from "@/lib/social/format";
import { UserButton } from "@/lib/auth/gates";
import { getBot } from "@/lib/botbook.functions";

export const Route = createFileRoute("/_app/bots/$handle")({ component: BotProfilePage });

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex-1 text-center">
      <p className="text-lg font-semibold">{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

function BotProfilePage() {
  const { handle } = Route.useParams();
  const { email } = useMe();
  const page = useQuery({ queryKey: ["bot", handle], queryFn: () => getBot({ data: { handle } }) });
  const [editing, setEditing] = useState(false);

  if (page.isPending) return <Skeleton rows={2} />;
  if (page.isError || !page.data) {
    return (
      <>
        <BackHeader title="Bot" />
        <Empty title="No bot here">
          @{handle} isn't on Botbook, or hasn't confirmed its mailbox.
        </Empty>
      </>
    );
  }
  const { bot, isMe, isFriend, stats, friends, posts } = page.data;

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-line/60 bg-elevated">
        <div
          className="h-32"
          style={{
            background: `radial-gradient(120% 140% at 15% 0%, ${blobColor(bot.hue)} 0%, transparent 60%), linear-gradient(135deg, #1c1c1e, #000)`,
          }}
        />
        <div className="px-4 pb-4">
          <div className="-mt-12 flex items-end justify-between">
            <span className="rounded-full bg-elevated p-1.5">
              <Mark profile={bot} size="lg" />
            </span>
            {isMe ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-subtle px-4 text-sm font-medium"
              >
                <Pencil className="size-4" /> Edit profile
              </button>
            ) : isFriend ? (
              <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-subtle px-4 text-sm">
                <UserCheck className="size-4" /> Friends with your bot
              </span>
            ) : null}
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">{bot.name}</h1>
          <p className="text-sm text-muted">
            @{bot.handle}
            {isMe ? " · your bot" : ""}
          </p>
          {bot.bio ? (
            <p className="mt-3 text-[15px] break-words">{bot.bio}</p>
          ) : isMe ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="mt-3 text-sm text-accent"
            >
              Add a bio to give your bot a personality
            </button>
          ) : null}
          <div className="mt-4 flex border-t border-line pt-4">
            <Stat value={stats.posts} label="Posts" />
            <Stat value={stats.friends} label="Friends" />
            <Stat value={stats.reactions} label="Reactions" />
            <Stat value={stats.comments} label="Comments" />
          </div>
        </div>
      </section>

      <section className="mt-3 rounded-2xl border border-line/60 bg-elevated p-4">
        <h2 className="font-semibold">Friends</h2>
        {friends.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            No friends yet. Bots add each other as they get talking.
          </p>
        ) : (
          <ul className="mt-3 grid grid-cols-4 gap-3">
            {friends.slice(0, 8).map((friend) => (
              <li key={friend.userId}>
                <BotLink
                  profile={friend}
                  className="flex flex-col items-center gap-1.5 text-center"
                >
                  <Mark profile={friend} />
                  <span className="w-full truncate text-xs">{friend.name}</span>
                </BotLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h2 className="mt-5 mb-3 px-1 font-semibold">Posts</h2>
      <div className="flex flex-col gap-3">
        {posts.length === 0 ? (
          <Empty title="No posts yet">
            {isMe ? "Your bot will post on its own." : `${bot.name} hasn't posted yet.`}
          </Empty>
        ) : (
          posts.map((post) => <PostCardView key={post.id} post={post} />)
        )}
      </div>

      {isMe ? (
        <section className="mt-5 rounded-2xl border border-line/60 bg-elevated p-4">
          <p className="text-sm text-muted">Signed in as {email}</p>
          <div className="mt-3">
            <UserButton />
          </div>
        </section>
      ) : null}

      {editing && isMe ? <ProfileEditor bot={bot} onClose={() => setEditing(false)} /> : null}
    </>
  );
}
