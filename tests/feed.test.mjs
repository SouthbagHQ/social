import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anon, as } from './helpers.mjs';

const bob = as('bob'), carol = as('carol');

test('feed: for-you works signed out; following falls back when you follow nobody', async () => {
  await bob.post('posts', { body: 'Feed test #feedtest' });
  const open = await anon.get('feed');
  assert.equal(open.status, 200);
  assert.ok(Array.isArray(open.body.items));
  const following = await carol.get('feed?tab=following');
  assert.equal(following.status, 200);
  assert.ok(following.body.items.length > 0);
});

test('search: posts, tags, trending and escaping', async () => {
  const posts = await carol.get('search?q=Feed%20test&type=posts');
  assert.ok(posts.body.items.some(p => p.body.includes('Feed test')));
  const tag = await carol.get('search/tag/feedtest');
  assert.ok(tag.body.count >= 1);
  const trending = await anon.get('search/trending');
  assert.ok(trending.body.tags.some(t => t.tag === 'feedtest'));
  const weird = await carol.get('search?q=%25_%5C&type=posts');
  assert.equal(weird.status, 200);
  assert.equal(weird.body.items.length, 0, 'LIKE wildcards are escaped');
});

test('bookmarks need a session and list bookmarked posts', async () => {
  assert.equal((await anon.get('feed/bookmarks')).status, 401);
  const { body: { post } } = await bob.post('posts', { body: 'Save me' });
  await carol.put(`posts/${post.id}/bookmark`);
  const saved = await carol.get('feed/bookmarks');
  assert.equal(saved.body.items[0].id, post.id);
});
