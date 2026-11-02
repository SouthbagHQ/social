import assert from 'node:assert/strict';
import { test } from 'node:test';
import { as } from './helpers.mjs';

// The account-level freeze comes from the mock Identity server (scripts/mock-identity.mjs):
// dev-erin is frozen, dev-frank's status check fails (unknown), everyone else is active.
const erin = as('erin'), frank = as('frank'), alice = as('alice');

test('a frozen account is blocked entirely, reads included', async () => {
  const read = await erin.get('me');
  assert.equal(read.status, 423);
  assert.match(read.body.error, /identity\.southbag\.cc\/unfreeze/);
  const write = await erin.post('posts', { body: 'hello' });
  assert.equal(write.status, 423);
});

test('status unknown (Identity down): EVERYTHING fails closed, reads included', async () => {
  const read = await frank.get('me');
  assert.equal(read.status, 503);
  assert.match(read.body.error, /unavailable/);
  const write = await frank.post('posts', { body: 'hello' });
  assert.equal(write.status, 503);
  assert.match(write.body.error, /unavailable/);
});

test('active accounts are unaffected', async () => {
  assert.equal((await alice.get('me')).status, 200);
  const { status } = await alice.post('posts', { body: 'Freeze test post.' });
  assert.equal(status, 201);
});
