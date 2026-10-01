// Jank, after Southbag Online Banking, Identity and Service Table (../support): a splash screen,
// a cookie banner, more help buttons than anyone needs, an announcements ticker, a page that
// jumps a little while you scroll, and buttons that bounce. None of it is a joke on screen; it is
// just a site that was built badly. Everything is once-per-session or harmless, and nothing here
// stops anyone posting, reading or messaging. Motion lives in css/chaos.css.

import { h } from './dom.js';
import { navigate } from './router.js';
import { dialog } from './ui.js';
import { track } from './analytics.js';

const once = key => {
  try { if (sessionStorage.getItem(key)) return false; sessionStorage.setItem(key, '1'); } catch {}
  return true;
};

// ── Splash ───────────────────────────────────────────────────────────────
// Banking's loader: promotional slides and a progress bar, once per browser session. No skip.
const slides = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `/img/ad-${n}.jpg`);
const statuses = ['Loading', 'Verifying session', 'Reviewing activity', 'Loading feed', 'Almost done', 'Almost done'];

export function splash(duration = 4200) {
  if (!once('sb_splash_seen')) return;
  const chosen = [...slides].sort(() => Math.random() - 0.5).slice(0, 3);
  const img = h('img', { src: chosen[0], alt: '' });
  const bar = h('div.splash-bar');
  const status = h('p.splash-status', statuses[0]);
  const el = h('div.splash', { role: 'progressbar', 'aria-label': 'Loading Southbag Social' }, img, h('div.splash-track', bar), status);
  document.body.append(el);
  document.documentElement.classList.add('splash-open');
  track('social_splash_shown');
  const start = performance.now();
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
    setTimeout(() => el.remove(), 500);
  }, 60);
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

// ── Jank ─────────────────────────────────────────────────────────────────
// Buttons bounce when pressed, and the page shifts a little now and then while scrolling
// (Service Table does the same).
export function jank() {
  document.addEventListener('click', e => {
    const btn = e.target.closest?.('button, .btn, .btn-large, .btn-small');
    if (!btn) return;
    btn.classList.remove('boing');
    void btn.offsetWidth;
    btn.classList.add('boing');
  }, true);
  document.addEventListener('scroll', () => {
    if (Math.random() > 0.05) return;
    document.body.style.paddingTop = `${Math.round(Math.random() * 40)}px`;
    document.body.style.paddingLeft = `${Math.round(Math.random() * 8)}px`;
  }, { passive: true });
}
