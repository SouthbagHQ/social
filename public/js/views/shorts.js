// /shorts and /shorts/:id — TikTok: a full-height vertical feed, one short per screen.
//   GET  /api/posts/:id                     the short in the URL (shown first)
//   GET  /api/videos/shorts?cursor          the "for you" queue
//   POST /api/posts/:id/view                once per short, after a couple of seconds
//   GET  /api/posts/:id/replies             the comments panel
//
// Bandwidth: videos come out of D1 in 1.5 MiB range chunks, so only the visible short loads
// properly; the next one preloads metadata; anything more than two away is unloaded.

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { count, plural, timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, infiniteList, menu, share, toast, toastError } from '../ui.js';
import { composer } from '../components/composer.js';
import { postCard, reactionButton, richText } from '../components/post.js';
import { avatar } from '../components/user.js';
import { channelInfo, heartBurst, isTyping } from './videos.js';

const MUTE_KEY = 'sb_shorts_muted';
const VIEW_AFTER = 2; // seconds of playback

const readMuted = () => { try { return localStorage.getItem(MUTE_KEY) !== '0'; } catch { return true; } };
const writeMuted = muted => { try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch {} };

export default async function shorts(ctx) {
  ctx.layout('full');
  ctx.title('Shorts');

  const state = {
    items: [],        // { post, el, video, ... }
    ids: new Set(),
    active: -1,
    next: undefined,  // queue cursor; null = end
    loading: false,
    muted: readMuted(),
    viewed: new Set(),
    panel: null,      // open comments panel
  };

  const feed = h('div.shorts-feed', { tabIndex: -1, 'aria-label': 'Shorts' });
  const endCard = h('section.short.short-end.hidden',
    h('div.short-end-inner',
      icon('shorts'),
      h('h2', 'You have reached the end.'),
      h('p', 'Southbag has decided you have had enough. Your watch history has been retained.'),
      h('div.row.wrap', { style: 'justify-content:center' },
        h('button.btn', { type: 'button', onclick: () => go(-state.active) }, 'Start again'),
        store.me ? h('a.btn.outline', { href: '/upload?type=short' }, 'Upload a short') : null)));
  const upBtn = h('button.shorts-nav-btn', { type: 'button', 'aria-label': 'Previous short', onclick: () => go(-1) }, icon('chevron-up'));
  const downBtn = h('button.shorts-nav-btn', { type: 'button', 'aria-label': 'Next short', onclick: () => go(1) }, icon('chevron-down'));
  const panelHost = h('div.shorts-panel-host');
  const page = h('div.shorts-page', feed, h('div.shorts-nav', upBtn, downBtn), panelHost);

  // ── Initial content ──
  const first = ctx.params.id;
  if (first) {
    try {
      const { post } = await api.get(`posts/${first}`, null, { signal: ctx.signal });
      if (post.kind === 'video') { navigate(`/watch/${post.id}`, { replace: true }); return null; }
      if (post.kind !== 'short' || post.deleted) { navigate(`/post/${post.id}`, { replace: true }); return null; }
      addItem(post);
    } catch (err) {
      if (err.name === 'AbortError') return null;
      toast('That short is unavailable. Here are some others. Kevin chose them.', { error: true });
    }
  }
  await loadMore();
  if (ctx.signal.aborted) return null;
  feed.append(endCard);

  if (!state.items.length) {
    return h('div.shorts-page.shorts-empty',
      h('div.short-end-inner',
        empty({
          icon: 'shorts',
          title: 'No shorts yet.',
          text: 'Nobody has uploaded a vertical video. Kevin is reviewing the horizontal ones in the meantime.',
          action: store.me ? h('a.btn', { href: '/upload?type=short' }, 'Upload a short') : h('button.btn', { type: 'button', onclick: () => login('/upload?type=short') }, 'Log in to upload'),
        })));
  }

  // ── Visibility tracking ──
  const observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio >= 0.6) {
        const i = state.items.findIndex(it => it.el === e.target);
        if (i !== -1) activate(i);
      }
    }
  }, { root: feed, threshold: [0.6] });
  state.items.forEach(it => observer.observe(it.el));

  // Fit the feed to the space under the site header (or the whole screen on phones).
  const fit = () => {
    const bar = document.querySelector('.bottom-bar');
    const barH = bar && getComputedStyle(bar).display !== 'none' ? bar.offsetHeight : 0;
    page.style.setProperty('--shorts-bottom', `${barH}px`);
    const top = Math.max(0, page.getBoundingClientRect().top + window.scrollY);
    page.style.setProperty('--shorts-top', `${top}px`);
  };
  const onResize = () => { fit(); snapTo(state.active, 'instant'); };
  window.addEventListener('resize', onResize);
  requestAnimationFrame(() => { window.scrollTo(0, 0); fit(); });

  // ── Input ──
  let wheelLockUntil = 0, wheelQuietTimer = null, wheelLocked = false, wheelAccum = 0;
  feed.addEventListener('wheel', e => {
    if (e.ctrlKey || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    e.preventDefault();
    clearTimeout(wheelQuietTimer);
    // One move per gesture: stay locked until the wheel (or trackpad inertia) goes quiet.
    wheelQuietTimer = setTimeout(() => { if (Date.now() >= wheelLockUntil) wheelLocked = false; else setTimeout(() => { wheelLocked = false; }, wheelLockUntil - Date.now()); wheelAccum = 0; }, 160);
    if (wheelLocked) return;
    wheelAccum += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (Math.abs(wheelAccum) < 24) return;
    wheelLocked = true;
    wheelLockUntil = Date.now() + 450;
    go(wheelAccum > 0 ? 1 : -1);
    wheelAccum = 0;
  }, { passive: false });

  const onKey = e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
    const onControl = e.target.closest?.('button, a');
    switch (e.key) {
      case 'ArrowDown': case 'PageDown': e.preventDefault(); go(1); break;
      case 'ArrowUp': case 'PageUp': e.preventDefault(); go(-1); break;
      case ' ': case 'k': case 'K':
        if (e.key === ' ' && onControl) return;
        e.preventDefault(); togglePlay(); break;
      case 'm': case 'M': e.preventDefault(); setMuted(!state.muted); break;
      case 'c': case 'C': e.preventDefault(); if (state.items[state.active]) openComments(state.items[state.active].post); break;
      case 'Escape': if (state.panel) { e.preventDefault(); closeComments(); } break;
      default: return;
    }
  };
  document.addEventListener('keydown', onKey);

  ctx.cleanup(() => {
    observer.disconnect();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    clearTimeout(wheelQuietTimer);
    for (const it of state.items) unload(it);
    closeComments();
  });

  // Start at the top.
  requestAnimationFrame(() => { feed.scrollTop = 0; feed.focus({ preventScroll: true }); if (state.active === -1) activate(0); });
  return page;

  // ── Functions ──

  async function loadMore() {
    if (state.loading || state.next === null) return;
    state.loading = true;
    try {
      const data = await api.get('videos/shorts', { cursor: state.next }, { signal: ctx.signal });
      state.next = data.next;
      for (const post of data.items) {
        const it = addItem(post);
        if (it && observerReady()) observer.observe(it.el);
      }
    } catch (err) {
      if (err.name !== 'AbortError') toastError(err);
      state.next = null;
    }
    state.loading = false;
    endCard.classList.toggle('hidden', state.next !== null || !state.items.length);
  }

  function observerReady() { try { return Boolean(observer); } catch { return false; } }

  function addItem(post) {
    if (state.ids.has(post.id)) return null;
    const media = post.media.find(m => m.kind === 'video');
    if (!media) return null;
    state.ids.add(post.id);
    const it = { post, media, index: state.items.length };
    it.el = buildShort(it);
    state.items.push(it);
    if (endCard.isConnected) feed.insertBefore(it.el, endCard);
    else feed.append(it.el);
    return it;
  }

  function buildShort(it) {
    const { post, media } = it;
    const vertical = media.height && media.width ? media.height / media.width >= 1.4 : true;
    const video = h('video', {
      poster: media.poster_url || undefined, playsInline: true, loop: true, muted: state.muted, preload: 'none',
      class: { cover: vertical }, 'aria-label': post.body ? `Short by @${post.author.handle}: ${post.body.slice(0, 80)}` : `Short by @${post.author.handle}`,
    });
    it.video = video;
    const pausedIcon = h('span.short-paused.hidden', { 'aria-hidden': 'true' }, icon('play'));
    const progress = h('div.short-progress-fill');
    const progressBar = h('div.short-progress', { role: 'slider', 'aria-label': 'Seek', tabIndex: -1 }, progress);
    const muteBtn = h('button.short-mute', { type: 'button', 'aria-label': state.muted ? 'Unmute' : 'Mute', onclick: e => { e.stopPropagation(); setMuted(!state.muted); } },
      icon(state.muted ? 'mute' : 'volume'));
    it.muteBtn = muteBtn;
    it.pausedIcon = pausedIcon;

    // Tap to pause; double tap to like.
    let tapTimer = null;
    const stage = h('div.short-stage', video, pausedIcon, muteBtn, progressBar, caption(post));
    stage.addEventListener('click', e => {
      if (e.target.closest('a, button, .short-progress')) return;
      if (tapTimer) {
        clearTimeout(tapTimer); tapTimer = null;
        heartBurst(stage);
        if (!post.viewer.reaction) likeQuietly(it);
        return;
      }
      tapTimer = setTimeout(() => { tapTimer = null; togglePlay(); }, 260);
    });
    video.addEventListener('timeupdate', () => {
      if (video.duration) progress.style.width = `${(video.currentTime / video.duration) * 100}%`;
      trackView(it);
    });
    video.addEventListener('play', () => pausedIcon.classList.add('hidden'));
    video.addEventListener('pause', () => { if (state.items[state.active] === it) pausedIcon.classList.remove('hidden'); });
    progressBar.addEventListener('click', e => {
      e.stopPropagation();
      const r = progressBar.getBoundingClientRect();
      if (video.duration) video.currentTime = ((e.clientX - r.left) / r.width) * video.duration;
    });

    it.rail = rail(it);
    return h('section.short', { dataset: { postId: post.id } }, stage, it.rail);
  }

  function caption(post) {
    const text = post.body ? h('div.short-caption-text', richText(post.body)) : null;
    const box = h('div.short-caption',
      h('div.short-caption-head',
        h('a.short-handle', { href: `/@${post.author.handle}` }, `@${post.author.handle}`),
        h('span.short-time', `· ${timeAgo(post.created_at)}`)),
      text,
      h('div.short-sound', icon('volume'), h('span', `Original audio — @${post.author.handle}. Rights retained by Southbag.`)));
    if (text) {
      text.addEventListener('click', e => { if (!e.target.closest('a')) { e.stopPropagation(); box.classList.toggle('expanded'); } });
    }
    return box;
  }

  function rail(it) {
    const { post } = it;
    const author = post.author;
    const plus = h('button.short-follow.hidden', { type: 'button', 'aria-label': `Add @${author.handle} to The Pile`, title: 'Add to The Pile' }, icon('plus'));
    if (store.me?.id !== author.id) {
      plus.classList.remove('hidden');
      plus.addEventListener('click', async e => {
        e.stopPropagation();
        if (!store.me) return login();
        plus.disabled = true;
        try {
          await api.put(`users/${author.handle}/follow`);
          toast(`@${author.handle} has been added to The Pile.`);
          markFollowing(author.handle);
        } catch (err) { toastError(err); plus.disabled = false; }
      });
    }
    it.plus = plus;
    const commentCount = h('span', count(post.counts.replies));
    it.commentCount = commentCount;
    const bookmark = h('button.rail-btn', { type: 'button', 'aria-label': 'Bookmark', class: { on: post.viewer.bookmarked } }, h('span.rail-icon', icon('bookmark')), h('span', 'Save'));
    bookmark.addEventListener('click', async e => {
      e.stopPropagation();
      if (!store.me) return login();
      try {
        if (post.viewer.bookmarked) await api.del(`posts/${post.id}/bookmark`);
        else await api.put(`posts/${post.id}/bookmark`);
        post.viewer.bookmarked = !post.viewer.bookmarked;
        bookmark.classList.toggle('on', post.viewer.bookmarked);
        toast(post.viewer.bookmarked ? 'Saved. Southbag saved a copy too.' : 'Unsaved. The copy we kept is not.');
      } catch (err) { toastError(err); }
    });
    const more = h('button.rail-btn', { type: 'button', 'aria-label': 'More' }, h('span.rail-icon', icon('more')));
    more.addEventListener('click', e => {
      e.stopPropagation();
      menu(more, [
        { label: 'Open as post', icon: 'link', href: `/post/${post.id}` },
        { label: 'Why am I seeing this?', icon: 'eye', onClick: () => dialog({ title: 'Algorithmic transparency', body: 'Kevin.' }) },
        post.viewer.can_edit
          ? { label: 'Request deletion', icon: 'trash', danger: true, onClick: () => removeShort(it) }
          : { label: 'Report to Kevin', icon: 'flag', onClick: () => toast('Reported. Kevin has already seen it.') },
      ]);
    });
    const like = reactionButton(post);
    return h('div.short-rail',
      h('div.short-author', avatar(author, { size: 'lg' }), plus),
      h('div.rail-like', like),
      h('button.rail-btn', { type: 'button', 'aria-label': 'Comments', onclick: e => { e.stopPropagation(); openComments(post); } },
        h('span.rail-icon', icon('comment')), commentCount),
      bookmark,
      h('button.rail-btn', { type: 'button', 'aria-label': 'Share', onclick: e => { e.stopPropagation(); share(`/shorts/${post.id}`, post.body || 'A short on Southbag Social'); } },
        h('span.rail-icon', icon('share')), h('span', 'Share')),
      more);
  }

  function markFollowing(handle) {
    for (const it of state.items) if (it.post.author.handle === handle) it.plus.classList.add('hidden');
  }

  async function likeQuietly(it) {
    if (!store.me) return login();
    const btn = it.rail.querySelector('.rail-like button');
    btn?.click();
  }

  async function removeShort(it) {
    if (!(await confirm('Request deletion of this short? Deletion is advisory. The short is still retained.', { ok: 'Request deletion' }))) return;
    try {
      await api.del(`posts/${it.post.id}`);
      toast('Deletion request filed. Shorts are never fully deleted.');
      const i = state.items.indexOf(it);
      unload(it);
      observer.unobserve(it.el);
      it.el.remove();
      state.items.splice(i, 1);
      state.ids.delete(it.post.id);
      state.active = -1;
      if (state.items.length) activate(Math.min(i, state.items.length - 1));
      else navigate('/shorts', { replace: true });
    } catch (err) { toastError(err); }
  }

  function load(it, preload) {
    if (!it.video.getAttribute('src')) it.video.src = it.media.url;
    it.video.preload = preload;
  }

  function unload(it) {
    if (!it.video.getAttribute('src')) return;
    it.video.pause();
    it.video.removeAttribute('src');
    it.video.load();
  }

  function activate(i) {
    if (i === state.active || i < 0 || i >= state.items.length) return;
    const prev = state.items[state.active];
    if (prev) { prev.video.pause(); prev.pausedIcon.classList.add('hidden'); prev.el.classList.remove('active'); }
    state.active = i;
    const it = state.items[i];
    it.el.classList.add('active');
    it.lastTime = 0;
    load(it, 'auto');
    it.video.muted = state.muted;
    play(it);
    // Preload only the next one's metadata; drop anything further away.
    const nextIt = state.items[i + 1];
    if (nextIt) load(nextIt, 'metadata');
    state.items.forEach((other, j) => { if (Math.abs(j - i) > 2) unload(other); });
    history.replaceState({}, '', `/shorts/${it.post.id}`);
    ctx.title(it.post.body ? it.post.body.slice(0, 60) : `Short by @${it.post.author.handle}`);
    upBtn.disabled = i === 0;
    downBtn.disabled = i === state.items.length - 1 && state.next === null;
    if (state.panel) openComments(it.post);
    // Follow state for the plus button (one request per new author, cached).
    if (store.me && store.me.id !== it.post.author.id) {
      channelInfo(it.post.author.handle).then(info => { if (info?.is_following) markFollowing(it.post.author.handle); });
    }
    if (i >= state.items.length - 3) loadMore();
  }

  function play(it) {
    it.video.play().catch(err => {
      if (err.name === 'AbortError') return;
      // Sound was blocked: carry on muted.
      if (!it.video.muted) {
        it.video.muted = true;
        setMuted(true, { remember: false });
        it.video.play().catch(() => it.pausedIcon.classList.remove('hidden'));
      } else it.pausedIcon.classList.remove('hidden');
    });
  }

  function togglePlay() {
    const it = state.items[state.active];
    if (!it) return;
    if (it.video.paused) { if (it.video.muted !== state.muted) it.video.muted = state.muted; play(it); }
    else it.video.pause();
  }

  function setMuted(muted, { remember = true } = {}) {
    state.muted = muted;
    if (remember) writeMuted(muted);
    for (const it of state.items) {
      it.video.muted = muted;
      mount(it.muteBtn, icon(muted ? 'mute' : 'volume'));
      it.muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    }
    if (!muted) toast('Sound on. Southbag is listening too.', { timeout: 2000 });
  }

  function trackView(it) {
    if (state.viewed.has(it.post.id) || it.video.paused) return;
    const t = it.video.currentTime;
    const step = t - (it.lastTime || 0);
    it.lastTime = t;
    if (step > 0 && step < 1.5) it.played = (it.played || 0) + step;
    if ((it.played || 0) >= Math.min(VIEW_AFTER, (it.video.duration || VIEW_AFTER) * 0.8)) {
      state.viewed.add(it.post.id);
      api.post(`posts/${it.post.id}/view`).then(({ views }) => { it.post.counts.views = views; }).catch(() => {});
    }
  }

  function snapTo(i, behavior = 'smooth') {
    const it = state.items[i];
    const target = it ? it.el : null;
    if (target) feed.scrollTo({ top: target.offsetTop, behavior });
  }

  function go(dir) {
    const i = state.active + dir;
    if (i >= state.items.length) {
      if (state.next === null) feed.scrollTo({ top: endCard.offsetTop, behavior: 'smooth' });
      return;
    }
    if (i < 0) return;
    snapTo(i);
  }

  // ── Comments panel (side panel on desktop, bottom sheet on phones) ──
  function openComments(post) {
    closeComments(false);
    const title = h('h2', plural(post.counts.replies, 'comment'));
    const list = infiniteList({
      className: 'shorts-comment-list',
      signal: ctx.signal,
      load: cursor => api.get(`posts/${post.id}/replies`, { cursor, sort: 'top' }, { signal: ctx.signal }),
      render: reply => postCard(reply, { compact: true, card: false }),
      empty: empty({ icon: 'comment', title: 'No comments.', text: 'The silence is compliant.' }),
    });
    const panel = h('aside.shorts-panel', { role: 'dialog', 'aria-label': 'Comments' },
      h('div.shorts-panel-head', title,
        h('button.icon-btn', { type: 'button', 'aria-label': 'Close comments', onclick: () => closeComments() }, icon('close'))),
      h('div.shorts-panel-body', list),
      h('div.shorts-panel-foot', composer({
        replyTo: post,
        compact: true,
        placeholder: 'Add a comment. Say something compliant.',
        submitLabel: 'Comment',
        onPosted: reply => {
          post.counts.replies++;
          title.textContent = plural(post.counts.replies, 'comment');
          const it = state.items.find(x => x.post.id === post.id);
          if (it) it.commentCount.textContent = count(post.counts.replies);
          list.prepend(postCard(reply, { compact: true, card: false }));
        },
      })));
    state.panel = panel;
    mount(panelHost, panel);
    page.classList.add('with-panel');
    requestAnimationFrame(() => panel.classList.add('open'));
  }

  function closeComments(refocus = true) {
    if (!state.panel) return;
    state.panel.remove();
    state.panel = null;
    page.classList.remove('with-panel');
    if (refocus) feed.focus({ preventScroll: true });
  }
}
