// /dating - Dating. Signed-in users only.
//   First visit: intro panel with "Get started".
//   Then: one card at a time, with "Pass" and "Interested" (Left / Right arrow keys).
//   Pressing "Pass" removes access to Dating for good; after that only the notice is shown.
// API: GET /api/dating, POST /api/dating/start, /interested, /pass (see src/routes/dating.ts).

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { track } from '../analytics.js';
import { errorBox, loading, toastError } from '../ui.js';

const FINDING_MS = 600;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export default async function view(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Dating');

  const root = h('div.dating');
  let mode = 'loading';
  let busy = false;
  let gone = false;
  ctx.cleanup(() => { gone = true; });

  const head = () => h('div.page-head', h('h1', 'Dating'));
  const show = (...nodes) => { if (!gone) mount(root, head(), ...nodes); };

  function renderBanned() {
    mode = 'banned';
    ctx.title('Dating');
    show(h('section.south-card.dating-panel.dating-banned', { role: 'status' },
      h('h2', 'You no longer have access to Dating.'),
      h('p', 'This decision is final.'),
      h('p', h('a', { href: '/' }, 'Back to feed'))));
  }

  function renderIntro() {
    mode = 'intro';
    const start = h('button.btn-large', { type: 'button', onclick: () => getStarted(start) }, 'Get started');
    show(h('section.south-card.dating-panel.dating-intro',
      h('h2', 'Meet people near you.'),
      h('div.dating-actions', start),
      h('p.fine', 'By continuing you agree to the ', h('a', { href: '/terms' }, 'Dating terms'), '.')));
  }

  function cardNode(card) {
    return h('article.south-card.dating-card', { 'aria-label': card.name },
      h('div.dating-photo', h('img', { src: card.image_url, alt: card.name, width: 964, height: 1350, draggable: false })),
      h('h2.dating-name', card.name));
  }

  function renderCard(card) {
    mode = 'card';
    const pass = h('button.btn-large', { type: 'button', onclick: () => doPass() }, 'Pass');
    const interested = h('button.btn-large', { type: 'button', onclick: () => doInterested() }, 'Interested');
    show(h('div.dating-stack',
      cardNode(card),
      h('div.dating-actions', pass, interested),
      h('p.fine.dating-keys', 'Left arrow to pass. Right arrow if interested.')));
  }

  function renderFinding() {
    mode = 'finding';
    show(h('div.dating-stack', h('div.south-card.dating-finding', loading('Finding someone…'))));
  }

  function renderError(err) {
    mode = 'error';
    show(h('section.south-card.dating-panel', errorBox(err)));
  }

  function fromState(state) {
    if (state.banned) renderBanned();
    else if (!state.started || !state.card) renderIntro();
    else renderCard(state.card);
  }

  const removed = err => err?.status === 403;

  async function getStarted(button) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      fromState(await api.post('dating/start'));
    } catch (err) {
      if (removed(err)) renderBanned();
      else { toastError(err); button.disabled = false; }
    } finally {
      busy = false;
    }
  }

  async function doInterested() {
    if (busy || mode !== 'card') return;
    busy = true;
    renderFinding();
    try {
      const [state] = await Promise.all([api.post('dating/interested'), wait(FINDING_MS)]);
      fromState(state);
    } catch (err) {
      if (removed(err)) renderBanned();
      else renderError(err);
    } finally {
      busy = false;
    }
  }

  async function doPass() {
    if (busy || mode !== 'card') return;
    busy = true;
    root.querySelectorAll('.dating-actions button').forEach(b => { b.disabled = true; });
    try {
      await api.post('dating/pass');
      renderBanned();
    } catch (err) {
      if (removed(err)) renderBanned();
      else { toastError(err); root.querySelectorAll('.dating-actions button').forEach(b => { b.disabled = false; }); }
    } finally {
      busy = false;
    }
  }

  const onKey = e => {
    if (mode !== 'card' || busy || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (document.querySelector('.overlay')) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); doPass(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); doInterested(); }
  };
  document.addEventListener('keydown', onKey);
  ctx.cleanup(() => document.removeEventListener('keydown', onKey));

  try {
    const state = await api.get('dating', null, { signal: ctx.signal });
    track('social_dating_opened', { banned: state.banned, started: state.started });
    fromState(state);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    renderError(err);
  }
  return root;
}
