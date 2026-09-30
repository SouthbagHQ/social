// Search (/search?q=&type=top|posts|people|tags|groups|videos).
//   GET /api/search?q&type&cursor - see src/routes/search.ts for the shapes.

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { navigate } from '../router.js';
import { empty, infiniteList, tabs } from '../ui.js';
import { postCard } from '../components/post.js';
import { userRow } from '../components/user.js';
import { groupRow, pageHead, tagCard, tagRow } from './feed-kit.js';

const TYPES = [
  ['top', 'Top'], ['posts', 'Posts'], ['people', 'People'], ['tags', 'Tags'], ['groups', 'Groups'], ['videos', 'Videos'],
];

const noResults = () => empty({ title: 'No results.' });

export default async function searchView(ctx) {
  const q = (ctx.query.get('q') || '').trim();
  const type = TYPES.some(([t]) => t === ctx.query.get('type')) ? ctx.query.get('type') : 'top';
  ctx.title(q ? `Search: ${q}` : 'Search');
  const signal = ctx.signal;

  const input = h('input.input.boxed', { type: 'search', name: 'q', value: q, placeholder: 'Search posts, people, tags and groups', 'aria-label': 'Search', autofocus: !q });
  const form = h('form.explore-search', {
    role: 'search',
    onsubmit: e => {
      e.preventDefault();
      const next = input.value.trim();
      if (next) navigate(`/search?q=${encodeURIComponent(next)}${type !== 'top' ? `&type=${type}` : ''}`);
    },
  }, input, h('button.btn', { type: 'submit' }, 'Search'));

  const head = [pageHead('Search'), form];

  if (!q) {
    const suggestions = h('div', { class: 'announcement-grid trending-grid' }, h('h2', 'Trending'), h('p.muted', { style: 'grid-column:1/-1;margin:0' }, 'Loading'));
    api.get('search/trending', null, { signal }).then(({ tags }) => {
      mount(suggestions, h('h2', 'Trending'), tags.length
        ? tags.map((t, i) => tagCard(t, i + 1))
        : h('p.muted', { style: 'grid-column:1/-1;margin:0' }, 'Nothing is trending.'));
    }).catch(() => suggestions.remove());
    return h('div.search-page', head, suggestions);
  }

  const tabBar = tabs(TYPES.map(([t, label]) => ({
    href: `/search?q=${encodeURIComponent(q)}${t === 'top' ? '' : `&type=${t}`}`, label, current: t === type,
  })));

  let body;
  if (type === 'top') {
    const extras = h('div');
    const emptyHost = h('div');
    const list = infiniteList({
      signal,
      load: async cursor => {
        if (cursor) return api.get('search', { q, type: 'posts', cursor }, { signal });
        const data = await api.get('search', { q, type: 'top' }, { signal });
        mount(extras,
          data.people.length ? h('section.south-card.flat.search-section',
            h('div.section-head', h('h2', 'People'), h('a', { href: `/search?q=${encodeURIComponent(q)}&type=people` }, 'See all')),
            data.people.map(u => userRow(u))) : null,
          data.tags.length ? h('section.south-card.flat.search-section',
            h('div.section-head', h('h2', 'Tags'), h('a', { href: `/search?q=${encodeURIComponent(q)}&type=tags` }, 'See all')),
            h('div.tag-chips', data.tags.map(t => h('a.chip', { href: `/tag/${encodeURIComponent(t.tag)}` }, `#${t.tag}`, h('span.muted', ` ${t.count}`))))) : null,
          data.posts.items.length && (data.people.length || data.tags.length) ? h('h2.results-title', 'Posts') : null);
        // "No results" only when nothing at all matched; otherwise a quieter note.
        mount(emptyHost, data.people.length || data.tags.length
          ? h('p.muted.no-posts', 'No posts found.')
          : noResults());
        return data.posts;
      },
      render: post => postCard(post),
      empty: emptyHost,
    });
    body = h('div', extras, list);
  } else if (type === 'posts' || type === 'videos') {
    body = infiniteList({ signal, load: cursor => api.get('search', { q, type, cursor }, { signal }), render: post => postCard(post), empty: noResults() });
  } else {
    const render = type === 'people' ? u => userRow(u) : type === 'tags' ? tagRow : groupRow;
    body = infiniteList({
      signal,
      className: `south-card flat result-list ${type}-results`,
      load: cursor => api.get('search', { q, type, cursor }, { signal }),
      render,
      empty: noResults(),
      onPage: (_, data) => {
        // Hide the empty card frame when there is nothing in it.
        if (!data.next && !body.list.childElementCount) body.list.classList.add('hidden');
      },
    });
  }

  return h('div.search-page', head, tabBar, body);
}
