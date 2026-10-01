import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE, anon, as } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol');
const NO_DELETING = "Deletion isn't available. Kevin knows what you did.";

test('session: /api/me reflects the cookie', async () => {
  assert.equal((await anon.get('me')).body.authenticated, false);
  const me = await alice.get('me');
  assert.equal(me.body.user.handle, 'alice');
});

test('CSRF: cookie-authenticated writes from another origin are refused', async () => {
  const res = await fetch(`${BASE}/api/posts`, {
    method: 'POST',
    headers: { cookie: 'southbag_social_session=dev-alice', origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'hi' }),
  });
  assert.equal(res.status, 403);
});

test('posts: create, validate, react, reply, repost, amend, never delete', async () => {
  const blank = await alice.post('posts', { body: '   ' });
  assert.equal(blank.status, 422);
  const long = await alice.post('posts', { body: 'x'.repeat(281) });
  assert.equal(long.status, 422);

  const { body: { post } } = await alice.post('posts', { body: 'Hello #Southbag @bob' });
  assert.equal(post.author.handle, 'alice');

  const reacted = await bob.put(`posts/${post.id}/reaction`, { type: 'haha' });
  assert.equal(reacted.body.post.counts.reactions, 1);
  assert.equal(reacted.body.post.viewer.reaction, 'haha');
  const changed = await bob.put(`posts/${post.id}/reaction`, { type: 'love' });
  assert.equal(changed.body.post.counts.reactions, 1, 'changing a reaction does not double count');

  const reply = await bob.post('posts', { body: 'A reply', reply_to_id: post.id });
  assert.equal(reply.status, 201);
  const thread = await carol.get(`posts/${reply.body.post.id}`);
  assert.equal(thread.body.ancestors[0].id, post.id);
  const replies = await carol.get(`posts/${post.id}/replies`);
  assert.equal(replies.body.items.length, 1);

  const repost = await carol.post(`posts/${post.id}/repost`);
  assert.equal(repost.body.post.counts.reposts, 1);
  assert.equal(repost.body.post.viewer.reposted, true);
  assert.equal((await carol.post(`posts/${post.id}/repost`)).status, 409);

  assert.equal((await bob.patch(`posts/${post.id}`, { body: 'nope' })).status, 403);
  const amended = await alice.patch(`posts/${post.id}`, { body: 'Hello again' });
  assert.equal(amended.body.post.body, 'Hello again');
  assert.ok(amended.body.post.edited_at);

  for (const who of [bob, alice]) {
    const refused = await who.del(`posts/${post.id}`);
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body, { error: NO_DELETING }, 'not even the author can delete');
  }
  const kept = (await carol.get(`posts/${post.id}`)).body.post;
  assert.ok(!kept.deleted);
  assert.equal(kept.body, 'Hello again');
});

test('media: chunked upload into D1, full and ranged reads', async () => {
  const size = 1572864 * 2 + 1234;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  const created = await alice.post('media', { kind: 'video', content_type: 'video/mp4', size, width: 720, height: 1280, duration: 9 });
  assert.equal(created.status, 201);
  const { id, chunk_size: chunk, chunk_count: count } = created.body;
  assert.equal(count, 3);
  assert.equal((await alice.post(`media/${id}/complete`)).status, 409, 'cannot complete before chunks arrive');
  assert.equal((await bob.put(`media/${id}/chunks/0`, bytes.subarray(0, chunk))).status, 404, 'only the owner uploads');
  for (let i = 0; i < count; i++) {
    const res = await alice.put(`media/${id}/chunks/${i}`, bytes.subarray(i * chunk, Math.min(size, (i + 1) * chunk)));
    assert.equal(res.status, 200);
  }
  const done = await alice.post(`media/${id}/complete`);
  assert.equal(done.body.url, `/media/${id}`);

  const full = new Uint8Array(await (await fetch(`${BASE}/media/${id}`)).arrayBuffer());
  assert.deepEqual(full, bytes);
  const ranged = await fetch(`${BASE}/media/${id}`, { headers: { range: `bytes=${chunk - 2}-${chunk + 5}` } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes ${chunk - 2}-${chunk - 1}/${size}`, 'ranges stop at a chunk edge');
  const tail = await fetch(`${BASE}/media/${id}`, { headers: { range: 'bytes=-100' } });
  assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), bytes.subarray(size - 100));

  // A vertical short-length video becomes a short.
  const { body: { post } } = await alice.post('posts', { body: 'my short', media_ids: [id] });
  assert.equal(post.kind, 'short');
  assert.equal(post.media[0].id, id);
  assert.equal((await bob.post('posts', { body: 'steal', media_ids: [id] })).status, 422, 'cannot attach other people’s files');
});

test('visibility: followers-only posts stay hidden from strangers', async () => {
  const { body: { post } } = await alice.post('posts', { body: 'For The Pile only', visibility: 'followers' });
  assert.equal((await carol.get(`posts/${post.id}`)).status, 404);
  assert.equal((await alice.get(`posts/${post.id}`)).status, 200);
});

test('media: files still used by other features cannot be deleted', async () => {
  const bytes = new Uint8Array(500);
  const { body: m } = await alice.post('media', { kind: 'image', content_type: 'image/png', size: bytes.length, width: 10, height: 10 });
  await alice.put(`media/${m.id}/chunks/0`, bytes);
  await alice.post(`media/${m.id}/complete`);
  const { body: created } = await alice.post('events', { title: 'Cover test', starts_at: Date.now() + 86400000, timezone: 'Australia/Melbourne', cover_media_id: m.id, privacy: 'public', online_url: 'https://southbag.cc' });
  assert.ok(created.event, JSON.stringify(created));
  assert.equal((await alice.del(`media/${m.id}`)).status, 409, 'an event cover is in use');
});
