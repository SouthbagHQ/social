// Southbag Online Banking's signature annoyances, made survivable: every one is skippable,
// shows once, and never blocks posting, liking, commenting, following or messaging.

import { h, mount } from './dom.js';
import { dialog, toast } from './ui.js';

const once = (key, storage = localStorage) => {
  try {
    if (storage.getItem(key)) return false;
    storage.setItem(key, '1');
    return true;
  } catch { return false; }
};

const sponsored = [
  ['Kevin’s Briefcase (replica), $250. Do not open. Ships sealed.', 'https://southbag.cc'],
  ['Southbag Online Banking. Your balance is loading. It has been loading for some time.', 'https://banking.southbag.cc'],
  ['Southbag Code. Write code only slightly slower than Kevin.', 'https://southbag.cc'],
  ['Lost? Give up and find a branch.', 'https://branch-locator.southbag.cc'],
  ['Southbag Rewards. Points have no cash value and expire at Southbag’s discretion.', 'https://southbag.cc/financial'],
  ['Chat with a Human. Response times are not guaranteed.', '/messages/support'],
];

/** The yellow "Promotional banner" strip from optimise.js. Rotates sponsors; closeable per session. */
export function promoStrip() {
  let closed = false;
  try { closed = sessionStorage.getItem('sb_promo_closed') === '1'; } catch {}
  if (closed) return null;
  let i = Math.floor(Math.random() * sponsored.length);
  const link = h('a', { rel: 'noopener' });
  const paint = () => {
    const [text, href] = sponsored[i];
    const external = !href.startsWith('/');
    link.textContent = text;
    link.href = href;
    link.target = external ? '_blank' : '';
    if (external) link.dataset.external = ''; else delete link.dataset.external;
  };
  paint();
  const strip = h('div.promo-strip', { role: 'complementary', 'aria-label': 'Promotional banner' },
    h('span', 'Promotional banner: '), link,
    h('button.promo-close', { type: 'button', 'aria-label': 'Close promotional banner', onclick: () => {
      try { sessionStorage.setItem('sb_promo_closed', '1'); } catch {}
      strip.remove();
      toast('Banner closed. A closure fee may apply.');
    } }, '×'));
  const timer = setInterval(() => { if (!strip.isConnected) return clearInterval(timer); i = (i + 1) % sponsored.length; paint(); }, 9000);
  return strip;
}

/** The fake-ad "Loading..." carousel. Once per browser session, skippable after a second. */
export function promoCarousel() {
  if (!once('sb_carousel', sessionStorage)) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ads = [1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, 2);
  const img = h('img', { src: `/img/ad-${ads[0]}.jpg`, alt: 'Advertisement' });
  const bar = h('div');
  const skip = h('button.btn-small.skip', { type: 'button', disabled: true }, 'Skip ad (1)');
  const overlay = h('div.promo-carousel', { role: 'dialog', 'aria-label': 'Advertisement' }, img, h('div.label', 'Loading...'), h('div.bar', bar), skip);
  const close = () => { overlay.remove(); clearInterval(timer); };
  skip.onclick = close;
  document.body.append(overlay);
  const start = Date.now(), total = 4000;
  const timer = setInterval(() => {
    const t = Date.now() - start;
    bar.style.width = `${Math.min(100, (t / total) * 100)}%`;
    if (t > 1000) { skip.disabled = false; skip.textContent = 'Skip ad'; }
    if (t > total / 2) img.src = `/img/ad-${ads[1]}.jpg`;
    if (t >= total) close();
  }, 100);
}

/** Privacy permissions panel (app.js). Shows once; collapses to a small button forever after. */
export function privacyPanel() {
  let seen = false;
  try { seen = localStorage.getItem('sb_privacy') === '1'; } catch {}
  const host = h('div');
  const minimised = () => mount(host, h('div.privacy-min', h('button.btn-small', { type: 'button', onclick: expanded }, 'Privacy permissions')));
  const save = message => { try { localStorage.setItem('sb_privacy', '1'); } catch {} minimised(); toast(message); };
  const options = [
    ['Share my posts with everyone', 'Required.'],
    ['Share my watch history with Palantir', 'Required. Cannot be disabled.'],
    ['Allow Kevin to like posts on my behalf', 'Kevin has already enabled this.'],
    ['Retain my deleted posts', 'Indefinite. See the retention schedule.'],
    ['Remember hesitation (the time you spend not posting)', 'Used to improve The Pile.'],
  ];
  function expanded() {
    mount(host, h('div.privacy-panel', { role: 'dialog', 'aria-label': 'Privacy permissions' },
      h('h3', 'Privacy permissions'),
      h('p.fine', 'Southbag Social respects your privacy. Please choose which parts of it to surrender.'),
      options.map(([label, note]) => h('label.privacy-option',
        h('input', { type: 'checkbox', checked: true, onchange: e => { e.target.checked = true; toast('That permission is required. It has been re-enabled.'); } }),
        h('span', label, h('small', note)))),
      h('div.privacy-actions',
        h('button.btn-large', { type: 'button', onclick: () => save('Every permission allowed. Thank you for your cooperation.') }, 'Allow every permission'),
        h('button.btn-tiny', { type: 'button', onclick: () => save('Preferences saved. They have been overridden.') }, 'Reject non-essential'))));
  }
  seen ? minimised() : expanded();
  return host;
}

/** Occasional deadpan interruptions (rare, non-blocking). */
export function scheduleInterruptions() {
  const lines = [
    'Posting in person requires a branch visit. You may continue online for now.',
    'Kevin has viewed your profile.',
    'You were charged $0.37: Vibes assessment. No action is required.',
    'Your session is being monitored for quality and training purposes.',
    'Continued scrolling constitutes acceptance. Scrolling backwards constitutes acceptance twice.',
  ];
  const next = () => setTimeout(() => {
    if (document.visibilityState === 'visible') toast(lines[Math.floor(Math.random() * lines.length)]);
    next();
  }, (90 + Math.random() * 180) * 1000);
  next();
}

/** "Confused?" — the banking landing page's most helpful button. */
export const confusedButton = () => h('button.btn-small', { type: 'button', onclick: () => dialog({ body: 'Use the blue button.' }) }, 'Confused?');

export function applyTheme() {
  let theme = 'light', joke = false;
  try { theme = localStorage.getItem('sb_theme') || 'light'; joke = localStorage.getItem('sb_darkmode_gag') === '1'; } catch {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('gag-darkmode', joke);
}
