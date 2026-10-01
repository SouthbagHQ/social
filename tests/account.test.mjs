import assert from 'node:assert/strict';
import { test } from 'node:test';
import { as } from './helpers.mjs';

const alice = as('alice'), kevin = as('kevin');
const wait = ms => new Promise(r => setTimeout(r, ms));

test('your data: counts of what is kept, and nothing deleted', async () => {
  const before = (await kevin.get('me/data')).body;
  const value = (data, label) => data.items.find(i => i.label === label)?.value;
  assert.equal(value(before, 'Deleted items'), '0');
  assert.ok(before.since > 0);
  await kevin.post('posts', { body: 'Counting.' });
  const after = (await kevin.get('me/data')).body;
  assert.equal(Number(value(after, 'Posts')), Number(value(before, 'Posts')) + 1);
  assert.equal((await as('nobody').get('me/data')).status, 401);
});

test('activity log: your own actions, newest first, with links and paging', async () => {
  // Only Alice's own posts, so nothing here changes what other test files see.
  const older = (await alice.post('posts', { body: 'Logged first.' })).body.post;
  await wait(5);
  const post = (await alice.post('posts', { body: 'Logged.' })).body.post;
  await wait(5);
  const reply = (await alice.post('posts', { body: 'Logged again.', reply_to_id: post.id })).body.post;
  await wait(5);
  await alice.put(`posts/${post.id}/reaction`, { type: 'like' });

  const first = (await alice.get('me/activity?limit=3')).body;
  assert.deepEqual(first.items.map(i => i.text), ['Reacted to a post', 'Replied to a post', 'Posted']);
  assert.deepEqual(first.items.map(i => i.link), [`/post/${post.id}`, `/post/${reply.id}`, `/post/${post.id}`]);
  assert.ok(first.next, 'more to come');
  const second = (await alice.get(`me/activity?limit=3&before=${first.next}`)).body;
  assert.ok(second.items.every(i => i.created_at < Number(first.next)), 'the next page is older');
  assert.equal(second.items[0].link, `/post/${older.id}`);
  assert.equal((await as('nobody').get('me/activity')).status, 401);
});
