import assert from 'node:assert/strict';
import { test } from 'node:test';
import { as } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol');

test('messages: 1:1 is reused, unread counts, read receipts', async () => {
  const first = await alice.post('messages', { handles: ['bob'], body: 'Hello Bob' });
  assert.ok([200, 201].includes(first.status));
  const id = first.body.conversation.id;
  const again = await alice.post('messages', { handles: ['bob'] });
  assert.equal(again.body.conversation.id, id, 'the 1:1 is reused');

  assert.ok((await bob.get('me')).body.unread.messages >= 1);
  const convo = await bob.get(`messages/${id}`);
  assert.equal(convo.body.items.at(-1).body, 'Hello Bob');
  await bob.post(`messages/${id}/read`);
  assert.equal((await bob.get('me')).body.unread.messages, 0);

  const reply = await bob.post(`messages/${id}`, { body: 'Hi Alice' });
  const polled = await alice.get(`messages/${id}/poll?after=${first.body.message?.id || ''}`);
  assert.ok(polled.body.items.some(m => m.id === reply.body.message.id));
  assert.equal((await carol.get(`messages/${id}`)).status >= 403, true, 'outsiders cannot read it');
});

test('messages: Southbag Support answers every message', async () => {
  const { body: { conversation } } = await carol.post('messages/support');
  const sent = await carol.post(`messages/${conversation.id}`, { body: 'Where is Kevin?' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.reply.sender, null);
  assert.ok(sent.body.reply.body.length > 0);
});
