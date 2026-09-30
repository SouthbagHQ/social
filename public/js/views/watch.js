// /watch/:id: the player (a 16:9 box; every video is stretched to fill it), title, channel row,
// actions, description, comments, and "Up next" on the right (below on narrow screens).
//   GET  /api/posts/:id                    the video
//   GET  /api/videos/:id/related           up next
//   GET  /api/posts/:id/replies?sort       comments
//   POST /api/posts/:id/view               once, about three seconds into playback
// Keys: space/k play or pause, j/l back or forward 10 s, f fullscreen, m mute (ignored while typing).

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { fullDate, plural, relative } from '../format.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, errorBox, infiniteList, menu, share, toast, toastError } from '../ui.js';
import { videoEl } from '../components/media.js';
import { postCard, reactionButton, richText } from '../components/post.js';
import { composer } from '../components/composer.js';
import { avatar, followButton, verifiedBadge } from '../components/user.js';
import { channelInfo, isTyping, videoCard } from './videos.js';

const VIEW_AFTER = 3; // seconds of actual playback before a view counts

export default async function watch(ctx) {
  ctx.layout('wide');
  const id = ctx.params.id;
  let post;
  try {
    ({ post } = await api.get(`posts/${id}`, null, { signal: ctx.signal }));
  } catch (err) {
    if (err.name === 'AbortError') return null;
    ctx.title('Video unavailable');
    return h('div.south-card.flat',
      h('h1', 'Video not available.'),
      errorBox(err),
      h('a.btn', { href: '/videos' }, 'Back to videos'));
  }
  if (post.kind === 'short') { navigate(`/shorts/${post.id}`, { replace: true }); return null; }
  if (post.kind !== 'video' || post.deleted) { navigate(`/post/${post.id}`, { replace: true }); return null; }
  const media = post.media.find(m => m.kind === 'video');
  if (!media) { navigate(`/post/${post.id}`, { replace: true }); return null; }
  ctx.title(post.title);

  // -- Player --
  const video = videoEl(media, { controls: true, autoplay: false, preload: 'auto' });
  video.setAttribute('aria-label', post.title);
  const unmuteBtn = h('button.watch-unmute.hidden', { type: 'button', onclick: () => { video.muted = false; unmuteBtn.classList.add('hidden'); } },
    'Unmute');
  const upNext = h('div.watch-upnext.hidden');
  const player = h('div.watch-player', video, unmuteBtn, upNext);

  // Autoplay with sound if the browser allows it, muted otherwise.
  video.play().catch(() => {
    video.muted = true;
    video.play().then(() => unmuteBtn.classList.remove('hidden')).catch(() => {});
  });
  video.addEventListener('volumechange', () => { if (!video.muted) unmuteBtn.classList.add('hidden'); });

  // Count a view after VIEW_AFTER seconds of real playback (seeking doesn't count), or at the end.
  const viewsEl = h('span', plural(post.counts.views, 'view'));
  let played = 0, lastTime = 0, counted = false;
  const countView = () => {
    if (counted) return;
    counted = true;
    api.post(`posts/${post.id}/view`).then(({ views }) => {
      post.counts.views = views;
      viewsEl.textContent = plural(views, 'view');
    }).catch(() => {});
  };
  video.addEventListener('timeupdate', () => {
    const t = video.currentTime;
    const step = t - lastTime;
    if (step > 0 && step < 1.5 && !video.paused) played += step;
    lastTime = t;
    if (played >= Math.min(VIEW_AFTER, (video.duration || VIEW_AFTER) * 0.9)) countView();
  });
  video.addEventListener('seeking', () => { lastTime = video.currentTime; });
  video.addEventListener('ended', countView);

  // -- Title, meta, channel row, actions --
  const titleEl = h('h1.watch-title', post.title);
  const channelCount = h('span.watch-subs', '\u00a0');
  const followSlot = h('span');
  const author = post.author;
  channelInfo(author.handle).then(info => {
    if (ctx.signal.aborted) return;
    if (info?.follower_count != null) channelCount.textContent = plural(info.follower_count, 'follower');
    else channelCount.textContent = `@${author.handle}`;
    if (store.me?.id !== author.id) {
      mount(followSlot, followButton({ ...author, is_following: Boolean(info?.is_following) }, {
        small: false,
        onChange: following => {
          if (info?.follower_count == null) return;
          info.follower_count += following ? 1 : -1;
          info.is_following = following;
          channelCount.textContent = plural(info.follower_count, 'follower');
        },
      }));
    }
  });

  const bookmarkBtn = h('button.icon-btn', { type: 'button', 'aria-pressed': post.viewer.bookmarked ? 'true' : 'false' }, post.viewer.bookmarked ? 'Saved' : 'Save');
  bookmarkBtn.addEventListener('click', async () => {
    if (!store.me) return login();
    try {
      if (post.viewer.bookmarked) await api.del(`posts/${post.id}/bookmark`);
      else await api.put(`posts/${post.id}/bookmark`);
      post.viewer.bookmarked = !post.viewer.bookmarked;
      bookmarkBtn.setAttribute('aria-pressed', post.viewer.bookmarked ? 'true' : 'false');
      bookmarkBtn.textContent = post.viewer.bookmarked ? 'Saved' : 'Save';
      toast(post.viewer.bookmarked ? 'Saved.' : 'Removed from saved.');
    } catch (err) { toastError(err); }
  });

  const moreBtn = h('button.icon-btn', { type: 'button' }, 'More');
  moreBtn.addEventListener('click', () => menu(moreBtn, [
    { label: 'Copy link at current time', onClick: () => share(`/watch/${post.id}?t=${Math.floor(video.currentTime)}`, post.title) },
    post.viewer.can_edit ? { label: 'Edit', onClick: amend } : null,
    post.viewer.can_edit ? { label: 'Delete', onClick: remove } : null,
    !post.viewer.can_edit ? { label: 'Report', onClick: () => toast('Reported.') } : null,
  ]));

  const actions = h('div.watch-actions',
    reactionButton(post),
    h('button.icon-btn', { type: 'button', onclick: () => share(`/watch/${post.id}`, post.title) }, 'Share'),
    bookmarkBtn,
    moreBtn);

  const channelRow = h('div.watch-channel',
    avatar(author),
    h('div.grow',
      h('a.watch-channel-name', { href: `/@${author.handle}` }, author.name, author.verified ? verifiedBadge() : null),
      channelCount),
    followSlot);

  // -- Description (collapsed until clicked) --
  const descText = h('div.watch-desc-text', post.body ? richText(post.body) : h('span.muted', 'No description.'));
  const toggle = h('button.btn-small.watch-desc-toggle', { type: 'button' }, 'More');
  const desc = h('div.watch-desc.collapsed',
    h('div.watch-desc-meta', viewsEl, h('span', { title: fullDate(post.created_at) }, relative(post.created_at)),
      post.visibility !== 'public' ? h('span', post.visibility === 'followers' ? 'Followers only' : 'Friends only') : null,
      post.edited_at ? h('span', { title: `Edited ${fullDate(post.edited_at)}` }, 'Edited') : null),
    descText,
    h('p.fine.watch-desc-legal', `Published ${fullDate(post.created_at)}.`),
    toggle);
  const setCollapsed = collapsed => {
    desc.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? 'More' : 'Less';
  };
  desc.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    if (e.target === toggle) return setCollapsed(!desc.classList.contains('collapsed'));
    if (desc.classList.contains('collapsed')) setCollapsed(false);
  });

  // -- Comments --
  let sort = 'top';
  const commentCount = h('h2.watch-comments-title', `${plural(post.counts.replies, 'comment')}`);
  const sortBtn = h('button.btn-small', { type: 'button' }, 'Sort: Top');
  const listHost = h('div');
  const paintComments = () => mount(listHost, infiniteList({
    className: 'watch-comment-list',
    signal: ctx.signal,
    load: cursor => api.get(`posts/${post.id}/replies`, { cursor, sort: sort === 'top' ? 'top' : 'new' }, { signal: ctx.signal }),
    render: reply => postCard(reply, { compact: true, card: false, link: true }),
    empty: empty({ title: 'No comments yet.' }),
  }));
  sortBtn.addEventListener('click', () => menu(sortBtn, [
    { label: 'Top', onClick: () => { sort = 'top'; sortBtn.textContent = 'Sort: Top'; paintComments(); } },
    { label: 'Newest', onClick: () => { sort = 'new'; sortBtn.textContent = 'Sort: Newest'; paintComments(); } },
  ]));
  paintComments();
  const comments = h('section.watch-comments', { id: 'comments' },
    h('div.row', commentCount, sortBtn),
    composer({
      replyTo: post,
      compact: true,
      placeholder: 'Add a comment',
      submitLabel: 'Comment',
      onPosted: reply => {
        post.counts.replies++;
        commentCount.textContent = plural(post.counts.replies, 'comment');
        listHost.firstChild?.prepend(postCard(reply, { compact: true, card: false }));
        toast('Posted.');
      },
    }),
    listHost);

  // -- Up next --
  const related = h('aside.watch-related', { 'aria-label': 'Up next' }, h('h2.watch-related-title', 'Up next'), h('div.loading', 'Loading'));
  let nextVideo = null;
  api.get(`videos/${post.id}/related`, { limit: 12 }, { signal: ctx.signal }).then(({ items }) => {
    nextVideo = items[0] || null;
    mount(related, h('h2.watch-related-title', 'Up next'),
      items.length ? items.map(p => videoCard(p, { compact: true }))
        : h('p.muted', 'No other videos.'));
  }).catch(err => { if (err.name !== 'AbortError') mount(related, h('h2.watch-related-title', 'Up next'), h('p.muted', 'Could not load videos.')); });

  // Play the next video after a short countdown.
  let upNextTimer = null;
  const cancelUpNext = () => { clearInterval(upNextTimer); upNextTimer = null; upNext.classList.add('hidden'); };
  video.addEventListener('ended', () => {
    if (!nextVideo || video.loop) return;
    let left = 8;
    const label = h('strong');
    const paint = () => { label.textContent = `Up next in ${left}`; };
    paint();
    mount(upNext,
      label,
      h('div.watch-upnext-title', nextVideo.title),
      h('div.row',
        h('button.btn-small', { type: 'button', onclick: cancelUpNext }, 'Cancel'),
        h('a.btn-small', { href: `/watch/${nextVideo.id}` }, 'Play now')));
    upNext.classList.remove('hidden');
    upNextTimer = setInterval(() => {
      left--;
      paint();
      if (left <= 0) { cancelUpNext(); navigate(`/watch/${nextVideo.id}`); }
    }, 1000);
  });
  video.addEventListener('play', cancelUpNext);
  video.addEventListener('seeking', () => { if (upNextTimer) cancelUpNext(); });

  // Start at ?t= seconds (shared links).
  const startAt = Number(ctx.query.get('t'));
  if (startAt > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(startAt, video.duration || startAt); }, { once: true });

  // -- Keyboard --
  const onKey = e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
    const onControl = e.target.closest?.('button, a, [role="button"]') && e.target !== video;
    switch (e.key) {
      case ' ': case 'k': case 'K':
        if (e.key === ' ' && onControl) return;
        e.preventDefault();
        video.paused ? video.play().catch(() => {}) : video.pause();
        break;
      case 'j': case 'J': e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 10); break;
      case 'l': case 'L': e.preventDefault(); video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); break;
      case 'm': case 'M': e.preventDefault(); video.muted = !video.muted; break;
      case 'f': case 'F':
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else (player.requestFullscreen?.() || video.webkitEnterFullscreen?.())?.catch?.(() => {});
        break;
      default: return;
    }
  };
  document.addEventListener('keydown', onKey);

  ctx.cleanup(() => {
    document.removeEventListener('keydown', onKey);
    cancelUpNext();
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  });

  async function amend() {
    let title, body;
    const ok = await dialog({
      title: 'Edit video',
      wide: true,
      body: h('div',
        h('label.field', h('span', 'Title'), title = h('input.input', { value: post.title || '', maxLength: 120 })),
        h('label.field', h('span', 'Description'), body = h('textarea.textarea.boxed', { rows: 6, maxLength: 2200 }, post.body))),
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }],
    });
    if (!ok) return;
    try {
      const { post: fresh } = await api.patch(`posts/${post.id}`, { title: title.value, body: body.value });
      Object.assign(post, { title: fresh.title, body: fresh.body, edited_at: fresh.edited_at });
      titleEl.textContent = fresh.title;
      mount(descText, fresh.body ? richText(fresh.body) : h('span.muted', 'No description.'));
      ctx.title(fresh.title);
      toast('Saved.');
    } catch (err) { toastError(err); }
  }

  async function remove() {
    if (!(await confirm('Delete this video?', { title: 'Delete video', ok: 'Delete' }))) return;
    try {
      await api.del(`posts/${post.id}`);
      toast('Deleted.');
      navigate('/videos');
    } catch (err) { toastError(err); }
  }

  return h('div.watch',
    h('div.watch-primary',
      player,
      titleEl,
      h('div.watch-bar', channelRow, actions),
      desc,
      comments),
    related);
}

