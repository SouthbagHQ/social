// /boards and /boards/:boardId - boards of saved photos (Pinterest style).
//   /boards                       "For you": pins from boards and people you follow (or recent pins)
//   /boards?tab=yours|following|create
//   /boards?owner=<handle>        someone's boards
//   /boards?q=<text>              pin search
//   /boards/:boardId[?pin=<id>]   a board (and optionally one pin opened over it)
// API: see src/routes/boards.ts.

import { api } from '../api.js';
import { track } from '../analytics.js';
import { h, mount } from '../dom.js';
import { plural } from '../format.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, errorBox, infiniteList, loading, promptDialog, refuseDelete, share, tabs, toast, toastError } from '../ui.js';
import { pickFiles, uploadFile } from '../upload.js';
import { field, formDialog, saveToBoard } from '../components/board-picker.js';
import { avatar, userName } from '../components/user.js';

const TABS = [
  ['foryou', 'For you'],
  ['yours', 'Your boards'],
  ['following', 'Following'],
  ['create', 'Create board'],
];

// Every pin gets a box of one of these shapes (picked from its id, so it never changes) and the
// photo is stretched into it, whatever shape the photo is.
const SHAPES = ['shape-tall', 'shape-square', 'shape-taller', 'shape-wide', 'shape-portrait'];
const shapeOf = id => SHAPES[[...String(id).slice(-5)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % SHAPES.length];

const pinHref = pin => `/boards/${pin.board?.id}?pin=${pin.id}`;

export default async function view(ctx) {
  ctx.layout('wide');
  return ctx.params.boardId ? boardPage(ctx) : boardsHome(ctx);
}

// ── Grids ───────────────────────────────────────────────────────────────

/** One pin in a masonry grid. Opens the pin over the page when clicked. */
function pinTile(pin, opts = {}) {
  const tile = h('a.pin-tile', {
    href: pinHref(pin),
    dataset: { pinId: pin.id },
    onclick: e => { e.preventDefault(); if (opts.onOpen) opts.onOpen(pin); else openPin(pin, { ...opts, tile }); },
  },
    h('span.pin-img', { class: shapeOf(pin.id) }, h('img', { src: pin.image.url, alt: pin.title || pin.image.alt || '', loading: 'lazy' })),
    pin.title ? h('span.pin-title', pin.title) : null,
    h('span.pin-by', opts.showBoard && pin.board ? pin.board.title : pin.user.name));
  tile._pin = pin;
  return tile;
}

/** A paged masonry grid of pins. */
function pinGrid(load, { emptyText = 'No pins yet.', signal, ...opts } = {}) {
  return infiniteList({ load, signal, className: 'pin-grid', render: pin => pinTile(pin, opts), empty: empty({ title: emptyText }) });
}

/** Board cover: one large and two small photos, each stretched into its slot. */
function boardCover(board) {
  const slot = (m, cls) => h(`span.cover-slot.${cls}`, m ? h('img', { src: m.url, alt: '', loading: 'lazy' }) : null);
  return h('span.board-cover', slot(board.covers[0], 'big'), slot(board.covers[1], 'small-a'), slot(board.covers[2], 'small-b'));
}

function boardCard(board, { ownerId = null } = {}) {
  return h('a.board-card', { href: `/boards/${board.id}` },
    boardCover(board),
    h('span.board-card-title', board.title),
    h('span.board-card-meta', plural(board.pin_count, 'pin'), board.visibility === 'secret' ? ', secret' : '',
      board.owner && !board.viewer.is_owner && board.owner.id !== ownerId ? `, by ${board.owner.name}` : ''));
}

function boardGrid(load, { emptyText, signal, ownerId }) {
  return infiniteList({ load, signal, className: 'board-grid', render: b => boardCard(b, { ownerId }), empty: empty({ title: emptyText }) });
}

// ── /boards ─────────────────────────────────────────────────────────────

async function boardsHome(ctx) {
  const q = (ctx.query.get('q') || '').trim();
  const owner = (ctx.query.get('owner') || '').replace(/^@/, '').trim();
  const tab = TABS.some(([key]) => key === ctx.query.get('tab')) ? ctx.query.get('tab') : 'foryou';
  ctx.title('Boards');

  const search = h('input.input', { type: 'search', name: 'q', value: q, placeholder: 'Search pins', 'aria-label': 'Search pins' });
  const head = h('div.page-head.boards-head',
    h('h1', 'Boards'),
    h('span.spacer'),
    h('form.boards-search', { onsubmit: e => { e.preventDefault(); const v = search.value.trim(); navigate(v ? `/boards?q=${encodeURIComponent(v)}` : '/boards'); } },
      search, h('button', { type: 'submit' }, 'Search')));

  const strip = tabs(TABS.map(([key, label]) => ({
    href: key === 'foryou' ? '/boards' : `/boards?tab=${key}`, label, current: !q && !owner && key === tab,
  })));

  if (q) {
    ctx.title(`${q} - Boards`);
    return h('div.boards', head, strip, h('p.boards-sub', `Pins matching "${q}"`),
      pinGrid(cursor => api.get('boards/search', { q, cursor }, { signal: ctx.signal }), { emptyText: 'No results.', signal: ctx.signal, showBoard: true }));
  }

  if (owner) {
    const root = h('div.boards', head, strip, loading());
    let user;
    try {
      user = (await api.get(`users/${encodeURIComponent(owner)}`, null, { signal: ctx.signal })).user;
    } catch (err) {
      mount(root, head, strip, errorBox(err));
      return root;
    }
    ctx.title(`${user.name}'s boards`);
    const mine = store.me?.id === user.id;
    mount(root, head, strip,
      h('div.boards-owner', avatar(user), h('div.grow', h('h2', `${user.name}'s boards`), h('p.fine', h('a', { href: `/@${user.handle}` }, `@${user.handle}`)))),
      boardGrid(cursor => api.get('boards', { owner: user.handle, cursor }, { signal: ctx.signal }),
        { emptyText: mine ? 'You have no boards yet.' : 'No boards yet.', signal: ctx.signal, ownerId: user.id }));
    return root;
  }

  if (tab === 'foryou') {
    const note = h('p.boards-sub');
    let mode;
    const grid = pinGrid(async cursor => {
      const data = await api.get('boards/feed', { cursor, mode }, { signal: ctx.signal });
      if (!mode) {
        mode = data.mode;
        note.textContent = mode === 'recent'
          ? (store.me ? 'Recent pins. Follow boards and people to see their pins here.' : 'Recent pins')
          : 'From boards and people you follow';
      }
      return data;
    }, { signal: ctx.signal, emptyText: 'No pins yet.', showBoard: true });
    return h('div.boards', head, strip, note, grid);
  }

  if (!ctx.requireAuth()) return h('div');

  if (tab === 'yours') {
    return h('div.boards', head, strip,
      boardGrid(cursor => api.get('boards', { cursor }, { signal: ctx.signal }), { emptyText: 'You have no boards yet.', signal: ctx.signal }));
  }
  if (tab === 'following') {
    return h('div.boards', head, strip,
      boardGrid(cursor => api.get('boards/following', { cursor }, { signal: ctx.signal }), { emptyText: 'You are not following any boards.', signal: ctx.signal }));
  }
  return h('div.boards', head, strip, createForm());
}

function createForm() {
  const title = h('input.input', { maxLength: 50, required: true, placeholder: 'Kitchen ideas' });
  const description = h('textarea.textarea', { maxLength: 500, rows: 3 });
  const secret = h('input', { type: 'checkbox' });
  const submit = h('button.btn', { type: 'submit' }, 'Create');
  return h('form.south-card.board-create', {
    onsubmit: async e => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const { board } = await api.post('boards', { title: title.value, description: description.value, visibility: secret.checked ? 'secret' : 'public' });
        toast('Board created.');
        navigate(`/boards/${board.id}`);
      } catch (err) { toastError(err); submit.disabled = false; }
    },
  },
    h('h2', 'Create board'),
    field('Name', title),
    field('Description', description),
    h('label.checkbox', secret, h('span', 'Keep this board secret', h('br'), h('small.fine', 'Only you and collaborators will see it.'))),
    submit);
}

// ── /boards/:boardId ────────────────────────────────────────────────────

async function boardPage(ctx) {
  const id = ctx.params.boardId;
  const root = h('div.boards', loading());
  let data;
  try {
    data = await api.get(`boards/${id}`, null, { signal: ctx.signal });
  } catch (err) {
    if (err.name === 'AbortError') return root;
    ctx.title('Boards');
    mount(root, h('div.page-head', h('h1', 'Boards')), errorBox(err), h('p', h('a', { href: '/boards' }, 'Back to boards')));
    return root;
  }
  ctx.title(data.board.title);

  const header = h('div');
  const canArrange = () => Boolean(data.viewer.can_edit);
  let grid;
  const reload = async () => {
    try {
      data = await api.get(`boards/${id}`);
      mount(header, boardHead(data, { reload, grid: () => grid, canArrange }));
    } catch (err) { toastError(err); }
  };
  mount(header, boardHead(data, { reload, grid: () => grid, canArrange }));
  grid = pinGrid(cursor => api.get(`boards/${id}/pins`, { cursor }, { signal: ctx.signal }), {
    signal: ctx.signal, onBoard: id, onChange: reload, canArrange,
  });
  mount(root, h('p.boards-crumbs', h('a', { href: '/boards' }, 'Boards'), ' / ',
    data.board.owner ? h('a', { href: `/boards?owner=${data.board.owner.handle}` }, data.board.owner.name) : null), header, grid);

  const pinId = ctx.query.get('pin');
  if (pinId) {
    api.get(`boards/pins/${pinId}`, null, { signal: ctx.signal })
      .then(({ pin }) => openPin(pin, { onBoard: id, onChange: reload, canArrange }))
      .catch(err => { if (err.name !== 'AbortError') toastError(err); });
  }
  return root;
}

function boardHead(data, { reload, grid, canArrange }) {
  const { board, viewer, collaborators } = data;
  const owner = viewer.role === 'owner';
  const tools = h('div.board-tools');

  if (!owner) {
    let following = viewer.following;
    const follow = h('button.btn', { type: 'button' }, following ? 'Following' : 'Follow');
    follow.addEventListener('click', async () => {
      if (!store.me) return login();
      follow.disabled = true;
      try {
        const res = following ? await api.del(`boards/${board.id}/follow`) : await api.put(`boards/${board.id}/follow`);
        following = res.following;
        follow.textContent = following ? 'Following' : 'Follow';
        followers.textContent = plural(res.follower_count, 'follower');
        if (following) toast(`Following ${board.title}.`);
      } catch (err) { toastError(err); }
      follow.disabled = false;
    });
    tools.append(follow);
  }
  if (viewer.can_edit) tools.append(h('button.btn', { type: 'button', onclick: () => addPin(board, { grid, reload, canArrange }) }, 'Add pin'));
  if (owner) {
    tools.append(
      h('button.btn', { type: 'button', onclick: () => editBoard(board, reload) }, 'Edit board'),
      h('button.btn', { type: 'button', onclick: () => invite(board, reload) }, 'Invite'));
  }
  if (viewer.role === 'editor') tools.append(h('button.btn', { type: 'button', onclick: () => leave(board, reload) }, 'Leave board'));
  tools.append(h('button.btn', { type: 'button', onclick: () => share(`/boards/${board.id}`, board.title) }, 'Share'));

  const followers = h('span', plural(board.follower_count, 'follower'));
  const invitation = viewer.role === 'invited' ? h('div.notice.board-invite',
    h('p', `${board.owner?.name || 'The owner'} invited you to collaborate on this board.`),
    h('div.row',
      h('button', { type: 'button', onclick: async () => {
        try { await api.post(`boards/${board.id}/collaborators/accept`); toast('You can now add pins to this board.'); reload(); }
        catch (err) { toastError(err); }
      } }, 'Accept'),
      h('button', { type: 'button', onclick: async () => {
        try { await api.del(`boards/${board.id}/collaborators/${store.me.handle}`); toast('Invitation declined.'); reload(); }
        catch (err) { toastError(err); }
      } }, 'Decline'))) : null;

  const people = collaborators.length ? h('div.board-collaborators',
    h('span.board-label', 'Collaborators'),
    collaborators.map(cb => h('span.board-person',
      avatar(cb.user, { size: 'xs' }), userName(cb.user, { handle: false }),
      cb.role === 'invited' ? h('span.fine', 'Invited') : null,
      owner ? h('button.btn-small', { type: 'button', onclick: async () => {
        if (!(await confirm(`Remove ${cb.user.name} from this board?`, { title: 'Remove collaborator', ok: 'Remove' }))) return;
        try { await api.del(`boards/${board.id}/collaborators/${cb.user.handle}`); toast('Removed.'); reload(); }
        catch (err) { toastError(err); }
      } }, 'Remove') : null))) : null;

  return h('section.south-card.board-head',
    invitation,
    h('h1.board-title', board.title),
    board.owner ? h('div.board-owner', avatar(board.owner, { size: 'sm' }), userName(board.owner)) : null,
    board.description ? h('p.board-description', board.description) : null,
    h('p.board-stats', h('span', plural(board.pin_count, 'pin')), followers,
      board.visibility === 'secret' ? h('span', 'Secret board') : null),
    people,
    tools);
}

async function editBoard(board, reload) {
  const title = h('input.input', { value: board.title, maxLength: 50, required: true });
  const description = h('textarea.textarea', { maxLength: 500, rows: 3 }, board.description);
  const secret = h('input', { type: 'checkbox', checked: board.visibility === 'secret' });
  const saved = await formDialog({
    title: 'Edit board',
    extra: () => h('button', { type: 'button', onclick: refuseDelete }, 'Delete board'),
    content: [field('Name', title), field('Description', description), h('label.checkbox', secret, h('span', 'Keep this board secret'))],
    onSubmit: () => api.patch(`boards/${board.id}`, { title: title.value, description: description.value, visibility: secret.checked ? 'secret' : 'public' }),
  });
  if (saved) { toast('Saved.'); reload(); }
}

async function invite(board, reload) {
  const handle = await promptDialog('Username', { title: 'Invite to board', placeholder: 'bob', ok: 'Invite' });
  if (!handle) return;
  try {
    await api.post(`boards/${board.id}/collaborators`, { handle: handle.replace(/^@/, '') });
    toast('Invitation sent.');
    reload();
  } catch (err) { toastError(err); }
}

async function leave(board, reload) {
  if (!(await confirm('Leave this board? Your pins stay on it.', { title: 'Leave board', ok: 'Leave' }))) return;
  try {
    await api.del(`boards/${board.id}/collaborators/${store.me.handle}`);
    toast('You left the board.');
    reload();
  } catch (err) { toastError(err); }
}

async function addPin(board, { grid, reload, canArrange }) {
  let media = null;
  const preview = h('div.pin-upload-preview', h('span.fine', 'No photo chosen.'));
  const status = h('span.fine');
  const choose = h('button', { type: 'button' }, 'Choose photo');
  choose.addEventListener('click', async () => {
    const [file] = await pickFiles({ accept: 'image/*' });
    if (!file) return;
    choose.disabled = true;
    status.textContent = 'Uploading';
    try {
      if (media) api.del(`media/${media.id}`).catch(() => {});
      media = await uploadFile(file, { onProgress: p => { status.textContent = `Uploading ${Math.round(p * 100)}%`; } });
      mount(preview, h('img', { src: media.url, alt: '' }));
      status.textContent = '';
    } catch (err) { toastError(err); status.textContent = ''; }
    choose.disabled = false;
  });
  const title = h('input.input', { maxLength: 100 });
  const note = h('textarea.textarea', { maxLength: 500, rows: 3 });
  const link = h('input.input', { type: 'url', placeholder: 'https://' });
  const result = await formDialog({
    title: 'Add pin',
    wide: true,
    content: h('div.pin-form', h('div.pin-form-photo', preview, h('div.row', choose, status)),
      h('div.grow', field('Title', title), field('Note', note), field('Link', link))),
    onSubmit: async () => {
      if (!media) throw new Error('Choose a photo first.');
      return api.post(`boards/${board.id}/pins`, { media_id: media.id, title: title.value, note: note.value, link: link.value });
    },
  });
  if (!result) {
    if (media) api.del(`media/${media.id}`).catch(() => {});
    return;
  }
  toast('Pinned.');
  grid()?.prepend(pinTile(result.pin, { onBoard: board.id, onChange: reload, canArrange }));
  reload();
}

// ── A pin, opened over the page ─────────────────────────────────────────

function openPin(first, opts = {}) {
  track('social_pin_opened', { pin_id: first.id });
  let titleEl, scroller;
  return dialog({
    title: first.title || 'Pin',
    wide: true,
    actions: [],
    onOpen: box => {
      titleEl = box.querySelector('.dialog-title');
      scroller = box.querySelector('.body');
    },
    body: close => {
      const root = h('div.pin-view-wrap', {
        onclick: e => { const a = e.target.closest('a[href^="/"]'); if (a && !a.classList.contains('pin-tile')) close(null); },
      });
      const show = (pin, tile) => {
        if (titleEl) titleEl.textContent = pin.title || 'Pin';
        if (scroller) scroller.scrollTop = 0;
        mount(root, pinView(pin, { ...opts, tile, close, show }));
      };
      show(first, opts.tile);
      return root;
    },
  });
}

function pinView(pin, { tile, close, show, onBoard, onChange, canArrange }) {
  const onThisBoard = onBoard && pin.board?.id === onBoard;
  const related = h('div', loading());
  api.get(`boards/pins/${pin.id}/related`).then(({ items }) => {
    mount(related, items.length
      ? h('div.pin-grid.pin-grid-small', items.map(p => {
          return pinTile(p, { showBoard: true, onOpen: () => show(p, null) });
        }))
      : h('p.muted', 'No related pins.'));
  }).catch(err => mount(related, errorBox(err)));

  let host = null;
  try { host = pin.link ? new URL(pin.link).hostname : null; } catch {}

  const tools = h('div.pin-tools',
    h('button.btn', { type: 'button', onclick: async () => { const saved = await saveToBoard({ pin }); if (saved) pin.save_count++; } }, 'Save'),
    pin.source_post_id ? h('a.btn', { href: `/post/${pin.source_post_id}` }, 'Visit source post') : null,
    !onThisBoard && pin.board ? h('a.btn', { href: `/boards/${pin.board.id}` }, 'Open board') : null,
    h('button.btn', { type: 'button', onclick: () => share(pinHref(pin), pin.title || 'Pin') }, 'Share'));

  if (pin.viewer.can_edit) {
    tools.append(
      h('button.btn', { type: 'button', onclick: () => editPin(pin, { tile, close, show, onBoard, onChange, canArrange }) }, 'Edit'),
      h('button.btn', { type: 'button', onclick: refuseDelete }, 'Delete'));
  }
  if (onThisBoard && canArrange?.() && tile?.isConnected) {
    tools.append(
      h('button.btn', { type: 'button', onclick: () => reorder(pin, tile, -1) }, 'Move up'),
      h('button.btn', { type: 'button', onclick: () => reorder(pin, tile, 1) }, 'Move down'));
  }
  if (onThisBoard && pin.board?.owner?.id === store.me?.id) {
    tools.append(h('button.btn', { type: 'button', onclick: async () => {
      try { await api.patch(`boards/${pin.board.id}`, { cover_pin_id: pin.id }); toast('Cover updated.'); onChange?.(); }
      catch (err) { toastError(err); }
    } }, 'Make cover'));
  }

  return h('div.pin-view',
    h('div.pin-view-main',
      h('div.pin-view-img', h('img', { src: pin.image.url, alt: pin.title || pin.image.alt || '' })),
      h('div.pin-view-info',
        pin.note ? h('p.pin-note', pin.note) : null,
        pin.link ? h('p', h('a', { href: pin.link, target: '_blank', rel: 'noopener noreferrer nofollow', dataset: { external: '' } }, host || pin.link)) : null,
        h('div.pin-saved-by', avatar(pin.user, { size: 'xs' }),
          h('span', 'Saved by ', h('a', { href: `/@${pin.user.handle}` }, pin.user.name),
            pin.board ? [' to ', h('a', { href: `/boards/${pin.board.id}` }, pin.board.title)] : null)),
        pin.save_count ? h('p.fine', `Saved ${plural(pin.save_count, 'time')}`) : null,
        tools)),
    h('h3.pin-related-title', 'More like this'),
    related);
}

async function reorder(pin, tile, dir) {
  const list = tile.parentElement;
  const tiles = [...list.querySelectorAll(':scope > .pin-tile')];
  const i = tiles.indexOf(tile);
  const other = tiles[i + dir];
  if (!other) return toast(dir < 0 ? 'Already at the top.' : 'Load more pins to move it further.');
  const order = dir < 0 ? [pin.id, other._pin.id] : [other._pin.id, pin.id];
  try {
    await api.put(`boards/${pin.board.id}/order`, { pin_ids: order });
    if (dir < 0) list.insertBefore(tile, other); else list.insertBefore(other, tile);
    toast(dir < 0 ? 'Moved up.' : 'Moved down.');
  } catch (err) { toastError(err); }
}

async function editPin(pin, { tile, close, show, onBoard, onChange, canArrange }) {
  const title = h('input.input', { value: pin.title, maxLength: 100 });
  const note = h('textarea.textarea', { maxLength: 500, rows: 3 }, pin.note);
  const link = h('input.input', { type: 'url', value: pin.link || '', placeholder: 'https://' });
  const boardSelect = h('select.select', h('option', { value: pin.board.id }, pin.board.title));
  api.get('boards/mine').then(({ items }) => {
    mount(boardSelect, items.map(b => h('option', { value: b.id, selected: b.id === pin.board.id }, b.title)));
    if (!items.some(b => b.id === pin.board.id)) boardSelect.prepend(h('option', { value: pin.board.id, selected: true }, pin.board.title));
  }).catch(() => {});
  const result = await formDialog({
    title: 'Edit pin',
    content: [field('Title', title), field('Note', note), field('Link', link), field('Board', boardSelect)],
    onSubmit: () => api.patch(`boards/pins/${pin.id}`, {
      title: title.value, note: note.value, link: link.value,
      ...(boardSelect.value !== pin.board.id && { board_id: boardSelect.value }),
    }),
  });
  if (!result) return;
  const updated = result.pin;
  toast(updated.board.id !== pin.board.id ? `Moved to ${updated.board.title}.` : 'Saved.');
  if (onBoard && updated.board.id !== onBoard) {
    document.querySelectorAll(`.pin-tile[data-pin-id="${pin.id}"]`).forEach(t => t.remove());
    close(null);
    onChange?.();
    return;
  }
  const fresh = pinTile(updated, { onBoard, onChange, canArrange });
  document.querySelectorAll(`.pin-tile[data-pin-id="${pin.id}"]`).forEach(t => t.replaceWith(fresh));
  show(updated, fresh);
}
