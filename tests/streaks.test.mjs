import assert from 'node:assert/strict';
import { test } from 'node:test';
import { as } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol'), kevin = as('kevin');
const HOUR = 3600e3, DAY = 24 * HOUR;

// The localhost-only test hook: runs the same streak upsert a one-to-one message does, at any moment.
const hook = (who, input) => who.post('streaks/_test', input).then(r => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
});
const tick = (who, handle, now) => hook(who, { op: 'tick', handle, now });
const reset = (who, handle) => hook(who, { op: 'reset', handle });
const row = async (who, handle) => (await hook(who, { op: 'row', handle })).row;

/** A moment on a Sydney calendar day. Days in June are AEST (UTC+10), days in January AEDT (UTC+11). */
const sydney = (day, hour = 12, minute = 0, second = 0) => {
  const offset = Number(day.slice(5, 7)) >= 4 && Number(day.slice(5, 7)) <= 9 ? 10 : 11; // close enough away from the switch-over weeks
  return Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), hour - offset, minute, second);
};

test('streaks: Sydney calendar days', async () => {
  const day = now => hook(alice, { op: 'day', now });
  // AEST (UTC+10): 13:59:59Z is 11:59:59 pm on the 1st, 14:00Z is midnight on the 2nd.
  assert.equal((await day(Date.parse('2026-10-01T13:59:59Z'))).day, '2026-10-01');
  assert.equal((await day(Date.parse('2026-10-01T14:00:00Z'))).day, '2026-10-02');
  // AEDT (UTC+11) in summer.
  assert.equal((await day(Date.parse('2026-01-15T12:59:59Z'))).day, '2026-01-15');
  assert.equal((await day(Date.parse('2026-01-15T13:00:00Z'))).day, '2026-01-16');
  // Across daylight saving starting (Sunday 4 October 2026, 2 am -> 3 am).
  assert.equal((await day(Date.parse('2026-10-04T12:59:59Z'))).day, '2026-10-04');
  assert.equal((await day(Date.parse('2026-10-04T13:00:00Z'))).day, '2026-10-05');
  assert.equal((await day(Date.parse('2026-10-01T08:00:00Z'))).hour, 18);
  assert.equal((await day(Date.parse('2026-10-01T14:00:00Z'))).hour, 0);
});

test('streaks: both people, every day', async () => {
  await reset(carol, 'kevin');

  // One-sided messages don't count, however many.
  let r = await tick(carol, 'kevin', sydney('2001-06-01', 9));
  assert.equal(r.streak, null);
  r = await tick(carol, 'kevin', sydney('2001-06-01', 10));
  assert.equal(r.streak, null);

  // Both on the same day: 1, and the message that completes it says so (once).
  r = await tick(kevin, 'carol', sydney('2001-06-01', 22));
  assert.equal(r.day, '2001-06-01');
  assert.equal(r.streak.current, 1);
  assert.equal(r.streak.extended, true);
  assert.equal(r.streak.completed_today, true);
  r = await tick(kevin, 'carol', sydney('2001-06-01', 23));
  assert.equal(r.streak.current, 1);
  assert.equal(r.streak.extended, false, 'only the completing message extends');
  assert.equal(r.row.started_day, '2001-06-01');

  // Next day: at risk until both have sent, then 2; and 3 the day after.
  r = await tick(kevin, 'carol', sydney('2001-06-02', 8));
  assert.equal(r.streak.current, 1);
  assert.equal(r.streak.at_risk, true);
  assert.equal(r.streak.extended, false);
  r = await tick(carol, 'kevin', sydney('2001-06-02', 20));
  assert.equal(r.streak.current, 2);
  assert.equal(r.streak.at_risk, false);
  assert.equal(r.streak.extended, true);
  await tick(carol, 'kevin', sydney('2001-06-03', 7));
  r = await tick(kevin, 'carol', sydney('2001-06-03', 7, 30));
  assert.equal(r.streak.current, 3);
  assert.equal(r.streak.longest, 3);

  // A missed day (the 4th) resets it, but longest stays.
  r = await tick(carol, 'kevin', sydney('2001-06-05', 12));
  assert.equal(r.streak, null, 'the streak ran out at midnight on the 4th');
  r = await tick(kevin, 'carol', sydney('2001-06-05', 13));
  assert.equal(r.streak.current, 1);
  assert.equal(r.streak.longest, 3);
  assert.equal(r.row.started_day, '2001-06-05');

  // A message at 11:59:59 pm and a reply at midnight are on different days.
  await tick(carol, 'kevin', sydney('2001-06-06', 23, 59, 59));
  r = await tick(kevin, 'carol', sydney('2001-06-06', 24, 0, 0));
  assert.equal(r.day, '2001-06-07');
  assert.equal(r.streak, null, 'the 6th never completed');
  r = await tick(carol, 'kevin', sydney('2001-06-07', 0, 30));
  assert.equal(r.streak.current, 1, 'the 7th completed, but the 6th broke the run');
  assert.equal(r.streak.longest, 3);

  // Summer time: 11:30 pm AEDT on 15 January is 12:30 pm UTC, still the 15th in Sydney.
  await reset(carol, 'kevin');
  await tick(carol, 'kevin', Date.parse('2002-01-15T12:30:00Z'));
  r = await tick(kevin, 'carol', Date.parse('2002-01-15T12:59:00Z'));
  assert.equal(r.day, '2002-01-15');
  assert.equal(r.streak.current, 1);
  await tick(carol, 'kevin', Date.parse('2002-01-15T13:01:00Z'));
  r = await tick(kevin, 'carol', Date.parse('2002-01-16T12:00:00Z'));
  assert.equal(r.day, '2002-01-16');
  assert.equal(r.streak.current, 2);

  // An old message arriving late (clock skew) never moves the sender's day backwards.
  r = await tick(kevin, 'carol', Date.parse('2002-01-14T12:00:00Z'));
  assert.equal(r.row.current, 2);
  assert.equal((await row(carol, 'kevin')).current, 2);
});

test('streaks: real messages in one-to-ones, not groups or Support', async () => {
  await reset(alice, 'carol');
  const start = await alice.post('messages', { handles: ['carol'], body: 'Morning' });
  const id = start.body.conversation.id;
  assert.equal(start.body.conversation.is_group, false);

  const one = await alice.post(`messages/${id}`, { body: 'Still there?' });
  assert.equal(one.status, 201);
  assert.ok('streak' in one.body, 'one-to-one sends report the streak');
  assert.equal(one.body.streak, null, 'one-sided');

  const two = await carol.post(`messages/${id}`, { body: 'Yes' });
  assert.equal(two.body.streak.current, 1);
  assert.equal(two.body.streak.extended, true);
  assert.equal(two.body.streak.at_risk, false);
  const three = await carol.post(`messages/${id}`, { body: 'Again' });
  assert.equal(three.body.streak.current, 1);
  assert.equal(three.body.streak.extended, false);

  // Conversation list, conversation and poll payloads.
  const list = await alice.get('messages?limit=50');
  const item = list.body.items.find(i => i.id === id);
  assert.equal(item.streak.current, 1);
  assert.equal(item.streak.at_risk, false);
  assert.ok(list.body.items.filter(i => i.is_group || i.is_support).every(i => i.streak === null));
  assert.equal((await alice.get(`messages/${id}`)).body.conversation.streak.current, 1);
  assert.equal((await alice.get(`messages/${id}/poll?after=${three.body.message.id}`)).body.streak.current, 1);

  // GET /api/streaks and /with/:handle.
  const mine = await alice.get('streaks');
  assert.equal(mine.status, 200);
  const withCarol = mine.body.items.find(s => s.user.handle === 'carol');
  assert.equal(withCarol.current, 1);
  assert.equal(withCarol.conversation_id, id);
  assert.equal(withCarol.at_risk, false);
  const one2one = await carol.get('streaks/with/alice');
  assert.equal(one2one.body.current, 1);
  assert.equal(one2one.body.user.handle, 'alice');
  assert.equal(one2one.body.conversation_id, id);
  assert.equal((await carol.get('streaks/with/nobody-at-all')).status, 404);

  // Group chats don't count.
  await reset(bob, 'carol');
  const group = await bob.post('messages', { handles: ['carol', 'kevin'], body: 'Group hello' });
  assert.equal(group.body.conversation.is_group, true);
  assert.equal(group.body.conversation.streak, null);
  const g1 = await carol.post(`messages/${group.body.conversation.id}`, { body: 'Hi all' });
  assert.equal('streak' in g1.body, false);
  await bob.post(`messages/${group.body.conversation.id}`, { body: 'Hi again' });
  assert.equal(await row(bob, 'carol'), null, 'no streak row from a group chat');
  assert.equal((await bob.get('streaks/with/carol')).body.current, 0);

  // Nor does Southbag Support.
  const { body: { conversation: support } } = await carol.post('messages/support');
  assert.equal(support.streak, null);
  const s1 = await carol.post(`messages/${support.id}`, { body: 'Hello' });
  assert.equal('streak' in s1.body, false);
});

test('streaks: list is sorted and at risk until today counts', async () => {
  await reset(alice, 'kevin');
  const now = Date.now();
  for (const at of [now - 3 * DAY, now - 2 * DAY, now - DAY]) {
    await tick(alice, 'kevin', at);
    await tick(kevin, 'alice', at);
  }
  const { body } = await alice.get('streaks');
  const k = body.items.find(s => s.user.handle === 'kevin');
  assert.equal(k.current, 3);
  assert.equal(k.at_risk, true, 'yesterday counted, today has not yet');
  assert.equal(k.completed_today, false);
  const currents = body.items.map(s => s.current);
  assert.deepEqual(currents, [...currents].sort((a, b) => b - a));
  // Alice messages today: still at risk until Kevin does too.
  await tick(alice, 'kevin', now);
  assert.equal((await alice.get('streaks/with/kevin')).body.at_risk, true);
  await tick(kevin, 'alice', now);
  const after = (await alice.get('streaks/with/kevin')).body;
  assert.equal(after.current, 4);
  assert.equal(after.at_risk, false);
});

// Runs the cron at made-up moments in 2099, so it goes last (it zeroes every streak older than that).
test('streaks: cron warns once a day after 6 pm, and resets lost streaks', async () => {
  await reset(bob, 'kevin');
  const conv = (await bob.post('messages', { handles: ['kevin'] })).body.conversation;
  for (const day of ['2099-06-01', '2099-06-02', '2099-06-03']) {
    await tick(bob, 'kevin', sydney(day, 10));
    await tick(kevin, 'bob', sydney(day, 11));
  }
  // Kevin has messaged on the 4th, Bob hasn't.
  await tick(kevin, 'bob', sydney('2099-06-04', 9));

  const early = await hook(bob, { op: 'cron', now: sydney('2099-06-04', 17, 30) });
  assert.equal(early.warned, 0, 'not before 6 pm');
  const evening = await hook(bob, { op: 'cron', now: sydney('2099-06-04', 18, 5) });
  assert.equal(evening.warned, 1, 'only the person who has not messaged today');
  assert.equal((await row(bob, 'kevin')).warned_day, '2099-06-04');
  const later = await hook(bob, { op: 'cron', now: sydney('2099-06-04', 21) });
  assert.equal(later.warned, 0, 'once per day');

  const notes = (await bob.get('notifications?limit=50')).body.items;
  const warning = notes.find(n => n.body === 'Your 3 day streak with Kevin Southbag ends at midnight.');
  assert.ok(warning, JSON.stringify(notes.slice(0, 3)));
  assert.equal(warning.link, `/messages/${conv.id}`);
  assert.equal(warning.actor.handle, 'kevin');
  assert.ok(!(await kevin.get('notifications?limit=50')).body.items.some(n => /day streak with Bob/.test(n.body || '')),
    'Kevin already messaged today');

  // Under 3 days: no warning.
  await reset(alice, 'bob');
  for (const day of ['2099-06-02', '2099-06-03']) { await tick(alice, 'bob', sydney(day)); await tick(bob, 'alice', sydney(day)); }
  assert.equal((await hook(bob, { op: 'cron', now: sydney('2099-06-04', 22) })).warned, 0);

  // The 4th never completed: on the 5th the streak is lost and zeroed, longest kept.
  const next = await hook(bob, { op: 'cron', now: sydney('2099-06-05', 1) });
  assert.ok(next.lost >= 1);
  const lost = await row(bob, 'kevin');
  assert.equal(lost.current, 0);
  assert.equal(lost.longest, 3);
  assert.equal((await bob.get('streaks/with/kevin')).body.current, 0);
});
