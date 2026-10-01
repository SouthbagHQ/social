// Sending money through Southbag Online Banking (routes/payments.ts). Used by /payments, profiles and
// one-to-one chats. No confirmation step: Send sends.
//   POST /api/payments { to, amount (cents), note? } -> { payment, conversation_id, balance, message }

import { api } from '../api.js';
import { h } from '../dom.js';
import { track } from '../analytics.js';
import { login, store } from '../store.js';
import { toast } from '../ui.js';
import { formDialog } from './board-picker.js';

export const MAX_NOTE = 140;

/** "12", "12.5", "$1,234.56" -> cents, or null. */
export function parseAmount(text) {
  const cleaned = String(text || '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return cents > 0 ? cents : null;
}

/** Sends the payment and shows the result. Throws with the server's message on failure. */
export async function sendPayment(to, amountText, note = '') {
  const amount = parseAmount(amountText);
  if (!amount) throw new Error('Enter an amount, like 12.50.');
  const res = await api.post('payments', { to, amount, note });
  track('social_payment_sent_ui', { amount, fees: res.payment.fees });
  toast(res.message);
  return res;
}

/** Amount and note fields. */
export function paymentFields() {
  const amount = h('input.input.boxed', { name: 'amount', inputMode: 'decimal', placeholder: '0.00', required: true, 'aria-label': 'Amount in dollars' });
  const note = h('input.input.boxed', { name: 'note', maxLength: MAX_NOTE, placeholder: 'What it is for (optional)', 'aria-label': 'Note' });
  return {
    amount, note,
    nodes: [
      h('label.field', h('span', 'Amount'), h('div.pay-amount', h('span', '$'), amount)),
      h('label.field', h('span', 'Note'), note),
      h('p.tiny', 'Taken from your Southbag Online Banking account, with Southbag Online Banking\'s transfer fees on top. No Southbag Online Banking account? One is opened for you. Payments are final.'),
    ],
  };
}

/** "Send money" dialog for one person. Resolves with the API response, or null if closed. */
export function sendMoneyDialog(user) {
  if (!store.me) { login(); return Promise.resolve(null); }
  const fields = paymentFields();
  return formDialog({
    title: `Send money to ${user.name}`,
    ok: 'Send',
    content: [h('p', `@${user.handle}`), ...fields.nodes],
    onSubmit: () => sendPayment(user.handle, fields.amount.value, fields.note.value),
  });
}
