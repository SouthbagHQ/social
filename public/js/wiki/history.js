// Page history, a single old revision, and the line diff between two revisions.
//   /wiki/:space/:page/history
//   /wiki/:space/:page/revision?id=
//   /wiki/:space/:page/diff?from=&to=

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { fullDate, plural } from '../format.js';
import { navigate } from '../router.js';
import { confirm, empty, infiniteList, toast, toastError } from '../ui.js';
import { ago, canEdit, dateLink, delta, forgetSpace, pageApi, pagePath, pageTabs, pageTitle, userLink, wikiFrame } from './common.js';
import { render } from './markup.js';

const revisionPath = (space, slug, id) => pagePath(space, slug, 'revision', `id=${id}`);
const diffPath = (space, slug, from, to) => pagePath(space, slug, 'diff', [from ? `from=${from}` : '', to ? `to=${to}` : ''].filter(Boolean).join('&'));

async function revert(space, page, revision) {
  const by = revision.author ? `@${revision.author.handle}` : 'a deleted account';
  if (!(await confirm(`Restore the version by ${by} from ${fullDate(revision.created_at)}? This adds a new revision.`, { title: 'Revert page', ok: 'Revert' }))) return;
  try {
    await api.post(pageApi(space.slug, page.slug, '/revert'), { revision_id: revision.id });
    forgetSpace(space.slug);
    toast('Reverted.');
    navigate(pagePath(space.slug, page.slug));
  } catch (err) { toastError(err); }
}

// ── History ─────────────────────────────────────────────────────────────

export function historyView(ctx, spaceSlug, slug) {
  return wikiFrame(ctx, spaceSlug, async (main, { space }) => {
    const first = await api.get(pageApi(spaceSlug, slug, '/history'), null, { signal: ctx.signal });
    const { page, viewer } = first;
    ctx.title(`History of ${page.title}`);
    const editable = canEdit(viewer, page);
    const selected = [];
    const compare = h('button.btn', { type: 'button', disabled: true }, 'Compare selected');
    const hint = h('span.fine', 'Select two revisions to compare.');
    const sync = () => {
      compare.disabled = selected.length !== 2;
      hint.textContent = selected.length === 2 ? '' : 'Select two revisions to compare.';
    };
    compare.addEventListener('click', () => {
      const [a, b] = [...selected].sort();
      navigate(diffPath(space.slug, page.slug, a, b));
    });

    const row = rev => {
      const box = h('input', { type: 'checkbox', 'aria-label': `Select revision from ${fullDate(rev.created_at)}`, onchange: () => {
        if (box.checked) {
          selected.push(rev.id);
          if (selected.length > 2) {
            const dropped = selected.shift();
            list.list.querySelector(`input[data-id="${dropped}"]`).checked = false;
          }
        } else selected.splice(selected.indexOf(rev.id), 1);
        sync();
      } });
      box.dataset.id = rev.id;
      const item = h('li.wk-rev', { class: { current: rev.current } },
        box,
        h('div.wk-rev-main',
          h('p.wk-rev-line',
            dateLink(rev.created_at, revisionPath(space.slug, page.slug, rev.id)), ' ',
            userLink(rev.author), ' ',
            h('span.fine', `${rev.size.toLocaleString('en-AU')} characters `), delta(rev.delta),
            rev.current ? h('span.chip', 'Current') : null),
          rev.summary ? h('p.wk-rev-summary', rev.summary) : null),
        h('div.wk-rev-actions',
          h('a.btn-small', { href: revisionPath(space.slug, page.slug, rev.id) }, 'View'),
          h('a.btn-small.wk-prev', { href: diffPath(space.slug, page.slug, null, rev.id) }, 'Diff'),
          editable && !rev.current ? h('button.btn-small', { type: 'button', onclick: () => revert(space, page, rev) }, 'Revert') : null));
      return item;
    };
    let firstPage = first;
    const list = infiniteList({
      load: cursor => {
        if (firstPage && !cursor) { const p = firstPage; firstPage = null; return Promise.resolve(p); }
        return api.get(pageApi(spaceSlug, slug, '/history'), { cursor }, { signal: ctx.signal });
      },
      render: row,
      className: 'wk-revs',
      empty: empty({ title: 'No revisions.' }),
      signal: ctx.signal,
      onPage: (items, data) => {
        // The oldest revision has nothing to diff against.
        if (!data.next) list?.list.lastElementChild?.querySelector('.wk-prev')?.remove();
      },
    });
    mount(main,
      pageTitle(`History of ${page.title}`, `From ${space.title}`),
      h('div.wk-tabbar', pageTabs(space.slug, page.slug, 'history', { canEdit: editable })),
      h('div.row.wrap.wk-compare', compare, hint),
      list);
  });
}

// ── One revision ────────────────────────────────────────────────────────

export function revisionView(ctx, spaceSlug, slug) {
  return wikiFrame(ctx, spaceSlug, async (main, { space }) => {
    const id = ctx.query.get('id') || '';
    const data = await api.get(pageApi(spaceSlug, slug, `/revisions/${encodeURIComponent(id)}`), null, { signal: ctx.signal });
    const { page, revision } = data;
    ctx.title(`${page.title} (old version)`);
    const editable = canEdit(data.viewer, page);
    mount(main,
      pageTitle(page.title, `From ${space.title}`),
      h('div.wk-tabbar', pageTabs(space.slug, page.slug, 'history', { canEdit: editable })),
      h('div.notice.wk-old',
        revision.current
          ? h('p', 'This is the current version of this page, edited by ', userLink(revision.author), `, ${ago(revision.created_at)}.`)
          : h('p', 'This is an old version of this page, edited by ', userLink(revision.author), ` on ${fullDate(revision.created_at)}. It may differ from the current version.`),
        revision.summary ? h('p.fine', `Summary: ${revision.summary}`) : null,
        h('div.row.wrap',
          h('a.btn-small', { href: pagePath(space.slug, page.slug) }, 'Current version'),
          revision.current ? null : h('a.btn-small', { href: diffPath(space.slug, page.slug, revision.id, page.current_revision_id) }, 'Compare with current'),
          h('a.btn-small', { href: diffPath(space.slug, page.slug, null, revision.id) }, 'Compare with previous'),
          editable && !revision.current ? h('button.btn-small', { type: 'button', onclick: () => revert(space, page, revision) }, 'Revert to this version') : null)),
      h('article.wk-article.south-card.flat', render(data.content, { space: space.slug, missing: data.missing, files: data.files })));
  });
}

// ── Diff ────────────────────────────────────────────────────────────────

function side(label, rev, space, page) {
  if (!rev) return h('div.wk-diff-side', h('p.wk-diff-label', label), h('p.fine', 'Page created.'));
  return h('div.wk-diff-side',
    h('p.wk-diff-label', label),
    h('p', dateLink(rev.created_at, revisionPath(space.slug, page.slug, rev.id)), rev.current ? ' (current)' : ''),
    h('p', userLink(rev.author), ' ', delta(rev.delta)),
    rev.summary ? h('p.wk-rev-summary', rev.summary) : null);
}

export function diffView(ctx, spaceSlug, slug) {
  return wikiFrame(ctx, spaceSlug, async (main, { space }) => {
    const data = await api.get(pageApi(spaceSlug, slug, '/diff'), { from: ctx.query.get('from'), to: ctx.query.get('to') }, { signal: ctx.signal });
    const { page } = data;
    ctx.title(`Changes to ${page.title}`);
    const editable = canEdit(data.viewer, page);
    const lines = data.lines.map(line => {
      if (line.op === 'skip') return h('div.wk-diff-skip', `${plural(line.count, 'unchanged line')}`);
      const text = line.text === '' ? ' ' : line.text;
      if (line.op === 'del') return h('div.wk-diff-del', h('span.sr-only', 'Removed: '), h('del', text));
      if (line.op === 'add') return h('div.wk-diff-add', h('span.sr-only', 'Added: '), h('ins', text));
      return h('div.wk-diff-same', text);
    });
    mount(main,
      pageTitle(`Changes to ${page.title}`, `From ${space.title}`),
      h('div.wk-tabbar', pageTabs(space.slug, page.slug, 'history', { canEdit: editable })),
      h('div.wk-diff-head.south-card.flat',
        side('Older version', data.from, space, page),
        side('Newer version', data.to, space, page)),
      h('p.fine.wk-diff-stats',
        `${plural(data.added, 'line')} added, ${plural(data.removed, 'line')} removed.`,
        data.truncated ? ' This diff is too large to show in full.' : '',
        ' ',
        data.from && editable && !data.from.current ? h('button.btn-small', { type: 'button', onclick: () => revert(space, page, data.from) }, 'Restore older version') : null),
      lines.length ? h('div.wk-diff', { role: 'region', 'aria-label': 'Changes' }, lines) : empty({ title: 'No changes.' }));
  });
}

