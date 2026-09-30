// /settings — profile (name, handle, bio, location, website, avatar, banner), appearance,
// the retention schedule, and the parts Southbag Identity™ owns (password, 2FA, deletion).
//   PATCH /api/me { name?, handle?, bio?, location?, website?, avatar_media_id?, banner_media_id? }

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { money } from '../format.js';
import { applyTheme } from '../gags.js';
import { store } from '../store.js';
import { shake, toast, toastError } from '../ui.js';
import { pickFiles, uploadFile } from '../upload.js';
import { avatar } from '../components/user.js';

const RETENTION = [
  ['Posts', 'Indefinite'], ['Deleted posts', 'Indefinite'], ['Drafts you did not send', 'Indefinite'],
  ['Likes (and their fees)', 'Indefinite'], ['Stories', '24 hours (visible) · Indefinite (retained)'],
  ['Messages', 'Indefinite'], ['Watch history', 'Indefinite'], ['Hesitation', 'Indefinite'],
  ['Profile photos you replaced', 'Indefinite'], ['Deletion', 'Not available'],
];

const store_ = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };

export default function settings(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Settings');
  const me = store.me;

  return h('div.settings',
    h('div.page-head', h('h1', 'Settings'), h('span.spacer'), h('a.btn-small.outline', { href: `/@${me.handle}` }, icon('user'), 'View profile')),
    profileCard(me),
    appearanceCard(),
    retentionCard(),
    accountCard(me));
}

// ── Profile ───────────────────────────────────────────────────────────────

function imagePicker({ label, kind, current, maxEdge, field }) {
  const preview = kind === 'avatar'
    ? h('div.avatar-preview', avatar({ ...store.me, avatar_url: current }, { size: 'xl', link: false }))
    : h('div.banner-preview', current ? h('img', { src: current, alt: '' }) : h('img.watermark', { src: '/img/logo-400.png', alt: '' }));
  const bar = h('div');
  const progress = h('div.progress-bar.hidden', bar);
  const remove = h('button.btn-small.flat', { type: 'button', class: { hidden: !current } }, 'Remove');
  const paint = url => {
    if (kind === 'avatar') mount(preview, avatar({ ...store.me, avatar_url: url }, { size: 'xl', link: false }));
    else mount(preview, url ? h('img', { src: url, alt: '' }) : h('img.watermark', { src: '/img/logo-400.png', alt: '' }));
    remove.classList.toggle('hidden', !url);
  };
  const change = h('button.btn-small', { type: 'button' }, icon('camera'), current ? 'Change' : 'Upload');
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
      toast(kind === 'avatar' ?'Profile photo updated. The previous one is retained.' : 'Banner updated. The previous one is retained.');
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
      toast('Removed from display. Retained on file.');
    } catch (err) { toastError(err); }
  });
  return h('div.image-picker', { class: `pick-${kind}` },
    h('span.label', label),
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
  const location = h('input.input', { name: 'location', value: me.location || '', maxLength: 60, placeholder: 'Anywhere except Canberra' });
  const website = h('input.input', { name: 'website', value: me.website || '', maxLength: 200, type: 'url', placeholder: 'https://' });
  const save = h('button.btn', { type: 'submit' }, 'Save changes');

  const form = h('form.settings-form', { onsubmit: async e => {
    e.preventDefault();
    const values = { name: name.value.trim(), handle: handle.value.trim().replace(/^@/, ''), bio: bio.value.trim(), location: location.value.trim(), website: website.value.trim() };
    const current = store.me;
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== (current[k] || '')));
    if (!Object.keys(changed).length) return toast('Nothing changed. Kevin checked.');
    save.disabled = true;
    try {
      await api.patch('me', changed);
      await store.refresh();
      toast(changed.handle ? `Saved. You are now @${changed.handle}. The old handle is retained.` : 'Saved. Amendments are logged. The original is retained.');
    } catch (err) {
      shake(form);
      toastError(err);
    }
    save.disabled = false;
  } },
    field('Display name (Southbag Identity calls you Southbag Customer)', name),
    field('Handle', h('div.handle-input', h('span', '@'), handle), '3–20 letters, numbers or underscores. Previous handles are retained.'),
    field('Bio', bio, h('span', 'Mention #tags and @people. Characters left: ', bioCount)),
    h('div.two-col',
      field('Location', location),
      field('Website', website)),
    h('div.row.wrap', save, h('span.fine', 'Changes are reviewed after they are published.')));

  return h('section.south-card.flat',
    h('h2', 'Profile'),
    h('div.pickers',
      imagePicker({ label: 'Profile photo', kind: 'avatar', current: me.avatar_url, maxEdge: 512, field: 'avatar_media_id' }),
      imagePicker({ label: 'Banner', kind: 'banner', current: me.banner_url, maxEdge: 1600, field: 'banner_media_id' })),
    h('p.fine', 'Upload a profile photo. Or don\'t. We already have your face.'),
    h('hr.divider'),
    form);
}

// ── Appearance ────────────────────────────────────────────────────────────

function appearanceCard() {
  const theme = read('sb_theme') || 'light';
  const radio = (value, label, note) => h('label.checkbox',
    h('input', { type: 'radio', name: 'sb_theme', value, checked: theme === value, onchange: () => { store_('sb_theme', value); applyTheme(); toast(value === 'dark' ? 'Dark mode enabled. Kevin prefers the lights on.' : 'Light mode enabled. The office light never turns off either.'); } }),
    h('span', label, h('small.fine', { style: 'display:block' }, note)));
  const gag = h('label.checkbox',
    h('input', { type: 'checkbox', checked: read('sb_darkmode_gag') === '1', onchange: e => {
      store_('sb_darkmode_gag', e.target.checked ? '1' : null);
      applyTheme();
      toast(e.target.checked ? 'Dark mode (banking edition) enabled. Headings are now black on black. As designed.' : 'Dark mode (banking edition) disabled. The headings have returned.');
    } }),
    h('span', 'Dark mode (banking edition)',
      h('small.fine', { style: 'display:block' }, 'As shipped by Southbag Online Banking: black background, black headings, pink buttons. Not recommended. Very authentic.')));
  return h('section.south-card.flat',
    h('h2', 'Appearance'),
    h('div.stack', radio('light', 'Light', 'Off-white paper. Beveled edges. The default.'), radio('dark', 'Dark', 'The real dark mode. Readable. Suspicious.'), gag));
}

// ── Retention and account ─────────────────────────────────────────────────

function retentionCard() {
  return h('section.south-card.flat',
    h('p.eyebrow', 'SB-DATA-2021 · READ ONLY'),
    h('h2', 'Retention schedule'),
    h('table.retention',
      h('thead', h('tr', h('th', 'Data'), h('th', 'Retention'))),
      h('tbody', RETENTION.map(([what, how]) => h('tr', h('td', what), h('td', h('strong', how)))))),
    h('p.fine', 'This schedule cannot be changed. Requests to change it are retained indefinitely.'));
}

function accountCard(me) {
  const external = (href, label, cls = 'a.btn.outline') => h(cls, { href, target: '_blank', rel: 'noopener', dataset: { external: '' } }, label);
  return h('section.south-card.flat',
    h('h2', 'Account and security'),
    h('div.kv',
      h('div', h('span.muted', 'Email (from Southbag Identity™)'), h('strong', me.email || 'Withheld')),
      h('div', h('span.muted', 'Fees owed to Southbag'), h('a', { href: '/verified' }, money(me.bag_balance || 0)))),
    h('p', 'Your password and two-factor authentication are managed by Southbag Identity™. Southbag Social cannot see them. It has asked.'),
    h('div.row.wrap',
      external('https://identity.southbag.cc/security', 'Password and 2FA'),
      h('a.btn.danger', { href: '/auth/logout' }, icon('log-out'), 'Log out')),
    h('hr.divider'),
    h('p.fine', 'Deleting your Southbag Identity deletes your access. It does not delete your posts.'),
    external('https://identity.southbag.cc/account', 'Delete account', 'a.btn-tiny'));
}
