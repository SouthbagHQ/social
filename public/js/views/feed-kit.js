// Helpers shared by the feed & discovery views (home, explore, search, tag, post, bookmarks).
// Not a route. Owned by the feed feature; other features are welcome to import from it.

import { h, icon } from '../dom.js';
import { count, plural } from '../format.js';
import { navigate } from '../router.js';
import { dialog, toast } from '../ui.js';

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

// ── Sponsored cards (client-side only; never real posts) ─────────────────
const ads = [
  {
    brand: 'Kevin’s Briefcase (replica)', price: '$250.00', img: null,
    text: 'Do not open. Ships sealed. Customers who have opened it should not post about it.',
    cta: 'Buy sealed', onClick: () => toast('Order received. Delivery: 3–10 business days. Do not open the box either.', { fee: 'Handling of The Briefcase' }),
  },
  {
    brand: 'Southbag Online Banking', img: '/img/ad-1.jpg',
    text: 'Your balance is loading. It has been loading for some time. Be free.',
    cta: 'Log in to banking', href: 'https://banking.southbag.cc',
  },
  {
    brand: 'Prohibited Shark Permit', price: '$140.00', img: null,
    text: 'Lifts the Blahaj shadowban for one (1) shark. Support staff are not permitted to comment. They love it.',
    cta: 'Apply for a permit', onClick: () => toast('Application received. Kevin has forbidden it.', { error: true }),
  },
  {
    brand: 'Southbag Verified™', price: '$8.00/week', img: null,
    text: 'Bronze, Silver, Gold, Platinum, Diamond, Obsidian. Each tier costs more and does absolutely nothing.',
    cta: 'Get verified', href: '/verified',
  },
  {
    brand: 'Southbag Code', img: '/img/ad-4.jpg',
    text: 'A terminal agent for developers who already have a terminal. Write code only slightly slower than Kevin.',
    cta: 'Learn more', href: 'https://southbag.cc',
  },
  {
    brand: 'Boost this feed', price: '$4.99', img: null,
    text: 'Pay to see your own posts slightly higher. Reach is not guaranteed. Neither is the feed.',
    cta: 'Boost', onClick: () => toast('Boosted. Nothing has changed. That is the product.', { fee: 'Boost processing' }),
  },
  {
    brand: 'Southbag Branch Locator', img: '/img/ad-7.jpg',
    text: 'Lost? Give up and find a branch. Branches do not exist, but the locator is very thorough.',
    cta: 'Find a branch', href: 'https://branch-locator.southbag.cc',
  },
];

let adCursor = Math.floor(Math.random() * ads.length);

/** A clearly labelled fake sponsored card in the promo-yellow style. Dismissible. */
export function sponsoredCard() {
  const ad = ads[adCursor++ % ads.length];
  const external = ad.href && /^https?:/.test(ad.href);
  const card = h('aside.south-card.sponsored-card', { 'aria-label': `Sponsored: ${ad.brand}` },
    h('div.sponsored-head',
      h('span.sponsored-label', 'SPONSORED'),
      h('span.muted', 'Paid for by Southbag, to Southbag'),
      h('span.spacer'),
      h('button.icon-btn', { type: 'button', title: 'Why am I seeing this?', 'aria-label': 'Why am I seeing this ad?',
        onclick: () => dialog({ title: 'Algorithmic transparency', body: 'Kevin.' }) }, icon('eye')),
      h('button.icon-btn', { type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss this ad', onclick: () => {
        card.remove();
        toast('Ad dismissed. A closure fee may apply.');
      } }, icon('close'))),
    ad.img ? h('img.sponsored-img', { src: ad.img, alt: '', loading: 'lazy' }) : null,
    h('div.sponsored-body',
      h('strong.sponsored-brand', ad.brand),
      ad.price ? h('span.sponsored-price', ad.price) : null,
      h('p', ad.text),
      ad.href
        ? h('a.btn-small', { href: ad.href, ...(external && { target: '_blank', rel: 'noopener', dataset: { external: '' } }) }, ad.cta)
        : h('button.btn-small', { type: 'button', onclick: ad.onClick }, ad.cta)));
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

// ── Small presentational pieces ───────────────────────────────────────────

/** Square photo tile linking to the post (Instagram grid). */
export function photoTile(post) {
  const first = post.media?.find(m => m.kind === 'image');
  if (!first) return null;
  return h('a.photo-tile', { href: `/post/${post.id}`, 'aria-label': `Photo by @${post.author.handle}${post.body ? ': ' + post.body.slice(0, 80) : ''}` },
    h('img', { src: first.url, alt: first.alt || '', loading: 'lazy', decoding: 'async' }),
    post.media.length > 1 ? h('span.multi', { title: `${post.media.length} photos` }, icon('grid')) : null,
    h('span.overlay',
      h('span', icon('heart'), count(post.counts.reactions)),
      h('span', icon('comment'), count(post.counts.replies))));
}

/** A trending tag in announcement-card form. */
export const tagCard = (t, rank) => h('a.announcement-card.tag-card', { href: `/tag/${encodeURIComponent(t.tag)}` },
  rank ? h('span.rank', `${rank}`) : null,
  h('strong', `#${t.tag}`),
  h('span.muted', plural(t.count, 'post')));

/** A tag search result row. */
export const tagRow = t => h('a.result-row', { href: `/tag/${encodeURIComponent(t.tag)}` },
  h('span.tag-icon', icon('hash')),
  h('span.grow', h('strong', `#${t.tag}`)),
  h('span.muted', plural(t.count, 'post')));

/** A group search result row. */
export const groupRow = g => h('a.result-row', { href: `/g/${encodeURIComponent(g.slug)}` },
  h('span.avatar.sm', g.avatar_url ? h('img', { src: g.avatar_url, alt: '', loading: 'lazy' }) : h('span.initial', (g.name || 'g').charAt(0).toLowerCase())),
  h('span.grow',
    h('strong', g.name),
    g.description ? h('span.desc', g.description) : null),
  h('span.group-meta',
    g.privacy === 'private' ? h('span.chip', icon('lock'), 'Private') : null,
    g.is_member ? h('span.chip.teal', 'Member') : null,
    h('span.muted', plural(g.member_count, 'member'))));

/** Page heading row: back button, title, optional right-hand content. */
export function pageHead(title, { back = false, right = null, sub = null } = {}) {
  return h('div.page-head.feed-head',
    back ? h('button.icon-btn', { type: 'button', 'aria-label': 'Back', onclick: () => history.length > 1 ? history.back() : navigate('/') }, icon('back')) : null,
    h('div.grow', h('h1', title), sub ? h('p.muted.sub', sub) : null),
    right);
}
