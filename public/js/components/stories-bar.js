// Stories: the tray of people with stories above the feed, and the story composer.
//
//   storiesBar()          -> Node, returned at once and filled in when GET /api/stories answers.
//                           Hides itself when signed out and nobody has a story.
//   openStoryComposer()   -> opens the "New story" dialog (photo, short video, or text on a background).
//   STORY_BACKGROUNDS     presets for text stories (the server keeps the key in stories.background).
//   storyBackground(key)  -> CSS background colour for a preset key (or null).
//
// Anything that changes stories dispatches `stories:changed` on window; mounted bars reload.

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { dialog, toast, toastError } from '../ui.js';
import { kindOf, pickFiles, uploadFile } from '../upload.js';
import { avatar } from './user.js';

export const STORY_MAX_SECONDS = 60;
const CAPTION_LIMIT = 200;
const TEXT_LIMIT = 180;

// Greys, plus one Southbag blue. Keys must match BACKGROUNDS in src/routes/stories.ts.
export const STORY_BACKGROUNDS = {
  white: { label: 'White', color: '#fbfaf6', ink: '#171714' },
  light: { label: 'Light grey', color: '#dcdbd6', ink: '#171714' },
  grey: { label: 'Grey', color: '#9a9892', ink: '#171714' },
  dark: { label: 'Dark grey', color: '#4a4944', ink: '#ffffff' },
  black: { label: 'Black', color: '#171714', ink: '#ffffff' },
  blue: { label: 'Blue', color: '#3b87c6', ink: '#ffffff' },
};
const DEFAULT_BACKGROUND = 'light';

export const storyBackground = key => STORY_BACKGROUNDS[key]?.color || null;

const changed = () => window.dispatchEvent(new CustomEvent('stories:changed'));

/** Remember where the viewer was opened from, so closing it goes back there. */
export const markStoryOrigin = () => { try { sessionStorage.setItem('sb_story_from', location.pathname + location.search); } catch {} };

// The tray

export function storiesBar() {
  const track = h('div.stories-track', { role: 'list' }, h('p.stories-empty', 'Loading'));
  const prev = h('button.btn-small', { type: 'button', disabled: true, onclick: () => track.scrollBy({ left: -track.clientWidth * 0.8, behavior: 'smooth' }) }, 'Previous');
  const next = h('button.btn-small', { type: 'button', disabled: true, onclick: () => track.scrollBy({ left: track.clientWidth * 0.8, behavior: 'smooth' }) }, 'Next');
  const root = h('section.stories-bar', { 'aria-label': 'Stories' },
    h('div.stories-head', h('h3', 'Stories'), h('span.spacer'), prev, next),
    track);

  const paintScroll = () => {
    prev.disabled = track.scrollLeft <= 4;
    next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
  };
  track.addEventListener('scroll', paintScroll, { passive: true });

  async function load() {
    let items = [];
    try {
      ({ items } = await api.get('stories'));
    } catch {
      if (!store.me) { root.hidden = true; return; }
    }
    const me = store.me;
    const mine = me && items.find(i => i.user.id === me.id);
    const others = items.filter(i => !me || i.user.id !== me.id);
    if (!me && !others.length) { root.hidden = true; return; }
    root.hidden = false;
    mount(track,
      me ? addItem() : null,
      mine ? bubble(mine, 'Your story') : null,
      others.map(item => bubble(item)),
      !others.length && me ? h('p.stories-empty', { role: 'listitem' }, 'No stories yet.') : null);
    requestAnimationFrame(paintScroll);
  }

  const onChanged = () => { if (!root.isConnected) return window.removeEventListener('stories:changed', onChanged); load(); };
  window.addEventListener('stories:changed', onChanged);
  load();
  return root;
}

function addItem() {
  return h('div.story-bubble.add', { role: 'listitem' },
    h('button.story-add', { type: 'button', onclick: () => openStoryComposer() }, 'Add story'));
}

function bubble(item, label) {
  const { user, seen } = item;
  return h('div.story-bubble', { role: 'listitem', class: { seen } },
    h('a.story-open', {
      href: `/stories/${user.handle}`,
      onclick: markStoryOrigin,
      'aria-label': `Stories from ${user.name}, ${item.stories_count} ${item.stories_count === 1 ? 'story' : 'stories'}${seen ? ', seen' : ''}`,
    },
      avatar(user, { link: false, ring: seen ? 'seen' : 'new' }),
      h('span.label', label || user.name.split(' ')[0] || user.handle)));
}

// Composer

function videoDuration(url) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => resolve(null);
    setTimeout(() => resolve(null), 8000);
    v.src = url;
  });
}

/** Word-wraps `text` for a canvas context at `maxWidth`, keeping the user's line breaks. */
function wrap(ctx, text, maxWidth) {
  const lines = [];
  const fits = t => ctx.measureText(t).width <= maxWidth;
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (fits(test)) { line = test; continue; }
      if (line) lines.push(line);
      // A word wider than the story gets broken by character.
      line = '';
      for (const ch of word) {
        if (line && !fits(line + ch)) { lines.push(line); line = ''; }
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Draws a text story (1080x1920) and resolves to a JPEG File. */
async function renderTextStory(text, key) {
  const bg = STORY_BACKGROUNDS[key] || STORY_BACKGROUNDS[DEFAULT_BACKGROUND];
  const canvas = document.createElement('canvas');
  canvas.width = 1080; canvas.height = 1920;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg.color;
  ctx.fillRect(0, 0, 1080, 1920);
  // Same font as the page (the browser default).
  const family = getComputedStyle(document.body).fontFamily || 'serif';
  const font = size => `700 ${size}px ${family}`;
  let size = text.length > 120 ? 64 : text.length > 60 ? 76 : 92;
  ctx.font = font(size);
  let lines = wrap(ctx, text, 900);
  while (lines.length * size * 1.25 > 1400 && size > 40) {
    size -= 6;
    ctx.font = font(size);
    lines = wrap(ctx, text, 900);
  }
  ctx.fillStyle = bg.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,.27)';
  ctx.shadowBlur = 4; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;
  const top = 960 - ((lines.length - 1) * size * 1.25) / 2;
  lines.forEach((line, i) => ctx.fillText(line, 540, top + i * size * 1.25));
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
  return new File([blob], 'story.jpg', { type: 'image/jpeg' });
}

/** Opens the "New story" dialog. Resolves with the created story, or null. */
export function openStoryComposer() {
  if (!store.me) { login(); return Promise.resolve(null); }
  let created = null;
  return dialog({
    title: 'New story',
    wide: true,
    actions: [],
    body: close => {
      let mode = 'media';
      let file = null, previewUrl = null, background = DEFAULT_BACKGROUND;
      const preview = h('div.story-preview');
      const caption = h('input.input', { placeholder: 'Caption (optional)', maxLength: CAPTION_LIMIT });
      const textInput = h('textarea.textarea', { rows: 3, maxLength: TEXT_LIMIT, placeholder: 'Write something' });
      const progress = h('div.progress-bar', { hidden: true }, h('div'));
      const share = h('button.btn', { type: 'submit', disabled: true }, 'Share story');
      const pick = h('button.btn-small', { type: 'button' }, 'Choose file');
      const backgrounds = h('div.story-backgrounds', { role: 'radiogroup', 'aria-label': 'Background' },
        Object.entries(STORY_BACKGROUNDS).map(([key, bg]) => h('label.checkbox',
          h('input', { type: 'radio', name: 'story-background', value: key, checked: key === background, onchange: () => { background = key; paint(); } }),
          h('span', bg.label))));
      const tabsEl = h('div.tabs.story-mode',
        h('button', { type: 'button', 'aria-selected': 'true', onclick: () => setMode('media') }, 'Photo or video'),
        h('button', { type: 'button', 'aria-selected': 'false', onclick: () => setMode('text') }, 'Text'));
      const mediaFields = h('div.stack', h('div.row.wrap', pick, h('span.fine', 'Photo, or video up to 60 seconds.')), h('label.field', h('span', 'Caption'), caption));
      const textFields = h('div.stack', { hidden: true }, h('label.field', h('span', 'Text'), textInput), h('div', h('span.field-label', 'Background'), backgrounds));

      function setMode(next) {
        mode = next;
        [...tabsEl.children].forEach((b, i) => b.setAttribute('aria-selected', String((i === 0) === (mode === 'media'))));
        mediaFields.hidden = mode !== 'media';
        textFields.hidden = mode !== 'text';
        paint();
        (mode === 'text' ? textInput : pick).focus();
      }

      function paint() {
        preview.style.background = '';
        if (mode === 'text') {
          const bg = STORY_BACKGROUNDS[background];
          preview.style.background = bg.color;
          mount(preview, h('div.story-preview-text', { style: { color: bg.ink } }, textInput.value.trim() || 'Preview'));
          share.disabled = !textInput.value.trim();
        } else if (file) {
          mount(preview, kindOf(file) === 'video'
            ? h('video', { src: previewUrl, muted: true, autoplay: true, loop: true, playsInline: true })
            : h('img', { src: previewUrl, alt: '' }));
          share.disabled = false;
        } else {
          mount(preview, h('p.story-preview-empty', 'No file chosen.'));
          share.disabled = true;
        }
      }

      async function choose() {
        const [picked] = await pickFiles({ accept: 'image/*,video/*' });
        if (!picked) return;
        const kind = kindOf(picked);
        if (kind !== 'image' && kind !== 'video') return toast('Stories are photos or videos.', { error: true });
        const url = URL.createObjectURL(picked);
        if (kind === 'video') {
          const seconds = await videoDuration(url);
          if (seconds == null || seconds > STORY_MAX_SECONDS + 0.5) {
            URL.revokeObjectURL(url);
            return toast(seconds == null ? 'Could not read the video length. Stories are 60 seconds or less.'
              : `That video is ${Math.round(seconds)} seconds. Stories are ${STORY_MAX_SECONDS} seconds or less.`, { error: true });
          }
        }
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        file = picked; previewUrl = url;
        pick.textContent = 'Choose another file';
        paint();
      }
      pick.addEventListener('click', choose);
      textInput.addEventListener('input', paint);

      const form = h('form.story-composer', { onsubmit: async e => {
        e.preventDefault();
        if (share.disabled) return;
        share.disabled = true;
        share.textContent = 'Uploading';
        progress.hidden = false;
        try {
          const text = textInput.value.trim();
          const upload = mode === 'text' ? await renderTextStory(text, background) : file;
          const media = await uploadFile(upload, {
            alt: mode === 'text' ? text : caption.value.trim(),
            maxEdge: 1920,
            onProgress: p => { progress.firstChild.style.width = `${Math.round(p * 100)}%`; },
          });
          const { story } = await api.post('stories', {
            media_id: media.id,
            caption: mode === 'text' ? '' : caption.value.trim(),
            background: mode === 'text' ? background : undefined,
          });
          created = story;
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          toast('Story shared.');
          changed();
          close(true);
        } catch (err) {
          toastError(err);
          share.disabled = false;
          share.textContent = 'Share story';
          progress.hidden = true;
        }
      } },
        tabsEl,
        h('div.story-composer-grid',
          preview,
          h('div.stack',
            mediaFields,
            textFields,
            progress,
            h('p.fine', 'Stories are visible for 24 hours.'),
            h('div.row', share, h('button.btn-small', { type: 'button', onclick: () => close(null) }, 'Cancel')))));
      paint();
      return form;
    },
  }).then(() => created);
}
