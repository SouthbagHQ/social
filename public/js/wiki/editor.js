// /wiki/:space/:page/edit: textarea editor with formatting buttons, image upload, preview,
// edit summary and "Publish changes". Saves with base_revision_id; a 409 shows the newer text.

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { navigate } from '../router.js';
import { login } from '../store.js';
import { loading, tabs, toast, toastError } from '../ui.js';
import { pickFiles, uploadFile } from '../upload.js';
import { MAIN, ago, canEdit, forgetSpace, pageApi, pagePath, pageTabs, pageTitle, spacePath, userLink, wikiFrame } from './common.js';
import { linkSlugs, render, titleOf } from './markup.js';

const HELP = "== Heading ==   '''bold'''   ''italic''   [[Page]] or [[Page|label]]   [https://example.com label]   * list   # numbered list";

/** Wraps the selection in `before`/`after`, or inserts them around `placeholder` (selected). */
function wrap(textarea, before, after, placeholder) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const inner = value.slice(start, end) || placeholder;
  textarea.setRangeText(before + inner + after, start, end, 'end');
  textarea.setSelectionRange(start + before.length, start + before.length + inner.length);
  textarea.focus();
  textarea.dispatchEvent(new Event('input'));
}

/** Inserts a block on its own line at the cursor. */
function insertBlock(textarea, text, selectFrom = 0, selectLength = 0) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const pre = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
  const post = value[end] && value[end] !== '\n' ? '\n' : '';
  textarea.setRangeText(pre + text + post, start, end, 'end');
  const at = start + pre.length + selectFrom;
  textarea.setSelectionRange(at, at + selectLength);
  textarea.focus();
  textarea.dispatchEvent(new Event('input'));
}

export function editorView(ctx, spaceSlug, slug) {
  return wikiFrame(ctx, spaceSlug, async (main, { space, viewer }) => {
    const title = titleOf(slug);
    if (!ctx.me) {
      ctx.title(`Edit ${title}`);
      return mount(main, pageTitle(title, 'Log in to edit.'), h('button.btn', { type: 'button', onclick: () => login() }, 'Log in'));
    }
    let data = null;
    try {
      data = await api.get(pageApi(spaceSlug, slug), { redirect: 'no' }, { signal: ctx.signal });
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const page = data?.page ?? null;
    const exists = Boolean(page);
    const realTitle = page?.title ?? title;
    const realSlug = page?.slug ?? slug;
    const editable = canEdit(viewer, page);
    ctx.title(`${exists ? 'Editing' : 'Creating'} ${realTitle}`);

    const head = [
      pageTitle(exists ? `Editing ${realTitle}` : `Creating ${realTitle}`, `From ${space.title}`),
      h('div.wk-tabbar', pageTabs(space.slug, realSlug, 'edit', { canEdit: editable, exists })),
    ];
    if (!editable) {
      return mount(main, head,
        h('div.notice', page?.protected ? 'This page is protected. Only wiki admins can edit it.' : 'Only members of this wiki can edit it.'),
        exists ? h('label.field', h('span', 'Source'), h('textarea.textarea.wk-source', { readOnly: true, rows: 20, value: data.content })) : null);
    }

    let base = page?.current_revision_id ?? null;
    const textarea = h('textarea.textarea.wk-textarea', {
      name: 'content', rows: 22, spellcheck: true, value: data?.content ?? '', 'aria-label': 'Page text',
      placeholder: exists ? '' : `Write about ${realTitle}.`,
    });
    const counter = h('span.counter');
    const paintCount = () => {
      counter.textContent = `${textarea.value.length.toLocaleString('en-AU')} of 100,000 characters`;
      counter.classList.toggle('over', textarea.value.length > 100000);
    };
    textarea.addEventListener('input', paintCount);
    paintCount();
    let dirty = false;
    textarea.addEventListener('input', () => { dirty = true; });
    const beforeUnload = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    ctx.cleanup(() => window.removeEventListener('beforeunload', beforeUnload));

    const uploadStatus = h('span.fine.wk-upload-status', { 'aria-live': 'polite' });
    const insertImage = async () => {
      const [file] = await pickFiles({ accept: 'image/*' });
      if (!file) return;
      uploadStatus.textContent = 'Uploading';
      try {
        const media = await uploadFile(file, { onProgress: p => { uploadStatus.textContent = `Uploading ${Math.round(p * 100)}%`; } });
        uploadStatus.textContent = '';
        const text = `[[File:${media.id}|Caption]]`;
        insertBlock(textarea, text, text.length - 9, 7);
        toast('Image added.');
      } catch (err) {
        uploadStatus.textContent = '';
        toastError(err);
      }
    };
    const tool = (label, fn) => h('button.btn-small', { type: 'button', onclick: fn }, label);
    const toolbar = h('div.wk-toolbar', { role: 'toolbar', 'aria-label': 'Formatting' },
      tool('Bold', () => wrap(textarea, "'''", "'''", 'bold text')),
      tool('Italic', () => wrap(textarea, "''", "''", 'italic text')),
      tool('Link', () => wrap(textarea, '[[', ']]', 'Page title')),
      tool('Heading', () => insertBlock(textarea, '== Heading ==', 3, 7)),
      tool('Insert image', insertImage),
      uploadStatus);

    const preview = h('div.wk-preview.south-card.flat', { hidden: true });
    const writeArea = h('div.wk-write', toolbar, textarea, h('p.fine.wk-help', HELP), counter);
    let mode = 'write';
    const modeTabs = h('div');
    const paintTabs = () => mount(modeTabs, tabs([
      { label: 'Write', selected: mode === 'write', onClick: () => setMode('write') },
      { label: 'Preview', selected: mode === 'preview', onClick: () => setMode('preview') },
    ]));
    async function setMode(next) {
      mode = next;
      paintTabs();
      writeArea.hidden = mode !== 'write';
      preview.hidden = mode !== 'preview';
      if (mode !== 'preview') return textarea.focus();
      mount(preview, loading('Loading preview'));
      let missing = [];
      try {
        const slugs = linkSlugs(textarea.value);
        if (slugs.length) missing = (await api.post(`wiki/${encodeURIComponent(space.slug)}/resolve`, { slugs })).missing;
      } catch { /* show links as existing */ }
      mount(preview, textarea.value.trim()
        ? render(textarea.value, { space: space.slug, missing })
        : h('p.muted', 'Nothing to preview.'));
    }
    paintTabs();

    const summary = h('input.input', { name: 'summary', maxLength: 200, placeholder: 'Briefly describe your changes', autocomplete: 'off' });
    const publish = h('button.btn-large', { type: 'submit' }, 'Publish changes');
    const conflictBox = h('div');
    const form = h('form.wk-editor', { onsubmit: async e => {
      e.preventDefault();
      if (!textarea.value.trim()) return toast('Write something first.', { error: true });
      if (textarea.value.length > 100000) return toast('Pages are limited to 100,000 characters.', { error: true });
      publish.disabled = true;
      try {
        const res = await api.put(pageApi(space.slug, realSlug), { content: textarea.value, summary: summary.value.trim(), base_revision_id: base });
        dirty = false;
        forgetSpace(space.slug);
        toast(exists ? 'Saved.' : 'Page created.');
        navigate(res.page.slug.toLowerCase() === MAIN.toLowerCase() ? spacePath(space.slug) : pagePath(space.slug, res.page.slug));
      } catch (err) {
        publish.disabled = false;
        if (err.status === 409) return showConflict(err);
        toastError(err);
      }
    } },
      modeTabs, writeArea, preview, conflictBox,
      h('label.field.wk-summary', h('span', 'Edit summary'), summary),
      h('div.row.wrap.wk-publish', publish,
        h('a', { href: exists ? (realSlug.toLowerCase() === MAIN.toLowerCase() ? spacePath(space.slug) : pagePath(space.slug, realSlug)) : spacePath(space.slug) }, 'Cancel')));

    // The 409 from the API carries no body here (ApiError keeps only the message), so fetch the latest.
    async function showConflict(err) {
      toastError(err);
      let latest = null;
      try { latest = await api.get(pageApi(space.slug, realSlug), { redirect: 'no' }); } catch { /* keep going */ }
      if (latest) base = latest.page.current_revision_id;
      mount(conflictBox, h('div.notice.wk-conflict',
        h('p', h('b', err.message)),
        latest ? [
          h('p.fine', 'Latest version by ', userLink(latest.revision.author), `, ${ago(latest.revision.created_at)}. `,
            latest.revision.summary ? `Summary: ${latest.revision.summary}` : null),
          h('label.field', h('span', 'Latest version'), h('textarea.textarea.wk-source', { readOnly: true, rows: 10, value: latest.content })),
          h('p.fine', 'Your text is still in the editor above. Publishing again replaces the latest version with it.'),
          h('div.row.wrap',
            h('button.btn-small', { type: 'button', onclick: () => { textarea.value = latest.content; dirty = true; paintCount(); mount(conflictBox); } }, 'Use the latest version'),
            h('a', { href: pagePath(space.slug, realSlug, 'history'), target: '_blank', rel: 'noopener' }, 'Open history')),
        ] : null));
      conflictBox.scrollIntoView({ block: 'center' });
    }

    mount(main, head,
      exists ? null : h('p.fine.wk-new-note', 'This page does not exist yet. Write it below.'),
      form);
    textarea.setSelectionRange(0, 0);
    textarea.focus();
    textarea.scrollTop = 0;
  });
}
