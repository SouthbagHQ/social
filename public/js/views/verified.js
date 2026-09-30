// /verified — Southbag Verified™: six tiers, one badge, no benefits. No real payments; the fee is
// added to your bag_balance ledger ("never charged, always recorded").
//   POST /api/users/me/verify { tier } → { verified, tier, charged, bag_balance, message }
//   DELETE /api/users/me/verify        → { verified, charged, bag_balance, message }

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { money } from '../format.js';
import { login, store } from '../store.js';
import { confetti, confirm, toast, toastError } from '../ui.js';
import { verifiedBadge } from '../components/user.js';

const TIERS = [
  { key: 'bronze', name: 'Bronze', cents: 800, colour: '#a0673a', perks: ['A badge.', 'That is the whole product.'] },
  { key: 'silver', name: 'Silver', cents: 1600, colour: '#8e9aa6', perks: ['The same badge.', 'Slightly more expensive.'] },
  { key: 'gold', name: 'Gold', cents: 3200, colour: '#c9a227', perks: ['The same badge, reviewed by Kevin.', 'Review outcome withheld.'] },
  { key: 'platinum', name: 'Platinum', cents: 6400, colour: '#5f8a8b', perks: ['Priority placement in The Pile.', 'The Pile has no order.'] },
  { key: 'diamond', name: 'Diamond', cents: 12800, colour: '#4fc3f7', perks: ['A dedicated account manager.', 'He is on leave.'] },
  { key: 'obsidian', name: 'Obsidian', cents: 25600, colour: '#1b1b1b', perks: ['Kevin is aware of you.', 'This cannot be undone.'] },
];

export default function verified(ctx) {
  ctx.title('Southbag Verified™');
  const status = h('div');
  const ledger = h('div');

  const paint = () => {
    const me = store.me;
    mount(status, !me
      ? h('p', 'Log in to purchase a badge. The badge will not log in for you.')
      : me.verified
        ? h('div.verified-status.on', verifiedBadge(), h('div',
            h('strong', 'You are Southbag Verified™.'),
            h('p.fine', 'Your tier is recorded. It is not displayed. Kevin knows which one you have.')),
            h('button.btn-small.outline', { type: 'button', onclick: cancel }, 'Cancel subscription'))
        : h('div.verified-status', icon('verified'), h('div',
            h('strong', 'You are not verified.'),
            h('p.fine', 'Your identity has been confirmed by Southbag Identity™. That does not count.'))));
    mount(ledger,
      h('div.ledger-total', h('span.muted', 'Fees owed to Southbag'), h('strong', money(me?.bag_balance || 0))),
      h('p.fine', 'Includes the appreciation surcharge ($0.02 per reaction), verification fees and notice periods. Fees are never charged. They are always recorded.'),
      h('p', 'Balance in Southbag Online Banking: ', h('span.stuck-loading')),
      h('a.btn-small', { href: 'https://banking.southbag.cc', target: '_blank', rel: 'noopener', dataset: { external: '' } }, 'View in Southbag Online Banking'));
  };

  async function buy(tier) {
    if (!store.me) return login();
    const ok = await confirm(`Subscribe to Southbag Verified™ ${tier.name} for ${money(tier.cents)} per week? The fee is added to your ledger. It does absolutely nothing.`,
      { title: 'Southbag Payments', ok: 'Pay with engagement' });
    if (!ok) return;
    try {
      const res = await api.post('users/me/verify', { tier: tier.key });
      store.patchMe({ verified: true, bag_balance: res.bag_balance });
      paint();
      confetti(40);
      toast(res.message, { fee: `${tier.name} tier, first week` });
    } catch (err) { toastError(err); }
  }

  async function cancel() {
    const ok = await confirm("Cancel Southbag Verified™? Cancellation requires 30 days' notice, billed now. Your badge is revoked immediately.",
      { title: 'Southbag Payments', ok: 'Cancel subscription', cancel: 'Keep paying' });
    if (!ok) return;
    try {
      const res = await api.del('users/me/verify');
      store.patchMe({ verified: false, bag_balance: res.bag_balance });
      paint();
      toast(res.message, { fee: 'Notice period' });
    } catch (err) { toastError(err); }
  }

  paint();

  return h('div.verified-page',
    h('section.south-card.flat.verified-hero',
      h('p.eyebrow', 'SB-DIG-009-V · VERIFICATION'),
      h('h1', 'Southbag Verified', h('sup', '™'), ' ', verifiedBadge()),
      h('p', 'A badge next to your name, from $8.00 per week. Six tiers are available. Each tier costs more and does absolutely nothing.'),
      h('p.meta-line.mono', 'Applications received 247 · Granted this year 3 · Denied or pending 244'),
      status),
    h('section.announcement-grid.tiers', { 'aria-label': 'Verification tiers' },
      h('h2', 'Choose a tier'),
      TIERS.map(tier => h('div.announcement-card.tier', { style: `--tier:${tier.colour}` },
        h('div.tier-head', h('span.tier-badge', icon('verified')), h('h3', tier.name)),
        h('p.tier-price', h('strong', money(tier.cents)), h('span.muted', ' / week')),
        h('ul', tier.perks.map(p => h('li', p))),
        h('button.btn-small', { type: 'button', onclick: () => buy(tier) }, `Buy ${tier.name}`)))),
    h('section.south-card.flat',
      h('h2', 'Fee ledger'),
      ledger),
    h('p.fine', 'Southbag Verified™ confirms that you paid. It does not confirm anything else. Refunds are processed in person at a branch. Branches do not exist.'));
}
