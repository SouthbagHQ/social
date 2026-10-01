// Shared pieces of the wiki views: paths, the wiki frame (sidebar and article tabs), small formatters.

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { fullDate, relative, timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { store } from '../store.js';
import { errorBox, loading, tabs } from '../ui.js';
import { encodeSlug, slugOf, titleOf } from './markup.js';

export const MAIN = 'Main_Page';
export const enc = encodeURIComponent;

/** Paths. `slug` may be a title. */
export const spacePath = space => `/wiki/${enc(space)}`;
export const pagePath = (space, slug, action = '', query = '') =>
  `/wiki/${enc(space)}/${encodeSlug(slugOf(slug))}${action ? `/${action}` : ''}${query ? `?${query}` : ''}`;
export const specialPath = (space, name, query = '') => `/wiki/${enc(space)}/Special:${name}${query ? `?${query}` : ''}`;
/** API path for a page. */
export const pageApi = (space, slug, rest = '') => `wiki/${enc(space)}/pages/${enc(slugOf(slug))}${rest}`;

export { slugOf, titleOf };

/** "2 hours ago", "just now". */
export const ago = ms => relative(ms);
export const when = ms => h('time', { datetime: new Date(ms).toISOString(), title: fullDate(ms) }, ago(ms));
export const dateLink = (ms, href) => h('a', { href, title: fullDate(ms) }, fullDate(ms));
export const shortWhen = ms => { const t = timeAgo(ms); return t === 'now' ? 'just now' : /^\d+[mhd]$/.test(t) ? `${t} ago` : t; };

export const userLink = user => user ? h('a', { href: `/@${user.handle}` }, user.name) : h('span.muted', 'Deleted account');

/** "+12", "-4", "0" in the history and change lists. */
export const delta = n => h('span.wk-delta', { class: { big: Math.abs(n) >= 500 } }, n > 0 ? `+${n}` : String(n));

/** Can the viewer change this page? (Server checks again.) */
export const canEdit = (viewer, page) => Boolean(viewer?.can_edit && (!page || ((!page.protected || viewer.can_admin) && !page.deleted)));

/** The wiki's logo stretched into a fixed box, or its initial. */
export function logoBox(space, size = '') {
  return h('span.wk-logo', { class: { [size]: Boolean(size) } },
    space.logo_url ? h('img', { src: space.logo_url, alt: '' }) : h('span.initial', (space.title || space.slug).charAt(0).toLowerCase()));
}

const spaceCache = new Map();

/** GET /api/wiki/:space, remembered briefly so tab switches don't refetch. */
export async function loadSpace(slug, signal, fresh = false) {
  const hit = spaceCache.get(slug.toLowerCase());
  if (!fresh && hit && Date.now() - hit.at < 30000 && hit.me === (store.me?.id ?? null)) return hit.data;
  const data = await api.get(`wiki/${enc(slug)}`, null, { signal });
  spaceCache.set(slug.toLowerCase(), { data, at: Date.now(), me: store.me?.id ?? null });
  return data;
}
export const forgetSpace = slug => spaceCache.delete(String(slug).toLowerCase());

/**
 * The frame around every page of a wiki: sidebar of links and a main column.
 * `fill(main, info)` renders into the main column once the wiki has loaded; info = { space, viewer }.
 */
export function wikiFrame(ctx, spaceSlug, fill) {
  const side = h('aside.wk-side.south-card.flat');
  const main = h('div.wk-main', loading());
  const root = h('div.wk-page', h('div.wk-body', side, main));
  (async () => {
    let info;
    try {
      info = await loadSpace(spaceSlug, ctx.signal);
    } catch (err) {
      if (err.name === 'AbortError') return;
      side.remove();
      mount(main, err.status === 404
        ? h('div.south-card.flat', h('h2', 'Wiki not found.'), h('p', h('a', { href: '/wiki' }, 'All wikis')))
        : errorBox(err));
      return;
    }
    const { space } = info;
    mount(side, sidebar(space, info.viewer, ctx));
    try {
      await fill(main, info);
    } catch (err) {
      if (err.name === 'AbortError') return;
      mount(main, errorBox(err));
    }
    if (location.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView());
  })();
  return root;
}

function sidebar(space, viewer, ctx) {
  const current = ctx.path;
  const link = (href, label) => h('li', h('a', { href, 'aria-current': current === href.split('?')[0] ? 'page' : null }, label));
  const q = h('input', { type: 'search', name: 'q', placeholder: 'Search this wiki', 'aria-label': 'Search this wiki' });
  return [
    h('a.wk-side-brand', { href: spacePath(space.slug) }, logoBox(space, 'lg'), h('span.wk-side-title', space.title)),
    space.community ? h('p.fine.wk-side-community', 'Part of ', h('a', { href: `/c/${space.community.name}` }, `c/${space.community.name}`)) : null,
    h('form.wk-side-search', { role: 'search', onsubmit: e => {
      e.preventDefault();
      if (q.value.trim()) navigate(specialPath(space.slug, 'Search', `q=${enc(q.value.trim())}`));
    } }, q, h('button.btn-small', { type: 'submit' }, 'Search')),
    h('ul.wk-side-links',
      link(spacePath(space.slug), 'Main page'),
      link(specialPath(space.slug, 'RecentChanges'), 'Recent changes'),
      link(specialPath(space.slug, 'Random'), 'Random page'),
      link(specialPath(space.slug, 'AllPages'), 'All pages'),
      viewer.can_edit ? link(specialPath(space.slug, 'CreatePage'), 'Create page') : null,
      link(specialPath(space.slug, 'Members'), 'Members'),
      viewer.can_admin ? link(specialPath(space.slug, 'Settings'), 'Settings') : null),
    h('p.fine.wk-side-stats', `${space.page_count} ${space.page_count === 1 ? 'page' : 'pages'}, ${space.edit_count} ${space.edit_count === 1 ? 'edit' : 'edits'}`),
    !store.me ? h('p.fine', 'Log in to edit.') : !viewer.can_edit ? h('p.fine', 'Only members can edit this wiki.') : null,
  ];
}

/** "Read / Edit / History / Talk" for a page. */
export function pageTabs(space, slug, active, { canEdit: editable = true, exists = true } = {}) {
  const t = (key, label, href) => ({ href, label, current: active === key });
  return tabs([
    t('read', 'Read', slugOf(slug) === MAIN ? spacePath(space) : pagePath(space, slug)),
    t('edit', exists ? (editable ? 'Edit' : 'View source') : 'Create', pagePath(space, slug, 'edit')),
    exists ? t('history', 'History', pagePath(space, slug, 'history')) : null,
    exists ? t('talk', 'Talk', pagePath(space, slug, 'talk')) : null,
  ].filter(Boolean));
}

/** Heading block for a page: small wiki name and the page title. */
export const pageTitle = (title, sub = null) => h('header.wk-head', h('h1.wk-title', title), sub ? h('p.wk-sub', sub) : null);

// ── Form pieces (create a wiki, settings) ──

export function policySelect(value = 'anyone') {
  return h('select.select', { name: 'edit_policy' },
    h('option', { value: 'anyone', selected: value === 'anyone' }, 'Anyone signed in'),
    h('option', { value: 'members', selected: value === 'members' }, 'Members only'));
}

/** Communities the viewer moderates, as a select (wikis can belong to one). */
export function communitySelect(ctx, current = null) {
  const select = h('select.select', { name: 'community' }, h('option', { value: '' }, 'None'));
  if (current) select.append(h('option', { value: current.name, selected: true }, `c/${current.name}`));
  api.get('communities', { tab: 'mine', limit: 50 }, { signal: ctx.signal }).then(res => {
    for (const c of res.items || []) {
      if ((c.role === 'owner' || c.role === 'moderator') && c.name !== current?.name) select.append(h('option', { value: c.name }, `c/${c.name}`));
    }
  }).catch(() => {});
  return select;
}
