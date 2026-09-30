import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anon, as } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol'), kevin = as('kevin');
const suffix = () => Math.random().toString(36).slice(2, 8);

async function png(who) {
  const bytes = new Uint8Array(1000);
  const { body } = await who.post('media', { kind: 'image', content_type: 'image/png', size: bytes.length, width: 10, height: 10 });
  await who.put(`media/${body.id}/chunks/0`, bytes);
  return (await who.post(`media/${body.id}/complete`)).body;
}

async function community(owner = alice, extra = {}) {
  const name = `t_${suffix()}`;
  const res = await owner.post('communities', { name, title: 'Test community', description: 'For tests.', rules: 'Be civil\nNo spam', ...extra });
  assert.equal(res.status, 201, res.text);
  return res.body.community;
}

const hot = (score, createdAt) =>
  Math.sign(score) * Math.log10(Math.max(Math.abs(score), 1)) + createdAt / 1000 / 45000;

test('communities: create, validate, join and leave', async () => {
  const c = await community();
  assert.equal(c.role, 'owner');
  assert.equal(c.member_count, 1);
  assert.deepEqual(c.rules, ['Be civil', 'No spam']);

  for (const name of ['ab', 'has space', 'x'.repeat(22), 'dash-name', 'feed']) {
    const res = await alice.post('communities', { name });
    assert.ok([409, 422].includes(res.status), `${name} -> ${res.status}`);
  }
  assert.equal((await bob.post('communities', { name: c.name.toUpperCase() })).status, 409, 'names are unique ignoring case');
  assert.equal((await anon.get(`communities/${c.name}`)).status, 200);
  assert.equal((await anon.get('communities/nope_nope_nope')).status, 404);
  const unauth = await fetch(`${process.env.BASE || 'http://localhost:8799'}/api/communities`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);

  const joined = await bob.post(`communities/${c.name}/join`);
  assert.equal(joined.body.viewer.role, 'member');
  assert.equal(joined.body.member_count, 2);
  assert.equal((await bob.post(`communities/${c.name}/join`)).body.member_count, 2, 'joining twice counts once');
  assert.ok((await bob.get('communities?tab=mine')).body.items.some(x => x.name === c.name));
  assert.equal((await bob.get(`communities/${c.name}`)).body.viewer.role, 'member');

  assert.equal((await bob.del(`communities/${c.name}/join`)).body.member_count, 1);
  assert.equal((await bob.del(`communities/${c.name}/join`)).body.member_count, 1, 'leaving twice counts once');
  assert.equal((await alice.del(`communities/${c.name}/join`)).status, 409, 'owners cannot leave');

  const listed = await anon.get(`communities?sort=new&q=${c.name}`);
  assert.equal(listed.body.items[0].name, c.name);

  assert.equal((await bob.patch(`communities/${c.name}`, { description: 'Mine now' })).status, 403);
  const patched = await alice.patch(`communities/${c.name}`, { description: 'Updated.', rules: ['One', 'Two', 'Three'] });
  assert.equal(patched.body.community.description, 'Updated.');
  assert.deepEqual(patched.body.community.rules, ['One', 'Two', 'Three']);
});

test('communities: posting text, link and image threads', async () => {
  const c = await community();
  const text = await bob.post(`communities/${c.name}/threads`, { kind: 'text', title: 'Hello there', body: 'First post.' });
  assert.equal(text.status, 201, text.text);
  assert.equal(text.body.thread.kind, 'text');
  assert.equal(text.body.thread.score, 1, 'authors upvote their own posts');
  assert.equal(text.body.thread.vote, 1);
  assert.equal(text.body.thread.author.handle, 'bob');
  assert.equal(text.body.thread.community.name, c.name);

  const link = await bob.post(`communities/${c.name}/threads`, { kind: 'link', title: 'A link', url: 'https://example.com/a' });
  assert.equal(link.body.thread.url, 'https://example.com/a');
  assert.equal((await bob.post(`communities/${c.name}/threads`, { kind: 'link', title: 'Bad', url: 'javascript:alert(1)' })).status, 422);
  assert.equal((await bob.post(`communities/${c.name}/threads`, { kind: 'link', title: 'Bad' })).status, 422);

  const media = await bob.post('media', { kind: 'image', content_type: 'image/png', size: 10 }).then(async r => {
    await bob.put(`media/${r.body.id}/chunks/0`, new Uint8Array(10));
    return (await bob.post(`media/${r.body.id}/complete`)).body;
  });
  const image = await bob.post(`communities/${c.name}/threads`, { kind: 'image', title: 'A picture', media_id: media.id });
  assert.equal(image.status, 201, image.text);
  assert.equal(image.body.thread.image_url, `/media/${media.id}`);
  const others = await png(carol);
  assert.equal((await bob.post(`communities/${c.name}/threads`, { kind: 'image', title: 'Not mine', media_id: others.id })).status, 422);
  assert.equal((await bob.post(`communities/${c.name}/threads`, { kind: 'image', title: 'Nothing' })).status, 422);

  assert.equal((await bob.post(`communities/${c.name}/threads`, { title: '' })).status, 422);
  assert.equal((await bob.post(`communities/${c.name}/threads`, { title: 'x'.repeat(301) })).status, 422);
  assert.equal((await bob.post(`communities/${c.name}/threads`, { title: 'Long', body: 'x'.repeat(10001) })).status, 422);

  assert.equal((await anon.get(`communities/${c.name}`)).body.community.thread_count, 3);
  const one = await anon.get(`communities/${c.name}/threads/${text.body.thread.id}`);
  assert.equal(one.body.thread.body, 'First post.');
  assert.equal(one.body.thread.vote, 0);

  // Editing and deleting are the author's.
  assert.equal((await carol.patch(`communities/${c.name}/threads/${text.body.thread.id}`, { body: 'Hijacked' })).status, 403);
  const edited = await bob.patch(`communities/${c.name}/threads/${text.body.thread.id}`, { body: 'Edited.' });
  assert.equal(edited.body.thread.body, 'Edited.');
  assert.ok(edited.body.thread.edited_at);
  assert.equal((await carol.del(`communities/${c.name}/threads/${link.body.thread.id}`)).status, 403);
  assert.equal((await bob.del(`communities/${c.name}/threads/${link.body.thread.id}`)).status, 200);
  const gone = await anon.get(`communities/${c.name}/threads/${link.body.thread.id}`);
  assert.equal(gone.body.thread.deleted, true);
  assert.equal(gone.body.thread.author, null);
  assert.equal(gone.body.thread.url, null);
  const list = await anon.get(`communities/${c.name}/threads?sort=new`);
  assert.equal(list.body.items.some(t => t.id === link.body.thread.id), false);
  assert.equal((await anon.get(`communities/${c.name}`)).body.community.thread_count, 2);

  // Threads stay out of the social feeds.
  const feed = await bob.get('feed');
  assert.equal(JSON.stringify(feed.body).includes('Hello there'), false);
});

test('communities: votes are idempotent, switch cleanly and update hot', async () => {
  const c = await community();
  const { body: { thread } } = await alice.post(`communities/${c.name}/threads`, { title: 'Vote on this' });
  const vote = (who, value, target_id = thread.id, target_type = 'thread') => who.put('communities/votes', { target_type, target_id, value });

  let r = await vote(bob, 1);
  assert.deepEqual([r.body.score, r.body.upvotes, r.body.downvotes, r.body.vote], [2, 2, 0, 1]);
  r = await vote(bob, 1);
  assert.deepEqual([r.body.score, r.body.upvotes, r.body.downvotes], [2, 2, 0], 'voting twice changes nothing');
  r = await vote(bob, -1);
  assert.deepEqual([r.body.score, r.body.upvotes, r.body.downvotes], [0, 1, 1], 'switching moves two points');
  r = await vote(carol, -1);
  r = await vote(kevin, -1);
  assert.deepEqual([r.body.score, r.body.upvotes, r.body.downvotes], [-2, 1, 3]);
  r = await vote(bob, 0);
  assert.deepEqual([r.body.score, r.body.upvotes, r.body.downvotes, r.body.vote], [-1, 1, 2, 0]);
  r = await vote(bob, 0);
  assert.equal(r.body.score, -1, 'clearing twice changes nothing');
  r = await vote(alice, 0);
  assert.deepEqual([r.body.score, r.body.upvotes, r.body.downvotes], [-2, 0, 2], 'authors can take back their own vote');

  assert.equal((await vote(bob, 2)).status, 422);
  assert.equal((await vote(bob, 1, 'nope')).status, 404);
  assert.equal((await bob.put('communities/votes', { target_type: 'post', target_id: thread.id, value: 1 })).status, 422);
  const noAuth = await fetch(`${process.env.BASE || 'http://localhost:8799'}/api/communities/votes`, { method: 'PUT', body: '{}' });
  assert.equal(noAuth.status, 401);

  const seen = await bob.get(`communities/${c.name}/threads/${thread.id}`);
  assert.equal(seen.body.thread.vote, 0);
  assert.equal((await carol.get(`communities/${c.name}/threads/${thread.id}`)).body.thread.vote, -1);

  // Hot: a newer post with a higher score ranks first; a well-voted older post can beat a new one.
  const { body: { thread: second } } = await bob.post(`communities/${c.name}/threads`, { title: 'Second' });
  await vote(carol, 1, second.id);
  await vote(kevin, 1, second.id);
  const hotList = (await anon.get(`communities/${c.name}/threads?sort=hot`)).body.items;
  assert.deepEqual(hotList.map(t => t.id), [second.id, thread.id]);

  // Top sorts by score; the time window filters by age.
  const top = (await anon.get(`communities/${c.name}/threads?sort=top&t=all`)).body.items;
  assert.deepEqual(top.map(t => t.score), [3, -2]);
  assert.equal((await anon.get(`communities/${c.name}/threads?sort=top&t=day`)).body.items.length, 2);
  const newest = (await anon.get(`communities/${c.name}/threads?sort=new`)).body.items;
  assert.equal(newest[0].id, second.id);
  assert.equal(newest[0].vote, 0);
  assert.equal((await carol.get(`communities/${c.name}/threads?sort=new`)).body.items[0].vote, 1, 'lists carry the viewer\'s vote');
});

test('communities: hot rank follows the formula', async () => {
  const c = await community();
  const { body: { thread } } = await alice.post(`communities/${c.name}/threads`, { title: 'Hot maths' });
  const fillers = [];
  for (let i = 0; i < 3; i++) fillers.push((await bob.post(`communities/${c.name}/threads`, { title: `Filler ${i}` })).body.thread);
  // Same score: newer first.
  assert.equal((await anon.get(`communities/${c.name}/threads?sort=hot&limit=1`)).body.items[0].id, fillers[2].id);
  // log10(4) is worth hours of age, so a few votes lift the oldest post to the top.
  for (const who of [bob, carol, kevin]) await who.put('communities/votes', { target_type: 'thread', target_id: thread.id, value: 1 });
  assert.ok(hot(4, thread.created_at) > hot(1, fillers[2].created_at));
  // A downvoted post (score -2) sinks below older ones.
  await carol.put('communities/votes', { target_type: 'thread', target_id: fillers[2].id, value: -1 });
  await kevin.put('communities/votes', { target_type: 'thread', target_id: fillers[2].id, value: -1 });
  await alice.put('communities/votes', { target_type: 'thread', target_id: fillers[2].id, value: -1 });
  const order = (await anon.get(`communities/${c.name}/threads?sort=hot`)).body.items.map(t => t.id);
  assert.deepEqual(order, [thread.id, fillers[1].id, fillers[0].id, fillers[2].id]);
  // Paging with a tiny page size still visits every thread once.
  const seen = new Set();
  let cursor = '';
  for (let i = 0; i < 5; i++) {
    const r = await anon.get(`communities/${c.name}/threads?sort=hot&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    r.body.items.forEach(t => seen.add(t.id));
    if (!r.body.next) break;
    cursor = r.body.next;
  }
  assert.equal(seen.size, 4);
  const top = (await anon.get(`communities/${c.name}/threads?sort=hot&limit=1`)).body.items[0];
  assert.equal(top.id, thread.id);
  assert.equal(top.score, 4);
  assert.ok(hot(4, top.created_at) > hot(1, top.created_at));
});

test('communities: nested comments, sorting, edits and notifications', async () => {
  const c = await community();
  const { body: { thread } } = await alice.post(`communities/${c.name}/threads`, { title: 'Discuss' });
  const path = `communities/${c.name}/threads/${thread.id}/comments`;
  const a = (await bob.post(path, { body: 'Top level from bob' })).body.comment;
  assert.equal(a.depth, 0);
  const b = (await carol.post(path, { body: 'Top level from carol' })).body.comment;
  const reply = (await alice.post(path, { body: 'Reply to bob', parent_id: a.id })).body.comment;
  assert.equal(reply.depth, 1);
  assert.equal(reply.parent_id, a.id);

  // Six levels deep, and no deeper.
  let parent = reply;
  for (let d = 2; d < 6; d++) {
    const r = await bob.post(path, { body: `Level ${d}`, parent_id: parent.id });
    assert.equal(r.status, 201, r.text);
    parent = r.body.comment;
  }
  assert.equal(parent.depth, 5);
  assert.equal((await bob.post(path, { body: 'Too deep', parent_id: parent.id })).status, 422);
  assert.equal((await bob.post(path, { body: '' })).status, 422);
  assert.equal((await bob.post(path, { body: 'x'.repeat(5001) })).status, 422);
  assert.equal((await bob.post(path, { body: 'Orphan', parent_id: 'nope' })).status, 404);

  // Carol's comment gets votes so Top puts it first.
  await bob.put('communities/votes', { target_type: 'comment', target_id: b.id, value: 1 });
  const v = await kevin.put('communities/votes', { target_type: 'comment', target_id: b.id, value: 1 });
  assert.equal(v.body.score, 3);

  const topTree = (await anon.get(`${path}?sort=top`)).body;
  assert.equal(topTree.count, 7);
  assert.deepEqual(topTree.items.map(x => x.id), [b.id, a.id]);
  let node = topTree.items[1];
  for (let d = 1; d < 6; d++) { assert.equal(node.children.length, 1); node = node.children[0]; assert.equal(node.depth, d); }
  const newTree = (await anon.get(`${path}?sort=new`)).body;
  assert.deepEqual(newTree.items.map(x => x.id), [b.id, a.id]);
  assert.equal((await kevin.get(`${path}`)).body.items[0].vote, 1);

  // Counts and notifications: alice is told about top-level comments, bob about alice's reply.
  assert.equal((await anon.get(`communities/${c.name}/threads/${thread.id}`)).body.thread.comment_count, 7);
  const aliceNotes = (await alice.get('notifications')).body.items.filter(n => n.type === 'reply' && n.link === `/c/${c.name}/${thread.id}` && n.body?.startsWith('Top level'));
  assert.equal(aliceNotes.length, 2);
  assert.equal(aliceNotes[0].post, null);
  const bobNotes = (await bob.get('notifications')).body.items.filter(n => n.type === 'reply' && n.link === `/c/${c.name}/${thread.id}` && n.body === 'Reply to bob');
  assert.equal(bobNotes.length, 1);

  // Edit and delete.
  assert.equal((await carol.patch(`${path}/${a.id}`, { body: 'Nope' })).status, 403);
  const edited = await bob.patch(`${path}/${a.id}`, { body: 'Edited by bob' });
  assert.equal(edited.body.comment.body, 'Edited by bob');
  assert.ok(edited.body.comment.edited_at);
  assert.equal((await carol.del(`${path}/${a.id}`)).status, 403);
  assert.equal((await bob.del(`${path}/${a.id}`)).status, 200);
  const after = (await anon.get(path)).body;
  const deleted = after.items.find(x => x.id === a.id);
  assert.equal(deleted.deleted, true, 'a deleted comment with replies stays as a placeholder');
  assert.equal(deleted.body, '');
  assert.equal(deleted.author, null);
  assert.equal(deleted.children.length, 1);
  assert.equal((await bob.del(`${path}/${b.id}`)).status, 403);
  assert.equal((await carol.del(`${path}/${b.id}`)).status, 200);
  assert.equal((await anon.get(path)).body.items.some(x => x.id === b.id), false, 'deleted leaves disappear');
  assert.equal((await anon.get(`communities/${c.name}/threads/${thread.id}`)).body.thread.comment_count, 5);
});

test('communities: moderators pin, lock and remove; others cannot', async () => {
  const c = await community();
  await bob.post(`communities/${c.name}/join`);
  await carol.post(`communities/${c.name}/join`);
  const older = (await carol.post(`communities/${c.name}/threads`, { title: 'Older' })).body.thread;
  const newer = (await carol.post(`communities/${c.name}/threads`, { title: 'Newer' })).body.thread;
  const threadPath = id => `communities/${c.name}/threads/${id}`;

  assert.equal((await bob.patch(threadPath(older.id), { pinned: true })).status, 403);
  assert.equal((await carol.patch(threadPath(older.id), { locked: true })).status, 403, 'authors are not moderators');
  assert.equal((await bob.put(`communities/${c.name}/moderators/carol`)).status, 403);
  assert.equal((await alice.put(`communities/${c.name}/moderators/kevin`)).status, 404, 'moderators must be members');
  const promoted = await alice.put(`communities/${c.name}/moderators/bob`);
  assert.equal(promoted.body.member.role, 'moderator');
  const info = (await anon.get(`communities/${c.name}`)).body;
  assert.deepEqual(info.moderators.map(m => [m.user.handle, m.role]), [['alice', 'owner'], ['bob', 'moderator']]);
  assert.equal((await bob.get(threadPath(older.id))).body.thread.viewer.can_moderate, true);

  // Pin: first on the Hot page.
  const pinned = await bob.patch(threadPath(older.id), { pinned: true });
  assert.equal(pinned.body.thread.pinned, true);
  assert.equal((await anon.get(`communities/${c.name}/threads?sort=hot`)).body.items[0].id, older.id);
  assert.equal((await anon.get(`communities/${c.name}/threads?sort=hot`)).body.items.length, 2);

  // Lock: only moderators may comment.
  await bob.patch(threadPath(newer.id), { locked: true });
  assert.equal((await carol.post(`${threadPath(newer.id)}/comments`, { body: 'Can I?' })).status, 403);
  assert.equal((await bob.post(`${threadPath(newer.id)}/comments`, { body: 'Locked.' })).status, 201);
  const comment = (await alice.post(`${threadPath(older.id)}/comments`, { body: 'Remove me' })).body.comment;

  // Remove comments and threads.
  assert.equal((await carol.del(`${threadPath(older.id)}/comments/${comment.id}`)).status, 403);
  assert.equal((await bob.del(`${threadPath(older.id)}/comments/${comment.id}`)).status, 200);
  assert.equal((await anon.get(`${threadPath(older.id)}/comments`)).body.count, 0);
  assert.equal((await bob.del(threadPath(older.id))).status, 403, 'moderators remove rather than delete');
  const removed = await bob.patch(threadPath(older.id), { removed: true });
  assert.equal(removed.body.thread.removed, true);
  assert.equal(removed.body.thread.pinned, false);
  assert.equal((await anon.get(`communities/${c.name}/threads?sort=new`)).body.items.some(t => t.id === older.id), false);
  assert.equal((await anon.get(threadPath(older.id))).status, 404);
  assert.equal((await carol.get(threadPath(older.id))).body.thread.body, '', 'titles only: text body is empty here anyway');
  assert.equal((await carol.post(`${threadPath(older.id)}/comments`, { body: 'Hello?' })).status, 404);
  assert.equal((await carol.put('communities/votes', { target_type: 'thread', target_id: older.id, value: 1 })).status, 404);
  assert.equal((await anon.get(`communities/${c.name}`)).body.community.thread_count, 1);
  await bob.patch(threadPath(older.id), { removed: false });
  assert.equal((await anon.get(`communities/${c.name}`)).body.community.thread_count, 2);

  // Demoted moderators lose the power.
  await alice.del(`communities/${c.name}/moderators/bob`);
  assert.equal((await bob.patch(threadPath(newer.id), { locked: false })).status, 403);
});

test('communities: home feed shows joined communities, popular when signed out', async () => {
  const a = await community(alice);
  const b = await community(bob);
  const inA = (await alice.post(`communities/${a.name}/threads`, { title: 'In A' })).body.thread;
  const inB = (await bob.post(`communities/${b.name}/threads`, { title: 'In B' })).body.thread;
  await carol.post(`communities/${a.name}/join`);
  const carolFeed = (await carol.get('communities/feed?sort=new')).body;
  assert.equal(carolFeed.source, 'joined');
  assert.ok(carolFeed.items.some(t => t.id === inA.id));
  assert.equal(carolFeed.items.some(t => t.id === inB.id), false);
  const open = (await anon.get('communities/feed?sort=new&limit=50')).body;
  assert.equal(open.source, 'popular');
  assert.ok(open.items.some(t => t.id === inB.id));
  const top = (await anon.get('communities/feed?sort=top&t=week')).body;
  assert.ok(Array.isArray(top.items));
  const popular = (await anon.get('communities?sort=popular')).body.items;
  for (let i = 1; i < popular.length; i++) assert.ok(popular[i - 1].member_count >= popular[i].member_count);
});
