// Pinned posts: one per profile, shown at the top of the Posts tab.
//   PUT    /api/pins           { post_id } → { post }   (pins one of your own top-level posts; replaces any pin)
//   DELETE /api/pins           → { ok: true }
//   GET    /api/pins/:handle   → { post: PostJson | null }

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { body, fail, requireUser, str } from '../lib/http';
import { hydrate, hydrateIds, loadVisiblePost, type PostRow } from '../lib/posts';
import { track } from '../lib/palantir';

const pins = new Hono<AppEnv>();

pins.put('/', async c => {
  const user = requireUser(c);
  const input = await body<{ post_id?: unknown }>(c);
  const id = str(input.post_id, 64);
  const post = id ? await c.env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<PostRow>() : null;
  if (!post || post.deleted_at) fail(404, 'Post not found.');
  if (post.author_id !== user.id) fail(403, 'You can only pin your own posts.');
  if (post.reply_to_id) fail(422, 'Replies cannot be pinned.');
  if (post.repost_of_id && !post.body) fail(422, 'Reposts cannot be pinned.');
  if (post.group_id) fail(422, 'Group posts cannot be pinned.');
  await c.env.DB.prepare('UPDATE users SET pinned_post_id = ?, updated_at = ? WHERE id = ?').bind(post.id, Date.now(), user.id).run();
  track(c, 'social_post_pinned', { post_id: post.id, kind: post.kind });
  return c.json({ post: (await hydrateIds(c.env, user, [post.id]))[0] });
});

pins.delete('/', async c => {
  const user = requireUser(c);
  await c.env.DB.prepare('UPDATE users SET pinned_post_id = NULL, updated_at = ? WHERE id = ?').bind(Date.now(), user.id).run();
  track(c, 'social_post_unpinned');
  return c.json({ ok: true });
});

pins.get('/:handle', async c => {
  const viewer = c.get('user');
  const handle = c.req.param('handle').replace(/^@/, '');
  const owner = handle.toLowerCase() === 'me' && viewer
    ? await c.env.DB.prepare('SELECT id, pinned_post_id FROM users WHERE id = ?').bind(viewer.id).first<{ id: string; pinned_post_id: string | null }>()
    : await c.env.DB.prepare('SELECT id, pinned_post_id FROM users WHERE handle = ?').bind(handle).first<{ id: string; pinned_post_id: string | null }>();
  if (!owner) fail(404, 'User not found.');
  if (!owner.pinned_post_id) return c.json({ post: null });
  const post = await loadVisiblePost(c.env, viewer?.id ?? null, owner.pinned_post_id);
  if (!post || post.deleted_at || post.author_id !== owner.id) return c.json({ post: null });
  return c.json({ post: (await hydrate(c.env, viewer, [post]))[0] });
});

export default pins;
