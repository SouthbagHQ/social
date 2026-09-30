import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anon, as } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol');

test('follows: idempotent, counted, visible on profiles', async () => {
  assert.equal((await alice.put('users/bob/follow')).status, 200);
  assert.equal((await alice.put('users/bob/follow')).status, 200);
  const profile = await alice.get('users/bob');
  assert.equal(profile.body.viewer.is_following, true);
  assert.equal(profile.body.user.follower_count, 1, 'repeat follows do not double count');
  assert.equal((await alice.put('users/alice/follow')).status, 422);
  const followers = await anon.get('users/bob/followers');
  assert.ok(followers.body.items.some(u => u.handle === 'alice'));
  const notes = await bob.get('notifications');
  assert.ok(notes.body.items.some(n => n.type === 'follow' && n.actor?.handle === 'alice'));
});

test('friends: request, accept, unfriend — one row per pair', async () => {
  assert.equal((await carol.put('users/bob/friend')).body.friendship, 'requested');
  assert.equal((await bob.get('users/carol')).body.viewer.friendship, 'incoming');
  assert.equal((await bob.put('users/carol/friend')).body.friendship, 'friends');
  assert.equal((await carol.get('users/bob')).body.viewer.friendship, 'friends');
  // friends can post on each other's walls; strangers cannot
  assert.equal((await carol.post('posts', { body: 'On your wall', wall_user_id: 'dev-bob' })).status, 201);
  assert.equal((await alice.post('posts', { body: 'Nope', wall_user_id: 'dev-bob' })).status, 403);
  const wall = await anon.get('users/bob/posts?tab=wall');
  assert.ok(wall.body.items.some(p => p.body === 'On your wall'));
});

test('blocks remove follows and hide the blocker', async () => {
  await carol.put('users/alice/follow');
  assert.equal((await alice.put('users/carol/block')).body.blocked, true);
  assert.equal((await carol.get('users/alice')).body.viewer.is_following, false);
  assert.equal((await carol.put('users/alice/follow')).status, 403);
  await alice.del('users/carol/block');
});

test('me: handles are validated and unique', async () => {
  assert.equal((await alice.patch('me', { handle: 'bob' })).status, 409);
  assert.equal((await alice.patch('me', { handle: 'a!' })).status, 422);
  assert.equal((await alice.patch('me', { handle: 'kevin' })).status, 409);
  assert.equal((await alice.patch('me', { bio: 'Retained permanently.' })).status, 200);
});
