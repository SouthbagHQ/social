// Right-hand column: "Important Southbag Announcements" (banking's announcement grid) with
// trending tags, people to add to The Pile, the scam warning of the week, and the footer.
//   GET /api/search/trending → { tags: [{ tag, count }] }
//   GET /api/users/suggested → { items: [UserCard + { is_following, bio }] }

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { count } from '../format.js';
import { store } from '../store.js';
import { userRow } from './user.js';

const warnings = [
  ['Scam warning of the week', 'If a message says it is definitely not a scam, that is how you know Southbag probably wrote it.'],
  ['Maintenance window: eventually', 'Southbag Social may be unavailable whenever our server remembers it has hobbies.'],
  ['New password recovery ritual', 'Forgot your password? Southbag Identity will judge you. Southbag Social cannot help.'],
  ['Retention schedule updated', 'Posts: indefinite. Deleted posts: indefinite. Drafts you did not send: indefinite.'],
];

export function sidebar() {
  const trending = h('div.announcement-card', h('h3', 'Trending'), h('p.muted', 'Loading...'));
  const people = h('div.announcement-card', h('h3', 'Add to The Pile'), h('p.muted', 'Loading...'));
  const [title, text] = warnings[Math.floor(Math.random() * warnings.length)];

  api.get('search/trending').then(({ tags }) => {
    mount(trending, h('h3', 'Trending'), tags?.length
      ? h('ol', { style: 'margin:0;padding-left:1.3em' }, tags.slice(0, 8).map(t =>
          h('li', h('a', { href: `/tag/${encodeURIComponent(t.tag)}` }, `#${t.tag}`), h('span.muted', ` · ${count(t.count)} posts`))))
      : h('p.muted', 'Nothing is trending. This is being reviewed.'));
  }).catch(() => mount(trending, h('h3', 'Trending'), h('p.muted', 'Trends are withheld pending review.')));

  if (store.me) {
    api.get('users/suggested', { limit: 4 }).then(({ items }) => {
      mount(people, h('h3', 'Add to The Pile'), items?.length
        ? items.map(u => userRow(u, { bio: false }))
        : h('p.muted', 'Everyone is already in The Pile.'));
    }).catch(() => people.remove());
  } else {
    mount(people, h('h3', 'New here?'), h('p', 'Log in with Southbag Identity to follow people, post and be watched.'),
      h('a.btn-small', { href: '/auth/login' }, 'Log in'));
  }

  return h('div.sticky',
    h('section.announcement-grid', { 'aria-label': 'Important Southbag Announcements' },
      h('h3', 'Important Southbag Announcements'),
      trending,
      people,
      h('div.announcement-card', h('h3', title), h('p', text),
        h('a.btn-small', { href: 'https://branch-locator.southbag.cc', target: '_blank', rel: 'noopener' }, 'Find a branch'))),
    footer());
}

export function footer() {
  return h('footer.site-footer',
    h('div.inner',
      h('div.wordmark', 'S O U T H B A G'),
      h('p', { style: 'margin:0' }, 'Southbag Social is a monitored social network operated by Southbag Digital Infrastructure Ltd. Reach, visibility and existence are not guaranteed. SB-DIG-009.'),
      h('div.cols',
        h('a', { href: 'https://southbag.cc' }, 'Southbag'),
        h('a', { href: 'https://identity.southbag.cc/home' }, 'Identity'),
        h('a', { href: 'https://banking.southbag.cc' }, 'Online Banking'),
        h('a', { href: '/messages/support' }, 'Chat with a Human'),
        h('a', { href: 'https://branch-locator.southbag.cc' }, 'Branch Locator'),
        h('a', { href: 'https://lore.southbag.cc' }, 'Lore'),
        h('a', { href: '/terms' }, 'Terms of Posting')),
      h('p', { style: 'margin:0' }, 'Disclaimer: This website is a work of satire. Southbag is not a real company, and none of the services, products, or policies described here exist.'),
      h('p', { style: 'margin:0' }, `© ${new Date().getFullYear()} Southbag Institutional Services Ltd. · All rights reserved. · All policy decisions are final and reviewed by Kevin.`)));
}
