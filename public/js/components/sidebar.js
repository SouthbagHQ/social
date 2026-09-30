// Right-hand column: trending tags, people to follow and the footer.
//   GET /api/search/trending → { tags: [{ tag, count }] }
//   GET /api/users/suggested → { items: [UserCard + { is_following, bio }] }

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { count } from '../format.js';
import { store } from '../store.js';
import { userRow } from './user.js';

export function sidebar() {
  const trending = h('section.south-card', h('h3', 'Trending'), h('p.muted', 'Loading'));
  const people = store.me ? h('section.south-card', h('h3', 'Who to follow'), h('p.muted', 'Loading')) : null;

  api.get('search/trending').then(({ tags }) => {
    mount(trending, h('h3', 'Trending'), tags?.length
      ? h('ol', { style: 'margin:0;padding-left:1.3em;box-shadow:none' }, tags.slice(0, 8).map(t =>
          h('li', { style: 'box-shadow:none' }, h('a', { href: `/tag/${encodeURIComponent(t.tag)}` }, `#${t.tag}`), h('span.muted', ` ${count(t.count)}`))))
      : h('p.muted', 'Nothing yet.'));
  }).catch(() => trending.remove());

  if (people) {
    api.get('users/suggested', { limit: 4 }).then(({ items }) => {
      if (!items?.length) return people.remove();
      mount(people, h('h3', 'Who to follow'), items.map(u => userRow(u, { bio: false })));
    }).catch(() => people.remove());
  }

  return h('div.sticky', trending, people, footer());
}

export function footer() {
  return h('footer.site-footer',
    h('div.inner',
      h('span', `© ${new Date().getFullYear()} Southbag`),
      h('a', { href: '/terms' }, 'Terms'),
      h('a', { href: 'https://identity.southbag.cc/home' }, 'Southbag Identity'),
      h('a', { href: '/messages/support' }, 'Help'),
      h('a', { href: 'https://southbag.cc' }, 'southbag.cc')));
}
