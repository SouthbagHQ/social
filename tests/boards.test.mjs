import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anon, as, BASE } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol'), kevin = as('kevin');
let n = 0;
const uniq = title => `${title} ${Date.now().toString(36).slice(-4)}${n++}`;
const ids = res => res.body.items.map(x => x.id);

async function upload(who, { kind = 'image', type = 'image/png', size = 400 } = {}) {
  const { body } = await who.post('media', { kind, content_type: type, size, width: 300, height: 200 });
  await who.put(`media/${body.id}/chunks/0`, new Uint8Array(size).fill(7));
  return (await who.post(`media/${body.id}/complete`)).body;
}

async function board(who, fields = {}) {
  const res = await who.post('boards', { title: uniq('Board'), ...fields });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.board;
}

async function pin(who, boardId, fields) {
  const res = await who.post(`boards/${boardId}/pins`, fields);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.pin;
}

async function photoPost(who, { visibility = 'public', images = 1 } = {}) {
  const media = [];
  for (let i = 0; i < images; i++) media.push(await upload(who));
  const res = await who.post('posts', { kind: 'photo', body: 'Weekend market\nMore text', media_ids: media.map(m => m.id), visibility });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { post: res.body.post, media };
}

test('boards: create, read, update, delete', async () => {
  assert.equal((await anon.get('boards/feed')).status, 200);
  assert.equal((await alice.post('boards', { title: '' })).status, 422);
  assert.equal((await alice.post('boards', { title: 'x'.repeat(51) })).status, 422);
  assert.equal((await alice.post('boards', { title: 'Ok', visibility: 'hidden' })).status, 422);
  assert.equal((await alice.post('boards', { title: 'Ok', description: 'x'.repeat(501) })).status, 422);

  const title = uniq('Kitchen ideas');
  const b = await board(alice, { title, description: 'Tiles and benches.' });
  assert.equal(b.title, title);
  assert.equal(b.visibility, 'public');
  assert.equal(b.owner.handle, 'alice');
  assert.equal(b.pin_count, 0);
  assert.deepEqual(b.covers, []);
  assert.equal((await alice.post('boards', { title: title.toUpperCase() })).status, 409, 'names are unique per owner');
  assert.equal((await bob.post('boards', { title })).status, 201, 'but not across people');

  const detail = (await bob.get(`boards/${b.id}`)).body;
  assert.equal(detail.board.description, 'Tiles and benches.');
  assert.equal(detail.viewer.role, null);
  assert.equal(detail.viewer.can_edit, false);
  assert.equal((await alice.get(`boards/${b.id}`)).body.viewer.role, 'owner');
  assert.equal((await anon.get(`boards/${b.id}`)).status, 200);
  assert.equal((await anon.get('boards/nope')).status, 404);

  assert.equal((await bob.patch(`boards/${b.id}`, { title: 'Mine' })).status, 403);
  const renamed = await alice.patch(`boards/${b.id}`, { title: 'Kitchen', description: '' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.board.title, 'Kitchen');
  assert.equal(renamed.body.board.description, '');
  assert.equal((await alice.patch(`boards/${b.id}`, { title: '' })).status, 422);

  assert.ok(ids(await alice.get('boards')).includes(b.id));
  assert.ok(ids(await anon.get('boards?owner=alice')).includes(b.id));
  assert.equal((await anon.get('boards?owner=nobody-here')).status, 404);
  assert.equal((await anon.get('boards')).status, 401);

  assert.equal((await bob.del(`boards/${b.id}`)).status, 403);
  assert.equal((await alice.del(`boards/${b.id}`)).status, 200);
  assert.equal((await alice.get(`boards/${b.id}`)).status, 404);
});

test('boards: secret boards are only for the owner and collaborators', async () => {
  const secret = await board(alice, { title: uniq('Gift ideas'), visibility: 'secret' });
  const image = await upload(alice);
  const p = await pin(alice, secret.id, { media_id: image.id, title: 'Scarf' });

  assert.equal((await bob.get(`boards/${secret.id}`)).status, 404);
  assert.equal((await anon.get(`boards/${secret.id}`)).status, 404);
  assert.equal((await anon.get(`boards/${secret.id}/pins`)).status, 404);
  assert.equal((await bob.get(`boards/pins/${p.id}`)).status, 404);
  assert.ok(!ids(await bob.get('boards?owner=alice&limit=48')).includes(secret.id));
  assert.ok(ids(await alice.get('boards?owner=alice&limit=48')).includes(secret.id));
  assert.ok(!ids(await anon.get('boards/feed?limit=50')).includes(p.id));
  assert.ok(!ids(await bob.get(`boards/search?q=Scarf`)).includes(p.id));
  assert.ok(ids(await alice.get(`boards/search?q=Scarf`)).includes(p.id));
  assert.equal((await bob.put(`boards/${secret.id}/follow`)).status, 404);
  assert.equal((await bob.post(`boards/${secret.id}/pins`, { pin_id: p.id })).status, 404);

  // An invitation lets the person see it; accepting makes them an editor.
  assert.equal((await alice.post(`boards/${secret.id}/collaborators`, { handle: 'carol' })).status, 201);
  assert.equal((await carol.get(`boards/${secret.id}`)).body.viewer.role, 'invited');
  assert.equal((await carol.get(`boards/${secret.id}/pins`)).body.items[0].id, p.id);

  // Making it public opens it up.
  await alice.patch(`boards/${secret.id}`, { visibility: 'public' });
  assert.equal((await bob.get(`boards/pins/${p.id}`)).status, 200);
  assert.ok(ids(await anon.get('boards/feed?limit=50')).includes(p.id));
});

test('boards: saving photos from posts respects who can see the post', async () => {
  const b = await board(bob);
  const { post, media } = await photoPost(alice, { images: 2 });
  const saved = await pin(bob, b.id, { post_id: post.id, media_id: media[1].id });
  assert.equal(saved.image.id, media[1].id);
  assert.equal(saved.source_post_id, post.id);
  assert.equal(saved.title, 'Weekend market', 'defaults to the first line');
  assert.equal(saved.user.handle, 'bob');
  assert.equal((await bob.post(`boards/${b.id}/pins`, { post_id: post.id, media_id: media[1].id })).status, 409);
  const first = await pin(bob, b.id, { post_id: post.id, title: 'Custom', note: 'For later' });
  assert.equal(first.image.id, media[0].id, 'no media_id: the first photo');
  assert.equal(first.note, 'For later');

  // Not this post's photo, a text post, a missing post.
  const other = await upload(alice);
  assert.equal((await bob.post(`boards/${b.id}/pins`, { post_id: post.id, media_id: other.id })).status, 422);
  const text = (await alice.post('posts', { body: 'Just words' })).body.post;
  assert.equal((await bob.post(`boards/${b.id}/pins`, { post_id: text.id })).status, 422);
  assert.equal((await bob.post(`boards/${b.id}/pins`, { post_id: 'nope' })).status, 404);

  // Friends-only: carol is not alice's friend, so she cannot save it, and bob's pin of it is hidden from her.
  const { post: friendsOnly } = await photoPost(alice, { visibility: 'friends' });
  const carolBoard = await board(carol);
  assert.equal((await carol.post(`boards/${carolBoard.id}/pins`, { post_id: friendsOnly.id })).status, 404);
  await alice.put('users/bob/friend');
  await bob.put('users/alice/friend');
  const hidden = await pin(bob, b.id, { post_id: friendsOnly.id });
  assert.equal((await bob.get(`boards/pins/${hidden.id}`)).status, 200);
  assert.equal((await carol.get(`boards/pins/${hidden.id}`)).status, 404);
  assert.ok(!ids(await carol.get(`boards/${b.id}/pins`)).includes(hidden.id));
  assert.ok(ids(await bob.get(`boards/${b.id}/pins`)).includes(hidden.id));
  assert.equal((await carol.post(`boards/${carolBoard.id}/pins`, { pin_id: hidden.id })).status, 404, 'no repin either');

  // Deleting the post hides pins of it.
  await alice.del(`posts/${post.id}`);
  assert.equal((await bob.get(`boards/pins/${saved.id}`)).status, 404);

  // Uploads must be your own finished image.
  const bobsVideo = await upload(bob, { kind: 'video', type: 'video/mp4' });
  assert.equal((await bob.post(`boards/${b.id}/pins`, { media_id: other.id })).status, 422);
  assert.equal((await bob.post(`boards/${b.id}/pins`, { media_id: bobsVideo.id })).status, 422);
  assert.equal((await bob.post(`boards/${b.id}/pins`, {})).status, 422);
  const own = await upload(bob);
  assert.equal((await bob.post(`boards/${b.id}/pins`, { media_id: own.id, link: 'javascript:alert(1)' })).status, 422);
  assert.equal((await bob.post(`boards/${b.id}/pins`, { media_id: own.id, title: 'x'.repeat(101) })).status, 422);
  const withLink = await pin(bob, b.id, { media_id: own.id, link: 'https://example.com/recipe' });
  assert.equal(withLink.link, 'https://example.com/recipe');
  assert.equal(withLink.source_post_id, null);
});

test('boards: repins, related pins and search', async () => {
  const mine = await board(alice, { title: uniq('Gardens') });
  const image = await upload(alice);
  const original = await pin(alice, mine.id, { media_id: image.id, title: uniq('Native garden'), note: 'Grevillea' });
  const extra = await pin(alice, mine.id, { media_id: (await upload(alice)).id, title: 'Path' });

  const kevinBoard = await board(kevin);
  const repin = await pin(kevin, kevinBoard.id, { pin_id: original.id });
  assert.equal(repin.source_pin_id, original.id);
  assert.equal(repin.image.id, image.id);
  assert.equal(repin.title, original.title, 'copies the title and note');
  assert.equal(repin.note, 'Grevillea');
  assert.equal(repin.board.id, kevinBoard.id);
  assert.equal((await kevin.post(`boards/${kevinBoard.id}/pins`, { pin_id: original.id })).status, 409);
  assert.equal((await alice.get(`boards/pins/${original.id}`)).body.pin.save_count, 1);
  const note = (await alice.get('notifications')).body.items.find(x => x.type === 'pin_saved');
  assert.ok(note && note.link === `/boards/${kevinBoard.id}?pin=${repin.id}`);

  // Kevin cannot pin to alice's board.
  assert.equal((await kevin.post(`boards/${mine.id}/pins`, { pin_id: original.id })).status, 403);

  const related = await alice.get(`boards/pins/${original.id}/related`);
  assert.equal(related.status, 200);
  const relatedIds = ids(related);
  assert.equal(relatedIds[0], extra.id, 'same board first');
  assert.ok(!relatedIds.includes(original.id));
  assert.ok(!relatedIds.includes(repin.id), 'the same photo is not related to itself');

  const found = await anon.get(`boards/search?q=${encodeURIComponent('grevillea')}`);
  assert.ok(ids(found).includes(original.id));
  assert.ok(ids(found).includes(repin.id));
  assert.deepEqual((await anon.get('boards/search?q=')).body.items, []);
  assert.ok(ids(await anon.get(`boards?q=${encodeURIComponent(mine.title)}`)).includes(mine.id));
});

test('boards: collaborators can add pins but not manage the board', async () => {
  const group = await board(alice, { title: uniq('Trip') });
  assert.equal((await alice.post(`boards/${group.id}/collaborators`, { handle: 'nobody-here' })).status, 404);
  assert.equal((await alice.post(`boards/${group.id}/collaborators`, { handle: 'alice' })).status, 422);
  assert.equal((await bob.post(`boards/${group.id}/collaborators`, { handle: 'carol' })).status, 403);
  assert.equal((await alice.post(`boards/${group.id}/collaborators`, { handle: 'bob' })).status, 201);
  assert.equal((await alice.post(`boards/${group.id}/collaborators`, { handle: 'bob' })).status, 409);

  const invite = (await bob.get('notifications')).body.items.find(x => x.type === 'board_invite');
  assert.equal(invite.link, `/boards/${group.id}`);

  // Invited is not yet an editor.
  const bobImage = await upload(bob);
  assert.equal((await bob.post(`boards/${group.id}/pins`, { media_id: bobImage.id })).status, 403);
  assert.equal((await carol.post(`boards/${group.id}/collaborators/accept`)).status, 404);
  assert.equal((await bob.post(`boards/${group.id}/collaborators/accept`)).body.role, 'editor');

  const detail = (await alice.get(`boards/${group.id}`)).body;
  assert.deepEqual(detail.collaborators.map(x => [x.user.handle, x.role]), [['bob', 'editor']]);
  assert.equal((await bob.get(`boards/${group.id}`)).body.viewer.can_edit, true);

  const bobPin = await pin(bob, group.id, { media_id: bobImage.id, title: 'Hostel' });
  const alicePin = await pin(alice, group.id, { media_id: (await upload(alice)).id });
  assert.ok(ids(await bob.get('boards?limit=48')).includes(group.id), 'group boards are listed for collaborators');

  // Editors edit their own pins; the owner can edit any.
  assert.equal((await bob.patch(`boards/pins/${bobPin.id}`, { note: 'Booked' })).body.pin.note, 'Booked');
  assert.equal((await bob.patch(`boards/pins/${alicePin.id}`, { note: 'Mine' })).status, 403);
  assert.equal((await bob.del(`boards/pins/${alicePin.id}`)).status, 403);
  assert.equal((await alice.patch(`boards/pins/${bobPin.id}`, { title: 'Hostel (old town)' })).status, 200);
  assert.equal((await bob.patch(`boards/${group.id}`, { title: 'Bob trip' })).status, 403);
  assert.equal((await bob.del(`boards/${group.id}`)).status, 403);
  assert.equal((await bob.post(`boards/${group.id}/collaborators`, { handle: 'kevin' })).status, 403);
  assert.equal((await bob.del(`boards/${group.id}/collaborators/alice`)).status, 403);

  // Leaving takes away editing.
  assert.equal((await bob.del(`boards/${group.id}/collaborators/bob`)).status, 200);
  assert.equal((await bob.post(`boards/${group.id}/pins`, { media_id: (await upload(bob)).id })).status, 403);
  assert.equal((await bob.del(`boards/${group.id}/collaborators/bob`)).status, 404);

  // Owner removes.
  await alice.post(`boards/${group.id}/collaborators`, { handle: 'carol' });
  assert.equal((await alice.del(`boards/${group.id}/collaborators/carol`)).status, 200);
  assert.equal((await carol.post(`boards/${group.id}/collaborators/accept`)).status, 404);
});

test('boards: follows and the home feed', async () => {
  const b = await board(carol, { title: uniq('Lamps') });
  assert.equal((await carol.put(`boards/${b.id}/follow`)).status, 422, 'not your own board');
  const followed = await kevin.put(`boards/${b.id}/follow`);
  assert.deepEqual(followed.body, { following: true, follower_count: 1 });
  assert.equal((await kevin.put(`boards/${b.id}/follow`)).body.follower_count, 1, 'idempotent');
  assert.equal((await kevin.get(`boards/${b.id}`)).body.viewer.following, true);
  assert.ok(ids(await kevin.get('boards/following')).includes(b.id));

  const p1 = await pin(carol, b.id, { media_id: (await upload(carol)).id, title: 'Brass lamp' });
  const p2 = await pin(carol, b.id, { media_id: (await upload(carol)).id, title: 'Paper lamp' });
  const feed = await kevin.get('boards/feed?limit=50');
  assert.equal(feed.body.mode, 'following');
  const order = ids(feed);
  assert.ok(order.indexOf(p2.id) >= 0 && order.indexOf(p2.id) < order.indexOf(p1.id), 'newest first');

  // People you follow: their pins show up too.
  const other = await board(bob);
  const bobPin = await pin(bob, other.id, { media_id: (await upload(bob)).id });
  assert.ok(!ids(await kevin.get('boards/feed?limit=50')).includes(bobPin.id));
  await kevin.put('users/bob/follow');
  assert.ok(ids(await kevin.get('boards/feed?limit=50')).includes(bobPin.id));
  await kevin.del('users/bob/follow');

  // Paging.
  const page1 = await kevin.get('boards/feed?limit=1');
  assert.equal(page1.body.items.length, 1);
  assert.ok(page1.body.next);
  const page2 = await kevin.get(`boards/feed?limit=1&cursor=${page1.body.next}`);
  assert.ok(page2.body.items[0].id < page1.body.items[0].id);

  // Signed out (or following nothing): recent public pins.
  const recent = await anon.get('boards/feed?limit=50');
  assert.equal(recent.body.mode, 'recent');
  assert.ok(ids(recent).includes(p2.id));

  const unfollowed = await kevin.del(`boards/${b.id}/follow`);
  assert.deepEqual(unfollowed.body, { following: false, follower_count: 0 });
  assert.ok(!ids(await kevin.get('boards/following')).includes(b.id));
});

test('boards: pin order, moving pins and covers', async () => {
  const b = await board(alice, { title: uniq('Order') });
  const pins = [];
  for (let i = 0; i < 4; i++) pins.push(await pin(alice, b.id, { media_id: (await upload(alice)).id, title: `P${i}` }));
  const order = async () => ids(await alice.get(`boards/${b.id}/pins`));
  assert.deepEqual(await order(), pins.map(p => p.id).reverse(), 'newest on top');

  // Swap the top two.
  assert.equal((await alice.put(`boards/${b.id}/order`, { pin_ids: [pins[2].id, pins[3].id] })).status, 200);
  assert.deepEqual(await order(), [pins[2].id, pins[3].id, pins[1].id, pins[0].id]);
  assert.equal((await alice.put(`boards/${b.id}/order`, { pin_ids: [pins[0].id] })).status, 422);
  assert.equal((await bob.put(`boards/${b.id}/order`, { pin_ids: [pins[0].id, pins[1].id] })).status, 403);

  // Paging in board order.
  const first = await alice.get(`boards/${b.id}/pins?limit=2`);
  assert.deepEqual(ids(first), [pins[2].id, pins[3].id]);
  const second = await alice.get(`boards/${b.id}/pins?limit=2&cursor=${encodeURIComponent(first.body.next)}`);
  assert.deepEqual(ids(second), [pins[1].id, pins[0].id]);
  assert.equal(second.body.next, null);

  // Cover: the chosen pin first, then the top pins.
  const covered = await alice.patch(`boards/${b.id}`, { cover_pin_id: pins[0].id });
  assert.equal(covered.body.board.covers[0].id, pins[0].image.id);
  assert.equal(covered.body.board.covers.length, 3);
  assert.equal((await alice.patch(`boards/${b.id}`, { cover_pin_id: 'nope' })).status, 422);

  // Move a pin to another board.
  const other = await board(alice, { title: uniq('Other') });
  const moved = await alice.patch(`boards/pins/${pins[0].id}`, { board_id: other.id });
  assert.equal(moved.body.pin.board.id, other.id);
  assert.equal((await alice.get(`boards/${b.id}`)).body.board.pin_count, 3);
  assert.equal((await alice.get(`boards/${b.id}`)).body.board.cover_pin_id, null, 'cover cleared');
  assert.equal((await alice.get(`boards/${other.id}`)).body.board.pin_count, 1);
  const bobBoard = await board(bob);
  assert.equal((await alice.patch(`boards/pins/${pins[1].id}`, { board_id: bobBoard.id })).status, 403);

  // Boards list: most recently pinned first.
  const listed = ids(await alice.get('boards?limit=48'));
  assert.ok(listed.indexOf(other.id) < listed.indexOf(b.id));
  const p1 = await alice.get('boards?limit=1');
  const p2 = await alice.get(`boards?limit=1&cursor=${encodeURIComponent(p1.body.next)}`);
  assert.notEqual(p2.body.items[0].id, p1.body.items[0].id);
});

test('boards: files stay while pinned and go with their last pin', async () => {
  const b = await board(bob, { title: uniq('Files') });
  const image = await upload(bob);
  const p = await pin(bob, b.id, { media_id: image.id });
  assert.equal((await bob.del(`media/${image.id}`)).status, 409, 'in use by a pin');

  const kevinBoard = await board(kevin);
  const repin = await pin(kevin, kevinBoard.id, { pin_id: p.id });
  assert.equal((await bob.del(`boards/pins/${p.id}`)).status, 200);
  assert.equal((await fetch(`${BASE}/media/${image.id}`)).status, 200, 'kept for the repin');
  assert.equal((await kevin.get(`boards/pins/${repin.id}`)).status, 200);
  assert.equal((await kevin.del(`boards/${kevinBoard.id}`)).status, 200);
  assert.equal((await fetch(`${BASE}/media/${image.id}`)).status, 404, 'deleted with the last pin');

  // A post's photo stays with the post when its pin goes.
  const { post, media } = await photoPost(alice);
  const fromPost = await pin(bob, b.id, { post_id: post.id });
  assert.equal((await bob.del(`boards/pins/${fromPost.id}`)).status, 200);
  assert.equal((await fetch(`${BASE}/media/${media[0].id}`)).status, 200);
  assert.equal((await bob.get(`boards/${b.id}`)).body.board.pin_count, 0);
});
