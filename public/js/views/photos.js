// /photos: a feed of photo posts (or a 3-column grid). Every photo sits in a square and is
// stretched to fill it.
//   GET /api/videos/feed?kind=photo&cursor -> { items, next }
// Double-tap a photo to like it. The feed/grid choice is remembered per browser.

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { count, fullDate, plural, relative } from '../format.js';
import { login, store } from '../store.js';
import { dialog, empty, infiniteList, menu, refuseDelete, share, toast, toastError } from '../ui.js';
import { carousel } from '../components/media.js';
import { REACTIONS, postUrl, richText } from '../components/post.js';
import { avatar, verifiedBadge } from '../components/user.js';
import { likedNote } from './videos.js';

const VIEW_KEY = 'sb_photos_view';
const readView = () => { try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'feed'; } catch { return 'feed'; } };
const writeView = v => { try { localStorage.setItem(VIEW_KEY, v); } catch {} };

export default async function photos(ctx) {
  ctx.layout('default');
  ctx.title('Photos');
  let view = ctx.query.get('view') === 'grid' ? 'grid' : ctx.query.get('view') === 'feed' ? 'feed' : readView();

  const body = h('div');
  const toggle = h('div.ig-toggle', { role: 'group', 'aria-label': 'Layout' });
  const paintToggle = () => mount(toggle,
    [['feed', 'Feed'], ['grid', 'Grid']].map(([key, label]) => h('button.icon-btn', {
      type: 'button', 'aria-pressed': view === key ? 'true' : 'false',
      onclick: () => { if (view === key) return; view = key; writeView(key); paintToggle(); paint(); },
    }, label)));

  function paint() {
    mount(body, infiniteList({
      className: view === 'grid' ? 'ig-grid' : 'ig-feed',
      signal: ctx.signal,
      load: cursor => api.get('videos/feed', { kind: 'photo', cursor, limit: view === 'grid' ? 30 : 12 }, { signal: ctx.signal }),
      render: post => (view === 'grid' ? gridTile(post) : igCard(post)),
      empty: empty({
        title: 'No photos yet.',
        action: store.me ? h('a.btn', { href: '/upload?type=photo' }, 'New post') : null,
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
        ? h('a.btn', { href: '/upload?type=photo' }, 'New post')
        : h('button.btn', { type: 'button', onclick: () => login('/upload?type=photo') }, 'New post')),
    body);
}

/** A grid square: the first photo stretched to fill it, a count for carousels, totals on hover. */
function gridTile(post) {
  const first = post.media.find(m => m.kind === 'image');
  if (!first) return null;
  return h('a.ig-tile', { href: postUrl(post), dataset: { postId: post.id }, 'aria-label': post.body ? post.body.slice(0, 100) : `Photo by @${post.author.handle}` },
    h('img', { src: first.url, alt: first.alt || '', loading: 'lazy', decoding: 'async' }),
    post.media.length > 1 ? h('span.ig-tile-multi', `${post.media.length} photos`) : null,
    h('span.ig-tile-hover',
      h('span', plural(post.counts.reactions, 'like')),
      h('span', plural(post.counts.replies, 'comment'))));
}

/** A photo post card: header, square carousel, actions, likes, caption, comments link. */
export function igCard(post) {
  if (!post.media.some(m => m.kind === 'image')) return null;
  const author = post.author;
  const images = post.media.filter(m => m.kind === 'image');

  // -- Like state --
  const likes = h('button.btn-small.ig-likes', { type: 'button' });
  const likeBtn = h('button.icon-btn', { type: 'button' });
  const paint = () => {
    const r = post.viewer.reaction;
    likeBtn.setAttribute('aria-pressed', r ? 'true' : 'false');
    likeBtn.textContent = !r ? 'Like' : r === 'like' ? 'Liked' : REACTIONS[r]?.label || 'Liked';
    likes.textContent = plural(post.counts.reactions, 'like');
    likes.classList.toggle('hidden', !post.counts.reactions);
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
    try {
      const { post: fresh } = liked ? await api.put(`posts/${post.id}/reaction`, { type: 'like' }) : await api.del(`posts/${post.id}/reaction`);
      Object.assign(post, { viewer: fresh.viewer, counts: fresh.counts, reactions: fresh.reactions });
      paint();
    } catch (err) {
      post.viewer.reaction = before.reaction;
      post.counts.reactions = before.n;
      paint();
      toastError(err);
    }
    busy = false;
  };
  likeBtn.addEventListener('click', () => setLiked(!post.viewer.reaction));
  likes.addEventListener('click', () => showLikers(post));
  paint();

  // -- Media: double-tap to like. Single taps are swallowed (no lightbox). --
  const mediaBox = h('div.ig-media', carousel(images));
  let lastTap = 0;
  mediaBox.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    if (e.target.tagName === 'IMG') e.stopPropagation();
    const now = Date.now();
    if (now - lastTap < 320) {
      lastTap = 0;
      likedNote(mediaBox);
      setLiked(true);
    } else lastTap = now;
  }, true);
  mediaBox.addEventListener('dblclick', e => e.preventDefault());

  // -- Save --
  const bm = h('button.icon-btn', { type: 'button', 'aria-pressed': post.viewer.bookmarked ? 'true' : 'false' }, post.viewer.bookmarked ? 'Saved' : 'Save');
  bm.addEventListener('click', async () => {
    if (!store.me) return login();
    try {
      if (post.viewer.bookmarked) await api.del(`posts/${post.id}/bookmark`);
      else await api.put(`posts/${post.id}/bookmark`);
      post.viewer.bookmarked = !post.viewer.bookmarked;
      bm.textContent = post.viewer.bookmarked ? 'Saved' : 'Save';
      bm.setAttribute('aria-pressed', post.viewer.bookmarked ? 'true' : 'false');
      toast(post.viewer.bookmarked ? 'Saved.' : 'Removed from saved.');
    } catch (err) { toastError(err); }
  });

  // -- Caption, clamped until "More" --
  let caption = null;
  if (post.body) {
    const moreBtn = h('button.btn-small.ig-more', { type: 'button' }, 'More');
    const text = h('div.ig-caption.clamped',
      h('a.ig-handle', { href: `/@${author.handle}` }, author.handle), ' ',
      h('span', richText(post.body)));
    const long = post.body.length > 110 || post.body.split('\n').length > 2;
    if (!long) text.classList.remove('clamped');
    moreBtn.addEventListener('click', () => { text.classList.remove('clamped'); moreBtn.remove(); });
    caption = h('div', text, long ? moreBtn : null);
  }

  const moreMenu = h('button.icon-btn', { type: 'button' }, 'More');
  const card = h('article.ig-card', { dataset: { postId: post.id } });
  moreMenu.addEventListener('click', () => menu(moreMenu, [
    { label: 'Go to post', href: postUrl(post) },
    { label: 'Copy link', onClick: () => share(postUrl(post)) },
    post.viewer.can_edit
      ? { label: 'Delete', onClick: refuseDelete }
      : { label: 'Report', onClick: () => toast('Reported.') },
  ]));

  mount(card,
    h('header.ig-head',
      avatar(author, { size: 'sm' }),
      h('div.grow',
        h('a.ig-handle', { href: `/@${author.handle}` }, author.handle, author.verified ? verifiedBadge() : null),
        h('time.muted', { datetime: new Date(post.created_at).toISOString(), title: fullDate(post.created_at) }, relative(post.created_at))),
      moreMenu),
    mediaBox,
    h('div.ig-actions',
      likeBtn,
      h('a.icon-btn', { href: `${postUrl(post)}#reply` }, 'Comment'),
      h('button.icon-btn', { type: 'button', onclick: () => share(postUrl(post)) }, 'Share'),
      h('span.spacer'),
      bm),
    likes,
    caption,
    post.counts.replies
      ? h('a.ig-comments', { href: postUrl(post) }, post.counts.replies === 1 ? 'View 1 comment' : `View all ${count(post.counts.replies)} comments`)
      : h('a.ig-comments', { href: `${postUrl(post)}#reply` }, 'Add a comment'));
  return card;
}

async function showLikers(post) {
  if (!post.counts.reactions) return;
  try {
    const { items } = await api.get(`posts/${post.id}/reactions`);
    dialog({
      title: 'Likes',
      body: h('div', items.length
        ? items.map(r => h('div.user-row', avatar(r.user, { size: 'sm' }),
          h('div.grow', h('a', { href: `/@${r.user.handle}`, onclick: () => document.querySelector('.overlay')?.remove() }, r.user.name), h('span.muted', ` @${r.user.handle}`)),
          h('span', REACTIONS[r.type]?.label || 'Like')))
        : h('p', 'No likes yet.')),
    });
  } catch (err) { toastError(err); }
}
