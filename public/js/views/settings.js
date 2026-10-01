// /settings - profile (name, handle, bio, location, website, photo, banner), appearance,
// notifications on this device, and links to Southbag Identity for password and account.
//   PATCH /api/me { name?, handle?, bio?, location?, website?, avatar_media_id?, banner_media_id? }

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { applyTheme } from '../gags.js';
import { store } from '../store.js';
import { toast, toastError } from '../ui.js';
import { disablePush, enablePush, needsHomeScreen, pushState } from '../push.js';
import { pickFiles, uploadFile } from '../upload.js';
import { avatar } from '../components/user.js';

const IDENTITY = 'https://identity.southbag.cc';

const save_ = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };

export default function settings(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Settings');
  const me = store.me;

  return h('div.settings',
    h('div.page-head', h('h1', 'Settings'), h('span.spacer'), h('a.btn-small', { href: `/@${me.handle}` }, 'View profile')),
    profileCard(me),
    appearanceCard(),
    notificationsCard(),
    accountCard(me));
}

// -- Profile ---------------------------------------------------------------

function imagePicker({ label, kind, current, maxEdge, field }) {
  const preview = h(kind === 'avatar' ? 'div.avatar-preview' : 'div.banner-preview');
  const bar = h('div');
  const progress = h('div.progress-bar.hidden', bar);
  const remove = h('button.btn-small', { type: 'button', class: { hidden: !current } }, 'Remove');
  const change = h('button.btn-small', { type: 'button' });
  const paint = url => {
    if (kind === 'avatar') mount(preview, avatar({ ...store.me, avatar_url: url }, { size: 'xl', link: false }));
    else mount(preview, url ? h('img', { src: url, alt: '' }) : null);
    preview.classList.toggle('empty', !url);
    remove.classList.toggle('hidden', !url);
    change.textContent = url ? 'Change' : 'Upload';
  };
  paint(current);
  change.addEventListener('click', async () => {
    const [file] = await pickFiles({ accept: 'image/*' });
    if (!file) return;
    const local = URL.createObjectURL(file);
    paint(local);
    change.disabled = true;
    progress.classList.remove('hidden');
    try {
      const media = await uploadFile(file, { maxEdge, onProgress: p => { bar.style.width = `${Math.round(p * 100)}%`; } });
      await api.patch('me', { [field]: media.id });
      await store.refresh();
      current = kind === 'avatar' ? store.me.avatar_url : store.me.banner_url;
      paint(current);
      toast('Saved.');
    } catch (err) {
      toastError(err);
      paint(current);
    }
    URL.revokeObjectURL(local);
    progress.classList.add('hidden');
    bar.style.width = '0';
    change.disabled = false;
  });
  remove.addEventListener('click', async () => {
    try {
      await api.patch('me', { [field]: null });
      await store.refresh();
      current = null;
      paint(null);
      toast('Removed.');
    } catch (err) { toastError(err); }
  });
  return h('div.image-picker', { class: `pick-${kind}` },
    h('span.field-label', label),
    preview,
    progress,
    h('div.row.wrap', change, remove));
}

function profileCard(me) {
  const field = (label, input, hint) => h('label.field', h('span', label), input, hint ? h('small.fine', hint) : null);
  const name = h('input.input', { name: 'name', value: me.name, maxLength: 50, required: true, autocomplete: 'nickname' });
  const handle = h('input.input', { name: 'handle', value: me.handle, maxLength: 20, pattern: '\\w{3,20}', autocomplete: 'username', spellcheck: false });
  const bio = h('textarea.textarea', { name: 'bio', maxLength: 300, rows: 3 }, me.bio || '');
  const bioCount = h('span.counter');
  const updateBio = () => { bioCount.textContent = `${300 - [...bio.value].length}`; };
  bio.addEventListener('input', updateBio);
  updateBio();
  const location = h('input.input', { name: 'location', value: me.location || '', maxLength: 60 });
  const website = h('input.input', { name: 'website', value: me.website || '', maxLength: 200, type: 'url', placeholder: 'https://' });
  const save = h('button.btn', { type: 'submit' }, 'Save');

  const form = h('form.settings-form', { onsubmit: async e => {
    e.preventDefault();
    const values = { name: name.value.trim(), handle: handle.value.trim().replace(/^@/, ''), bio: bio.value.trim(), location: location.value.trim(), website: website.value.trim() };
    const current = store.me;
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== (current[k] || '')));
    if (!Object.keys(changed).length) return toast('No changes.');
    save.disabled = true;
    try {
      await api.patch('me', changed);
      await store.refresh();
      toast('Saved.');
    } catch (err) {
      toastError(err);
    }
    save.disabled = false;
  } },
    field('Display name', name),
    field('Handle', h('div.handle-input', h('span', '@'), handle), '3 to 20 letters, numbers or underscores.'),
    field('Bio', bio, h('span', 'Characters left: ', bioCount)),
    h('div.two-col',
      field('Location', location),
      field('Website', website)),
    h('div.row.wrap', save));

  return h('section.south-card.flat',
    h('h2', 'Profile'),
    h('div.pickers',
      imagePicker({ label: 'Profile photo', kind: 'avatar', current: me.avatar_url, maxEdge: 512, field: 'avatar_media_id' }),
      imagePicker({ label: 'Banner', kind: 'banner', current: me.banner_url, maxEdge: 1600, field: 'banner_media_id' })),
    h('hr.divider'),
    form);
}

// -- Appearance ------------------------------------------------------------

function appearanceCard() {
  // The old second dark mode (sb_darkmode_gag) is no longer offered; clear it for anyone who had it on.
  if (read('sb_darkmode_gag')) { save_('sb_darkmode_gag', null); applyTheme(); }
  const theme = read('sb_theme') || 'light';
  const radio = (value, label) => h('label.checkbox',
    h('input', { type: 'radio', name: 'sb_theme', value, checked: theme === value, onchange: () => { save_('sb_theme', value); applyTheme(); toast('Saved.'); } }),
    h('span', label));
  return h('section.south-card.flat',
    h('h2', 'Appearance'),
    h('fieldset.theme-choice',
      h('legend', 'Theme'),
      radio('light', 'Light'),
      radio('dark', 'Dark')));
}

// -- Notifications (push, this browser only) -------------------------------

function notificationsCard() {
  const text = h('p', 'Loading...');
  const button = h('button.btn', { type: 'button', class: { hidden: true } });
  let state = null;
  const paint = next => {
    state = next;
    text.textContent = {
      unsupported: needsHomeScreen()
        ? 'On iPhone and iPad, add Southbag Social to your Home Screen first, then turn notifications on there.'
        : "This browser can't show notifications.",
      unavailable: "Notifications aren't available.",
      denied: 'Notifications are blocked in your browser settings.',
      off: 'Get notifications on this device when Southbag Social is closed.',
      on: 'Notifications are on for this device.',
    }[state];
    button.textContent = state === 'on' ? 'Turn off' : 'Turn on';
    button.classList.toggle('hidden', state !== 'on' && state !== 'off');
  };
  const recheck = () => pushState().then(paint).catch(() => paint('unavailable'));
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (state === 'on') {
        await disablePush();
        toast('Notifications off.');
      } else if (await enablePush()) {
        toast('Notifications on.');
      }
    } catch (err) {
      toastError(err);
    }
    await recheck();
    button.disabled = false;
  });
  recheck();
  return h('section.south-card.flat',
    h('h2', 'Notifications'),
    text,
    h('div.row.wrap', button));
}

// -- Account ---------------------------------------------------------------

function accountCard(me) {
  const external = (href, label, cls = 'a.btn') => h(cls, { href, target: '_blank', rel: 'noopener', dataset: { external: '' } }, label);
  return h('section.south-card.flat',
    h('h2', 'Account'),
    h('div.kv',
      h('div', h('span.muted', 'Email'), h('strong', me.email || 'Not set')),
      h('div', h('span.muted', 'Southbag Verified'), h('a', { href: '/verified' }, me.verified ? 'Active' : 'Not subscribed'))),
    h('p', 'Your password, two-step verification and account are managed in Southbag Identity.'),
    h('div.row.wrap',
      external(`${IDENTITY}/security`, 'Password and security'),
      external(`${IDENTITY}/home`, 'Southbag Identity'),
      h('a.btn', { href: '/auth/logout' }, 'Sign out')),
    h('hr.divider'),
    external(`${IDENTITY}/account`, 'Delete account', 'a.btn-tiny'));
}
