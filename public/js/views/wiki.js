// Wikis (Fandom / Wikipedia style). One module for every wiki route:
//   /wiki                                  Popular wikis, Your wikis, Create a wiki (?tab=)
//   /wiki/:space                           the wiki's Main Page
//   /wiki/:space/:page                     an article (Read)
//   /wiki/:space/:page/edit|history|talk|diff|revision|links
//   /wiki/:space/Special:RecentChanges|AllPages|Random|Search|CreatePage|Members|Settings
// API: /api/wiki (see src/routes/wiki.ts). Markup: public/js/wiki/markup.js.

import { api } from '../api.js';
import { track } from '../analytics.js';
import { h, mount } from '../dom.js';
import { plural } from '../format.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { dialog, empty, infiniteList, loading, menu, refuseDelete, tabs, toast, toastError } from '../ui.js';
import { pictureField } from './group-new.js';
import {
  MAIN, ago, canEdit, communitySelect, enc, forgetSpace, logoBox, pageApi, pagePath, pageTabs, pageTitle, policySelect, spacePath, userLink,
  wikiFrame,
} from '../wiki/common.js';
import { render, titleOf } from '../wiki/markup.js';
import { editorView } from '../wiki/editor.js';
import { diffView, historyView, revisionView } from '../wiki/history.js';
import { talkView } from '../wiki/talk.js';
import { specialView } from '../wiki/special.js';

export default async function wikiView(ctx) {
  ctx.layout('wide');
  const { space, page, action } = ctx.params;
  if (!space) return homeView(ctx);
  if (!page) return articleView(ctx, space, MAIN);
  const special = page.match(/^special:(.*)$/i);
  if (special) return specialView(ctx, space, special[1]);
  switch (action) {
    case undefined: return articleView(ctx, space, page);
    case 'edit': return editorView(ctx, space, page);
    case 'history': return historyView(ctx, space, page);
    case 'diff': return diffView(ctx, space, page);
    case 'revision': return revisionView(ctx, space, page);
    case 'talk': return talkView(ctx, space, page);
    case 'links': return linksView(ctx, space, page);
    default: navigate(pagePath(space, page), { replace: true }); return null;
  }
}

// ── /wiki ───────────────────────────────────────────────────────────────

const HOME_TABS = [['popular', 'Popular wikis'], ['mine', 'Your wikis'], ['create', 'Create a wiki']];

function homeView(ctx) {
  ctx.title('Wiki');
  const tab = HOME_TABS.some(([k]) => k === ctx.query.get('tab')) ? ctx.query.get('tab') : 'popular';
  const body = tab === 'create' ? createWiki(ctx) : tab === 'mine' ? yourWikis(ctx) : popularWikis(ctx);
  return h('div.wk-home',
    h('header.page-head', h('h1', 'Wiki')),
    tabs(HOME_TABS.map(([key, label]) => ({ href: key === 'popular' ? '/wiki' : `/wiki?tab=${key}`, label, current: key === tab }))),
    body);
}

function spaceCard(space) {
  return h('article.south-card.wk-card',
    h('a.wk-card-logo', { href: spacePath(space.slug), 'aria-hidden': 'true', tabIndex: -1 }, logoBox(space, 'lg')),
    h('div.wk-card-main',
      h('h3', h('a', { href: spacePath(space.slug) }, space.title)),
      space.description ? h('p.wk-card-desc', space.description) : null,
      h('p.fine', `${plural(space.page_count, 'page')}, ${plural(space.edit_count, 'edit')}`,
        space.community ? [', part of ', h('a', { href: `/c/${space.community.name}` }, `c/${space.community.name}`)] : null,
        space.role ? `. You are ${space.role === 'owner' ? 'the owner' : space.role === 'admin' ? 'an admin' : 'an editor'}.` : null)));
}

function popularWikis(ctx) {
  const q = h('input', { type: 'search', name: 'q', placeholder: 'Find a wiki', 'aria-label': 'Find a wiki', value: ctx.query.get('q') || '' });
  const list = infiniteList({
    load: cursor => api.get('wiki', { tab: 'popular', q: ctx.query.get('q'), cursor }, { signal: ctx.signal }),
    render: spaceCard,
    className: 'wk-grid',
    empty: empty({ title: ctx.query.get('q') ? 'No results.' : 'No wikis yet.' }),
    signal: ctx.signal,
  });
  return h('section',
    h('form.row.wk-find', { role: 'search', onsubmit: e => {
      e.preventDefault();
      navigate(q.value.trim() ? `/wiki?q=${enc(q.value.trim())}` : '/wiki');
    } }, q, h('button.btn', { type: 'submit' }, 'Search')),
    list);
}

function yourWikis(ctx) {
  if (!ctx.me) return h('div.south-card.flat', h('p', 'Log in to see your wikis.'), h('button.btn', { type: 'button', onclick: () => login() }, 'Log in'));
  return infiniteList({
    load: cursor => api.get('wiki', { tab: 'mine', cursor }, { signal: ctx.signal }),
    render: spaceCard,
    className: 'wk-grid',
    empty: empty({ title: 'No wikis yet.', action: h('a.btn', { href: '/wiki?tab=create' }, 'Create a wiki') }),
    signal: ctx.signal,
  });
}

function createWiki(ctx) {
  if (!ctx.me) return h('div.south-card.flat', h('p', 'Log in to create a wiki.'), h('button.btn', { type: 'button', onclick: () => login() }, 'Log in'));
  const title = h('input.input', { name: 'title', maxLength: 80, required: true, placeholder: 'Wiki name' });
  const slug = h('input.input', { name: 'slug', maxLength: 40, required: true, placeholder: 'address', autocomplete: 'off' });
  const address = h('p.fine', '/wiki/address');
  let slugTouched = false;
  const suggest = () => title.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  title.addEventListener('input', () => { if (!slugTouched) { slug.value = suggest(); address.textContent = `/wiki/${slug.value || 'address'}`; } });
  slug.addEventListener('input', () => { slugTouched = true; address.textContent = `/wiki/${slug.value.trim() || 'address'}`; });
  const description = h('textarea.textarea', { rows: 3, maxLength: 500, placeholder: 'What is this wiki about?' });
  const logo = pictureField({ label: 'Logo', kind: 'avatar' });
  const policy = policySelect();
  const community = communitySelect(ctx);
  const submit = h('button.btn-large', { type: 'submit' }, 'Create wiki');
  const form = h('form.south-card.flat.wk-form', { onsubmit: async e => {
    e.preventDefault();
    if (logo.busy) return toast('Wait for the upload to finish.');
    submit.disabled = true;
    try {
      const { space } = await api.post('wiki', {
        slug: slug.value.trim(), title: title.value.trim(), description: description.value.trim(),
        logo_media_id: logo.value || null, edit_policy: policy.value, community: community.value || null,
      });
      track('social_wiki_created', { wiki: space.slug });
      toast('Wiki created.');
      navigate(spacePath(space.slug));
    } catch (err) { toastError(err); submit.disabled = false; }
  } },
    h('h2', 'Create a wiki'),
    h('label.field', h('span', 'Name'), title),
    h('label.field', h('span', 'Address'), slug, h('small.fine', '3 to 40 letters, numbers or hyphens.'), address),
    h('label.field', h('span', 'Description'), description),
    logo,
    h('label.field', h('span', 'Who can edit'), policy),
    h('label.field', h('span', 'Community'), community, h('small.fine', 'Optional. Members of the community can edit a members-only wiki.')),
    submit);
  return form;
}

// ── Article ─────────────────────────────────────────────────────────────

function articleView(ctx, spaceSlug, slug) {
  return wikiFrame(ctx, spaceSlug, async (main, { space, viewer }) => {
    let data;
    try {
      data = await api.get(pageApi(spaceSlug, slug), { redirect: ctx.query.get('redirect') }, { signal: ctx.signal });
    } catch (err) {
      if (err.status !== 404) throw err;
      ctx.title(`${titleOf(slug)} (${space.title})`);
      return mount(main, missingPage(space, viewer, slug));
    }
    const { page } = data;
    ctx.title(`${page.title} (${space.title})`);
    track('social_wiki_page_viewed', { wiki: space.slug, page: page.slug });
    if (data.redirected_from) {
      history.replaceState(history.state, '', (page.slug === MAIN ? spacePath(space.slug) : pagePath(space.slug, page.slug)) + location.hash);
    }
    const isMain = page.slug.toLowerCase() === MAIN.toLowerCase();
    const editable = canEdit(data.viewer, page);
    const actions = h('div.wk-actions',
      data.viewer.signed_in ? watchButton(space, page, data.viewer.watching) : null,
      moreButton(ctx, space, page, data.viewer, isMain));
    mount(main,
      pageTitle(isMain ? space.title : page.title, isMain ? (space.description || null) : `From ${space.title}`),
      h('div.wk-tabbar', pageTabs(space.slug, page.slug, 'read', { canEdit: editable }), actions),
      page.deleted ? h('div.notice', 'This page has been deleted. Only wiki admins can see it. ',
        h('button.btn-small', { type: 'button', onclick: () => restore(space, page) }, 'Restore')) : null,
      data.redirected_from ? h('p.fine.wk-redirected', 'Redirected from ',
        h('a', { href: pagePath(space.slug, data.redirected_from.slug, '', 'redirect=no') }, data.redirected_from.title)) : null,
      page.protected ? h('p.fine.wk-protected', 'This page is protected. Only wiki admins can edit it.') : null,
      h('article.wk-article.south-card.flat', render(data.content, { space: space.slug, missing: data.missing, files: data.files })),
      h('p.fine.wk-foot',
        'Last edited by ', userLink(data.revision.author), `, ${ago(data.revision.created_at)}. `,
        `Viewed ${plural(page.view_count + 1, 'time')}. `,
        h('a', { href: pagePath(space.slug, page.slug, 'links') }, 'What links here')));
  });
}

function missingPage(space, viewer, slug) {
  const title = titleOf(slug);
  const allowed = canEdit(viewer, null);
  return [
    pageTitle(title, `From ${space.title}`),
    h('div.wk-tabbar', pageTabs(space.slug, slug, 'read', { exists: false })),
    h('div.south-card.flat.wk-missing',
      h('p', 'This page does not exist.'),
      allowed ? h('a.btn', { href: pagePath(space.slug, slug, 'edit') }, 'Create page')
        : store.me ? h('p.fine', 'Only members of this wiki can create pages.')
        : h('button.btn', { type: 'button', onclick: () => login() }, 'Log in to create it'),
      h('p.fine', h('a', { href: pagePath(space.slug, slug, 'links') }, 'What links here'))),
  ];
}

function watchButton(space, page, watching) {
  const btn = h('button.btn-small', { type: 'button' });
  const paint = () => { btn.textContent = watching ? 'Unwatch' : 'Watch'; btn.setAttribute('aria-pressed', String(watching)); };
  paint();
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = watching ? await api.del(pageApi(space.slug, page.slug, '/watch')) : await api.put(pageApi(space.slug, page.slug, '/watch'));
      watching = res.watching;
      paint();
      toast(watching ? 'Watching this page.' : 'Stopped watching.');
    } catch (err) { toastError(err); }
    btn.disabled = false;
  });
  return btn;
}

function moreButton(ctx, space, page, viewer, isMain) {
  const btn = h('button.btn-small', { type: 'button', 'aria-haspopup': 'menu' }, 'More');
  const editable = canEdit(viewer, page);
  btn.addEventListener('click', () => menu(btn, [
    { label: 'What links here', href: pagePath(space.slug, page.slug, 'links') },
    { label: 'History', href: pagePath(space.slug, page.slug, 'history') },
    editable && !isMain ? { label: 'Move', onClick: () => movePage(space, page) } : null,
    viewer.can_admin ? { label: page.protected ? 'Unprotect' : 'Protect', onClick: () => protect(space, page) } : null,
    viewer.can_admin && !isMain && !page.deleted ? { label: 'Delete', onClick: refuseDelete } : null,
  ]));
  return btn;
}

async function movePage(space, page) {
  const input = h('input.input', { value: page.title, maxLength: 200 });
  const keep = h('input', { type: 'checkbox', checked: true });
  const ok = await dialog({
    title: 'Move page',
    body: h('div',
      h('label.field', h('span', 'New title'), input),
      h('label.checkbox', keep, h('span', 'Leave a redirect behind'))),
    actions: [{ label: 'Cancel', value: false }, { label: 'Move', value: true, primary: true }],
    onOpen: () => { input.focus(); input.select(); },
  });
  if (!ok) return;
  try {
    const res = await api.post(pageApi(space.slug, page.slug, '/move'), { title: input.value, redirect: keep.checked });
    toast('Moved.');
    navigate(pagePath(space.slug, res.page.slug));
  } catch (err) { toastError(err); }
}

async function protect(space, page) {
  try {
    await api.put(pageApi(space.slug, page.slug, '/protect'), { protected: !page.protected });
    toast(page.protected ? 'Unprotected.' : 'Protected.');
    navigate(pagePath(space.slug, page.slug), { replace: true, scroll: false });
  } catch (err) { toastError(err); }
}

async function restore(space, page) {
  try {
    await api.post(pageApi(space.slug, page.slug, '/undelete'));
    forgetSpace(space.slug);
    toast('Restored.');
    navigate(pagePath(space.slug, page.slug), { replace: true, scroll: false });
  } catch (err) { toastError(err); }
}

// ── What links here ─────────────────────────────────────────────────────

function linksView(ctx, spaceSlug, slug) {
  return wikiFrame(ctx, spaceSlug, async (main, { space }) => {
    const title = titleOf(slug);
    ctx.title(`What links here (${title})`);
    mount(main, pageTitle('What links here', h('span', 'Pages that link to ', h('a', { href: pagePath(space.slug, slug) }, title))), loading());
    const { items } = await api.get(pageApi(space.slug, slug, '/links'), null, { signal: ctx.signal });
    main.lastChild.replaceWith(items.length
      ? h('ul.wk-list.south-card.flat', items.map(p => h('li',
          h('a', { href: pagePath(space.slug, p.slug, '', p.redirect_to ? 'redirect=no' : '') }, p.title),
          p.redirect_to ? h('span.fine', ' (redirect)') : null)))
      : empty({ title: 'No pages link here.' }));
  });
}

