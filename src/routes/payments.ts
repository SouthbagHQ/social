// Payments between people, paid out of Southbag Online Banking (lib/banking.ts). Mounted at /api/payments.
//
//   GET  /api/payments/account        -> { account: { balance, account_number, status, transactions } | null }
//   GET  /api/payments?cursor&limit   -> { items: [PaymentJson], next }   sent and received, newest first
//   POST /api/payments                { to: handle, amount: cents, note? } -> { payment, conversation_id, balance, message }
//
// PaymentJson: { id, direction: 'sent' | 'received', user: UserCard (the other person), amount, fees, note, created_at }
//
// Sending takes the amount plus Banking's transfer fees from the sender's account; the recipient
// gets the amount. There is no confirmation step. Each payment is also a message in the pair's
// one-to-one conversation and a notification for the recipient. Payments can't be deleted or reversed.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { account, money, transfer } from '../lib/banking';
import { body, cursor, fail, limit, page, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { track } from '../lib/palantir';
import { userByHandle, userCard, userCards, type UserRow } from '../lib/users';
import { bumpConversation, directConversationId } from './messages';

const payments = new Hono<AppEnv>();

export const MAX_PAYMENT = 1000000; // $10,000.00
export const MAX_NOTE = 140;

interface PaymentRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  amount: number;
  fees: number;
  note: string;
  created_at: number;
}

const unavailable = () => fail(502, 'Southbag Online Banking is unavailable. Try again later.');

payments.get('/account', async c => {
  const user = requireUser(c);
  const result = await account(c.env, user).catch(err => { console.error('banking account', err); return unavailable(); });
  return c.json({ account: result });
});

payments.get('/', async c => {
  const user = requireUser(c);
  const size = limit(c, 20);
  const after = cursor(c);
  const { results } = await c.env.DB.prepare(`SELECT * FROM payments WHERE (sender_id = ? OR recipient_id = ?)
      ${after ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`)
    .bind(user.id, user.id, ...(after ? [after] : []), size + 1).all<PaymentRow>();
  const { items, next } = page(results, size);
  const others = await userCards(c.env, items.map(p => (p.sender_id === user.id ? p.recipient_id : p.sender_id)));
  return c.json({
    items: items.map(p => {
      const sent = p.sender_id === user.id;
      const otherId = sent ? p.recipient_id : p.sender_id;
      return {
        id: p.id, direction: sent ? 'sent' : 'received', user: others.get(otherId) ?? null,
        amount: p.amount, fees: sent ? p.fees : 0, note: p.note, created_at: p.created_at,
      };
    }),
    next,
  });
});

payments.post('/', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const amount = Number(input.amount);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_PAYMENT)
    fail(422, `Payments are ${money(1)} to ${money(MAX_PAYMENT)}.`);
  const note = str(input.note, MAX_NOTE);
  const handle = typeof input.to === 'string' ? input.to.trim().replace(/^@/, '') : '';
  if (!handle) fail(422, 'Choose who to pay.');
  const recipient = await userByHandle(c.env, handle) as (UserRow & { email: string | null }) | null;
  if (!recipient) fail(404, 'User not found.');
  if (recipient.id === user.id) fail(422, 'You cannot send money to yourself.');
  const block = await c.env.DB.prepare(`SELECT blocker_id FROM blocks
      WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1`)
    .bind(recipient.id, user.id, user.id, recipient.id).first<{ blocker_id: string }>();
  if (block) fail(403, block.blocker_id === user.id
    ? `You blocked @${recipient.handle}. Unblock them first.`
    : `@${recipient.handle} is not accepting payments from you.`);

  const result = await transfer(c.env, user, { id: recipient.id, email: recipient.email ?? null, name: recipient.name }, amount)
    .catch(err => { console.error('banking transfer', err); return unavailable(); });
  if (!result.ok) {
    track(c, 'social_payment_refused', { amount, reason: result.error ?? null });
    fail(422, result.text || 'Southbag Online Banking refused the payment.');
  }
  const fees = result.fees ?? 0;

  const now = Date.now();
  const id = newId(now);
  const conversationId = await directConversationId(c.env, user.id, recipient.id, now);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO payments (id, sender_id, recipient_id, amount, fees, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, user.id, recipient.id, amount, fees, note, now),
    c.env.DB.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, payment_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(newId(now), conversationId, user.id, note, id, now),
    bumpConversation(c.env, conversationId, now),
    c.env.DB.prepare('UPDATE conversation_members SET last_read_at = MAX(last_read_at, ?) WHERE conversation_id = ? AND user_id = ?')
      .bind(now, conversationId, user.id),
    c.env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, body, link, created_at) VALUES (?, ?, ?, 'payment', ?, '/payments', ?)`)
      .bind(newId(now), recipient.id, user.id, `${user.name} sent you ${money(amount)}.`, now),
  ]);
  track(c, 'social_payment_sent', { payment_id: id, amount, fees, with_note: Boolean(note) });
  return c.json({
    payment: { id, direction: 'sent', user: userCard(recipient), amount, fees, note, created_at: now },
    conversation_id: conversationId,
    balance: result.balance ?? null,
    message: fees
      ? `Sent ${money(amount)} to @${recipient.handle}. Southbag Online Banking kept ${money(fees)} in fees.`
      : `Sent ${money(amount)} to @${recipient.handle}.`,
  }, 201);
});

export default payments;
