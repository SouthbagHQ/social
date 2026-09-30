import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anon, as } from './helpers.mjs';

const alice = as('alice');

async function upload(who, { width, height, duration }) {
  const size = 2000;
  const { body } = await who.post('media', { kind: 'video', content_type: 'video/mp4', size, width, height, duration });
  await who.put(`media/${body.id}/chunks/0`, new Uint8Array(size));
  return (await who.post(`media/${body.id}/complete`)).body;
}

test('videos: long videos need a title; feeds, related and channels list them', async () => {
  const landscape = await upload(alice, { width: 1920, height: 1080, duration: 300 });
  assert.equal((await alice.post('posts', { kind: 'video', media_ids: [landscape.id] })).status, 422);
  const { body: { post } } = await alice.post('posts', { kind: 'video', title: 'Floor 3 walkthrough', media_ids: [landscape.id] });
  assert.equal(post.kind, 'video');

  const vertical = await upload(alice, { width: 720, height: 1280, duration: 15 });
  const short = (await alice.post('posts', { kind: 'short', body: 'short', media_ids: [vertical.id] })).body.post;

  const feed = await anon.get('videos/feed?kind=video');
  assert.ok(feed.body.items.some(p => p.id === post.id));
  const shorts = await anon.get('videos/shorts');
  assert.ok(shorts.body.items.some(p => p.id === short.id));
  assert.equal((await anon.get(`videos/${post.id}/related`)).status, 200);
  const channel = await anon.get('videos/channel/alice?kind=short');
  assert.ok(channel.body.items.some(p => p.id === short.id));

  const views = await alice.post(`posts/${post.id}/view`);
  assert.equal(views.body.views, 1);
});
