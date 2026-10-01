// Wiki markup parser (public/js/wiki/markup.js). Runs in Node; render() gets a tiny fake DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkSlugs, parse, parseInline, plainText, render, slugOf } from '../public/js/wiki/markup.js';

test('wiki markup: inline bold, italic and links', () => {
  assert.deepEqual(parseInline("a '''b''' ''c'' '''''d'''''"), [
    { t: 'text', v: 'a ' }, { t: 'b', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' ' },
    { t: 'i', c: [{ t: 'text', v: 'c' }] }, { t: 'text', v: ' ' },
    { t: 'b', c: [{ t: 'i', c: [{ t: 'text', v: 'd' }] }] },
  ]);
  // Improper nesting is repaired, unclosed runs end with the line.
  const crossed = parseInline("'''bold ''both''' italic''");
  assert.equal(crossed[0].t, 'b');
  assert.equal(crossed[1].t, 'i');
  assert.equal(parseInline("'''open")[0].t, 'b');

  const [link] = parseInline('[[Main page]]');
  assert.deepEqual(link, { t: 'link', title: 'Main page', slug: 'Main_page', anchor: '', label: 'Main page' });
  const [labelled] = parseInline('[[Some_page#Early life|the start]]');
  assert.equal(labelled.slug, 'Some_page');
  assert.equal(labelled.anchor, 'Early_life');
  assert.equal(labelled.label, 'the start');
  assert.equal(parseInline('[[#Section]]')[0].t, 'anchor');
  assert.equal(parseInline('[[Bad<title]]')[0].t, 'text');

  assert.deepEqual(parseInline('[https://example.com/x Example]')[0], { t: 'ext', href: 'https://example.com/x', label: 'Example' });
  assert.equal(parseInline('[javascript:alert(1) x]')[0].t, 'text', 'only http and https links');
  assert.equal(parseInline('see https://example.com.')[1].href, 'https://example.com/', 'bare links stop before punctuation');

  assert.deepEqual(parseInline('[[File:abc123def456|thumb|A cat]]')[0], { t: 'file', id: 'abc123def456', caption: 'A cat' });
});

test('wiki markup: blocks, headings and lists', () => {
  const doc = parse([
    'Intro with [[Link]].',
    'Same paragraph.',
    '',
    '== History ==',
    'Text.',
    '=== Early ===',
    '* one',
    '** one point one',
    '* two',
    '# first',
    '== History ==',
    '----',
    ': indented',
  ].join('\n'));
  assert.deepEqual(doc.blocks.map(b => b.type), ['paragraph', 'heading', 'paragraph', 'heading', 'list', 'list', 'heading', 'rule', 'indent']);
  assert.equal(doc.blocks[0].inlines.length, 3, 'lines of a paragraph join');
  assert.deepEqual(doc.headings.map(x => [x.level, x.anchor]), [[2, 'History'], [3, 'Early'], [2, 'History_2']]);
  const bullets = doc.blocks[4];
  assert.equal(bullets.ordered, false);
  assert.equal(bullets.items.length, 2);
  assert.equal(bullets.items[0].children[0].items[0].inlines[0].v, 'one point one');
  assert.equal(doc.blocks[5].ordered, true);
});

test('wiki markup: tables, infobox and redirects', () => {
  const doc = parse('{|\n|+ Caption\n! A !! B\n|-\n| 1 || [[Two|2]]\n|}\n{{Infobox\n| title = Kevin\n| image = abcdefgh12\n| Role = [[Staff|Watcher]]\n}}');
  const [table, box] = doc.blocks;
  assert.equal(table.type, 'table');
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0].header, true);
  assert.equal(table.rows[1][1].inlines[0].slug, 'Two');
  assert.equal(box.type, 'infobox');
  assert.equal(box.title, 'Kevin');
  assert.equal(box.image, 'abcdefgh12');
  assert.equal(box.rows[0].key, 'Role');
  assert.equal(box.rows[0].value[0].label, 'Watcher');

  const r = parse('\n#REDIRECT [[New title]]\n\nignored?');
  assert.equal(r.redirect, 'New title');
  assert.equal(r.blocks[0].type, 'redirect');
});

test('wiki markup: helpers', () => {
  assert.equal(slugOf('  Main  page_x '), 'Main_page_x');
  assert.deepEqual(linkSlugs('[[A]] [[a]] [[B c|x]] [[File:abcdefgh12]] [[#Top]]'), ['A', 'B_c']);
  assert.equal(plainText("== Head ==\n'''Bold''' [[Page|label]] [https://x.com site] [[File:abcdefgh12|cap]]\n* item"), 'Head Bold label site item');
});

// A small fake DOM: enough for h() and render().
class Node_ {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.classList = new Set(); this.classList.add = this.classList.add.bind(this.classList); this.dataset = {}; this.style = {}; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener() {}
  get textContent() { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  find(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) if (c instanceof Node_) c.find(pred, out); return out; }
}
class Text_ { constructor(v) { this.textContent = v; } }

test('wiki markup: render builds nodes, red links, files and a table of contents', () => {
  globalThis.Node = Node_;
  globalThis.document = {
    createElement: tag => {
      const el = new Node_(tag);
      for (const k of ['href', 'title', 'id', 'src', 'alt', 'target', 'rel', 'loading']) el[k] = undefined;
      return el;
    },
    createTextNode: v => new Text_(v),
  };
  try {
    const root = render("== One ==\n[[Here]] and [[Missing page|gone]] <script>x</script>\n== Two ==\n[[File:abcdefgh12|Cat]] [[File:zzzzzzzz99]]\n== Three ==\ntext",
      { space: 'trivia', missing: ['missing_page'], files: { abcdefgh12: { url: '/media/abcdefgh12' } } });
    const links = root.find(n => n.tagName === 'a');
    const toc = root.find(n => n.tagName === 'nav');
    assert.equal(toc.length, 1, 'three headings get contents');
    const here = links.find(a => a.textContent === 'Here');
    assert.equal(here.href, '/wiki/trivia/Here');
    const red = links.find(a => a.classList.has('wiki-red'));
    assert.equal(red.href, '/wiki/trivia/Missing_page/edit');
    assert.match(red.textContent, /gone \(page does not exist\)/);
    const imgs = root.find(n => n.tagName === 'img');
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0].src, '/media/abcdefgh12');
    assert.ok(root.find(n => n.classList.has('wiki-thumb-missing')).length, 'unknown files say so');
    assert.equal(root.find(n => n.tagName === 'script').length, 0, 'markup-like text stays text');
    assert.ok(root.textContent.includes('<script>x</script>'));
  } finally {
    delete globalThis.document;
    delete globalThis.Node;
  }
});
