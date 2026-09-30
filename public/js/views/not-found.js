import { h } from '../dom.js';

export default function notFound(ctx) {
  ctx.title('Not found');
  return h('div.south-card.flat',
    h('p.eyebrow', 'REF: SB-ERR-404'),
    h('h1', 'Kevin has closed this path.'),
    h('p', 'This attempt is on record. Kevin was already watching. He does not need to respond.'),
    h('p.mono', 'Fee — $12.00 — Policy curiosity'),
    h('p.fine', 'Do not request this path again. The Pile does not forget.'),
    h('a.btn', { href: '/' }, 'Return to the feed'));
}
