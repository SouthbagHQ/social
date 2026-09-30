// Helpers shared by the feed & discovery views (home, explore, search, tag, post, bookmarks).
// Not a route. Owned by the feed feature; other features are welcome to import from it.

import { h } from '../dom.js';
import { plural } from '../format.js';
import { navigate } from '../router.js';
import { toast } from '../ui.js';

/** An AbortSignal that aborts with `parent` or when `.abort()` is called (for lists that get replaced). */
export function childController(parent) {
  const controller = new AbortController();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}

/** Remembers a small per-browser preference (the last feed tab, say). Survives blocked storage. */
export const pref = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

// -- Sponsored cards (client-side only; never real posts) -----------------
// Plain promotions for other Southbag products.
const ads = [
  { brand: 'Southbag Office', text: 'Documents, spreadsheets and slides in your browser.', cta: 'Open Office', href: 'https://office.southbag.cc' },
  { brand: 'Southbag Drive', text: 'Store and share your files.', cta: 'Open Drive', href: 'https://drive.southbag.cc' },
  { brand: 'Southbag Code', text: 'A coding agent for your terminal.', cta: 'Learn more', href: 'https://code.southbag.cc' },
  { brand: 'Southbag Identity', text: 'One account for every Southbag product.', cta: 'Manage account', href: 'https://identity.southbag.cc' },
];

let adCursor = Math.floor(Math.random() * ads.length);

/** A sponsored card promoting a Southbag product. Can be hidden. */
export function sponsoredCard() {
  const ad = ads[adCursor++ % ads.length];
  const card = h('aside.south-card.sponsored-card', { 'aria-label': `Sponsored: ${ad.brand}` },
    h('div.sponsored-head',
      h('span.sponsored-label', 'Sponsored'),
      h('span.spacer'),
      h('button.btn-small', { type: 'button', 'aria-label': `Hide ${ad.brand}`, onclick: () => { card.remove(); toast('Hidden.'); } }, 'Hide')),
    h('h3.sponsored-brand', ad.brand),
    h('p', ad.text),
    h('a.btn-small', { href: ad.href, target: '_blank', rel: 'noopener', dataset: { external: '' } }, ad.cta));
  return card;
}

/**
 * Wraps an infiniteList render function so a sponsored card follows every `every`th item.
 * Returns a DocumentFragment when an ad is due (infiniteList appends whatever node it gets).
 */
export function withSponsored(render, every = 8) {
  let n = 0;
  return item => {
    const node = render(item);
    if (!node) return null;
    n++;
    if (n % every !== 0) return node;
    const frag = document.createDocumentFragment();
    frag.append(node, sponsoredCard());
    return frag;
  };
}

// -- Small presentational pieces -------------------------------------------

/** Square photo tile linking to the post. The photo is stretched to fill the square. */
export function photoTile(post) {
  const first = post.media?.find(m => m.kind === 'image');
  if (!first) return null;
  return h('a.photo-tile', { href: `/post/${post.id}`, 'aria-label': `Photo by @${post.author.handle}${post.body ? ': ' + post.body.slice(0, 80) : ''}` },
    h('span.tile-box',
      h('img', { src: first.url, alt: first.alt || '', loading: 'lazy', decoding: 'async' }),
      post.media.length > 1 ? h('span.multi', `${post.media.length} photos`) : null),
    h('span.tile-stats', `${plural(post.counts.reactions, 'like')}, ${plural(post.counts.replies, 'comment')}`));
}

/** A trending tag in announcement-card form. */
export const tagCard = (t, rank) => h('a.announcement-card.tag-card', { href: `/tag/${encodeURIComponent(t.tag)}` },
  rank ? h('span.rank', `${rank}.`) : null,
  h('strong', `#${t.tag}`),
  h('span.muted', plural(t.count, 'post')));

/** A tag search result row. */
export const tagRow = t => h('a.result-row', { href: `/tag/${encodeURIComponent(t.tag)}` },
  h('span.grow', h('strong', `#${t.tag}`)),
  h('span.muted', plural(t.count, 'post')));

/** A group search result row. */
export const groupRow = g => h('a.result-row', { href: `/g/${encodeURIComponent(g.slug)}` },
  h('span.avatar.sm', g.avatar_url ? h('img', { src: g.avatar_url, alt: '', loading: 'lazy' }) : h('span.initial', (g.name || 'g').charAt(0).toLowerCase())),
  h('span.grow',
    h('strong', g.name),
    g.description ? h('span.desc', g.description) : null),
  h('span.group-meta',
    g.privacy === 'private' ? h('span.chip', 'Private') : null,
    g.is_member ? h('span.chip.teal', 'Member') : null,
    h('span.muted', plural(g.member_count, 'member'))));

/** Page heading row: back button, title, optional right-hand content. */
export function pageHead(title, { back = false, right = null, sub = null } = {}) {
  return h('div.page-head.feed-head',
    back ? h('button.btn-small.back-btn', { type: 'button', onclick: () => history.length > 1 ? history.back() : navigate('/') }, 'Back') : null,
    h('div.grow', h('h1', title), sub ? h('p.muted.sub', sub) : null),
    right);
}
