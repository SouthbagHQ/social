// Single-post actions shared by every surface (feed, photos, videos, shorts, groups, walls):
//   POST   /api/posts                    create (any kind; see CreatePostInput) → { post }
//   GET    /api/posts/:id                → { post, ancestors }   (ancestors = reply chain, oldest first)
//   GET    /api/posts/:id/replies        ?cursor&limit&sort=new|top → { items, next }
//   PATCH  /api/posts/:id                { body?, title? } → { post }   ("Amend")
//   DELETE /api/posts/:id
//   PUT    /api/posts/:id/reaction       { type } → { post }
//   DELETE /api/posts/:id/reaction       → { post }
//   POST   /api/posts/:id/repost         → { post }  (the original, updated)
//   DELETE /api/posts/:id/repost         → { post }
//   PUT    /api/posts/:id/bookmark       DELETE /api/posts/:id/bookmark
//   POST   /api/posts/:id/view           counts a view (videos, shorts)
//   GET    /api/posts/:id/reactions      ?type → { items: [{ user, type }] }

import { Hono } from 'hono';
import type { AppEnv, Ctx } from '../env';
import { body, cursor, fail, limit, requireUser, str } from '../lib/http';
import {
  MAX_BODY, MAX_TEXT, MAX_TITLE, createPost, deletePost, extractTags, hydrate, hydrateIds, loadVisiblePost,
  reactionTypes, visibleTo, type CreatePostInput, type PostRow, type ReactionType,
} from '../lib/posts';
import { notifyStatement } from '../lib/notify';
import { track } from '../lib/palantir';
import { userCardColumns, userCard, type UserRow } from '../lib/users';

const posts = new Hono<AppEnv>();

/** Appreciation surcharge per reaction, in cents. Never charged. Always recorded. */
const REACTION_FEE = 2;

async function visibleOr404(c: Ctx, id: string): Promise<PostRow> {
  const post = await loadVisiblePost(c.env, c.get('user')?.id ?? null, id);
  if (!post) fail(404, 'Post not found.');
  return post;
}

const one = async (c: Ctx, id: string) => (await hydrateIds(c.env, c.get('user'), [id]))[0];

posts.post('/', async c => {
  const user = requireUser(c);
  const id = await createPost(c.env, user, await body<CreatePostInput>(c));
  const post = await one(c, id);
  track(c, 'social_post_created', { post_id: id, kind: post.kind, visibility: post.visibility, reply: Boolean(post.reply_to), quote: Boolean(post.repost_of), media_count: post.media.length, poll: Boolean(post.poll), group_id: post.group?.id ?? null, wall: Boolean(post.wall_user) });
  return c.json({ post }, 201);
});

posts.get('/:id', async c => {
  const post = await visibleOr404(c, c.req.param('id'));
  // Walk up the reply chain (at most 10 hops) so a thread page can show context.
  const chain: PostRow[] = [];
  let parentId = post.reply_to_id;
  while (parentId && chain.length < 10) {
    const parent = await loadVisiblePost(c.env, c.get('user')?.id ?? null, parentId);
    if (!parent) break;
    chain.unshift(parent);
    parentId = parent.reply_to_id;
  }
  const [hydrated, ...ancestors] = await hydrate(c.env, c.get('user'), [post, ...chain]);
  return c.json({ post: hydrated, ancestors });
});

posts.get('/:id/replies', async c => {
  const post = await visibleOr404(c, c.req.param('id'));
  const size = limit(c);
  const v = visibleTo(c.get('user')?.id ?? null);
  const top = c.req.query('sort') === 'top';
  const after = cursor(c);
  // "top" pages by offset (cursor is a number); "new" pages by id.
  const offset = top ? Math.max(0, Number(after) || 0) : 0;
  const { results } = await c.env.DB.prepare(`SELECT p.* FROM posts p WHERE p.reply_to_id = ? AND ${v.sql}
      ${!top && after ? 'AND p.id < ?' : ''}
      ORDER BY ${top ? 'p.reaction_count + p.reply_count * 2 DESC, p.id DESC' : 'p.id DESC'} LIMIT ? OFFSET ?`)
    .bind(post.id, ...v.params, ...(!top && after ? [after] : []), size + 1, offset).all<PostRow>();
  const items = await hydrate(c.env, c.get('user'), results.slice(0, size));
  const more = results.length > size;
  return c.json({ items, next: more ? (top ? String(offset + size) : items[items.length - 1].id) : null });
});

posts.patch('/:id', async c => {
  const user = requireUser(c);
  const post = await visibleOr404(c, c.req.param('id'));
  if (post.author_id !== user.id || post.deleted_at) fail(403, 'You cannot edit this post.');
  const input = await body(c);
  const newBody = 'body' in input ? str(input.body, MAX_BODY) : post.body;
  const title = 'title' in input ? str(input.title, MAX_TITLE) || null : post.title;
  if (post.kind === 'text' && [...newBody].length > MAX_TEXT) fail(422, `Posts are limited to ${MAX_TEXT} characters.`);
  if (post.kind === 'video' && !title) fail(422, 'Videos need a title.');
  if (!newBody && post.kind === 'text' && !post.repost_of_id) fail(422, 'Write something first.');
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE posts SET body = ?, title = ?, edited_at = ? WHERE id = ?').bind(newBody, title, now, post.id),
    c.env.DB.prepare('DELETE FROM post_tags WHERE post_id = ?').bind(post.id),
    ...extractTags(`${title || ''} ${newBody}`).map(tag =>
      c.env.DB.prepare('INSERT OR IGNORE INTO post_tags (tag, post_id, created_at) VALUES (?, ?, ?)').bind(tag, post.id, post.created_at)),
  ]);
  track(c, 'social_post_edited', { post_id: post.id, kind: post.kind });
  return c.json({ post: await one(c, post.id) });
});

posts.delete('/:id', async c => {
  await deletePost(c.env, requireUser(c), c.req.param('id'));
  track(c, 'social_post_deleted', { post_id: c.req.param('id') });
  return c.json({ ok: true });
});

posts.put('/:id/reaction', async c => {
  const user = requireUser(c);
  const post = await visibleOr404(c, c.req.param('id'));
  if (post.deleted_at) fail(404, 'Post not found.');
  const input = await body(c);
  const type = (reactionTypes as readonly string[]).includes(input.type as string) ? input.type as ReactionType : 'like';
  const existing = await c.env.DB.prepare('SELECT type FROM reactions WHERE post_id = ? AND user_id = ?')
    .bind(post.id, user.id).first<{ type: string }>();
  const now = Date.now();
  if (existing) {
    await c.env.DB.prepare('UPDATE reactions SET type = ? WHERE post_id = ? AND user_id = ?').bind(type, post.id, user.id).run();
  } else {
    const statements = [
      c.env.DB.prepare('INSERT INTO reactions (post_id, user_id, type, created_at) VALUES (?, ?, ?, ?)').bind(post.id, user.id, type, now),
      c.env.DB.prepare('UPDATE posts SET reaction_count = reaction_count + 1 WHERE id = ?').bind(post.id),
      c.env.DB.prepare('UPDATE users SET bag_balance = bag_balance + ? WHERE id = ?').bind(REACTION_FEE, user.id),
    ];
    const note = notifyStatement(c.env, { userId: post.author_id, actorId: user.id, type: 'reaction', postId: post.id, body: type }, now);
    if (note) statements.push(note);
    await c.env.DB.batch(statements);
  }
  track(c, 'social_reaction_added', { post_id: post.id, post_kind: post.kind, type, changed: Boolean(existing), own_post: post.author_id === user.id });
  return c.json({ post: await one(c, post.id) });
});

posts.delete('/:id/reaction', async c => {
  const user = requireUser(c);
  const post = await visibleOr404(c, c.req.param('id'));
  const { meta } = await c.env.DB.prepare('DELETE FROM reactions WHERE post_id = ? AND user_id = ?').bind(post.id, user.id).run();
  if (meta.changes) await c.env.DB.prepare('UPDATE posts SET reaction_count = MAX(0, reaction_count - 1) WHERE id = ?').bind(post.id).run();
  if (meta.changes) track(c, 'social_reaction_removed', { post_id: post.id, post_kind: post.kind });
  return c.json({ post: await one(c, post.id) });
});

posts.post('/:id/repost', async c => {
  const user = requireUser(c);
  const post = await visibleOr404(c, c.req.param('id'));
  if (post.visibility !== 'public' && post.author_id !== user.id) fail(403, 'Only public posts can be reposted.');
  await createPost(c.env, user, { repost_of_id: post.id });
  track(c, 'social_post_reposted', { post_id: post.id, post_kind: post.kind, own_post: post.author_id === user.id });
  return c.json({ post: await one(c, post.repost_of_id && !post.body ? post.repost_of_id : post.id) });
});

posts.delete('/:id/repost', async c => {
  const user = requireUser(c);
  const post = await visibleOr404(c, c.req.param('id'));
  const mine = await c.env.DB.prepare(`SELECT id FROM posts WHERE author_id = ? AND repost_of_id = ? AND body = ''
    AND deleted_at IS NULL`).bind(user.id, post.id).first<{ id: string }>();
  if (mine) await deletePost(c.env, user, mine.id);
  if (mine) track(c, 'social_repost_removed', { post_id: post.id });
  return c.json({ post: await one(c, post.id) });
});

posts.put('/:id/bookmark', async c => {
  const user = requireUser(c);
  const post = await visibleOr404(c, c.req.param('id'));
  await c.env.DB.prepare('INSERT OR IGNORE INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)')
    .bind(user.id, post.id, Date.now()).run();
  track(c, 'social_bookmark_added', { post_id: post.id, post_kind: post.kind });
  return c.json({ ok: true, bookmarked: true });
});

posts.delete('/:id/bookmark', async c => {
  const user = requireUser(c);
  await c.env.DB.prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?').bind(user.id, c.req.param('id')).run();
  track(c, 'social_bookmark_removed', { post_id: c.req.param('id') });
  return c.json({ ok: true, bookmarked: false });
});

posts.post('/:id/view', async c => {
  const post = await visibleOr404(c, c.req.param('id'));
  await c.env.DB.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').bind(post.id).run();
  track(c, 'social_post_viewed', { post_id: post.id, kind: post.kind });
  return c.json({ views: post.view_count + 1 });
});

posts.get('/:id/reactions', async c => {
  const post = await visibleOr404(c, c.req.param('id'));
  const type = c.req.query('type');
  const size = limit(c, 50, 100);
  const { results } = await c.env.DB.prepare(`SELECT r.type, r.created_at, ${userCardColumns.split(', ').map(col => 'u.' + col).join(', ')}
      FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.post_id = ? ${type ? 'AND r.type = ?' : ''}
      ORDER BY r.created_at DESC LIMIT ?`)
    .bind(post.id, ...(type ? [type] : []), size).all<UserRow & { type: string }>();
  return c.json({ items: results.map(r => ({ user: userCard(r), type: r.type })) });
});

export default posts;
