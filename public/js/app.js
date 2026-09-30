// Southbag Social — boot, shell and route table.
//
// Shell (top to bottom), following Southbag Online Banking's signed-in pages:
//   yellow promotional strip → header (logo + "Social", search, account) → [home only: "Welcome, name"
//   + status line] → groove tab-strip nav → layout (main + announcements sidebar) → mobile bottom bar.

import { h, icon, mount } from './dom.js';
import { applyTheme, privacyPanel, promoCarousel, promoStrip, scheduleInterruptions } from './gags.js';
import { navigate, route, startRouter } from './router.js';
import { login, store } from './store.js';
import { errorBox, loading, menu } from './ui.js';
import { avatar } from './components/user.js';
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
const sections = [
  { href: '/', label: 'Feed', icon: 'home' },
  { href: '/explore', label: 'Explore', icon: 'compass' },
  { href: '/photos', label: 'Photos', icon: 'image' },
  { href: '/videos', label: 'Videos', icon: 'video' },
  { href: '/shorts', label: 'Shorts', icon: 'shorts' },
  { href: '/groups', label: 'Groups', icon: 'users' },
  { href: '/messages', label: 'Messages', icon: 'message', badge: 'messages', auth: true },
  { href: '/notifications', label: 'Notifications', icon: 'bell', badge: 'notifications', auth: true },
];

const app = document.getElementById('app');
const shell = {
  promo: h('div'),
  header: h('header.site-header'),
  welcome: h('div.welcome'),
  nav: h('nav.south-nav', { 'aria-label': 'Southbag Social sections' }),
  main: h('main', { id: 'main', tabIndex: -1 }),
  aside: h('aside'),
  footer: h('div'),
  bottom: h('nav.bottom-bar', { 'aria-label': 'Quick navigation' }),
};
shell.layout = h('div.layout', shell.main, shell.aside);

const isCurrent = (href, path) => href === '/' ? path === '/' : path === href || path.startsWith(href + '/');

function renderHeader() {
  const me = store.me;
  const search = h('input.input', {
    type: 'search', name: 'q', placeholder: 'Search Southbag Social', 'aria-label': 'Search',
    value: location.pathname === '/search' ? new URLSearchParams(location.search).get('q') || '' : '',
  });
  const accountBtn = me ? h('button.icon-btn', { type: 'button', 'aria-label': 'Account menu', style: 'padding:0' }, avatar(me, { size: 'sm', link: false })) : null;
  accountBtn?.addEventListener('click', () => menu(accountBtn, [
    { label: `@${me.handle}`, icon: 'user', href: `/@${me.handle}` },
    { label: 'Friends', icon: 'users', href: '/friends' },
    { label: 'Bookmarks', icon: 'bookmark', href: '/bookmarks' },
    { label: 'Get verified ($8.00/week)', icon: 'verified', href: '/verified' },
    { label: 'Settings', icon: 'settings', href: '/settings' },
    'divider',
    { label: 'Southbag Identity™', icon: 'lock', onClick: () => window.open('https://identity.southbag.cc/home', '_blank', 'noopener') },
    { label: 'Log out', icon: 'log-out', onClick: () => { location.href = '/auth/logout'; } },
  ]));
  mount(shell.header,
    h('a.brand', { href: '/', 'aria-label': 'Southbag Social home' },
      h('img', { src: '/img/logo-112.png', alt: 'southbag', width: 129, height: 44 }),
      h('h2', 'Social')),
    h('form.search', { role: 'search', onsubmit: e => { e.preventDefault(); if (search.value.trim()) navigate(`/search?q=${encodeURIComponent(search.value.trim())}`); } },
      icon('search'), search),
    h('div.account',
      me ? h('a.btn-small', { href: '/upload', title: 'Upload a video' }, icon('upload'), h('span.label', 'Upload')) : null,
      me ? accountBtn : h('button.btn-small', { type: 'button', onclick: () => login() }, 'Log in with Southbag Identity')));
}

function renderNav(path) {
  const me = store.me;
  const items = [...sections.filter(s => !s.auth || me), me && { href: `/@${me.handle}`, label: 'Profile', icon: 'user' }].filter(Boolean);
  const badge = key => key && store.unread[key] ? h('span.badge', store.unread[key] > 99 ? '99+' : String(store.unread[key])) : null;
  mount(shell.nav, h('ul', items.map(s => h('li', h('a', { href: s.href, 'aria-current': isCurrent(s.href, path) ? 'page' : null },
    icon(s.icon), h('span.label', s.label), badge(s.badge))))));
  const bottom = [
    { href: '/', label: 'Feed', icon: 'home' },
    { href: '/shorts', label: 'Shorts', icon: 'shorts' },
    me ? { href: '/upload', label: 'Create', icon: 'plus', create: true } : { href: '/explore', label: 'Explore', icon: 'compass' },
    { href: me ? '/messages' : '/videos', label: me ? 'Messages' : 'Videos', icon: me ? 'message' : 'video', badge: me && 'messages' },
    me ? { href: '/notifications', label: 'Alerts', icon: 'bell', badge: 'notifications' } : { href: '/groups', label: 'Groups', icon: 'users' },
  ];
  mount(shell.bottom, bottom.map(s => h('a', { href: s.href, class: { create: s.create }, 'aria-current': isCurrent(s.href, path) ? 'page' : null, 'aria-label': s.label },
    icon(s.icon), h('span', s.label), badge(s.badge))));
}

function renderWelcome(path) {
  const me = store.me;
  if (path !== '/' || !me) return mount(shell.welcome);
  mount(shell.welcome,
    h('h1', `Welcome, ${me.name}`),
    h('p', 'Your engagement: ', h('span.stuck-loading')),
    h('p.status', `@${me.handle} · ${me.follower_count} in The Pile · ${me.verified ? 'verified (purchased)' : 'unverified'} · shadowbanned · Bronze Minus`));
}

function paintChrome(path) {
  renderHeader();
  renderNav(path);
  renderWelcome(path);
}

store.on(() => { renderNav(location.pathname); });

// ── Rendering a route ───────────────────────────────────────────────────
async function render(ctx, matched, controller, scroll) {
  const path = ctx.path;
  ctx.me = store.me;
  paintChrome(path);
  let layout = 'default';
  ctx.layout = kind => { layout = kind; shell.layout.className = `layout ${kind === 'default' ? '' : kind}`.trim(); };
  ctx.layout('default');
  ctx.title = text => { document.title = text ? `${text} — Southbag Social` : 'Southbag Social'; };
  ctx.title('');
  ctx.requireAuth = () => {
    if (store.me) return true;
    mount(shell.main, h('div.south-card.flat',
      h('h2', 'Southbag Identity is required.'),
      h('p', 'You must log in with your Southbag account before you can post, watch or be watched.'),
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
    mount(shell.main, h('div.south-card.flat',
      h('h2', 'Something went wrong.'),
      errorBox(err),
      h('p.muted', 'It has been logged. Kevin does not need to respond.')));
  }
  if (layout === 'default') mount(shell.aside, sidebar(ctx));
  else mount(shell.aside);
  mount(shell.footer, layout === 'full' || layout === 'default' ? null : footer());
}

// ── Boot ────────────────────────────────────────────────────────────────
async function boot() {
  applyTheme();
  mount(app, loading('Loading...'));
  await store.refresh();
  mount(shell.promo, promoStrip());
  mount(app, shell.promo, shell.header, shell.welcome, shell.nav, shell.layout, shell.footer, shell.bottom);
  const params = new URLSearchParams(location.search);
  if (params.get('login_error')) {
    const { toast } = await import('./ui.js');
    toast(`Login failed (${params.get('login_error')}). Still probably secure.`, { error: true, timeout: 8000 });
    history.replaceState({}, '', location.pathname);
  }
  if (params.get('signed_out')) {
    const { toast } = await import('./ui.js');
    toast('Signed out. Your data has not been.');
    history.replaceState({}, '', location.pathname);
  }
  startRouter(render);
  if (store.me) {
    promoCarousel();
    document.body.append(privacyPanel());
    scheduleInterruptions();
    // Poll unread counts once a minute (cheap: one query).
    setInterval(() => { if (document.visibilityState === 'visible') store.refresh(); }, 60000);
  }
  window.addEventListener('auth:required', () => { if (store.me) store.refresh(); });
}

boot();
