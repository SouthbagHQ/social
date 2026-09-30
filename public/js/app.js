// Southbag Social — boot, shell and route table.
//
// Shell (top to bottom): promotional strip, header (stretched logo, search, account), then the
// layout: sidebar of links, the page, and a column of extras. Same furniture as Identity and Office.

import { h, mount } from './dom.js';
import { applyTheme, promoStrip } from './gags.js';
import { navigate, route, startRouter } from './router.js';
import { login, store } from './store.js';
import { errorBox, loading, menu } from './ui.js';
import { sidebar, footer } from './components/sidebar.js';

// ── Routes ──────────────────────────────────────────────────────────────
// Feed & discovery (Twitter / Facebook)
route('/', () => import('./views/home.js'));
route('/explore', () => import('./views/explore.js'));
route('/search', () => import('./views/search.js'));
route('/tag/:tag', () => import('./views/tag.js'));
route('/post/:id', () => import('./views/post.js'));
route('/bookmarks', () => import('./views/bookmarks.js'));
// People (profiles, friends, notifications, settings)
route('/@:handle', () => import('./views/profile.js'));
route('/@:handle/:tab', () => import('./views/profile.js'));
route('/notifications', () => import('./views/notifications.js'));
route('/friends', () => import('./views/friends.js'));
route('/settings', () => import('./views/settings.js'));
route('/welcome', () => import('./views/welcome.js'));
route('/verified', () => import('./views/verified.js'));
// Video & photos (YouTube / TikTok / Instagram)
route('/videos', () => import('./views/videos.js'));
route('/watch/:id', () => import('./views/watch.js'));
route('/shorts', () => import('./views/shorts.js'));
route('/shorts/:id', () => import('./views/shorts.js'));
route('/photos', () => import('./views/photos.js'));
route('/upload', () => import('./views/upload.js'));
// Stories & groups (Instagram / Facebook)
route('/stories/:handle', () => import('./views/stories.js'));
route('/groups', () => import('./views/groups.js'));
route('/groups/new', () => import('./views/group-new.js'));
route('/g/:slug', () => import('./views/group.js'));
route('/g/:slug/:tab', () => import('./views/group.js'));
// Messages
route('/messages', () => import('./views/messages.js'));
route('/messages/:id', () => import('./views/messages.js'));
// Legal
route('/terms', () => import('./views/terms.js'));
route('/404', () => import('./views/not-found.js'));

// ── Shell ───────────────────────────────────────────────────────────────
// Office's header (stretched logo, search, account) over Identity's dashboard: a sidebar of
// plain underlined links, the page, and a column of extras.
const sections = [
  { href: '/', label: 'Feed' },
  { href: '/explore', label: 'Explore' },
  { href: '/photos', label: 'Photos' },
  { href: '/videos', label: 'Videos' },
  { href: '/shorts', label: 'Shorts' },
  { href: '/groups', label: 'Groups' },
  { href: '/messages', label: 'Messages', badge: 'messages', auth: true },
  { href: '/notifications', label: 'Notifications', badge: 'notifications', auth: true },
  { href: '/friends', label: 'Friends', badge: 'friend_requests', auth: true },
  { href: '/bookmarks', label: 'Bookmarks', auth: true },
  { href: '/settings', label: 'Settings', auth: true },
];

const app = document.getElementById('app');
const shell = {
  promo: h('div'),
  header: h('header.site-header'),
  nav: h('nav.south-nav', { 'aria-label': 'Southbag Social' }),
  main: h('main', { id: 'main', tabIndex: -1 }),
  aside: h('aside'),
  footer: h('div'),
};
shell.layout = h('div.layout', shell.nav, shell.main, shell.aside);

const isCurrent = (href, path) => href === '/' ? path === '/' : path === href || path.startsWith(href + '/') || (href === '/groups' && path.startsWith('/g/'));

function renderHeader() {
  const me = store.me;
  const search = h('input', {
    type: 'search', name: 'q', placeholder: 'Search', 'aria-label': 'Search',
    value: location.pathname === '/search' ? new URLSearchParams(location.search).get('q') || '' : '',
  });
  const accountBtn = me ? h('button', { type: 'button' }, me.name) : null;
  accountBtn?.addEventListener('click', () => menu(accountBtn, [
    { label: 'Profile', href: `/@${me.handle}` },
    { label: 'Settings', href: '/settings' },
    { label: 'Southbag Identity', onClick: () => window.open('https://identity.southbag.cc/home', '_blank', 'noopener') },
    { label: 'Sign out', onClick: () => { location.href = '/auth/logout'; } },
  ]));
  mount(shell.header,
    h('a.brand', { href: '/', 'aria-label': 'Southbag Social' },
      h('img', { src: '/img/logo-400.png', alt: 'southbag' }),
      h('h2', 'Social')),
    h('form.search', { role: 'search', onsubmit: e => { e.preventDefault(); if (search.value.trim()) navigate(`/search?q=${encodeURIComponent(search.value.trim())}`); } },
      search),
    h('div.account',
      me ? h('a.btn', { href: '/upload' }, 'Upload') : null,
      me ? accountBtn : h('button', { type: 'button', onclick: () => login() }, 'Log in')));
}

function renderNav(path) {
  const me = store.me;
  const items = [...sections.filter(s => !s.auth || me), me && { href: `/@${me.handle}`, label: 'Profile' }].filter(Boolean);
  const badge = key => key && store.unread[key] ? h('span.badge', store.unread[key] > 99 ? '99+' : String(store.unread[key])) : null;
  mount(shell.nav,
    h('p.nav-title', 'Southbag Social'),
    me ? h('p.nav-hello.tiny', `Hello, "${me.email || me.handle}" !`) : null,
    h('ul', items.map(s => h('li', h('a', { href: s.href, 'aria-current': isCurrent(s.href, path) ? 'page' : null }, s.label, badge(s.badge))))),
    h('div.nav-footer',
      me ? h('button', { type: 'button', onclick: () => { location.href = '/auth/logout'; } }, 'Sign out')
        : h('button', { type: 'button', onclick: () => login() }, 'Log in'),
      h('p.tiny', 'Kevin is watching')));
}

store.on(() => { renderHeader(); renderNav(location.pathname); });

// ── Rendering a route ───────────────────────────────────────────────────
async function render(ctx, matched, controller, scroll) {
  const path = ctx.path;
  ctx.me = store.me;
  renderHeader();
  renderNav(path);
  let layout = 'default';
  ctx.layout = kind => { layout = kind; shell.layout.className = `layout ${kind === 'default' ? '' : kind}`.trim(); };
  ctx.layout('default');
  ctx.title = text => { document.title = text ? `${text} - Southbag Social` : 'Southbag Social'; };
  ctx.title('');
  ctx.requireAuth = () => {
    if (store.me) return true;
    mount(shell.main, h('div.south-card',
      h('h2', 'Log in'),
      h('p', 'You need a Southbag account to see this page.'),
      h('button.btn-large', { type: 'button', onclick: () => login() }, 'Log in with Southbag Identity')));
    return false;
  };
  mount(shell.main, loading());
  if (scroll) window.scrollTo(0, 0);

  // Signed-out visitors get the landing page at /.
  const load = path === '/' && !store.me ? () => import('./views/landing.js') : matched?.load;
  try {
    const mod = await load();
    if (controller.signal.aborted) return;
    const node = await mod.default(ctx);
    if (controller.signal.aborted) return;
    if (node) mount(shell.main, node);
  } catch (err) {
    if (controller.signal.aborted || err.name === 'AbortError') return;
    console.error(err);
    mount(shell.main, h('div.south-card', h('h2', 'Something went wrong'), errorBox(err)));
  }
  if (layout === 'default') mount(shell.aside, sidebar(ctx));
  else mount(shell.aside);
  mount(shell.footer, layout === 'wide' ? footer() : null);
}

// ── Boot ────────────────────────────────────────────────────────────────
async function boot() {
  applyTheme();
  mount(app, loading());
  await store.refresh();
  mount(shell.promo, promoStrip());
  mount(app, shell.promo, shell.header, shell.layout, shell.footer);
  const params = new URLSearchParams(location.search);
  if (params.get('login_error') || params.get('signed_out')) {
    const { toast } = await import('./ui.js');
    if (params.get('login_error')) toast(`Login failed (${params.get('login_error')}).`, { error: true, timeout: 8000 });
    else toast('Signed out.');
    history.replaceState({}, '', location.pathname);
  }
  startRouter(render);
  if (store.me) {
    // Poll unread counts once a minute (cheap: one query).
    setInterval(() => { if (document.visibilityState === 'visible') store.refresh(); }, 60000);
  }
  window.addEventListener('auth:required', () => { if (store.me) store.refresh(); });
}

boot();
