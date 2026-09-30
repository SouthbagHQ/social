// Podcasts and music (Spotify / SoundCloud / Apple Podcasts).
//   /audio                  Home: continue listening, new episodes, new music, popular this week
//   /audio/podcasts         podcasts and the latest episodes (?q= search, ?sort=popular|new)
//   /audio/music            artists and the latest songs
//   /audio/library          your playlists, followed shows, liked tracks, your shows and uploads
//   /audio/upload           publish an episode or a song (?show=<id> preselects the show)
//   /audio/show/:id         a podcast or artist page
//   /audio/track/:id        an episode or song
//   /audio/playlist/:id     a playlist
// API: /api/audio (src/routes/audio.ts). Playback: components/player.js, which lives outside the page.

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { bytes, duration as fmt, fullDate, plural, timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, errorBox, infiniteList, loading, share, shake, tabs, toast, toastError } from '../ui.js';
import { pickFiles, uploadBlob, uploadFile } from '../upload.js';
import { richText } from '../components/post.js';
import { enqueue, playButton, playTrack } from '../components/player.js';

const AUDIO_LIMIT = 60 * 1048576;
const MAX_DESCRIPTION = 5000;

export default async function view(ctx) {
  ctx.layout('wide');
  const { section: tab = 'home', id } = ctx.params;
  if (id) {
    if (tab === 'show') return showPage(ctx, id);
    if (tab === 'track') return trackPage(ctx, id);
    if (tab === 'playlist') return playlistPage(ctx, id);
    return notFound(ctx);
  }
  const pages = { home: homeTab, podcasts: c => browseTab(c, 'podcast'), music: c => browseTab(c, 'artist'), library: libraryTab, upload: uploadTab };
  if (!pages[tab]) return notFound(ctx);
  const body = await pages[tab](ctx);
  return h('div.audio-page', header(tab), body);
}

function header(current) {
  const items = [
    { key: 'home', href: '/audio', label: 'Home' },
    { key: 'podcasts', href: '/audio/podcasts', label: 'Podcasts' },
    { key: 'music', href: '/audio/music', label: 'Music' },
    { key: 'library', href: '/audio/library', label: 'Library' },
    { key: 'upload', href: '/audio/upload', label: 'Upload' },
  ];
  return h('div.audio-head',
    h('div.page-head', h('h1', 'Podcasts and music')),
    tabs(items.map(t => ({ href: t.href, label: t.label, current: t.key === current }))));
}

function notFound(ctx) {
  ctx.title('Not found');
  return h('div.audio-page', header(null), h('div.south-card', h('h2', 'Not found'), h('p', 'That page does not exist.')));
}

// ── Pieces ───────────────────────────────────────────────────────────────

/** A square cover, stretched into its box. */
function cover(url, { size = '', title = '', href } = {}) {
  const inner = url ? h('img', { src: url, alt: '', loading: 'lazy' })
    : title ? h('span.audio-cover-blank', title.trim().charAt(0).toLowerCase())
    : h('span.audio-cover-blank.text', 'No cover');
  return h(href ? 'a.audio-cover' : 'span.audio-cover', { href, class: { [size]: Boolean(size) }, 'aria-hidden': href ? null : 'true', tabIndex: href ? -1 : null }, inner);
}

const kindWord = kind => ({ podcast: 'Podcast', artist: 'Artist', episode: 'Episode', song: 'Song' })[kind] || '';

function episodeLabel(t) {
  if (t.kind !== 'episode') return null;
  if (t.season != null && t.episode_number != null) return `Season ${t.season}, episode ${t.episode_number}`;
  if (t.episode_number != null) return `Episode ${t.episode_number}`;
  if (t.season != null) return `Season ${t.season}`;
  return null;
}

function progressNote(t) {
  if (t.viewer?.completed) return 'Played';
  const p = t.viewer?.progress;
  if (!p || !t.duration) return null;
  return `${fmt(Math.max(0, t.duration - p))} left`;
}

function likeButton(track, { onChange } = {}) {
  const btn = h('button.btn-small', { type: 'button' });
  const paint = () => {
    btn.textContent = track.viewer.liked ? 'Liked' : 'Like';
    btn.setAttribute('aria-pressed', String(track.viewer.liked));
  };
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!store.me) return login();
    btn.disabled = true;
    try {
      const r = track.viewer.liked ? await api.del(`audio/tracks/${track.id}/like`) : await api.put(`audio/tracks/${track.id}/like`);
      track.viewer.liked = r.liked;
      track.like_count = r.like_count;
      paint();
      onChange?.(track);
    } catch (err) { toastError(err); }
    btn.disabled = false;
  });
  paint();
  return btn;
}

function followShowButton(show, { onChange } = {}) {
  const btn = h('button.btn', { type: 'button' });
  const paint = () => { btn.textContent = show.viewer.following ? 'Following' : 'Follow'; };
  btn.addEventListener('click', async () => {
    if (!store.me) return login();
    if (show.viewer.following && !(await confirm(`Unfollow ${show.title}?`, { title: 'Unfollow', ok: 'Unfollow' }))) return;
    btn.disabled = true;
    try {
      const r = show.viewer.following ? await api.del(`audio/shows/${show.id}/follow`) : await api.put(`audio/shows/${show.id}/follow`);
      show.viewer.following = r.following;
      show.follower_count = r.follower_count;
      if (r.following) toast(`Following ${show.title}.`);
      paint();
      onChange?.(show);
    } catch (err) { toastError(err); }
    btn.disabled = false;
  });
  paint();
  return btn;
}

/**
 * One track in a list: cover, title, show, date, length, and Play / Add to playlist / Like.
 * `queue` is the list it belongs to (playing from a list queues the rest). `extra` adds buttons.
 */
function trackRow(track, { queue, number, showShow = true, extra = [] } = {}) {
  const href = `/audio/track/${track.id}`;
  const sub = [
    showShow ? h('a', { href: `/audio/show/${track.show.id}` }, track.show.title) : null,
    episodeLabel(track),
    track.kind === 'song' && track.album ? track.album : null,
    h('span', { title: fullDate(track.published_at) }, timeAgo(track.published_at)),
    track.duration ? fmt(track.duration) : null,
    progressNote(track),
  ].filter(Boolean);
  return h('div.audio-row', { class: { numbered: number != null }, dataset: { trackId: track.id } },
    number != null ? h('span.audio-num', String(number)) : null,
    cover(track.cover_url, { href, title: track.title }),
    h('div.audio-row-main',
      h('a.audio-row-title', { href }, track.title),
      h('div.audio-row-sub', sub.flatMap((part, i) => (i ? [', ', part] : [part])))),
    h('div.audio-row-actions',
      playButton(track, { queue }),
      h('button.btn-small', { type: 'button', onclick: e => { e.stopPropagation(); addToPlaylist(track); } }, 'Add to playlist'),
      likeButton(track),
      extra));
}

function trackList(tracks, { emptyText = 'Nothing here yet.', numbered = false, showShow = true, extra } = {}) {
  if (!tracks.length) return empty({ title: emptyText });
  return h('div.audio-list', tracks.map((t, i) => trackRow(t, { queue: tracks, number: numbered ? i + 1 : null, showShow, extra: extra?.(t, i) })));
}

function showTile(show) {
  const href = `/audio/show/${show.id}`;
  return h('a.audio-tile', { href },
    cover(show.cover_url, { size: 'fill', title: show.title }),
    h('strong.audio-tile-title', show.title),
    h('span.audio-tile-sub', show.owner.name),
    h('span.audio-tile-sub', show.kind === 'podcast' ? plural(show.track_count, 'episode') : plural(show.track_count, 'song')));
}

const showGrid = (shows, emptyText) => shows.length ? h('div.audio-grid', shows.map(showTile)) : empty({ title: emptyText });

function playlistTile(p) {
  const href = `/audio/playlist/${p.id}`;
  return h('a.audio-tile', { href },
    cover(p.cover_url, { size: 'fill', title: p.title }),
    h('strong.audio-tile-title', p.title),
    h('span.audio-tile-sub', plural(p.track_count, 'track')),
    p.visibility === 'private' ? h('span.audio-tile-sub', 'Private') : null);
}

const section = (title, ...children) => h('section.south-card.audio-section', h('h2', title), ...children);

// ── Home ─────────────────────────────────────────────────────────────────

async function homeTab(ctx) {
  ctx.title('Podcasts and music');
  const data = await api.get('audio/home', null, { signal: ctx.signal });
  return h('div',
    data.continue_listening.length ? section('Continue listening', trackList(data.continue_listening)) : null,
    section(data.new_episodes_from === 'following' ? 'New episodes' : 'Latest episodes',
      trackList(data.new_episodes, { emptyText: 'No episodes yet.' })),
    section('New music', trackList(data.new_music, { emptyText: 'No songs yet.' })),
    section('Popular this week', trackList(data.popular, { emptyText: 'Nothing has been played this week.' })),
    section('Popular shows', showGrid(data.popular_shows, 'No shows yet.')));
}

// ── Podcasts / Music ─────────────────────────────────────────────────────

async function browseTab(ctx, kind) {
  const podcast = kind === 'podcast';
  ctx.title(podcast ? 'Podcasts' : 'Music');
  const q = (ctx.query.get('q') || '').trim();
  const sort = ctx.query.get('sort') === 'new' ? 'new' : 'popular';
  const base = podcast ? '/audio/podcasts' : '/audio/music';
  const go = (params) => {
    const s = new URLSearchParams({ ...(q && { q }), ...(sort !== 'popular' && { sort }), ...params });
    for (const [k, v] of [...s]) if (!v) s.delete(k);
    navigate(`${base}${s.toString() ? `?${s}` : ''}`, { replace: true, scroll: false });
  };

  const input = h('input', { type: 'search', value: q, placeholder: podcast ? 'Search podcasts and episodes' : 'Search artists and songs', 'aria-label': 'Search' });
  const sortSelect = h('select', { 'aria-label': 'Sort', onchange: () => go({ sort: sortSelect.value === 'popular' ? '' : 'new' }) },
    h('option', { value: 'popular', selected: sort === 'popular' }, 'Popular'),
    h('option', { value: 'new', selected: sort === 'new' }, 'New'));
  const form = h('form.audio-search', { role: 'search', onsubmit: e => { e.preventDefault(); go({ q: input.value.trim() }); } },
    input, h('button', { type: 'submit' }, 'Search'), sortSelect);

  // Shows: a page at a time with "More".
  const grid = h('div.audio-grid');
  const gridStatus = h('div');
  let next;
  async function moreShows() {
    mount(gridStatus, loading());
    try {
      const page = await api.get('audio/shows', { kind, sort, q, cursor: next, limit: 12 }, { signal: ctx.signal });
      page.items.forEach(s => grid.append(showTile(s)));
      next = page.next;
      mount(gridStatus,
        !grid.children.length ? empty({ title: q ? 'No results.' : podcast ? 'No podcasts yet.' : 'No artists yet.' }) : null,
        next ? h('button', { type: 'button', onclick: moreShows }, 'More') : null);
    } catch (err) {
      if (err.name !== 'AbortError') mount(gridStatus, errorBox(err));
    }
  }
  moreShows();

  const trackKind = podcast ? 'episode' : 'song';
  // Play from the list queues everything loaded so far.
  const listed = [];
  const list = infiniteList({
    className: 'audio-list',
    signal: ctx.signal,
    load: cursor => api.get('audio/tracks', { kind: trackKind, sort, q, cursor }, { signal: ctx.signal }),
    render: t => { listed.push(t); return trackRow(t, { queue: () => listed.slice() }); },
    empty: empty({ title: q ? 'No results.' : podcast ? 'No episodes yet.' : 'No songs yet.' }),
  });

  return h('div',
    form,
    section(podcast ? 'Podcasts' : 'Artists', grid, gridStatus),
    section(podcast ? (sort === 'new' ? 'Latest episodes' : 'Popular episodes') : (sort === 'new' ? 'Latest songs' : 'Popular songs'), list));
}

// ── Library ──────────────────────────────────────────────────────────────

async function libraryTab(ctx) {
  ctx.title('Library');
  if (!ctx.requireAuth()) return null;
  const data = await api.get('audio/library', null, { signal: ctx.signal });
  const newPlaylist = h('button', { type: 'button', onclick: async () => {
    const p = await playlistForm();
    if (p) navigate(`/audio/playlist/${p.id}`);
  } }, 'New playlist');
  const newShow = h('button', { type: 'button', onclick: async () => {
    const s = await showForm({ kind: 'podcast' });
    if (s) navigate(`/audio/show/${s.id}`);
  } }, 'New show');
  return h('div',
    h('section.south-card.audio-section',
      h('div.row.between', h('h2', 'Playlists'), newPlaylist),
      data.playlists.length ? h('div.audio-grid', data.playlists.map(playlistTile)) : empty({ title: 'No playlists yet.' })),
    section('Following', showGrid(data.shows, 'Not following any shows.')),
    section('Liked', trackList(data.liked, { emptyText: 'No liked episodes or songs.' })),
    h('section.south-card.audio-section',
      h('div.row.between', h('h2', 'Your shows'), newShow),
      showGrid(data.my_shows, 'No shows yet.')),
    section('Your uploads', trackList(data.uploads, { emptyText: 'No uploads yet.' })));
}

// ── Upload ───────────────────────────────────────────────────────────────

async function uploadTab(ctx) {
  ctx.title('Upload');
  if (!ctx.requireAuth()) return null;
  let shows = (await api.get('audio/shows/mine', null, { signal: ctx.signal })).items;
  const preset = shows.find(s => s.id === ctx.query.get('show'));
  const s = { kind: preset?.kind === 'artist' ? 'song' : 'episode', audio: null, cover: null, audioCtl: null, coverCtl: null, publishing: false, progress: 0, file: null, error: null };

  const showKind = () => (s.kind === 'episode' ? 'podcast' : 'artist');
  ctx.cleanup(() => {
    s.audioCtl?.abort();
    s.coverCtl?.abort();
    if (!s.publishing) {
      if (s.audio) api.del(`media/${s.audio.id}`).catch(() => {});
      if (s.cover) api.del(`media/${s.cover.id}`).catch(() => {});
    }
  });

  // Type
  const typeSelect = h('select', { onchange: () => { s.kind = typeSelect.value; paintShows(); refresh(); } },
    h('option', { value: 'episode', selected: s.kind === 'episode' }, 'Podcast episode'),
    h('option', { value: 'song', selected: s.kind === 'song' }, 'Song'));

  // Show
  const showSelect = h('select', { onchange: refresh });
  const newShowBtn = h('button.btn-small', { type: 'button', onclick: async () => {
    const created = await showForm({ kind: showKind() });
    if (!created) return;
    shows = [created, ...shows];
    paintShows(created.id);
    refresh();
  } });
  function paintShows(selected = showSelect.value || preset?.id) {
    const mine = shows.filter(x => x.kind === showKind());
    mount(showSelect, mine.length
      ? mine.map(x => h('option', { value: x.id, selected: x.id === selected }, x.title))
      : h('option', { value: '' }, showKind() === 'podcast' ? 'No podcasts yet' : 'No artists yet'));
    newShowBtn.textContent = showKind() === 'podcast' ? 'New podcast' : 'New artist';
  }

  // Audio file
  const fileName = h('strong.grow');
  const bar = h('div');
  const status = h('div.fine');
  const audioBox = h('div.audio-upload-file.hidden', h('div.row', fileName), h('div.progress-bar', bar), status);
  const chooseAudio = h('button', { type: 'button', onclick: async () => { const [f] = await pickFiles({ accept: 'audio/*' }); if (f) chooseFile(f); } }, 'Choose audio file');

  // Cover
  const coverBox = h('div.audio-upload-cover', cover(null, { size: 'lg' }));
  const coverBtn = h('button', { type: 'button', onclick: async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) chooseCover(f); } }, 'Choose cover');
  const coverNote = h('p.fine', 'Square images look best. Without one, the show cover is used.');

  // Fields
  const title = h('input', { maxLength: 200, 'aria-required': 'true', oninput: refresh });
  const desc = h('textarea', { rows: 6, maxLength: MAX_DESCRIPTION, oninput: refresh });
  const descCount = h('span.counter');
  const season = h('input', { type: 'number', min: 0, max: 1000, inputMode: 'numeric' });
  const episode = h('input', { type: 'number', min: 0, max: 100000, inputMode: 'numeric' });
  const album = h('input', { maxLength: 120 });
  const genre = h('input', { maxLength: 40 });
  const toFeed = h('input', { type: 'checkbox', checked: true });
  const episodeFields = h('div.audio-fields', h('label.field', h('span', 'Season'), season), h('label.field', h('span', 'Episode'), episode));
  const songFields = h('div.audio-fields', h('label.field', h('span', 'Album'), album), h('label.field', h('span', 'Genre'), genre));
  const publish = h('button.btn-large', { type: 'submit' }, 'Publish');

  const form = h('form.south-card.audio-upload', { onsubmit: e => { e.preventDefault(); submit(); } },
    h('label.field', h('span', 'Type'), typeSelect),
    h('div.field', h('span.field-label', s.kind === 'episode' ? 'Podcast' : 'Artist'), h('div.row', showSelect, newShowBtn)),
    h('div.field', h('span.field-label', 'Audio file'), h('p.fine', `MP3, M4A, OGG or WAV, up to ${AUDIO_LIMIT / 1048576} MB.`), chooseAudio, audioBox),
    h('div.field', h('span.field-label', 'Cover'), h('div.row.wrap.audio-cover-row', coverBox, h('div', coverBtn, coverNote))),
    h('label.field', h('span', 'Title'), title),
    h('label.field', h('span', 'Description'), desc, descCount),
    episodeFields,
    songFields,
    h('label.checkbox', toFeed, h('span', 'Post to your feed')),
    h('div.row.wrap', publish));
  const showLabel = form.querySelector('.field-label');

  async function chooseFile(file) {
    const type = contentTypeOf(file);
    if (!type) { toast('That file is not audio.', { error: true }); shake(chooseAudio); return; }
    if (file.size > AUDIO_LIMIT) { toast(`Audio files are limited to ${AUDIO_LIMIT / 1048576} MB.`, { error: true }); shake(chooseAudio); return; }
    s.audioCtl?.abort();
    if (s.audio) api.del(`media/${s.audio.id}`).catch(() => {});
    const ctl = new AbortController();
    Object.assign(s, { audio: null, audioCtl: ctl, file, progress: 0, error: null });
    if (!title.value) title.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 200);
    refresh();
    try {
      const length = await audioDuration(file);
      const media = await uploadBlob(file, {
        kind: 'audio', contentType: type, duration: length, signal: ctl.signal,
        onProgress: p => { if (s.audioCtl === ctl) { s.progress = p; refresh(); } },
      });
      if (s.audioCtl !== ctl) { api.del(`media/${media.id}`).catch(() => {}); return; }
      s.audio = media;
      s.progress = 1;
    } catch (err) {
      if (err.name === 'AbortError' || s.audioCtl !== ctl) return;
      s.error = `Upload failed. ${err.message}`;
      toast(s.error, { error: true });
    }
    refresh();
  }

  async function chooseCover(file) {
    s.coverCtl?.abort();
    const old = s.cover;
    const ctl = new AbortController();
    s.coverCtl = ctl;
    mount(coverBox, h('div.audio-cover.lg', loading('Uploading')));
    try {
      const media = await uploadFile(file, { maxEdge: 1400, signal: ctl.signal });
      if (media.kind !== 'image') throw new Error('Covers must be images.');
      if (s.coverCtl !== ctl) return;
      s.cover = media;
      if (old) api.del(`media/${old.id}`).catch(() => {});
    } catch (err) {
      if (err.name !== 'AbortError') toastError(err);
    }
    mount(coverBox, cover(s.cover?.url || null, { size: 'lg' }));
  }

  function refresh() {
    const episodeKind = s.kind === 'episode';
    showLabel.textContent = episodeKind ? 'Podcast' : 'Artist';
    episodeFields.classList.toggle('hidden', !episodeKind);
    songFields.classList.toggle('hidden', episodeKind);
    audioBox.classList.toggle('hidden', !s.file);
    if (s.file) {
      fileName.textContent = s.file.name;
      bar.style.width = `${Math.round(s.progress * 100)}%`;
      status.textContent = s.error || (s.audio
        ? `Uploaded. ${bytes(s.file.size)}${s.audio.duration ? `, ${fmt(s.audio.duration)}` : ''}.`
        : `Uploading ${bytes(Math.round(s.file.size * s.progress))} of ${bytes(s.file.size)} (${Math.round(s.progress * 100)}%)`);
      chooseAudio.textContent = 'Choose a different file';
    }
    descCount.textContent = desc.value ? String(MAX_DESCRIPTION - [...desc.value].length) : '';
    const ready = s.audio && title.value.trim() && showSelect.value && !s.publishing;
    publish.disabled = !ready;
    publish.textContent = s.publishing ? 'Publishing' : s.file && !s.audio && !s.error ? `Uploading ${Math.round(s.progress * 100)}%` : 'Publish';
  }

  async function submit() {
    if (publish.disabled) return;
    s.publishing = true;
    refresh();
    try {
      const { track } = await api.post('audio/tracks', {
        show_id: showSelect.value,
        title: title.value.trim(),
        description: desc.value,
        media_id: s.audio.id,
        cover_media_id: s.cover?.id,
        duration: s.audio.duration,
        ...(s.kind === 'episode'
          ? { season: season.value || null, episode_number: episode.value || null }
          : { album: album.value || null, genre: genre.value || null }),
        post_to_feed: toFeed.checked,
      });
      toast('Published.');
      navigate(`/audio/track/${track.id}`);
      return;
    } catch (err) {
      shake(form);
      toastError(err);
    }
    s.publishing = false;
    refresh();
  }

  paintShows(preset?.id);
  refresh();
  return form;
}

/** The content type the server accepts for an audio file, or null. */
function contentTypeOf(file) {
  const t = (file.type || '').toLowerCase();
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (t === 'audio/mpeg' || t === 'audio/mp3' || ext === 'mp3') return 'audio/mpeg';
  if (t === 'audio/mp4' || t === 'audio/x-m4a' || t === 'audio/m4a' || ext === 'm4a') return 'audio/mp4';
  if (t === 'audio/aac' || ext === 'aac') return 'audio/aac';
  if (t === 'audio/ogg' || ext === 'ogg' || ext === 'oga' || ext === 'opus') return 'audio/ogg';
  if (t === 'audio/webm' || ext === 'weba') return 'audio/webm';
  if (t === 'audio/wav' || t === 'audio/x-wav' || t === 'audio/wave' || ext === 'wav') return 'audio/wav';
  return null;
}

/** Length of an audio file in seconds (null if the browser can't tell). */
function audioDuration(file) {
  return new Promise(resolve => {
    const el = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const done = value => { URL.revokeObjectURL(url); resolve(value); };
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    setTimeout(() => done(null), 10000);
    el.src = url;
  });
}

// ── Dialogs ──────────────────────────────────────────────────────────────

/** Create (or edit, with `show`) a podcast or artist. Resolves to the saved show or null. */
async function showForm({ kind = 'podcast', show = null } = {}) {
  let coverMedia = null;
  let coverUrl = show?.cover_url || null;
  const kindSelect = h('select', { disabled: Boolean(show) },
    h('option', { value: 'podcast', selected: (show?.kind || kind) === 'podcast' }, 'Podcast'),
    h('option', { value: 'artist', selected: (show?.kind || kind) === 'artist' }, 'Artist'));
  const title = h('input', { maxLength: 120, value: show?.title || '' });
  const category = h('input', { maxLength: 40, value: show?.category || '', placeholder: 'News, Comedy, Indie' });
  const desc = h('textarea', { rows: 4, maxLength: 5000, value: show?.description || '' });
  const coverBox = h('div', cover(coverUrl, { size: 'md' }));
  const coverBtn = h('button.btn-small', { type: 'button', onclick: async () => {
    const [f] = await pickFiles({ accept: 'image/*' });
    if (!f) return;
    coverBtn.disabled = true;
    mount(coverBox, h('div.audio-cover.md', loading('Uploading')));
    try {
      const media = await uploadFile(f, { maxEdge: 1400 });
      if (coverMedia) api.del(`media/${coverMedia.id}`).catch(() => {});
      coverMedia = media;
      coverUrl = media.url;
    } catch (err) { toastError(err); }
    mount(coverBox, cover(coverUrl, { size: 'md' }));
    coverBtn.disabled = false;
  } }, 'Choose cover');

  const value = await dialog({
    title: show ? 'Edit show' : 'New show',
    wide: true,
    body: h('div',
      h('label.field', h('span', 'Type'), kindSelect),
      h('label.field', h('span', 'Name'), title),
      h('label.field', h('span', 'Category'), category),
      h('label.field', h('span', 'Description'), desc),
      h('div.field', h('span.field-label', 'Cover'), h('div.row', coverBox, coverBtn))),
    actions: [{ label: 'Cancel', value: false }, { label: show ? 'Save' : 'Create', value: true, primary: true }],
    onOpen: () => title.focus(),
  });
  if (!value) {
    if (coverMedia) api.del(`media/${coverMedia.id}`).catch(() => {});
    return null;
  }
  const input = {
    title: title.value, category: category.value, description: desc.value,
    ...(coverMedia && { cover_media_id: coverMedia.id }),
  };
  try {
    const r = show ? await api.patch(`audio/shows/${show.id}`, input) : await api.post('audio/shows', { kind: kindSelect.value, ...input });
    toast(show ? 'Saved.' : 'Created.');
    return r.show;
  } catch (err) {
    toastError(err);
    if (coverMedia && !show) api.del(`media/${coverMedia.id}`).catch(() => {});
    return null;
  }
}

/** Create or edit a playlist. Resolves to the saved playlist or null. */
async function playlistForm(playlist = null) {
  const title = h('input', { maxLength: 120, value: playlist?.title || '' });
  const desc = h('textarea', { rows: 3, maxLength: 1000, value: playlist?.description || '' });
  const visibility = h('select',
    h('option', { value: 'public', selected: playlist?.visibility !== 'private' }, 'Public'),
    h('option', { value: 'private', selected: playlist?.visibility === 'private' }, 'Private'));
  const ok = await dialog({
    title: playlist ? 'Edit playlist' : 'New playlist',
    body: h('div',
      h('label.field', h('span', 'Name'), title),
      h('label.field', h('span', 'Description'), desc),
      h('label.field', h('span', 'Visibility'), visibility)),
    actions: [{ label: 'Cancel', value: false }, { label: playlist ? 'Save' : 'Create', value: true, primary: true }],
    onOpen: () => title.focus(),
  });
  if (!ok) return null;
  try {
    const input = { title: title.value, description: desc.value, visibility: visibility.value };
    const r = playlist ? await api.patch(`audio/playlists/${playlist.id}`, input) : await api.post('audio/playlists', input);
    toast(playlist ? 'Saved.' : 'Created.');
    return r.playlist;
  } catch (err) {
    toastError(err);
    return null;
  }
}

async function addToPlaylist(track) {
  if (!store.me) return login();
  let playlists;
  try { playlists = (await api.get('audio/playlists')).items; } catch (err) { toastError(err); return; }
  const name = h('input', { maxLength: 120, placeholder: 'Name' });
  const choice = await dialog({
    title: 'Add to playlist',
    body: close => h('div',
      playlists.length
        ? h('div.audio-pick', playlists.map(p => h('button', { type: 'button', onclick: () => close(p) }, p.title)))
        : h('p.muted', 'No playlists yet.'),
      h('label.field', h('span', 'New playlist'), name)),
    actions: [{ label: 'Cancel', value: null }, { label: 'Create and add', value: 'new', primary: true }],
  });
  if (!choice) return;
  try {
    let target = choice;
    if (choice === 'new') {
      if (!name.value.trim()) { toast('Give the playlist a name.', { error: true }); return; }
      target = (await api.post('audio/playlists', { title: name.value })).playlist;
    }
    await api.post(`audio/playlists/${target.id}/tracks`, { track_id: track.id });
    toast(`Added to ${target.title}.`);
  } catch (err) { toastError(err); }
}

/** Edit a track's details. Resolves to the saved track or null. */
async function trackForm(track) {
  const episodeKind = track.kind === 'episode';
  const title = h('input', { maxLength: 200, value: track.title });
  const desc = h('textarea', { rows: 6, maxLength: MAX_DESCRIPTION, value: track.description });
  const a = h('input', episodeKind ? { type: 'number', min: 0, value: track.season ?? '' } : { maxLength: 120, value: track.album ?? '' });
  const b = h('input', episodeKind ? { type: 'number', min: 0, value: track.episode_number ?? '' } : { maxLength: 40, value: track.genre ?? '' });
  const ok = await dialog({
    title: episodeKind ? 'Edit episode' : 'Edit song',
    wide: true,
    body: h('div',
      h('label.field', h('span', 'Title'), title),
      h('label.field', h('span', 'Description'), desc),
      h('div.audio-fields', h('label.field', h('span', episodeKind ? 'Season' : 'Album'), a), h('label.field', h('span', episodeKind ? 'Episode' : 'Genre'), b))),
    actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }],
  });
  if (!ok) return null;
  try {
    const r = await api.patch(`audio/tracks/${track.id}`, {
      title: title.value, description: desc.value,
      ...(episodeKind ? { season: a.value || null, episode_number: b.value || null } : { album: a.value || null, genre: b.value || null }),
    });
    toast('Saved.');
    return r.track;
  } catch (err) {
    toastError(err);
    return null;
  }
}

// ── Show page ────────────────────────────────────────────────────────────

async function showPage(ctx, id) {
  const data = await api.get(`audio/shows/${id}`, null, { signal: ctx.signal }).catch(err => {
    if (err.status === 404) return null;
    throw err;
  });
  if (!data) return notFound(ctx);
  const { show } = data;
  let tracks = data.tracks;
  let next = data.next;
  ctx.title(show.title);
  const podcast = show.kind === 'podcast';

  const stats = h('p.audio-stats');
  const paintStats = () => {
    stats.textContent = [show.category, plural(show.follower_count, 'follower'), podcast ? plural(show.track_count, 'episode') : plural(show.track_count, 'song')]
      .filter(Boolean).join(', ');
  };
  paintStats();

  const listHost = h('div');
  const moreHost = h('div');
  const paintList = () => {
    mount(listHost, trackList(tracks, { emptyText: podcast ? 'No episodes yet.' : 'No songs yet.', showShow: false, numbered: !podcast }));
    mount(moreHost, next ? h('button', { type: 'button', onclick: loadMore }, 'More') : null);
  };
  async function loadMore() {
    try {
      const page = await api.get(`audio/shows/${show.id}/tracks`, { cursor: next });
      tracks = tracks.concat(page.items);
      next = page.next;
      paintList();
    } catch (err) { toastError(err); }
  }
  paintList();

  const owner = show.viewer.can_edit;
  const actions = h('div.row.wrap.audio-actions',
    tracks.length ? h('button.btn', { type: 'button', onclick: () => playTrack(tracks[0], { queue: tracks }) }, podcast ? 'Play latest' : 'Play') : null,
    owner ? null : followShowButton(show, { onChange: paintStats }),
    owner ? h('a.btn', { href: `/audio/upload?show=${show.id}` }, 'Upload') : null,
    owner ? h('button.btn', { type: 'button', onclick: async () => {
      const saved = await showForm({ show });
      if (saved) navigate(`/audio/show/${show.id}`, { replace: true, scroll: false });
    } }, 'Edit') : null,
    owner ? h('button.btn', { type: 'button', onclick: async () => {
      if (!(await confirm(`Delete ${show.title}?`, { title: 'Delete show', ok: 'Delete' }))) return;
      try {
        await api.del(`audio/shows/${show.id}`);
        toast('Deleted.');
        navigate('/audio/library');
      } catch (err) { toastError(err); }
    } }, 'Delete') : null,
    h('button.btn', { type: 'button', onclick: () => share(`/audio/show/${show.id}`, show.title) }, 'Share'));

  return h('div.audio-page', header(null),
    h('div.south-card.audio-hero',
      cover(show.cover_url, { size: 'xl', title: show.title }),
      h('div.audio-hero-text',
        h('p.eyebrow', kindWord(show.kind)),
        h('h2.audio-hero-title', show.title),
        h('p', 'By ', h('a', { href: `/@${show.owner.handle}` }, show.owner.name)),
        stats,
        actions)),
    show.description ? h('section.south-card.audio-section', h('h2', 'About'), h('div.audio-description', richText(show.description))) : null,
    h('section.south-card.audio-section', h('h2', podcast ? 'Episodes' : 'Songs'), listHost, moreHost));
}

// ── Track page ───────────────────────────────────────────────────────────

async function trackPage(ctx, id) {
  const data = await api.get(`audio/tracks/${id}`, null, { signal: ctx.signal }).catch(err => {
    if (err.status === 404) return null;
    throw err;
  });
  if (!data) return notFound(ctx);
  const { track, more } = data;
  ctx.title(track.title);
  const owner = track.viewer.can_edit;

  const details = [
    episodeLabel(track),
    track.kind === 'song' && track.album ? `Album: ${track.album}` : null,
    track.kind === 'song' && track.genre ? `Genre: ${track.genre}` : null,
    fullDate(track.published_at),
    track.duration ? fmt(track.duration) : null,
  ].filter(Boolean).join(', ');
  const stats = h('p.audio-stats');
  const paintStats = () => {
    stats.textContent = [plural(track.play_count, 'play'), plural(track.like_count, 'like'), progressNote(track)].filter(Boolean).join(', ');
  };
  paintStats();

  const resume = track.kind === 'episode' && track.viewer.progress && !track.viewer.completed;
  const actions = h('div.row.wrap.audio-actions',
    playButton(track, { queue: [track, ...more], small: false, label: resume ? 'Resume' : 'Play' }),
    likeButton(track, { onChange: paintStats }),
    h('button.btn', { type: 'button', onclick: () => addToPlaylist(track) }, 'Add to playlist'),
    h('button.btn', { type: 'button', onclick: () => enqueue(track) }, 'Add to queue'),
    h('button.btn', { type: 'button', onclick: () => share(`/audio/track/${track.id}`, track.title) }, 'Share'),
    owner ? h('button.btn', { type: 'button', onclick: async () => {
      if (await trackForm(track)) navigate(`/audio/track/${track.id}`, { replace: true, scroll: false });
    } }, 'Edit') : null,
    owner ? h('button.btn', { type: 'button', onclick: async () => {
      if (!(await confirm(`Delete ${track.title}? The file and its feed post are deleted too.`, { title: 'Delete', ok: 'Delete' }))) return;
      try {
        await api.del(`audio/tracks/${track.id}`);
        toast('Deleted.');
        navigate(`/audio/show/${track.show.id}`);
      } catch (err) { toastError(err); }
    } }, 'Delete') : null);

  return h('div.audio-page', header(null),
    h('div.south-card.audio-hero',
      cover(track.cover_url, { size: 'xl', title: track.title }),
      h('div.audio-hero-text',
        h('p.eyebrow', kindWord(track.kind)),
        h('h2.audio-hero-title', track.title),
        h('p', h('a', { href: `/audio/show/${track.show.id}` }, track.show.title), ' by ', h('a', { href: `/@${track.owner.handle}` }, track.owner.name)),
        h('p.audio-stats', details),
        stats,
        actions)),
    track.description ? h('section.south-card.audio-section', h('h2', 'Description'), h('div.audio-description', richText(track.description))) : null,
    track.post_id ? h('p.fine', h('a', { href: `/post/${track.post_id}` }, 'Comments on the feed post')) : null,
    h('section.south-card.audio-section', h('h2', `More from ${track.show.title}`),
      trackList(more, { emptyText: 'Nothing else yet.', showShow: false })));
}

// ── Playlist page ────────────────────────────────────────────────────────

async function playlistPage(ctx, id) {
  const data = await api.get(`audio/playlists/${id}`, null, { signal: ctx.signal }).catch(err => {
    if (err.status === 404) return null;
    throw err;
  });
  if (!data) return notFound(ctx);
  const { playlist } = data;
  let tracks = data.tracks;
  ctx.title(playlist.title);
  const owner = playlist.viewer.can_edit;

  const stats = h('p.audio-stats');
  const listHost = h('div');
  const paint = () => {
    const total = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    stats.textContent = [playlist.visibility === 'private' ? 'Private' : null, plural(tracks.length, 'track'), total ? fmt(total) : null].filter(Boolean).join(', ');
    mount(listHost, trackList(tracks, {
      emptyText: 'No tracks yet. Use "Add to playlist" on any episode or song.',
      numbered: true,
      extra: owner ? (t, i) => [
        h('button.btn-small', { type: 'button', disabled: i === 0, 'aria-label': `Move ${t.title} up`, onclick: () => move(i, -1) }, 'Up'),
        h('button.btn-small', { type: 'button', disabled: i === tracks.length - 1, 'aria-label': `Move ${t.title} down`, onclick: () => move(i, 1) }, 'Down'),
        h('button.btn-small', { type: 'button', onclick: () => remove(t) }, 'Remove'),
      ] : undefined,
    }));
  };
  async function move(i, dir) {
    const order = tracks.slice();
    [order[i], order[i + dir]] = [order[i + dir], order[i]];
    try {
      tracks = (await api.put(`audio/playlists/${playlist.id}/order`, { track_ids: order.map(t => t.id) })).tracks;
      paint();
    } catch (err) { toastError(err); }
  }
  async function remove(t) {
    try {
      await api.del(`audio/playlists/${playlist.id}/tracks/${t.id}`);
      tracks = tracks.filter(x => x.id !== t.id);
      toast('Removed.');
      paint();
    } catch (err) { toastError(err); }
  }
  paint();

  const actions = h('div.row.wrap.audio-actions',
    h('button.btn', { type: 'button', onclick: () => { if (tracks.length) playTrack(tracks[0], { queue: tracks }); } }, 'Play'),
    h('button.btn', { type: 'button', onclick: () => { if (tracks.length) { const q = shuffle(tracks); playTrack(q[0], { queue: q }); } } }, 'Shuffle'),
    playlist.visibility === 'public' ? h('button.btn', { type: 'button', onclick: () => share(`/audio/playlist/${playlist.id}`, playlist.title) }, 'Share') : null,
    owner ? h('button.btn', { type: 'button', onclick: async () => {
      if (await playlistForm(playlist)) navigate(`/audio/playlist/${playlist.id}`, { replace: true, scroll: false });
    } }, 'Edit') : null,
    owner ? h('button.btn', { type: 'button', onclick: async () => {
      if (!(await confirm(`Delete ${playlist.title}?`, { title: 'Delete playlist', ok: 'Delete' }))) return;
      try {
        await api.del(`audio/playlists/${playlist.id}`);
        toast('Deleted.');
        navigate('/audio/library');
      } catch (err) { toastError(err); }
    } }, 'Delete') : null);

  return h('div.audio-page', header(null),
    h('div.south-card.audio-hero',
      cover(playlist.cover_url, { size: 'xl', title: playlist.title }),
      h('div.audio-hero-text',
        h('p.eyebrow', 'Playlist'),
        h('h2.audio-hero-title', playlist.title),
        h('p', 'By ', h('a', { href: `/@${playlist.owner.handle}` }, playlist.owner.name)),
        stats,
        playlist.description ? h('p.audio-description', playlist.description) : null,
        actions)),
    h('section.south-card.audio-section', h('h2', 'Tracks'), listHost));
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
