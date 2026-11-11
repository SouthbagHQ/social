// /albums - your shared albums. Photos and videos in them live in Southbag Drive.
//   GET /api/albums?cursor    POST /api/albums { title }

import { api } from '../api.js';
import { h } from '../dom.js';
import { plural } from '../format.js';
import { navigate } from '../router.js';
import { empty, infiniteList, promptDialog, toastError } from '../ui.js';

/** An album as an inset tile: stretched cover, title, counts. */
function albumTile(a) {
  return h('a.south-item.album-tile', { href: `/albums/${a.id}` },
    h('div.album-cover', a.cover_url ? h('img', { src: a.cover_url, alt: '', loading: 'lazy' }) : null),
    h('div.album-tile-body',
      h('strong', a.title),
      h('div.album-tile-meta', `${plural(a.media_count, 'item')}, ${plural(a.member_count, 'member')}`),
      a.role === 'owner' ? h('span.chip', 'Owner') : null));
}

async function createAlbum() {
  const title = await promptDialog('Album title', { ok: 'Create', placeholder: 'Holiday 2026' });
  if (!title || !title.trim()) return;
  try {
    const { album } = await api.post('albums', { title: title.trim() });
    navigate(`/albums/${album.id}`);
  } catch (err) {
    toastError(err);
  }
}

export default function albumsView(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Albums');

  const list = infiniteList({
    className: 'album-grid',
    signal: ctx.signal,
    load: cursor => api.get('albums', { cursor }, { signal: ctx.signal }),
    render: albumTile,
    empty: empty({
      title: 'No albums yet.',
      action: h('button.btn-small', { type: 'button', onclick: createAlbum }, 'Create album'),
    }),
  });

  return h('div.albums-page',
    h('div.page-head',
      h('h1', 'Albums'),
      h('span.spacer'),
      h('button.btn', { type: 'button', onclick: createAlbum }, 'Create album')),
    h('p.albums-note.tiny', 'Shared albums are stored in Southbag Drive. Everything you share is kept.'),
    list);
}
