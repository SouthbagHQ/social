import assert from 'node:assert/strict';
import { test } from 'node:test';
import { as } from './helpers.mjs';

// The tests run with BANKING_DEV=1 (scripts/test.sh): a stand-in bank with $5,000 and no fees.
const alice = as('alice'), bob = as('bob'), carol = as('carol');
const NO_DELETING = "Deletion isn't available. Kevin knows what you did.";

test('payments: sending money shows up for both people, in their chat and notifications', async () => {
  const sent = await alice.post('payments', { to: '@bob', amount: 1234, note: 'Garlic bread' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message, 'Sent $12.34 to @bob.');
  assert.equal(sent.body.payment.amount, 1234);
  assert.equal(sent.body.payment.user.handle, 'bob');
  const { id } = sent.body.payment;

  const mine = (await alice.get('payments')).body.items.find(p => p.id === id);
  assert.equal(mine.direction, 'sent');
  assert.equal(mine.user.handle, 'bob');
  assert.equal(mine.note, 'Garlic bread');
  const theirs = (await bob.get('payments')).body.items.find(p => p.id === id);
  assert.equal(theirs.direction, 'received');
  assert.equal(theirs.user.handle, 'alice');
  assert.equal(theirs.fees, 0, 'recipients never see the fees');

  const chat = (await bob.get(`messages/${sent.body.conversation_id}`)).body;
  const last = chat.items.at(-1);
  assert.equal(last.sender.handle, 'alice');
  assert.equal(last.body, 'Garlic bread');
  const bobId = (await bob.get('me')).body.user.id;
  assert.deepEqual({ amount: last.payment.amount, recipient: last.payment.recipient_id }, { amount: 1234, recipient: bobId });
  const listed = (await bob.get('messages')).body.items.find(cv => cv.id === sent.body.conversation_id);
  assert.equal(listed.last_message.kind, 'payment');
  assert.equal(listed.unread, true);

  const note = (await bob.get('notifications')).body.items.find(n => n.type === 'payment');
  assert.equal(note.body, 'Alice Southbag sent you $12.34.');
  assert.equal(note.link, '/payments');

  // Paying again reuses the same conversation.
  const again = await alice.post('payments', { to: 'bob', amount: 1 });
  assert.equal(again.body.conversation_id, sent.body.conversation_id);
  assert.equal(again.body.payment.note, '');
});

test('payments: amounts, people and blocks are checked; the bank can refuse', async () => {
  for (const amount of [0, -5, 1.5, 1000001, 'ten']) assert.equal((await alice.post('payments', { to: 'bob', amount })).status, 422, `amount ${amount}`);
  assert.equal((await alice.post('payments', { to: 'alice', amount: 100 })).status, 422);
  assert.equal((await alice.post('payments', { to: 'nobody-here', amount: 100 })).status, 404);
  assert.equal((await alice.post('payments', { amount: 100 })).status, 422);
  assert.equal((await as('nobody').post('payments', { to: 'bob', amount: 100 })).status, 401);

  const before = (await alice.get('payments')).body.items.length;
  const refused = await alice.post('payments', { to: 'bob', amount: 600000 });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /^Need /);
  assert.equal((await alice.get('payments')).body.items.length, before, 'nothing recorded');

  await carol.put('users/alice/block');
  assert.equal((await alice.post('payments', { to: 'carol', amount: 100 })).body.error, '@carol is not accepting payments from you.');
  assert.equal((await carol.post('payments', { to: 'alice', amount: 100 })).body.error, 'You blocked @alice. Unblock them first.');
  await carol.del('users/alice/block');
});

test('payments: the balance comes from the bank, and payments are never deleted', async () => {
  const { account } = (await alice.get('payments/account')).body;
  assert.equal(account.balance, 500000);
  const [latest] = (await alice.get('payments')).body.items;
  const del = await alice.del(`payments/${latest.id}`);
  assert.equal(del.status, 403);
  assert.deepEqual(del.body, { error: NO_DELETING });
});
