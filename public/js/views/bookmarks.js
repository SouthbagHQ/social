// Bookmarks (/bookmarks): your saved posts, newest bookmark first. Signed-in only.
//   GET /api/feed/bookmarks?cursor → { items, next }

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
      icon: 'bookmark',
      title: 'No bookmarks.',
      text: 'Southbag has bookmarked everything on your behalf anyway. Use the bookmark button on a post to keep your own copy.',
      action: h('a.btn-small', { href: '/explore' }, 'Find something to keep'),
    }),
  });
  return h('div.bookmarks-page',
    pageHead('Bookmarks', { back: true, sub: 'Only you can see these. And Kevin.' }),
    list);
}
