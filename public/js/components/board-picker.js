// "Save to board": pick one of your boards (or make one) and save a photo to it.
//   saveToBoard({ post })   a post with photos; if it has several, you choose which one
//   saveToBoard({ pin })    repin someone's pin
// Resolves with the new pin, or null if nothing was saved.
// API: GET /api/boards/mine?media_id, POST /api/boards, POST /api/boards/:id/pins

import { api } from '../api.js';
import { track } from '../analytics.js';
import { h, mount } from '../dom.js';
import { login, store } from '../store.js';
import { dialog, errorBox, loading, shake, toast, toastError } from '../ui.js';

export const field = (label, input, hint) =>
  h('label.field', h('span', label), input, hint ? h('small.fine', hint) : null);

/**
 * A dialog holding a form. `onSubmit()` may throw; the dialog stays open and shows the error.
 * Resolves with what onSubmit returned, or null if closed. `extra(close)` may add a button on the left.
 */
export function formDialog({ title, content, ok = 'Save', onSubmit, wide = false, extra = null }) {
  return dialog({
    title, wide, actions: [],
    body: close => {
      const submit = h('button', { type: 'submit' }, ok);
      const form = h('form.board-form', {
        onsubmit: async e => {
          e.preventDefault();
          submit.disabled = true;
          try {
            const result = await onSubmit();
            close(result ?? true);
          } catch (err) {
            toastError(err);
            shake(form);
            submit.disabled = false;
          }
        },
      }, content, h('div.board-form-actions', extra?.(close), h('span.grow'),
        h('button', { type: 'button', onclick: () => close(null) }, 'Cancel'), submit));
      return form;
    },
  });
}

export function saveToBoard({ post = null, pin = null } = {}) {
  if (!store.me) { login(); return Promise.resolve(null); }
  const images = pin ? [pin.image] : (post?.media || []).filter(m => m.kind === 'image');
  if (!images.length) { toast('There is no photo to save.'); return Promise.resolve(null); }
  let selected = images[0];
  track('social_board_picker_opened', { source: pin ? 'pin' : 'post' });

  return dialog({
    title: 'Save to board',
    actions: [],
    body: close => {
      const list = h('div.picker-boards');
      const preview = h('div.picker-preview');
      const paintPreview = () => mount(preview, h('img', { src: selected.url, alt: selected.alt || '' }));

      const choices = images.length > 1 ? h('div.picker-photos', images.map((m, i) => {
        const btn = h('button.icon-btn', { type: 'button', 'aria-pressed': String(m === selected), onclick: () => {
          selected = m;
          choices.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
          paintPreview();
          loadBoards();
        } }, `Photo ${i + 1}`);
        return btn;
      })) : null;

      async function save(board, row) {
        row?.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
          const payload = pin ? { pin_id: pin.id } : { post_id: post.id, media_id: selected.id };
          const { pin: saved } = await api.post(`boards/${board.id}/pins`, payload);
          toast(`Saved to ${board.title}.`);
          close(saved);
        } catch (err) {
          toastError(err);
          row?.querySelectorAll('button').forEach(b => { b.disabled = false; });
        }
      }

      async function loadBoards() {
        mount(list, loading());
        try {
          const { items } = await api.get('boards/mine', { media_id: selected.id });
          mount(list, items.length ? items.map(b => {
            const row = h('div.picker-row',
              h('span.grow', h('strong', b.title), b.visibility === 'secret' ? h('span.fine', ' Secret') : null,
                b.role === 'editor' ? h('span.fine', ' Group board') : null),
              b.saved ? h('span.fine', 'Saved') : null);
            if (!b.saved) row.append(h('button.btn-small', { type: 'button', onclick: () => save(b, row) }, 'Save'));
            return row;
          }) : h('p.muted', 'No boards yet.'));
        } catch (err) { mount(list, errorBox(err)); }
      }

      // Make a board and save straight into it.
      const title = h('input.input', { maxLength: 50, placeholder: 'Board name', required: true });
      const secret = h('input', { type: 'checkbox' });
      const create = h('form.picker-create', {
        onsubmit: async e => {
          e.preventDefault();
          const submit = create.querySelector('button');
          submit.disabled = true;
          try {
            const { board } = await api.post('boards', { title: title.value, visibility: secret.checked ? 'secret' : 'public' });
            await save(board, null);
          } catch (err) { toastError(err); shake(create); }
          submit.disabled = false;
        },
      },
        h('h3', 'Create board'),
        field('Name', title),
        h('label.checkbox', secret, h('span', 'Keep this board secret')),
        h('button', { type: 'submit' }, 'Create and save'));

      paintPreview();
      loadBoards();
      return h('div.picker', h('div.picker-top', preview, h('div.grow', choices, h('h3', 'Your boards'), list)), h('hr.divider'), create);
    },
  });
}
