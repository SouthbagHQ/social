// /welcome — where new accounts land after their first Southbag Identity login.
// Identity names everyone "Southbag Customer" and has no handles, so we assigned one. This page
// lets people keep it (recommended) or ask for another, set a name and photo, consent, and
// add a few people to The Pile before entering.

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { navigate } from '../router.js';
import { store } from '../store.js';
import { confetti, errorBox, loading, shake, toast, toastError } from '../ui.js';
import { pickFiles, uploadFile } from '../upload.js';
import { avatar, userRow } from '../components/user.js';

export default function welcome(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Welcome');
  ctx.layout('wide');
  const me = store.me;

  // Step 1: handle
  const handleInput = h('input.input', { value: me.handle, maxLength: 20, spellcheck: false, 'aria-label': 'Handle' });
  const handleEdit = h('div.hidden', h('label.field', h('span', 'Requested handle'), h('div.handle-input', h('span', '@'), handleInput)),
    h('p.fine', '3–20 letters, numbers or underscores. Requests are reviewed instantly, which is to say not at all.'));
  const handleStatus = h('p.fine');
  let keepHandle = true;
  const handleStep = h('section.welcome-step',
    h('p.eyebrow', 'STEP 1 OF 5'),
    h('h2', 'Choose a handle.'),
    h('p', 'Southbag has already chosen one for you. It is ', h('strong.mono', `@${me.handle}`), '. You may keep it.'),
    h('div.row.wrap',
      h('button.btn', { type: 'button', onclick: () => {
        keepHandle = true;
        handleEdit.classList.add('hidden');
        handleInput.value = me.handle;
        handleStatus.textContent = `Handle kept: @${me.handle}. It was always going to be.`;
      } }, icon('check'), 'Keep assigned handle'),
      h('button.btn-small.outline', { type: 'button', onclick: () => {
        keepHandle = false;
        handleEdit.classList.remove('hidden');
        handleStatus.textContent = '';
        handleInput.focus();
      } }, 'Request a different handle')),
    handleEdit, handleStatus);

  // Step 2: name
  const nameInput = h('input.input', { value: me.name, maxLength: 50, 'aria-label': 'Display name' });
  const nameStep = h('section.welcome-step',
    h('p.eyebrow', 'STEP 2 OF 5'),
    h('h2', 'Your name.'),
    h('p', 'Southbag Identity calls everyone “Southbag Customer”. You may be more specific. Southbag will continue to call you Southbag Customer internally.'),
    h('label.field', h('span', 'Display name'), nameInput));

  // Step 3: photo
  const photo = h('div.welcome-photo', avatar(me, { size: 'xl', link: false }));
  const photoBar = h('div');
  const photoProgress = h('div.progress-bar.hidden', photoBar);
  const photoBtn = h('button.btn-small', { type: 'button' }, icon('camera'), 'Upload a photo');
  photoBtn.addEventListener('click', async () => {
    const [file] = await pickFiles({ accept: 'image/*' });
    if (!file) return;
    const local = URL.createObjectURL(file);
    mount(photo, avatar({ ...me, avatar_url: local }, { size: 'xl', link: false }));
    photoBtn.disabled = true;
    photoProgress.classList.remove('hidden');
    try {
      const media = await uploadFile(file, { maxEdge: 512, onProgress: p => { photoBar.style.width = `${Math.round(p * 100)}%`; } });
      await api.patch('me', { avatar_media_id: media.id });
      await store.refresh();
      toast('Photo uploaded. It matches the one we already had.');
    } catch (err) {
      toastError(err);
      mount(photo, avatar(store.me, { size: 'xl', link: false }));
    }
    photoProgress.classList.add('hidden');
    photoBtn.disabled = false;
  });
  const photoStep = h('section.welcome-step',
    h('p.eyebrow', 'STEP 3 OF 5 · OPTIONAL'),
    h('h2', 'Profile photo.'),
    h('p', 'Upload a profile photo. Or don\'t. We already have your face.'),
    h('div.row', photo, h('div.stack', photoBtn, photoProgress,
      h('button.btn-small.flat', { type: 'button', onclick: () => toast('Skipped. Southbag ID™ will supply one if required.') }, 'Skip'))));

  // Step 4: consent
  const consent = h('input', { type: 'checkbox' });
  const consentStep = h('section.welcome-step',
    h('p.eyebrow', 'STEP 4 OF 5 · REQUIRED'),
    h('h2', 'Consent.'),
    h('label.checkbox', consent,
      h('span', 'By continuing, you agree that your posts, likes, watch history and hesitation may be used for Palantir analytics, Rewards points (no cash value), and The Pile.')),
    h('p.fine', 'Your consent is non-revocable during the hold period. The hold period is indefinite. Kevin has already agreed on your behalf.'));

  // Step 5: people
  const people = h('div', loading());
  api.get('users/suggested', { limit: 6 }, { signal: ctx.signal })
    .then(({ items }) => mount(people, items.length
      ? items.map(u => userRow(u))
      : h('p.muted', 'Nobody else is here yet. Kevin follows you. That will have to do.')))
    .catch(err => { if (err.name !== 'AbortError') mount(people, errorBox(err)); });
  const peopleStep = h('section.welcome-step',
    h('p.eyebrow', 'STEP 5 OF 5'),
    h('h2', 'Add people to The Pile.'),
    h('p', 'Following someone adds them to The Pile. Do not ask whether The Pile is physical.'),
    people);

  // Enter
  const enter = h('button.btn-large', { type: 'button' }, 'Enter Southbag Social');
  const error = h('div');
  enter.addEventListener('click', async () => {
    mount(error);
    if (!consent.checked) {
      shake(consentStep);
      mount(error, errorBox('Consent is required. It is also assumed. Please tick the box so the paperwork matches.'));
      return;
    }
    const changes = {};
    const name = nameInput.value.trim();
    const handle = handleInput.value.trim().replace(/^@/, '');
    if (name && name !== store.me.name) changes.name = name;
    if (!keepHandle && handle && handle !== store.me.handle) changes.handle = handle;
    enter.disabled = true;
    try {
      if (Object.keys(changes).length) await api.patch('me', changes);
      await store.refresh();
      try { localStorage.setItem('sb_welcomed', '1'); } catch {}
      confetti(30);
      toast('Welcome to Southbag Social. Continued use constitutes acceptance.');
      navigate('/');
    } catch (err) {
      shake(enter);
      mount(error, errorBox(err));
      enter.disabled = false;
    }
  });

  return h('div.welcome-page',
    h('section.south-card.flat.welcome-card',
      h('p.eyebrow', 'SB-DIG-009 · ONBOARDING'),
      h('h1', 'Welcome to Southbag Social'),
      h('p', 'You logged in with your Southbag account, so you may now post, watch and be watched. A few formalities remain. They are mostly for us.'),
      handleStep, nameStep, photoStep, consentStep, peopleStep,
      h('div.welcome-enter', error, enter,
        h('p.fine', 'By entering, you agree to all Southbag terms, policies, and content retention schedules. Kevin has already liked this on your behalf.'))));
}
