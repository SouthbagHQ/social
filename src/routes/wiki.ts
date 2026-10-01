// Wikis (Fandom / Wikipedia style). Mounted at /api/wiki. Tables: migrations/0013_wiki.sql.
// Page text is wiki markup; the browser renders it (public/js/wiki/markup.js). The Worker only
// pulls out internal links ([[Page]]), images ([[File:<mediaId>]]) and redirects (#REDIRECT [[Page]]).
//
// Spaces
//   GET    /api/wiki                       ?tab=popular|new|mine&q&community&cursor -> { items: SpaceJson[], next }
//   POST   /api/wiki                       { slug, title, description?, logo_media_id?, community?, edit_policy? } -> 201 { space }
//                                          (also creates "Main Page")
//   GET    /api/wiki/:space                -> { space, viewer: ViewerJson, main_page: 'Main_Page' }
//   PATCH  /api/wiki/:space                admins: { title?, description?, logo_media_id?, edit_policy?, community? } -> { space }
//   DELETE /api/wiki/:space                owner -> { ok }
//   GET    /api/wiki/:space/members        -> { items: [{ user, role }] }
//   PUT    /api/wiki/:space/members/:handle    admins: { role: admin|editor } -> { member: { user, role } }
//   DELETE /api/wiki/:space/members/:handle    admins, or yourself -> { ok }
//   GET    /api/wiki/:space/pages          ?cursor=<slug>&deleted=1 (admins) -> { items: PageJson[], next }   (A to Z)
//   POST   /api/wiki/:space/pages          { title, content, summary? } -> 201 { page, revision }
//   POST   /api/wiki/:space/resolve        { slugs: string[] } -> { missing: string[] }  (lower-case slugs with no page)
//   GET    /api/wiki/:space/recent         ?cursor -> { items: ChangeJson[], next }
//   GET    /api/wiki/:space/search         ?q -> { items: [{ slug, title, snippet, title_match }], next: null }
//   GET    /api/wiki/:space/random         -> { slug }
// Pages (:slug is the title with spaces or underscores, any case)
//   GET    /api/wiki/:space/pages/:slug    ?redirect=no -> PageView
//   PUT    /api/wiki/:space/pages/:slug    { content, summary?, base_revision_id } -> { page, revision } (creates the page when missing)
//                                          409 { error, latest: RevisionJson & { content } } when base_revision_id is stale
//   GET    /api/wiki/:space/pages/:slug/history          ?cursor -> { items: RevisionJson[], next, page, viewer }
//   GET    /api/wiki/:space/pages/:slug/revisions/:id    -> PageView for that revision
//   GET    /api/wiki/:space/pages/:slug/diff             ?from&to (to defaults to current, from to the one before)
//                                                        -> { page, from: RevisionJson|null, to: RevisionJson, lines: DiffLine[], added, removed,
//                                                             truncated, viewer }
//   POST   /api/wiki/:space/pages/:slug/revert           { revision_id, summary? } -> { page, revision }
//   POST   /api/wiki/:space/pages/:slug/move             { title, redirect?: true } -> { page, redirect: slug|null }
//   DELETE /api/wiki/:space/pages/:slug                  admins -> { ok }
//   POST   /api/wiki/:space/pages/:slug/undelete         admins -> { page }
//   PUT    /api/wiki/:space/pages/:slug/protect          admins: { protected } -> { page }
//   GET    /api/wiki/:space/pages/:slug/links            "What links here" -> { items: [{ slug, title, redirect_to }] }
//   GET    /api/wiki/:space/pages/:slug/talk             -> { items: TalkJson[] (oldest first, flat; nest by parent_id), count }
//   POST   /api/wiki/:space/pages/:slug/talk             { body, parent_id? } -> 201 { comment }
//   DELETE /api/wiki/:space/pages/:slug/talk/:id         author or admins -> { ok }
//   PUT    /api/wiki/:space/pages/:slug/watch            -> { watching: true }
//   DELETE /api/wiki/:space/pages/:slug/watch            -> { watching: false }
//
// SpaceJson: { id, slug, title, description, logo_url, community: { name, title }|null, edit_policy, page_count,
//              edit_count, created_at, updated_at, role: owner|admin|editor|null }
// ViewerJson: { role, can_edit, can_admin, signed_in }
// PageJson: { id, slug, title, protected, redirect_to, view_count, created_at, updated_at, deleted, current_revision_id }
// RevisionJson: { id, page_id, author: UserCard|null, summary, size, delta, created_at, current }
// PageView: { space, page, revision: RevisionJson, content, files: { [mediaId]: { url, width, height } },
//             missing: string[] (lower-case slugs of red links), redirected_from: { slug, title }|null,
//             viewer: ViewerJson & { can_edit (this page), watching } }
// DiffLine: { op: 'same'|'add'|'del', text } | { op: 'skip', count }
//
// Permissions: anyone may read. Editing needs a signed-in user, and with edit_policy 'members' a wiki
// member (or a member of the wiki's community). Protected pages, deleting, restoring and protecting
// need a wiki admin: the owner, an admin member, or a moderator of the wiki's community.
// Watchers get a 'system' notification (with a link to the diff) when someone else edits or talks.

import { Hono } from 'hono';
import type { AppEnv, Ctx, Env, SessionUser } from '../env';
import { body, cursor, fail, limit, placeholders, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { deleteUnusedMedia, getMedia } from '../lib/media';
import { notifyStatement } from '../lib/notify';
import { track } from '../lib/palantir';
import { userByHandle, userCard, userCardColumns, userCards, type UserCard, type UserRow } from '../lib/users';

const wiki = new Hono<AppEnv>();

type Role = 'owner' | 'admin' | 'editor';
type Policy = 'anyone' | 'members';

interface SpaceRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  logo_media_id: string | null;
  owner_id: string;
  community_id: string | null;
  edit_policy: Policy;
  page_count: number;
  edit_count: number;
  created_at: number;
  updated_at: number;
}
interface SpaceFull extends SpaceRow {
  member_role: 'admin' | 'editor' | null;
  community_role: 'owner' | 'moderator' | 'member' | null;
  community_name: string | null;
  community_title: string | null;
}
interface PageRow {
  id: string;
  space_id: string;
  slug: string;
  title: string;
  current_revision_id: string | null;
  protected: number;
  redirect_to: string | null;
  view_count: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
interface RevisionRow {
  id: string;
  page_id: string;
  space_id: string;
  author_id: string | null;
  content?: string;
  summary: string;
  size: number;
  delta: number;
  created_at: number;
}
interface TalkRow {
  id: string;
  page_id: string;
  author_id: string | null;
  parent_id: string | null;
  depth: number;
  body: string;
  created_at: number;
  deleted_at: number | null;
}

interface Viewer {
  user: SessionUser | null;
  role: Role | null;
  admin: boolean;
  canEdit: boolean;
}

export const MAIN_PAGE = 'Main Page';
const SPACE_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/i;
const RESERVED = new Set(['new', 'create', 'search', 'special', 'random', 'recent', 'all', 'mine', 'popular', 'api', 'admin']);
const MAX_SPACE_TITLE = 80;
const MAX_DESCRIPTION = 500;
const MAX_TITLE = 200;
const MAX_CONTENT = 100_000;
const MAX_SUMMARY = 200;
const MAX_TALK = 5000;
const MAX_TALK_DEPTH = 4;
const MAX_LINKS = 300;
const MAX_FILES = 50;
const MAX_WATCHERS_NOTIFIED = 200;
const CONFLICT = 'Someone edited this page while you were editing. Review the changes and try again.';
const BAD_TITLE = /[#<>[\]{}|/\\\u0000-\u001f\u007f]/;
const MEDIA_ID = /^[a-z0-9]{8,40}$/i;
const REV_COLUMNS = 'id, page_id, space_id, author_id, summary, size, delta, created_at';

// ── Titles, slugs and markup ────────────────────────────────────────────

/** "  main_page " -> "main page". Underscores are spaces; runs of space collapse. */
export const normalizeTitle = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().replace(/^:+\s*/, '') : '';
export const slugOf = (title: string): string => title.replace(/ /g, '_');

function isValidTitle(title: string): boolean {
  return Boolean(title) && title.length <= MAX_TITLE && !BAD_TITLE.test(title) && !/^\.+$/.test(title)
    && !/^(special|file)\s*:/i.test(title);
}

function validTitle(value: unknown): string {
  const title = normalizeTitle(value);
  if (!title) fail(422, 'Give the page a title.');
  if (title.length > MAX_TITLE) fail(422, `Page titles are limited to ${MAX_TITLE} characters.`);
  if (BAD_TITLE.test(title) || /^\.+$/.test(title)) fail(422, 'Page titles cannot contain # < > [ ] { } | / or \\.');
  if (/^(special|file)\s*:/i.test(title)) fail(422, 'That title is reserved.');
  return title;
}

/** Internal link targets (slugs, deduplicated ignoring case), image ids and the redirect target. */
export function extractMarkup(content: string): { links: string[]; files: string[]; redirect: string | null } {
  const links = new Map<string, string>();
  const files = new Set<string>();
  for (const m of content.matchAll(/\[\[([^[\]\n]+?)\]\]/g)) {
    const target = m[1].split('|')[0];
    const file = target.match(/^\s*file\s*:\s*(.+)$/i);
    if (file) {
      const id = file[1].trim();
      if (MEDIA_ID.test(id) && files.size < MAX_FILES) files.add(id);
      continue;
    }
    const title = normalizeTitle(target.split('#')[0]);
    if (!isValidTitle(title)) continue;
    const slug = slugOf(title);
    if (!links.has(slug.toLowerCase()) && links.size < MAX_LINKS) links.set(slug.toLowerCase(), slug);
  }
  // {{Infobox | image = <mediaId> }}
  for (const m of content.matchAll(/\|\s*image\s*=\s*(?:\[\[)?\s*(?:file\s*:\s*)?([a-z0-9]{8,40})\b/gi)) {
    if (files.size < MAX_FILES) files.add(m[1]);
  }
  const r = content.match(/^\s*#redirect\s*:?\s*\[\[([^[\]|#\n]+)/i);
  const redirectTitle = r ? normalizeTitle(r[1]) : '';
  return { links: [...links.values()], files: [...files], redirect: isValidTitle(redirectTitle) ? slugOf(redirectTitle) : null };
}

function validContent(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/\s+$/, '') : '';
  if (!text.trim()) fail(422, 'Write something first.');
  if (text.length > MAX_CONTENT) fail(422, 'Pages are limited to 100,000 characters.');
  return text;
}

function validText(value: unknown, max: number, what: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if ([...text].length > max) fail(422, `${what} are limited to ${max} characters.`);
  return text;
}

const likeTerm = (q: string) => `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
const enc = (slug: string) => encodeURIComponent(slug).replace(/%3A/gi, ':');
const pageLink = (space: string, slug: string, rest = '') => `/wiki/${space}/${enc(slug)}${rest}`;

// ── Line diff ───────────────────────────────────────────────────────────

export type DiffLine = { op: 'same' | 'add' | 'del'; text: string } | { op: 'skip'; count: number };
const DIFF_MAX_LINES = 5000;
const DIFF_MAX_CELLS = 1_500_000;
const DIFF_CONTEXT = 3;
const DIFF_MAX_OUTPUT = 3000;

/**
 * Line-based diff: common prefix and suffix are trimmed, the middle is an LCS table (capped at
 * DIFF_MAX_CELLS; beyond that the middle is shown as all removed then all added). Unchanged runs are
 * collapsed to DIFF_CONTEXT lines either side of a change.
 */
export function diffLines(before: string, after: string): { lines: DiffLine[]; added: number; removed: number; truncated: boolean } {
  let truncated = false;
  let a = before === '' ? [] : before.split('\n');
  let b = after === '' ? [] : after.split('\n');
  if (a.length > DIFF_MAX_LINES) { a = a.slice(0, DIFF_MAX_LINES); truncated = true; }
  if (b.length > DIFF_MAX_LINES) { b = b.slice(0, DIFF_MAX_LINES); truncated = true; }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const ops: { op: 'same' | 'add' | 'del'; text: string }[] = [];
  for (let i = 0; i < start; i++) ops.push({ op: 'same', text: a[i] });
  const n = endA - start, m = endB - start;
  if (n * m > DIFF_MAX_CELLS) {
    truncated = true;
    for (let i = start; i < endA; i++) ops.push({ op: 'del', text: a[i] });
    for (let j = start; j < endB; j++) ops.push({ op: 'add', text: b[j] });
  } else if (n || m) {
    // Lines to small integers so the table compares numbers.
    const ids = new Map<string, number>();
    const idOf = (s: string) => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v); } return v; };
    const x = Int32Array.from({ length: n }, (_, i) => idOf(a[start + i]));
    const y = Int32Array.from({ length: m }, (_, j) => idOf(b[start + j]));
    const w = m + 1;
    const table = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { ops.push({ op: 'same', text: a[start + i] }); i++; j++; }
      else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) { ops.push({ op: 'del', text: a[start + i] }); i++; }
      else { ops.push({ op: 'add', text: b[start + j] }); j++; }
    }
    for (; i < n; i++) ops.push({ op: 'del', text: a[start + i] });
    for (; j < m; j++) ops.push({ op: 'add', text: b[start + j] });
  }
  for (let i = endA; i < a.length; i++) ops.push({ op: 'same', text: a[i] });

  let added = 0, removed = 0;
  const lines: DiffLine[] = [];
  const near = new Uint8Array(ops.length);
  ops.forEach((o, k) => {
    if (o.op === 'same') return;
    if (o.op === 'add') added++; else removed++;
    for (let d = Math.max(0, k - DIFF_CONTEXT); d <= Math.min(ops.length - 1, k + DIFF_CONTEXT); d++) near[d] = 1;
  });
  let skipped = 0;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].op === 'same' && !near[k]) { skipped++; continue; }
    if (skipped) { lines.push({ op: 'skip', count: skipped }); skipped = 0; }
    if (lines.length >= DIFF_MAX_OUTPUT) { truncated = true; break; }
    lines.push(ops[k]);
  }
  if (skipped) lines.push({ op: 'skip', count: skipped });
  return { lines, added, removed, truncated };
}

// ── Loading and JSON ────────────────────────────────────────────────────

const mediaUrl = (id: string | null) => (id ? `/media/${id}` : null);

function spaceJson(s: SpaceRow & Partial<Pick<SpaceFull, 'community_name' | 'community_title'>>, role: Role | null) {
  return {
    id: s.id,
    slug: s.slug,
    title: s.title,
    description: s.description,
    logo_url: mediaUrl(s.logo_media_id),
    community: s.community_name ? { name: s.community_name, title: s.community_title || s.community_name } : null,
    edit_policy: s.edit_policy,
    page_count: s.page_count,
    edit_count: s.edit_count,
    created_at: s.created_at,
    updated_at: s.updated_at,
    role,
  };
}

const pageJson = (p: PageRow) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  protected: Boolean(p.protected),
  redirect_to: p.redirect_to,
  view_count: p.view_count,
  created_at: p.created_at,
  updated_at: p.updated_at,
  deleted: Boolean(p.deleted_at),
  current_revision_id: p.current_revision_id,
});

const revisionJson = (r: RevisionRow, authors: Map<string, UserCard>, currentId: string | null) => ({
  id: r.id,
  page_id: r.page_id,
  author: (r.author_id && authors.get(r.author_id)) || null,
  summary: r.summary,
  size: r.size,
  delta: r.delta,
  created_at: r.created_at,
  current: r.id === currentId,
});

function viewerOf(s: SpaceFull, user: SessionUser | null): Viewer {
  if (!user) return { user, role: null, admin: false, canEdit: false };
  const communityMod = s.community_role === 'owner' || s.community_role === 'moderator';
  const role: Role | null = s.owner_id === user.id ? 'owner'
    : s.member_role === 'admin' || communityMod ? 'admin'
    : s.member_role === 'editor' || s.community_role === 'member' ? 'editor' : null;
  const admin = role === 'owner' || role === 'admin';
  return { user, role, admin, canEdit: s.edit_policy === 'anyone' || role !== null };
}

const viewerJson = (v: Viewer) => ({ role: v.role, can_edit: v.canEdit, can_admin: v.admin, signed_in: Boolean(v.user) });
const canEditPage = (v: Viewer, p: PageRow | null) => v.canEdit && (!p || ((!p.protected || v.admin) && !p.deleted_at));

const SPACE_SELECT = (userParam: boolean) => `SELECT s.*,
    ${userParam ? '(SELECT role FROM wiki_members WHERE space_id = s.id AND user_id = ?1)' : 'NULL'} AS member_role,
    ${userParam ? '(SELECT role FROM community_members WHERE community_id = s.community_id AND user_id = ?1)' : 'NULL'} AS community_role,
    c.name AS community_name, c.title AS community_title
  FROM wiki_spaces s LEFT JOIN communities c ON c.id = s.community_id`;

async function loadSpace(c: Ctx): Promise<{ space: SpaceFull; viewer: Viewer }> {
  const user = c.get('user');
  const slug = c.req.param('space') ?? '';
  const space = user
    ? await c.env.DB.prepare(`${SPACE_SELECT(true)} WHERE s.slug = ?2`).bind(user.id, slug).first<SpaceFull>()
    : await c.env.DB.prepare(`${SPACE_SELECT(false)} WHERE s.slug = ?1`).bind(slug).first<SpaceFull>();
  if (!space) fail(404, 'Wiki not found.');
  return { space, viewer: viewerOf(space, user) };
}

const routeSlug = (c: Ctx) => slugOf(normalizeTitle(c.req.param('slug') ?? ''));

async function findPage(env: Env, spaceId: string, slug: string): Promise<PageRow | null> {
  if (!slug) return null;
  return env.DB.prepare('SELECT * FROM wiki_pages WHERE space_id = ? AND slug = ?').bind(spaceId, slug).first<PageRow>();
}

/** The page at :slug (deleted pages only for admins), or a 404. */
async function loadPage(c: Ctx, opts: { deleted?: boolean } = {}) {
  const { space, viewer } = await loadSpace(c);
  const page = await findPage(c.env, space.id, routeSlug(c));
  if (!page || (page.deleted_at && !(opts.deleted && viewer.admin))) fail(404, 'Page not found.');
  return { space, viewer, page };
}

async function revisionById(env: Env, pageId: string, id: string, withContent = false): Promise<RevisionRow | null> {
  return env.DB.prepare(`SELECT ${REV_COLUMNS}${withContent ? ', content' : ''} FROM wiki_revisions WHERE id = ? AND page_id = ?`)
    .bind(id, pageId).first<RevisionRow>();
}

/** Lower-case slugs among `slugs` with no live page in the space. */
async function missingSlugs(env: Env, spaceId: string, slugs: string[]): Promise<string[]> {
  const wanted = [...new Set(slugs.map(s => s.toLowerCase()))].slice(0, MAX_LINKS);
  if (!wanted.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < wanted.length; i += 90) chunks.push(wanted.slice(i, i + 90));
  const results = await env.DB.batch(chunks.map(chunk => env.DB.prepare(
    `SELECT lower(slug) AS slug FROM wiki_pages WHERE space_id = ? AND deleted_at IS NULL AND slug IN (${placeholders(chunk.length)})`,
  ).bind(spaceId, ...chunk)));
  const found = new Set(results.flatMap(r => (r.results as { slug: string }[]).map(x => x.slug)));
  return wanted.filter(s => !found.has(s));
}

/** Ready images among `ids`: { id: { url, width, height } }. */
async function filesFor(env: Env, ids: string[]): Promise<Record<string, { url: string; width: number | null; height: number | null }>> {
  if (!ids.length) return {};
  const { results } = await env.DB.prepare(`SELECT id, width, height FROM media WHERE kind = 'image' AND status = 'ready'
      AND id IN (${placeholders(ids.length)})`).bind(...ids).all<{ id: string; width: number | null; height: number | null }>();
  return Object.fromEntries(results.map(m => [m.id, { url: `/media/${m.id}`, width: m.width, height: m.height }]));
}

/** Everything the article view needs for one revision's text. */
async function pageView(c: Ctx, space: SpaceFull, viewer: Viewer, page: PageRow, revision: RevisionRow & { content: string },
  extra: { redirected_from?: { slug: string; title: string } | null; watching?: boolean } = {}) {
  const markup = extractMarkup(revision.content);
  const [missing, files, authors] = await Promise.all([
    missingSlugs(c.env, space.id, markup.links),
    filesFor(c.env, markup.files),
    userCards(c.env, revision.author_id ? [revision.author_id] : []),
  ]);
  return {
    space: spaceJson(space, viewer.role),
    page: pageJson(page),
    revision: revisionJson(revision, authors, page.current_revision_id),
    content: revision.content,
    files,
    missing,
    redirected_from: extra.redirected_from ?? null,
    viewer: { ...viewerJson(viewer), can_edit: canEditPage(viewer, page), watching: Boolean(extra.watching) },
  };
}

// ── Saving revisions ────────────────────────────────────────────────────

interface SaveInput {
  space: SpaceFull;
  user: SessionUser;
  /** The page to edit, or null to create one called `title`. */
  page: PageRow | null;
  title?: string;
  content: string;
  summary: string;
  /** The revision the editor started from; must still be current. */
  baseRevisionId: string | null;
  /** Previous text size, for the size change shown in history. */
  previousSize: number;
  now?: number;
}

/**
 * Writes a revision and everything that hangs off it in one batch. Every statement after the first
 * is guarded on the page now pointing at the new revision, so two editors saving from the same base
 * cannot both win: the loser's batch changes nothing and gets `conflict`.
 */
async function saveRevision(env: Env, input: SaveInput): Promise<{ conflict: true } | { conflict: false; pageId: string; revisionId: string }> {
  const { space, user, page, content, summary } = input;
  const now = input.now ?? Date.now();
  if (page && page.current_revision_id !== input.baseRevisionId) return { conflict: true };
  const markup = extractMarkup(content);
  const goodFiles = markup.files.length
    ? (await env.DB.prepare(`SELECT id FROM media WHERE kind = 'image' AND status = 'ready' AND id IN (${placeholders(markup.files.length)})`)
        .bind(...markup.files).all<{ id: string }>()).results.map(r => r.id)
    : [];
  const revisionId = newId(now);
  const pageId = page?.id ?? newId(now);
  const guard = 'EXISTS (SELECT 1 FROM wiki_pages WHERE id = ? AND current_revision_id = ?)';
  const g = [pageId, revisionId];
  const db = env.DB;
  const statements: D1PreparedStatement[] = [];

  if (page) {
    statements.push(db.prepare(`UPDATE wiki_pages SET current_revision_id = ?, redirect_to = ?, updated_at = ?
        WHERE id = ? AND current_revision_id IS ? AND deleted_at IS NULL`)
      .bind(revisionId, markup.redirect, now, page.id, input.baseRevisionId));
  } else {
    const title = input.title!;
    statements.push(db.prepare(`INSERT INTO wiki_pages (id, space_id, slug, title, current_revision_id, redirect_to, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(pageId, space.id, slugOf(title), title, revisionId, markup.redirect, now, now));
  }
  statements.push(db.prepare(`INSERT INTO wiki_revisions (id, page_id, space_id, author_id, content, summary, size, delta, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`)
    .bind(revisionId, pageId, space.id, user.id, content, summary, content.length, content.length - input.previousSize, now, ...g));
  statements.push(db.prepare(`DELETE FROM wiki_links WHERE from_page_id = ? AND ${guard}`).bind(pageId, ...g));
  for (let i = 0; i < markup.links.length; i += 90) {
    const chunk = markup.links.slice(i, i + 90);
    statements.push(db.prepare(`INSERT OR IGNORE INTO wiki_links (from_page_id, space_id, to_slug)
        SELECT ?, ?, column1 FROM (VALUES ${chunk.map(() => '(?)').join(', ')}) WHERE ${guard}`)
      .bind(pageId, space.id, ...chunk, ...g));
  }
  if (goodFiles.length) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO wiki_files (page_id, media_id, created_at)
        SELECT ?, column1, ? FROM (VALUES ${goodFiles.map(() => '(?)').join(', ')}) WHERE ${guard}`)
      .bind(pageId, now, ...goodFiles, ...g));
  }
  statements.push(db.prepare(`UPDATE wiki_spaces SET edit_count = edit_count + 1, updated_at = ?4,
      page_count = (SELECT COUNT(*) FROM wiki_pages WHERE space_id = ?1 AND deleted_at IS NULL AND redirect_to IS NULL)
      WHERE id = ?1 AND EXISTS (SELECT 1 FROM wiki_pages WHERE id = ?2 AND current_revision_id = ?3)`)
    .bind(space.id, pageId, revisionId, now));
  if (page) {
    // Watchers hear about edits by other people. One statement whatever the number of watchers.
    const title = page.title;
    const link = pageLink(space.slug, page.slug, `/diff?from=${page.current_revision_id}&to=${revisionId}`);
    statements.push(watcherNotifications(env, pageId, user, `${user.name} edited ${title} in ${space.title}.`, link, now, guard, g));
  } else {
    statements.push(db.prepare('INSERT OR IGNORE INTO wiki_watch (page_id, user_id, created_at) VALUES (?, ?, ?)').bind(pageId, user.id, now));
  }
  try {
    const results = await db.batch(statements);
    if (page && !results[0].meta.changes) return { conflict: true };
  } catch (err) {
    if (!page && String(err).includes('UNIQUE')) return { conflict: true };
    throw err;
  }
  return { conflict: false, pageId, revisionId };
}

/** Notifies the page's watchers except `actor` (and `skip`), optionally only when `guard` holds. */
function watcherNotifications(env: Env, pageId: string, actor: SessionUser, text: string, link: string, now: number,
  guard = '1', guardParams: unknown[] = [], skip: string | null = null): D1PreparedStatement {
  const time = now.toString(36).padStart(9, '0');
  return env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, body, link, created_at)
      SELECT ? || substr(lower(hex(randomblob(4))), 1, 7), w.user_id, ?, 'system', ?, ?, ?
      FROM wiki_watch w WHERE w.page_id = ? AND w.user_id != ? AND w.user_id != ? AND ${guard}
      LIMIT ${MAX_WATCHERS_NOTIFIED}`)
    .bind(time, actor.id, text, link, now, pageId, actor.id, skip ?? '', ...guardParams);
}

/** The 409 body for an edit conflict: the latest text so the editor can compare. */
async function conflictResponse(c: Ctx, spaceId: string, slug: string) {
  const page = await findPage(c.env, spaceId, slug);
  let latest = null;
  if (page?.current_revision_id) {
    const rev = await revisionById(c.env, page.id, page.current_revision_id, true);
    if (rev) {
      const authors = await userCards(c.env, rev.author_id ? [rev.author_id] : []);
      latest = { ...revisionJson(rev, authors, page.current_revision_id), content: rev.content ?? '' };
    }
  }
  return c.json({ error: CONFLICT, latest, page: page ? pageJson(page) : null }, 409);
}

async function savedResponse(c: Ctx, pageId: string, revisionId: string, status: 200 | 201 = 200) {
  const [page, rev] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM wiki_pages WHERE id = ?').bind(pageId).first<PageRow>(),
    c.env.DB.prepare(`SELECT ${REV_COLUMNS} FROM wiki_revisions WHERE id = ?`).bind(revisionId).first<RevisionRow>(),
  ]);
  const authors = await userCards(c.env, rev?.author_id ? [rev.author_id] : []);
  return c.json({ page: pageJson(page!), revision: revisionJson(rev!, authors, page!.current_revision_id) }, status);
}

const recountPages = (env: Env, spaceId: string, now: number) => env.DB.prepare(`UPDATE wiki_spaces SET updated_at = ?1,
    page_count = (SELECT COUNT(*) FROM wiki_pages WHERE space_id = ?2 AND deleted_at IS NULL AND redirect_to IS NULL) WHERE id = ?2`)
  .bind(now, spaceId);

// ── Spaces ──────────────────────────────────────────────────────────────

function validSpaceSlug(value: unknown): string {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SPACE_RE.test(slug) || slug.includes('--')) fail(422, 'Wiki addresses are 3 to 40 letters, numbers or single hyphens.');
  if (RESERVED.has(slug)) fail(409, 'That address is reserved.');
  return slug;
}

/** A media id the user may use as a wiki logo (their own ready image), or null to clear. */
async function logoId(env: Env, userId: string, value: unknown): Promise<string | null> {
  if (value === null || value === '' || value === undefined) return null;
  const file = typeof value === 'string' ? await getMedia(env, value) : null;
  if (!file || file.owner_id !== userId || file.kind !== 'image' || file.status !== 'ready') fail(422, 'Upload an image first.');
  return file.id;
}

/** The community a wiki may be added to: the user must moderate it. */
async function communityFor(env: Env, userId: string, value: unknown): Promise<string | null> {
  const name = typeof value === 'string' ? value.trim().replace(/^c\//i, '') : '';
  if (!name) return null;
  const row = await env.DB.prepare(`SELECT c.id, cm.role FROM communities c
      LEFT JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = ? WHERE c.name = ?`)
    .bind(userId, name).first<{ id: string; role: string | null }>();
  if (!row) fail(404, 'Community not found.');
  if (row.role !== 'owner' && row.role !== 'moderator') fail(403, 'Only community moderators can add a wiki to it.');
  return row.id;
}

const policyOf = (value: unknown): Policy => (value === 'members' ? 'members' : 'anyone');

wiki.get('/', async c => {
  const user = c.get('user');
  const size = limit(c, 24);
  const tab = c.req.query('tab');
  const q = str(c.req.query('q'), 60);
  const community = str(c.req.query('community'), 40);
  const after = cursor(c);
  if (tab === 'mine' && !user) return c.json({ items: [], next: null });
  const where: string[] = [];
  const params: unknown[] = [];
  if (tab === 'mine') { where.push('s.id IN (SELECT space_id FROM wiki_members WHERE user_id = ?1)'); }
  if (q) { where.push(`(s.title LIKE ? ESCAPE '\\' OR s.slug LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\')`); params.push(likeTerm(q), likeTerm(q), likeTerm(q)); }
  if (community) { where.push('c.name = ?'); params.push(community); }
  const keyset = tab === 'mine' || tab === 'new';
  if (keyset && after) { where.push('s.id < ?'); params.push(after); }
  const sql = `${SPACE_SELECT(Boolean(user))} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${keyset ? 's.id DESC' : 's.edit_count DESC, s.page_count DESC, s.id DESC'} LIMIT ?`;
  const { results } = await c.env.DB.prepare(sql).bind(...(user ? [user.id] : []), ...params, keyset ? size + 1 : 50).all<SpaceFull>();
  const rows = keyset ? results.slice(0, size) : results;
  return c.json({
    items: rows.map(s => spaceJson(s, viewerOf(s, user).role)),
    next: keyset && results.length > size ? rows[rows.length - 1].id : null,
  });
});

wiki.post('/', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const slug = validSpaceSlug(input.slug);
  const title = validText(input.title, MAX_SPACE_TITLE, 'Wiki names');
  if (!title) fail(422, 'Give the wiki a name.');
  const description = validText(input.description, MAX_DESCRIPTION, 'Descriptions');
  const [logo, communityId] = await Promise.all([logoId(c.env, user.id, input.logo_media_id), communityFor(c.env, user.id, input.community)]);
  const taken = await c.env.DB.prepare('SELECT 1 FROM wiki_spaces WHERE slug = ?').bind(slug).first();
  if (taken) fail(409, 'That address is taken.');
  const now = Date.now();
  const id = newId(now);
  const pageId = newId(now);
  const revisionId = newId(now);
  const content = `'''${title}''' is a wiki on Southbag Social.${description ? `\n\n${description}` : ''}\n\n== Getting started ==\n`
    + `* Edit this page to say what the wiki covers.\n* Create a page from the sidebar, or link to one: [[First page]].`;
  const links = extractMarkup(content).links;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO wiki_spaces (id, slug, title, description, logo_media_id, owner_id, community_id, edit_policy,
          page_count, edit_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`)
        .bind(id, slug, title, description, logo, user.id, communityId, policyOf(input.edit_policy), now, now),
      c.env.DB.prepare(`INSERT INTO wiki_members (space_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)`).bind(id, user.id, now),
      c.env.DB.prepare(`INSERT INTO wiki_pages (id, space_id, slug, title, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(pageId, id, slugOf(MAIN_PAGE), MAIN_PAGE, revisionId, now, now),
      c.env.DB.prepare(`INSERT INTO wiki_revisions (id, page_id, space_id, author_id, content, summary, size, delta, created_at)
          VALUES (?, ?, ?, ?, ?, 'Created the wiki', ?, ?, ?)`).bind(revisionId, pageId, id, user.id, content, content.length, content.length, now),
      ...links.map(l => c.env.DB.prepare('INSERT OR IGNORE INTO wiki_links (from_page_id, space_id, to_slug) VALUES (?, ?, ?)').bind(pageId, id, l)),
      c.env.DB.prepare('INSERT INTO wiki_watch (page_id, user_id, created_at) VALUES (?, ?, ?)').bind(pageId, user.id, now),
    ]);
  } catch (err) {
    if (String(err).includes('UNIQUE')) fail(409, 'That address is taken.');
    throw err;
  }
  track(c, 'social_wiki_created', { wiki_id: id, community: Boolean(communityId) });
  const space = await c.env.DB.prepare(`${SPACE_SELECT(true)} WHERE s.id = ?2`).bind(user.id, id).first<SpaceFull>();
  return c.json({ space: spaceJson(space!, 'owner') }, 201);
});

wiki.get('/:space', async c => {
  const { space, viewer } = await loadSpace(c);
  return c.json({ space: spaceJson(space, viewer.role), viewer: viewerJson(viewer), main_page: slugOf(MAIN_PAGE) });
});

wiki.patch('/:space', async c => {
  const { space, viewer } = await loadSpace(c);
  const user = requireUser(c);
  if (!viewer.admin) fail(403, 'Only wiki admins can change the wiki.');
  const input = await body(c);
  const next = { ...space };
  if ('title' in input) {
    next.title = validText(input.title, MAX_SPACE_TITLE, 'Wiki names');
    if (!next.title) fail(422, 'Give the wiki a name.');
  }
  if ('description' in input) next.description = validText(input.description, MAX_DESCRIPTION, 'Descriptions');
  if ('edit_policy' in input) next.edit_policy = policyOf(input.edit_policy);
  if ('logo_media_id' in input && input.logo_media_id !== space.logo_media_id) next.logo_media_id = await logoId(c.env, user.id, input.logo_media_id);
  if ('community' in input) next.community_id = await communityFor(c.env, user.id, input.community);
  await c.env.DB.prepare(`UPDATE wiki_spaces SET title = ?, description = ?, edit_policy = ?, logo_media_id = ?, community_id = ?, updated_at = ?
      WHERE id = ?`).bind(next.title, next.description, next.edit_policy, next.logo_media_id, next.community_id, Date.now(), space.id).run();
  if (space.logo_media_id && space.logo_media_id !== next.logo_media_id) await deleteUnusedMedia(c.env, [space.logo_media_id]);
  const row = await c.env.DB.prepare(`${SPACE_SELECT(true)} WHERE s.id = ?2`).bind(user.id, space.id).first<SpaceFull>();
  return c.json({ space: spaceJson(row!, viewerOf(row!, user).role) });
});

wiki.delete('/:space', async c => {
  const { space, viewer } = await loadSpace(c);
  requireUser(c);
  if (viewer.role !== 'owner') fail(403, 'Only the owner can delete the wiki.');
  const { results } = await c.env.DB.prepare(`SELECT DISTINCT f.media_id FROM wiki_files f JOIN wiki_pages p ON p.id = f.page_id
      WHERE p.space_id = ? LIMIT 200`).bind(space.id).all<{ media_id: string }>();
  await c.env.DB.prepare('DELETE FROM wiki_spaces WHERE id = ?').bind(space.id).run();
  await deleteUnusedMedia(c.env, [space.logo_media_id, ...results.map(r => r.media_id)]);
  return c.json({ ok: true });
});

// ── Members ─────────────────────────────────────────────────────────────

wiki.get('/:space/members', async c => {
  const { space } = await loadSpace(c);
  const { results } = await c.env.DB.prepare(`SELECT wm.role, ${userCardColumns.split(', ').map(col => 'u.' + col).join(', ')}
      FROM wiki_members wm JOIN users u ON u.id = wm.user_id WHERE wm.space_id = ?
      ORDER BY CASE WHEN u.id = ? THEN 0 WHEN wm.role = 'admin' THEN 1 ELSE 2 END, u.handle LIMIT 500`)
    .bind(space.id, space.owner_id).all<UserRow & { role: 'admin' | 'editor' }>();
  return c.json({ items: results.map(r => ({ user: userCard(r), role: r.id === space.owner_id ? 'owner' : r.role })) });
});

wiki.put('/:space/members/:handle', async c => {
  const { space, viewer } = await loadSpace(c);
  requireUser(c);
  if (!viewer.admin) fail(403, 'Only wiki admins can add members.');
  const input = await body(c);
  const role = input.role === 'admin' ? 'admin' : 'editor';
  const target = await userByHandle(c.env, c.req.param('handle'));
  if (!target) fail(404, 'User not found.');
  if (target.id === space.owner_id) fail(409, 'The owner is always an admin.');
  await c.env.DB.prepare(`INSERT INTO wiki_members (space_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (space_id, user_id) DO UPDATE SET role = excluded.role`).bind(space.id, target.id, role, Date.now()).run();
  await notifyStatement(c.env, {
    userId: target.id, actorId: viewer.user!.id, type: 'system',
    body: `${viewer.user!.name} added you to ${space.title} as ${role === 'admin' ? 'an admin' : 'an editor'}.`,
    link: `/wiki/${space.slug}`,
  })?.run();
  return c.json({ member: { user: userCard(target), role } });
});

wiki.delete('/:space/members/:handle', async c => {
  const { space, viewer } = await loadSpace(c);
  const user = requireUser(c);
  const target = await userByHandle(c.env, c.req.param('handle'));
  if (!target) fail(404, 'User not found.');
  if (target.id !== user.id && !viewer.admin) fail(403, 'Only wiki admins can remove members.');
  if (target.id === space.owner_id) fail(409, 'The owner cannot be removed.');
  await c.env.DB.prepare('DELETE FROM wiki_members WHERE space_id = ? AND user_id = ?').bind(space.id, target.id).run();
  return c.json({ ok: true });
});

// ── Lists: all pages, recent changes, search, random ────────────────────

wiki.get('/:space/pages', async c => {
  const { space, viewer } = await loadSpace(c);
  const size = limit(c, 50, 50);
  const after = cursor(c);
  const deleted = c.req.query('deleted') === '1' && viewer.admin;
  const { results } = await c.env.DB.prepare(`SELECT * FROM wiki_pages WHERE space_id = ? AND deleted_at IS ${deleted ? 'NOT ' : ''}NULL
      ${after ? 'AND slug > ?' : ''} ORDER BY slug LIMIT ?`)
    .bind(space.id, ...(after ? [after] : []), size + 1).all<PageRow>();
  const items = results.slice(0, size);
  return c.json({ items: items.map(pageJson), next: results.length > size ? items[items.length - 1].slug : null });
});

wiki.post('/:space/pages', async c => {
  const { space, viewer } = await loadSpace(c);
  const user = requireUser(c);
  const input = await body(c);
  const title = validTitle(input.title);
  if (!viewer.canEdit) fail(403, 'Only members of this wiki can create pages.');
  const content = validContent(input.content);
  const summary = validText(input.summary, MAX_SUMMARY, 'Edit summaries');
  const existing = await findPage(c.env, space.id, slugOf(title));
  if (existing) fail(409, existing.deleted_at ? 'This page was deleted. Ask a wiki admin to restore it.' : 'A page with that title already exists.');
  const saved = await saveRevision(c.env, { space, user, page: null, title, content, summary: summary || 'Created page', baseRevisionId: null, previousSize: 0 });
  if (saved.conflict) fail(409, 'A page with that title already exists.');
  track(c, 'social_wiki_page_created', { wiki_id: space.id, page_id: saved.pageId });
  return savedResponse(c, saved.pageId, saved.revisionId, 201);
});

wiki.post('/:space/resolve', async c => {
  const { space } = await loadSpace(c);
  const input = await body<{ slugs?: unknown }>(c);
  const slugs = (Array.isArray(input.slugs) ? input.slugs : [])
    .map(s => slugOf(normalizeTitle(s))).filter(s => isValidTitle(s.replace(/_/g, ' ')));
  return c.json({ missing: await missingSlugs(c.env, space.id, slugs) });
});

wiki.get('/:space/recent', async c => {
  const { space, viewer } = await loadSpace(c);
  const size = limit(c, 30, 50);
  const after = cursor(c);
  const { results } = await c.env.DB.prepare(`SELECT r.id, r.page_id, r.space_id, r.author_id, r.summary, r.size, r.delta, r.created_at,
        p.slug AS page_slug, p.title AS page_title, p.current_revision_id AS page_current, p.deleted_at AS page_deleted
      FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id
      WHERE r.space_id = ? ${viewer.admin ? '' : 'AND p.deleted_at IS NULL'} ${after ? 'AND r.id < ?' : ''}
      ORDER BY r.id DESC LIMIT ?`)
    .bind(space.id, ...(after ? [after] : []), size + 1)
    .all<RevisionRow & { page_slug: string; page_title: string; page_current: string; page_deleted: number | null }>();
  const rows = results.slice(0, size);
  const authors = await userCards(c.env, rows.map(r => r.author_id ?? ''));
  return c.json({
    items: rows.map(r => ({
      ...revisionJson(r, authors, r.page_current),
      page: { slug: r.page_slug, title: r.page_title, deleted: Boolean(r.page_deleted) },
    })),
    next: results.length > size ? rows[rows.length - 1].id : null,
  });
});

wiki.get('/:space/search', async c => {
  const { space } = await loadSpace(c);
  const q = str(c.req.query('q'), 100);
  if (q.length < 2) return c.json({ items: [], next: null });
  const term = likeTerm(q);
  const { results } = await c.env.DB.prepare(`SELECT p.slug, p.title, (p.title LIKE ?1 ESCAPE '\\') AS title_match,
        substr(r.content, max(1, instr(lower(r.content), ?2) - 80), 240) AS snippet
      FROM wiki_pages p JOIN wiki_revisions r ON r.id = p.current_revision_id
      WHERE p.space_id = ?3 AND p.deleted_at IS NULL AND p.redirect_to IS NULL
        AND (p.title LIKE ?1 ESCAPE '\\' OR r.content LIKE ?1 ESCAPE '\\')
      ORDER BY title_match DESC, p.slug LIMIT 50`)
    .bind(term, q.toLowerCase(), space.id).all<{ slug: string; title: string; title_match: number; snippet: string }>();
  track(c, 'social_wiki_searched', { wiki_id: space.id, results: results.length });
  return c.json({ items: results.map(r => ({ ...r, title_match: Boolean(r.title_match) })), next: null });
});

wiki.get('/:space/random', async c => {
  const { space } = await loadSpace(c);
  const where = 'space_id = ? AND deleted_at IS NULL AND redirect_to IS NULL';
  const offset = Math.floor(Math.random() * Math.max(1, space.page_count));
  const row = await c.env.DB.prepare(`SELECT slug FROM wiki_pages WHERE ${where} ORDER BY id LIMIT 1 OFFSET ?`).bind(space.id, offset).first<{ slug: string }>()
    ?? await c.env.DB.prepare(`SELECT slug FROM wiki_pages WHERE ${where} ORDER BY id LIMIT 1`).bind(space.id).first<{ slug: string }>();
  if (!row) fail(404, 'No pages yet.');
  return c.json({ slug: row.slug });
});

// ── Pages ───────────────────────────────────────────────────────────────

wiki.get('/:space/pages/:slug', async c => {
  const { space, viewer } = await loadSpace(c);
  const user = viewer.user;
  const pageSql = `SELECT p.*, ${user ? 'EXISTS (SELECT 1 FROM wiki_watch WHERE page_id = p.id AND user_id = ?)' : '0'} AS watching
    FROM wiki_pages p WHERE p.space_id = ? AND p.slug = ?`;
  const find = (slug: string) => c.env.DB.prepare(pageSql).bind(...(user ? [user.id] : []), space.id, slug).first<PageRow & { watching: number }>();
  let page = await find(routeSlug(c));
  if (!page || (page.deleted_at && !viewer.admin)) fail(404, 'Page not found.');
  let redirectedFrom: { slug: string; title: string } | null = null;
  if (page.redirect_to && !page.deleted_at && c.req.query('redirect') !== 'no') {
    const target = await find(page.redirect_to);
    if (target && !target.deleted_at) {
      redirectedFrom = { slug: page.slug, title: page.title };
      page = target;
    }
  }
  const revision = page.current_revision_id ? await revisionById(c.env, page.id, page.current_revision_id, true) : null;
  if (!revision) fail(404, 'Page not found.');
  if (!page.deleted_at) {
    c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE wiki_pages SET view_count = view_count + 1 WHERE id = ?').bind(page.id).run().catch(() => {}));
  }
  const { watching, ...row } = page;
  return c.json(await pageView(c, space, viewer, row, revision as RevisionRow & { content: string }, { redirected_from: redirectedFrom, watching: Boolean(watching) }));
});

wiki.put('/:space/pages/:slug', async c => {
  const { space, viewer } = await loadSpace(c);
  const user = requireUser(c);
  const input = await body(c);
  const slug = routeSlug(c);
  const page = await findPage(c.env, space.id, slug);
  if (!viewer.canEdit) fail(403, 'Only members of this wiki can edit it.');
  if (page?.deleted_at) fail(409, 'This page was deleted. Ask a wiki admin to restore it.');
  if (page?.protected && !viewer.admin) fail(403, 'This page is protected. Only wiki admins can edit it.');
  const title = page ? page.title : validTitle(slug);
  const content = validContent(input.content);
  const summary = validText(input.summary, MAX_SUMMARY, 'Edit summaries');
  const base = typeof input.base_revision_id === 'string' && input.base_revision_id ? input.base_revision_id : null;
  let previousSize = 0;
  if (page?.current_revision_id) {
    const current = await c.env.DB.prepare('SELECT size FROM wiki_revisions WHERE id = ?').bind(page.current_revision_id).first<{ size: number }>();
    previousSize = current?.size ?? 0;
  }
  const saved = await saveRevision(c.env, { space, user, page, title, content, summary: summary || (page ? '' : 'Created page'), baseRevisionId: base, previousSize });
  if (saved.conflict) return conflictResponse(c, space.id, slug);
  track(c, page ? 'social_wiki_page_edited' : 'social_wiki_page_created', { wiki_id: space.id, page_id: saved.pageId, size: content.length });
  return savedResponse(c, saved.pageId, saved.revisionId, page ? 200 : 201);
});

wiki.get('/:space/pages/:slug/history', async c => {
  const { viewer, page } = await loadPage(c, { deleted: true });
  const size = limit(c, 30, 50);
  const after = cursor(c);
  const { results } = await c.env.DB.prepare(`SELECT ${REV_COLUMNS} FROM wiki_revisions WHERE page_id = ? ${after ? 'AND id < ?' : ''}
      ORDER BY id DESC LIMIT ?`).bind(page.id, ...(after ? [after] : []), size + 1).all<RevisionRow>();
  const rows = results.slice(0, size);
  const authors = await userCards(c.env, rows.map(r => r.author_id ?? ''));
  return c.json({
    items: rows.map(r => revisionJson(r, authors, page.current_revision_id)),
    next: results.length > size ? rows[rows.length - 1].id : null,
    page: pageJson(page),
    viewer: { ...viewerJson(viewer), can_edit: canEditPage(viewer, page) },
  });
});

wiki.get('/:space/pages/:slug/revisions/:id', async c => {
  const { space, viewer, page } = await loadPage(c, { deleted: true });
  const revision = await revisionById(c.env, page.id, c.req.param('id'), true);
  if (!revision) fail(404, 'Revision not found.');
  return c.json(await pageView(c, space, viewer, page, revision as RevisionRow & { content: string }));
});

wiki.get('/:space/pages/:slug/diff', async c => {
  const { viewer, page } = await loadPage(c, { deleted: true });
  const toId = c.req.query('to') || page.current_revision_id || '';
  const to = await revisionById(c.env, page.id, toId, true);
  if (!to) fail(404, 'Revision not found.');
  const fromId = c.req.query('from');
  const from = fromId
    ? await revisionById(c.env, page.id, fromId, true)
    : await c.env.DB.prepare(`SELECT ${REV_COLUMNS}, content FROM wiki_revisions WHERE page_id = ? AND id < ? ORDER BY id DESC LIMIT 1`)
        .bind(page.id, to.id).first<RevisionRow>();
  if (fromId && !from) fail(404, 'Revision not found.');
  // Always older on the left.
  const [older, newer] = from && from.id > to.id ? [to, from] : [from, to];
  const result = diffLines(older?.content ?? '', newer!.content ?? '');
  const authors = await userCards(c.env, [older?.author_id ?? '', newer!.author_id ?? '']);
  const strip = (r: RevisionRow) => revisionJson(r, authors, page.current_revision_id);
  return c.json({
    page: pageJson(page), from: older ? strip(older) : null, to: strip(newer!), ...result,
    viewer: { ...viewerJson(viewer), can_edit: canEditPage(viewer, page) },
  });
});

wiki.post('/:space/pages/:slug/revert', async c => {
  const { space, viewer, page } = await loadPage(c);
  const user = requireUser(c);
  if (!canEditPage(viewer, page)) fail(403, page.protected ? 'This page is protected. Only wiki admins can edit it.' : 'Only members of this wiki can edit it.');
  const input = await body(c);
  const target = await revisionById(c.env, page.id, str(input.revision_id, 40), true);
  if (!target) fail(404, 'Revision not found.');
  if (target.id === page.current_revision_id) fail(409, 'That is already the current version.');
  const current = await c.env.DB.prepare('SELECT size FROM wiki_revisions WHERE id = ?').bind(page.current_revision_id).first<{ size: number }>();
  const author = target.author_id ? (await userCards(c.env, [target.author_id])).get(target.author_id) : null;
  const summary = validText(input.summary, MAX_SUMMARY, 'Edit summaries')
    || `Reverted to the version by ${author ? `@${author.handle}` : 'a deleted account'}`.slice(0, MAX_SUMMARY);
  const saved = await saveRevision(c.env, {
    space, user, page, content: target.content!, summary, baseRevisionId: page.current_revision_id, previousSize: current?.size ?? 0,
  });
  if (saved.conflict) return conflictResponse(c, space.id, page.slug);
  track(c, 'social_wiki_page_reverted', { wiki_id: space.id, page_id: page.id });
  return savedResponse(c, saved.pageId, saved.revisionId);
});

wiki.post('/:space/pages/:slug/move', async c => {
  const { space, viewer, page } = await loadPage(c);
  const user = requireUser(c);
  if (!canEditPage(viewer, page)) fail(403, page.protected ? 'This page is protected. Only wiki admins can move it.' : 'Only members of this wiki can move pages.');
  const input = await body(c);
  const title = validTitle(input.title);
  const slug = slugOf(title);
  const keepRedirect = input.redirect !== false;
  const sameSlug = slug.toLowerCase() === page.slug.toLowerCase();
  if (title === page.title) fail(422, 'Choose a different title.');
  const db = c.env.DB;
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (!sameSlug) {
    const existing = await findPage(c.env, space.id, slug);
    if (existing) {
      // Moving back over the redirect a move left behind is fine; anything else is in the way.
      const ours = existing.redirect_to?.toLowerCase() === page.slug.toLowerCase() && !existing.deleted_at;
      if (!ours) fail(409, 'A page with that title already exists.');
      statements.push(db.prepare('DELETE FROM wiki_pages WHERE id = ?').bind(existing.id));
    }
  }
  const current = await revisionById(c.env, page.id, page.current_revision_id!, true);
  const moveRevision = newId(now);
  statements.push(
    db.prepare('UPDATE wiki_pages SET slug = ?, title = ?, current_revision_id = ?, updated_at = ? WHERE id = ?')
      .bind(slug, title, moveRevision, now, page.id),
    db.prepare(`INSERT INTO wiki_revisions (id, page_id, space_id, author_id, content, summary, size, delta, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .bind(moveRevision, page.id, space.id, user.id, current!.content, `Moved ${page.title} to ${title}`.slice(0, MAX_SUMMARY), current!.size, now),
  );
  let redirect: string | null = null;
  if (keepRedirect && !sameSlug) {
    redirect = page.slug;
    const redirectId = newId(now);
    const redirectRevision = newId(now);
    const text = `#REDIRECT [[${title}]]`;
    statements.push(
      db.prepare(`INSERT INTO wiki_pages (id, space_id, slug, title, current_revision_id, redirect_to, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(redirectId, space.id, page.slug, page.title, redirectRevision, slug, now, now),
      db.prepare(`INSERT INTO wiki_revisions (id, page_id, space_id, author_id, content, summary, size, delta, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(redirectRevision, redirectId, space.id, user.id, text, `Moved ${page.title} to ${title}`.slice(0, MAX_SUMMARY), text.length, text.length, now),
      db.prepare('INSERT INTO wiki_links (from_page_id, space_id, to_slug) VALUES (?, ?, ?)').bind(redirectId, space.id, slug),
    );
  }
  statements.push(
    recountPages(c.env, space.id, now),
    watcherNotifications(c.env, page.id, user, `${user.name} moved ${page.title} to ${title} in ${space.title}.`, pageLink(space.slug, slug), now),
  );
  try {
    await db.batch(statements);
  } catch (err) {
    if (String(err).includes('UNIQUE')) fail(409, 'A page with that title already exists.');
    throw err;
  }
  track(c, 'social_wiki_page_moved', { wiki_id: space.id, page_id: page.id, redirect: Boolean(redirect) });
  const moved = await c.env.DB.prepare('SELECT * FROM wiki_pages WHERE id = ?').bind(page.id).first<PageRow>();
  return c.json({ page: pageJson(moved!), redirect });
});

wiki.delete('/:space/pages/:slug', async c => {
  const { space, viewer, page } = await loadPage(c);
  requireUser(c);
  if (!viewer.admin) fail(403, 'Only wiki admins can delete pages.');
  if (page.slug.toLowerCase() === slugOf(MAIN_PAGE).toLowerCase()) fail(409, 'The main page cannot be deleted.');
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE wiki_pages SET deleted_at = ? WHERE id = ?').bind(now, page.id),
    recountPages(c.env, space.id, now),
  ]);
  track(c, 'social_wiki_page_deleted', { wiki_id: space.id, page_id: page.id });
  return c.json({ ok: true });
});

wiki.post('/:space/pages/:slug/undelete', async c => {
  const { space, viewer, page } = await loadPage(c, { deleted: true });
  requireUser(c);
  if (!viewer.admin) fail(403, 'Only wiki admins can restore pages.');
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE wiki_pages SET deleted_at = NULL WHERE id = ?').bind(page.id),
    recountPages(c.env, space.id, now),
  ]);
  track(c, 'social_wiki_page_restored', { wiki_id: space.id, page_id: page.id });
  return c.json({ page: pageJson({ ...page, deleted_at: null }) });
});

wiki.put('/:space/pages/:slug/protect', async c => {
  const { space, viewer, page } = await loadPage(c);
  requireUser(c);
  if (!viewer.admin) fail(403, 'Only wiki admins can protect pages.');
  const input = await body(c);
  const value = input.protected === false ? 0 : 1;
  await c.env.DB.prepare('UPDATE wiki_pages SET protected = ? WHERE id = ?').bind(value, page.id).run();
  track(c, 'social_wiki_page_protected', { wiki_id: space.id, page_id: page.id, protected: Boolean(value) });
  return c.json({ page: pageJson({ ...page, protected: value }) });
});

// "What links here". The page itself need not exist (red links have backlinks too).
wiki.get('/:space/pages/:slug/links', async c => {
  const { space } = await loadSpace(c);
  const slug = routeSlug(c);
  const { results } = await c.env.DB.prepare(`SELECT p.slug, p.title, p.redirect_to FROM wiki_links l JOIN wiki_pages p ON p.id = l.from_page_id
      WHERE l.space_id = ? AND l.to_slug = ? AND p.deleted_at IS NULL ORDER BY p.slug LIMIT 500`)
    .bind(space.id, slug).all<{ slug: string; title: string; redirect_to: string | null }>();
  return c.json({ items: results });
});

// ── Talk ────────────────────────────────────────────────────────────────

const talkJson = (t: TalkRow, authors: Map<string, UserCard>, viewer: Viewer) => ({
  id: t.id,
  parent_id: t.parent_id,
  depth: t.depth,
  author: t.deleted_at ? null : (t.author_id && authors.get(t.author_id)) || null,
  body: t.deleted_at ? '' : t.body,
  deleted: Boolean(t.deleted_at),
  created_at: t.created_at,
  viewer: { can_delete: !t.deleted_at && Boolean(viewer.user && (viewer.user.id === t.author_id || viewer.admin)) },
});

wiki.get('/:space/pages/:slug/talk', async c => {
  const { viewer, page } = await loadPage(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM wiki_talk WHERE page_id = ? ORDER BY id LIMIT 500').bind(page.id).all<TalkRow>();
  const authors = await userCards(c.env, results.map(r => r.author_id ?? ''));
  return c.json({ items: results.map(r => talkJson(r, authors, viewer)), count: results.filter(r => !r.deleted_at).length });
});

wiki.post('/:space/pages/:slug/talk', async c => {
  const { space, viewer, page } = await loadPage(c);
  const user = requireUser(c);
  const input = await body(c);
  const text = typeof input.body === 'string' ? input.body.trim() : '';
  if (!text) fail(422, 'Write a comment first.');
  if ([...text].length > MAX_TALK) fail(422, `Comments are limited to ${MAX_TALK} characters.`);
  let parent: TalkRow | null = null;
  if (input.parent_id) {
    parent = await c.env.DB.prepare('SELECT * FROM wiki_talk WHERE id = ? AND page_id = ?').bind(str(input.parent_id, 40), page.id).first<TalkRow>();
    if (!parent || parent.deleted_at) fail(404, 'Comment not found.');
  }
  const now = Date.now();
  const row: TalkRow = {
    id: newId(now), page_id: page.id, author_id: user.id, parent_id: parent?.id ?? null,
    depth: parent ? Math.min(parent.depth + 1, MAX_TALK_DEPTH) : 0, body: text, created_at: now, deleted_at: null,
  };
  const link = pageLink(space.slug, page.slug, '/talk');
  const statements = [
    c.env.DB.prepare('INSERT INTO wiki_talk (id, page_id, author_id, parent_id, depth, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, row.page_id, row.author_id, row.parent_id, row.depth, row.body, row.created_at),
    watcherNotifications(c.env, page.id, user, `${user.name} commented on the talk page for ${page.title}.`, link, now, '1', [], parent?.author_id ?? null),
  ];
  const reply = parent?.author_id
    ? notifyStatement(c.env, { userId: parent.author_id, actorId: user.id, type: 'system', body: `${user.name} replied to you on the talk page for ${page.title}.`, link }, now)
    : null;
  if (reply) statements.push(reply);
  await c.env.DB.batch(statements);
  track(c, 'social_wiki_talk_posted', { wiki_id: space.id, page_id: page.id, reply: Boolean(parent) });
  return c.json({ comment: talkJson(row, new Map([[user.id, userCard(user as unknown as UserRow)]]), viewer) }, 201);
});

wiki.delete('/:space/pages/:slug/talk/:id', async c => {
  const { viewer, page } = await loadPage(c);
  const user = requireUser(c);
  const row = await c.env.DB.prepare('SELECT * FROM wiki_talk WHERE id = ? AND page_id = ?').bind(c.req.param('id'), page.id).first<TalkRow>();
  if (!row || row.deleted_at) fail(404, 'Comment not found.');
  if (row.author_id !== user.id && !viewer.admin) fail(403, 'You can only delete your own comments.');
  await c.env.DB.prepare('UPDATE wiki_talk SET deleted_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  return c.json({ ok: true });
});

// ── Watching ────────────────────────────────────────────────────────────

wiki.put('/:space/pages/:slug/watch', async c => {
  const { space, page } = await loadPage(c);
  const user = requireUser(c);
  await c.env.DB.prepare('INSERT OR IGNORE INTO wiki_watch (page_id, user_id, created_at) VALUES (?, ?, ?)').bind(page.id, user.id, Date.now()).run();
  track(c, 'social_wiki_page_watched', { wiki_id: space.id, page_id: page.id });
  return c.json({ watching: true });
});

wiki.delete('/:space/pages/:slug/watch', async c => {
  const { page } = await loadPage(c);
  const user = requireUser(c);
  await c.env.DB.prepare('DELETE FROM wiki_watch WHERE page_id = ? AND user_id = ?').bind(page.id, user.id).run();
  return c.json({ watching: false });
});

export default wiki;
