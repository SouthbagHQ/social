// /verified - Southbag Verified: a monthly subscription that shows "Verified" next to your name.
//   POST /api/users/me/verify   -> { verified, tier, charged, bag_balance, message }
//   DELETE /api/users/me/verify -> { verified, charged, bag_balance, message }

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { money } from '../format.js';
import { login, store } from '../store.js';
import { confirm, toast, toastError } from '../ui.js';
import { avatar, userName } from '../components/user.js';

const PRICE_CENTS = 800;

export default function verified(ctx) {
  ctx.title('Southbag Verified');
  const status = h('div.verified-status');
  const preview = h('div.verified-preview');

  const paint = () => {
    const me = store.me;
    mount(preview, me
      ? [avatar(me, { size: 'lg', link: false }), h('div', userName({ ...me, verified: true }, { link: false }))]
      : null);
    preview.classList.toggle('hidden', !me);
    if (!me) {
      mount(status,
        h('p', 'Log in to subscribe.'),
        h('button.btn', { type: 'button', onclick: () => login() }, 'Log in'));
    } else if (me.verified) {
      mount(status,
        h('p', h('strong', 'Your subscription is active.')),
        h('button.btn', { type: 'button', onclick: cancel }, 'Cancel subscription'));
    } else {
      mount(status,
        h('p', 'You are not subscribed.'),
        h('button.btn-large', { type: 'button', onclick: subscribe }, 'Subscribe'));
    }
  };

  async function subscribe() {
    if (!store.me) return login();
    const ok = await confirm(`Subscribe to Southbag Verified for ${money(PRICE_CENTS)} per month?`,
      { title: 'Southbag Verified', ok: 'Subscribe' });
    if (!ok) return;
    try {
      const res = await api.post('users/me/verify');
      store.patchMe({ verified: true, bag_balance: res.bag_balance });
      paint();
      toast(res.message || 'Subscribed.');
    } catch (err) { toastError(err); }
  }

  async function cancel() {
    const ok = await confirm('Verified will be removed from your name.',
      { title: 'Cancel subscription?', ok: 'Cancel subscription', cancel: 'Keep' });
    if (!ok) return;
    try {
      const res = await api.del('users/me/verify');
      store.patchMe({ verified: false, bag_balance: res.bag_balance });
      paint();
      toast(res.message || 'Subscription cancelled.');
    } catch (err) { toastError(err); }
  }

  paint();

  return h('div.verified-page',
    h('section.south-card.flat.verified-hero',
      h('h1', 'Southbag Verified'),
      h('p.verified-price', h('strong', money(PRICE_CENTS)), ' per month'),
      h('p', '"Verified" appears next to your name on your profile, posts and comments.'),
      preview,
      h('hr.divider'),
      status),
    h('section.south-card.flat',
      h('h2', 'Details'),
      h('ul.verified-details',
        h('li', 'Billed monthly.'),
        h('li', 'Cancel any time on this page.'),
        h('li', 'Verified is removed as soon as you cancel.'))));
}
