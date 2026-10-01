// Wiki markup: parse to a plain tree, then render with h(). Nothing here touches `document` until
// render() is called, so the parser runs under Node too (tests/wiki-markup.test.mjs).
//
// Supported:
//   == Heading ==  === Sub ===  ==== Sub sub ====      ----  (rule)
//   '''bold'''  ''italic''  '''''both'''''
//   * bullets  # numbers  (nest with ** / ## / *#)      : indented line
//   [[Page]]  [[Page|label]]  [[Page#Section|label]]  [[#Section]]
//   [https://example.com label]  bare https://links
//   [[File:<mediaId>|caption]]
//   {| table |} with |+ caption, ! headers, |- rows, | cells, || and !! on one line
//   {{Infobox | title = … | image = <mediaId> | Key = Value }}
//   #REDIRECT [[Page]]
// The server (src/routes/wiki.ts) uses the same title rules to find links.

import { h } from '../dom.js';

// ── Titles ──────────────────────────────────────────────────────────────

const BAD_TITLE = /[#<>[\]{}|/\\\u0000-\u001f\u007f]/;

/** "  main_page " -> "main page". */
export const normalizeTitle = value =>
  typeof value === 'string' ? value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().replace(/^:+\s*/, '') : '';
export const slugOf = title => normalizeTitle(title).replace(/ /g, '_');
export const titleOf = slug => normalizeTitle(slug);
export const isValidTitle = title => Boolean(title) && title.length <= 200 && !BAD_TITLE.test(title) && !/^\.+$/.test(title)
  && !/^(special|file)\s*:/i.test(title);
/** Path segment for a slug (keeps ':' readable). */
export const encodeSlug = slug => encodeURIComponent(slug).replace(/%3A/gi, ':');
/** Heading anchor: "Early life" -> "Early_life". */
export const anchorOf = text => text.trim().replace(/\s+/g, '_');
export const headingId = anchor => `sec-${anchor}`;

// ── Inline ──────────────────────────────────────────────────────────────

const INLINE = /\[\[([^[\]\n]+?)\]\]|\[(https?:\/\/[^\s\]]+)(?:\s+([^\]\n]*))?\]|(https?:\/\/[^\s<>[\]"']*[^\s<>[\]"'.,;:!?)])|('{2,})/g;
const FILE_OPTION = /^(thumb|thumbnail|frame|frameless|left|right|center|centre|none|upright|\d+px)$/i;
const MEDIA_ID = /^[a-z0-9]{8,40}$/i;

function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

/** One [[...]] body to a node. */
function internal(inner) {
  const bar = inner.indexOf('|');
  const target = bar < 0 ? inner : inner.slice(0, bar);
  const label = bar < 0 ? null : inner.slice(bar + 1).trim();
  const file = target.match(/^\s*file\s*:\s*(.+)$/i);
  if (file) {
    const id = file[1].trim();
    const params = label === null ? [] : label.split('|').map(s => s.trim());
    const caption = params.filter(p => p && !FILE_OPTION.test(p)).pop() || '';
    return MEDIA_ID.test(id) ? { t: 'file', id, caption } : { t: 'text', v: `[[${inner}]]` };
  }
  const hash = target.indexOf('#');
  const pagePart = hash < 0 ? target : target.slice(0, hash);
  const anchor = hash < 0 ? '' : anchorOf(target.slice(hash + 1));
  const title = normalizeTitle(pagePart);
  if (!title) {
    if (anchor) return { t: 'anchor', anchor, label: label || target.slice(hash + 1).trim() };
    return { t: 'text', v: `[[${inner}]]` };
  }
  if (!isValidTitle(title)) return { t: 'text', v: label || `[[${inner}]]` };
  return { t: 'link', title, slug: slugOf(title), anchor, label: label || target.trim().replace(/^:+/, '') };
}

/** Text to inline nodes: text, b, i, link, anchor, ext, file. */
export function parseInline(text) {
  const root = { c: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const emit = node => {
    const parent = top().c;
    if (node.t === 'text' && parent.length && parent[parent.length - 1].t === 'text') parent[parent.length - 1].v += node.v;
    else parent.push(node);
  };
  const isOpen = kind => stack.some(n => n.t === kind);
  const toggle = kind => {
    if (!isOpen(kind)) {
      const node = { t: kind, c: [] };
      top().c.push(node);
      stack.push(node);
      return;
    }
    // Close back to `kind`, then reopen anything that was opened inside it.
    const reopen = [];
    while (top().t !== kind) reopen.unshift(stack.pop().t);
    stack.pop();
    for (const k of reopen) { const node = { t: k, c: [] }; top().c.push(node); stack.push(node); }
  };
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) emit({ t: 'text', v: text.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[1] !== undefined) emit(internal(m[1]));
    else if (m[2] !== undefined) {
      const href = safeHref(m[2]);
      emit(href ? { t: 'ext', href, label: (m[3] || '').trim() || m[2] } : { t: 'text', v: m[0] });
    } else if (m[4] !== undefined) {
      const href = safeHref(m[4]);
      emit(href ? { t: 'ext', href, label: m[4] } : { t: 'text', v: m[0] });
    } else {
      let n = m[5].length;
      if (n === 4) { emit({ t: 'text', v: "'" }); n = 3; }
      if (n > 5) { emit({ t: 'text', v: "'".repeat(n - 5) }); n = 5; }
      if (n === 2) toggle('i');
      else if (n === 3) toggle('b');
      else {
        // ''''' closes whichever is innermost first, or opens bold then italic.
        const order = isOpen('b') || isOpen('i')
          ? stack.filter(x => x.t === 'b' || x.t === 'i').map(x => x.t).reverse()
          : ['b', 'i'];
        if (order.length === 1) order.push(order[0] === 'b' ? 'i' : 'b');
        for (const k of order) toggle(k);
      }
    }
  }
  if (last < text.length) emit({ t: 'text', v: text.slice(last) });
  return prune(root.c);
}

/** Drops empty bold/italic nodes left by stray quotes. */
function prune(nodes) {
  return nodes.filter(n => {
    if (n.c) n.c = prune(n.c);
    return !(n.c && !n.c.length) && !(n.t === 'text' && n.v === '');
  });
}

// ── Blocks ──────────────────────────────────────────────────────────────

const HEADING = /^(={1,6})\s*(.+?)\s*\1\s*$/;
const LIST = /^([*#]+)\s*(.*)$/;
const REDIRECT = /^\s*#redirect\s*:?\s*\[\[([^[\]|#\n]+)[^\]\n]*\]\]/i;

function buildLists(entries, depth = 0) {
  const lists = [];
  let k = 0;
  while (k < entries.length) {
    const marker = entries[k].prefix[depth];
    const list = { type: 'list', ordered: marker === '#', items: [] };
    while (k < entries.length && entries[k].prefix[depth] === marker) {
      const e = entries[k];
      if (e.prefix.length === depth + 1) {
        list.items.push({ inlines: parseInline(e.text), children: [] });
        k++;
      } else {
        const start = k;
        while (k < entries.length && entries[k].prefix.length > depth + 1 && entries[k].prefix[depth] === marker) k++;
        if (!list.items.length) list.items.push({ inlines: [], children: [] });
        list.items[list.items.length - 1].children.push(...buildLists(entries.slice(start, k), depth + 1));
      }
    }
    lists.push(list);
  }
  return lists;
}

function parseTable(lines) {
  const table = { type: 'table', caption: null, rows: [] };
  let row = null;
  const newRow = () => { row = []; table.rows.push(row); };
  const cellText = raw => {
    // "attrs | text" -> text (attributes are ignored)
    const bar = raw.indexOf('|');
    return bar >= 0 && !raw.slice(0, bar).includes('[[') && /=/.test(raw.slice(0, bar)) ? raw.slice(bar + 1) : raw;
  };
  for (const line of lines.slice(1)) {
    const l = line.trim();
    if (l.startsWith('|}')) break;
    if (l.startsWith('|+')) { table.caption = parseInline(l.slice(2).trim()); continue; }
    if (l.startsWith('|-')) { newRow(); continue; }
    if (l.startsWith('!')) {
      if (!row) newRow();
      for (const cell of l.slice(1).split('!!')) row.push({ header: true, inlines: parseInline(cellText(cell).trim()) });
      continue;
    }
    if (l.startsWith('|')) {
      if (!row) newRow();
      for (const cell of l.slice(1).split('||')) row.push({ header: false, inlines: parseInline(cellText(cell).trim()) });
      continue;
    }
    // A continuation line belongs to the last cell.
    if (row?.length && l) row[row.length - 1].inlines.push({ t: 'text', v: ' ' }, ...parseInline(l));
  }
  table.rows = table.rows.filter(r => r.length);
  return table;
}

/** Splits on `sep` outside [[...]] and {{...}}. */
function splitTop(text, sep) {
  const parts = [];
  let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === '[[' || two === '{{') { depth++; i++; }
    else if ((two === ']]' || two === '}}') && depth) { depth--; i++; }
    else if (!depth && text[i] === sep) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from));
  return parts;
}

function parseTemplate(lines) {
  const text = lines.join('\n').replace(/^\s*\{\{/, '').replace(/\}\}\s*$/, '');
  const [head, ...parts] = splitTop(text, '|');
  const name = head.trim();
  if (!/^infobox\b/i.test(name)) return { type: 'paragraph', inlines: parseInline(lines.join(' ')) };
  const box = { type: 'infobox', title: name.replace(/^infobox\s*/i, '').trim(), image: null, caption: null, rows: [] };
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key || !value) continue;
    const k = key.toLowerCase();
    if (k === 'title' || k === 'name') box.title = value;
    else if (k === 'image') box.image = (value.match(/^(?:\[\[)?\s*(?:file\s*:)?\s*([a-z0-9]{8,40})/i) || [])[1] || null;
    else if (k === 'caption') box.caption = parseInline(value);
    else box.rows.push({ key, value: parseInline(value) });
  }
  return box;
}

/**
 * Markup to { blocks, headings, redirect }. Blocks: paragraph, heading, list, indent, rule, table,
 * infobox, redirect. Headings: [{ level, text, anchor, id }] in order.
 */
export function parse(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  const headings = [];
  const usedAnchors = new Map();
  let redirect = null;
  let para = [];
  const flush = () => {
    if (!para.length) return;
    blocks.push({ type: 'paragraph', inlines: parseInline(para.join(' ')) });
    para = [];
  };

  const r = text.match(REDIRECT);
  if (r) {
    redirect = normalizeTitle(r[1]);
    if (isValidTitle(redirect)) blocks.push({ type: 'redirect', title: redirect, slug: slugOf(redirect) });
    else redirect = null;
  }

  let first = 0;
  if (redirect) { while (!lines[first].trim()) first++; first++; }
  for (let i = first; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    let m;
    if ((m = trimmed.match(HEADING))) {
      flush();
      const level = Math.min(4, Math.max(2, m[1].length));
      const inlines = parseInline(m[2]);
      const plain = inlineText(inlines);
      let anchor = anchorOf(plain) || 'section';
      const seen = usedAnchors.get(anchor.toLowerCase()) || 0;
      usedAnchors.set(anchor.toLowerCase(), seen + 1);
      if (seen) anchor = `${anchor}_${seen + 1}`;
      const heading = { type: 'heading', level, inlines, text: plain, anchor, id: headingId(anchor) };
      headings.push(heading);
      blocks.push(heading);
      continue;
    }
    if (/^-{4,}$/.test(trimmed)) { flush(); blocks.push({ type: 'rule' }); continue; }
    if (trimmed.startsWith('{|')) {
      flush();
      const start = i;
      while (i < lines.length && !lines[i].trim().startsWith('|}')) i++;
      blocks.push(parseTable(lines.slice(start, i + 1)));
      continue;
    }
    if (trimmed.startsWith('{{')) {
      flush();
      const start = i;
      while (i < lines.length && !lines[i].trim().endsWith('}}')) i++;
      blocks.push(parseTemplate(lines.slice(start, Math.min(i, lines.length - 1) + 1)));
      continue;
    }
    if (LIST.test(line)) {
      flush();
      const entries = [];
      while (i < lines.length && (m = lines[i].match(LIST))) { entries.push({ prefix: m[1], text: m[2] }); i++; }
      i--;
      blocks.push(...buildLists(entries));
      continue;
    }
    if ((m = line.match(/^(:+)\s*(.*)$/))) {
      flush();
      blocks.push({ type: 'indent', depth: Math.min(m[1].length, 6), inlines: parseInline(m[2]) });
      continue;
    }
    para.push(trimmed);
  }
  flush();
  return { blocks, headings, redirect };
}

/** Plain text of inline nodes. */
export function inlineText(nodes) {
  return nodes.map(n => n.t === 'text' ? n.v
    : n.c ? inlineText(n.c)
    : n.t === 'link' || n.t === 'anchor' || n.t === 'ext' ? n.label
    : n.t === 'file' ? n.caption : '').join('');
}

/** Internal link slugs in a text (for checking which exist before preview). */
export function linkSlugs(source) {
  const seen = new Map();
  for (const m of String(source ?? '').matchAll(/\[\[([^[\]\n]+?)\]\]/g)) {
    const node = internal(m[1]);
    if (node.t === 'link' && !seen.has(node.slug.toLowerCase())) seen.set(node.slug.toLowerCase(), node.slug);
  }
  return [...seen.values()];
}

/** Markup to one line of plain text (search snippets, summaries). */
export function plainText(source) {
  return String(source ?? '')
    .replace(/\[\[\s*file\s*:[^\]]*\]\]/gi, ' ')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/[^\s\]]+\s*([^\]]*)\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/^\s*=+\s*(.*?)\s*=+\s*$/gm, '$1')
    .replace(/^\s*[*#:]+\s*/gm, '')
    .replace(/\{\{|\}\}|\{\||\|\}|^\s*\|-?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Render ──────────────────────────────────────────────────────────────

/**
 * Builds the article DOM. Options:
 *   space     wiki slug, for link paths
 *   missing   Set or array of lower-case slugs with no page (red links); null = assume all exist
 *   files     { [mediaId]: { url } } of images that exist; null = assume all exist
 *   toc       add a table of contents when there are 3 or more headings (default true)
 */
export function render(source, { space, missing = null, files = null, toc = true } = {}) {
  const doc = typeof source === 'string' ? parse(source) : source;
  const missingSet = missing instanceof Set ? missing : new Set((missing || []).map(s => s.toLowerCase()));
  const pageHref = (slug, anchor = '', action = '') =>
    `/wiki/${encodeURIComponent(space)}/${encodeSlug(slug)}${action ? `/${action}` : ''}${anchor ? `#${headingId(anchor)}` : ''}`;

  const inline = nodes => nodes.map(n => {
    switch (n.t) {
      case 'text': return n.v;
      case 'b': return h('b', inline(n.c));
      case 'i': return h('i', inline(n.c));
      case 'anchor': return h('a', { href: `#${headingId(n.anchor)}` }, n.label);
      case 'ext': return h('a.wiki-ext', { href: n.href, target: '_blank', rel: 'noopener noreferrer nofollow', dataset: { external: '' } }, n.label);
      case 'file': return figure(n.id, n.caption ? [n.caption] : []);
      case 'link':
        if (missingSet.has(n.slug.toLowerCase())) {
          return h('a.wiki-red', { href: pageHref(n.slug, '', 'edit'), title: `${n.title} (page does not exist)` },
            n.label, h('span.wiki-red-note', ' (page does not exist)'));
        }
        return h('a.wiki-link', { href: pageHref(n.slug, n.anchor), title: n.title }, n.label);
      default: return null;
    }
  });

  const figure = (id, caption) => {
    const known = !files || files[id];
    return h('span.wiki-thumb',
      h('span.wiki-thumb-box', known
        ? h('img', { src: files?.[id]?.url || `/media/${id}`, alt: typeof caption[0] === 'string' ? caption[0] : '', loading: 'lazy' })
        : h('span.wiki-thumb-missing', 'File not found.')),
      caption.length ? h('span.wiki-caption', caption) : null);
  };

  const list = block => h(block.ordered ? 'ol' : 'ul', block.items.map(item =>
    h('li', inline(item.inlines), item.children.map(list))));

  const out = [];
  let tocDone = !toc || doc.headings.length < 3;
  for (const block of doc.blocks) {
    if (block.type === 'heading' && !tocDone) { out.push(contents(doc.headings)); tocDone = true; }
    switch (block.type) {
      case 'paragraph': out.push(h('p', inline(block.inlines))); break;
      case 'heading': out.push(h(`h${block.level}.wiki-heading`, { id: block.id }, inline(block.inlines))); break;
      case 'list': out.push(list(block)); break;
      case 'indent': out.push(h('div.wiki-indent', { style: { marginLeft: `${block.depth * 1.6}em` } }, inline(block.inlines))); break;
      case 'rule': out.push(h('hr.divider')); break;
      case 'redirect':
        out.push(h('p.wiki-redirect', 'Redirect to ', h('a.wiki-link', { href: pageHref(block.slug) }, block.title)));
        break;
      case 'table':
        out.push(h('div.wiki-table-wrap', h('table.wiki-table',
          block.caption ? h('caption', inline(block.caption)) : null,
          h('tbody', block.rows.map(row => h('tr', row.map(cell => h(cell.header ? 'th' : 'td', inline(cell.inlines)))))))));
        break;
      case 'infobox':
        out.push(h('aside.wiki-infobox',
          block.title ? h('p.wiki-infobox-title', block.title) : null,
          block.image ? figure(block.image, block.caption ? inline(block.caption) : []) : null,
          block.rows.length ? h('table', h('tbody', block.rows.map(r => h('tr', h('th', r.key), h('td', inline(r.value)))))) : null));
        break;
    }
  }
  return h('div.wiki-content', out);
}

/** Numbered table of contents ("1", "1.1", …) linking to heading anchors. */
export function contents(headings) {
  const counters = [0, 0, 0];
  const base = Math.min(...headings.map(x => x.level));
  const items = headings.map(x => {
    const depth = Math.min(2, x.level - base);
    counters[depth]++;
    for (let d = depth + 1; d < counters.length; d++) counters[d] = 0;
    const number = counters.slice(0, depth + 1).map(n => n || 1).join('.');
    return h('li', { class: `wiki-toc-${depth}` }, h('a', { href: `#${x.id}` }, h('span.wiki-toc-number', number), ' ', x.text));
  });
  return h('nav.wiki-toc', { 'aria-label': 'Contents' }, h('p.wiki-toc-title', 'Contents'), h('ul', items));
}
