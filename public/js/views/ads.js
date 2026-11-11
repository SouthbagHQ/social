// /ads - Southbag Ads: paid sponsored placements in the feeds, prepaid from Southbag Online
// Banking. Create a campaign, watch its showings and visits, pause or resume it.
//   GET  /api/ads         -> { items, rates, min_budget_cents, max_budget_cents }
//   GET  /api/ads/targets -> { posts, listings, page }
//   POST /api/ads         -> { campaign, charged, message }
//   POST /api/ads/:id/pause | /resume

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { money, plural, timeAgo } from '../format.js';
import { empty, errorBox, loading, toast, toastError } from '../ui.js';

const KINDS = [
  { value: 'post', label: 'A post' },
  { value: 'listing', label: 'A Marketplace listing' },
  { value: 'page', label: 'Your page' },
];

export default async function ads(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Ads');

  let targets = null;
  let initialItems = [];
  let rates = { impression_cents: 5, click_cents: 25, min_budget_cents: 500, max_budget_cents: 50000 };
  try {
    const [t, mine] = await Promise.all([api.get('ads/targets'), api.get('ads')]);
    targets = t;
    initialItems = mine.items;
    rates = { ...rates, ...mine.rates, min_budget_cents: mine.min_budget_cents, max_budget_cents: mine.max_budget_cents };
  } catch (err) {
    return h('div.ads-page', h('h1', 'Ads'), h('div.south-card', errorBox(err)));
  }

  // -- Create ------------------------------------------------------------
  const kind = h('select.input.boxed', { name: 'kind', 'aria-label': 'What to promote' },
    KINDS.map(k => h('option', { value: k.value }, k.label)));
  const target = h('select.input.boxed', { name: 'target', 'aria-label': 'Which one' });
  const name = h('input.input.boxed', { name: 'name', placeholder: 'Campaign name (optional)', maxLength: 80, autocomplete: 'off' });
  const budget = h('input.input.boxed', {
    name: 'budget', type: 'number', min: rates.min_budget_cents / 100, max: rates.max_budget_cents / 100,
    step: '0.01', value: (rates.min_budget_cents / 100).toFixed(2), required: true, 'aria-label': 'Budget in dollars',
  });

  const optionsFor = k => k === 'listing' ? targets.listings : k === 'page' ? [targets.page] : targets.posts;
  const paintTargets = () => {
    const options = optionsFor(kind.value);
    mount(target, options.length
      ? options.map(o => h('option', { value: o.id }, o.label))
      : h('option', { value: '' }, kind.value === 'listing' ? 'No available listings' : 'Nothing to promote'));
    target.disabled = !options.length;
    // A "Boost" link elsewhere lands here with ?kind=&target= preselected.
    const wanted = ctx.query.get('target');
    if (wanted && options.some(o => o.id === wanted)) target.value = wanted;
  };
  if (ctx.query.get('kind') && KINDS.some(k => k.value === ctx.query.get('kind'))) kind.value = ctx.query.get('kind');
  kind.addEventListener('change', paintTargets);
  paintTargets();

  const start = h('button.btn-large', { type: 'submit' }, 'Start campaign');
  const form = h('form.south-card.ads-form', {
    onsubmit: async e => {
      e.preventDefault();
      if (!target.value) return toast('Nothing to promote.', { error: true });
      start.disabled = true;
      try {
        const res = await api.post('ads', {
          kind: kind.value,
          target_id: target.value,
          name: name.value.trim() || undefined,
          budget_cents: Math.round(Number(budget.value) * 100),
        });
        name.value = '';
        toast(res.message || 'Campaign started.');
        window.dispatchEvent(new Event('bank:changed'));
        refresh();
      } catch (err) { toastError(err); }
      start.disabled = false;
    },
  },
    h('h2', 'Start a campaign'),
    h('label.field', h('span', 'Promote'), kind),
    h('label.field', h('span', 'Which one'), target),
    h('label.field', h('span', 'Name'), name),
    h('label.field', h('span', `Budget (${money(rates.min_budget_cents)} to ${money(rates.max_budget_cents)})`), budget),
    h('div.row', start));

  // -- Your campaigns ------------------------------------------------------
  const list = h('div.ads-list', loading());

  const statusText = s => s === 'active' ? 'Running' : s === 'paused' ? 'Paused' : s === 'ended' ? 'Budget spent' : 'Rejected';

  function row(c) {
    const toggle = h('button.btn-small', { type: 'button' }, c.status === 'active' ? 'Pause' : 'Resume');
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        const res = await api.post(`ads/${c.id}/${c.status === 'active' ? 'pause' : 'resume'}`);
        toast(res.message);
        refresh();
      } catch (err) { toastError(err); toggle.disabled = false; }
    });
    return h('article.south-card.ad-campaign',
      h('div.ad-campaign-head',
        h('div.grow',
          h('strong', c.name),
          h('p.tiny',
            `${c.kind === 'post' ? 'Post' : c.kind === 'listing' ? 'Listing' : 'Page'}: `,
            c.target.href ? h('a', { href: c.target.href }, c.target.label) : c.target.label,
            ` · started ${timeAgo(c.created_at)}`)),
        h('span.chip', statusText(c.status))),
      h('p.ad-stats',
        h('span', plural(c.impressions, 'showing')),
        h('span', plural(c.clicks, 'visit')),
        h('span', `${money(c.spent_cents)} of ${money(c.budget_cents)} spent`)),
      h('div.ad-progress', h('span', { style: `width: ${Math.min(100, Math.round(c.spent_cents / c.budget_cents * 100))}%` })),
      ['active', 'paused'].includes(c.status) ? h('div.row', toggle) : null);
  }

  function paintList(items) {
    mount(list, items.length ? items.map(row) : empty({ title: 'No campaigns.', text: 'Promote a post, listing or page above.' }));
  }
  async function refresh() {
    try { paintList((await api.get('ads')).items); } catch (err) { mount(list, errorBox(err)); }
  }
  paintList(initialItems);

  return h('div.ads-page',
    h('h1', 'Ads'),
    h('section.south-card.flat',
      h('h2', 'Southbag Ads'),
      h('p', 'Sponsored placements in the feeds, marked Sponsored.'),
      h('ul.ads-rates',
        h('li', `Each showing costs ${money(rates.impression_cents)}.`),
        h('li', `Each visit costs ${money(rates.click_cents)}. Repeat visits by the same person are free.`),
        h('li', 'The full budget is taken from your Southbag Online Banking account when the campaign starts.'),
        h('li', 'A campaign ends when its budget is spent. Payments already taken are kept.'))),
    form,
    h('h2', 'Your campaigns'),
    list);
}
