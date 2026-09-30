// /videos — the YouTube home: chips (All / Recent / Popular), a thumbnail grid, a Shorts shelf.
//   GET /api/videos/feed?kind=video&sort=recent|popular&cursor → { items, next }
//   GET /api/videos/shorts?limit → { items }
//
// Also exports the small pieces the other video views share (watch, shorts, photos, upload):
// videoCard, shortTile, viewsLine, channelInfo, heartBurst, isTyping.

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { fullDate, plural, relative } from '../format.js';
import { login, store } from '../store.js';
import { empty, infiniteList } from '../ui.js';
import { videoThumb } from '../components/media.js';
import { avatar, verifiedBadge } from '../components/user.js';

// ── Shared helpers ───────────────────────────────────────────────────────

/** "1.2K views · 3 days ago" */
export const viewsLine = post =>
  `${plural(post.counts.views, 'view')} · ${relative(post.created_at)}`;

/** Is the user typing somewhere (so keyboard shortcuts should stay out of the way)? */
export const isTyping = e => {
  const t = e.target;
  return Boolean(t?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .overlay, .menu'))
    || Boolean(document.querySelector('.overlay'));
};

/** Channel name with the purchased tick. */
export const channelName = user => h('a.yt-channel', { href: `/@${user.handle}`, title: `@${user.handle}` },
  h('span', user.name), user.verified ? verifiedBadge() : null);

/** A YouTube grid card: thumbnail, 2-line title, channel, "N views · 3 days ago". */
export function videoCard(post, { compact = false } = {}) {
  const m = post.media.find(x => x.kind === 'video');
  if (!m) return null;
  const href = `/watch/${post.id}`;
  return h('article.yt-card', { class: { compact }, dataset: { postId: post.id } },
    videoThumb(m, { href }),
    h('div.yt-meta',
      compact ? null : avatar(post.author, { size: 'sm' }),
      h('div.grow',
        h('a.yt-title', { href, title: post.title || '' }, post.title || 'Untitled video (Kevin approved)'),
        h('div.yt-sub', channelName(post.author)),
        h('div.yt-sub', { title: fullDate(post.created_at) }, viewsLine(post),
          post.visibility !== 'public' ? h('span', { title: `Visible to ${post.visibility === 'followers' ? 'The Pile' : 'friends'}` }, ' · ', icon(post.visibility === 'friends' ? 'users' : 'lock')) : null))));
}

/** A vertical Shorts tile (shelf rows, channel pages). */
export function shortTile(post) {
  const m = post.media.find(x => x.kind === 'video');
  if (!m) return null;
  return h('a.yt-short', { href: `/shorts/${post.id}`, dataset: { postId: post.id } },
    videoThumb(m, { vertical: true }),
    h('span.yt-short-caption', post.body || `@${post.author.handle}`),
    h('span.yt-sub', plural(post.counts.views, 'view')));
}

/**
 * Channel details for a handle: { follower_count, is_following, … }. Asks the users API first and
 * falls back to /api/videos/channel/:handle. Cached briefly; resolves to null if both fail.
 */
const channelCache = new Map();
export function channelInfo(handle) {
  const hit = channelCache.get(handle);
  if (hit && Date.now() - hit.at < 30000) return hit.promise;
  const promise = api.get(`users/${encodeURIComponent(handle)}`)
    .then(d => {
      const u = d?.user || d;
      if (!u || (u.follower_count == null && u.is_following == null)) throw new Error('No channel details');
      return u;
    })
    .catch(() => api.get(`videos/channel/${encodeURIComponent(handle)}`, { limit: 1 }).then(d => d.channel))
    .catch(() => null);
  channelCache.set(handle, { at: Date.now(), promise });
  return promise;
}

/** The Instagram double-tap heart, drawn over `host` (which should be position: relative). */
export function heartBurst(host) {
  const el = h('span.heart-burst', { 'aria-hidden': 'true' }, icon('heart'));
  host.append(el);
  setTimeout(() => el.remove(), 900);
}

// ── The page ─────────────────────────────────────────────────────────────

const chips = [
  { key: 'all', label: 'All' },
  { key: 'recent', label: 'Recent' },
  { key: 'popular', label: 'Popular' },
];

export default async function videos(ctx) {
  ctx.layout('wide');
  ctx.title('Videos');
  let sort = chips.some(c => c.key === ctx.query.get('sort')) ? ctx.query.get('sort') : 'all';

  const chipBar = h('div.yt-chips', { role: 'tablist', 'aria-label': 'Sort videos' });
  const body = h('div');

  const paintChips = () => mount(chipBar, chips.map(c => h('button.yt-chip', {
    type: 'button', role: 'tab', 'aria-selected': c.key === sort ? 'true' : 'false',
    onclick: () => {
      if (c.key === sort) return;
      sort = c.key;
      history.replaceState({}, '', c.key === 'all' ? '/videos' : `/videos?sort=${c.key}`);
      paintChips();
      paintBody();
    },
  }, c.label)));

  function paintBody() {
    let shelfPlaced = false;
    const shelf = sort === 'all' ? shortsShelf(ctx) : null;
    const list = infiniteList({
      className: 'yt-grid',
      signal: ctx.signal,
      load: cursor => api.get('videos/feed', { kind: 'video', sort: sort === 'popular' ? 'popular' : 'recent', cursor }, { signal: ctx.signal }),
      render: post => videoCard(post),
      empty: empty({
        icon: 'video',
        title: 'No videos yet.',
        text: 'Nothing has been uploaded. Kevin is watching the empty grid in the meantime.',
        action: store.me ? h('a.btn', { href: '/upload?type=video' }, 'Upload video') : null,
      }),
      onPage: () => {
        // YouTube puts the Shorts shelf after the first two rows.
        if (!shelf || shelfPlaced) return;
        shelfPlaced = true;
        const cards = list.list.children;
        if (cards.length) cards[Math.min(cards.length, 8) - 1].after(shelf);
        else list.list.after(shelf);
      },
    });
    mount(body, list);
  }

  paintChips();
  paintBody();

  return h('div.yt-home',
    h('div.page-head',
      h('h1', 'Videos'),
      h('span.spacer'),
      h('a.btn-small.outline', { href: '/shorts' }, icon('shorts'), 'Shorts'),
      store.me
        ? h('a.btn', { href: '/upload?type=video' }, icon('upload'), 'Upload video')
        : h('button.btn', { type: 'button', onclick: () => login('/upload?type=video') }, icon('upload'), 'Upload video')),
    h('p.fine.yt-tagline', 'Watch anything. Southbag is watching you watch it. Uploads are retained permanently.'),
    chipBar,
    body);
}

/** A row of Shorts under a heading. Removes itself when there are none. */
function shortsShelf(ctx) {
  const row = h('div.yt-shelf-row', h('div.loading', h('div.spinner'), 'Loading...'));
  const shelf = h('section.yt-shelf', { 'aria-label': 'Shorts' },
    h('div.yt-shelf-head', icon('shorts'), h('h2', 'Shorts'), h('span.spacer'),
      h('a.btn-small.flat', { href: '/shorts' }, 'Watch all')),
    row);
  api.get('videos/shorts', { limit: 12 }, { signal: ctx.signal }).then(({ items }) => {
    if (!items.length) return shelf.remove();
    mount(row, items.map(shortTile));
  }).catch(() => shelf.remove());
  return shelf;
}
