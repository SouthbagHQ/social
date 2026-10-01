// Jank, after Southbag Online Banking, Identity and Service Table (../support): a splash screen,
// a cookie banner, more help buttons than anyone needs, an announcements ticker, nags to turn on
// notifications, and a page that jumps a little while you scroll. None of it is a joke on screen;
// it is just a site that was built badly. Everything is once-per-session or harmless, and nothing
// here stops anyone posting, reading or messaging. Motion lives in css/chaos.css.

import { h, mount } from './dom.js';
import { navigate } from './router.js';
import { store } from './store.js';
import { dialog, toast, toastError } from './ui.js';
import { track } from './analytics.js';
import { enablePush, needsHomeScreen, pushState } from './push.js';

const once = key => {
  try { if (sessionStorage.getItem(key)) return false; sessionStorage.setItem(key, '1'); } catch {}
  return true;
};

// ── Splash ───────────────────────────────────────────────────────────────
// Banking's loader: promotional slides and a progress bar, once per browser session. No skip.
const slides = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `/img/ad-${n}.jpg`);
const statuses = ['Loading', 'Verifying session', 'Reviewing activity', 'Loading feed', 'Almost done', 'Almost done'];

/** Shows the splash (once per session). Resolves when it is gone, straight away if it isn't shown. */
export function splash(duration = 4200) {
  if (!once('sb_splash_seen')) return Promise.resolve();
  const chosen = [...slides].sort(() => Math.random() - 0.5).slice(0, 3);
  const img = h('img', { src: chosen[0], alt: '' });
  const bar = h('div.splash-bar');
  const status = h('p.splash-status', statuses[0]);
  const el = h('div.splash', { role: 'progressbar', 'aria-label': 'Loading Southbag Social' }, img, h('div.splash-track', bar), status);
  document.body.append(el);
  document.documentElement.classList.add('splash-open');
  track('social_splash_shown');
  const start = performance.now();
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  const tick = setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / duration);
    // Fast to 80%, then a crawl, like every progress bar.
    bar.style.width = `${Math.round((t < 0.5 ? t * 1.6 : 0.8 + (t - 0.5) * 0.4) * 100)}%`;
    img.src = chosen[Math.min(chosen.length - 1, Math.floor(t * chosen.length))];
    status.textContent = statuses[Math.min(statuses.length - 1, Math.floor(t * statuses.length))];
    if (t < 1) return;
    clearInterval(tick);
    el.classList.add('leaving');
    document.documentElement.classList.remove('splash-open');
    setTimeout(() => { el.remove(); done(); }, 500);
  }, 60);
  return finished;
}

// ── Cookie banner ────────────────────────────────────────────────────────
// Once per browser. "Manage preferences" opens every cookie we could think of, all required.
const cookies = [
  'Session', 'Sign-in state', 'Sign-in redirect', 'Security token', 'Request forgery protection',
  'Load balancing', 'Region routing', 'Cache variation', 'Image format preference', 'Feature flags',
  'Gradual rollout', 'Theme', 'Language', 'Locale', 'Time zone', 'Date format', 'Number format',
  'Sidebar state', 'Dismissed banners', 'Promotion strip', 'Splash screen seen', 'Cookie banner seen',
  'Cookie preferences', 'Recently viewed', 'Recent searches', 'Drafts', 'Upload progress',
  'Audio player position', 'Video volume', 'Shorts position', 'Stories seen', 'Unread counts',
  'Notification polling', 'Analytics', 'Session replay', 'Performance', 'Error reporting',
  'Web vitals', 'Page leave', 'kevin_session', 'Bot protection', 'Rate limiting',
];

function cookiePreferences() {
  return dialog({
    title: 'Cookie preferences',
    wide: true,
    body: h('div',
      h('div.cookie-list', cookies.map(name =>
        h('label.cookie-row', h('input', { type: 'checkbox', checked: true, disabled: true }), ` ${name} `, h('span.tiny', '(required)')))),
      h('p.tiny', 'Your preferences have been recorded.')),
    actions: [{ label: 'Save', value: true, primary: true }],
  });
}

export function cookieBanner() {
  try { if (localStorage.getItem('sb_cookies_choice')) return; } catch {}
  const close = choice => {
    try { localStorage.setItem('sb_cookies_choice', choice); } catch {}
    track('social_cookie_choice', { choice });
    banner.remove();
  };
  const banner = h('section.cookie-banner', { role: 'region', 'aria-label': 'Cookies' },
    h('h3', 'Cookies'),
    h('p', 'Southbag Social uses cookies. Some cannot be declined. Continued use constitutes acceptance. ', h('a', { href: '/terms' }, 'Terms')),
    h('div.cookie-actions',
      h('button.btn-large', { type: 'button', onclick: () => close('all') }, 'Accept all'),
      h('button.btn-large', { type: 'button', onclick: () => close('accept') }, 'Accept'),
      h('button.btn-tiny', { type: 'button', onclick: async () => { await cookiePreferences(); close('managed'); } }, 'Manage preferences')));
  setTimeout(() => document.body.append(banner), 2500);
}

// ── Help strip ───────────────────────────────────────────────────────────
// Six ways to reach the same support chat, alternately tiny and huge.
const helpLabels = ['Help', 'Help Centre', 'Get help', 'Support', 'Contact Support', 'Contact us', 'Live chat', 'FAQ'];

export function helpStrip() {
  const labels = [...helpLabels].sort(() => Math.random() - 0.5).slice(0, 6);
  return h('div.help-strip', { role: 'navigation', 'aria-label': 'Help' }, labels.map((label, i) =>
    h(i % 2 ? 'button.btn-large' : 'button.btn-tiny', {
      type: 'button',
      onclick: () => { track('social_help_button', { label }); navigate('/messages/support'); },
    }, label)));
}

// ── Announcements ticker ─────────────────────────────────────────────────
const announcements = [
  'Welcome to Southbag Social.',
  'Everything you post is kept.',
  'New: Wiki. Contributions are permanent.',
  'Scheduled maintenance: in progress. Estimated completion: unknown.',
  'Terms updated. Continued use constitutes acceptance.',
  'Activity on Southbag Social is reviewed.',
];
export const ticker = () => h('div.ticker', { 'aria-hidden': 'true' },
  h('div.ticker-track', [...announcements, ...announcements].map(line => h('span', line))));

// ── Notification nags ────────────────────────────────────────────────────
// Like every site that wants to send notifications: a strip under the header that stays until
// they're on, a card in the corner after most page changes, and a dialog every few pages (with an
// "Are you sure?"). Only "Turn on" asks the browser for permission. Nothing opens while someone is
// typing or another dialog is open, or on Settings and Welcome. It all stops once notifications are
// on, or blocked in the browser.
const NAG_EVERY = 3;            // pages between dialogs
const NAG_GAP_MS = 2 * 60000;   // and at least this long between them
const nagSkip = path => path === '/settings' || path === '/welcome';
const busy = () => document.querySelector('.overlay') || document.documentElement.classList.contains('splash-open')
  || document.activeElement?.matches?.('input, textarea, select, [contenteditable], [contenteditable] *');
const lastDialog = () => { try { return Number(sessionStorage.getItem('sb_nag_at')) || 0; } catch { return 0; } };
const dialogShown = () => { try { sessionStorage.setItem('sb_nag_at', String(Date.now())); } catch {} };

/** Returns the strip for the shell; call `start()` once the router is running. */
export function notificationNags() {
  const strip = h('div.nag-strip.hidden', { role: 'region', 'aria-label': 'Notifications' });
  let state = 'unknown';
  let card = null;
  let pages = 0;
  let lastPath = null;
  const refresh = async () => {
    try { state = store.me ? await pushState() : 'unknown'; } catch { state = 'unknown'; }
    const homeScreen = state === 'unsupported' && needsHomeScreen();
    strip.classList.toggle('hidden', state !== 'off' && !homeScreen);
    mount(strip, state === 'off'
      ? [h('span', 'Notifications are off for this device.'), h('button.btn-small', { type: 'button', onclick: () => turnOn('strip') }, 'Turn on')]
      : homeScreen ? h('span', 'Add Southbag Social to your Home Screen to get notifications.') : null);
    if (state !== 'off') { card?.remove(); card = null; }
    return state;
  };
  // Called straight from a click, so the browser's own prompt is allowed to appear.
  const turnOn = async kind => {
    track('social_push_nag_answered', { kind, choice: 'on' });
    try {
      if (await enablePush()) toast('Notifications on.');
    } catch (err) {
      toastError(err);
    }
    await refresh();
  };

  const showCard = () => {
    if (card || state !== 'off') return;
    track('social_push_nag_shown', { kind: 'card' });
    const close = () => { card?.remove(); card = null; };
    card = h('section.nag-card', { role: 'region', 'aria-label': 'Notifications' },
      h('h3', 'Notifications'),
      h('p', 'Southbag Social would like to send you notifications.'),
      h('div.cookie-actions',
        h('button.btn-large', { type: 'button', onclick: () => { close(); turnOn('card'); } }, 'Allow'),
        h('button.btn-tiny', { type: 'button', onclick: () => { close(); track('social_push_nag_answered', { kind: 'card', choice: 'later' }); } }, 'Later')));
    document.body.append(card);
  };

  const showDialog = async () => {
    dialogShown();
    track('social_push_nag_shown', { kind: 'dialog' });
    const ask = (title, body) => dialog({ title, body, actions: [{ label: 'Not now', value: false }, { label: 'Turn on', value: true, primary: true }] });
    let yes = await ask('Turn on notifications?', 'Find out when people follow you, reply to you or mention you, even when Southbag Social is closed.');
    if (!yes && state === 'off') yes = await ask('Are you sure?', "You won't be notified when people interact with you.");
    if (yes) turnOn('dialog');
    else track('social_push_nag_answered', { kind: 'dialog', choice: 'not_now' });
  };

  const onPage = async () => {
    const path = location.pathname;
    if (path === lastPath) return;
    lastPath = path;
    if (!store.me || await refresh() !== 'off' || nagSkip(path)) return;
    const page = ++pages;
    setTimeout(() => {
      if (location.pathname !== path || state !== 'off' || busy()) return;
      if ((page === 1 || page % NAG_EVERY === 0) && Date.now() - lastDialog() > NAG_GAP_MS) showDialog();
      else if (Math.random() < 0.6) showCard();
    }, page === 1 ? 9000 : 4000);
  };

  return {
    strip,
    start() {
      window.addEventListener('route:change', onPage);
      onPage();
    },
  };
}

// ── Jank ─────────────────────────────────────────────────────────────────
// The page shifts a little now and then while scrolling (Service Table does the same).
export function jank() {
  document.addEventListener('scroll', () => {
    if (Math.random() > 0.05) return;
    document.body.style.paddingTop = `${Math.round(Math.random() * 40)}px`;
    document.body.style.paddingLeft = `${Math.round(Math.random() * 8)}px`;
  }, { passive: true });
}
