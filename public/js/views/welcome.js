// /welcome - where new accounts land after their first Southbag Identity login.
// Identity has no handles, so one was assigned at sign-up. This page lets people change it, set a
// display name and photo, and follow a few people before continuing.

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { navigate } from '../router.js';
import { store } from '../store.js';
import { errorBox, loading, shake, toast, toastError } from '../ui.js';
import { pickFiles, uploadFile } from '../upload.js';
import { avatar, userRow } from '../components/user.js';

export default function welcome(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Welcome');
  ctx.layout('wide');
  const me = store.me;

  // Handle
  const handleInput = h('input.input', { value: me.handle, maxLength: 20, pattern: '\\w{3,20}', spellcheck: false, autocomplete: 'username' });
  const handleStep = h('section.welcome-step',
    h('h2', 'Choose a handle'),
    h('label.field', h('span', 'Handle'), h('div.handle-input', h('span', '@'), handleInput),
      h('small.fine', '3 to 20 letters, numbers or underscores.')));

  // Name
  const nameInput = h('input.input', { value: me.name, maxLength: 50, autocomplete: 'nickname' });
  const nameStep = h('section.welcome-step',
    h('h2', 'Display name'),
    h('label.field', h('span', 'Display name'), nameInput));

  // Photo
  const photo = h('div.welcome-photo', avatar(me, { size: 'xl', link: false }));
  const photoBar = h('div');
  const photoProgress = h('div.progress-bar.hidden', photoBar);
  const photoBtn = h('button.btn-small', { type: 'button' }, me.avatar_url ? 'Change photo' : 'Upload photo');
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
      photoBtn.textContent = 'Change photo';
      toast('Photo uploaded.');
    } catch (err) {
      toastError(err);
      mount(photo, avatar(store.me, { size: 'xl', link: false }));
    }
    URL.revokeObjectURL(local);
    photoProgress.classList.add('hidden');
    photoBar.style.width = '0';
    photoBtn.disabled = false;
  });
  const photoStep = h('section.welcome-step',
    h('h2', 'Profile photo'),
    h('p.fine', 'Optional.'),
    h('div.row', photo, h('div.stack', photoBtn, photoProgress)));

  // People
  const people = h('div', loading());
  api.get('users/suggested', { limit: 6 }, { signal: ctx.signal })
    .then(({ items }) => mount(people, items.length ? items.map(u => userRow(u)) : h('p.muted', 'No suggestions.')))
    .catch(err => { if (err.name !== 'AbortError') mount(people, errorBox(err)); });
  const peopleStep = h('section.welcome-step',
    h('h2', 'People to follow'),
    people);

  // Continue
  const next = h('button.btn-large', { type: 'button' }, 'Continue');
  const error = h('div');
  next.addEventListener('click', async () => {
    mount(error);
    const changes = {};
    const name = nameInput.value.trim();
    const handle = handleInput.value.trim().replace(/^@/, '');
    if (!name) {
      shake(nameStep);
      mount(error, errorBox('Enter a display name.'));
      return;
    }
    if (name !== store.me.name) changes.name = name;
    if (handle && handle !== store.me.handle) changes.handle = handle;
    next.disabled = true;
    try {
      if (Object.keys(changes).length) await api.patch('me', changes);
      await store.refresh();
      try { localStorage.setItem('sb_welcomed', '1'); } catch {}
      toast('Welcome to Southbag Social.');
      navigate('/');
    } catch (err) {
      shake(next);
      mount(error, errorBox(err));
      next.disabled = false;
    }
  });

  return h('div.welcome-page',
    h('section.south-card.flat.welcome-card',
      h('h1', 'Welcome'),
      h('p', 'Set up your Southbag Social profile.'),
      handleStep, nameStep, photoStep, peopleStep,
      h('div.welcome-enter', error, next,
        h('p.fine', 'You can change these later in ', h('a', { href: '/settings' }, 'Settings'), '.'))));
}
