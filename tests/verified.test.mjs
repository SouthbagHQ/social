import assert from 'node:assert/strict';
import { test } from 'node:test';
import { as } from './helpers.mjs';

// The tests run with BANKING_DEV=1 (scripts/test.sh), so charges succeed without a bank.
const carol = as('carol');
const DAY = 86400000;

test('verified: subscribing charges Southbag Online Banking straight away, once', async () => {
  const sub = await carol.post('users/me/verify');
  assert.equal(sub.status, 200);
  assert.equal(sub.body.verified, true);
  assert.equal(sub.body.charged, 800);
  assert.equal(sub.body.message, 'Subscribed. $8.00 was taken from your Southbag Online Banking account.');
  assert.equal((await carol.get('me')).body.user.verified, true);
  const notes = (await carol.get('notifications')).body.items;
  assert.ok(notes.some(n => n.body === 'Your Southbag Verified subscription is active. $8.00 was taken from your Southbag Online Banking account.'));

  const again = await carol.post('users/me/verify');
  assert.equal(again.body.charged, 0, 'no second charge');
  assert.equal(again.body.message, 'You are already subscribed.');
});

test('verified: renewals charge every 30 days, and stop when cancelled', async () => {
  const before = Date.now();
  const renewed = await carol.post('users/me/verify/_renew');
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.verified, true);
  assert.ok(renewed.body.renews_at >= before + 29 * DAY, 'next charge is about 30 days out');
  const notes = (await carol.get('notifications')).body.items;
  assert.ok(notes.some(n => n.body === 'Southbag Verified renewed. $8.00 was taken from your Southbag Online Banking account.'));

  const cancelled = await carol.del('users/me/verify');
  assert.equal(cancelled.status, 200, 'cancelling is not deleting');
  assert.equal(cancelled.body.verified, false);
  assert.equal((await carol.get('me')).body.user.verified, false);
  assert.equal((await carol.del('users/me/verify')).status, 409);
  const after = await carol.post('users/me/verify/_renew');
  assert.deepEqual(after.body, { verified: false, renews_at: null }, 'nothing renews after cancelling');
});

test('verified: the renewal hook is for localhost only, and needs a session', async () => {
  assert.equal((await as('nobody').post('users/me/verify/_renew')).status, 401);
});
