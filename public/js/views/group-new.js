// /groups/new - create a group.  POST /api/groups -> navigate to /g/:slug

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { navigate } from '../router.js';
import { shake, toast, toastError } from '../ui.js';
import { pickFiles, uploadFile } from '../upload.js';

export const PRIVACY = {
  public: {
    label: 'Public',
    text: 'Anyone can see posts and join.',
  },
  private: {
    label: 'Private',
    text: 'Only members can see posts. Admins approve new members.',
  },
};

const slugify = text => text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

/**
 * An image picker that uploads straight away. Returns a node with `.value` (media id, null to clear,
 * undefined when untouched) and `.busy`. `kind` is 'avatar' or 'banner'. The preview is a box of the
 * same shape the picture is shown in, and the picture is stretched to fill it.
 */
export function pictureField({ label, kind, current = null, hint }) {
  let value;
  const preview = h(`div.picture-preview.${kind}`);
  const progress = h('div.progress-bar', { hidden: true }, h('div'));
  const remove = h('button.btn-small', { type: 'button', hidden: !current, onclick: () => { value = null; paint(null); } }, 'Remove');
  const paint = url => {
    mount(preview, url ? h('img', { src: url, alt: '' }) : h('span', kind === 'banner' ? 'No banner' : 'No picture'));
    remove.hidden = !url;
  };
  const field = h('div.field.picture-field',
    h('span', label),
    preview,
    progress,
    h('div.row.wrap',
      h('button.btn-small', { type: 'button', onclick: async () => {
        const [file] = await pickFiles({ accept: 'image/*' });
        if (!file) return;
        const local = URL.createObjectURL(file);
        paint(local);
        field.busy = true;
        progress.hidden = false;
        try {
          const media = await uploadFile(file, { maxEdge: kind === 'banner' ? 2048 : 800, onProgress: p => { progress.firstChild.style.width = `${Math.round(p * 100)}%`; } });
          value = media.id;
        } catch (err) {
          toastError(err);
          paint(current);
        }
        field.busy = false;
        progress.hidden = true;
      } }, 'Upload'),
      remove),
    hint ? h('small.fine', hint) : null);
  paint(current);
  Object.defineProperty(field, 'value', { get: () => value });
  field.busy = false;
  return field;
}

export default function groupNewView(ctx) {
  ctx.title('Create group');
  if (!ctx.requireAuth()) return null;

  const name = h('input.input', { name: 'name', required: true, maxLength: 60, placeholder: 'Group name', autocomplete: 'off' });
  const address = h('span');
  const description = h('textarea.textarea', { rows: 4, maxLength: 1000, placeholder: 'What is this group about?' });
  let privacy = 'public';
  const privacyOptions = h('div.privacy-choices', Object.entries(PRIVACY).map(([key, p]) =>
    h('label.privacy-choice', { class: { on: key === privacy } },
      h('input', { type: 'radio', name: 'privacy', value: key, checked: key === privacy, onchange: () => {
        privacy = key;
        privacyOptions.querySelectorAll('.privacy-choice').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
      } }),
      h('span', h('strong', p.label), h('small', p.text)))));
  const avatarField = pictureField({ label: 'Picture (optional)', kind: 'avatar', hint: 'Shown square.' });
  const bannerField = pictureField({ label: 'Banner (optional)', kind: 'banner', hint: 'Shown wide.' });
  const submit = h('button.btn-large', { type: 'submit' }, 'Create group');

  const paintAddress = () => { address.textContent = `/g/${slugify(name.value) || 'group-name'}`; };
  name.addEventListener('input', paintAddress);
  paintAddress();

  const form = h('form.south-card.group-form', { onsubmit: async e => {
    e.preventDefault();
    if (avatarField.busy || bannerField.busy) return toast('Wait for the upload to finish.');
    submit.disabled = true;
    try {
      const { group } = await api.post('groups', {
        name: name.value,
        description: description.value,
        privacy,
        avatar_media_id: avatarField.value || undefined,
        banner_media_id: bannerField.value || undefined,
      });
      toast('Group created.');
      navigate(`/g/${group.slug}`);
    } catch (err) {
      shake(form);
      toastError(err);
      submit.disabled = false;
    }
  } },
    h('h1', 'Create group'),
    h('label.field', h('span', 'Name'), name, h('small.fine', 'Address: ', address)),
    h('label.field', h('span', 'Description'), description),
    h('div.field', h('span', 'Privacy'), privacyOptions),
    avatarField,
    bannerField,
    h('div.row.wrap', submit, h('a.btn', { href: '/groups' }, 'Cancel')));

  setTimeout(() => name.focus(), 50);
  return h('div', form);
}
