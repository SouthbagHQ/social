import assert from 'node:assert/strict';
import { test } from 'node:test';
import { as } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol'), kevin = as('kevin');

async function makeServer(name = `Test server ${Date.now()}`) {
  const res = await alice.post('servers', { name, description: 'For tests.' });
  assert.equal(res.status, 201, res.text);
  const detail = (await alice.get(`servers/${res.body.server.id}`)).body;
  return { id: res.body.server.id, code: res.body.server.invite_code, general: res.body.channel_id, detail };
}

async function join(who, code) {
  const res = await who.post(`servers/join/${code}`);
  assert.equal(res.status, 200, res.text);
  return res.body;
}

test('servers: creation gives #general, @everyone and the owner every permission', async () => {
  const s = await makeServer('Book club');
  assert.equal(s.detail.channels.length, 1);
  assert.equal(s.detail.channels[0].name, 'general');
  assert.equal(s.detail.channels[0].id, s.general);
  assert.equal(s.detail.categories.length, 1);
  const everyone = s.detail.roles.find(r => r.is_everyone);
  assert.ok(everyone, 'has @everyone');
  assert.equal(everyone.name, '@everyone');
  assert.equal(everyone.id, s.id);
  assert.equal(s.detail.me.is_owner, true);
  assert.ok(Object.values(s.detail.me.permissions).every(Boolean));
  assert.equal(s.detail.server.member_count, 1);
  const list = await alice.get('servers');
  assert.ok(list.body.items.some(x => x.id === s.id));
  assert.equal((await bob.get(`servers/${s.id}`)).status, 404, 'outsiders cannot see it');
  assert.equal((await alice.post('servers', { name: '  ' })).status, 422);
});

test('servers: invites, joining and leaving', async () => {
  const s = await makeServer();
  const preview = await bob.get(`servers/invite/${s.code}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.is_member, false);
  const joined = await join(bob, s.code);
  assert.equal(joined.joined, true);
  assert.equal(joined.server.member_count, 2);
  assert.equal((await join(bob, s.code)).joined, false, 'joining twice is harmless');
  const bobView = await bob.get(`servers/${s.id}`);
  assert.equal(bobView.status, 200);
  assert.equal(bobView.body.me.permissions.manage_channels, false);
  assert.ok((await bob.get('servers')).body.items.some(x => x.id === s.id));

  // Only managers can rotate the invite; the old code stops working.
  assert.equal((await bob.post(`servers/${s.id}/invite`)).status, 403);
  const rotated = await alice.post(`servers/${s.id}/invite`);
  assert.notEqual(rotated.body.invite_code, s.code);
  assert.equal((await carol.post(`servers/join/${s.code}`)).status, 404);
  await join(carol, rotated.body.invite_code);

  assert.equal((await bob.post(`servers/${s.id}/leave`)).status, 200);
  assert.equal((await bob.get(`servers/${s.id}`)).status, 404);
  assert.equal((await alice.post(`servers/${s.id}/leave`)).status, 422, 'the owner cannot leave');
  const members = await alice.get(`servers/${s.id}/members`);
  assert.deepEqual(members.body.items.map(m => m.user.handle).sort(), ['alice', 'carol']);
});

test('servers: permissions for channels, roles, kicks and messages', async () => {
  const s = await makeServer();
  await join(bob, s.code);
  await join(carol, s.code);

  // Plain members can't manage anything.
  assert.equal((await bob.post(`servers/${s.id}/channels`, { name: 'random' })).status, 403);
  assert.equal((await bob.patch(`servers/${s.id}`, { name: 'Mine now' })).status, 403);
  assert.equal((await bob.post(`servers/${s.id}/roles`, { name: 'Boss', permissions: 127 })).status, 403);
  assert.equal((await bob.del(`servers/${s.id}/members/dev-carol`)).status, 403);
  assert.equal((await bob.put(`servers/${s.id}/bans/dev-carol`, {})).status, 403);

  // A moderator role: channels, kicks and messages.
  const role = await alice.post(`servers/${s.id}/roles`, { name: 'Moderators', permissions: { manage_channels: true, kick_members: true, manage_messages: true } });
  assert.equal(role.status, 201, role.text);
  assert.equal(role.body.role.position, 1);
  assert.equal((await alice.put(`servers/${s.id}/members/dev-bob/roles/${role.body.role.id}`)).status, 200);
  const bobDetail = (await bob.get(`servers/${s.id}`)).body;
  assert.equal(bobDetail.me.permissions.manage_channels, true);
  assert.equal(bobDetail.me.permissions.ban_members, false);

  const channel = await bob.post(`servers/${s.id}/channels`, { name: 'Book Talk!', topic: 'Books' });
  assert.equal(channel.status, 201);
  assert.equal(channel.body.channel.name, 'book-talk');
  const renamed = await bob.patch(`servers/${s.id}/channels/${channel.body.channel.id}`, { topic: 'Only books' });
  assert.equal(renamed.body.channel.topic, 'Only books');

  // Moderators can't grant what they don't have, or touch roles at or above their own.
  assert.equal((await bob.post(`servers/${s.id}/roles`, { name: 'x', permissions: { ban_members: true } })).status, 403);
  assert.equal((await bob.patch(`servers/${s.id}/roles/${role.body.role.id}`, { permissions: 127 })).status, 403);

  // Kicking needs a higher role; nobody outranks the owner.
  assert.equal((await bob.del(`servers/${s.id}/members/dev-alice`)).status, 403);
  const msg = await alice.post(`servers/${s.id}/channels/${s.general}/messages`, { body: 'Owner message' });
  assert.equal((await carol.del(`servers/${s.id}/channels/${s.general}/messages/${msg.body.message.id}`)).status, 403);
  assert.equal((await carol.put(`servers/${s.id}/channels/${s.general}/messages/${msg.body.message.id}/pin`)).status, 403);
  assert.equal((await bob.put(`servers/${s.id}/channels/${s.general}/messages/${msg.body.message.id}/pin`)).status, 200, 'manage_messages can pin');
  assert.equal((await bob.del(`servers/${s.id}/channels/${s.general}/messages/${msg.body.message.id}`)).status, 200, 'manage_messages can delete');
  assert.equal((await bob.del(`servers/${s.id}/members/dev-carol`)).status, 200);
  assert.equal((await carol.get(`servers/${s.id}`)).status, 404, 'kicked');
  await join(carol, s.code); // a kick is not a ban

  // Announcement channels are for moderators.
  const news = await alice.post(`servers/${s.id}/channels`, { name: 'news', kind: 'announcement' });
  assert.equal((await carol.post(`servers/${s.id}/channels/${news.body.channel.id}/messages`, { body: 'hi' })).status, 403);
  assert.equal((await bob.post(`servers/${s.id}/channels/${news.body.channel.id}/messages`, { body: 'Update' })).status, 201);

  // Deleting a channel needs manage_channels.
  assert.equal((await carol.del(`servers/${s.id}/channels/${channel.body.channel.id}`)).status, 403);
  assert.equal((await bob.del(`servers/${s.id}/channels/${channel.body.channel.id}`)).status, 200);
});

test('servers: messages send, edit, delete, pin, react, reply and page', async () => {
  const s = await makeServer();
  await join(bob, s.code);
  const base = `servers/${s.id}/channels/${s.general}`;

  const first = await alice.post(`${base}/messages`, { body: 'First message' });
  assert.equal(first.status, 201);
  const id = first.body.message.id;
  assert.equal(first.body.message.author.handle, 'alice');
  assert.equal((await alice.post(`${base}/messages`, { body: '' })).status, 422);
  assert.equal((await alice.post(`${base}/messages`, { body: 'x'.repeat(4001) })).status, 422);

  const reply = await bob.post(`${base}/messages`, { body: 'A reply', reply_to_id: id });
  assert.equal(reply.body.message.reply_to.id, id);
  assert.equal(reply.body.message.reply_to.author.handle, 'alice');

  assert.equal((await bob.patch(`${base}/messages/${id}`, { body: 'Hacked' })).status, 403, 'only the author edits');
  const edited = await alice.patch(`${base}/messages/${id}`, { body: 'First message, edited' });
  assert.equal(edited.body.message.body, 'First message, edited');
  assert.ok(edited.body.message.edited_at);

  const liked = await bob.put(`${base}/messages/${id}/reactions/like`);
  assert.deepEqual(liked.body.message.reactions, [{ reaction: 'like', count: 1, me: true }]);
  await alice.put(`${base}/messages/${id}/reactions/like`);
  const both = (await alice.get(`${base}/messages`)).body.items.find(m => m.id === id);
  assert.deepEqual(both.reactions, [{ reaction: 'like', count: 2, me: true }]);
  await bob.del(`${base}/messages/${id}/reactions/like`);
  assert.equal((await bob.put(`${base}/messages/${id}/reactions/bogus`)).status, 422);

  const pinned = await alice.put(`${base}/messages/${id}/pin`);
  assert.equal(pinned.body.message.pinned, true);
  const pins = await bob.get(`${base}/pins`);
  assert.deepEqual(pins.body.items.map(m => m.id), [id]);

  assert.equal((await bob.del(`${base}/messages/${id}`)).status, 403, 'no manage_messages');
  const own = await bob.del(`${base}/messages/${reply.body.message.id}`);
  assert.equal(own.status, 200, 'authors delete their own');

  // Paging newest-first.
  for (let i = 0; i < 4; i++) await alice.post(`${base}/messages`, { body: `Page ${i}` });
  const page1 = await bob.get(`${base}/messages?limit=2`);
  assert.deepEqual(page1.body.items.map(m => m.body), ['Page 3', 'Page 2']);
  const page2 = await bob.get(`${base}/messages?limit=2&before=${page1.body.next}`);
  assert.deepEqual(page2.body.items.map(m => m.body), ['Page 1', 'Page 0']);
  assert.ok(!page2.body.items.some(m => m.id === reply.body.message.id), 'deleted messages are gone');
});

test('servers: polling returns new, edited and deleted messages, typing and unread flags', async () => {
  const s = await makeServer();
  await join(bob, s.code);
  const base = `servers/${s.id}/channels/${s.general}`;
  const other = await alice.post(`servers/${s.id}/channels`, { name: 'other' });

  const start = await bob.get(`${base}/messages`);
  const since = start.body.now;
  const a = await alice.post(`${base}/messages`, { body: 'One' });
  const b = await alice.post(`${base}/messages`, { body: 'Two' });

  let poll = await bob.get(`${base}/poll?after=&since=${since}`);
  assert.equal(poll.status, 200);
  assert.deepEqual(poll.body.items.map(m => m.body), ['One', 'Two']);
  const after = poll.body.items.at(-1).id;

  await alice.patch(`${base}/messages/${a.body.message.id}`, { body: 'One, edited' });
  await alice.del(`${base}/messages/${b.body.message.id}`);
  await alice.post(`${base}/typing`);
  const c = await alice.post(`${base}/messages`, { body: 'Three' });
  await alice.post(`${base}/typing`);
  await alice.post(`servers/${s.id}/channels/${other.body.channel.id}/messages`, { body: 'Elsewhere' });

  poll = await bob.get(`${base}/poll?after=${after}&since=${poll.body.now}&read=1`);
  assert.deepEqual(poll.body.items.map(m => m.id), [c.body.message.id]);
  assert.ok(poll.body.updated.some(m => m.id === a.body.message.id && m.body === 'One, edited'));
  assert.ok(poll.body.deleted.includes(b.body.message.id));
  assert.deepEqual(poll.body.typing.map(t => t.handle), ['alice']);
  assert.ok(poll.body.online_count >= 1);
  const flags = Object.fromEntries(poll.body.channels.map(ch => [ch.id, ch.unread]));
  assert.equal(flags[s.general], false, 'read=1 marks the open channel read');
  assert.equal(flags[other.body.channel.id], true, 'other channels show unread');

  // Typing is not reported back to the typist, and the poll is members-only.
  const own = await alice.get(`${base}/poll?after=${c.body.message.id}&since=${Date.now()}`);
  assert.deepEqual(own.body.typing, []);
  assert.equal((await carol.get(`${base}/poll?after=`)).status, 404);

  await bob.post(`servers/${s.id}/channels/${other.body.channel.id}/read`);
  const list = await bob.get('servers');
  assert.equal(list.body.items.find(x => x.id === s.id).unread, false);
});

test('servers: mentions notify, @everyone needs permission', async () => {
  const s = await makeServer();
  await join(bob, s.code);
  await join(carol, s.code);
  const base = `servers/${s.id}/channels/${s.general}`;

  const before = (await bob.get('me')).body.unread.notifications;
  const m = await alice.post(`${base}/messages`, { body: 'Hey @bob, look' });
  assert.equal(m.status, 201);
  assert.equal((await bob.get('me')).body.unread.notifications, before + 1);
  const notes = await bob.get('notifications');
  const note = (notes.body.items || []).find(n => n.type === 'mention');
  assert.ok(note, 'mention notification');
  assert.match(note.body || '', /mentioned you in #general/);

  const detail = (await bob.get(`servers/${s.id}`)).body;
  assert.equal(detail.channels.find(c => c.id === s.general).mention_count, 1);

  const plain = await carol.post(`${base}/messages`, { body: '@everyone hello' });
  assert.equal(plain.body.message.mention_everyone, false, 'no permission, no ping');
  const loud = await alice.post(`${base}/messages`, { body: '@everyone meeting' });
  assert.equal(loud.body.message.mention_everyone, true);
  const bobDetail = (await bob.get(`servers/${s.id}`)).body;
  assert.equal(bobDetail.channels.find(c => c.id === s.general).mention_count, 2);
  const polled = await bob.get(`${base}/messages?limit=1`);
  assert.equal(polled.body.items[0].mentions_me, true);
});

test('servers: slowmode limits sends except for moderators', async () => {
  const s = await makeServer();
  await join(bob, s.code);
  const base = `servers/${s.id}/channels/${s.general}`;
  assert.equal((await bob.patch(`servers/${s.id}/channels/${s.general}`, { slowmode_seconds: 10 })).status, 403);
  const set = await alice.patch(`servers/${s.id}/channels/${s.general}`, { slowmode_seconds: 10 });
  assert.equal(set.body.channel.slowmode_seconds, 10);
  assert.equal((await bob.post(`${base}/messages`, { body: 'one' })).status, 201);
  const second = await bob.post(`${base}/messages`, { body: 'two' });
  assert.equal(second.status, 429);
  assert.match(second.body.error, /Slowmode/);
  assert.equal((await alice.post(`${base}/messages`, { body: 'a' })).status, 201);
  assert.equal((await alice.post(`${base}/messages`, { body: 'b' })).status, 201, 'owners are exempt');
});

test('servers: bans remove members and stop them rejoining', async () => {
  const s = await makeServer();
  await join(kevin, s.code);
  await join(bob, s.code);
  // A ban role for Bob; he still can't ban the owner.
  const role = await alice.post(`servers/${s.id}/roles`, { name: 'Bans', permissions: ['ban_members'] });
  await alice.put(`servers/${s.id}/members/dev-bob/roles/${role.body.role.id}`);
  assert.equal((await bob.put(`servers/${s.id}/bans/dev-alice`, {})).status, 403);

  assert.equal((await bob.put(`servers/${s.id}/bans/dev-kevin`, { reason: 'Spam' })).status, 200);
  assert.equal((await kevin.get(`servers/${s.id}`)).status, 404);
  const rejoin = await kevin.post(`servers/join/${s.code}`);
  assert.equal(rejoin.status, 403);
  assert.equal((await kevin.get(`servers/invite/${s.code}`)).body.banned, true);
  const bans = await alice.get(`servers/${s.id}/bans`);
  assert.deepEqual(bans.body.items.map(b => [b.user.handle, b.reason]), [['kevin', 'Spam']]);

  assert.equal((await alice.del(`servers/${s.id}/bans/dev-kevin`)).status, 200);
  assert.equal((await kevin.post(`servers/join/${s.code}`)).status, 200);

  // Deleting is for the owner only.
  assert.equal((await bob.del(`servers/${s.id}`)).status, 403);
  assert.equal((await alice.del(`servers/${s.id}`)).status, 200);
  assert.equal((await alice.get(`servers/${s.id}`)).status, 404);
});
