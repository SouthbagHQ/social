// /payments - money sent and received through Southbag Online Banking.
//   GET  /api/payments/account -> { account: { balance, account_number, status, transactions } | null }
//   GET  /api/payments?cursor  -> { items: [{ id, direction, user, amount, fees, note, created_at }], next }
//   POST /api/payments         (components/payments.js)

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { fullDate, money, timeAgo } from '../format.js';
import { empty, errorBox, infiniteList, loading, toastError } from '../ui.js';
import { avatar } from '../components/user.js';
import { paymentFields, sendPayment } from '../components/payments.js';

export default function payments(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Payments');

  const accountCard = h('section.south-card.pay-account', h('h2', 'Southbag Online Banking'), loading());
  const loadAccount = () => api.get('payments/account').then(({ account }) => {
    mount(accountCard, h('h2', 'Southbag Online Banking'), account
      ? [
          h('p.pay-balance', h('strong', money(account.balance))),
          h('p.tiny', `Account ${account.account_number || 'number pending'}${account.status && account.status !== 'active' ? ` (${account.status})` : ''}`),
          account.transactions?.length
            ? h('ul.pay-transactions', account.transactions.slice(0, 5).map(t =>
                h('li', h('span.grow', t.description), h('span', { class: { 'pay-out': t.amount < 0 } }, money(t.amount)))))
            : null,
          h('a', { href: 'https://banking.southbag.cc', target: '_blank', rel: 'noopener' }, 'Open Southbag Online Banking'),
        ]
      : h('p', 'You don\'t have a Southbag Online Banking account yet. One is opened for you when you send money or subscribe to Southbag Verified.'));
  }).catch(err => mount(accountCard, h('h2', 'Southbag Online Banking'), errorBox(err)));
  loadAccount();

  const to = h('input.input.boxed', { name: 'to', placeholder: '@handle', required: true, autocomplete: 'off', 'aria-label': 'Who to pay' });
  const preset = ctx.query.get('to');
  if (preset) to.value = `@${preset.replace(/^@/, '')}`;
  const fields = paymentFields();
  const send = h('button.btn-large', { type: 'submit' }, 'Send');
  const form = h('form.south-card.pay-form', {
    onsubmit: async e => {
      e.preventDefault();
      send.disabled = true;
      try {
        const res = await sendPayment(to.value, fields.amount.value, fields.note.value);
        fields.amount.value = '';
        fields.note.value = '';
        history.prepend(row(res.payment));
        loadAccount();
      } catch (err) { toastError(err); }
      send.disabled = false;
    },
  }, h('h2', 'Send money'), h('label.field', h('span', 'To'), to), fields.nodes, h('div.row', send));

  const row = p => h('article.south-card.pay-row',
    p.user ? avatar(p.user, { size: 'sm' }) : null,
    h('div.grow',
      h('p', p.direction === 'sent' ? 'Sent to ' : 'Received from ',
        p.user ? h('a', { href: `/@${p.user.handle}` }, p.user.name) : 'a deleted account',
        ' ', h('span.muted', { title: fullDate(p.created_at) }, timeAgo(p.created_at))),
      p.note ? h('p.pay-note', p.note) : null,
      p.direction === 'sent' && p.fees ? h('p.tiny', `Fees ${money(p.fees)}`) : null),
    h('strong.pay-amount-total', { class: { 'pay-out': p.direction === 'sent' } }, `${p.direction === 'sent' ? '-' : '+'}${money(p.amount)}`));

  const history = infiniteList({
    load: cursor => api.get('payments', { cursor }, { signal: ctx.signal }),
    render: row,
    empty: empty({ title: 'No payments.' }),
    signal: ctx.signal,
  });

  return h('div.pay-page',
    h('h1', 'Payments'),
    accountCard,
    form,
    h('h2', 'History'),
    history);
}
