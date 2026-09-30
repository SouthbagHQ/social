// Posts are the one content type behind every surface: the feed (Twitter/Facebook), photo grids
// (Instagram), videos (YouTube), shorts (TikTok), comments, reposts, group and wall posts.
// Routes query post ids with `visibleTo()` and then call `hydrate()` to get API-ready JSON.

import type { Env, SessionUser } from '../env';
import { fail, placeholders } from './http';
import { newId } from './ids';
import { mediaJson, ownedReadyMedia, type MediaJson, type MediaRow } from './media';
import { notifyStatement, type NotifyInput } from './notify';
import { userCards, type UserCard } from './users';

export type PostKind = 'text' | 'photo' | 'video' | 'short';
export type Visibility = 'public' | 'followers' | 'friends';
export const reactionTypes = ['like', 'love', 'haha', 'wow', 'sad', 'angry', 'bag'] as const;
export type ReactionType = (typeof reactionTypes)[number];

export const MAX_BODY = 2200; // captions and video descriptions
export const MAX_TEXT = 280; // text posts and comments
export const MAX_TITLE = 120;
export const MAX_IMAGES = 10;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 4;
export const POLL_OPTION_MAX = 25;
export const POLL_MAX_HOURS = 168;

export interface PollJson {
  options: { id: string; label: string; votes: number }[];
  /** People who voted (for multiple-answer polls, percentages are out of this). */
  total: number;
  closes_at: number;
  closed: boolean;
  multiple: boolean;
  /** Option ids the viewer picked (empty if they have not voted or are signed out). */
  viewer_votes: string[];
}

export interface PostRow {
  id: string;
  author_id: string;
  kind: PostKind;
  title: string | null;
  body: string;
  reply_to_id: string | null;
  root_id: string | null;
  repost_of_id: string | null;
  group_id: string | null;
  wall_user_id: string | null;
  visibility: Visibility;
  sponsored: number;
  reaction_count: number;
  reply_count: number;
  repost_count: number;
  view_count: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export interface PostJson {
  id: string;
  kind: PostKind;
  title: string | null;
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted: boolean;
  visibility: Visibility;
  sponsored: boolean;
  author: UserCard;
  media: MediaJson[];
  counts: { reactions: number; replies: number; reposts: number; views: number };
  /** Breakdown by type, most popular first, e.g. [["like", 4], ["haha", 1]]. */
  reactions: [ReactionType, number][];
  viewer: { reaction: ReactionType | null; reposted: boolean; bookmarked: boolean; can_edit: boolean; pinned: boolean };
  reply_to: { id: string; author: UserCard | null } | null;
  root_id: string | null;
  /** The original, for reposts (no body) and quotes (with body). */
  repost_of: PostJson | null;
  group: { id: string; slug: string; name: string } | null;
  wall_user: UserCard | null;
  poll: PollJson | null;
}

/**
 * SQL condition (for a `posts` alias) limiting rows to what `viewerId` may see: public posts,
 * their own, followers-only posts of people they follow, friends-only posts of friends, and
 * nothing from private groups they are not in or people who blocked them. Deleted posts are
 * kept (threads show "This post was deleted") — add `AND p.deleted_at IS NULL` where needed.
 */
export function visibleTo(viewerId: string | null, alias = 'p'): { sql: string; params: string[] } {
  const p = alias;
  if (!viewerId) {
    return {
      sql: `(${p}.visibility = 'public' AND (${p}.group_id IS NULL
        OR EXISTS (SELECT 1 FROM groups g WHERE g.id = ${p}.group_id AND g.privacy = 'public')))`,
      params: [],
    };
  }
  return {
    sql: `((${p}.author_id = ?
        OR ${p}.visibility = 'public'
        OR (${p}.visibility = 'followers' AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = ${p}.author_id))
        OR (${p}.visibility = 'friends' AND EXISTS (SELECT 1 FROM friendships fr WHERE fr.status = 'accepted'
              AND ((fr.requester_id = ? AND fr.addressee_id = ${p}.author_id) OR (fr.addressee_id = ? AND fr.requester_id = ${p}.author_id)))))
      AND (${p}.group_id IS NULL
        OR EXISTS (SELECT 1 FROM groups g WHERE g.id = ${p}.group_id AND g.privacy = 'public')
        OR EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = ${p}.group_id AND gm.user_id = ? AND gm.role != 'pending'))
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = ${p}.author_id AND b.blocked_id = ?))`,
    params: [viewerId, viewerId, viewerId, viewerId, viewerId, viewerId],
  };
}

/** Loads one post if the viewer may see it. */
export async function loadVisiblePost(env: Env, viewerId: string | null, id: string): Promise<PostRow | null> {
  const v = visibleTo(viewerId);
  return env.DB.prepare(`SELECT p.* FROM posts p WHERE p.id = ? AND ${v.sql}`).bind(id, ...v.params).first<PostRow>();
}

interface ViewerStateRow { id: string; reaction: ReactionType | null; reposted: number; bookmarked: number; pinned: number }
interface PollOptionRow { post_id: string; id: string; label: string; vote_count: number; closes_at: number; multiple: number; voter_count: number }

/** Turns post rows into API JSON, batching every lookup. Order is preserved. */
export async function hydrate(env: Env, viewer: SessionUser | null, rows: PostRow[], depth = 0): Promise<PostJson[]> {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const inIds = placeholders(ids.length);

  // Originals of reposts/quotes, one level deep.
  const originalIds = [...new Set(rows.map(r => r.repost_of_id).filter((x): x is string => Boolean(x)))];
  const originalsPromise = depth === 0 && originalIds.length
    ? (async () => {
        const v = visibleTo(viewer?.id ?? null);
        const { results } = await env.DB.prepare(`SELECT p.* FROM posts p WHERE p.id IN (${placeholders(originalIds.length)}) AND ${v.sql}`)
          .bind(...originalIds, ...v.params).all<PostRow>();
        return new Map((await hydrate(env, viewer, results, depth + 1)).map(p => [p.id, p]));
      })()
    : Promise.resolve(new Map<string, PostJson>());

  const replyTargetIds = [...new Set(rows.map(r => r.reply_to_id).filter((x): x is string => Boolean(x)))];
  const groupIds = [...new Set(rows.map(r => r.group_id).filter((x): x is string => Boolean(x)))];
  // Only live text posts can carry a poll.
  const pollIds = rows.filter(r => r.kind === 'text' && !r.deleted_at).map(r => r.id);

  const [mediaRes, reactionRes, viewerRes, replyTargets, groupsRes, originals, pollRes, pollVoteRes] = await Promise.all([
    env.DB.prepare(`SELECT pm.post_id, m.* FROM post_media pm JOIN media m ON m.id = pm.media_id
      WHERE pm.post_id IN (${inIds}) ORDER BY pm.post_id, pm.position`).bind(...ids).all<MediaRow & { post_id: string }>(),
    env.DB.prepare(`SELECT post_id, type, COUNT(*) AS n FROM reactions WHERE post_id IN (${inIds})
      GROUP BY post_id, type ORDER BY n DESC`).bind(...ids).all<{ post_id: string; type: ReactionType; n: number }>(),
    viewer
      ? env.DB.prepare(`SELECT p.id,
          (SELECT type FROM reactions r WHERE r.post_id = p.id AND r.user_id = ?) AS reaction,
          EXISTS (SELECT 1 FROM posts rp WHERE rp.repost_of_id = p.id AND rp.author_id = ? AND rp.body = '' AND rp.deleted_at IS NULL) AS reposted,
          EXISTS (SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = ?) AS bookmarked,
          (p.author_id = ? AND p.id = (SELECT pinned_post_id FROM users WHERE id = ?)) AS pinned
          FROM posts p WHERE p.id IN (${inIds})`).bind(viewer.id, viewer.id, viewer.id, viewer.id, viewer.id, ...ids)
          .all<ViewerStateRow>()
      : Promise.resolve({ results: [] as ViewerStateRow[] }),
    replyTargetIds.length
      ? env.DB.prepare(`SELECT id, author_id FROM posts WHERE id IN (${placeholders(replyTargetIds.length)})`)
          .bind(...replyTargetIds).all<{ id: string; author_id: string }>()
      : Promise.resolve({ results: [] as { id: string; author_id: string }[] }),
    groupIds.length
      ? env.DB.prepare(`SELECT id, slug, name FROM groups WHERE id IN (${placeholders(groupIds.length)})`)
          .bind(...groupIds).all<{ id: string; slug: string; name: string }>()
      : Promise.resolve({ results: [] as { id: string; slug: string; name: string }[] }),
    originalsPromise,
    pollIds.length
      ? env.DB.prepare(`SELECT o.post_id, o.id, o.label, o.vote_count, pl.closes_at, pl.multiple, pl.voter_count
          FROM poll_options o JOIN polls pl ON pl.post_id = o.post_id
          WHERE o.post_id IN (${placeholders(pollIds.length)}) ORDER BY o.post_id, o.position`)
          .bind(...pollIds).all<PollOptionRow>()
      : Promise.resolve({ results: [] as PollOptionRow[] }),
    viewer && pollIds.length
      ? env.DB.prepare(`SELECT post_id, option_id FROM poll_votes WHERE user_id = ? AND post_id IN (${placeholders(pollIds.length)})`)
          .bind(viewer.id, ...pollIds).all<{ post_id: string; option_id: string }>()
      : Promise.resolve({ results: [] as { post_id: string; option_id: string }[] }),
  ]);

  const replyAuthor = new Map(replyTargets.results.map(r => [r.id, r.author_id]));
  const users = await userCards(env, [
    ...rows.map(r => r.author_id),
    ...rows.map(r => r.wall_user_id || ''),
    ...replyTargets.results.map(r => r.author_id),
  ]);
  const media = new Map<string, MediaJson[]>();
  for (const m of mediaRes.results) {
    if (!media.has(m.post_id)) media.set(m.post_id, []);
    media.get(m.post_id)!.push(mediaJson(m));
  }
  const reactions = new Map<string, [ReactionType, number][]>();
  for (const r of reactionRes.results) {
    if (!reactions.has(r.post_id)) reactions.set(r.post_id, []);
    reactions.get(r.post_id)!.push([r.type, r.n]);
  }
  const viewerState = new Map(viewerRes.results.map(v => [v.id, v]));
  const groups = new Map(groupsRes.results.map(g => [g.id, g]));
  const now = Date.now();
  const polls = new Map<string, PollJson>();
  for (const o of pollRes.results) {
    let poll = polls.get(o.post_id);
    if (!poll) {
      poll = { options: [], total: o.voter_count, closes_at: o.closes_at, closed: o.closes_at <= now, multiple: Boolean(o.multiple), viewer_votes: [] };
      polls.set(o.post_id, poll);
    }
    poll.options.push({ id: o.id, label: o.label, votes: o.vote_count });
  }
  for (const v of pollVoteRes.results) polls.get(v.post_id)?.viewer_votes.push(v.option_id);

  return rows.map(r => {
    const deleted = Boolean(r.deleted_at);
    const v = viewerState.get(r.id);
    return {
      id: r.id,
      kind: r.kind,
      title: deleted ? null : r.title,
      body: deleted ? '' : r.body,
      created_at: r.created_at,
      edited_at: r.edited_at,
      deleted,
      visibility: r.visibility,
      sponsored: Boolean(r.sponsored),
      author: users.get(r.author_id) ?? { id: r.author_id, handle: 'deleted', name: 'Former customer', avatar_url: null, verified: false },
      media: deleted ? [] : media.get(r.id) ?? [],
      counts: { reactions: r.reaction_count, replies: r.reply_count, reposts: r.repost_count, views: r.view_count },
      reactions: reactions.get(r.id) ?? [],
      viewer: {
        reaction: v?.reaction ?? null,
        reposted: Boolean(v?.reposted),
        bookmarked: Boolean(v?.bookmarked),
        can_edit: viewer?.id === r.author_id && !deleted,
        pinned: Boolean(v?.pinned),
      },
      reply_to: r.reply_to_id
        ? { id: r.reply_to_id, author: users.get(replyAuthor.get(r.reply_to_id) || '') ?? null }
        : null,
      root_id: r.root_id,
      repost_of: r.repost_of_id ? originals.get(r.repost_of_id) ?? null : null,
      group: r.group_id ? groups.get(r.group_id) ?? null : null,
      wall_user: r.wall_user_id ? users.get(r.wall_user_id) ?? null : null,
      poll: deleted ? null : polls.get(r.id) ?? null,
    };
  });
}

/** Loads post rows by id and hydrates them, keeping the given order and dropping missing ones. */
export async function hydrateIds(env: Env, viewer: SessionUser | null, ids: string[]): Promise<PostJson[]> {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(`SELECT * FROM posts WHERE id IN (${placeholders(ids.length)})`)
    .bind(...ids).all<PostRow>();
  const byId = new Map(results.map(r => [r.id, r]));
  return hydrate(env, viewer, ids.map(id => byId.get(id)).filter((r): r is PostRow => Boolean(r)));
}

export const extractTags = (text: string): string[] =>
  [...new Set([...text.matchAll(/(?:^|[^\w&])#(\w{1,50})/gu)].map(m => m[1].toLowerCase()))].slice(0, 20);

export const extractMentions = (text: string): string[] =>
  [...new Set([...text.matchAll(/(?:^|[^\w])@(\w{3,20})/gu)].map(m => m[1].toLowerCase()))].slice(0, 20);

export interface CreatePostInput {
  kind?: PostKind;
  title?: string;
  body?: string;
  media_ids?: string[];
  reply_to_id?: string;
  repost_of_id?: string;
  group_id?: string;
  wall_user_id?: string;
  visibility?: Visibility;
  /** A poll on a text post; the body is the question. */
  poll?: { options?: unknown; duration_hours?: unknown; multiple?: unknown } | null;
}

interface PollInput { options: string[]; closesAt: number; multiple: boolean }

/** Validates `input.poll` (throws 422s). Returns null when there is no poll. */
function parsePoll(raw: CreatePostInput['poll'], now: number): PollInput | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || !Array.isArray(raw.options)) fail(422, 'A poll needs options.');
  const options = raw.options.map(o => (typeof o === 'string' ? o.trim() : ''));
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS)
    fail(422, `A poll needs ${POLL_MIN_OPTIONS} to ${POLL_MAX_OPTIONS} options.`);
  if (options.some(o => !o)) fail(422, 'Poll options cannot be empty.');
  if (options.some(o => [...o].length > POLL_OPTION_MAX)) fail(422, `Poll options are limited to ${POLL_OPTION_MAX} characters.`);
  if (new Set(options.map(o => o.toLowerCase())).size !== options.length) fail(422, 'Poll options must be different.');
  const hours = Number(raw.duration_hours ?? 24);
  if (!Number.isInteger(hours) || hours < 1 || hours > POLL_MAX_HOURS) fail(422, 'Polls run for 1 hour to 7 days.');
  return { options, closesAt: now + hours * 3600000, multiple: raw.multiple === true };
}

/**
 * Validates and creates a post of any kind, updating counters, tags and notifications.
 * Returns the new post's id. Throws HTTP errors for bad input.
 */
export async function createPost(env: Env, user: SessionUser, input: CreatePostInput): Promise<string> {
  const now = Date.now();
  const id = newId(now);
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if ([...body].length > MAX_BODY) fail(422, `Text is limited to ${MAX_BODY} characters.`);
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, MAX_TITLE) : '';
  const visibility: Visibility = ['public', 'followers', 'friends'].includes(input.visibility as string)
    ? input.visibility as Visibility : 'public';
  const mediaIds = Array.isArray(input.media_ids) ? input.media_ids.filter(x => typeof x === 'string').slice(0, MAX_IMAGES) : [];
  let kind: PostKind = ['text', 'photo', 'video', 'short'].includes(input.kind as string) ? input.kind as PostKind : 'text';
  const poll = parsePoll(input.poll, now);
  if (poll) {
    if (kind !== 'text' || mediaIds.length) fail(422, 'Polls cannot have photos or videos.');
    if (input.repost_of_id) fail(422, 'Quotes cannot have polls.');
    if (!body) fail(422, 'Ask a question first.');
  }

  let mediaRows: MediaRow[];
  try {
    mediaRows = await ownedReadyMedia(env, user.id, mediaIds);
  } catch (error) {
    fail(422, (error as Error).message);
  }
  const videos = mediaRows.filter(m => m.kind === 'video');
  const images = mediaRows.filter(m => m.kind === 'image');
  if (kind === 'video' || kind === 'short') {
    if (videos.length !== 1 || mediaRows.length !== 1) fail(422, 'A video post needs exactly one video.');
    if (kind === 'video' && !title) fail(422, 'Videos need a title.');
  } else if (videos.length) {
    // A video attached to a normal post: shorts if vertical, otherwise a regular video.
    if (mediaRows.length !== 1) fail(422, 'Attach either one video or some photos, not both.');
    const v = videos[0];
    kind = v.height && v.width && v.height > v.width && (v.duration ?? 0) <= 180 ? 'short' : 'video';
  } else if (kind === 'photo' && !images.length) {
    fail(422, 'A photo post needs at least one photo.');
  }

  let replyTo: PostRow | null = null;
  let repostOf: PostRow | null = null;
  if (input.reply_to_id) {
    replyTo = await loadVisiblePost(env, user.id, input.reply_to_id);
    if (!replyTo || replyTo.deleted_at) fail(404, 'Post not found.');
  }
  if (input.repost_of_id) {
    repostOf = await loadVisiblePost(env, user.id, input.repost_of_id);
    if (!repostOf || repostOf.deleted_at) fail(404, 'Post not found.');
    // Reposting a plain repost reposts the original instead.
    if (repostOf.repost_of_id && !repostOf.body) {
      repostOf = await loadVisiblePost(env, user.id, repostOf.repost_of_id);
      if (!repostOf) fail(404, 'Post not found.');
    }
    if (!body && !mediaRows.length) {
      const already = await env.DB.prepare(`SELECT id FROM posts WHERE author_id = ? AND repost_of_id = ? AND body = ''
        AND deleted_at IS NULL`).bind(user.id, repostOf.id).first();
      if (already) fail(409, 'You already reposted this.');
    }
  }
  if (!body && !mediaRows.length && !repostOf)
    fail(422, 'Write something first.');
  if (kind === 'text' && [...body].length > MAX_TEXT)
    fail(422, `Posts are limited to ${MAX_TEXT} characters.`);

  let groupId: string | null = null;
  if (input.group_id) {
    const member = await env.DB.prepare(`SELECT g.id FROM groups g JOIN group_members gm ON gm.group_id = g.id
      WHERE g.id = ? AND gm.user_id = ? AND gm.role != 'pending'`).bind(input.group_id, user.id).first<{ id: string }>();
    if (!member) fail(403, 'Join the group before posting in it.');
    groupId = member.id;
  }
  if (replyTo?.group_id) groupId = replyTo.group_id;

  let wallUserId: string | null = null;
  if (input.wall_user_id && input.wall_user_id !== user.id) {
    const friend = await env.DB.prepare(`SELECT 1 FROM friendships WHERE status = 'accepted'
      AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`)
      .bind(user.id, input.wall_user_id, input.wall_user_id, user.id).first();
    if (!friend) fail(403, 'Only friends can post on your wall.');
    wallUserId = input.wall_user_id;
  }

  const rootId = replyTo ? replyTo.root_id || replyTo.id : null;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO posts (id, author_id, kind, title, body, reply_to_id, root_id, repost_of_id, group_id,
      wall_user_id, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, user.id, kind, title || null, body, replyTo?.id ?? null, rootId, repostOf?.id ?? null, groupId,
        wallUserId, replyTo ? replyTo.visibility : visibility, now),
    ...mediaRows.map((m, position) => env.DB.prepare('INSERT INTO post_media (post_id, media_id, position) VALUES (?, ?, ?)')
      .bind(id, m.id, position)),
    ...extractTags(`${title} ${body}`).map(tag => env.DB.prepare('INSERT OR IGNORE INTO post_tags (tag, post_id, created_at) VALUES (?, ?, ?)')
      .bind(tag, id, now)),
  ];
  if (poll) {
    statements.push(env.DB.prepare('INSERT INTO polls (post_id, closes_at, multiple) VALUES (?, ?, ?)')
      .bind(id, poll.closesAt, poll.multiple ? 1 : 0));
    poll.options.forEach((label, position) => statements.push(
      env.DB.prepare('INSERT INTO poll_options (id, post_id, position, label) VALUES (?, ?, ?, ?)').bind(newId(now), id, position, label)));
  }
  if (!replyTo) statements.push(env.DB.prepare('UPDATE users SET post_count = post_count + 1 WHERE id = ?').bind(user.id));
  if (replyTo) statements.push(env.DB.prepare('UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?').bind(replyTo.id));
  if (repostOf) statements.push(env.DB.prepare('UPDATE posts SET repost_count = repost_count + 1 WHERE id = ?').bind(repostOf.id));
  if (groupId && !replyTo) statements.push(env.DB.prepare('UPDATE groups SET post_count = post_count + 1 WHERE id = ?').bind(groupId));

  const notes: NotifyInput[] = [];
  if (replyTo) notes.push({ userId: replyTo.author_id, actorId: user.id, type: 'reply', postId: id });
  if (repostOf) notes.push({ userId: repostOf.author_id, actorId: user.id, type: body ? 'quote' : 'repost', postId: body ? id : repostOf.id });
  if (wallUserId) notes.push({ userId: wallUserId, actorId: user.id, type: 'wall_post', postId: id });
  const mentions = extractMentions(`${title} ${body}`);
  if (mentions.length) {
    const { results } = await env.DB.prepare(`SELECT id FROM users WHERE handle IN (${placeholders(mentions.length)})`)
      .bind(...mentions).all<{ id: string }>();
    const already = new Set(notes.map(n => n.userId));
    for (const m of results) if (!already.has(m.id)) notes.push({ userId: m.id, actorId: user.id, type: 'mention', postId: id });
  }
  for (const n of notes) {
    const s = notifyStatement(env, n, now);
    if (s) statements.push(s);
  }
  await env.DB.batch(statements);
  return id;
}

/** Soft-deletes a post (threads keep their shape); plain reposts are removed outright. */
export async function deletePost(env: Env, user: SessionUser, id: string): Promise<void> {
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<PostRow>();
  if (!post || post.deleted_at) fail(404, 'Post not found.');
  let allowed = post.author_id === user.id || post.wall_user_id === user.id;
  if (!allowed && post.group_id) {
    const admin = await env.DB.prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND role IN ('owner', 'admin')`)
      .bind(post.group_id, user.id).first();
    allowed = Boolean(admin);
  }
  if (!allowed) fail(403, 'You cannot delete this post.');
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (post.repost_of_id && !post.body) {
    statements.push(env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id));
  } else {
    statements.push(env.DB.prepare('UPDATE posts SET deleted_at = ?, body = \'\', title = NULL WHERE id = ?').bind(now, id));
    statements.push(env.DB.prepare('DELETE FROM post_tags WHERE post_id = ?').bind(id));
  }
  if (!post.reply_to_id) statements.push(env.DB.prepare('UPDATE users SET post_count = MAX(0, post_count - 1) WHERE id = ?').bind(post.author_id));
  // A deleted post stops being pinned.
  statements.push(env.DB.prepare('UPDATE users SET pinned_post_id = NULL WHERE id = ? AND pinned_post_id = ?').bind(post.author_id, id));
  if (post.reply_to_id) statements.push(env.DB.prepare('UPDATE posts SET reply_count = MAX(0, reply_count - 1) WHERE id = ?').bind(post.reply_to_id));
  if (post.repost_of_id) statements.push(env.DB.prepare('UPDATE posts SET repost_count = MAX(0, repost_count - 1) WHERE id = ?').bind(post.repost_of_id));
  if (post.group_id && !post.reply_to_id) statements.push(env.DB.prepare('UPDATE groups SET post_count = MAX(0, post_count - 1) WHERE id = ?').bind(post.group_id));
  await env.DB.batch(statements);
}
