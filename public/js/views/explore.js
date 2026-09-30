// Explore (/explore). Works signed out.
//   search box -> trending tags (announcement grid) -> photo grid -> top posts this week + people to follow
//   GET /api/search/explore -> { tags, posts, photos, people }

import { api } from '../api.js';
import { h } from '../dom.js';
import { navigate } from '../router.js';
import { empty } from '../ui.js';
import { postCard } from '../components/post.js';
import { userRow } from '../components/user.js';
import { pageHead, photoTile, sponsoredCard, tagCard } from './feed-kit.js';

export default async function explore(ctx) {
  ctx.title('Explore');
  ctx.layout('wide');
  const data = await api.get('search/explore', null, { signal: ctx.signal });

  const search = h('input.input.boxed', { type: 'search', name: 'q', placeholder: 'Search posts, people, tags and groups', 'aria-label': 'Search' });
  const searchForm = h('form.explore-search', {
    role: 'search',
    onsubmit: e => { e.preventDefault(); const q = search.value.trim(); if (q) navigate(`/search?q=${encodeURIComponent(q)}`); },
  }, search, h('button.btn', { type: 'submit' }, 'Search'));

  const trending = h('section.announcement-grid.trending-grid', { 'aria-label': 'Trending' },
    h('h2', 'Trending'),
    data.tags.length
      ? data.tags.map((t, i) => tagCard(t, i + 1))
      : h('p.muted', { style: 'grid-column:1/-1;margin:0' }, 'Nothing is trending.'));

  const photos = data.photos.length ? h('section.explore-section',
    h('div.section-head', h('h2', 'Photos'), h('a', { href: '/photos' }, 'See all')),
    h('div.photo-grid', data.photos.map(photoTile))) : null;

  const posts = h('section.explore-section.explore-posts',
    h('div.section-head', h('h2', 'Top posts this week')),
    data.posts.length
      ? h('div.south-board', data.posts.flatMap((p, i) => i === 4 ? [postCard(p), sponsoredCard()] : [postCard(p)]))
      : empty({ title: 'No posts yet.' }));

  const people = h('section.explore-section.explore-people',
    h('div.announcement-grid',
      h('h3', 'Who to follow'),
      h('div.announcement-card',
        data.people.length
          ? data.people.map(u => userRow(u))
          : h('p.muted', ctx.me ? 'You follow everyone.' : 'No one here yet.'),
        ctx.me ? null : h('p.fine', 'Log in to follow people.'))));

  return h('div.explore-page',
    pageHead('Explore'),
    searchForm,
    trending,
    photos,
    h('div.explore-columns', posts, people));
}
