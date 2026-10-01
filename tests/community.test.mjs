import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anon, as } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol');

const NO_DELETING = "Deletion isn't available. Kevin knows what you did.";

async function png(who) {
  const bytes = new Uint8Array(1000);
  const { body } = await who.post('media', { kind: 'image', content_type: 'image/png', size: bytes.length, width: 10, height: 10 });
  await who.put(`media/${body.id}/chunks/0`, bytes);
  return (await who.post(`media/${body.id}/complete`)).body;
}

test('stories: post, tray, view once, owner-only viewers, and no deleting', async () => {
  const media = await png(bob);
  const { status, body: { story } } = await bob.post('stories', { media_id: media.id, caption: 'Retained.' });
  assert.equal(status, 201);
  assert.ok(story.expires_at - Date.now() > 23 * 3600e3);
  const tray = await alice.get('stories');
  assert.ok(tray.body.items.some(i => i.user.handle === 'bob' && !i.seen));
  await alice.post(`stories/${story.id}/view`);
  await alice.post(`stories/${story.id}/view`);
  assert.equal((await bob.get(`stories/${story.id}/viewers`)).body.count, 1);
  assert.equal((await alice.get(`stories/${story.id}/viewers`)).status, 403);
  assert.equal((await alice.get('stories/bob')).body.items[0].seen, true);
  const refused = await bob.del(`stories/${story.id}`);
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: NO_DELETING });
  assert.ok((await alice.get('stories/bob')).body.items.some(i => i.id === story.id), 'the story stays until it expires');
});

test('groups: private groups gate posts behind approval', async () => {
  const { body: { group } } = await alice.post('groups', { name: 'Floor 3 Residents Test', description: 'Does not exist.', privacy: 'private' });
  await alice.post('posts', { group_id: group.id, body: 'Members only.' });
  assert.equal((await bob.post('posts', { group_id: group.id, body: 'Let me in' })).status, 403);
  assert.equal((await bob.get(`groups/${group.slug}/posts`)).status, 403);
  assert.equal((await anon.get('feed')).body.items.some(p => p.body === 'Members only.'), false, 'private group posts stay out of public feeds');

  assert.equal((await bob.post(`groups/${group.slug}/join`)).body.viewer.role, 'pending');
  assert.equal((await carol.post(`groups/${group.slug}/members/bob`, { action: 'approve' })).status, 403);
  await alice.post(`groups/${group.slug}/members/bob`, { action: 'approve' });
  const posts = await bob.get(`groups/${group.slug}/posts`);
  assert.ok(posts.body.items.some(p => p.body === 'Members only.'));
  assert.equal((await bob.get(`groups/${group.slug}`)).body.group.member_count, 2);
});
