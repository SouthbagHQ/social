// Video and photo surfaces (YouTube, TikTok, Instagram). The content itself is ordinary posts of
// kind video / short / photo, created with POST /api/posts; this router only lists them.
//
//   GET /api/videos/feed?kind=video|short|photo&sort=recent|popular&cursor&limit
//        -> { items: PostJson[], next }      recent pages by id, popular by offset
//   GET /api/videos/shorts?cursor&limit
//        -> { items, next }                  "For you": a hot score (engagement over age) with a
//                                            frozen clock in the cursor so pages stay stable
//   GET /api/videos/:id/related?limit
//        -> { items }                        same kind; the same channel first, then popular
//   GET /api/videos/channel/:handle?kind=video|short|photo&cursor&limit
//        -> { channel, items, next }         channel = UserCard + bio, counts and is_following
//
// Everything is top-level (no replies), not deleted, and filtered with visibleTo(). Every handler
// runs a handful of D1 queries plus hydrate()'s fixed batch.

import { Hono } from 'hono';
import type { AppEnv, Ctx } from '../env';
import { cursor, fail, limit, page } from '../lib/http';
import { hydrate, loadVisiblePost, visibleTo, type PostKind, type PostRow } from '../lib/posts';
import { userByHandle, userCard, type UserRow } from '../lib/users';

const videos = new Hono<AppEnv>();

const surfaceKinds: PostKind[] = ['video', 'short', 'photo'];
const kindParam = (c: Ctx, fallback: PostKind = 'video'): PostKind => {
  const k = c.req.query('kind') as PostKind;
  return surfaceKinds.includes(k) ? k : fallback;
};

/** Engagement used for "popular". Views are cheap, reactions and comments less so. */
const ENGAGEMENT = '(p.view_count + p.reaction_count * 4 + p.reply_count * 3 + p.repost_count * 5)';

/** Conditions shared by every list here: top-level posts of one kind that the viewer may see. */
function base(c: Ctx, kind: PostKind) {
  const v = visibleTo(c.get('user')?.id ?? null);
  return {
    sql: `p.kind = ? AND p.reply_to_id IS NULL AND p.deleted_at IS NULL AND ${v.sql}`,
    params: [kind, ...v.params] as (string | number)[],
  };
}

const offsetOf = (value: string | null) => Math.max(0, Math.min(10000, Math.floor(Number(value) || 0)));

videos.get('/feed', async c => {
  const kind = kindParam(c);
  const size = limit(c, 24, 50);
  const after = cursor(c);
  const b = base(c, kind);
  if (c.req.query('sort') === 'popular') {
    const offset = offsetOf(after);
    const { results } = await c.env.DB.prepare(`SELECT p.* FROM posts p WHERE ${b.sql}
        ORDER BY ${ENGAGEMENT} DESC, p.id DESC LIMIT ? OFFSET ?`)
      .bind(...b.params, size + 1, offset).all<PostRow>();
    const items = await hydrate(c.env, c.get('user'), results.slice(0, size));
    return c.json({ items, next: results.length > size ? String(offset + size) : null });
  }
  const { results } = await c.env.DB.prepare(`SELECT p.* FROM posts p WHERE ${b.sql}
      ${after ? 'AND p.id < ?' : ''} ORDER BY p.id DESC LIMIT ?`)
    .bind(...b.params, ...(after ? [after] : []), size + 1).all<PostRow>();
  const { items, next } = page(results, size);
  return c.json({ items: await hydrate(c.env, c.get('user'), items), next });
});

videos.get('/shorts', async c => {
  const size = limit(c, 8, 30);
  // Cursor: "<offset>_<clock>". The clock is frozen at the first page so the order holds still.
  const [rawOffset, rawClock] = (cursor(c) || '').split('_');
  const offset = offsetOf(rawOffset);
  const clock = Number(rawClock) > 0 ? Number(rawClock) : Date.now();
  const b = base(c, 'short');
  // Hot score: engagement per unit of age, with a two-hour head start so new shorts get a turn.
  const { results } = await c.env.DB.prepare(`SELECT p.* FROM posts p WHERE ${b.sql} AND p.created_at <= ?
      ORDER BY (${ENGAGEMENT} + 2) * 1.0 / ((? - p.created_at) / 3600000.0 + 2) DESC, p.id DESC LIMIT ? OFFSET ?`)
    .bind(...b.params, clock, clock, size + 1, offset).all<PostRow>();
  const items = await hydrate(c.env, c.get('user'), results.slice(0, size));
  return c.json({ items, next: results.length > size ? `${offset + size}_${clock}` : null });
});

videos.get('/channel/:handle', async c => {
  const kind = kindParam(c);
  const size = limit(c, 24, 50);
  const after = cursor(c);
  const user = await userByHandle(c.env, c.req.param('handle'));
  if (!user) fail(404, 'Channel not found.');
  const viewer = c.get('user');
  const b = base(c, kind);
  const [{ results }, following] = await Promise.all([
    c.env.DB.prepare(`SELECT p.* FROM posts p WHERE p.author_id = ? AND ${b.sql}
        ${after ? 'AND p.id < ?' : ''} ORDER BY p.id DESC LIMIT ?`)
      .bind(user.id, ...b.params, ...(after ? [after] : []), size + 1).all<PostRow>(),
    viewer && viewer.id !== user.id
      ? c.env.DB.prepare('SELECT 1 AS yes FROM follows WHERE follower_id = ? AND followee_id = ?').bind(viewer.id, user.id).first()
      : Promise.resolve(null),
  ]);
  const { items, next } = page(results, size);
  const row = user as unknown as UserRow & { bio: string; follower_count: number; following_count: number; post_count: number };
  return c.json({
    channel: {
      ...userCard(row),
      bio: row.bio,
      follower_count: row.follower_count,
      following_count: row.following_count,
      post_count: row.post_count,
      is_following: Boolean(following),
      is_me: viewer?.id === user.id,
    },
    items: await hydrate(c.env, viewer, items),
    next,
  });
});

videos.get('/:id/related', async c => {
  const viewer = c.get('user');
  const post = await loadVisiblePost(c.env, viewer?.id ?? null, c.req.param('id'));
  if (!post || post.deleted_at) fail(404, 'Video not found.');
  const size = limit(c, 12, 30);
  const kind = surfaceKinds.includes(post.kind) ? post.kind : 'video';
  const b = base(c, kind);
  const [sameChannel, popular] = await Promise.all([
    c.env.DB.prepare(`SELECT p.* FROM posts p WHERE p.author_id = ? AND p.id != ? AND ${b.sql}
        ORDER BY p.id DESC LIMIT ?`)
      .bind(post.author_id, post.id, ...b.params, Math.min(size, 6)).all<PostRow>(),
    c.env.DB.prepare(`SELECT p.* FROM posts p WHERE p.author_id != ? AND ${b.sql}
        ORDER BY ${ENGAGEMENT} DESC, p.id DESC LIMIT ?`)
      .bind(post.author_id, ...b.params, size).all<PostRow>(),
  ]);
  const rows = [...sameChannel.results, ...popular.results].slice(0, size);
  return c.json({ items: await hydrate(c.env, viewer, rows) });
});

export default videos;
