// Special pages of a wiki: /wiki/:space/Special:<Name>
//   RecentChanges, AllPages, Random, Search, CreatePage, Members, Settings

import { api } from '../api.js';
import { track } from '../analytics.js';
import { h, mount } from '../dom.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { confirm, empty, infiniteList, shake, toast, toastError } from '../ui.js';
import { avatar } from '../components/user.js';
import { pictureField } from '../views/group-new.js';
import { communitySelect, delta, enc, forgetSpace, loadSpace, pagePath, pageTitle, policySelect, shortWhen, specialPath, userLink, wikiFrame } from './common.js';
import { isValidTitle, normalizeTitle, plainText, slugOf } from './markup.js';

const NAMES = {
  recentchanges: recentChanges,
  allpages: allPages,
  random,
  search,
  createpage: createPage,
  members,
  settings,
};

export function specialView(ctx, spaceSlug, name) {
  const view = NAMES[name.toLowerCase()];
  return wikiFrame(ctx, spaceSlug, async (main, info) => {
    if (!view) return mount(main, pageTitle('Page not found.'), h('p', h('a', { href: `/wiki/${enc(spaceSlug)}` }, 'Main page')));
    await view(ctx, main, info);
  });
}

// ── Recent changes ──────────────────────────────────────────────────────

async function recentChanges(ctx, main, { space }) {
  ctx.title(`Recent changes (${space.title})`);
  const row = r => h('li.wk-change',
    h('span.fine.wk-change-when', shortWhen(r.created_at)),
    h('span.wk-change-main',
      h('a', { href: pagePath(space.slug, r.page.slug) }, r.page.title),
      r.page.deleted ? h('span.fine', ' (deleted)') : null, ' ',
      h('a.fine', { href: pagePath(space.slug, r.page.slug, 'diff', `to=${r.id}`) }, 'Diff'), ' ',
      h('a.fine', { href: pagePath(space.slug, r.page.slug, 'history') }, 'History'), ' ',
      delta(r.delta), ' ',
      userLink(r.author),
      r.summary ? h('span.wk-rev-summary', ` ${r.summary}`) : null));
  mount(main,
    pageTitle('Recent changes', `From ${space.title}`),
    infiniteList({
      load: cursor => api.get(`wiki/${enc(space.slug)}/recent`, { cursor }, { signal: ctx.signal }),
      render: row,
      className: 'wk-changes',
      empty: empty({ title: 'No changes yet.' }),
      signal: ctx.signal,
    }));
}

// ── All pages ───────────────────────────────────────────────────────────

async function allPages(ctx, main, { space, viewer }) {
  ctx.title(`All pages (${space.title})`);
  const deleted = viewer.can_admin && ctx.query.get('deleted') === '1';
  const row = p => h('li',
    h('a', { href: pagePath(space.slug, p.slug, '', p.redirect_to ? 'redirect=no' : '') }, p.title),
    p.redirect_to ? h('span.fine', ' (redirect)') : null,
    p.protected ? h('span.fine', ' (protected)') : null);
  mount(main,
    pageTitle(deleted ? 'Deleted pages' : 'All pages', `From ${space.title}`),
    viewer.can_admin ? h('p.fine', deleted
      ? h('a', { href: specialPath(space.slug, 'AllPages') }, 'Show all pages')
      : h('a', { href: specialPath(space.slug, 'AllPages', 'deleted=1') }, 'Show deleted pages')) : null,
    infiniteList({
      load: cursor => api.get(`wiki/${enc(space.slug)}/pages`, { cursor, deleted: deleted ? '1' : null }, { signal: ctx.signal }),
      render: row,
      className: 'wk-columns',
      empty: empty({ title: deleted ? 'No deleted pages.' : 'No pages yet.' }),
      signal: ctx.signal,
    }));
}

// ── Random page ─────────────────────────────────────────────────────────

async function random(ctx, main, { space }) {
  ctx.title('Random page');
  try {
    const { slug } = await api.get(`wiki/${enc(space.slug)}/random`, null, { signal: ctx.signal });
    navigate(pagePath(space.slug, slug), { replace: true });
  } catch (err) {
    if (err.status !== 404) throw err;
    mount(main, pageTitle('Random page'), empty({ title: 'No pages yet.' }));
  }
}

// ── Search ──────────────────────────────────────────────────────────────

/** Highlight-free plain snippet around the match. */
function snippet(text, q) {
  const plain = plainText(text);
  const at = plain.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, at - 60);
  const cut = plain.slice(start, start + 180);
  return `${start > 0 ? '...' : ''}${cut}${start + 180 < plain.length ? '...' : ''}`;
}

async function search(ctx, main, { space, viewer }) {
  const q = (ctx.query.get('q') || '').trim();
  ctx.title(q ? `Search: ${q}` : 'Search');
  const input = h('input', { type: 'search', name: 'q', value: q, placeholder: 'Search this wiki', 'aria-label': 'Search this wiki' });
  const form = h('form.row.wk-find', { role: 'search', onsubmit: e => {
    e.preventDefault();
    navigate(specialPath(space.slug, 'Search', input.value.trim() ? `q=${enc(input.value.trim())}` : ''));
  } }, input, h('button.btn', { type: 'submit' }, 'Search'));
  const results = h('div');
  mount(main, pageTitle('Search', `From ${space.title}`), form, results);
  if (q.length < 2) return mount(results, q ? h('p.fine', 'Type at least two characters.') : null);
  const { items } = await api.get(`wiki/${enc(space.slug)}/search`, { q }, { signal: ctx.signal });
  const exact = items.find(i => i.title.toLowerCase() === normalizeTitle(q).toLowerCase());
  const title = normalizeTitle(q);
  mount(results,
    !exact && viewer.can_edit && isValidTitle(title)
      ? h('p', 'Create the page ', h('a.wiki-red', { href: pagePath(space.slug, slugOf(title), 'edit') }, title), ' on this wiki.')
      : null,
    items.length
      ? h('ol.wk-results', items.map(r => h('li',
          h('a.wk-result-title', { href: pagePath(space.slug, r.slug) }, r.title),
          h('p.fine', snippet(r.snippet || '', q)))))
      : empty({ title: 'No results.' }));
}

// ── Create page ─────────────────────────────────────────────────────────

async function createPage(ctx, main, { space, viewer }) {
  ctx.title('Create page');
  if (!store.me) return mount(main, pageTitle('Create page'), h('button.btn', { type: 'button', onclick: () => login() }, 'Log in'));
  if (!viewer.can_edit) return mount(main, pageTitle('Create page'), h('p', 'Only members of this wiki can create pages.'));
  const input = h('input.input', { name: 'title', maxLength: 200, required: true, placeholder: 'Page title', value: ctx.query.get('title') || '' });
  const form = h('form.south-card.flat.wk-form', { onsubmit: async e => {
    e.preventDefault();
    const title = normalizeTitle(input.value);
    if (!isValidTitle(title)) { shake(form); return toast('Page titles cannot be empty or contain # < > [ ] { } | / or \\.', { error: true }); }
    navigate(pagePath(space.slug, slugOf(title), 'edit'));
  } },
    h('label.field', h('span', 'Title'), input),
    h('button.btn', { type: 'submit' }, 'Continue'));
  mount(main, pageTitle('Create page', `From ${space.title}`), form);
  input.focus();
}

// ── Members ─────────────────────────────────────────────────────────────

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', editor: 'Editor' };

async function members(ctx, main, { space, viewer }) {
  ctx.title(`Members (${space.title})`);
  const list = h('ul.wk-members.south-card.flat');
  const load = async () => {
    const { items } = await api.get(`wiki/${enc(space.slug)}/members`, null, { signal: ctx.signal });
    mount(list, items.length ? items.map(member) : empty({ title: 'No members.' }));
  };
  const member = m => h('li.user-row',
    avatar(m.user, { size: 'sm' }),
    h('div.grow', userLink(m.user), h('span.fine', ` @${m.user.handle}`), h('p.fine', ROLE_LABEL[m.role] || m.role)),
    viewer.can_admin && m.role !== 'owner' ? h('button.btn-small', { type: 'button', onclick: () => setRole(m.user.handle, m.role === 'admin' ? 'editor' : 'admin') },
      m.role === 'admin' ? 'Make editor' : 'Make admin') : null,
    m.role !== 'owner' && (viewer.can_admin || m.user.id === store.me?.id)
      ? h('button.btn-small', { type: 'button', onclick: () => removeMember(m) }, m.user.id === store.me?.id ? 'Leave' : 'Remove') : null);
  const setRole = async (handle, role) => {
    try {
      await api.put(`wiki/${enc(space.slug)}/members/${enc(handle)}`, { role });
      forgetSpace(space.slug);
      toast('Saved.');
      await load();
    } catch (err) { toastError(err); }
  };
  const removeMember = async m => {
    const self = m.user.id === store.me?.id;
    if (!(await confirm(self ? `Leave ${space.title}?` : `Remove @${m.user.handle} from ${space.title}?`, { title: self ? 'Leave wiki' : 'Remove member', ok: self ? 'Leave' : 'Remove' }))) return;
    try {
      await api.del(`wiki/${enc(space.slug)}/members/${enc(m.user.handle)}`);
      forgetSpace(space.slug);
      toast(self ? 'Left.' : 'Removed.');
      await load();
    } catch (err) { toastError(err); }
  };
  let addForm = null;
  if (viewer.can_admin) {
    const handle = h('input.input', { name: 'handle', placeholder: 'handle', autocomplete: 'off', required: true });
    const role = h('select.select', { name: 'role' }, h('option', { value: 'editor' }, 'Editor'), h('option', { value: 'admin' }, 'Admin'));
    addForm = h('form.south-card.flat.wk-add-member', { onsubmit: async e => {
      e.preventDefault();
      const value = handle.value.trim().replace(/^@/, '');
      if (!value) return shake(addForm);
      await setRole(value, role.value);
      handle.value = '';
    } },
      h('h3', 'Add a member'),
      h('div.row.wrap', h('label.field.grow', h('span', 'Handle'), handle), h('label.field', h('span', 'Role'), role)),
      h('button.btn', { type: 'submit' }, 'Add'));
  }
  mount(main,
    pageTitle('Members', `From ${space.title}`),
    h('p.fine', space.edit_policy === 'members'
      ? 'Only members can edit this wiki.'
      : 'Anyone signed in can edit this wiki. Admins can protect, move, delete and restore pages.'),
    space.community ? h('p.fine', `Members of c/${space.community.name} can edit too, and its moderators are admins.`) : null,
    addForm,
    list);
  await load();
}

// ── Settings ────────────────────────────────────────────────────────────

async function settings(ctx, main, { space, viewer }) {
  ctx.title(`Settings (${space.title})`);
  if (!viewer.can_admin) return mount(main, pageTitle('Settings'), h('p', 'Only wiki admins can change the wiki.'));
  const title = h('input.input', { name: 'title', maxLength: 80, value: space.title, required: true });
  const description = h('textarea.textarea', { rows: 3, maxLength: 500, value: space.description });
  const logo = pictureField({ label: 'Logo', kind: 'avatar', current: space.logo_url });
  const policy = policySelect(space.edit_policy);
  const community = communitySelect(ctx, space.community);
  const save = h('button.btn', { type: 'submit' }, 'Save');
  const form = h('form.south-card.flat.wk-form', { onsubmit: async e => {
    e.preventDefault();
    if (logo.busy) return toast('Wait for the upload to finish.');
    save.disabled = true;
    const patch = { title: title.value.trim(), description: description.value.trim(), edit_policy: policy.value, community: community.value || null };
    if (logo.value !== undefined) patch.logo_media_id = logo.value;
    try {
      await api.patch(`wiki/${enc(space.slug)}`, patch);
      forgetSpace(space.slug);
      await loadSpace(space.slug, undefined, true);
      toast('Saved.');
      navigate(specialPath(space.slug, 'Settings'), { replace: true, scroll: false });
    } catch (err) { shake(form); toastError(err); save.disabled = false; }
  } },
    h('label.field', h('span', 'Name'), title),
    h('label.field', h('span', 'Description'), description),
    logo,
    h('label.field', h('span', 'Who can edit'), policy),
    h('label.field', h('span', 'Community'), community),
    save);
  const danger = viewer.role === 'owner' ? h('div.south-card.flat',
    h('h3', 'Delete wiki'),
    h('p.fine', 'Deletes every page, revision and comment. This cannot be undone.'),
    h('button.btn', { type: 'button', onclick: async () => {
      if (!(await confirm(`Delete ${space.title} and all of its pages?`, { title: 'Delete wiki', ok: 'Delete' }))) return;
      try {
        await api.del(`wiki/${enc(space.slug)}`);
        forgetSpace(space.slug);
        track('social_wiki_deleted', { wiki: space.slug });
        toast('Deleted.');
        navigate('/wiki');
      } catch (err) { toastError(err); }
    } }, 'Delete wiki')) : null;
  mount(main, pageTitle('Settings', `From ${space.title}`), form, danger);
}
