// /upload?type=video|short|photo — Southbag Studio.
// Video and Short share one upload (switching tabs keeps the file); Photo post has its own list.
// Files upload as soon as they are picked (public/js/upload.js → /api/media in 1.5 MiB chunks),
// then Publish calls POST /api/posts { kind, title, body, media_ids, visibility }.
// Also home to the "Go live" gauntlet: ten dialogues, then a branch referral.

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { bytes, duration as fmtDuration } from '../format.js';
import { navigate } from '../router.js';
import { dialog, shake, toast, toastError } from '../ui.js';
import { LIMITS, kindOf, pickFiles, uploadFile, videoMeta } from '../upload.js';
import { celebrateFirstPost } from '../components/post.js';

const TYPES = [
  { key: 'video', label: 'Video', icon: 'video' },
  { key: 'short', label: 'Short', icon: 'shorts' },
  { key: 'photo', label: 'Photo post', icon: 'image' },
];
const MAX_PHOTOS = 10;
const SHORT_MAX = 180;
const RETENTION = 'Uploads are retained permanently. Deletion is advisory.';

export default async function upload(ctx) {
  ctx.layout('wide');
  ctx.title('Southbag Studio');
  if (!ctx.requireAuth()) return null;

  let type = TYPES.some(t => t.key === ctx.query.get('type')) ? ctx.query.get('type') : 'video';
  const cleanups = [];
  ctx.cleanup(() => cleanups.forEach(fn => fn()));

  const tabBar = h('nav.tabs.studio-tabs', { role: 'tablist' });
  const videoPanel = videoStudio(() => type, setType, cleanups);
  const photoPanel = photoStudio(cleanups);
  const paintTabs = () => {
    mount(tabBar, TYPES.map(t => h('button', {
      type: 'button', role: 'tab', 'aria-selected': t.key === type ? 'true' : 'false', onclick: () => setType(t.key),
    }, icon(t.icon), ' ', t.label)));
    videoPanel.el.classList.toggle('hidden', type === 'photo');
    photoPanel.el.classList.toggle('hidden', type !== 'photo');
    videoPanel.refresh();
  };
  function setType(next) {
    if (next === type) return;
    type = next;
    history.replaceState({}, '', `/upload?type=${next}`);
    paintTabs();
  }
  paintTabs();

  return h('div.studio',
    h('div.page-head',
      h('div', h('p.eyebrow', 'SB-DIG-009 · STUDIO'), h('h1', 'Southbag Studio')),
      h('span.spacer'),
      h('button.btn.studio-live', { type: 'button', onclick: goLive }, icon('radio'), 'Go live')),
    h('p.fine', RETENTION, ' Continued uploading constitutes acceptance.'),
    tabBar,
    videoPanel.el,
    photoPanel.el);
}

// ── Video and Short ──────────────────────────────────────────────────────

function videoStudio(getType, setType, cleanups) {
  const s = { file: null, preview: null, meta: null, media: null, error: null, controller: null, progress: 0, publishing: false };

  const input = h('input', { type: 'file', accept: 'video/mp4,video/webm,video/quicktime,video/*', hidden: true, onchange: () => { if (input.files[0]) choose(input.files[0]); input.value = ''; } });
  const drop = dropzone({
    title: () => (getType() === 'short' ? 'Drag a vertical video here' : 'Drag a video here'),
    detail: () => `MP4, WebM or MOV, up to ${LIMITS.video / 1048576} MB.${getType() === 'short' ? ' Vertical, three minutes or less.' : ''} Kevin measured.`,
    button: 'Select file',
    onPick: () => input.click(),
    onFiles: files => { const f = files.find(x => kindOf(x) === 'video'); if (f) choose(f); else toast('That is not a video. Kevin checked.', { error: true }); },
  });

  // Upload status
  const bar = h('div');
  const statusText = h('div.studio-status-text');
  const cancelBtn = h('button.btn-small.outline', { type: 'button', onclick: () => reset(true) }, 'Discard');
  const status = h('div.studio-status.south-card.flat.hidden',
    h('div.row', icon('upload'), h('strong.studio-filename.grow'), cancelBtn),
    h('div.progress-bar.studio-progress', bar),
    statusText);

  // Preview + poster
  const previewHost = h('div.studio-preview-video');
  const posterHost = h('div.studio-poster', h('span.muted', 'No poster yet.'));
  const checks = h('div.studio-checks');
  const preview = h('div.studio-side.hidden',
    h('h3', 'Preview'), previewHost,
    h('h3', 'Poster'), h('p.fine', 'Generated automatically from about a third of the way in. Southbag chose the frame. You may not.'), posterHost,
    checks);

  // Fields
  const title = h('input.input', { maxLength: 120, placeholder: 'Add a title that describes your video', 'aria-required': 'true' });
  const titleCount = h('span.counter');
  const titleField = h('label.field', h('span', 'Title (required)'), title, titleCount);
  const desc = h('textarea.textarea.boxed', { rows: 5, maxLength: 2200 });
  const descCount = h('span.counter');
  const descLabel = h('span', 'Description');
  const visibility = visibilitySelect();
  const publish = h('button.btn-large', { type: 'submit' }, 'Publish');
  const form = h('form.studio-form.hidden', { onsubmit: e => { e.preventDefault(); submit(); } },
    titleField,
    h('label.field', descLabel, desc, descCount),
    h('label.field', h('span', 'Visibility'), visibility),
    h('div.row.wrap', publish, h('span.fine', RETENTION)));
  title.addEventListener('input', refresh);
  desc.addEventListener('input', refresh);

  const el = h('section.studio-panel', input, drop, h('div.studio-grid', h('div.studio-main', status, form), preview));

  cleanups.push(() => reset(!s.publishing, { quiet: true }));

  async function choose(file) {
    if (s.file) reset(true, { quiet: true });
    if (file.size > LIMITS.video) {
      toast(`That video is ${bytes(file.size)}. The limit is ${LIMITS.video / 1048576} MB. Kevin measured.`, { error: true });
      shake(drop);
      return;
    }
    s.file = file;
    s.preview = URL.createObjectURL(file);
    s.controller = new AbortController();
    s.progress = 0;
    s.error = null;
    s.media = null;
    if (!title.value) title.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 120);
    el.querySelector('.studio-filename').textContent = file.name;
    mount(previewHost, h('video', { src: s.preview, controls: true, muted: true, playsInline: true, preload: 'metadata' }));
    mount(posterHost, h('div.loading', h('div.spinner'), 'Generating poster...'));
    refresh();

    const controller = s.controller;
    videoMeta(file).then(meta => {
      if (controller !== s.controller) return;
      s.meta = meta;
      if (meta.poster) {
        const url = URL.createObjectURL(meta.poster);
        cleanups.push(() => URL.revokeObjectURL(url));
        mount(posterHost, h('img', { src: url, alt: 'Auto-generated poster' }));
      } else mount(posterHost, h('span.muted', 'Southbag could not generate a poster. The first frame will do.'));
      // Suggest the right tab.
      if (isShortShaped(meta) && getType() === 'video') {
        toast('This looks like a short. Vertical and brief. Consider the Short tab.', { timeout: 5000 });
      }
      refresh();
    });

    try {
      const media = await uploadFile(file, {
        signal: controller.signal,
        onProgress: p => { if (controller === s.controller) { s.progress = p; refresh(); } },
      });
      if (controller !== s.controller) { api.del(`media/${media.id}`).catch(() => {}); return; }
      s.media = media;
      s.progress = 1;
      if (media.poster_url) mount(posterHost, h('img', { src: media.poster_url, alt: 'Auto-generated poster' }));
      if (!s.meta) s.meta = { width: media.width, height: media.height, duration: media.duration };
    } catch (err) {
      if (err.name === 'AbortError' || controller !== s.controller) return;
      s.error = `Upload failed. The video is still retained. (${err.message})`;
      toast(s.error, { error: true });
    }
    refresh();
  }

  function reset(deleteUploaded, { quiet = false } = {}) {
    s.controller?.abort();
    if (deleteUploaded && s.media) api.del(`media/${s.media.id}`).catch(() => {});
    if (s.preview) URL.revokeObjectURL(s.preview);
    Object.assign(s, { file: null, preview: null, meta: null, media: null, error: null, controller: null, progress: 0 });
    previewHost.querySelector('video')?.removeAttribute('src');
    mount(previewHost);
    mount(posterHost, h('span.muted', 'No poster yet.'));
    if (!quiet) { title.value = ''; desc.value = ''; toast('Discarded. A copy may have been retained.'); }
    refresh();
  }

  function refresh() {
    const t = getType();
    drop.refresh();
    const has = Boolean(s.file);
    drop.classList.toggle('hidden', has);
    status.classList.toggle('hidden', !has);
    form.classList.toggle('hidden', !has);
    preview.classList.toggle('hidden', !has);
    titleField.classList.toggle('hidden', t === 'short');
    descLabel.textContent = t === 'short' ? 'Caption' : 'Description';
    desc.placeholder = t === 'short' ? 'Describe your short. #tags work. Kevin reads them.' : 'Tell viewers about your video. Kevin will read it first.';
    titleCount.textContent = title.value ? String(120 - [...title.value].length) : '';
    descCount.textContent = desc.value ? String(2200 - [...desc.value].length) : '';

    if (has) {
      const total = s.file.size;
      const done = Math.round(total * s.progress);
      bar.style.width = `${Math.round(s.progress * 100)}%`;
      status.classList.toggle('failed', Boolean(s.error));
      statusText.textContent = s.error
        ? s.error
        : s.media
          ? `Upload complete. ${bytes(total)} stored in D1, in ${Math.ceil(total / (1536 * 1024))} chunk${total > 1536 * 1024 ? 's' : ''}. Processing is not required. Kevin watched it already.`
          : `Uploading ${bytes(done)} of ${bytes(total)} · ${Math.round(s.progress * 100)}%`;
    }

    // Checks and warnings
    const m = s.meta;
    const notes = [];
    if (m?.width && m?.height) notes.push(h('li', `${m.width} × ${m.height}${m.duration ? ` · ${fmtDuration(m.duration)}` : ''}`));
    if (t === 'short' && m) {
      if (m.width && m.height && m.width >= m.height) notes.push(h('li.warn', 'This video is not vertical. It will be published as a short anyway, sideways in spirit. ',
        h('button.btn-small.flat', { type: 'button', onclick: () => setType('video') }, 'Publish as a video instead')));
      if (m.duration > SHORT_MAX) notes.push(h('li.warn', `Shorts are three minutes or less. This one is ${fmtDuration(m.duration)}. Kevin has noticed. `,
        h('button.btn-small.flat', { type: 'button', onclick: () => setType('video') }, 'Publish as a video instead')));
    }
    if (t === 'video' && isShortShaped(m)) notes.push(h('li', 'This looks like a short. ',
      h('button.btn-small.flat', { type: 'button', onclick: () => setType('short') }, 'Publish as a short')));
    mount(checks, notes.length ? h('ul.studio-notes', notes) : null);

    const needTitle = t === 'video' && !title.value.trim();
    publish.disabled = !s.media || needTitle || s.publishing;
    publish.textContent = s.publishing ? 'Publishing…' : !has ? 'Publish' : s.error ? 'Upload failed'
      : !s.media ? `Uploading… ${Math.round(s.progress * 100)}%` : needTitle ? 'Title required' : t === 'short' ? 'Publish short' : 'Publish video';
  }

  async function submit() {
    const t = getType();
    if (publish.disabled) return;
    if (t === 'video' && !title.value.trim()) { toast('Videos need a title. Kevin insists.', { error: true }); shake(title); return; }
    s.publishing = true;
    refresh();
    try {
      const { post } = await api.post('posts', {
        kind: t, title: t === 'video' ? title.value.trim() : undefined, body: desc.value, media_ids: [s.media.id], visibility: visibility.value,
      });
      s.media = null; // published: nothing to clean up
      celebrateFirstPost();
      toast('Published. Pending review.');
      navigate(t === 'short' ? `/shorts/${post.id}` : `/watch/${post.id}`);
    } catch (err) {
      shake(form);
      toastError(err);
    }
    s.publishing = false;
    refresh();
  }

  refresh();
  return { el, refresh };
}

const isShortShaped = m => Boolean(m?.width && m?.height && m.height > m.width && (m.duration || 0) <= SHORT_MAX);

// ── Photo post ───────────────────────────────────────────────────────────

function photoStudio(cleanups) {
  /** @type {{ file: File, preview: string, media: object|null, error: string|null, progress: number, controller: AbortController }[]} */
  const items = [];
  let publishing = false;

  const drop = dropzone({
    title: () => 'Drag photos here',
    detail: () => `Up to ${MAX_PHOTOS} photos. JPEG, PNG, WebP or GIF. Large photos are shrunk before upload, like everything else here.`,
    button: 'Select photos',
    onPick: async () => add(await pickFiles({ accept: 'image/*', multiple: true })),
    onFiles: add,
  });
  const list = h('ol.studio-photos');
  const addMore = h('button.btn-small.outline', { type: 'button', onclick: async () => add(await pickFiles({ accept: 'image/*', multiple: true })) }, icon('plus'), 'Add photos');
  const counter = h('span.fine');
  const caption = h('textarea.textarea.boxed', { rows: 4, maxLength: 2200, placeholder: 'Write a caption. #tags work. Kevin reads them.' });
  const visibility = visibilitySelect();
  const publish = h('button.btn-large', { type: 'submit' }, 'Share');
  const form = h('form.studio-form.hidden', { onsubmit: e => { e.preventDefault(); submit(); } },
    h('div.row.wrap', addMore, counter),
    list,
    h('label.field', h('span', 'Caption'), caption),
    h('label.field', h('span', 'Visibility'), visibility),
    h('div.row.wrap', publish, h('span.fine', RETENTION)));
  const el = h('section.studio-panel', drop, form);

  cleanups.push(() => {
    for (const it of items) {
      it.controller.abort();
      if (it.media && !publishing) api.del(`media/${it.media.id}`).catch(() => {});
      URL.revokeObjectURL(it.preview);
    }
  });

  function add(files) {
    const images = files.filter(f => kindOf(f) === 'image');
    if (files.length && !images.length) toast('Photos only here. Videos go in the other tabs.', { error: true });
    for (const file of images) {
      if (items.length >= MAX_PHOTOS) { toast(`${MAX_PHOTOS} photos per post. Kevin counted.`, { error: true }); break; }
      const it = { file, preview: URL.createObjectURL(file), media: null, error: null, progress: 0, controller: new AbortController() };
      items.push(it);
      uploadFile(file, { signal: it.controller.signal, onProgress: p => { it.progress = p; paintProgress(it); } })
        .then(media => { it.media = media; it.progress = 1; })
        .catch(err => { if (err.name !== 'AbortError') { it.error = err.message; toast(`Upload failed. ${err.message}`, { error: true }); } })
        .finally(paint);
    }
    paint();
  }

  function move(it, dir) {
    const i = items.indexOf(it), j = i + dir;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    paint();
  }

  function remove(it) {
    it.controller.abort();
    if (it.media) api.del(`media/${it.media.id}`).catch(() => {});
    URL.revokeObjectURL(it.preview);
    items.splice(items.indexOf(it), 1);
    paint();
  }

  function paintProgress(it) {
    const fill = it.el?.querySelector('.progress-bar > div');
    if (fill) fill.style.width = `${Math.round(it.progress * 100)}%`;
  }

  function paint() {
    drop.classList.toggle('hidden', items.length > 0);
    form.classList.toggle('hidden', items.length === 0);
    addMore.disabled = items.length >= MAX_PHOTOS;
    counter.textContent = `${items.length} of ${MAX_PHOTOS} photos${items.length > 1 ? ' · the first one is the cover' : ''}`;
    mount(list, items.map((it, i) => {
      it.el = h('li.studio-photo', { class: { error: Boolean(it.error) }, title: it.error || it.file.name },
        h('img', { src: it.preview, alt: `Photo ${i + 1}` }),
        h('span.studio-photo-n', String(i + 1)),
        !it.media && !it.error ? h('div.progress-bar', h('div', { style: `width:${Math.round(it.progress * 100)}%` })) : null,
        it.error ? h('span.studio-photo-err', 'Failed') : null,
        h('div.studio-photo-tools',
          h('button.icon-btn', { type: 'button', 'aria-label': `Move photo ${i + 1} left`, disabled: i === 0, onclick: () => move(it, -1) }, icon('chevron-left')),
          h('button.icon-btn', { type: 'button', 'aria-label': `Remove photo ${i + 1}`, onclick: () => remove(it) }, icon('close')),
          h('button.icon-btn', { type: 'button', 'aria-label': `Move photo ${i + 1} right`, disabled: i === items.length - 1, onclick: () => move(it, 1) }, icon('chevron-right'))));
      return it.el;
    }));
    const uploading = items.some(it => !it.media && !it.error);
    const failed = items.some(it => it.error);
    publish.disabled = publishing || uploading || failed || !items.length;
    publish.textContent = publishing ? 'Sharing…' : uploading ? 'Uploading…' : failed ? 'Remove failed uploads' : 'Share';
  }

  async function submit() {
    if (publish.disabled) return;
    publishing = true;
    paint();
    try {
      const { post } = await api.post('posts', {
        kind: 'photo', body: caption.value, media_ids: items.map(it => it.media.id), visibility: visibility.value,
      });
      items.forEach(it => { it.media = null; });
      celebrateFirstPost();
      toast('Shared. Pending review.');
      navigate(`/post/${post.id}`);
    } catch (err) {
      publishing = false;
      shake(form);
      toastError(err);
      paint();
    }
  }

  paint();
  return { el };
}

// ── Shared bits ──────────────────────────────────────────────────────────

function visibilitySelect() {
  return h('select.select.boxed',
    h('option', { value: 'public' }, 'Everyone (and Kevin)'),
    h('option', { value: 'followers' }, 'The Pile (followers)'),
    h('option', { value: 'friends' }, 'Friends'));
}

/** A dashed drag-and-drop zone. title/detail are functions so they can follow the tab. */
function dropzone({ title, detail, button, onPick, onFiles }) {
  const titleEl = h('strong.studio-drop-title');
  const detailEl = h('span.fine');
  const zone = h('div.studio-drop', { tabIndex: 0, role: 'button', onclick: e => { if (!e.target.closest('button')) onPick(); } },
    icon('upload'),
    titleEl,
    h('span.muted', 'or'),
    h('button.btn', { type: 'button', onclick: onPick }, button),
    detailEl);
  zone.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === zone) { e.preventDefault(); onPick(); } });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); onFiles([...e.dataTransfer.files]); });
  zone.refresh = () => { titleEl.textContent = title(); detailEl.textContent = detail(); };
  zone.refresh();
  return zone;
}

// ── Go live: the ten-dialogue gauntlet ───────────────────────────────────

const GAUNTLET = [
  ['Before continuing, Southbag requires ten dialogues. This makes the stream safer by making the streamer tired.', 'Continue'],
  ['You are about to go live. So is Kevin.', 'Yes'],
  ['Live streams are recorded and retained per SB-NET-2022. The recording will outlive the stream.', 'I understand'],
  ['Please confirm you are not broadcasting from Canberra. That area is Reserved.', 'I am not in Canberra'],
  ['Please confirm nothing in frame refers to 2019. There was no 2019 incident.', 'Nothing refers to 2019'],
  ['Please confirm no Blahaj is visible. This content is prohibited. (We love it.)', 'No Blahaj is visible'],
  ['Your device is untrusted. So is your lighting.', 'Proceed regardless'],
  ['Viewers may comment. Comments may be read aloud on Floor 3. Southbag has no Floor 3.', 'Acknowledged'],
  ['A broadcast fee applies. Fee assessed: $7.00 — Kevin’s time.', 'Accept the fee'],
  ['This is the tenth dialogue. Kevin has reviewed your stream in advance. You may now go live.', 'Go live'],
];

async function goLive() {
  for (let i = 0; i < GAUNTLET.length; i++) {
    const [text, ok] = GAUNTLET[i];
    const go = await dialog({
      title: `Southbag Untrusted Broadcast Warning (${i + 1} of ${GAUNTLET.length})`,
      body: h('div', h('p', { style: 'margin-top:0' }, text),
        i > 3 ? h('p.fine', `Dialogues remaining: ${GAUNTLET.length - i - 1}. You are doing well. Kevin is not.`) : null),
      actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: true }],
    });
    if (!go) {
      toast(`Broadcast cancelled at dialogue ${i + 1} of ${GAUNTLET.length}. Your hesitation has been logged.`);
      return;
    }
  }
  await dialog({
    title: 'Southbag Alert',
    body: h('div', h('p', { style: 'margin-top:0' }, h('strong', 'Broadcast unavailable. Please visit a branch.')),
      h('p.fine', 'Live streaming requires an in-person identity check. Branches do not exist. This is being reviewed.')),
    actions: [{ label: 'OK', value: false, primary: true }, { label: 'Find a branch', value: true }],
  }).then(v => { if (v) window.open('https://branch-locator.southbag.cc', '_blank', 'noopener'); });
}
