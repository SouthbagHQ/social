// Stories (Instagram): the row of story rings above the feed, and the story composer.
//
//   storiesBar()          → Node, returned at once and filled in when GET /api/stories answers.
//                           Hides itself when signed out and nobody has a story.
//   openStoryComposer()   → opens the "New story" dialog (photo, short video, or text on a background).
//   STORY_BACKGROUNDS     presets for text stories (the server keeps the key in stories.background).
//   storyBackground(key)  → CSS background for a preset key (or null).
//
// Anything that changes stories dispatches `stories:changed` on window; mounted bars reload.

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { dialog, shake, toast, toastError } from '../ui.js';
import { kindOf, pickFiles, uploadFile } from '../upload.js';
import { avatar } from './user.js';

export const STORY_MAX_SECONDS = 60;
const CAPTION_LIMIT = 200;
const TEXT_LIMIT = 180;

export const STORY_BACKGROUNDS = {
  teal: { label: 'Teal', stops: ['#26a69a', '#00695c'], ink: '#ffffff' },
  logo: { label: 'Southbag', stops: ['#6286e7', '#3b87c6', '#058998'], ink: '#ffffff' },
  promo: { label: 'Promotional', stops: ['#fffa63', '#ffc400'], ink: '#111111' },
  night: { label: 'After hours', stops: ['#0b1020', '#263238'], ink: '#ffffff' },
  paper: { label: 'Paper', stops: ['#fffffa', '#ece9d8'], ink: '#222222' },
  alert: { label: 'Alert', stops: ['#cc0000', '#5a0000'], ink: '#ffffff' },
  floor3: { label: 'Floor 3', stops: ['#000080', '#000000'], ink: '#ffffff' },
};

export const storyBackground = key => {
  const bg = STORY_BACKGROUNDS[key];
  return bg ? `linear-gradient(160deg, ${bg.stops.join(', ')})` : null;
};

const changed = () => window.dispatchEvent(new CustomEvent('stories:changed'));

/** Remember where the viewer was opened from, so closing it goes back there. */
export const markStoryOrigin = () => { try { sessionStorage.setItem('sb_story_from', location.pathname + location.search); } catch {} };

// ── The tray ────────────────────────────────────────────────────────────

export function storiesBar() {
  const track = h('div.stories-track', { role: 'list' }, Array.from({ length: 5 }, () =>
    h('div.story-bubble.skeleton', { role: 'listitem', 'aria-hidden': 'true' }, h('span.ring'), h('span.label'))));
  const root = h('section.stories-bar', { 'aria-label': 'Stories' }, track,
    h('button.stories-scroll.left', { type: 'button', 'aria-label': 'Scroll stories left', onclick: () => track.scrollBy({ left: -track.clientWidth * 0.8, behavior: 'smooth' }) }, icon('chevron-left')),
    h('button.stories-scroll.right', { type: 'button', 'aria-label': 'Scroll stories right', onclick: () => track.scrollBy({ left: track.clientWidth * 0.8, behavior: 'smooth' }) }, icon('chevron-right')));

  const paintScroll = () => {
    root.classList.toggle('can-left', track.scrollLeft > 4);
    root.classList.toggle('can-right', track.scrollLeft + track.clientWidth < track.scrollWidth - 4);
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
      me ? yourBubble(me, mine) : null,
      others.map(item => bubble(item)),
      !others.length && me ? h('div.stories-empty', { role: 'listitem' },
        h('p', 'No stories from The Pile.'), h('p.fine', 'Kevin watched them all already.')) : null);
    requestAnimationFrame(paintScroll);
  }

  const onChanged = () => { if (!root.isConnected) return window.removeEventListener('stories:changed', onChanged); load(); };
  window.addEventListener('stories:changed', onChanged);
  load();
  return root;
}

function yourBubble(me, mine) {
  const open = () => {
    if (mine) { markStoryOrigin(); navigate(`/stories/${me.handle}`); } else openStoryComposer();
  };
  return h('div.story-bubble.yours', { role: 'listitem' },
    h('button.story-open', { type: 'button', onclick: open, 'aria-label': mine ? 'Watch your story' : 'Add to your story' },
      h('span.ring', { class: { live: Boolean(mine), seen: Boolean(mine) } }, avatar(me, { round: true, link: false }))),
    h('button.story-add', { type: 'button', 'aria-label': 'Add to your story', title: 'Add to your story', onclick: e => { e.stopPropagation(); openStoryComposer(); } }, icon('plus')),
    h('span.label', 'Your story'));
}

function bubble(item) {
  const { user, seen } = item;
  return h('div.story-bubble', { role: 'listitem', class: { seen } },
    h('a.story-open', {
      href: `/stories/${user.handle}`,
      onclick: markStoryOrigin,
      'aria-label': `${user.name}’s story, ${item.stories_count} ${item.stories_count === 1 ? 'item' : 'items'}${seen ? ', seen' : ''}`,
    },
      h('span.ring', { class: { live: true, seen } }, avatar(user, { round: true, link: false }))),
    h('span.label', user.handle === 'kevin' ? 'Kevin' : user.name.split(' ')[0] || user.handle));
}

// ── Composer ────────────────────────────────────────────────────────────

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

/** Draws a text story (1080×1920) and resolves to a JPEG File. */
async function renderTextStory(text, key) {
  const bg = STORY_BACKGROUNDS[key] || STORY_BACKGROUNDS.teal;
  const canvas = document.createElement('canvas');
  canvas.width = 1080; canvas.height = 1920;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 1080 * 0.6, 1920);
  bg.stops.forEach((c, i) => grad.addColorStop(i / Math.max(1, bg.stops.length - 1), c));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 1920);
  try { await document.fonts?.load('700 80px Lato'); } catch {}
  let size = text.length > 120 ? 64 : text.length > 60 ? 76 : 92;
  ctx.font = `700 ${size}px Lato, 'Helvetica Neue', Arial, sans-serif`;
  let lines = wrap(ctx, text, 900);
  while (lines.length * size * 1.25 > 1400 && size > 40) {
    size -= 6;
    ctx.font = `700 ${size}px Lato, 'Helvetica Neue', Arial, sans-serif`;
    lines = wrap(ctx, text, 900);
  }
  ctx.fillStyle = bg.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = bg.ink === '#ffffff' ? 'rgba(0,0,0,.35)' : 'rgba(255,255,255,.4)';
  ctx.shadowBlur = 6; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;
  const top = 960 - ((lines.length - 1) * size * 1.25) / 2;
  lines.forEach((line, i) => ctx.fillText(line, 540, top + i * size * 1.25));
  ctx.shadowColor = 'transparent';
  ctx.font = "500 26px ui-monospace, Menlo, Consolas, monospace";
  ctx.globalAlpha = 0.6;
  ctx.fillText('S O U T H B A G   S O C I A L  ·  R E T A I N E D', 540, 1840);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
  return new File([blob], 'story.jpg', { type: 'image/jpeg' });
}

/** Opens the "New story" dialog. Resolves with the created story, or null. */
export function openStoryComposer() {
  if (!store.me) { login(); return Promise.resolve(null); }
  let created = null;
  return dialog({
    title: 'New story',
    actions: [],
    body: close => {
      let mode = 'media';
      let file = null, previewUrl = null, background = 'teal';
      const preview = h('div.story-preview');
      const caption = h('input.input.boxed', { placeholder: 'Add a caption (optional). Kevin reads captions.', maxLength: CAPTION_LIMIT });
      const textInput = h('textarea.textarea.boxed', { rows: 3, maxLength: TEXT_LIMIT, placeholder: 'Type something. It will be large.' });
      const progress = h('div.progress-bar', { hidden: true }, h('div'));
      const share = h('button.btn', { type: 'submit', disabled: true }, 'Share to story');
      const pick = h('button.btn-small.outline', { type: 'button' }, icon('image'), 'Choose a photo or video');
      const swatches = h('div.story-swatches', { role: 'radiogroup', 'aria-label': 'Background' },
        Object.entries(STORY_BACKGROUNDS).map(([key, bg]) => h('button.swatch', {
          type: 'button', role: 'radio', title: bg.label, 'aria-label': bg.label, 'aria-checked': key === background ? 'true' : 'false',
          dataset: { key }, style: { background: storyBackground(key) },
          onclick: () => {
            background = key;
            for (const s of swatches.children) s.setAttribute('aria-checked', String(s.dataset.key === key));
            paint();
          },
        })));
      const tabsEl = h('div.tabs.story-mode',
        h('button', { type: 'button', 'aria-selected': 'true', onclick: () => setMode('media') }, 'Photo or video'),
        h('button', { type: 'button', 'aria-selected': 'false', onclick: () => setMode('text') }, 'Text'));
      const mediaFields = h('div.stack', pick, h('label.field', h('span', 'Caption'), caption));
      const textFields = h('div.stack', { hidden: true }, h('label.field', h('span', 'Text'), textInput), h('div', h('span.field-label', 'Background'), swatches));

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
          preview.style.background = storyBackground(background);
          mount(preview, h('div.story-preview-text', { style: { color: bg.ink } }, textInput.value.trim() || 'Your text here. Kevin is already reading it.'));
          share.disabled = !textInput.value.trim();
        } else if (file) {
          mount(preview, kindOf(file) === 'video'
            ? h('video', { src: previewUrl, muted: true, autoplay: true, loop: true, playsInline: true })
            : h('img', { src: previewUrl, alt: '' }),
          caption.value.trim() ? h('div.story-preview-caption', caption.value.trim()) : null);
          share.disabled = false;
        } else {
          mount(preview, h('button.story-preview-empty', { type: 'button', onclick: choose }, icon('camera'), h('span', 'Choose a photo or a video up to 60 seconds')));
          share.disabled = true;
        }
      }

      async function choose() {
        const [picked] = await pickFiles({ accept: 'image/*,video/*' });
        if (!picked) return;
        const kind = kindOf(picked);
        if (kind !== 'image' && kind !== 'video') return toast('Stories are photos or short videos.', { error: true });
        const url = URL.createObjectURL(picked);
        if (kind === 'video') {
          const seconds = await videoDuration(url);
          if (seconds == null || seconds > STORY_MAX_SECONDS + 0.5) {
            URL.revokeObjectURL(url);
            shake(form);
            return toast(seconds == null ? 'Kevin could not measure that video. Stories are 60 seconds or less.'
              : `That video is ${Math.round(seconds)} seconds. Stories are ${STORY_MAX_SECONDS} seconds or less. Kevin timed it.`, { error: true });
          }
        }
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        file = picked; previewUrl = url;
        pick.lastChild.textContent = 'Choose a different one';
        paint();
      }
      pick.addEventListener('click', choose);
      caption.addEventListener('input', paint);
      textInput.addEventListener('input', paint);

      const form = h('form.story-composer', { onsubmit: async e => {
        e.preventDefault();
        if (share.disabled) return;
        share.disabled = true;
        share.textContent = 'Uploading…';
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
          toast('Shared to your story. It expires in 24 hours. Retention does not.');
          changed();
          close(true);
        } catch (err) {
          shake(form);
          toastError(err);
          share.disabled = false;
          share.textContent = 'Share to story';
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
            h('p.fine', 'Stories expire in 24 hours. Retention does not.'),
            h('div.row', share, h('button.btn-small.flat', { type: 'button', onclick: () => close(null) }, 'Cancel')))));
      paint();
      return form;
    },
  }).then(() => created);
}
