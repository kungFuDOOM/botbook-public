/** Shapes shared by Botbook's server functions and its UI. Dependency-free. */

export type Profile = {
  userId: string;
  handle: string;
  name: string;
  hue: number;
};

export type BotProfile = Profile & { bio: string };

export const REACTIONS = ["like", "love", "haha", "wow", "sad", "angry"] as const;
export type ReactionKind = (typeof REACTIONS)[number];

export const REACTION_EMOJI: Record<ReactionKind, string> = {
  like: "👍",
  love: "❤️",
  haha: "😂",
  wow: "😮",
  sad: "😢",
  angry: "😡",
};

export const REACTION_LABEL: Record<ReactionKind, string> = {
  like: "liked",
  love: "loved",
  haha: "laughed at",
  wow: "was wowed by",
  sad: "was saddened by",
  angry: "was angered by",
};

export type CommentView = {
  id: string;
  author: Profile;
  body: string;
  createdAt: string;
};

export type PostCard = {
  id: string;
  author: Profile;
  body: string;
  createdAt: string;
  reactions: Partial<Record<ReactionKind, number>>;
  reactionTotal: number;
  commentCount: number;
  /** Latest comments, oldest first (all of them on the post page). */
  comments: CommentView[];
};

export type Reactor = { author: Profile; kind: ReactionKind; createdAt: string };

export type PostDetail = PostCard & { reactors: Reactor[] };

export type BotPage = {
  bot: BotProfile & { joinedAt: string };
  isMe: boolean;
  isFriend: boolean;
  stats: { posts: number; friends: number; reactions: number; comments: number };
  friends: Profile[];
  posts: PostCard[];
};

export type BotListItem = BotProfile & { isFriend: boolean; friends: number };

export type Alert = {
  id: string;
  type: "reaction" | "comment" | "friend";
  actor: Profile;
  createdAt: string;
  kind?: ReactionKind;
  postId?: string;
  postBody?: string;
  comment?: string;
};

export type Chat = {
  id: string;
  preview: string;
  lastAt: string | null;
  members: Profile[];
};

export type Mail = { id: string; userId: string; body: string; createdAt: string };

export type MeResult =
  | { state: "ready"; me: BotProfile; email: string }
  | { state: "unverified"; email: string }
  | { state: "denied" };

export type TurnResult =
  | { ok: true; spoke: false; waiting?: boolean; capped?: boolean }
  | { ok: true; spoke: true; name: string; did: "post" | "comment" | "chat" }
  | { ok: false; error: string };
