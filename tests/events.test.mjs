import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anon, as, BASE } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol'), kevin = as('kevin');
const HOUR = 3600e3, DAY = 24 * HOUR;
const soon = (offset = 3 * DAY, length = 2 * HOUR) => ({ starts_at: Date.now() + offset, ends_at: Date.now() + offset + length });
let n = 0;
const uniq = title => `${title} ${Date.now().toString(36)}${n++}`;

async function create(who, fields) {
  const res = await who.post('events', { ...soon(), timezone: 'Australia/Sydney', ...fields });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.event;
}

const ids = list => list.body.items.map(e => e.id);

async function befriend(a, aHandle, b, bHandle) {
  await a.put(`users/${bHandle}/friend`);
  await b.put(`users/${aHandle}/friend`);
}

test('events: creation and validation', async () => {
  assert.equal((await anon.get('events')).status, 200);
  assert.equal((await alice.post('events', { ...soon(), title: '' })).status, 422);
  assert.equal((await alice.post('events', { ...soon(), title: 'x'.repeat(101) })).status, 422);
  assert.equal((await alice.post('events', { ...soon(), title: 'Backwards', ends_at: Date.now() })).status, 422);
  assert.equal((await alice.post('events', { title: 'Too late', starts_at: Date.now() - DAY })).status, 422);
  assert.equal((await alice.post('events', { ...soon(), title: 'Bad link', online_url: 'javascript:alert(1)' })).status, 422);
  assert.equal((await alice.post('events', { ...soon(), title: 'No group', privacy: 'group' })).status, 422);
  assert.equal((await alice.post('events', { ...soon(), title: 'Bad zone', timezone: 'Mars/Olympus' })).status, 422);
  assert.equal((await alice.post('events', { ...soon(), title: 'Big', capacity: -3 })).status, 422);
  assert.equal((await alice.post('events', { ...soon(), title: 'Nobody', cohosts: ['nobody-at-all'] })).status, 404);

  const event = await create(alice, { title: uniq('Picnic'), description: 'Bring a plate.', location_name: 'Hyde Park', cohosts: ['kevin'] });
  assert.equal(event.going_count, 1, 'the host is going');
  assert.equal(event.viewer_rsvp, 'going');
  assert.equal(event.privacy, 'public');
  assert.equal(event.host.handle, 'alice');

  const detail = (await kevin.get(`events/${event.id}`)).body;
  assert.deepEqual(detail.event.hosts.map(h => h.handle), ['alice', 'kevin']);
  assert.equal(detail.viewer.role, 'cohost');
  assert.equal(detail.viewer.can_edit, true);
  assert.equal(detail.viewer.can_cancel, false);
  assert.equal((await kevin.patch(`events/${event.id}`, { title: 'Picnic (moved)' })).body.event.title, 'Picnic (moved)');
  assert.equal((await bob.patch(`events/${event.id}`, { title: 'Mine now' })).status, 403);
  assert.equal((await alice.patch(`events/${event.id}`, { ends_at: event.starts_at - 1 })).status, 422);
  assert.equal((await anon.get(`events/${event.id}`)).body.event.title, 'Picnic (moved)');
  assert.equal((await anon.get('events/nope')).status, 404);
});

test('events: listings per tab', async () => {
  const title = uniq('Listing');
  const event = await create(alice, { title });
  const later = await create(alice, { title: uniq('Later'), ...soon(5 * DAY) });
  const upcoming = await bob.get('events?tab=upcoming&limit=50');
  assert.ok(ids(upcoming).includes(event.id));
  const starts = upcoming.body.items.map(e => e.starts_at);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'soonest first');
  assert.ok(ids(await anon.get('events?limit=50')).includes(event.id));
  assert.ok(ids(await alice.get('events?tab=hosting&limit=50')).includes(event.id));
  assert.ok(!ids(await bob.get('events?tab=hosting&limit=50')).includes(event.id));
  assert.ok(!ids(await bob.get('events?tab=going&limit=50')).includes(event.id));
  await bob.put(`events/${event.id}/rsvp`, { status: 'going' });
  assert.ok(ids(await bob.get('events?tab=going&limit=50')).includes(event.id));

  // Paging by (starts_at, id).
  const first = await alice.get('events?tab=hosting&limit=1');
  assert.equal(first.body.items.length, 1);
  assert.ok(first.body.next);
  const second = await alice.get(`events?tab=hosting&limit=1&cursor=${first.body.next}`);
  assert.notEqual(second.body.items[0].id, first.body.items[0].id);
  assert.ok(second.body.items[0].starts_at >= first.body.items[0].starts_at);

  // Move one into the past.
  await alice.patch(`events/${later.id}`, { starts_at: Date.now() - 3 * HOUR, ends_at: Date.now() - 2 * HOUR });
  assert.ok(ids(await alice.get('events?tab=past&limit=50')).includes(later.id));
  assert.ok(!ids(await alice.get('events?tab=hosting&limit=50')).includes(later.id));
  assert.ok(!ids(await bob.get('events?limit=50')).includes(later.id));
  assert.equal((await bob.put(`events/${later.id}/rsvp`, { status: 'going' })).status, 409, 'ended');
  assert.deepEqual((await anon.get('events?tab=going')).body.items, []);
});

test('events: rsvp transitions and counts', async () => {
  const event = await create(alice, { title: uniq('Counts') });
  const put = async (who, status) => (await who.put(`events/${event.id}/rsvp`, { status })).body;
  assert.equal((await bob.put(`events/${event.id}/rsvp`, { status: 'maybe' })).status, 422);
  assert.deepEqual(await put(bob, 'going'), { rsvp: 'going', going_count: 2, interested_count: 0 });
  assert.deepEqual(await put(bob, 'going'), { rsvp: 'going', going_count: 2, interested_count: 0 }, 'idempotent');
  assert.deepEqual(await put(bob, 'interested'), { rsvp: 'interested', going_count: 1, interested_count: 1 });
  assert.deepEqual(await put(carol, 'interested'), { rsvp: 'interested', going_count: 1, interested_count: 2 });
  assert.deepEqual(await put(bob, 'declined'), { rsvp: 'declined', going_count: 1, interested_count: 1 });
  assert.equal((await bob.get(`events/${event.id}`)).body.viewer.rsvp, 'declined');
  assert.deepEqual((await bob.del(`events/${event.id}/rsvp`)).body, { rsvp: null, going_count: 1, interested_count: 1 });

  const interested = (await anon.get(`events/${event.id}/attendees?status=interested`)).body.items;
  assert.deepEqual(interested.map(a => a.user.handle), ['carol']);
  assert.equal((await carol.get(`events/${event.id}/attendees?status=declined`)).status, 403);
  assert.equal((await alice.get(`events/${event.id}/attendees?status=declined`)).status, 200);
  assert.deepEqual((await carol.get(`events/${event.id}`)).body.event.attendees.map(a => a.handle), ['alice']);
});

test('events: capacity', async () => {
  const event = await create(alice, { title: uniq('Small room'), capacity: 2 });
  assert.equal((await bob.put(`events/${event.id}/rsvp`, { status: 'going' })).status, 200);
  const full = await carol.put(`events/${event.id}/rsvp`, { status: 'going' });
  assert.equal(full.status, 409);
  assert.equal(full.body.error, 'This event is full.');
  assert.equal((await carol.put(`events/${event.id}/rsvp`, { status: 'interested' })).status, 200);
  assert.equal((await carol.get(`events/${event.id}`)).body.event.is_full, true);
  assert.equal((await bob.put(`events/${event.id}/rsvp`, { status: 'going' })).status, 200, 'already going is fine when full');
  await bob.put(`events/${event.id}/rsvp`, { status: 'interested' });
  assert.equal((await carol.put(`events/${event.id}/rsvp`, { status: 'going' })).body.going_count, 2);
  assert.equal((await alice.patch(`events/${event.id}`, { capacity: null })).body.event.capacity, null);
  assert.equal((await bob.put(`events/${event.id}/rsvp`, { status: 'going' })).body.going_count, 3);
});

test('events: friends-only, group-only and invite-only privacy, and blocks', async () => {
  await befriend(alice, 'alice', bob, 'bob');
  await carol.del('users/alice/friend');

  const friends = await create(alice, { title: uniq('Friends only'), privacy: 'friends' });
  assert.equal((await bob.get(`events/${friends.id}`)).status, 200);
  assert.equal((await carol.get(`events/${friends.id}`)).status, 404);
  assert.equal((await anon.get(`events/${friends.id}`)).status, 404);
  assert.ok(ids(await bob.get('events?limit=50')).includes(friends.id));
  assert.ok(!ids(await carol.get('events?limit=50')).includes(friends.id));
  assert.equal((await carol.put(`events/${friends.id}/rsvp`, { status: 'going' })).status, 404);
  assert.equal((await bob.post(`events/${friends.id}/invite`, { handles: ['carol'] })).status, 403, 'only hosts invite to friends-only events');

  const { body: { group } } = await alice.post('groups', { name: uniq('Event test group'), description: '', privacy: 'public' });
  await kevin.post(`groups/${group.slug}/join`);
  const groupOnly = await create(alice, { title: uniq('Members only'), privacy: 'group', group_id: group.id });
  assert.equal(groupOnly.group.slug, group.slug);
  assert.equal((await kevin.get(`events/${groupOnly.id}`)).status, 200);
  assert.equal((await carol.get(`events/${groupOnly.id}`)).status, 404);
  assert.equal((await bob.get(`events/${groupOnly.id}`)).status, 404, 'friendship does not open group events');
  assert.ok(ids(await kevin.get(`events?group=${group.slug}`)).includes(groupOnly.id));
  assert.deepEqual(ids(await carol.get(`events?group=${group.slug}`)), []);
  assert.equal((await carol.post('events', { ...soon(), title: 'Not a member', group_id: group.id })).status, 403);

  const { body: { group: closed } } = await alice.post('groups', { name: uniq('Private event group'), description: '', privacy: 'private' });
  const coerced = await create(alice, { title: uniq('Private group public'), privacy: 'public', group_id: closed.id });
  assert.equal(coerced.privacy, 'group', 'a private group cannot host public events');
  assert.equal((await anon.get(`events/${coerced.id}`)).status, 404);

  const invite = await create(alice, { title: uniq('Invite only'), privacy: 'invite' });
  assert.equal((await bob.get(`events/${invite.id}`)).status, 404);
  assert.equal((await carol.get(`events/${invite.id}`)).status, 404);
  assert.equal((await alice.post(`events/${invite.id}/invite`, { handles: ['nobody-at-all'] })).status, 404);
  assert.deepEqual((await alice.post(`events/${invite.id}/invite`, { handles: ['@carol'] })).body, { invited: ['carol'], already: [] });
  assert.deepEqual((await alice.post(`events/${invite.id}/invite`, { handles: ['carol'] })).body, { invited: [], already: ['carol'] });
  const seen = await carol.get(`events/${invite.id}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.viewer.invited, true);
  assert.ok(ids(await carol.get('events?limit=50')).includes(invite.id));
  const notes = (await carol.get('notifications')).body.items;
  assert.ok(notes.some(x => x.type === 'event_invite' && x.body.includes(invite.title) && x.actor.handle === 'alice'));
  assert.equal((await bob.get(`events/${invite.id}`)).status, 404, 'still hidden from others');

  // Blocks hide events both ways.
  const open = await create(alice, { title: uniq('Open to all') });
  await carol.put('users/alice/block');
  assert.equal((await carol.get(`events/${open.id}`)).status, 404);
  assert.ok(!ids(await carol.get('events?limit=50')).includes(open.id));
  await carol.del('users/alice/block');
  assert.equal((await carol.get(`events/${open.id}`)).status, 200);

  // Unfriending closes the friends-only event again (and leaves other test files a clean graph).
  await alice.del('users/bob/friend');
  assert.equal((await bob.get(`events/${friends.id}`)).status, 404);
});

test('events: cancelling keeps the page and tells attendees', async () => {
  const event = await create(alice, { title: uniq('Cancelled soon') });
  await bob.put(`events/${event.id}/rsvp`, { status: 'going' });
  await carol.put(`events/${event.id}/rsvp`, { status: 'interested' });
  assert.equal((await bob.del(`events/${event.id}`)).status, 403);
  const res = await alice.del(`events/${event.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.event.cancelled, true);
  const page = await bob.get(`events/${event.id}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.event.cancelled, true);
  assert.equal(page.body.viewer.can_edit, false);
  assert.equal((await bob.put(`events/${event.id}/rsvp`, { status: 'interested' })).status, 409);
  assert.equal((await alice.patch(`events/${event.id}`, { title: 'Back on' })).status, 409);
  assert.ok(!ids(await bob.get('events?limit=50')).includes(event.id), 'not in upcoming');
  assert.ok(ids(await bob.get('events?tab=going&limit=50')).includes(event.id), 'still in going');
  for (const who of [bob, carol]) {
    const notes = (await who.get('notifications')).body.items;
    assert.ok(notes.some(x => x.type === 'event_cancelled' && x.body.includes(event.title)));
  }
});

test('events: discussion', async () => {
  const event = await create(alice, { title: uniq('Discussion') });
  assert.equal((await bob.post(`events/${event.id}/comments`, { body: '   ' })).status, 422);
  assert.equal((await bob.post(`events/${event.id}/comments`, { body: 'x'.repeat(2001) })).status, 422);
  const { status, body: { comment } } = await bob.post(`events/${event.id}/comments`, { body: 'Is there parking?' });
  assert.equal(status, 201);
  assert.equal(comment.author.handle, 'bob');
  await carol.post(`events/${event.id}/comments`, { body: 'Following.' });
  const list = (await anon.get(`events/${event.id}/comments`)).body.items;
  assert.deepEqual(list.map(c => c.body), ['Following.', 'Is there parking?'], 'newest first');
  assert.equal((await carol.del(`events/${event.id}/comments/${comment.id}`)).status, 403);
  assert.equal((await alice.del(`events/${event.id}/comments/${comment.id}`)).status, 200, 'hosts can remove comments');
  assert.equal((await anon.get(`events/${event.id}`)).body.event.comment_count, 1);
  assert.ok((await alice.get('notifications')).body.items.some(x => x.type === 'event_comment' && x.body.includes(event.title)));
  assert.equal((await as('nobody').post(`events/${event.id}/comments`, { body: 'Hi' })).status, 401);
});

test('events: calendar file', async () => {
  const event = await create(alice, {
    title: uniq('Trivia, night; round 2'), description: 'Line one\nLine two', location_name: 'The Hall', location_address: '1 Main St',
    starts_at: Date.UTC(2031, 0, 2, 9, 30), ends_at: Date.UTC(2031, 0, 2, 11, 0),
  });
  const res = await fetch(`${BASE}/api/events/${event.id}/calendar.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/calendar/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename=".+\.ics"/);
  const text = await res.text();
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(text.includes('\r\nDTSTART:20310102T093000Z\r\n'));
  assert.ok(text.includes('\r\nDTEND:20310102T110000Z\r\n'));
  assert.ok(text.includes(`SUMMARY:${event.title.replace(',', '\\,').replace(';', '\\;')}`));
  assert.ok(text.includes('LOCATION:The Hall\\, 1 Main St'));
  assert.ok(text.includes('DESCRIPTION:Line one\\nLine two'));
  assert.ok(text.includes(`UID:${event.id}@`));
  assert.ok(text.split('\r\n').every(line => new TextEncoder().encode(line).length <= 75), 'lines are folded');

  const secret = await create(alice, { title: uniq('Secret'), privacy: 'invite' });
  assert.equal((await fetch(`${BASE}/api/events/${secret.id}/calendar.ics`)).status, 404);
  assert.equal((await alice.get(`events/${secret.id}/calendar.ics`)).status, 200);
});

test('events: reminders go to people going, once', async () => {
  const soonEvent = await create(alice, { title: uniq('Starting soon'), ...soon(2 * HOUR) });
  const laterEvent = await create(alice, { title: uniq('Next week'), ...soon(6 * DAY) });
  const cancelled = await create(alice, { title: uniq('Called off'), ...soon(3 * HOUR) });
  await bob.put(`events/${soonEvent.id}/rsvp`, { status: 'going' });
  await carol.put(`events/${soonEvent.id}/rsvp`, { status: 'interested' });
  await bob.put(`events/${laterEvent.id}/rsvp`, { status: 'going' });
  await bob.put(`events/${cancelled.id}/rsvp`, { status: 'going' });
  await alice.del(`events/${cancelled.id}`);

  const run = await bob.post('events/_reminders');
  assert.equal(run.status, 200);
  assert.ok(run.body.sent >= 2, 'bob and the host');
  const reminders = async who => (await who.get('notifications?limit=50')).body.items.filter(x => x.type === 'event_reminder');
  const mine = await reminders(bob);
  assert.equal(mine.filter(x => x.body.includes(soonEvent.title)).length, 1);
  assert.ok(mine.find(x => x.body.includes(soonEvent.title)).body.startsWith('Reminder: '));
  assert.equal(mine.filter(x => x.body.includes(laterEvent.title) || x.body.includes(cancelled.title)).length, 0);
  assert.equal((await reminders(carol)).filter(x => x.body.includes(soonEvent.title)).length, 0, 'interested is not going');
  assert.equal((await reminders(alice)).filter(x => x.body.includes(soonEvent.title)).length, 1, 'the host is going');

  await bob.post('events/_reminders');
  assert.equal((await reminders(bob)).filter(x => x.body.includes(soonEvent.title)).length, 1, 'only once');

  // Moving the start time re-arms the reminder.
  await alice.patch(`events/${soonEvent.id}`, soon(4 * HOUR));
  await bob.post('events/_reminders');
  assert.equal((await reminders(bob)).filter(x => x.body.includes(soonEvent.title)).length, 2);
});
