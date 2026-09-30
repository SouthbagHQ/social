// Bookmarks (/bookmarks): your saved posts, newest bookmark first. Signed-in only.
//   GET /api/feed/bookmarks?cursor -> { items, next }

import { api } from '../api.js';
import { h } from '../dom.js';
import { empty, infiniteList } from '../ui.js';
import { postCard } from '../components/post.js';
import { pageHead } from './feed-kit.js';

export default async function bookmarks(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Bookmarks');
  const list = infiniteList({
    signal: ctx.signal,
    load: cursor => api.get('feed/bookmarks', { cursor }, { signal: ctx.signal }),
    render: post => postCard(post),
    empty: empty({
      title: 'No bookmarks yet.',
      text: 'Posts you save appear here.',
      action: h('a.btn-small', { href: '/explore' }, 'Explore'),
    }),
  });
  return h('div.bookmarks-page',
    pageHead('Bookmarks', { back: true, sub: 'Only you can see these.' }),
    list);
}
