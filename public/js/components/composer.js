// The composer: text, up to 10 photos or one video, visibility. Uploads start as soon as a file
// is attached, so "Post" is quick. Used for feed posts, replies, quotes, wall posts and group posts.
//
//   composer({ placeholder, replyTo, quoteOf, groupId, wallUserId, onPosted(post), autofocus, compact,
//              submitLabel, allowMedia = true, allowVideo = true, visibility = true })

import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { login, store } from '../store.js';
import { shake, toast, toastError } from '../ui.js';
import { kindOf, pickFiles, uploadFile } from '../upload.js';
import { celebrateFirstPost } from './post.js';
import { avatar } from './user.js';

const TEXT_LIMIT = 280;
const CAPTION_LIMIT = 2200;
const MAX_PHOTOS = 10;

const placeholders = [
  'What is happening? Kevin already knows.',
  'Say something compliant.',
  'Share an update. It will be retained permanently.',
  'Post something. Your reach is conditional.',
];

export function composer(options = {}) {
  const {
    replyTo = null, quoteOf = null, groupId = null, wallUserId = null, onPosted, autofocus = false, compact = false,
    allowMedia = true, allowVideo = true, visibility: showVisibility = !replyTo && !groupId,
  } = options;
  const placeholder = options.placeholder || (replyTo ? 'Post your reply. Say something compliant.' : placeholders[Math.floor(Math.random() * placeholders.length)]);
  const submitLabel = options.submitLabel || (replyTo ? 'Reply' : 'Post');

  if (!store.me) {
    return h('div.notice', 'Log in with Southbag Identity to post. ',
      h('button.btn-small', { type: 'button', onclick: () => login() }, 'Log in'));
  }

  /** @type {{ file: File, preview: string, media: object|null, error: string|null, el: HTMLElement, controller: AbortController, done: Promise }[]} */
  const attachments = [];
  const textarea = h('textarea', { placeholder, rows: compact ? 1 : 2, 'aria-label': placeholder, maxLength: CAPTION_LIMIT + 100 });
  const counter = h('span.counter');
  const attachmentsEl = h('div.attachments');
  const visibility = h('select.select', { 'aria-label': 'Who can see this', style: 'width:auto;min-height:0;padding:4px;font-size:.85rem' },
    h('option', { value: 'public' }, 'Everyone (and Kevin)'),
    h('option', { value: 'followers' }, 'The Pile (followers)'),
    h('option', { value: 'friends' }, 'Friends'));
  const submit = h('button.btn', { type: 'submit' }, submitLabel);

  const limit = () => (attachments.length ? CAPTION_LIMIT : TEXT_LIMIT);
  const update = () => {
    const n = [...textarea.value].length;
    const left = limit() - n;
    counter.textContent = n ? String(left) : '';
    counter.classList.toggle('over', left < 0);
    const uploading = attachments.some(a => !a.media && !a.error);
    submit.disabled = left < 0 || uploading || (!n && !attachments.some(a => a.media) && !quoteOf);
    submit.textContent = uploading ? 'Uploading…' : submitLabel;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 320)}px`;
  };
  textarea.addEventListener('input', update);
  textarea.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit(); });
  textarea.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && allowMedia) { e.preventDefault(); addFiles(files); }
  });

  function addFiles(files) {
    for (const file of files) {
      const kind = kindOf(file);
      if (kind !== 'image' && !(kind === 'video' && allowVideo)) { toast('Southbag only accepts photos and videos here.', { error: true }); continue; }
      const hasVideo = attachments.some(a => kindOf(a.file) === 'video');
      if (kind === 'video' && attachments.length) { toast('A video goes on its own. Remove the other attachments first.', { error: true }); continue; }
      if (hasVideo) { toast('One video per post. Kevin set the rule.', { error: true }); continue; }
      if (attachments.length >= MAX_PHOTOS) { toast(`${MAX_PHOTOS} photos per post. Kevin counted.`, { error: true }); break; }
      const preview = URL.createObjectURL(file);
      const progress = h('div.progress', { style: 'width:0' });
      const item = { file, preview, media: null, error: null, controller: new AbortController() };
      item.el = h('div.attachment',
        kind === 'video' ? h('video', { src: preview, muted: true, playsInline: true }) : h('img', { src: preview, alt: '' }),
        progress,
        h('button.remove', { type: 'button', 'aria-label': 'Remove attachment', onclick: () => removeAttachment(item) }, icon('close')));
      attachments.push(item);
      attachmentsEl.append(item.el);
      item.done = uploadFile(file, { signal: item.controller.signal, onProgress: p => { progress.style.width = `${Math.round(p * 100)}%`; } })
        .then(media => { item.media = media; progress.style.width = '100%'; setTimeout(() => progress.remove(), 400); })
        .catch(err => {
          if (err.name === 'AbortError') return;
          item.error = err.message;
          item.el.classList.add('error');
          item.el.title = err.message;
          toast(`Upload failed. ${err.message}`, { error: true });
        })
        .finally(update);
    }
    update();
  }

  function removeAttachment(item) {
    item.controller.abort();
    if (item.media) api.del(`media/${item.media.id}`).catch(() => {});
    URL.revokeObjectURL(item.preview);
    item.el.remove();
    attachments.splice(attachments.indexOf(item), 1);
    update();
  }

  const tools = h('div.tools',
    allowMedia ? h('button.icon-btn', {
      type: 'button', title: allowVideo ? 'Add photos or a video' : 'Add photos',
      onclick: async () => addFiles(await pickFiles({ accept: allowVideo ? 'image/*,video/*' : 'image/*', multiple: true })),
    }, icon('image'), h('span.sr-only', 'Add media')) : null,
    showVisibility ? visibility : null,
    h('span.spacer'),
    counter,
    submit);

  const form = h('form.composer', { onsubmit: async e => {
    e.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    const failed = attachments.filter(a => a.error);
    if (failed.length) { toast('Remove the failed uploads first.', { error: true }); shake(form); update(); return; }
    const media = attachments.map(a => a.media).filter(Boolean);
    const video = media.find(m => m.kind === 'video');
    const kind = video
      ? (video.height > video.width && (video.duration || 0) <= 180 ? 'short' : 'video')
      : media.length && !replyTo && !groupId && !wallUserId ? 'photo' : 'text';
    let title;
    if (kind === 'video') {
      // Videos need a title; take the first line of the text.
      const first = textarea.value.trim().split('\n')[0];
      title = first.slice(0, 120) || 'Untitled video (Kevin approved)';
    }
    try {
      const { post } = await api.post('posts', {
        kind, title, body: textarea.value, media_ids: media.map(m => m.id),
        reply_to_id: replyTo?.id, repost_of_id: quoteOf?.id, group_id: groupId, wall_user_id: wallUserId,
        visibility: showVisibility ? visibility.value : undefined,
      });
      textarea.value = '';
      attachments.splice(0).forEach(a => { URL.revokeObjectURL(a.preview); a.el.remove(); });
      update();
      if (!replyTo) celebrateFirstPost();
      if (!replyTo && !quoteOf) toast('Posted. Pending review.');
      onPosted?.(post);
    } catch (err) {
      shake(form);
      toastError(err);
    }
    update();
  } },
    compact ? null : avatar(store.me, { link: false }),
    h('div.grow', textarea, attachmentsEl, tools));

  // Drag and drop onto the composer.
  if (allowMedia) {
    form.addEventListener('dragover', e => { e.preventDefault(); form.style.outline = '2px dashed var(--sb-teal)'; });
    form.addEventListener('dragleave', () => { form.style.outline = ''; });
    form.addEventListener('drop', e => { e.preventDefault(); form.style.outline = ''; addFiles([...e.dataTransfer.files]); });
  }
  update();
  if (autofocus) setTimeout(() => textarea.focus(), 50);
  form.focus = () => textarea.focus();
  form.setText = text => { textarea.value = text; update(); };
  return form;
}

/** Composer inside a card, the default on feeds. */
export const composerCard = options => h('div.south-card.flat', composer(options));
