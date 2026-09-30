// Shared UI kit: toasts, retro dialogs, menus, empty/loading states, tabs, infinite lists.

import { h, icon, mount } from './dom.js';

// ── Kevin's fees (never charged, always itemised) ────────────────────────
const feeReasons = [
  "Kevin's time", 'Looking at Kevin wrong', 'Existing near Kevin', 'Kevin tax', "Interrupting Kevin's lunch",
  'Kevin knows what you did', 'Policy curiosity', 'Appreciation surcharge', 'Vibes assessment',
  'Suspicion of happiness tax', 'Inactivity fee (you blinked)', 'Fee for having a fee', 'Gravity usage charge',
];
export function fee(reason) {
  const cents = [2, 37, 99, 150, 350, 700, 1200][Math.floor(Math.random() * 7)];
  return `Fee assessed: $${(cents / 100).toFixed(2)} — ${reason || feeReasons[Math.floor(Math.random() * feeReasons.length)]}.`;
}

// ── Toasts ───────────────────────────────────────────────────────────────
let toastHost;
/** toast('Posted. Pending review.') / toast(err, { error: true }) / toast('Liked.', { fee: true }) */
export function toast(message, { error = false, fee: withFee = false, timeout = 4200 } = {}) {
  if (!toastHost) toastHost = document.body.appendChild(h('div.toasts', { role: 'status', 'aria-live': 'polite' }));
  const text = message instanceof Error ? message.message : String(message);
  const el = h('div.toast', { class: { error } }, text, withFee ? h('span.fee', typeof withFee === 'string' ? fee(withFee) : fee()) : null);
  toastHost.append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, timeout);
  return el;
}
export const toastError = err => toast(err?.message || String(err), { error: true, timeout: 6000 });

// ── Retro dialogs ────────────────────────────────────────────────────────
/**
 * Opens a Windows-95-ish dialog. Resolves with the value of the clicked action (or null when closed).
 *   dialog({ title: 'Southbag Alert', body: 'Text or node', actions: [{ label: 'OK', value: true, primary: true }] })
 * `body` may be a function (close) => Node for custom content that closes itself.
 */
export function dialog({ title = 'Southbag Alert', body, actions = [{ label: 'OK', value: true, primary: true }], wide = false, onOpen } = {}) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    let done = false;
    const close = value => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
      resolve(value ?? null);
    };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    const content = typeof body === 'function' ? body(close) : body;
    const box = h('div.dialog', { class: { wide }, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div.titlebar', h('span', title), h('button', { type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, '✕')),
      h('div.body', typeof content === 'string' ? h('p', { style: 'margin:0' }, content) : content),
      actions.length ? h('div.actions', actions.map(a =>
        h('button.retro-btn', { type: 'button', class: { primary: a.primary }, onclick: () => close(a.value) }, a.label))) : null,
    );
    const overlay = h('div.overlay', { onclick: e => { if (e.target === overlay) close(null); } }, box);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    (box.querySelector('.retro-btn.primary') || box.querySelector('input, textarea, button:not(.titlebar button)'))?.focus();
    onOpen?.(box, close);
  });
}

export const alertDialog = (message, title = 'Southbag Alert') => dialog({ title, body: message });

/** confirm('Delete this post?', { ok: 'Request deletion' }) → Promise<boolean> */
export async function confirm(message, { title = 'Southbag Alert', ok = 'OK', cancel = 'Cancel' } = {}) {
  return Boolean(await dialog({
    title, body: message,
    actions: [{ label: cancel, value: false }, { label: ok, value: true, primary: true }],
  }));
}

/** prompt('New group name', { value }) → Promise<string|null> */
export function promptDialog(label, { title = 'Southbag Input Required', value = '', placeholder = '', multiline = false, ok = 'OK' } = {}) {
  let input;
  return dialog({
    title,
    body: h('label.field', h('span', label),
      input = h(multiline ? 'textarea.textarea.boxed' : 'input.input.boxed', { value, placeholder })),
    actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: true }],
    onOpen: () => input.focus(),
  }).then(v => (v ? input.value.trim() : null));
}

export function lightbox(src, alt = '') {
  const overlay = h('div.overlay.lightbox', { onclick: () => overlay.remove() },
    h('img', { src, alt }),
    h('button.icon-btn.close', { type: 'button', 'aria-label': 'Close' }, icon('close')));
  const onKey = e => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

// ── Menus ────────────────────────────────────────────────────────────────
/**
 * Pops a menu under `anchor`. items: [{ label, icon?, onClick, danger? } | 'divider']
 */
export function menu(anchor, items) {
  document.querySelectorAll('.menu.popup').forEach(m => m.remove());
  const rect = anchor.getBoundingClientRect();
  const el = h('div.menu.popup', { role: 'menu' }, items.filter(Boolean).map(item => item === 'divider' ? h('hr') :
    h(item.href ? 'a' : 'button', {
      type: item.href ? undefined : 'button', href: item.href, role: 'menuitem', class: { danger: item.danger },
      onclick: () => { el.remove(); item.onClick?.(); },
    }, item.icon ? icon(item.icon) : null, item.label)));
  el.style.top = `${rect.bottom + window.scrollY + 4}px`;
  document.body.append(el);
  const width = el.offsetWidth;
  el.style.left = `${Math.max(8, Math.min(rect.right + window.scrollX - width, window.scrollX + document.documentElement.clientWidth - width - 8))}px`;
  const away = e => { if (!el.contains(e.target) && e.target !== anchor) { el.remove(); document.removeEventListener('click', away, true); } };
  setTimeout(() => document.addEventListener('click', away, true));
  el.querySelector('button, a')?.focus();
  return el;
}

// ── States ───────────────────────────────────────────────────────────────
export const loading = (text = 'Loading...') => h('div.loading', h('div.spinner'), text);

/** empty({ icon: 'bell', title: 'No notifications.', text: 'Kevin has read them already.' }) */
export const empty = ({ icon: name = 'bag', title, text, ref, action } = {}) =>
  h('div.empty', icon(name), title ? h('p', h('strong', title)) : null, text ? h('p', text) : null,
    ref ? h('p.ref', ref) : null, action || null);

export const errorBox = err => h('div.error-box', { role: 'alert' }, err?.message || String(err));

/** Groove tab strip. items: [{ href, label, current? }] or [{ label, selected, onClick }] */
export const tabs = items => h('nav.tabs', items.map(t => t.href
  ? h('a', { href: t.href, 'aria-current': t.current ? 'page' : null }, t.label)
  : h('button', { type: 'button', 'aria-selected': t.selected ? 'true' : 'false', onclick: t.onClick }, t.label)));

/**
 * Infinite list. `load(cursor)` returns `{ items, next }` (the API's paging shape); `render(item)`
 * returns a Node (or null to skip). Returns a container that loads more as it scrolls into view.
 *   infiniteList({ load: c => api.get('feed', { cursor: c }), render: p => postCard(p), empty: empty({...}) })
 * The returned element has `.prepend(node)` for optimistic inserts and `.reload()`.
 */
export function infiniteList({ load, render, empty: emptyNode, className = 'south-board', signal, onPage } = {}) {
  const list = h('div', { class: className });
  const sentinel = h('div.sentinel');
  const status = h('div');
  const root = h('div', list, status, sentinel);
  let next = undefined, busy = false, done = false, count = 0;

  async function more() {
    if (busy || done || signal?.aborted) return;
    busy = true;
    mount(status, loading());
    try {
      const pageData = await load(next);
      if (signal?.aborted) return;
      const items = pageData.items || [];
      for (const item of items) {
        const node = render(item);
        if (node) { list.append(node); count++; }
      }
      onPage?.(items, pageData);
      next = pageData.next;
      done = !next;
      mount(status, done && !count && emptyNode ? emptyNode : null);
    } catch (err) {
      if (err.name === 'AbortError') return;
      mount(status, errorBox(err), h('button.btn-small.outline', { type: 'button', onclick: () => { busy = false; more(); } }, 'Try again'));
      done = true;
      busy = false;
      return;
    }
    busy = false;
    // Keep loading if the sentinel is still visible (short pages on tall screens).
    requestAnimationFrame(() => { if (!done && isVisible(sentinel)) more(); });
  }

  const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) more(); }, { rootMargin: '600px' });
  observer.observe(sentinel);
  signal?.addEventListener('abort', () => observer.disconnect());
  more();

  root.prepend = node => { list.prepend(node); count++; if (status.querySelector('.empty')) mount(status); };
  root.reload = () => { list.replaceChildren(); next = undefined; done = false; count = 0; busy = false; more(); };
  root.list = list;
  return root;
}

const isVisible = el => {
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight + 600 && r.bottom > -600 && el.isConnected;
};

// ── Gags ─────────────────────────────────────────────────────────────────
export function shake(el = document.body) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 600);
}

/** ASCII confetti, as in the banking support chat's [CONFETTI] tag. */
export function confetti(n = 50) {
  const chars = ['*', '+', 'o', '.', 'x', '-'];
  const colours = ['#cc0000', '#00cc00', '#0000cc', '#cccc00'];
  for (let i = 0; i < n; i++) {
    const el = h('span.confetti', chars[i % chars.length]);
    el.style.left = `${Math.random() * 100}vw`;
    el.style.color = colours[i % colours.length];
    el.style.fontSize = `${14 + Math.random() * 14}px`;
    el.style.animationDuration = `${1.5 + Math.random() * 2}s`;
    document.body.append(el);
    setTimeout(() => el.remove(), 4000);
  }
}

/** Copies text; falls back to a dialog when the clipboard is blocked. */
export async function copy(text, message = 'Link copied. Recipients have been logged.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    dialog({ title: 'Copy this', body: h('input.input.boxed', { value: text, readOnly: true, onfocus: e => e.target.select() }) });
  }
}

/** Share a URL with the native share sheet if there is one, otherwise copy it. */
export async function share(url, title = 'Southbag Social') {
  const full = new URL(url, location.origin).href;
  if (navigator.share) {
    try { await navigator.share({ title, url: full }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(full, 'Shared. Recipients have been logged.');
}
