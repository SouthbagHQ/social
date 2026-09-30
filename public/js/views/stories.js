// /stories/:handle — the full-screen story viewer (Instagram).
//   GET /api/stories/:handle → { user, items }; GET /api/stories (tray order, to move on to the next person)
//   POST /api/stories/:id/view; GET /api/stories/:id/viewers (own); DELETE /api/stories/:id (own)
//
// Tap right / left (or arrow keys) for next / previous, hold to pause, swipe down or Escape to close.
// Images show for 5 seconds; videos for their length. At the end of someone's stories the viewer
// moves on to the next person in the tray without reloading the page.

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, errorBox, loading, menu, toast, toastError } from '../ui.js';
import { openStoryComposer, storyBackground } from '../components/stories-bar.js';
import { avatar, userName } from '../components/user.js';

const IMAGE_MS = 5000;
let muted = false; // remembered between stories and visits

export default async function storiesView(ctx) {
  ctx.layout('full');
  ctx.title('Stories');

  // Where "close" goes: back to the page that opened us, or home for a direct link.
  let origin = null;
  try { origin = sessionStorage.getItem('sb_story_from'); sessionStorage.removeItem('sb_story_from'); } catch {}
  const canGoBack = Boolean(origin) && history.state !== null;

  const root = h('div.story-viewer', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Stories', tabIndex: -1 });
  mount(root, h('div.story-stage', loading('Loading...')));
  document.body.classList.add('story-viewer-open');

  let handle = ctx.params.handle.replace(/^@/, '');
  let reel = null; // { user, items }
  let index = 0;
  let tray = [];
  let closed = false;

  // Playback state.
  let raf = 0, startedAt = 0, elapsed = 0, duration = IMAGE_MS, paused = false, holds = 0;
  let video = null, bars = [], pauseBtn = null;

  const close = () => {
    if (closed) return;
    closed = true;
    stop();
    if (canGoBack) history.back();
    else navigate(origin || '/', { replace: true });
  };

  ctx.cleanup(() => {
    closed = true;
    stop();
    video?.pause();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('story-viewer-open');
  });

  // ── Loading reels ────────────────────────────────────────────────────
  const reelCache = new Map();
  const fetchReel = h => {
    if (!reelCache.has(h)) reelCache.set(h, api.get(`stories/${encodeURIComponent(h)}`).catch(err => { reelCache.delete(h); throw err; }));
    return reelCache.get(h);
  };

  async function openReel(nextHandle, { fromEnd = false } = {}) {
    stop();
    handle = nextHandle;
    let data;
    try {
      data = await fetchReel(handle);
    } catch (err) {
      if (closed) return;
      mount(root, h('div.story-stage.story-message', errorBox(err), closeButton()));
      return;
    }
    if (closed) return;
    if (location.pathname !== `/stories/${handle}`) history.replaceState(history.state, '', `/stories/${handle}`);
    reel = data;
    if (!reel.items.length) {
      mount(root, h('div.story-stage.story-message',
        closeButton(),
        empty({
          icon: 'camera', title: 'No live stories.',
          text: `${reel.user.name} has nothing live right now. Their stories expired. They were retained.`,
          action: store.me?.id === reel.user.id ? h('button.btn', { type: 'button', onclick: async () => { if (await openStoryComposer()) { reelCache.delete(handle); openReel(handle); } } }, 'Add to your story') : null,
        })));
      return;
    }
    ctx.title(`Stories from ${reel.user.name}`);
    const firstUnseen = reel.items.findIndex(s => !s.seen);
    index = fromEnd ? reel.items.length - 1 : firstUnseen >= 0 ? firstUnseen : 0;
    build();
    show();
  }

  const trayIndex = () => tray.findIndex(t => t.user.handle.toLowerCase() === handle.toLowerCase());
  const neighbour = dir => {
    const i = trayIndex();
    return i < 0 ? (dir > 0 ? tray.find(t => !t.seen && t.user.handle.toLowerCase() !== handle.toLowerCase()) : null) : tray[i + dir];
  };

  function nextStory() {
    if (!reel) return;
    if (index < reel.items.length - 1) { index++; show(); return; }
    const next = neighbour(1);
    if (next) openReel(next.user.handle);
    else close();
  }

  function prevStory() {
    if (!reel) return;
    if (index > 0) { index--; show(); return; }
    const prev = neighbour(-1);
    if (prev) openReel(prev.user.handle, { fromEnd: true });
    else { elapsed = 0; if (video) video.currentTime = 0; startedAt = performance.now(); }
  }

  // ── Building the frame ───────────────────────────────────────────────
  let frame, media, head, captionEl, footer, progress, timeEl;

  function closeButton() {
    return h('button.icon-btn.story-close', { type: 'button', 'aria-label': 'Close stories', onclick: close }, icon('close'));
  }

  function build() {
    const own = store.me?.id === reel.user.id;
    progress = h('div.story-progress', reel.items.map(() => h('span', h('i'))));
    bars = [...progress.children].map(s => s.firstChild);
    timeEl = h('span.story-time');
    pauseBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Pause', onclick: e => { e.stopPropagation(); togglePause(); } }, icon('pause'));
    const muteBtn = h('button.icon-btn.story-mute', { type: 'button', 'aria-label': muted ? 'Unmute' : 'Mute', onclick: e => {
      e.stopPropagation();
      muted = !muted;
      if (video) video.muted = muted;
      mount(muteBtn, icon(muted ? 'mute' : 'volume'));
      muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    } }, icon(muted ? 'mute' : 'volume'));
    const moreBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'More options' }, icon('more'));
    moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      hold();
      const story = reel.items[index];
      const m = menu(moreBtn, [
        own ? { label: 'Delete story', icon: 'trash', danger: true, onClick: () => removeStory(story) } : null,
        own ? { label: 'Add to your story', icon: 'plus', onClick: addMore } : null,
        !own ? { label: 'Report to Kevin', icon: 'flag', onClick: () => toast('Reported. Kevin has already seen it.') } : null,
        { label: 'Why am I seeing this?', icon: 'eye', onClick: () => dialog({ title: 'Algorithmic transparency', body: 'Kevin.' }) },
      ]);
      // Resume once the menu is gone.
      const watch = new MutationObserver(() => { if (!m.isConnected) { watch.disconnect(); release(); } });
      watch.observe(document.body, { childList: true });
    });
    head = h('div.story-head',
      progress,
      h('div.story-meta',
        h('a.story-who', { href: `/@${reel.user.handle}`, onclick: e => { e.preventDefault(); stop(); navigate(`/@${reel.user.handle}`); } },
          avatar(reel.user, { size: 'sm', round: true, link: false }),
          userName(reel.user, { handle: false, link: false }),
          timeEl),
        h('span.spacer'),
        muteBtn, pauseBtn, moreBtn, closeButton()));
    media = h('div.story-media');
    captionEl = h('div.story-caption');
    footer = h('div.story-foot', own ? seenByButton() : replyBox());
    frame = h('div.story-frame', media, h('div.story-shade'), head, captionEl, footer,
      h('div.story-hit.prev', { 'aria-hidden': 'true' }), h('div.story-hit.next', { 'aria-hidden': 'true' }));
    bindGestures(frame);
    const prevUser = neighbour(-1), nextUser = neighbour(1);
    mount(root,
      h('button.story-nav.prev', { type: 'button', 'aria-label': 'Previous story', onclick: prevStory }, icon('chevron-left')),
      h('div.story-stage', frame),
      h('button.story-nav.next', { type: 'button', 'aria-label': 'Next story', onclick: nextStory }, icon('chevron-right')),
      h('div.story-peek.prev', prevUser ? peek(prevUser) : null),
      h('div.story-peek.next', nextUser ? peek(nextUser) : null));
    root.focus({ preventScroll: true });
  }

  const peek = item => h('button.story-peek-btn', { type: 'button', onclick: () => openReel(item.user.handle), 'aria-label': `Stories from ${item.user.name}` },
    h('span.ring', { class: { live: true, seen: item.seen } }, avatar(item.user, { round: true, link: false })),
    h('span', item.user.name));

  function seenByButton() {
    const btn = h('button.story-seen', { type: 'button', onclick: e => { e.stopPropagation(); showViewers(reel.items[index]); } });
    btn.paint = story => mount(btn, icon('eye'), `Seen by ${story.view_count || 0} and Kevin`);
    return btn;
  }

  function replyBox() {
    if (!store.me) {
      return h('button.story-seen', { type: 'button', onclick: e => { e.stopPropagation(); login(); } }, 'Log in to reply. Kevin will read it either way.');
    }
    const input = h('input.story-reply-input', { placeholder: `Reply to ${reel.user.name}…`, maxLength: 500, 'aria-label': 'Reply' });
    input.addEventListener('focus', hold);
    input.addEventListener('blur', release);
    return h('form.story-reply', { onsubmit: e => {
      e.preventDefault();
      if (!input.value.trim()) return;
      input.value = '';
      input.blur();
      toast('Replies are forwarded to Kevin.');
    } }, input, h('button.icon-btn', { type: 'submit', 'aria-label': 'Send reply' }, icon('send')));
  }

  // ── Showing one story ────────────────────────────────────────────────
  function show() {
    stop();
    const story = reel.items[index];
    video?.pause();
    video = null;
    bars.forEach((b, i) => { b.style.width = i < index ? '100%' : '0%'; });
    timeEl.textContent = timeAgo(story.created_at);
    frame.style.background = storyBackground(story.background) || '#000';
    const m = story.media;
    if (m.kind === 'video') {
      video = h('video', { src: m.url, poster: m.poster_url || undefined, playsInline: true, preload: 'auto', muted });
      video.addEventListener('ended', nextStory);
      // A video that will not play gets a caption and the image timer instead of a frozen story.
      const el = video;
      video.addEventListener('error', () => {
        if (video !== el) return;
        mount(captionEl, h('p', 'This video could not be played. It has been retained.'));
        video = null;
        duration = IMAGE_MS;
        startedAt = performance.now();
        if (!paused && !holds) start();
      });
      video.addEventListener('loadedmetadata', () => { if (Number.isFinite(video?.duration)) duration = video.duration * 1000; });
      mount(media, video);
      duration = (m.duration || 15) * 1000;
    } else {
      mount(media, h('img', { src: m.url, alt: m.alt || story.caption || `Story from ${reel.user.name}`, draggable: false }));
      duration = IMAGE_MS;
    }
    mount(captionEl, story.caption ? h('p', story.caption) : null);
    footer.firstChild?.paint?.(story);
    // Preload what comes next.
    const upcoming = reel.items[index + 1];
    if (upcoming?.media.kind === 'image') new Image().src = upcoming.media.url;
    if (index === reel.items.length - 1) { const n = neighbour(1); if (n) fetchReel(n.user.handle).catch(() => {}); }
    markSeen(story);
    elapsed = 0;
    paused = false;
    holds = 0;
    paintPause();
    start();
  }

  function markSeen(story) {
    if (story.seen) return;
    story.seen = true;
    if (!store.me || store.me.id === reel.user.id) return;
    api.post(`stories/${story.id}/view`).catch(() => {});
    if (reel.items.every(s => s.seen)) {
      const t = tray.find(t => t.user.id === reel.user.id);
      if (t) t.seen = true;
    }
  }

  function start() {
    startedAt = performance.now() - elapsed;
    if (video) {
      video.muted = muted;
      video.play().catch(() => { if (!video) return; video.muted = muted = true; video.play().catch(() => {}); });
    }
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    video?.pause();
  }

  function tick(now) {
    if (closed) return;
    let p;
    if (video) {
      p = video.duration ? video.currentTime / video.duration : 0;
    } else {
      elapsed = now - startedAt;
      p = elapsed / duration;
      if (p >= 1) { bars[index].style.width = '100%'; nextStory(); return; }
    }
    if (bars[index]) bars[index].style.width = `${Math.min(100, p * 100)}%`;
    raf = requestAnimationFrame(tick);
  }

  function paintPause() {
    if (!pauseBtn) return;
    mount(pauseBtn, icon(paused ? 'play' : 'pause'));
    pauseBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    root.classList.toggle('paused', paused || holds > 0);
  }

  function togglePause() {
    paused = !paused;
    if (paused) { elapsed = performance.now() - startedAt; stop(); } else if (!holds) start();
    paintPause();
  }

  /** Temporary pauses (holding, menus, dialogs, typing a reply). They nest. */
  function hold() {
    if (holds++ === 0 && !paused) { elapsed = performance.now() - startedAt; stop(); }
    paintPause();
  }
  function release() {
    holds = Math.max(0, holds - 1);
    if (!holds && !paused && !closed && reel?.items.length) start();
    paintPause();
  }

  // ── Gestures and keys ────────────────────────────────────────────────
  function bindGestures(el) {
    let down = null, holdTimer = 0, held = false;
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button, a, input, form, .menu')) return;
      down = { x: e.clientX, y: e.clientY, t: Date.now() };
      held = false;
      holdTimer = setTimeout(() => { held = true; hold(); }, 220);
    });
    const end = e => {
      if (!down) return;
      clearTimeout(holdTimer);
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      const start = down;
      down = null;
      if (held) release();
      if (e.type === 'pointercancel') return;
      if (dy > 80 && Math.abs(dy) > Math.abs(dx)) return close();
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
        // Swipe sideways = move between people.
        const n = neighbour(dx < 0 ? 1 : -1);
        if (n) openReel(n.user.handle); else if (dx < 0) close();
        return;
      }
      if (held || Date.now() - start.t > 500) return;
      const rect = el.getBoundingClientRect();
      if (e.clientX - rect.left < rect.width * 0.3) prevStory(); else nextStory();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', e => { if (!e.target.closest('input')) e.preventDefault(); });
  }

  function onKey(e) {
    if (closed || document.querySelector('.overlay') || e.target.closest?.('input, textarea')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nextStory(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevStory(); }
    else if (e.key === ' ' && reel?.items.length) { e.preventDefault(); togglePause(); }
  }
  document.addEventListener('keydown', onKey);

  // ── Owner actions ────────────────────────────────────────────────────
  async function showViewers(story) {
    hold();
    await dialog({
      title: 'Seen by',
      body: () => {
        const list = h('div.story-viewers', loading());
        api.get(`stories/${story.id}/viewers`).then(({ items, count }) => {
          story.view_count = count;
          footer.firstChild?.paint?.(story);
          const real = items.filter(v => v.user.handle !== 'kevin');
          const kevin = items.find(v => v.user.handle === 'kevin')?.user
            || { id: 'kevin', handle: 'kevin', name: 'Kevin', avatar_url: null, verified: true };
          mount(list,
            h('div.user-row.kevin',
              avatar(kevin, { size: 'sm', round: true }),
              h('div.grow', userName(kevin), h('div.bio', 'Seen before you posted it'))),
            real.map(v => h('div.user-row',
              avatar(v.user, { size: 'sm', round: true }),
              h('div.grow', userName(v.user)),
              h('span.muted', { style: 'font-size:.84rem' }, timeAgo(v.created_at)))),
            real.length ? null : h('p.muted', { style: 'margin:8px 0 0' }, 'Nobody else yet. Kevin is enough.'));
        }).catch(err => mount(list, errorBox(err)));
        return list;
      },
    });
    release();
  }

  async function removeStory(story) {
    hold();
    const ok = await confirm('Delete this story? It will expire early. A copy will be retained anyway.', { ok: 'Request deletion' });
    if (!ok) return release();
    try {
      await api.del(`stories/${story.id}`);
      toast('Story deleted. The deletion has been retained.');
      window.dispatchEvent(new CustomEvent('stories:changed'));
      reel.items.splice(index, 1);
      reelCache.delete(handle);
      holds = 0;
      if (!reel.items.length) return close();
      index = Math.min(index, reel.items.length - 1);
      build();
      show();
    } catch (err) {
      toastError(err);
      release();
    }
  }

  async function addMore() {
    hold();
    const story = await openStoryComposer();
    if (story) {
      reelCache.delete(handle);
      holds = 0;
      openReel(handle);
    } else release();
  }

  // ── Go ───────────────────────────────────────────────────────────────
  api.get('stories', null, { signal: ctx.signal }).then(data => {
    tray = data.items || [];
    // Refresh the side peeks once we know the order.
    if (reel?.items.length && frame) {
      const prevUser = neighbour(-1), nextUser = neighbour(1);
      const [p, n] = root.querySelectorAll('.story-peek');
      if (p) mount(p, prevUser ? peek(prevUser) : null);
      if (n) mount(n, nextUser ? peek(nextUser) : null);
    }
  }).catch(() => {});
  openReel(handle);
  return root;
}
