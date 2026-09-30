// /photos — Instagram: a centred feed of photo posts (or a 3-column grid).
//   GET /api/videos/feed?kind=photo&cursor → { items, next }
// Double-tap a photo to like it. The feed/grid choice is remembered per browser.

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { count, fullDate, plural, relative } from '../format.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, infiniteList, menu, share, toast, toastError } from '../ui.js';
import { carousel } from '../components/media.js';
import { REACTIONS, postUrl, richText } from '../components/post.js';
import { avatar, verifiedBadge } from '../components/user.js';
import { heartBurst } from './videos.js';

const VIEW_KEY = 'sb_photos_view';
const readView = () => { try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'feed'; } catch { return 'feed'; } };
const writeView = v => { try { localStorage.setItem(VIEW_KEY, v); } catch {} };

export default async function photos(ctx) {
  ctx.layout('default');
  ctx.title('Photos');
  let view = ctx.query.get('view') === 'grid' ? 'grid' : ctx.query.get('view') === 'feed' ? 'feed' : readView();

  const body = h('div');
  const toggle = h('div.ig-toggle', { role: 'tablist', 'aria-label': 'Layout' });
  const paintToggle = () => mount(toggle,
    [['feed', 'list', 'Feed'], ['grid', 'grid', 'Grid']].map(([key, ic, label]) => h('button.icon-btn', {
      type: 'button', role: 'tab', 'aria-selected': view === key ? 'true' : 'false', title: `${label} view`,
      onclick: () => { if (view === key) return; view = key; writeView(key); paintToggle(); paint(); },
    }, icon(ic), h('span', label))));

  function paint() {
    mount(body, infiniteList({
      className: view === 'grid' ? 'ig-grid' : 'ig-feed',
      signal: ctx.signal,
      load: cursor => api.get('videos/feed', { kind: 'photo', cursor, limit: view === 'grid' ? 30 : 12 }, { signal: ctx.signal }),
      render: post => (view === 'grid' ? gridTile(post) : igCard(post)),
      empty: empty({
        icon: 'image',
        title: 'No photos yet.',
        text: 'Nobody has shared a photo. Your face is already on file, so Southbag is not worried.',
        action: store.me ? h('a.btn', { href: '/upload?type=photo' }, 'New photo post') : null,
      }),
    }));
  }
  paintToggle();
  paint();

  return h('div.ig-page',
    h('div.page-head',
      h('h1', 'Photos'),
      h('span.spacer'),
      toggle,
      store.me
        ? h('a.btn', { href: '/upload?type=photo' }, icon('camera'), 'New photo post')
        : h('button.btn', { type: 'button', onclick: () => login('/upload?type=photo') }, icon('camera'), 'New photo post')),
    h('p.fine', 'Up to ten photos per post. Filters are not available. Southbag applies its own.'),
    body);
}

/** A 3-column grid square: first photo, a stack marker for carousels, counts on hover. */
function gridTile(post) {
  const first = post.media.find(m => m.kind === 'image');
  if (!first) return null;
  return h('a.ig-tile', { href: postUrl(post), dataset: { postId: post.id }, 'aria-label': post.body ? post.body.slice(0, 100) : `Photo by @${post.author.handle}` },
    h('img', { src: first.url, alt: first.alt || '', loading: 'lazy', decoding: 'async' }),
    post.media.length > 1 ? h('span.ig-tile-multi', { title: `${post.media.length} photos` }, icon('image')) : null,
    h('span.ig-tile-hover',
      h('span', icon('heart'), count(post.counts.reactions)),
      h('span', icon('comment'), count(post.counts.replies))));
}

/** The Instagram-style card. */
export function igCard(post) {
  if (!post.media.some(m => m.kind === 'image')) return null;
  const author = post.author;
  const images = post.media.filter(m => m.kind === 'image');

  // ── Like state ──
  const likes = h('button.ig-likes', { type: 'button' });
  const heartBtn = h('button.ig-action.ig-heart', { type: 'button' });
  const paint = () => {
    const on = Boolean(post.viewer.reaction);
    heartBtn.classList.toggle('on', on);
    heartBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    heartBtn.setAttribute('aria-label', on ? 'Withdraw like' : 'Like');
    heartBtn.title = on ? 'Withdraw like (processing: 1–3 business days)' : 'Like (fees apply)';
    mount(heartBtn, on && post.viewer.reaction !== 'like' ? h('span.ig-emoji', REACTIONS[post.viewer.reaction]?.emoji || '❤️') : icon('heart'));
    likes.textContent = post.counts.reactions ? plural(post.counts.reactions, 'like') : 'Be the first to like this';
    likes.classList.toggle('none', !post.counts.reactions);
  };
  let busy = false;
  const setLiked = async liked => {
    if (!store.me) return login();
    if (busy || Boolean(post.viewer.reaction) === liked) return;
    busy = true;
    const before = { reaction: post.viewer.reaction, n: post.counts.reactions };
    post.viewer.reaction = liked ? 'like' : null;
    post.counts.reactions = Math.max(0, post.counts.reactions + (liked ? 1 : -1));
    paint();
    if (liked) { heartBtn.classList.remove('pop'); void heartBtn.offsetWidth; heartBtn.classList.add('pop'); }
    try {
      const { post: fresh } = liked ? await api.put(`posts/${post.id}/reaction`, { type: 'like' }) : await api.del(`posts/${post.id}/reaction`);
      Object.assign(post, { viewer: fresh.viewer, counts: fresh.counts, reactions: fresh.reactions });
      paint();
      if (liked && Math.random() < 0.25) toast('Liked.', { fee: 'Appreciation surcharge' });
    } catch (err) {
      post.viewer.reaction = before.reaction;
      post.counts.reactions = before.n;
      paint();
      toastError(err);
    }
    busy = false;
  };
  heartBtn.addEventListener('click', () => setLiked(!post.viewer.reaction));
  likes.addEventListener('click', () => showLikers(post));
  paint();

  // ── Media: double-tap to like. Single taps are swallowed (no lightbox), like Instagram. ──
  const mediaBox = h('div.ig-media', carousel(images));
  let lastTap = 0;
  mediaBox.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    if (e.target.tagName === 'IMG') e.stopPropagation();
    const now = Date.now();
    if (now - lastTap < 320) {
      lastTap = 0;
      heartBurst(mediaBox);
      setLiked(true);
    } else lastTap = now;
  }, true);
  mediaBox.addEventListener('dblclick', e => e.preventDefault());

  // ── Bookmark ──
  const bm = h('button.ig-action', { type: 'button', 'aria-label': 'Save', class: { on: post.viewer.bookmarked } }, icon('bookmark'));
  bm.addEventListener('click', async () => {
    if (!store.me) return login();
    try {
      if (post.viewer.bookmarked) await api.del(`posts/${post.id}/bookmark`);
      else await api.put(`posts/${post.id}/bookmark`);
      post.viewer.bookmarked = !post.viewer.bookmarked;
      bm.classList.toggle('on', post.viewer.bookmarked);
      toast(post.viewer.bookmarked ? 'Saved. Southbag saved a copy too.' : 'Unsaved. The copy we kept is not.');
    } catch (err) { toastError(err); }
  });

  // ── Caption, clamped until "more" ──
  let caption = null;
  if (post.body) {
    const moreBtn = h('button.ig-more', { type: 'button' }, 'more');
    caption = h('div.ig-caption.clamped',
      h('a.ig-handle', { href: `/@${author.handle}` }, author.handle), ' ',
      h('span', richText(post.body)));
    const long = post.body.length > 110 || post.body.split('\n').length > 2;
    if (!long) caption.classList.remove('clamped');
    const text = caption;
    moreBtn.addEventListener('click', () => { text.classList.remove('clamped'); moreBtn.remove(); });
    caption = h('div', text, long ? moreBtn : null);
  }

  const moreMenu = h('button.icon-btn', { type: 'button', 'aria-label': 'More options' }, icon('more'));
  const card = h('article.ig-card', { dataset: { postId: post.id } });
  moreMenu.addEventListener('click', () => menu(moreMenu, [
    { label: 'Go to post', icon: 'link', href: postUrl(post) },
    { label: 'Copy link', icon: 'share', onClick: () => share(postUrl(post)) },
    { label: 'Why am I seeing this?', icon: 'eye', onClick: () => dialog({ title: 'Algorithmic transparency', body: 'Kevin.' }) },
    post.viewer.can_edit
      ? { label: 'Request deletion', icon: 'trash', danger: true, onClick: async () => {
          if (!(await confirm('Request deletion of this post? Deletion is advisory.', { ok: 'Request deletion' }))) return;
          try { await api.del(`posts/${post.id}`); card.remove(); toast('Deletion request filed. Photos are never fully deleted.'); }
          catch (err) { toastError(err); }
        } }
      : { label: 'Report to Kevin', icon: 'flag', onClick: () => toast('Reported. Kevin has already seen it.') },
  ]));

  mount(card,
    h('header.ig-head',
      avatar(author, { size: 'sm' }),
      h('div.grow',
        h('a.ig-handle', { href: `/@${author.handle}` }, author.handle, author.verified ? verifiedBadge() : null),
        h('span.ig-dot', ' • '),
        h('time.muted', { datetime: new Date(post.created_at).toISOString(), title: fullDate(post.created_at) }, relative(post.created_at))),
      moreMenu),
    mediaBox,
    h('div.ig-actions',
      heartBtn,
      h('a.ig-action', { href: `${postUrl(post)}#reply`, 'aria-label': 'Comment' }, icon('comment')),
      h('button.ig-action', { type: 'button', 'aria-label': 'Share', onclick: () => share(postUrl(post)) }, icon('send')),
      h('span.spacer'),
      bm),
    likes,
    caption,
    post.counts.replies
      ? h('a.ig-comments', { href: postUrl(post) }, post.counts.replies === 1 ? 'View 1 comment' : `View all ${count(post.counts.replies)} comments`)
      : h('a.ig-comments', { href: `${postUrl(post)}#reply` }, 'Add a comment. Say something compliant.'),
    h('div.ig-time', relative(post.created_at)));
  return card;
}

async function showLikers(post) {
  if (!post.counts.reactions) return;
  try {
    const { items } = await api.get(`posts/${post.id}/reactions`);
    dialog({
      title: 'Likes (fees apply)',
      body: h('div', items.length
        ? items.map(r => h('div.user-row', avatar(r.user, { size: 'sm' }),
          h('div.grow', h('a', { href: `/@${r.user.handle}`, onclick: () => document.querySelector('.overlay')?.remove() }, r.user.name), h('span.muted', ` @${r.user.handle}`)),
          h('span', REACTIONS[r.type]?.emoji || '❤️')))
        : h('p', 'Nobody. Kevin liked it privately.')),
    });
  } catch (err) { toastError(err); }
}

