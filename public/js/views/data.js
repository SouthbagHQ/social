// /data - Your data: what Southbag Social keeps about you. Counts only.
//   GET /api/me/data -> { items: [{ label, value }], since }

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { fullDate } from '../format.js';
import { errorBox, loading } from '../ui.js';

export default function data(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Your data');
  const card = h('section.south-card', loading());
  api.get('me/data', {}, { signal: ctx.signal }).then(res => mount(card,
    res.since ? h('p.tiny', `Kept since ${fullDate(res.since)}.`) : null,
    h('table.data-table', h('tbody', res.items.map(i => h('tr', h('th', { scope: 'row' }, i.label), h('td', i.value)))))))
    .catch(err => { if (err.name !== 'AbortError') mount(card, errorBox(err)); });
  return h('div.data-page',
    h('h1', 'Your data'),
    h('p', 'Everything you share is kept.'),
    card);
}
