// House-style extras shared by every Southbag product: the promotional strip and themes.

import { h } from './dom.js';

const promotions = [
  ['Southbag Rewards', 'https://southbag.cc/financial'],
  ['Southbag Office', 'https://office.southbag.cc'],
  ['Southbag Drive', 'https://drive.southbag.cc'],
  ['Southbag Identity', 'https://identity.southbag.cc/home'],
  ['Southbag Code', 'https://code.southbag.cc'],
];

/** The promotional strip. Rotates through Southbag products; closeable for the session. */
export function promoStrip() {
  try { if (sessionStorage.getItem('sb_promo_closed') === '1') return null; } catch {}
  let i = Math.floor(Math.random() * promotions.length);
  const link = h('a', { target: '_blank', rel: 'noopener', dataset: { external: '' } });
  const paint = () => { [link.textContent, link.href] = promotions[i]; };
  paint();
  const strip = h('div.promo-strip', { role: 'complementary', 'aria-label': 'Promotion' },
    link,
    h('button.promo-close', { type: 'button', onclick: () => {
      try { sessionStorage.setItem('sb_promo_closed', '1'); } catch {}
      strip.remove();
    } }, 'Close'));
  const timer = setInterval(() => {
    if (!strip.isConnected) return clearInterval(timer);
    i = (i + 1) % promotions.length;
    paint();
  }, 9000);
  return strip;
}

export function applyTheme() {
  let theme = 'light', joke = false;
  try { theme = localStorage.getItem('sb_theme') || 'light'; joke = localStorage.getItem('sb_darkmode_gag') === '1'; } catch {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('gag-darkmode', joke);
}
