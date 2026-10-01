// Communities (Reddit style). One module for three routes:
//   /c                    home: Your communities (feed from joined communities), Popular, Create community
//   /c/:name              a community: header, Hot/New/Top, Create post, threads, sidebar
//   /c/:name/:threadId    a thread with its nested comments
// API: /api/communities (see src/routes/communities.ts for the shapes).

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { count, fullDate, plural, timeAgo } from '../format.js';
import { navigate, refresh } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, errorBox, infiniteList, lightbox, menu, promptDialog, refuseDelete, share, shake, tabs, toast, toastError } from '../ui.js';
import { uploadFile } from '../upload.js';
import { richText } from '../components/post.js';
import { avatar } from '../components/user.js';
import { pictureField } from './group-new.js';

const SORTS = [['hot', 'Hot'], ['new', 'New'], ['top', 'Top']];
const WINDOWS = [['day', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['all', 'All time']];
const NAME_RE = /^[A-Za-z0-9_]{3,21}$/;
const isMod = role => role === 'owner' || role === 'moderator';
const enc = encodeURIComponent;

/** "3h ago", "just now", "on 4 Mar". */
function ago(ms) {
  const t = timeAgo(ms);
  return t === 'now' ? 'just now' : /^\d+[mhd]$/.test(t) ? `${t} ago` : `on ${t}`;
}
const when = ms => h('time', { datetime: new Date(ms).toISOString(), title: fullDate(ms) }, ago(ms));
const threadUrl = t => `/c/${t.community.name}/${t.id}`;
const hostOf = url => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };

export default async function communitiesView(ctx) {
  const { name, threadId } = ctx.params;
  ctx.layout('wide');
  if (name && threadId) return threadPage(ctx, name, threadId);
  if (name) return communityPage(ctx, name);
  return homePage(ctx);
}

// ── Shared pieces ───────────────────────────────────────────────────────

/** A square box with the community icon stretched into it, or its initial. */
export function communityIcon(c, size = '') {
  return h('span.cm-icon', { class: { [size]: Boolean(size) } },
    c.icon_url ? h('img', { src: c.icon_url, alt: '' }) : h('span.initial', (c.name || 'c').charAt(0).toLowerCase()));
}

/**
 * Upvote / score / Downvote. `item` has { id, score, vote }. The current vote shows as a pressed
 * button and a blue score. Optimistic, then corrected from the server's answer.
 */
function voteColumn(type, item, { horizontal = false } = {}) {
  const up = h('button.icon-btn', { type: 'button' }, 'Upvote');
  const down = h('button.icon-btn', { type: 'button' }, 'Downvote');
  const score = h('span.cm-score', { 'aria-live': 'polite' });
  const paint = () => {
    up.setAttribute('aria-pressed', String(item.vote === 1));
    down.setAttribute('aria-pressed', String(item.vote === -1));
    score.textContent = count(item.score);
    score.title = plural(item.score, 'point');
    score.classList.toggle('voted', item.vote !== 0);
  };
  let busy = false;
  const cast = async value => {
    if (!store.me) return login();
    if (busy) return;
    const next = item.vote === value ? 0 : value;
    const before = { score: item.score, vote: item.vote };
    item.score += next - item.vote;
    item.vote = next;
    paint();
    busy = true;
    try {
      const res = await api.put('communities/votes', { target_type: type, target_id: item.id, value: next });
      item.score = res.score;
      item.vote = res.vote;
    } catch (err) {
      Object.assign(item, before);
      toastError(err);
    }
    busy = false;
    paint();
  };
  up.addEventListener('click', () => cast(1));
  down.addEventListener('click', () => cast(-1));
  paint();
  return h('div.cm-votes', { class: { horizontal } }, up, score, down);
}

/** Moderator "More" menu: Pin, Lock, Remove (and their opposites). */
function modButton(thread, name, onChange) {
  const more = h('button.btn-small', { type: 'button', 'aria-label': 'Moderator actions' }, 'More');
  const set = async (patch, done) => {
    try {
      const res = await api.patch(`communities/${enc(name)}/threads/${thread.id}`, patch);
      Object.assign(thread, res.thread);
      toast(done);
      onChange?.(thread);
    } catch (err) { toastError(err); }
  };
  more.addEventListener('click', () => menu(more, [
    thread.pinned ? { label: 'Unpin', onClick: () => set({ pinned: false }, 'Unpinned.') } : { label: 'Pin', onClick: () => set({ pinned: true }, 'Pinned.') },
    thread.locked ? { label: 'Unlock', onClick: () => set({ locked: false }, 'Unlocked.') } : { label: 'Lock', onClick: () => set({ locked: true }, 'Locked.') },
    thread.removed
      ? { label: 'Unhide', onClick: () => set({ removed: false }, 'Unhidden.') }
      : { label: 'Hide', onClick: () => set({ removed: true }, 'Hidden.') },
  ]));
  return more;
}

const flags = t => [
  t.pinned ? h('span.chip.teal', 'Pinned') : null,
  t.locked ? h('span.chip', 'Locked') : null,
  t.removed ? h('span.chip', 'Hidden') : null,
];

/** A row in a thread list. */
function threadRow(thread, { showCommunity = false } = {}) {
  const href = threadUrl(thread);
  const row = h('article.cm-thread', { class: { pinned: thread.pinned } });
  const paint = () => mount(row,
    voteColumn('thread', thread),
    thread.kind === 'image' && thread.image_url
      ? h('a.cm-thumb', { href, 'aria-label': thread.title }, h('img', { src: thread.image_url, alt: '', loading: 'lazy' }))
      : null,
    h('div.cm-thread-main',
      h('p.cm-meta',
        showCommunity ? [h('a.cm-community-link', { href: `/c/${thread.community.name}` }, `c/${thread.community.name}`), ' '] : null,
        'Posted by ', thread.author ? h('a', { href: `/@${thread.author.handle}` }, `u/${thread.author.handle}`) : '[deleted]',
        ' ', when(thread.created_at)),
      h('h3.cm-thread-title', h('a', { href }, thread.title), ' ', flags(thread)),
      thread.kind === 'link' && thread.url
        ? h('a.cm-link', { href: thread.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, hostOf(thread.url))
        : null,
      h('div.cm-thread-actions',
        h('a', { href }, plural(thread.comment_count, 'comment')),
        h('button.btn-small', { type: 'button', onclick: () => share(href, thread.title) }, 'Share'),
        thread.viewer?.can_moderate ? modButton(thread, thread.community.name, paint) : null)));
  paint();
  return row;
}

/** Hot / New / Top links, plus a time select for Top. `base` is the page path. */
function sortBar(base, sort, t) {
  const link = (s, extra = '') => `${base}?sort=${s}${extra}`;
  const select = h('select.select.cm-window', { 'aria-label': 'Time' }, WINDOWS.map(([value, label]) => h('option', { value, selected: value === t }, label)));
  select.addEventListener('change', () => navigate(link('top', `&t=${select.value}`)));
  return h('div.cm-sortbar',
    tabs(SORTS.map(([value, label]) => ({ href: value === 'top' ? link('top', `&t=${t}`) : link(value), label, current: value === sort }))),
    sort === 'top' ? select : null);
}

function readSort(ctx) {
  const sort = SORTS.some(([s]) => s === ctx.query.get('sort')) ? ctx.query.get('sort') : 'hot';
  const t = WINDOWS.some(([w]) => w === ctx.query.get('t')) ? ctx.query.get('t') : 'day';
  return { sort, t };
}

function threadList(ctx, path, { sort, t, showCommunity = false, onPage } = {}) {
  return infiniteList({
    className: 'cm-thread-list',
    signal: ctx.signal,
    load: cursor => api.get(path, { sort, t: sort === 'top' ? t : null, cursor }, { signal: ctx.signal }),
    render: thread => threadRow(thread, { showCommunity }),
    empty: empty({ title: 'No posts yet.' }),
    onPage,
  });
}

/** Community fields shared by the create form and the edit dialog. */
function communityFields(c = {}) {
  const title = h('input.input', { value: c.title || '', maxLength: 100, placeholder: 'Shown at the top of the community' });
  const description = h('textarea.textarea', { rows: 3, maxLength: 500 }, c.description || '');
  const rules = h('textarea.textarea', { rows: 4, placeholder: 'One rule per line' }, (c.rules || []).join('\n'));
  const icon = pictureField({ label: 'Icon', kind: 'avatar', current: c.icon_url || null, hint: 'Shown square.' });
  const banner = pictureField({ label: 'Banner', kind: 'banner', current: c.banner_url || null, hint: 'Shown wide.' });
  const nodes = [
    h('label.field', h('span', 'Title'), title),
    h('label.field', h('span', 'Description'), description),
    h('label.field', h('span', 'Rules'), rules),
    icon, banner,
  ];
  const values = () => {
    const out = { title: title.value, description: description.value, rules: rules.value };
    if (icon.value !== undefined) out.icon_media_id = icon.value;
    if (banner.value !== undefined) out.banner_media_id = banner.value;
    return out;
  };
  return { nodes, values, busy: () => icon.busy || banner.busy };
}

// ── /c ──────────────────────────────────────────────────────────────────

function homePage(ctx) {
  ctx.title('Communities');
  const tab = ['yours', 'popular', 'create'].includes(ctx.query.get('tab')) ? ctx.query.get('tab') : 'yours';
  const head = h('div.cm-home-head',
    h('h1', 'Communities'),
    tabs([
      { href: '/c', label: 'Your communities', current: tab === 'yours' },
      { href: '/c?tab=popular', label: 'Popular', current: tab === 'popular' },
      { href: '/c?tab=create', label: 'Create community', current: tab === 'create' },
    ]));
  const content = tab === 'create' ? createTab(ctx) : tab === 'popular' ? popularTab(ctx) : yoursTab(ctx);
  return h('div.cm-page', head, content);
}

function yoursTab(ctx) {
  const { sort, t } = readSort(ctx);
  const note = h('div.cm-note-host');
  const list = threadList(ctx, 'communities/feed', {
    sort, t, showCommunity: true,
    onPage: (_, page) => {
      if (page.source === 'popular' && !note.childNodes.length) {
        mount(note, h('p.fine.cm-note', ctx.me ? 'Join communities to fill this feed. Showing popular posts.' : 'Showing popular posts.'));
      }
    },
  });
  const joined = h('div.cm-joined');
  if (ctx.me) {
    api.get('communities', { tab: 'mine', limit: 50 }, { signal: ctx.signal }).then(res => {
      mount(joined, res.items.length
        ? h('ul.cm-joined-list', res.items.map(c => h('li', communityIcon(c, 'xs'), h('a', { href: `/c/${c.name}` }, `c/${c.name}`))))
        : h('p.muted', 'No communities yet.'));
    }).catch(err => { if (err.name !== 'AbortError') mount(joined, errorBox(err)); });
  } else {
    mount(joined, h('p.muted', 'Log in to join communities.'), h('button.btn-small', { type: 'button', onclick: () => login() }, 'Log in'));
  }
  const aside = h('aside.cm-aside',
    h('section.south-card.flat',
      h('h3', 'Your communities'),
      joined,
      h('div.row.wrap.cm-aside-actions',
        h('a.btn-small', { href: '/c?tab=create' }, 'Create community'),
        h('a.btn-small', { href: '/c?tab=popular' }, 'Browse'))));
  return h('div.cm-body', h('div.cm-main', h('section.south-card.flat.cm-feed-card', h('h2', 'Home'), sortBar('/c', sort, t), note), list), aside);
}

function communityRow(c) {
  let role = c.role;
  const btn = h('button.btn-small', { type: 'button' });
  const paint = () => { btn.textContent = role ? 'Joined' : 'Join'; };
  btn.addEventListener('click', async () => {
    if (!store.me) return login();
    if (role === 'owner') return navigate(`/c/${c.name}`);
    try {
      const res = role ? await api.del(`communities/${enc(c.name)}/join`) : await api.post(`communities/${enc(c.name)}/join`);
      role = res.viewer.role;
      members.textContent = plural(res.member_count, 'member');
      toast(role ? `Joined c/${c.name}.` : `Left c/${c.name}.`);
      paint();
    } catch (err) { toastError(err); }
  });
  paint();
  const members = h('span', plural(c.member_count, 'member'));
  return h('article.cm-row',
    communityIcon(c),
    h('div.grow',
      h('a.cm-row-name', { href: `/c/${c.name}` }, `c/${c.name}`),
      c.title && c.title !== c.name ? h('div.cm-row-title', c.title) : null,
      h('div.fine', members, `, ${plural(c.thread_count, 'post')}`),
      c.description ? h('p.cm-row-desc', c.description) : null),
    btn);
}

function popularTab(ctx) {
  const sort = ctx.query.get('sort') === 'new' ? 'new' : 'popular';
  const q = ctx.query.get('q') || '';
  const search = h('input.input', { type: 'search', name: 'q', value: q, placeholder: 'Search communities', 'aria-label': 'Search communities' });
  const form = h('form.cm-search.row', { onsubmit: e => {
    e.preventDefault();
    navigate(`/c?tab=popular${sort === 'new' ? '&sort=new' : ''}${search.value.trim() ? `&q=${enc(search.value.trim())}` : ''}`);
  } }, search, h('button.btn', { type: 'submit' }, 'Search'));
  const qs = q ? `&q=${enc(q)}` : '';
  const list = infiniteList({
    className: 'cm-row-list',
    signal: ctx.signal,
    load: cursor => api.get('communities', { sort, q, cursor }, { signal: ctx.signal }),
    render: communityRow,
    empty: empty({ title: q ? 'No results.' : 'No communities yet.' }),
  });
  return h('section.south-card.flat.cm-directory',
    form,
    tabs([
      { href: `/c?tab=popular${qs}`, label: 'Popular', current: sort === 'popular' },
      { href: `/c?tab=popular&sort=new${qs}`, label: 'New', current: sort === 'new' },
    ]),
    list);
}

function createTab(ctx) {
  if (!ctx.me) {
    return h('section.south-card.flat', h('p', 'Log in to create a community.'),
      h('button.btn', { type: 'button', onclick: () => login() }, 'Log in'));
  }
  const name = h('input.input', { name: 'name', maxLength: 21, required: true, autocomplete: 'off', placeholder: 'name', 'aria-describedby': 'cm-name-help' });
  const help = h('small.fine#cm-name-help', '3 to 21 letters, numbers or underscores. Names cannot be changed.');
  const preview = h('p.fine.cm-address', 'c/name');
  name.addEventListener('input', () => { preview.textContent = `c/${name.value.trim() || 'name'}`; });
  const fields = communityFields();
  const submit = h('button.btn-large', { type: 'submit' }, 'Create community');
  const form = h('form.south-card.flat.cm-form', { onsubmit: async e => {
    e.preventDefault();
    const value = name.value.trim().replace(/^c\//i, '');
    if (!NAME_RE.test(value)) { shake(form); return toast('Community names are 3 to 21 letters, numbers or underscores.', { error: true }); }
    if (fields.busy()) return toast('Wait for the upload to finish.');
    submit.disabled = true;
    try {
      const { community } = await api.post('communities', { name: value, ...fields.values() });
      toast(`Created c/${community.name}.`);
      navigate(`/c/${community.name}`);
    } catch (err) { shake(form); toastError(err); submit.disabled = false; }
  } },
    h('h2', 'Create community'),
    h('label.field', h('span', 'Name'), name, help, preview),
    fields.nodes,
    submit);
  return form;
}

// ── /c/:name ────────────────────────────────────────────────────────────

async function loadCommunity(ctx, name) {
  try {
    return await api.get(`communities/${enc(name)}`, null, { signal: ctx.signal });
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

function notFound(ctx, text) {
  ctx.title(text.replace(/\.$/, ''));
  return h('div.south-card.flat.cm-missing', empty({ title: text, action: h('a.btn-small', { href: '/c' }, 'Back to communities') }));
}

/** Banner, icon, c/name, title, members and the Join button. */
function communityHeader(ctx, data, { compact = false } = {}) {
  const c = data.community;
  let role = data.viewer.role;
  const members = h('span', plural(c.member_count, 'member'));
  const actions = h('div.cm-header-actions');
  const paint = () => {
    const buttons = [];
    if (!store.me) buttons.push(h('button.btn', { type: 'button', onclick: () => login() }, 'Join'));
    else if (!role) buttons.push(h('button.btn', { type: 'button', onclick: join }, 'Join'));
    else {
      const b = h('button.btn', { type: 'button', 'aria-haspopup': 'menu' }, 'Joined');
      b.addEventListener('click', () => menu(b, [
        role === 'owner' ? { label: 'Owners cannot leave', onClick: () => toast('Owners cannot leave their community.') } : { label: 'Leave community', onClick: leave },
      ]));
      buttons.push(b);
    }
    if (isMod(role)) buttons.push(h('button.btn-small', { type: 'button', onclick: () => editCommunity(data) }, 'Edit'));
    mount(actions, buttons);
  };
  async function join() {
    try {
      const res = await api.post(`communities/${enc(c.name)}/join`);
      role = res.viewer.role;
      members.textContent = plural(res.member_count, 'member');
      toast(`Joined c/${c.name}.`);
      paint();
    } catch (err) { toastError(err); }
  }
  async function leave() {
    if (!(await confirm(`Leave c/${c.name}?`, { title: 'Leave community', ok: 'Leave' }))) return;
    try {
      const res = await api.del(`communities/${enc(c.name)}/join`);
      role = res.viewer.role;
      members.textContent = plural(res.member_count, 'member');
      toast(`Left c/${c.name}.`);
      paint();
    } catch (err) { toastError(err); }
  }
  paint();
  return h('header.cm-header', { class: { compact } },
    h('div.cm-banner', c.banner_url ? h('img', { src: c.banner_url, alt: '' }) : null),
    h('div.cm-headline',
      communityIcon(c, 'lg'),
      h('div.grow',
        compact ? h('h2.cm-title', h('a', { href: `/c/${c.name}` }, c.title || c.name)) : h('h1.cm-title', c.title || c.name),
        h('p.cm-sub', h('a', { href: `/c/${c.name}` }, `c/${c.name}`), ', ', members)),
      actions));
}

async function editCommunity(data) {
  const c = data.community;
  const fields = communityFields(c);
  const ok = await dialog({
    title: 'Edit community',
    wide: true,
    body: h('div.cm-form', fields.nodes),
    actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }],
  });
  if (!ok) return;
  if (fields.busy()) return toast('The upload had not finished. Try again.', { error: true });
  try {
    await api.patch(`communities/${enc(c.name)}`, fields.values());
    toast('Saved.');
    refresh();
  } catch (err) { toastError(err); }
}

/** About, rules and moderators. */
function communitySidebar(data) {
  const c = data.community;
  const owner = data.viewer.role === 'owner';
  const mods = h('ul.cm-mods', data.moderators.map(m => h('li',
    avatar(m.user, { size: 'xs' }),
    h('a', { href: `/@${m.user.handle}` }, `u/${m.user.handle}`),
    m.role === 'owner' ? h('span.chip', 'Owner') : null,
    owner && m.role === 'moderator' ? h('button.btn-small', { type: 'button', onclick: () => setModerator(m.user.handle, false) }, 'Remove') : null)));
  async function setModerator(handle, on) {
    try {
      if (on) await api.put(`communities/${enc(c.name)}/moderators/${enc(handle.replace(/^[@u/]+/, ''))}`);
      else await api.del(`communities/${enc(c.name)}/moderators/${enc(handle)}`);
      toast('Saved.');
      refresh();
    } catch (err) { toastError(err); }
  }
  const addMod = owner ? h('button.btn-small', { type: 'button', onclick: async () => {
    const handle = await promptDialog('Handle of a member', { title: 'Add moderator', placeholder: 'handle', ok: 'Add' });
    if (handle) setModerator(handle, true);
  } }, 'Add moderator') : null;
  return h('aside.cm-aside',
    h('section.south-card.flat.cm-about',
      h('h3', 'About'),
      c.description ? h('p.cm-description', c.description) : h('p.muted', 'No description.'),
      h('ul.cm-facts',
        h('li', plural(c.member_count, 'member')),
        h('li', plural(c.thread_count, 'post')),
        h('li', `Created ${new Date(c.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}`))),
    h('section.south-card.flat',
      h('h3', 'Rules'),
      c.rules.length ? h('ol.cm-rules', c.rules.map(r => h('li', r))) : h('p.muted', 'No rules.')),
    h('section.south-card.flat',
      h('h3', 'Moderators'),
      mods,
      addMod));
}

async function communityPage(ctx, name) {
  const data = await loadCommunity(ctx, name);
  if (!data) return notFound(ctx, 'Community not found.');
  const c = data.community;
  ctx.title(`c/${c.name}`);
  const { sort, t } = readSort(ctx);
  let list;
  const composer = createPost(ctx, c, thread => { list.prepend(threadRow(thread)); });
  list = threadList(ctx, `communities/${enc(c.name)}/threads`, { sort, t });
  return h('div.cm-page',
    communityHeader(ctx, data),
    h('div.cm-body',
      h('div.cm-main', composer, h('section.south-card.flat.cm-sort-card', sortBar(`/c/${c.name}`, sort, t)), list),
      communitySidebar(data)));
}

/** "Create post": title, then Text / Link / Image. */
function createPost(ctx, community, onPosted) {
  const wrap = h('section.south-card.flat.cm-create');
  if (!ctx.me) {
    return mount(wrap, h('div.row.wrap', h('p.grow', 'Log in to post.'), h('button.btn', { type: 'button', onclick: () => login() }, 'Log in')));
  }
  let kind = 'text';
  let mediaId = null;
  let uploading = false;
  const title = h('input.input', { maxLength: 300, placeholder: 'Title', 'aria-label': 'Title', required: true });
  const counter = h('span.counter', '0/300');
  title.addEventListener('input', () => { counter.textContent = `${[...title.value].length}/300`; });
  const text = h('textarea.textarea', { rows: 5, maxLength: 10000, placeholder: 'Text (optional)', 'aria-label': 'Text' });
  const url = h('input.input', { type: 'url', placeholder: 'https://', 'aria-label': 'Link' });
  const preview = h('div.cm-image-preview');
  const progress = h('div.progress-bar', { hidden: true }, h('div'));
  const pick = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Image', class: 'cm-file' });
  pick.addEventListener('change', async () => {
    const [file] = pick.files;
    if (!file) return;
    mediaId = null;
    uploading = true;
    mount(preview, h('img', { src: URL.createObjectURL(file), alt: '' }));
    progress.hidden = false;
    try {
      const media = await uploadFile(file, { onProgress: p => { progress.firstChild.style.width = `${Math.round(p * 100)}%`; } });
      if (media.kind !== 'image') throw new Error('Choose an image.');
      mediaId = media.id;
    } catch (err) { toastError(err); mount(preview); pick.value = ''; }
    uploading = false;
    progress.hidden = true;
  });
  const panes = {
    text: h('div.cm-pane', text),
    link: h('div.cm-pane', url),
    image: h('div.cm-pane', pick, progress, preview),
  };
  const paneHost = h('div');
  const kindTabs = h('div');
  const paintKind = () => {
    mount(kindTabs, tabs([['text', 'Text'], ['link', 'Link'], ['image', 'Image']].map(([value, label]) =>
      ({ label, selected: kind === value, onClick: () => { kind = value; paintKind(); } }))));
    mount(paneHost, panes[kind]);
  };
  paintKind();
  const submit = h('button.btn', { type: 'submit' }, 'Post');
  const form = h('form.cm-create-form', { hidden: true, onsubmit: async e => {
    e.preventDefault();
    if (!title.value.trim()) { shake(form); return toast('Add a title.', { error: true }); }
    if (kind === 'image' && uploading) return toast('Wait for the upload to finish.');
    if (kind === 'image' && !mediaId) { shake(form); return toast('Add an image.', { error: true }); }
    submit.disabled = true;
    try {
      const payload = { title: title.value, kind };
      if (kind === 'text') payload.body = text.value;
      if (kind === 'link') payload.url = url.value.trim();
      if (kind === 'image') payload.media_id = mediaId;
      const { thread } = await api.post(`communities/${enc(community.name)}/threads`, payload);
      toast('Posted.');
      title.value = ''; text.value = ''; url.value = ''; pick.value = ''; mediaId = null; mount(preview);
      counter.textContent = '0/300';
      form.hidden = true;
      open.hidden = false;
      onPosted(thread);
    } catch (err) { shake(form); toastError(err); }
    submit.disabled = false;
  } },
    h('h3', 'Create post'),
    h('label.field', h('span', 'Title'), title, counter),
    kindTabs,
    paneHost,
    h('div.row.cm-create-actions',
      h('button.btn-small', { type: 'button', onclick: () => { form.hidden = true; open.hidden = false; } }, 'Cancel'),
      h('span.grow'),
      submit));
  const open = h('button.btn', { type: 'button', onclick: () => { form.hidden = false; open.hidden = true; title.focus(); } }, 'Create post');
  return mount(wrap, open, form);
}

// ── /c/:name/:threadId ──────────────────────────────────────────────────

async function threadPage(ctx, name, threadId) {
  const [data, threadRes] = await Promise.all([
    loadCommunity(ctx, name),
    api.get(`communities/${enc(name)}/threads/${enc(threadId)}`, null, { signal: ctx.signal }).catch(err => {
      if (err.status === 404) return null;
      throw err;
    }),
  ]);
  if (!data) return notFound(ctx, 'Community not found.');
  if (!threadRes) return notFound(ctx, 'Post not found.');
  const thread = threadRes.thread;
  const c = data.community;
  ctx.title(`${thread.title} - c/${c.name}`);
  const mod = isMod(data.viewer.role);
  const sort = ctx.query.get('sort') === 'new' ? 'new' : 'top';

  const article = h('article.south-card.flat.cm-full');
  const paintThread = () => {
    const actions = [];
    actions.push(h('span.cm-count', plural(thread.comment_count, 'comment')));
    actions.push(h('button.btn-small', { type: 'button', onclick: () => share(threadUrl(thread), thread.title) }, 'Share'));
    if (thread.viewer.can_edit) actions.push(h('button.btn-small', { type: 'button', onclick: editThread }, 'Edit'));
    if (thread.viewer.can_delete) actions.push(h('button.btn-small', { type: 'button', onclick: refuseDelete }, 'Delete'));
    if (thread.viewer.can_moderate) actions.push(modButton(thread, c.name, () => { paintThread(); paintComposer(); }));
    let content = null;
    if (thread.deleted) content = h('p.muted', 'This post was deleted.');
    else if (thread.removed && !thread.body && !thread.url && !thread.image_url) content = h('p.muted', 'This post was hidden by the moderators.');
    else if (thread.kind === 'image' && thread.image_url) {
      content = h('a.cm-image', { href: thread.image_url, 'aria-label': 'View image', onclick: e => { e.preventDefault(); lightbox(thread.image_url, thread.title); } },
        h('img', { src: thread.image_url, alt: '' }));
    } else if (thread.kind === 'link' && thread.url) {
      content = h('p.cm-link-full', h('a', { href: thread.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, thread.url));
    } else if (thread.body) content = h('div.cm-body-text', richText(thread.body));
    mount(article,
      voteColumn('thread', thread),
      h('div.cm-thread-main',
        h('p.cm-meta',
          h('a.cm-community-link', { href: `/c/${c.name}` }, `c/${c.name}`), ' ',
          'Posted by ', thread.author ? h('a', { href: `/@${thread.author.handle}` }, `u/${thread.author.handle}`) : '[deleted]',
          ' ', when(thread.created_at),
          thread.edited_at ? h('span', { title: fullDate(thread.edited_at) }, ', edited') : null),
        h('h2.cm-full-title', thread.title, ' ', flags(thread)),
        thread.removed && (thread.body || thread.url || thread.image_url) ? h('p.fine', 'Hidden by the moderators. Only you and the moderators can see this.') : null,
        content,
        h('div.cm-thread-actions', actions)));
  };

  async function editThread() {
    const input = h('textarea.textarea', { rows: 8, maxLength: 10000 }, thread.body);
    const ok = await dialog({
      title: 'Edit post', wide: true,
      body: h('label.field', h('span', 'Text'), input),
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }],
      onOpen: () => input.focus(),
    });
    if (!ok) return;
    try {
      const res = await api.patch(`communities/${enc(c.name)}/threads/${thread.id}`, { body: input.value });
      Object.assign(thread, res.thread);
      toast('Saved.');
      paintThread();
    } catch (err) { toastError(err); }
  }

  // Comments
  const tree = h('div.cm-comments');
  const composerHost = h('div');
  const bumpCount = delta => { thread.comment_count = Math.max(0, thread.comment_count + delta); paintThread(); };

  function commentForm({ parent = null, value = '', label = 'Comment', onDone, onCancel }) {
    const input = h('textarea.textarea', { rows: parent || value ? 3 : 4, maxLength: 5000, placeholder: parent ? 'Reply' : 'Add a comment', 'aria-label': label }, value);
    const submit = h('button.btn-small', { type: 'submit' }, label);
    const form = h('form.cm-comment-form', { onsubmit: async e => {
      e.preventDefault();
      if (!input.value.trim()) { shake(form); return; }
      submit.disabled = true;
      try { await onDone(input.value, form); input.value = ''; } catch (err) { shake(form); toastError(err); }
      submit.disabled = false;
    } },
      input,
      h('div.row.cm-comment-form-actions', onCancel ? h('button.btn-small', { type: 'button', onclick: onCancel }, 'Cancel') : null, h('span.grow'), submit));
    form.focusInput = () => input.focus();
    return form;
  }

  function paintComposer() {
    if (thread.deleted || thread.removed) return mount(composerHost);
    if (thread.locked && !mod) return mount(composerHost, h('p.notice.cm-locked', 'Locked. Only moderators can comment.'));
    if (!store.me) return mount(composerHost, h('div.row.wrap.cm-login', h('p.grow', 'Log in to comment.'), h('button.btn-small', { type: 'button', onclick: () => login() }, 'Log in')));
    mount(composerHost, commentForm({
      onDone: async body => {
        const { comment } = await api.post(`communities/${enc(c.name)}/threads/${thread.id}/comments`, { body });
        toast('Posted.');
        tree.querySelector(':scope > .empty')?.remove();
        tree.prepend(commentNode(comment));
        bumpCount(1);
      },
    }));
  }

  function commentNode(comment) {
    const el = h('div.cm-comment', { id: `comment-${comment.id}`, class: { [`d${comment.depth}`]: true } });
    const children = h('div.cm-children', comment.children.map(commentNode));
    const replyHost = h('div');
    let collapsed = false;
    const paint = () => {
      const gone = comment.deleted || comment.removed;
      const canReply = !gone && store.me && comment.depth < 5 && !(thread.locked && !mod) && !thread.deleted && !thread.removed;
      const actions = [];
      if (!gone) actions.push(voteColumn('comment', comment, { horizontal: true }));
      if (canReply) actions.push(h('button.btn-small', { type: 'button', onclick: reply }, 'Reply'));
      if (comment.viewer.can_edit) actions.push(h('button.btn-small', { type: 'button', onclick: edit }, 'Edit'));
      if (comment.viewer.can_delete) actions.push(h('button.btn-small', { type: 'button', onclick: refuseDelete }, 'Delete'));
      if (comment.viewer.can_moderate) actions.push(h('button.btn-small', { type: 'button', onclick: hide }, comment.removed ? 'Unhide' : 'Hide'));
      actions.push(h('button.btn-small', { type: 'button', 'aria-expanded': String(!collapsed), onclick: () => { collapsed = !collapsed; paint(); } }, collapsed ? 'Expand' : 'Collapse'));
      const meta = h('p.cm-meta',
        comment.author ? h('a', { href: `/@${comment.author.handle}` }, `u/${comment.author.handle}`) : '[deleted]',
        ' ', when(comment.created_at),
        comment.edited_at && !gone ? h('span', { title: fullDate(comment.edited_at) }, ', edited') : null,
        collapsed ? h('span', `, ${plural(comment.score, 'point')}`) : null);
      // Hidden comments still have their text for their author and the moderators.
      const bodyNode = comment.deleted || (comment.removed && !comment.body)
        ? h('p.muted.cm-comment-body', comment.removed ? '[hidden]' : '[deleted]')
        : [h('div.cm-comment-body', richText(comment.body)),
          comment.removed ? h('p.fine', 'Hidden by the moderators. Only you and the moderators can see this.') : null];
      mount(el, meta, collapsed ? null : [bodyNode, h('div.cm-comment-actions', actions), replyHost, children], collapsed ? h('div.cm-comment-actions', actions.at(-1)) : null);
    };
    async function hide() {
      try {
        const res = await api.patch(`communities/${enc(c.name)}/threads/${thread.id}/comments/${comment.id}`, { removed: !comment.removed });
        bumpCount(res.comment.removed ? -1 : 1);
        Object.assign(comment, res.comment);
        toast(comment.removed ? 'Hidden.' : 'Unhidden.');
        paint();
      } catch (err) { toastError(err); }
    }
    function reply() {
      if (replyHost.firstChild) return replyHost.querySelector('textarea')?.focus();
      const form = commentForm({
        parent: comment, label: 'Reply',
        onCancel: () => mount(replyHost),
        onDone: async body => {
          const res = await api.post(`communities/${enc(c.name)}/threads/${thread.id}/comments`, { body, parent_id: comment.id });
          toast('Posted.');
          mount(replyHost);
          comment.children.unshift(res.comment);
          children.prepend(commentNode(res.comment));
          bumpCount(1);
        },
      });
      mount(replyHost, form);
      form.focusInput();
    }
    function edit() {
      const form = commentForm({
        value: comment.body, label: 'Save',
        onCancel: paint,
        onDone: async body => {
          const res = await api.patch(`communities/${enc(c.name)}/threads/${thread.id}/comments/${comment.id}`, { body });
          Object.assign(comment, { body: res.comment.body, edited_at: res.comment.edited_at });
          toast('Saved.');
          paint();
        },
      });
      const bodyEl = el.querySelector(':scope > .cm-comment-body');
      bodyEl?.replaceWith(form);
      form.focusInput();
    }
    paint();
    return el;
  }

  async function loadComments() {
    try {
      const res = await api.get(`communities/${enc(c.name)}/threads/${thread.id}/comments`, { sort }, { signal: ctx.signal });
      mount(tree, res.items.length ? res.items.map(commentNode) : empty({ title: 'No comments yet.' }));
    } catch (err) {
      if (err.name !== 'AbortError') mount(tree, errorBox(err));
    }
  }

  paintThread();
  paintComposer();
  mount(tree, h('div.loading', 'Loading'));
  loadComments();

  const base = `/c/${c.name}/${thread.id}`;
  return h('div.cm-page',
    communityHeader(ctx, data, { compact: true }),
    h('div.cm-body',
      h('div.cm-main',
        article,
        h('section.south-card.flat.cm-discussion',
          composerHost,
          h('div.cm-comment-sort', h('span.fine', 'Sort by'), tabs([
            { href: base, label: 'Top', current: sort === 'top' },
            { href: `${base}?sort=new`, label: 'New', current: sort === 'new' },
          ])),
          tree)),
      communitySidebar(data)));
}
