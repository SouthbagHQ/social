// The audio player: a fixed bar at the bottom of every page. It is mounted once at boot, outside
// the page (see app.js), so playback carries on while you move around the site. Hidden until
// something plays.
//
//   playTrack(track, { queue })   play now; `queue` (an array of tracks containing it) becomes the queue
//   enqueue(track)                add to the end of the queue (plays straight away if nothing is playing)
//   currentTrack()                the track playing (or paused), or null
//   playButton(track, { queue })  a "Play"/"Pause" button that follows the player
//   playPostButton(post, media)   the same for an audio file attached to a feed post
//
// A track is the /api/audio Track shape: { id, kind, title, audio_url, cover_url, duration,
// show: { id, title }, owner, viewer: { progress, completed } }. Files are served from D1 with
// Range support, so seeking only fetches the chunk it needs.
// Podcast episodes save where you got to (every 15 s while playing, on pause, and when you leave)
// and resume from there. A play is counted once 30 s have been listened to.

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { duration as fmt } from '../format.js';
import { store } from '../store.js';
import { toast } from '../ui.js';

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
const SAVE_EVERY = 15000;
const COUNT_AFTER = 30;

const state = {
  queue: [],
  index: -1,
  speed: 1,
  listened: 0,
  counted: false,
  lastTime: 0,
  lastSaved: 0,
  lastSavedPosition: null,
  pendingSeek: null,
  seeking: false,
  queueOpen: false,
};
/** Positions saved during this visit, so replaying resumes even if the track object is stale. */
const resumeAt = new Map();
const watchers = new Set();

let ui = null;

try { const s = Number(localStorage.getItem('sb_audio_speed')); if (SPEEDS.includes(s)) state.speed = s; } catch {}

// ── Public API ───────────────────────────────────────────────────────────

export const currentTrack = () => state.queue[state.index] ?? null;
export const isPlaying = () => Boolean(ui && currentTrack() && !ui.audio.paused);
const same = (a, b) => Boolean(a && b) && (a.id && b.id ? a.id === b.id : a.audio_url === b.audio_url);
export const isCurrent = track => same(currentTrack(), track);

export function playTrack(track, { queue } = {}) {
  if (!track?.audio_url) return;
  audioPlayer();
  if (isCurrent(track)) {
    if (queue?.length) setQueue(queue, track);
    ui.audio.play().catch(playFailed);
    return;
  }
  leaveCurrent();
  setQueue(queue?.length ? queue : [track], track);
  load(true);
}

export function enqueue(track) {
  if (!track?.audio_url) return;
  if (!currentTrack()) return playTrack(track);
  if (state.queue.slice(state.index).some(t => same(t, track))) { toast('Already in the queue.'); return; }
  state.queue.push(track);
  paint();
  toast('Added to queue.');
}

export function pause() { ui?.audio.pause(); }

/** A "Play" / "Pause" button for one track that follows the player. */
export function playButton(track, { queue, small = true, label = 'Play' } = {}) {
  const btn = h(small ? 'button.btn-small' : 'button.btn', { type: 'button' });
  const paintBtn = () => {
    const on = isCurrent(track) && isPlaying();
    btn.textContent = on ? 'Pause' : label;
    btn.setAttribute('aria-label', `${on ? 'Pause' : 'Play'} ${track.title || 'audio'}`);
  };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (isCurrent(track) && isPlaying()) pause();
    else playTrack(track, { queue: typeof queue === 'function' ? queue() : queue });
  });
  watch(btn, paintBtn);
  paintBtn();
  return btn;
}

const byMedia = new Map();
/** "Play" for an audio file on a feed post. Uses the published track when there is one. */
export function playPostButton(post, media) {
  const fallback = {
    id: null,
    kind: 'song',
    title: post.title || firstLine(post.body) || 'Audio',
    audio_url: media.url,
    cover_url: post.author?.avatar_url || null,
    duration: media.duration,
    show: null,
    owner: post.author,
    post_id: post.id,
  };
  const btn = h('button.btn-small', { type: 'button' }, 'Play');
  const paintBtn = () => {
    const on = same(currentTrack(), fallback) && isPlaying();
    btn.textContent = on ? 'Pause' : 'Play';
  };
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    if (same(currentTrack(), fallback)) {
      if (isPlaying()) pause(); else ui.audio.play().catch(playFailed);
      return;
    }
    if (!byMedia.has(media.id)) {
      btn.disabled = true;
      const found = await api.get(`audio/tracks/by-media/${media.id}`).then(r => r.track, () => null);
      byMedia.set(media.id, found);
      btn.disabled = false;
    }
    playTrack(byMedia.get(media.id) || fallback);
  });
  watch(btn, paintBtn);
  return btn;
}

const firstLine = text => (text || '').split('\n')[0].slice(0, 120);

// ── Watchers (buttons elsewhere that show Play / Pause) ──────────────────

function watch(el, fn) {
  watchers.add({ el, fn, born: Date.now(), seen: false });
}

function notify() {
  for (const w of watchers) {
    if (w.el.isConnected) { w.seen = true; w.fn(); }
    else if (w.seen || Date.now() - w.born > 60000) watchers.delete(w);
  }
}

// ── The bar ──────────────────────────────────────────────────────────────

export function audioPlayer() {
  if (ui) return ui.root;
  const audio = new Audio();
  audio.preload = 'metadata';

  const btn = (label, onclick, extra = {}) => h('button.btn-small', { type: 'button', onclick, ...extra }, label);
  ui = { audio };
  ui.cover = h('a.ap-cover', { href: '/audio', 'aria-label': 'Now playing' });
  ui.title = h('a.ap-title', { href: '/audio' });
  ui.show = h('a.ap-show', { href: '/audio' });
  ui.prev = btn('Previous', previous);
  ui.back = btn('Back 15', () => skip(-15), { 'aria-label': 'Back 15 seconds' });
  ui.play = btn('Play', togglePlay);
  ui.fwd = btn('Forward 30', () => skip(30), { 'aria-label': 'Forward 30 seconds' });
  ui.next = btn('Next', next);
  ui.elapsed = h('span.ap-time', '0:00');
  ui.total = h('span.ap-time', '0:00');
  ui.seek = h('input.ap-range', { type: 'range', min: 0, max: 0, step: 1, value: 0, 'aria-label': 'Seek' });
  ui.speed = btn('Speed 1x', cycleSpeed, { 'aria-label': 'Playback speed' });
  ui.queueBtn = btn('Queue', toggleQueue, { 'aria-expanded': 'false' });
  ui.close = btn('Close', close, { 'aria-label': 'Close player' });
  ui.queue = h('div.ap-queue.hidden', { role: 'dialog', 'aria-label': 'Queue' });
  ui.bar = h('div.ap-bar',
    h('div.ap-now', ui.cover, h('div.ap-text', ui.title, ui.show)),
    h('div.ap-controls', ui.prev, ui.back, ui.play, ui.fwd, ui.next),
    h('div.ap-seek', ui.elapsed, ui.seek, ui.total),
    h('div.ap-extra', ui.speed, ui.queueBtn, ui.close));
  ui.root = h('div.audio-player.hidden', { role: 'region', 'aria-label': 'Audio player' }, ui.queue, ui.bar, audio);

  audio.addEventListener('loadedmetadata', () => {
    if (state.pendingSeek != null && Number.isFinite(audio.duration)) {
      audio.currentTime = Math.min(state.pendingSeek, Math.max(0, audio.duration - 1));
    }
    state.pendingSeek = null;
    state.lastTime = audio.currentTime;
    paintTime();
  });
  audio.addEventListener('durationchange', paintTime);
  audio.addEventListener('timeupdate', onTime);
  audio.addEventListener('play', () => { state.lastTime = audio.currentTime; paint(); });
  audio.addEventListener('pause', () => { if (!audio.ended) saveProgress(); paint(); });
  audio.addEventListener('ratechange', paint);
  audio.addEventListener('seeked', () => { state.lastTime = audio.currentTime; });
  audio.addEventListener('ended', () => {
    saveProgress({ completed: true });
    if (state.index < state.queue.length - 1) { state.index++; load(true); } else paint();
  });
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return;
    toast('This audio could not be played.', { error: true });
    paint();
  });

  ui.seek.addEventListener('input', () => {
    state.seeking = true;
    ui.elapsed.textContent = fmt(Number(ui.seek.value));
    paintFill();
  });
  ui.seek.addEventListener('change', () => {
    state.seeking = false;
    audio.currentTime = Number(ui.seek.value);
    state.lastTime = audio.currentTime;
  });

  // Keep the page clear of the bar.
  new ResizeObserver(() => {
    document.body.style.setProperty('--player-h', `${ui.root.offsetHeight}px`);
  }).observe(ui.root);

  const leave = () => { if (isPlaying()) saveProgress({ beacon: true }); };
  window.addEventListener('pagehide', leave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leave(); });

  setupMediaSession();
  return ui.root;
}

function setQueue(queue, track) {
  const list = queue.filter(t => t?.audio_url);
  let i = list.findIndex(t => same(t, track));
  if (i < 0) { list.unshift(track); i = 0; }
  state.queue = list;
  state.index = i;
}

function load(autoplay) {
  const t = currentTrack();
  if (!t) return close();
  const { audio } = ui;
  Object.assign(state, { listened: 0, counted: false, lastTime: 0, lastSaved: Date.now(), lastSavedPosition: null, seeking: false });
  state.pendingSeek = resumePosition(t);
  audio.src = t.audio_url;
  audio.defaultPlaybackRate = state.speed;
  audio.playbackRate = state.speed;
  ui.root.classList.remove('hidden');
  document.body.classList.add('has-player');
  paint();
  if (autoplay) audio.play().catch(playFailed);
}

function resumePosition(t) {
  if (t.kind !== 'episode' || !t.id) return null;
  const saved = resumeAt.has(t.id) ? resumeAt.get(t.id) : t.viewer?.completed ? 0 : t.viewer?.progress || 0;
  const length = t.duration || Infinity;
  return saved > 5 && saved < length - 10 ? saved : null;
}

function playFailed(err) {
  if (err?.name === 'AbortError') return;
  if (err?.name === 'NotAllowedError') { paint(); return; }
  toast('This audio could not be played.', { error: true });
  paint();
}

function togglePlay() {
  const { audio } = ui;
  if (audio.paused) audio.play().catch(playFailed); else audio.pause();
}

function skip(seconds) {
  const { audio } = ui;
  const end = Number.isFinite(audio.duration) ? audio.duration : Infinity;
  audio.currentTime = Math.max(0, Math.min(end - 0.5, audio.currentTime + seconds));
  state.lastTime = audio.currentTime;
  paintTime();
}

function previous() {
  if (ui.audio.currentTime > 5 || state.index <= 0) { ui.audio.currentTime = 0; state.lastTime = 0; return; }
  leaveCurrent();
  state.index--;
  load(true);
}

function next() {
  if (state.index >= state.queue.length - 1) return;
  leaveCurrent();
  state.index++;
  load(true);
}

function jump(i) {
  if (i === state.index) { ui.audio.play().catch(playFailed); return; }
  leaveCurrent();
  state.index = i;
  load(true);
}

function removeFromQueue(i) {
  if (i === state.index) return;
  state.queue.splice(i, 1);
  if (i < state.index) state.index--;
  paint();
}

function cycleSpeed() {
  state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
  ui.audio.defaultPlaybackRate = state.speed;
  ui.audio.playbackRate = state.speed;
  try { localStorage.setItem('sb_audio_speed', String(state.speed)); } catch {}
  paint();
}

function toggleQueue() {
  state.queueOpen = !state.queueOpen;
  paint();
}

function close() {
  leaveCurrent();
  if (!ui) return;
  const { audio } = ui;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.queue = [];
  state.index = -1;
  state.queueOpen = false;
  ui.root.classList.add('hidden');
  document.body.classList.remove('has-player');
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  paint();
}

/** Saves progress for the track that is about to stop being current. */
function leaveCurrent() {
  if (ui && currentTrack() && ui.audio.currentTime > 0) saveProgress();
}

// ── Listening: play counts and progress ──────────────────────────────────

function onTime() {
  const { audio } = ui;
  const t = currentTrack();
  if (!t) return;
  const delta = audio.currentTime - state.lastTime;
  state.lastTime = audio.currentTime;
  if (!audio.paused && delta > 0 && delta < 3) state.listened += delta;
  if (!state.counted && t.id && state.listened >= COUNT_AFTER) {
    state.counted = true;
    api.post(`audio/tracks/${t.id}/play`).then(r => { if (r?.play_count != null) t.play_count = r.play_count; }, () => {});
  }
  if (!audio.paused && Date.now() - state.lastSaved >= SAVE_EVERY) saveProgress();
  paintTime();
}

function saveProgress({ completed = false, beacon = false } = {}) {
  const t = currentTrack();
  if (!t?.id || t.kind !== 'episode' || !ui) return;
  const { audio } = ui;
  const position = completed ? (Number.isFinite(audio.duration) ? audio.duration : t.duration || audio.currentTime) : audio.currentTime;
  // Nothing to save before the resume point has been applied, or at the very start.
  if (!Number.isFinite(position) || (!completed && (state.pendingSeek != null || position < 1))) return;
  state.lastSaved = Date.now();
  resumeAt.set(t.id, completed ? 0 : position);
  t.viewer = { ...(t.viewer || {}), progress: completed ? null : position, completed };
  if (!store.me) return;
  const rounded = Math.round(position);
  if (!completed && rounded === state.lastSavedPosition) return;
  state.lastSavedPosition = rounded;
  const body = { position: Math.round(position * 10) / 10, completed };
  if (beacon) {
    fetch(`/api/audio/tracks/${t.id}/progress`, {
      method: 'PUT', keepalive: true, credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {});
  } else {
    api.put(`audio/tracks/${t.id}/progress`, body).catch(() => {});
  }
}

// ── Painting ─────────────────────────────────────────────────────────────

function lengthOf(t) {
  const d = ui.audio.duration;
  return Number.isFinite(d) && d > 0 ? d : t?.duration || 0;
}

function paintFill() {
  const max = Number(ui.seek.max) || 0;
  const pct = max ? (Number(ui.seek.value) / max) * 100 : 0;
  ui.seek.style.setProperty('--fill', `${pct.toFixed(2)}%`);
}

function paintTime() {
  const t = currentTrack();
  if (!ui || !t) return;
  const total = lengthOf(t);
  ui.seek.max = String(Math.max(0, Math.floor(total)));
  if (!state.seeking) {
    ui.seek.value = String(Math.floor(ui.audio.currentTime));
    ui.elapsed.textContent = fmt(ui.audio.currentTime);
  }
  ui.total.textContent = fmt(total);
  ui.seek.setAttribute('aria-valuetext', `${fmt(ui.audio.currentTime)} of ${fmt(total)}`);
  paintFill();
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && total) {
    try {
      navigator.mediaSession.setPositionState({ duration: total, playbackRate: ui.audio.playbackRate || 1, position: Math.min(ui.audio.currentTime, total) });
    } catch {}
  }
}

function paint() {
  if (!ui) return;
  const t = currentTrack();
  if (t) {
    const href = t.id ? `/audio/track/${t.id}` : t.post_id ? `/post/${t.post_id}` : '/audio';
    mount(ui.cover, t.cover_url ? h('img', { src: t.cover_url, alt: '' }) : h('span.ap-blank', (t.title || 'a').charAt(0).toLowerCase()));
    ui.cover.href = href;
    ui.title.href = href;
    ui.title.textContent = t.title || 'Untitled';
    ui.title.title = t.title || '';
    if (t.show) { ui.show.href = `/audio/show/${t.show.id}`; ui.show.textContent = t.show.title; }
    else if (t.owner) { ui.show.href = `/@${t.owner.handle}`; ui.show.textContent = t.owner.name; }
    else { ui.show.href = '/audio'; ui.show.textContent = ''; }
    ui.play.textContent = ui.audio.paused ? 'Play' : 'Pause';
    ui.prev.disabled = false;
    ui.next.disabled = state.index >= state.queue.length - 1;
    ui.speed.textContent = `Speed ${state.speed}x`;
    paintTime();
    updateMediaSession(t);
  }
  ui.queueBtn.setAttribute('aria-expanded', String(state.queueOpen));
  ui.queue.classList.toggle('hidden', !state.queueOpen || !t);
  if (state.queueOpen && t) paintQueue();
  notify();
}

function paintQueue() {
  mount(ui.queue,
    h('div.ap-queue-head', h('strong', 'Queue'), h('span.grow'),
      state.index < state.queue.length - 1
        ? h('button.btn-small', { type: 'button', onclick: () => { state.queue.splice(state.index + 1); paint(); } }, 'Clear')
        : null,
      h('button.btn-small', { type: 'button', onclick: toggleQueue }, 'Close')),
    h('ol.ap-queue-list', state.queue.map((t, i) => h('li', { class: { current: i === state.index } },
      h('div.grow',
        h('div.ap-queue-title', t.title || 'Untitled'),
        h('div.fine', [t.show?.title || t.owner?.name, t.duration ? fmt(t.duration) : null, i === state.index ? 'Now playing' : null].filter(Boolean).join(', '))),
      i === state.index ? null : h('button.btn-small', { type: 'button', onclick: () => jump(i) }, 'Play'),
      i === state.index ? null : h('button.btn-small', { type: 'button', onclick: () => removeFromQueue(i) }, 'Remove')))));
}

// ── Media Session (lock screen and hardware keys) ────────────────────────

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };
  set('play', () => ui.audio.play().catch(playFailed));
  set('pause', () => ui.audio.pause());
  set('seekbackward', d => skip(-(d?.seekOffset || 15)));
  set('seekforward', d => skip(d?.seekOffset || 30));
  set('previoustrack', previous);
  set('nexttrack', next);
  set('stop', close);
  set('seekto', d => { if (d?.seekTime != null) { ui.audio.currentTime = d.seekTime; paintTime(); } });
}

let sessionFor = null;
function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = ui.audio.paused ? 'paused' : 'playing';
  if (sessionFor === t || typeof MediaMetadata === 'undefined') return;
  sessionFor = t;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title || 'Untitled',
    artist: t.show?.title || t.owner?.name || '',
    album: t.album || (t.kind === 'episode' ? t.show?.title : '') || '',
    artwork: t.cover_url ? [{ src: new URL(t.cover_url, location.origin).href, sizes: '512x512' }] : [],
  });
}
