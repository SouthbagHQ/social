// /albums/:id - one shared album: members, and the photos and videos everyone added.
// The media itself is stored in and served from Southbag Drive; this page only sees metadata.
//   GET /api/albums/:id    PATCH /api/albums/:id { title }    POST /api/albums/:id/members { handle }
//   POST /api/albums/:id/leave    GET /api/albums/:id/media?cursor    PUT /api/albums/:id/media

import { api } from '../api.js';
import { h } from '../dom.js';
import { plural } from '../format.js';
import { navigate } from '../router.js';
import { confirm, empty, errorBox, infiniteList, lightbox, promptDialog, refuseDelete, toast, toastError } from '../ui.js';
import { avatar } from '../components/user.js';
import { videoEl } from '../components/media.js';
import { LIMITS, pickFiles, prepareImage } from '../upload.js';

/** One grid cell: a stretched photo that opens in the lightbox, or a playable video. */
function mediaCell(m) {
  if (m.kind === 'video') return h('div.album-cell', videoEl(m, { preload: 'metadata' }));
  return h('button.album-cell', { type: 'button', onclick: () => lightbox(m.url), 'aria-label': 'View photo' },
    h('img', { src: m.url, alt: '', loading: 'lazy' }));
}

/** Streams one file into the album through the Worker, which puts it in Southbag Drive. */
async function uploadAlbumFile(albumId, file) {
  let blob = file;
  let type = file.type;
  if (file.type.startsWith('image/')) {
    const prepared = await prepareImage(file);
    blob = prepared.blob;
    type = blob.type || file.type;
  }
  const kind = type.startsWith('image/') ? 'image' : 'video';
  if (blob.size > LIMITS[kind]) throw new Error(`That ${kind === 'image' ? 'photo' : 'video'} is too big.`);
  const response = await fetch(`/api/albums/${albumId}/media`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': type, 'x-sb-filename': encodeURIComponent(file.name || 'photo') },
    body: blob,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || `Upload failed (${response.status}). It has been logged.`);
  return result.media;
}

export default async function albumView(ctx) {
  if (!ctx.requireAuth()) return null;
  const id = ctx.params.id;

  let data;
  try {
    data = await api.get(`albums/${id}`, undefined, { signal: ctx.signal });
  } catch (err) {
    ctx.title('Album not found');
    return h('div.south-card', errorBox(err));
  }
  const { album, viewer, members } = data;
  ctx.title(album.title);

  const grid = infiniteList({
    className: 'album-media-grid',
    signal: ctx.signal,
    load: cursor => api.get(`albums/${id}/media`, { cursor }, { signal: ctx.signal }),
    render: mediaCell,
    empty: empty({ title: 'No photos or videos yet.' }),
  });

  const uploading = h('span.tiny');
  async function addFiles() {
    const files = await pickFiles({ accept: 'image/*,video/*', multiple: true });
    if (!files.length) return;
    let added = 0;
    for (const file of files) {
      uploading.textContent = `Uploading ${file.name || 'file'} (${added + 1}/${files.length})`;
      try {
        await uploadAlbumFile(id, file);
        added++;
      } catch (err) {
        toastError(err);
        break;
      }
    }
    uploading.textContent = '';
    if (added) {
      toast(added === 1 ? 'Added to the album.' : `${added} added to the album.`);
      // Freshest first: reload the page so the new media lands in the grid.
      navigate(`/albums/${id}`);
    }
  }

  async function rename() {
    const title = await promptDialog('Album title', { value: album.title, ok: 'Save' });
    if (!title || title === album.title) return;
    try {
      await api.patch(`albums/${id}`, { title });
      navigate(`/albums/${id}`);
    } catch (err) {
      toastError(err);
    }
  }

  async function invite() {
    const handle = await promptDialog('Invite by handle', { ok: 'Invite', placeholder: 'kevin' });
    if (!handle) return;
    try {
      const { member } = await api.post(`albums/${id}/members`, { handle: handle.replace(/^@/, '') });
      toast(`Added @${member.user.handle}.`);
      navigate(`/albums/${id}`);
    } catch (err) {
      toastError(err);
    }
  }

  async function leave() {
    if (!await confirm('Leave this album? You can only come back if the owner adds you again.', { ok: 'Leave' })) return;
    try {
      await api.post(`albums/${id}/leave`);
      navigate('/albums');
    } catch (err) {
      toastError(err);
    }
  }

  const owner = viewer.role === 'owner';
  return h('div.album-page',
    h('div.page-head',
      h('h1', album.title),
      h('span.spacer'),
      h('button.btn', { type: 'button', onclick: addFiles }, 'Add photos or videos')),
    h('p.albums-note.tiny', 'Stored in Southbag Drive. Everything you share is kept.'),
    h('div.south-card.album-members',
      h('h2', `Members (${members.length})`),
      h('div.album-member-row', members.map(m =>
        h('a.album-member', { href: `/@${m.user.handle}`, title: m.role === 'owner' ? 'Owner' : 'Member' },
          avatar(m.user, { size: 'sm' }),
          h('span.album-member-name', m.user.name || `@${m.user.handle}`,
            m.role === 'owner' ? ' (owner)' : '')))),
      h('div.row',
        owner ? h('button.btn-small', { type: 'button', onclick: invite }, 'Invite') : null,
        owner ? h('button.btn-small', { type: 'button', onclick: rename }, 'Rename') : null,
        owner ? h('button.btn-small', { type: 'button', onclick: refuseDelete }, 'Delete') : null,
        !owner ? h('button.btn-small', { type: 'button', onclick: leave }, 'Leave album') : null)),
    uploading,
    grid);
}
