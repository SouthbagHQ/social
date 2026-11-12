import assert from 'node:assert/strict';
import { test } from 'node:test';
import { as } from './helpers.mjs';

// Only alice, bob, carol and kevin are usable: dev-erin is frozen and dev-frank's status check
// fails in the mock Identity server (see tests/freeze.test.mjs).
const alice = as('alice'), bob = as('bob'), carol = as('carol'), kevin = as('kevin');

/** Creates a group chat (2+ other handles; a single handle makes a 1:1) and returns it. */
async function groupChat(who, handles, title) {
  const res = await who.post('messages', { handles, title });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.conversation.is_group, true);
  return res.body.conversation;
}

/** Marks a conversation read for everyone, so these chats don't leak unread counts into other tests. */
async function markAllRead(conv, ...whos) {
  for (const who of whos) await who.post(`messages/${conv.id}/read`);
}

const mentionNotes = async who =>
  (await who.get('notifications?unread=1&limit=50')).body.items.filter(n => n.type === 'mention');

test('group chats: the creator is the owner, everyone else a member', async () => {
  const conv = await groupChat(alice, ['bob', 'carol'], 'Bag enthusiasts');
  assert.equal(conv.viewer_role, 'owner');
  const bobId = conv.members.find(m => m.handle === 'bob').id;
  assert.equal(conv.roles[bobId], 'member');
  const forBob = await bob.get(`messages/${conv.id}`);
  assert.equal(forBob.body.conversation.viewer_role, 'member');
  await markAllRead(conv, alice, bob, carol);
});

test('group chats: renaming is for owners and admins', async () => {
  const conv = await groupChat(alice, ['bob', 'carol']);
  assert.equal((await bob.patch(`messages/${conv.id}`, { title: 'Nope' })).status, 403);
  const renamed = await alice.patch(`messages/${conv.id}`, { title: 'Bag chat' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.conversation.title, 'Bag chat');
  await markAllRead(conv, alice, bob, carol);
});

test('group chats: members add people, only owners and admins remove them', async () => {
  const conv = await groupChat(alice, ['bob', 'carol']);

  // Any member can add people.
  const added = await bob.post(`messages/${conv.id}/members`, { handles: ['kevin'] });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.conversation.member_count, 4);
  assert.equal((await kevin.get(`messages/${conv.id}`)).status, 200);

  // Adding the same person again is an error, not a duplicate membership.
  assert.equal((await bob.post(`messages/${conv.id}/members`, { handles: ['kevin'] })).status, 422);

  // A plain member cannot remove anyone; the owner can.
  assert.equal((await bob.del(`messages/${conv.id}/members/dev-kevin`)).status, 403);
  assert.equal((await alice.del(`messages/${conv.id}/members/dev-kevin`)).status, 200);
  assert.equal((await kevin.get(`messages/${conv.id}`)).status, 404);

  // You remove yourself with Leave, not Remove.
  assert.equal((await alice.del(`messages/${conv.id}/members/dev-alice`)).status, 422);
  await markAllRead(conv, alice, bob, carol);
});

test('group chats: the owner manages admins', async () => {
  const conv = await groupChat(alice, ['bob', 'carol']);

  // Only the owner can promote.
  assert.equal((await bob.patch(`messages/${conv.id}/members/dev-carol`, { role: 'admin' })).status, 403);
  const promoted = await alice.patch(`messages/${conv.id}/members/dev-bob`, { role: 'admin' });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.conversation.roles['dev-bob'], 'admin');

  // An admin can rename and remove members, but not touch the owner or other admins.
  assert.equal((await bob.patch(`messages/${conv.id}`, { title: 'Admin rename' })).status, 200);
  assert.equal((await bob.del(`messages/${conv.id}/members/dev-alice`)).status, 403);
  assert.equal((await bob.del(`messages/${conv.id}/members/dev-carol`)).status, 200);

  // Demote back to member: renaming is off-limits again.
  assert.equal((await alice.patch(`messages/${conv.id}/members/dev-bob`, { role: 'member' })).status, 200);
  assert.equal((await bob.patch(`messages/${conv.id}`, { title: 'Nope' })).status, 403);

  assert.equal((await alice.patch(`messages/${conv.id}/members/dev-bob`, { role: 'captain' })).status, 422);
  await markAllRead(conv, alice, bob);
});

test('group chats: an owner leaving hands over ownership', async () => {
  const conv = await groupChat(alice, ['bob', 'carol']);
  await alice.patch(`messages/${conv.id}/members/dev-carol`, { role: 'admin' });
  await alice.patch(`messages/${conv.id}/members/dev-bob`, { role: 'admin' });
  assert.equal((await alice.del(`messages/${conv.id}/members/me`)).status, 200);

  // Bob joined before Carol, so Bob is the new owner even though both were admins.
  const forBob = await bob.get(`messages/${conv.id}`);
  assert.equal(forBob.body.conversation.viewer_role, 'owner');
  assert.equal(forBob.body.conversation.roles['dev-carol'], 'admin');
  const note = forBob.body.items.find(m => !m.sender && m.body.includes('is now the owner'));
  assert.ok(note, 'a system message announces the new owner');
  await markAllRead(conv, bob, carol);
});

test('group chats: invite links join, dedupe and revoke', async () => {
  const conv = await groupChat(alice, ['bob', 'carol']);

  // Members cannot manage invite links.
  assert.equal((await carol.post(`messages/${conv.id}/invites`)).status, 403);
  assert.equal((await carol.get(`messages/${conv.id}/invites`)).status, 403);

  const created = await alice.post(`messages/${conv.id}/invites`);
  assert.equal(created.status, 201);
  const { code, url } = created.body.invite;
  assert.equal(url, `/messages/join/${code}`);

  // Anyone signed in can join through the link; joining twice keeps one membership.
  const joined = await kevin.post(`messages/join/${code}`);
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal(joined.body.joined, true);
  assert.equal((await kevin.post(`messages/join/${code}`)).body.joined, false);
  assert.equal((await alice.get(`messages/${conv.id}`)).body.conversation.member_count, 4);

  // The link shows up in the active list, and stops working once revoked.
  const list = await alice.get(`messages/${conv.id}/invites`);
  assert.ok(list.body.items.some(i => i.code === code));
  assert.equal((await alice.del(`messages/${conv.id}/invites/${code}`)).status, 200);
  assert.equal((await kevin.post(`messages/join/${code}`)).status, 404);
  assert.equal((await kevin.post('messages/join/not-a-real-code')).status, 404);
  await markAllRead(conv, alice, bob, carol, kevin);
});

test('group chats: pinned messages', async () => {
  const conv = await groupChat(alice, ['bob', 'carol']);
  const ids = [];
  for (const body of ['first', 'second', 'third', 'fourth'])
    ids.push((await alice.post(`messages/${conv.id}`, { body })).body.message.id);

  // Members cannot pin.
  assert.equal((await bob.post(`messages/${conv.id}/pins`, { message_id: ids[0] })).status, 403);

  // The owner pins up to three messages.
  for (const id of ids.slice(0, 3)) assert.equal((await alice.post(`messages/${conv.id}/pins`, { message_id: id })).status, 201);
  const view = await bob.get(`messages/${conv.id}`);
  assert.deepEqual(view.body.pinned.map(m => m.id).sort(), ids.slice(0, 3).sort());

  // A fourth needs an unpin first.
  assert.equal((await alice.post(`messages/${conv.id}/pins`, { message_id: ids[3] })).status, 422);
  assert.equal((await bob.del(`messages/${conv.id}/pins/${ids[0]}`)).status, 403);
  const unpinned = await alice.del(`messages/${conv.id}/pins/${ids[0]}`);
  assert.equal(unpinned.status, 200);
  assert.deepEqual(unpinned.body.pinned.map(m => m.id).sort(), ids.slice(1, 3).sort());

  // A message from another conversation cannot be pinned here. (Carol, not Kevin: a buyer who
  // has messaged the seller can be marked sold, and marketplace.test needs Kevin to have done neither.)
  const other = await alice.post('messages', { handles: ['carol'], body: 'elsewhere' });
  assert.equal((await alice.post(`messages/${conv.id}/pins`, { message_id: other.body.message.id })).status, 404);
  await markAllRead(conv, alice, bob, carol);
  await markAllRead(other.body.conversation, alice, carol);
});

test('group chats: @mentions notify mentioned members only', async () => {
  const conv = await groupChat(alice, ['bob', 'carol']);
  const before = (await mentionNotes(kevin)).length;

  const sent = await alice.post(`messages/${conv.id}`, { body: 'hi @bob and @carol, not @kevin' });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.body.message.mentions.map(m => m.handle).sort(), ['bob', 'carol']);

  // Kevin is not in the chat, so his mention count is unchanged.
  assert.equal((await mentionNotes(kevin)).length, before);

  // Bob and Carol each got a mention notification that opens this chat.
  for (const [who, name] of [[bob, 'bob'], [carol, 'carol']]) {
    const note = (await mentionNotes(who)).find(n => n.link === `/messages/${conv.id}`);
    assert.ok(note, `a mention notification for ${name}`);
    assert.match(note.body, /mentioned you in/);
  }

  // The mention survives a reload and a poll.
  const view = await carol.get(`messages/${conv.id}`);
  assert.deepEqual(view.body.items.at(-1).mentions.map(m => m.handle).sort(), ['bob', 'carol']);
  const polled = await bob.get(`messages/${conv.id}/poll?after=`);
  assert.deepEqual(polled.body.items.at(-1).mentions.map(m => m.handle).sort(), ['bob', 'carol']);

  // Mentioning yourself does nothing.
  const self = await alice.post(`messages/${conv.id}`, { body: 'note to @alice' });
  assert.deepEqual(self.body.message.mentions, []);
  await markAllRead(conv, alice, bob, carol);
});
