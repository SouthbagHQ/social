// /standing - Account standing. It says as little as possible.

import { h } from '../dom.js';
import { fullDate } from '../format.js';
import { store } from '../store.js';

export default function standing(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Account standing');
  return h('div.standing-page',
    h('h1', 'Account standing'),
    h('section.south-card',
      h('p', h('strong', 'Your account exists.')),
      store.me?.created_at ? h('p.tiny', `Since ${fullDate(store.me.created_at)}.`) : null));
}
