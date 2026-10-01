import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anon, as } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol');
const NO_DELETING = "Deletion isn't available. Kevin knows what you did.";

const poll = (options, extra = {}) => ({ options, duration_hours: 24, ...extra });

test('polls: create and validate', async () => {
  const one = await alice.post('posts', { body: 'Tea or coffee?', poll: poll(['Tea']) });
  assert.equal(one.status, 422);
  const five = await alice.post('posts', { body: 'Pick one', poll: poll(['a', 'b', 'c', 'd', 'e']) });
  assert.equal(five.status, 422);
  const noQuestion = await alice.post('posts', { body: '  ', poll: poll(['Tea', 'Coffee']) });
  assert.equal(noQuestion.status, 422);
  assert.match(noQuestion.body.error, /question/i);
  const longOption = await alice.post('posts', { body: 'Pick', poll: poll(['x'.repeat(26), 'y']) });
  assert.equal(longOption.status, 422);
  const blankOption = await alice.post('posts', { body: 'Pick', poll: poll(['Tea', ' ']) });
  assert.equal(blankOption.status, 422);
  const same = await alice.post('posts', { body: 'Pick', poll: poll(['Tea', 'tea']) });
  assert.equal(same.status, 422);
  const tooLong = await alice.post('posts', { body: 'Pick', poll: poll(['Tea', 'Coffee'], { duration_hours: 169 }) });
  assert.equal(tooLong.status, 422);
  const zero = await alice.post('posts', { body: 'Pick', poll: poll(['Tea', 'Coffee'], { duration_hours: 0 }) });
  assert.equal(zero.status, 422);

  const before = Date.now();
  const made = await alice.post('posts', { body: 'Tea or coffee?', poll: poll(['Tea', 'Coffee', 'Neither'], { duration_hours: 72 }) });
  assert.equal(made.status, 201);
  const p = made.body.post.poll;
  assert.deepEqual(p.options.map(o => o.label), ['Tea', 'Coffee', 'Neither']);
  assert.ok(p.options.every(o => o.id && o.votes === 0));
  assert.equal(p.total, 0);
  assert.equal(p.closed, false);
  assert.equal(p.multiple, false);
  assert.deepEqual(p.viewer_votes, []);
  assert.ok(p.closes_at >= before + 72 * 3600000 - 1000 && p.closes_at <= Date.now() + 72 * 3600000);

  // Shows up everywhere posts are hydrated, including for signed-out visitors.
  const signedOut = await anon.get(`posts/${made.body.post.id}`);
  assert.equal(signedOut.body.post.poll.options.length, 3);
  const plain = await alice.post('posts', { body: 'No poll here' });
  assert.equal(plain.body.post.poll, null);
});

test('polls: vote, change, withdraw, multiple answers, close', async () => {
  const { body: { post } } = await alice.post('posts', { body: 'Best day?', poll: poll(['Monday', 'Friday']) });
  const [mon, fri] = post.poll.options.map(o => o.id);

  assert.equal((await anon.get(`posts/${post.id}`)).status, 200);
  assert.equal((await bob.post(`polls/${post.id}/vote`, { option_ids: [] })).status, 422);
  assert.equal((await bob.post(`polls/${post.id}/vote`, { option_ids: ['nope'] })).status, 422);
  assert.equal((await bob.post(`polls/${post.id}/vote`, { option_ids: [mon, fri] })).status, 422, 'one option unless multiple');

  let res = await bob.post(`polls/${post.id}/vote`, { option_ids: [mon] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.post.poll.viewer_votes, [mon]);
  assert.deepEqual(res.body.post.poll.options.map(o => o.votes), [1, 0]);
  assert.equal(res.body.post.poll.total, 1);

  res = await bob.post(`polls/${post.id}/vote`, { option_ids: [fri] });
  assert.deepEqual(res.body.post.poll.viewer_votes, [fri], 'voting again replaces the vote');
  assert.deepEqual(res.body.post.poll.options.map(o => o.votes), [0, 1]);
  assert.equal(res.body.post.poll.total, 1);

  res = await carol.post(`polls/${post.id}/vote`, { option_ids: [fri] });
  assert.deepEqual(res.body.post.poll.options.map(o => o.votes), [0, 2]);
  assert.equal(res.body.post.poll.total, 2);
  // Each viewer sees their own votes.
  assert.deepEqual((await alice.get(`posts/${post.id}`)).body.post.poll.viewer_votes, []);

  res = await bob.del(`polls/${post.id}/vote`);
  assert.deepEqual(res.body.post.poll.viewer_votes, []);
  assert.deepEqual(res.body.post.poll.options.map(o => o.votes), [0, 1]);
  assert.equal(res.body.post.poll.total, 1);

  // Multiple answers.
  const multi = (await alice.post('posts', { body: 'Which fruit?', poll: poll(['Apple', 'Pear', 'Plum'], { multiple: true }) })).body.post;
  assert.equal(multi.poll.multiple, true);
  const [apple, pear, plum] = multi.poll.options.map(o => o.id);
  res = await bob.post(`polls/${multi.id}/vote`, { option_ids: [apple, pear] });
  assert.equal(res.status, 200);
  assert.deepEqual([...res.body.post.poll.viewer_votes].sort(), [apple, pear].sort());
  res = await carol.post(`polls/${multi.id}/vote`, { option_ids: [pear] });
  assert.deepEqual(res.body.post.poll.options.map(o => o.votes), [1, 2, 0]);
  assert.equal(res.body.post.poll.total, 2, 'total counts people, not answers');
  res = await bob.post(`polls/${multi.id}/vote`, { option_ids: [plum] });
  assert.deepEqual(res.body.post.poll.options.map(o => o.votes), [0, 1, 1]);
  // Options from another poll are refused.
  assert.equal((await bob.post(`polls/${multi.id}/vote`, { option_ids: [mon] })).status, 422);

  // Only the author can end a poll early; closed polls refuse votes.
  assert.equal((await bob.post(`polls/${post.id}/close`)).status, 403);
  res = await alice.post(`polls/${post.id}/close`);
  assert.equal(res.status, 200);
  assert.equal(res.body.post.poll.closed, true);
  assert.equal((await bob.post(`polls/${post.id}/vote`, { option_ids: [mon] })).status, 409);
  assert.equal((await carol.del(`polls/${post.id}/vote`)).status, 409);
  const final = (await bob.get(`posts/${post.id}`)).body.post.poll;
  assert.equal(final.closed, true);
  assert.deepEqual(final.options.map(o => o.votes), [0, 1]);

  // Posts without a poll 404. A poll's post can't be deleted, so the poll and its votes stay.
  const plain = (await alice.post('posts', { body: 'Plain' })).body.post;
  assert.equal((await bob.post(`polls/${plain.id}/vote`, { option_ids: [mon] })).status, 404);
  const refused = await alice.del(`posts/${multi.id}`);
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: NO_DELETING });
  const kept = (await bob.get(`posts/${multi.id}`)).body.post.poll;
  assert.deepEqual(kept.options.map(o => o.votes), [0, 1, 1]);
  assert.deepEqual(kept.viewer_votes, [plum]);
});

test('polls: private posts are not votable by people who cannot see them', async () => {
  const { body: { post } } = await alice.post('posts', { body: 'Friends only?', visibility: 'friends', poll: poll(['Yes', 'No']) });
  const res = await carol.post(`polls/${post.id}/vote`, { option_ids: [post.poll.options[0].id] });
  assert.equal(res.status, 404);
});

test('pins: pin, replace, unpin, other people, pinned posts cannot be deleted', async () => {
  const first = (await alice.post('posts', { body: 'Pin me' })).body.post;
  const second = (await alice.post('posts', { body: 'No, pin me' })).body.post;
  const bobs = (await bob.post('posts', { body: 'Bob post' })).body.post;
  const reply = (await alice.post('posts', { body: 'A reply', reply_to_id: bobs.id })).body.post;

  assert.equal((await anon.get('pins/alice')).status, 200);
  assert.equal((await alice.put('pins', { post_id: bobs.id })).status, 403, "can't pin someone else's post");
  assert.equal((await alice.put('pins', { post_id: reply.id })).status, 422, "can't pin a reply");
  assert.equal((await alice.put('pins', { post_id: 'missing' })).status, 404);

  let res = await alice.put('pins', { post_id: first.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.post.viewer.pinned, true);
  assert.equal((await bob.get('pins/alice')).body.post.id, first.id);
  assert.equal((await anon.get('pins/alice')).body.post.id, first.id);
  assert.equal((await alice.get('users/alice')).body.user.pinned_post_id, first.id);

  res = await alice.put('pins', { post_id: second.id });
  assert.equal((await bob.get('pins/alice')).body.post.id, second.id, 'pinning replaces the old pin');
  assert.equal((await alice.get(`posts/${first.id}`)).body.post.viewer.pinned, false);
  assert.equal((await alice.get(`posts/${second.id}`)).body.post.viewer.pinned, true);
  assert.equal((await bob.get(`posts/${second.id}`)).body.post.viewer.pinned, false, 'pinned is only reported to the author');

  assert.equal((await alice.del('pins')).status, 200);
  assert.equal((await bob.get('pins/alice')).body.post, null);

  await alice.put('pins', { post_id: second.id });
  const refused = await alice.del(`posts/${second.id}`);
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: NO_DELETING });
  assert.equal((await bob.get('pins/alice')).body.post.id, second.id, 'the pinned post stays pinned');
  assert.equal((await alice.get('users/alice')).body.user.pinned_post_id, second.id);
  assert.equal((await alice.del('pins')).status, 200, 'unpinning still works');
  assert.equal((await alice.get('users/alice')).body.user.pinned_post_id, null);

  assert.equal((await bob.get('pins/nobody-here')).status, 404);
});

test('pins: private pinned posts follow post visibility', async () => {
  const secret = (await carol.post('posts', { body: 'Friends only', visibility: 'friends' })).body.post;
  assert.equal((await carol.put('pins', { post_id: secret.id })).status, 200);
  assert.equal((await carol.get('pins/carol')).body.post.id, secret.id);
  assert.equal((await anon.get('pins/carol')).body.post, null);
  await carol.del('pins');
});
