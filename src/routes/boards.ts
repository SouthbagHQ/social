// Boards (Pinterest). Mounted at /api/boards.
//
//   GET    /api/boards                    ?owner=<handle> | ?q=<title> | (signed in) your boards; &cursor -> { items: BoardJson[], next }
//   GET    /api/boards/mine               ?media_id -> { items: [{ id, title, visibility, pin_count, role, saved }] } (boards you can pin to)
//   GET    /api/boards/following          ?cursor -> { items: BoardJson[], next }
//   GET    /api/boards/feed               ?mode=recent&cursor -> { items: PinJson[], next, mode: following|recent }
//   GET    /api/boards/search             ?q&cursor -> { items: PinJson[], next } (pin titles and notes)
//   GET    /api/boards/pins/:pinId        -> { pin }
//   GET    /api/boards/pins/:pinId/related -> { items: PinJson[] } (same board, same source author, then popular)
//   PATCH  /api/boards/pins/:pinId        { title?, note?, link?, board_id? (move) } -> { pin }
//   DELETE /api/boards/pins/:pinId
//   POST   /api/boards                    { title, description?, visibility? } -> { board }
//   GET    /api/boards/:id                -> { board, collaborators: [{ user, role }], viewer: { role, can_edit, following } }
//   PATCH  /api/boards/:id                owner: { title?, description?, visibility?, cover_pin_id? } -> { board }
//   DELETE /api/boards/:id                owner
//   GET    /api/boards/:id/pins           ?cursor -> { items: PinJson[], next } (board order, top first)
//   POST   /api/boards/:id/pins           owner/editors, one of:
//                                          { post_id, media_id? }   save a post's photo (the post must be visible to you)
//                                          { pin_id }               repin
//                                          { media_id }             your own upload
//                                        plus { title?, note?, link? } -> 201 { pin }
//   PUT    /api/boards/:id/order          owner/editors: { pin_ids } -> the listed pins swap places to match this order
//   PUT    /api/boards/:id/follow         -> { following, follower_count }      DELETE: unfollow
//   POST   /api/boards/:id/collaborators  owner: { handle } -> 201 { collaborator } (sends an invitation)
//   POST   /api/boards/:id/collaborators/accept   invited person -> { role: 'editor' }
//   DELETE /api/boards/:id/collaborators/:handle  owner removes anyone; anyone can leave or decline
//
// BoardJson: { id, title, description, visibility, owner: UserCard, pin_count, follower_count, cover_pin_id,
//   covers: MediaJson[] (up to 3: the chosen cover, then the top pins), created_at, updated_at,
//   viewer: { following, is_owner } }
// PinJson: { id, board: { id, title, visibility, owner } | null, user: UserCard (who pinned it), image: MediaJson,
//   title, note, link, source_post_id, source_pin_id, save_count, position, created_at, viewer: { can_edit } }
//
// Who sees what: public boards are visible to everyone; secret boards to the owner and collaborators
// (including people with a pending invitation). Nobody sees boards of someone who blocked them. A pin
// saved from a post is shown only while that post exists and is visible to the viewer, so saving a
// friends-only photo to a public board never shows it to anyone else.

import { Hono } from 'hono';
import type { AppEnv, Ctx, Env, SessionUser } from '../env';
import { body, cursor, fail, limit, placeholders, requireUser } from '../lib/http';
import { newId } from '../lib/ids';
import { deleteUnusedMedia, mediaJson, ownedReadyMedia, type MediaJson, type MediaRow } from '../lib/media';
import { notifyStatement, type NotificationType } from '../lib/notify';
import { track } from '../lib/palantir';
import { loadVisiblePost, visibleTo } from '../lib/posts';
import { userByHandle, userCards, type UserCard } from '../lib/users';

const boards = new Hono<AppEnv>();

const MAX_TITLE = 50;
const MAX_DESCRIPTION = 500;
const MAX_PIN_TITLE = 100;
const MAX_NOTE = 500;
const MAX_LINK = 500;
const MAX_BOARDS = 200;
const MAX_PINS = 2000;
const MAX_COLLABORATORS = 50;
const RELATED = 24;

type Visibility = 'public' | 'secret';
type Role = 'owner' | 'editor' | 'invited' | null;

interface BoardRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  visibility: Visibility;
  cover_pin_id: string | null;
  pin_count: number;
  follower_count: number;
  created_at: number;
  updated_at: number;
}

interface PinRow {
  id: string;
  board_id: string;
  user_id: string;
  media_id: string;
  source_post_id: string | null;
  source_pin_id: string | null;
  title: string;
  note: string;
  link: string | null;
  position: number;
  save_count: number;
  created_at: number;
}

// ── Visibility ──────────────────────────────────────────────────────────

/** Boards (alias `b`) the viewer may see. */
function boardVisible(viewerId: string | null, b = 'b'): { sql: string; params: string[] } {
  if (!viewerId) return { sql: `${b}.visibility = 'public'`, params: [] };
  return {
    sql: `((${b}.visibility = 'public' OR ${b}.owner_id = ?
        OR EXISTS (SELECT 1 FROM board_collaborators bcv WHERE bcv.board_id = ${b}.id AND bcv.user_id = ?))
      AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.blocker_id = ${b}.owner_id AND bl.blocked_id = ?))`,
    params: [viewerId, viewerId, viewerId],
  };
}

/** Pins (alias `pn`) whose source post, if they have one, still exists and is visible to the viewer. */
function sourceVisible(viewerId: string | null, pn = 'pn'): { sql: string; params: string[] } {
  const v = visibleTo(viewerId, 'sp');
  return {
    sql: `(${pn}.source_post_id IS NULL OR EXISTS (SELECT 1 FROM posts sp WHERE sp.id = ${pn}.source_post_id
      AND sp.deleted_at IS NULL AND ${v.sql}))`,
    params: v.params,
  };
}

/** Pins (alias `pn`, joined to their board as `b`) the viewer may see. */
function pinVisible(viewerId: string | null): { sql: string; params: string[] } {
  const b = boardVisible(viewerId), s = sourceVisible(viewerId);
  return { sql: `${b.sql} AND ${s.sql}`, params: [...b.params, ...s.params] };
}

// ── Input ───────────────────────────────────────────────────────────────

/** Trimmed text, or a 422 when it is too long. */
function text(value: unknown, max: number, message: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if ([...s].length > max) fail(422, message);
  return s;
}

function link(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return null;
  if (s.length > MAX_LINK) fail(422, 'Links are limited to 500 characters.');
  let url: URL;
  try { url = new URL(s); } catch { fail(422, 'Links must start with https://'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(422, 'Links must start with https://');
  return url.href;
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;

/** Keyset cursor "<sort key>:<id>" for lists not ordered by id alone. */
function splitCursor(c: Ctx): [number, string] | null {
  const raw = cursor(c);
  const i = raw?.indexOf(':') ?? -1;
  if (!raw || i < 1) return null;
  const key = Number(raw.slice(0, i));
  return Number.isFinite(key) ? [key, raw.slice(i + 1)] : null;
}

// ── JSON ────────────────────────────────────────────────────────────────

async function boardsJson(env: Env, viewer: SessionUser | null, rows: BoardRow[]) {
  if (!rows.length) return [];
  const ids = rows.map(b => b.id);
  const s = sourceVisible(viewer?.id ?? null);
  const [coverRes, followRes, owners] = await Promise.all([
    env.DB.prepare(`SELECT * FROM (
        SELECT pn.board_id AS cover_board_id, m.*, ROW_NUMBER() OVER (PARTITION BY pn.board_id
          ORDER BY (pn.id = b.cover_pin_id) DESC, pn.position DESC, pn.id DESC) AS rn
        FROM pins pn JOIN boards b ON b.id = pn.board_id JOIN media m ON m.id = pn.media_id
        WHERE pn.board_id IN (${placeholders(ids.length)}) AND ${s.sql}
      ) WHERE rn <= 3 ORDER BY cover_board_id, rn`).bind(...ids, ...s.params).all<MediaRow & { cover_board_id: string }>(),
    viewer
      ? env.DB.prepare(`SELECT board_id FROM board_follows WHERE user_id = ? AND board_id IN (${placeholders(ids.length)})`)
          .bind(viewer.id, ...ids).all<{ board_id: string }>()
      : Promise.resolve({ results: [] as { board_id: string }[] }),
    userCards(env, rows.map(b => b.owner_id)),
  ]);
  const covers = new Map<string, MediaJson[]>();
  for (const m of coverRes.results) {
    if (!covers.has(m.cover_board_id)) covers.set(m.cover_board_id, []);
    covers.get(m.cover_board_id)!.push(mediaJson(m));
  }
  const following = new Set(followRes.results.map(f => f.board_id));
  return rows.map(b => ({
    id: b.id,
    title: b.title,
    description: b.description,
    visibility: b.visibility,
    owner: owners.get(b.owner_id) ?? null,
    pin_count: b.pin_count,
    follower_count: b.follower_count,
    cover_pin_id: b.cover_pin_id,
    covers: covers.get(b.id) ?? [],
    created_at: b.created_at,
    updated_at: b.updated_at,
    viewer: { following: following.has(b.id), is_owner: viewer?.id === b.owner_id },
  }));
}

async function pinsJson(env: Env, viewer: SessionUser | null, rows: PinRow[]) {
  if (!rows.length) return [];
  const mediaIds = [...new Set(rows.map(r => r.media_id))];
  const boardIds = [...new Set(rows.map(r => r.board_id))];
  const [mediaRes, boardRes] = await Promise.all([
    env.DB.prepare(`SELECT * FROM media WHERE id IN (${placeholders(mediaIds.length)})`).bind(...mediaIds).all<MediaRow>(),
    env.DB.prepare(`SELECT id, title, visibility, owner_id FROM boards WHERE id IN (${placeholders(boardIds.length)})`)
      .bind(...boardIds).all<{ id: string; title: string; visibility: Visibility; owner_id: string }>(),
  ]);
  const users = await userCards(env, [...rows.map(r => r.user_id), ...boardRes.results.map(b => b.owner_id)]);
  const media = new Map(mediaRes.results.map(m => [m.id, mediaJson(m)]));
  const boardMap = new Map(boardRes.results.map(b => [b.id, b]));
  const ghost = (id: string): UserCard => ({ id, handle: 'deleted', name: 'Former customer', avatar_url: null, verified: false });
  return rows.filter(r => media.has(r.media_id)).map(r => {
    const b = boardMap.get(r.board_id);
    return {
      id: r.id,
      board: b ? { id: b.id, title: b.title, visibility: b.visibility, owner: users.get(b.owner_id) ?? ghost(b.owner_id) } : null,
      user: users.get(r.user_id) ?? ghost(r.user_id),
      image: media.get(r.media_id)!,
      title: r.title,
      note: r.note,
      link: r.link,
      source_post_id: r.source_post_id,
      source_pin_id: r.source_pin_id,
      save_count: r.save_count,
      position: r.position,
      created_at: r.created_at,
      viewer: { can_edit: Boolean(viewer && (viewer.id === r.user_id || viewer.id === b?.owner_id)) },
    };
  });
}
export type PinJson = Awaited<ReturnType<typeof pinsJson>>[number];

// ── Loading with permission checks ─────────────────────────────────────

/** A board the viewer may see, and their role on it. 404 otherwise. */
async function loadBoard(c: Ctx, id: string): Promise<{ board: BoardRow; role: Role }> {
  const viewer = c.get('user');
  const v = boardVisible(viewer?.id ?? null);
  const row = await c.env.DB.prepare(`SELECT b.*, ${viewer ? '(SELECT role FROM board_collaborators WHERE board_id = b.id AND user_id = ?)' : 'NULL'} AS viewer_role
    FROM boards b WHERE b.id = ? AND ${v.sql}`).bind(...(viewer ? [viewer.id] : []), id, ...v.params)
    .first<BoardRow & { viewer_role: 'invited' | 'editor' | null }>();
  if (!row) fail(404, 'Board not found.');
  const { viewer_role, ...board } = row;
  return { board, role: viewer && board.owner_id === viewer.id ? 'owner' : viewer_role ?? null };
}

/** For actions that change pins: the owner and collaborators. */
async function editableBoard(c: Ctx, id: string): Promise<BoardRow> {
  requireUser(c);
  const { board, role } = await loadBoard(c, id);
  if (role !== 'owner' && role !== 'editor') fail(403, 'Only the board owner and collaborators can do that.');
  return board;
}

async function ownBoard(c: Ctx, id: string): Promise<BoardRow> {
  requireUser(c);
  const { board, role } = await loadBoard(c, id);
  if (role !== 'owner') fail(403, 'Only the board owner can do that.');
  return board;
}

/** A pin the viewer may see, with its board's owner. 404 otherwise. */
async function loadPin(c: Ctx, id: string): Promise<PinRow & { board_owner_id: string; board_title: string; board_visibility: Visibility }> {
  const viewer = c.get('user');
  const v = pinVisible(viewer?.id ?? null);
  const pin = await c.env.DB.prepare(`SELECT pn.*, b.owner_id AS board_owner_id, b.title AS board_title, b.visibility AS board_visibility
    FROM pins pn JOIN boards b ON b.id = pn.board_id WHERE pn.id = ? AND ${v.sql}`).bind(id, ...v.params)
    .first<PinRow & { board_owner_id: string; board_title: string; board_visibility: Visibility }>();
  if (!pin) fail(404, 'Pin not found.');
  return pin;
}

const pinWithBoard = `SELECT pn.* FROM pins pn JOIN boards b ON b.id = pn.board_id`;

async function onePin(c: Ctx, id: string) {
  const row = await c.env.DB.prepare('SELECT * FROM pins WHERE id = ?').bind(id).first<PinRow>();
  return (await pinsJson(c.env, c.get('user'), row ? [row] : []))[0] ?? null;
}

async function oneBoard(c: Ctx, id: string) {
  const row = await c.env.DB.prepare('SELECT * FROM boards WHERE id = ?').bind(id).first<BoardRow>();
  return (await boardsJson(c.env, c.get('user'), row ? [row] : []))[0] ?? null;
}

/** Pages of boards ordered by (key DESC, id DESC); `key` is a column expression. */
async function boardPage(c: Ctx, from: string, where: string[], params: unknown[], key = 'b.updated_at') {
  const size = limit(c, 24, 48);
  const after = splitCursor(c);
  if (after) {
    where.push(`(${key} < ? OR (${key} = ? AND b.id < ?))`);
    params.push(after[0], after[0], after[1]);
  }
  const { results } = await c.env.DB.prepare(`SELECT b.*, ${key} AS sort_key ${from} WHERE ${where.join(' AND ')}
    ORDER BY ${key} DESC, b.id DESC LIMIT ?`).bind(...params, size + 1).all<BoardRow & { sort_key: number }>();
  const rows = results.slice(0, size);
  const last = rows[rows.length - 1];
  return {
    items: await boardsJson(c.env, c.get('user'), rows.map(({ sort_key: _, ...b }) => b)),
    next: results.length > size && last ? `${last.sort_key}:${last.id}` : null,
  };
}

/** Pages of pins (newest first) matching extra conditions, limited to what the viewer may see. */
async function pinPage(c: Ctx, where: string[], params: unknown[]) {
  const viewer = c.get('user');
  const size = limit(c, 30, 50);
  const v = pinVisible(viewer?.id ?? null);
  const after = cursor(c);
  const conditions = [v.sql, ...where];
  const values = [...v.params, ...params];
  if (after) { conditions.push('pn.id < ?'); values.push(after); }
  const { results } = await c.env.DB.prepare(`${pinWithBoard} WHERE ${conditions.join(' AND ')} ORDER BY pn.id DESC LIMIT ?`)
    .bind(...values, size + 1).all<PinRow>();
  const rows = results.slice(0, size);
  return { items: await pinsJson(c.env, viewer, rows), next: results.length > size ? rows[rows.length - 1].id : null };
}

const noteFor = (env: Env, n: Parameters<typeof notifyStatement>[1], now: number) =>
  notifyStatement(env, { ...n, type: n.type as NotificationType }, now);

// ── Lists ───────────────────────────────────────────────────────────────

boards.get('/', async c => {
  const viewer = c.get('user');
  const v = boardVisible(viewer?.id ?? null);
  const q = (c.req.query('q') || '').trim().slice(0, 50);
  const owner = c.req.query('owner');
  if (q) return c.json(await boardPage(c, 'FROM boards b', [v.sql, `b.title LIKE ? ESCAPE '\\'`], [...v.params, like(q)]));
  let ownerId: string;
  if (owner) {
    const user = await userByHandle(c.env, owner);
    if (!user) fail(404, 'User not found.');
    ownerId = user.id;
  } else {
    ownerId = requireUser(c).id;
  }
  // Their own boards and group boards they collaborate on.
  return c.json(await boardPage(c, 'FROM boards b', [v.sql, `(b.owner_id = ? OR EXISTS (SELECT 1 FROM board_collaborators bc
    WHERE bc.board_id = b.id AND bc.user_id = ? AND bc.role = 'editor'))`], [...v.params, ownerId, ownerId]));
});

boards.get('/mine', async c => {
  const user = requireUser(c);
  const mediaId = c.req.query('media_id') || '';
  const { results } = await c.env.DB.prepare(`SELECT b.id, b.title, b.visibility, b.pin_count,
      CASE WHEN b.owner_id = ? THEN 'owner' ELSE 'editor' END AS role,
      EXISTS (SELECT 1 FROM pins pn WHERE pn.board_id = b.id AND pn.media_id = ?) AS saved
    FROM boards b WHERE b.owner_id = ? OR EXISTS (SELECT 1 FROM board_collaborators bc WHERE bc.board_id = b.id
      AND bc.user_id = ? AND bc.role = 'editor')
    ORDER BY b.updated_at DESC, b.id DESC LIMIT 200`).bind(user.id, mediaId, user.id, user.id)
    .all<{ id: string; title: string; visibility: Visibility; pin_count: number; role: Role; saved: number }>();
  return c.json({ items: results.map(b => ({ ...b, saved: Boolean(b.saved) })) });
});

boards.get('/following', async c => {
  const user = requireUser(c);
  const v = boardVisible(user.id);
  return c.json(await boardPage(c, 'FROM boards b JOIN board_follows bf ON bf.board_id = b.id AND bf.user_id = ?',
    [v.sql], [user.id, ...v.params], 'bf.created_at'));
});

// Home feed: pins from boards you follow and people you follow, newest first. When that is empty
// (or signed out) it falls back to recent public pins; the response says which.
boards.get('/feed', async c => {
  const viewer = c.get('user');
  let mode: 'following' | 'recent' = viewer && c.req.query('mode') !== 'recent' ? 'following' : 'recent';
  const run = (m: typeof mode) => m === 'following'
    ? pinPage(c, [`(pn.board_id IN (SELECT board_id FROM board_follows WHERE user_id = ?)
        OR pn.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?))`], [viewer!.id, viewer!.id])
    : pinPage(c, [`b.visibility = 'public'`], []);
  let result = await run(mode);
  if (mode === 'following' && !result.items.length && !cursor(c)) {
    mode = 'recent';
    result = await run(mode);
  }
  return c.json({ ...result, mode });
});

boards.get('/search', async c => {
  const q = (c.req.query('q') || '').trim().slice(0, 100);
  if (!q) return c.json({ items: [], next: null });
  return c.json(await pinPage(c, [`(pn.title LIKE ? ESCAPE '\\' OR pn.note LIKE ? ESCAPE '\\')`], [like(q), like(q)]));
});

// ── Pins ────────────────────────────────────────────────────────────────

boards.get('/pins/:pinId', async c => {
  const pin = await loadPin(c, c.req.param('pinId'));
  return c.json({ pin: (await pinsJson(c.env, c.get('user'), [pin]))[0] });
});

boards.get('/pins/:pinId/related', async c => {
  const viewer = c.get('user');
  const pin = await loadPin(c, c.req.param('pinId'));
  const v = pinVisible(viewer?.id ?? null);
  const base = `${pinWithBoard} WHERE ${v.sql} AND pn.id != ? AND pn.media_id != ?`;
  const params = [...v.params, pin.id, pin.media_id];
  const [sameBoard, sameAuthor, popular] = await Promise.all([
    c.env.DB.prepare(`${base} AND pn.board_id = ? ORDER BY pn.position DESC, pn.id DESC LIMIT ?`)
      .bind(...params, pin.board_id, RELATED).all<PinRow>(),
    // The source author is whoever owns the file: the post's author, or the person who uploaded it.
    c.env.DB.prepare(`${base} AND pn.media_id IN (SELECT id FROM media WHERE owner_id = (SELECT owner_id FROM media WHERE id = ?))
      ORDER BY pn.id DESC LIMIT ?`).bind(...params, pin.media_id, RELATED).all<PinRow>(),
    c.env.DB.prepare(`${base} AND b.visibility = 'public' ORDER BY pn.save_count DESC, pn.id DESC LIMIT ?`)
      .bind(...params, RELATED).all<PinRow>(),
  ]);
  const seenPins = new Set<string>(), seenMedia = new Set<string>();
  const rows: PinRow[] = [];
  for (const r of [...sameBoard.results, ...sameAuthor.results, ...popular.results]) {
    if (rows.length >= RELATED) break;
    if (seenPins.has(r.id) || seenMedia.has(r.media_id)) continue;
    seenPins.add(r.id);
    seenMedia.add(r.media_id);
    rows.push(r);
  }
  return c.json({ items: await pinsJson(c.env, viewer, rows) });
});

boards.patch('/pins/:pinId', async c => {
  const user = requireUser(c);
  const pin = await loadPin(c, c.req.param('pinId'));
  if (pin.user_id !== user.id && pin.board_owner_id !== user.id) fail(403, 'Only the person who saved this pin can change it.');
  const input = await body(c);
  const sets: string[] = [], values: unknown[] = [];
  if (input.title !== undefined) { sets.push('title = ?'); values.push(text(input.title, MAX_PIN_TITLE, 'Titles are limited to 100 characters.')); }
  if (input.note !== undefined) { sets.push('note = ?'); values.push(text(input.note, MAX_NOTE, 'Notes are limited to 500 characters.')); }
  if (input.link !== undefined) { sets.push('link = ?'); values.push(link(input.link)); }
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (typeof input.board_id === 'string' && input.board_id !== pin.board_id) {
    const target = await editableBoard(c, input.board_id);
    if (target.pin_count >= MAX_PINS) fail(422, 'That board is full.');
    const dupe = await c.env.DB.prepare('SELECT 1 FROM pins WHERE board_id = ? AND media_id = ?').bind(target.id, pin.media_id).first();
    if (dupe) fail(409, 'Already saved to that board.');
    sets.push('board_id = ?', 'position = (SELECT COALESCE(MAX(position), 0) + 1 FROM pins WHERE board_id = ?)');
    values.push(target.id, target.id);
    statements.push(
      c.env.DB.prepare(`UPDATE boards SET pin_count = MAX(0, pin_count - 1),
        cover_pin_id = CASE WHEN cover_pin_id = ? THEN NULL ELSE cover_pin_id END WHERE id = ?`).bind(pin.id, pin.board_id),
      c.env.DB.prepare('UPDATE boards SET pin_count = pin_count + 1, updated_at = ? WHERE id = ?').bind(now, target.id),
    );
  }
  if (sets.length) {
    await c.env.DB.batch([c.env.DB.prepare(`UPDATE pins SET ${sets.join(', ')} WHERE id = ?`).bind(...values, pin.id), ...statements]);
  }
  return c.json({ pin: await onePin(c, pin.id) });
});

boards.delete('/pins/:pinId', async c => {
  const user = requireUser(c);
  const pin = await loadPin(c, c.req.param('pinId'));
  if (pin.user_id !== user.id && pin.board_owner_id !== user.id) fail(403, 'Only the person who saved this pin can delete it.');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM pins WHERE id = ?').bind(pin.id),
    c.env.DB.prepare(`UPDATE boards SET pin_count = MAX(0, pin_count - 1),
      cover_pin_id = CASE WHEN cover_pin_id = ? THEN NULL ELSE cover_pin_id END WHERE id = ?`).bind(pin.id, pin.board_id),
  ]);
  // An uploaded photo goes when its last pin does; a post's photo stays with the post.
  await deleteUnusedMedia(c.env, [pin.media_id]);
  track(c, 'social_pin_deleted', { pin_id: pin.id, board_id: pin.board_id });
  return c.json({ ok: true });
});

// ── Boards ──────────────────────────────────────────────────────────────

function boardFields(input: Record<string, unknown>, partial: boolean) {
  const fields: Partial<Pick<BoardRow, 'title' | 'description' | 'visibility'>> = {};
  if (!partial || input.title !== undefined) {
    const title = text(input.title, MAX_TITLE, 'Board names are limited to 50 characters.');
    if (!title) fail(422, 'Give your board a name.');
    fields.title = title;
  }
  if (!partial || input.description !== undefined)
    fields.description = text(input.description, MAX_DESCRIPTION, 'Descriptions are limited to 500 characters.');
  if (!partial || input.visibility !== undefined) {
    const visibility = input.visibility ?? 'public';
    if (visibility !== 'public' && visibility !== 'secret') fail(422, 'Boards are public or secret.');
    fields.visibility = visibility;
  }
  return fields;
}

async function titleTaken(env: Env, ownerId: string, title: string, exceptId = ''): Promise<boolean> {
  return Boolean(await env.DB.prepare('SELECT 1 FROM boards WHERE owner_id = ? AND title = ? COLLATE NOCASE AND id != ?')
    .bind(ownerId, title, exceptId).first());
}

boards.post('/', async c => {
  const user = requireUser(c);
  const fields = boardFields(await body(c), false);
  const [taken, owned] = await Promise.all([
    titleTaken(c.env, user.id, fields.title!),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM boards WHERE owner_id = ?').bind(user.id).first<{ n: number }>(),
  ]);
  if (taken) fail(409, 'You already have a board with that name.');
  if ((owned?.n ?? 0) >= MAX_BOARDS) fail(422, `You can have up to ${MAX_BOARDS} boards.`);
  const now = Date.now();
  const id = newId(now);
  await c.env.DB.prepare(`INSERT INTO boards (id, owner_id, title, description, visibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, user.id, fields.title, fields.description, fields.visibility, now, now).run();
  track(c, 'social_board_created', { board_id: id, visibility: fields.visibility });
  return c.json({ board: await oneBoard(c, id) }, 201);
});

boards.get('/:id', async c => {
  const viewer = c.get('user');
  const { board, role } = await loadBoard(c, c.req.param('id'));
  const [json, collabRes] = await Promise.all([
    boardsJson(c.env, viewer, [board]),
    c.env.DB.prepare(`SELECT user_id, role, created_at FROM board_collaborators WHERE board_id = ?
      ORDER BY created_at LIMIT ${MAX_COLLABORATORS}`).bind(board.id).all<{ user_id: string; role: 'invited' | 'editor'; created_at: number }>(),
  ]);
  // Pending invitations are only shown to the owner.
  const collabs = collabRes.results.filter(r => r.role === 'editor' || role === 'owner');
  const users = await userCards(c.env, collabs.map(r => r.user_id));
  return c.json({
    board: json[0],
    collaborators: collabs.filter(r => users.has(r.user_id)).map(r => ({ user: users.get(r.user_id)!, role: r.role })),
    viewer: { role, can_edit: role === 'owner' || role === 'editor', following: json[0].viewer.following },
  });
});

boards.patch('/:id', async c => {
  const user = requireUser(c);
  const board = await ownBoard(c, c.req.param('id'));
  const input = await body(c);
  const fields = boardFields(input, true);
  if (fields.title && await titleTaken(c.env, user.id, fields.title, board.id)) fail(409, 'You already have a board with that name.');
  const sets: string[] = [], values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) { sets.push(`${key} = ?`); values.push(value); }
  if (input.cover_pin_id !== undefined) {
    let cover: string | null = null;
    if (input.cover_pin_id) {
      const pin = await c.env.DB.prepare('SELECT id FROM pins WHERE id = ? AND board_id = ?').bind(input.cover_pin_id, board.id).first<{ id: string }>();
      if (!pin) fail(422, 'That pin is not on this board.');
      cover = pin.id;
    }
    sets.push('cover_pin_id = ?');
    values.push(cover);
  }
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE boards SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...values, Date.now(), board.id).run();
    track(c, 'social_board_updated', { board_id: board.id, fields: Object.keys(fields) });
  }
  return c.json({ board: await oneBoard(c, board.id) });
});

boards.delete('/:id', async c => {
  const board = await ownBoard(c, c.req.param('id'));
  // Uploaded photos that only this board used are removed too. Capped so one request stays within
  // the free plan's query budget; anything past that is left for the next file cleanup.
  const { results } = await c.env.DB.prepare('SELECT DISTINCT media_id FROM pins WHERE board_id = ? LIMIT 20')
    .bind(board.id).all<{ media_id: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM pins WHERE board_id = ?').bind(board.id),
    c.env.DB.prepare('DELETE FROM board_collaborators WHERE board_id = ?').bind(board.id),
    c.env.DB.prepare('DELETE FROM board_follows WHERE board_id = ?').bind(board.id),
    c.env.DB.prepare('DELETE FROM boards WHERE id = ?').bind(board.id),
  ]);
  await deleteUnusedMedia(c.env, results.map(r => r.media_id));
  track(c, 'social_board_deleted', { board_id: board.id });
  return c.json({ ok: true });
});

boards.get('/:id/pins', async c => {
  const viewer = c.get('user');
  const { board } = await loadBoard(c, c.req.param('id'));
  const size = limit(c, 30, 50);
  const s = sourceVisible(viewer?.id ?? null);
  const where = ['pn.board_id = ?', s.sql];
  const params: unknown[] = [board.id, ...s.params];
  const after = splitCursor(c);
  if (after) {
    where.push('(pn.position < ? OR (pn.position = ? AND pn.id < ?))');
    params.push(after[0], after[0], after[1]);
  }
  const { results } = await c.env.DB.prepare(`SELECT pn.* FROM pins pn WHERE ${where.join(' AND ')}
    ORDER BY pn.position DESC, pn.id DESC LIMIT ?`).bind(...params, size + 1).all<PinRow>();
  const rows = results.slice(0, size);
  const last = rows[rows.length - 1];
  return c.json({
    items: await pinsJson(c.env, viewer, rows),
    next: results.length > size && last ? `${last.position}:${last.id}` : null,
  });
});

boards.post('/:id/pins', async c => {
  const user = requireUser(c);
  const board = await editableBoard(c, c.req.param('id'));
  if (board.pin_count >= MAX_PINS) fail(422, 'This board is full.');
  const input = await body(c);
  let mediaId: string;
  let sourcePostId: string | null = null;
  let origin: Awaited<ReturnType<typeof loadPin>> | null = null;
  let defaults = { title: '', note: '', link: null as string | null };
  let source: 'repin' | 'post' | 'upload';

  if (typeof input.pin_id === 'string') {
    source = 'repin';
    origin = await loadPin(c, input.pin_id);
    mediaId = origin.media_id;
    sourcePostId = origin.source_post_id;
    defaults = { title: origin.title, note: origin.note, link: origin.link };
  } else if (typeof input.post_id === 'string') {
    source = 'post';
    const post = await loadVisiblePost(c.env, user.id, input.post_id);
    if (!post || post.deleted_at) fail(404, 'Post not found.');
    const wanted = typeof input.media_id === 'string' ? input.media_id : null;
    const image = await c.env.DB.prepare(`SELECT m.id FROM post_media pm JOIN media m ON m.id = pm.media_id
      WHERE pm.post_id = ? AND m.kind = 'image' AND m.status = 'ready' AND (? IS NULL OR m.id = ?)
      ORDER BY pm.position LIMIT 1`).bind(post.id, wanted, wanted).first<{ id: string }>();
    if (!image) fail(422, wanted ? 'That photo is not in this post.' : 'That post has no photo to save.');
    mediaId = image.id;
    sourcePostId = post.id;
    const firstLine = (post.title || post.body.split('\n')[0] || '').trim();
    defaults.title = [...firstLine].slice(0, MAX_PIN_TITLE).join('');
  } else if (typeof input.media_id === 'string') {
    source = 'upload';
    let rows: MediaRow[];
    try { rows = await ownedReadyMedia(c.env, user.id, [input.media_id]); } catch { fail(422, 'Upload a photo first.'); }
    if (rows[0].kind !== 'image') fail(422, 'Only photos can be pinned.');
    mediaId = rows[0].id;
  } else {
    fail(422, 'Choose a photo to save.');
  }

  const title = input.title !== undefined ? text(input.title, MAX_PIN_TITLE, 'Titles are limited to 100 characters.') : defaults.title;
  const note = input.note !== undefined ? text(input.note, MAX_NOTE, 'Notes are limited to 500 characters.') : defaults.note;
  const url = input.link !== undefined ? link(input.link) : defaults.link;
  const dupe = await c.env.DB.prepare('SELECT 1 FROM pins WHERE board_id = ? AND media_id = ?').bind(board.id, mediaId).first();
  if (dupe) fail(409, 'Already saved to this board.');

  const now = Date.now();
  const id = newId(now);
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO pins (id, board_id, user_id, media_id, source_post_id, source_pin_id, title, note, link, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM pins WHERE board_id = ?), ?)`)
      .bind(id, board.id, user.id, mediaId, sourcePostId, origin?.id ?? null, title, note, url, board.id, now),
    c.env.DB.prepare('UPDATE boards SET pin_count = pin_count + 1, updated_at = ? WHERE id = ?').bind(now, board.id),
  ];
  if (origin) {
    statements.push(c.env.DB.prepare('UPDATE pins SET save_count = save_count + 1 WHERE id = ?').bind(origin.id));
    // Saving to a secret board stays quiet.
    if (board.visibility === 'public') {
      const note = noteFor(c.env, { userId: origin.user_id, actorId: user.id, type: 'pin_saved' as NotificationType,
        body: `${user.name} saved your pin to "${board.title}".`, link: `/boards/${board.id}?pin=${id}` }, now);
      if (note) statements.push(note);
    }
  }
  await c.env.DB.batch(statements);
  track(c, 'social_pin_saved', { pin_id: id, board_id: board.id, source });
  return c.json({ pin: await onePin(c, id) }, 201);
});

boards.put('/:id/order', async c => {
  const board = await editableBoard(c, c.req.param('id'));
  const input = await body<{ pin_ids?: unknown }>(c);
  const ids = Array.isArray(input.pin_ids) ? [...new Set(input.pin_ids.filter((x): x is string => typeof x === 'string'))] : [];
  if (ids.length < 2 || ids.length > 50) fail(422, 'Choose 2 to 50 pins to reorder.');
  const { results } = await c.env.DB.prepare(`SELECT id, position FROM pins WHERE board_id = ? AND id IN (${placeholders(ids.length)})`)
    .bind(board.id, ...ids).all<{ id: string; position: number }>();
  if (results.length !== ids.length) fail(422, 'Those pins are not all on this board.');
  // The pins keep the same set of places; they just swap into the order given (first = highest).
  const places = results.map(r => r.position).sort((a, b) => b - a);
  await c.env.DB.batch(ids.map((id, i) => c.env.DB.prepare('UPDATE pins SET position = ? WHERE id = ?').bind(places[i], id)));
  return c.json({ ok: true, positions: Object.fromEntries(ids.map((id, i) => [id, places[i]])) });
});

// ── Follows ─────────────────────────────────────────────────────────────

boards.put('/:id/follow', async c => {
  const user = requireUser(c);
  const { board, role } = await loadBoard(c, c.req.param('id'));
  if (role === 'owner') fail(422, 'This is your board.');
  const now = Date.now();
  const res = await c.env.DB.prepare('INSERT OR IGNORE INTO board_follows (board_id, user_id, created_at) VALUES (?, ?, ?)')
    .bind(board.id, user.id, now).run();
  let count = board.follower_count;
  if (res.meta.changes) {
    count++;
    const statements = [c.env.DB.prepare('UPDATE boards SET follower_count = follower_count + 1 WHERE id = ?').bind(board.id)];
    const note = noteFor(c.env, { userId: board.owner_id, actorId: user.id, type: 'board_follow' as NotificationType,
      body: `${user.name} followed your board "${board.title}".`, link: `/boards/${board.id}` }, now);
    if (note) statements.push(note);
    await c.env.DB.batch(statements);
    track(c, 'social_board_followed', { board_id: board.id });
  }
  return c.json({ following: true, follower_count: count });
});

boards.delete('/:id/follow', async c => {
  const user = requireUser(c);
  const { board } = await loadBoard(c, c.req.param('id'));
  const res = await c.env.DB.prepare('DELETE FROM board_follows WHERE board_id = ? AND user_id = ?').bind(board.id, user.id).run();
  let count = board.follower_count;
  if (res.meta.changes) {
    count = Math.max(0, count - 1);
    await c.env.DB.prepare('UPDATE boards SET follower_count = MAX(0, follower_count - 1) WHERE id = ?').bind(board.id).run();
    track(c, 'social_board_unfollowed', { board_id: board.id });
  }
  return c.json({ following: false, follower_count: count });
});

// ── Collaborators (group boards) ───────────────────────────────────────

boards.post('/:id/collaborators', async c => {
  const user = requireUser(c);
  const board = await ownBoard(c, c.req.param('id'));
  const input = await body(c);
  const handle = typeof input.handle === 'string' ? input.handle.trim() : '';
  if (!handle) fail(422, 'Enter a username.');
  const invitee = await userByHandle(c.env, handle);
  if (!invitee) fail(404, 'User not found.');
  if (invitee.id === user.id) fail(422, 'You own this board.');
  const [blocked, existing, total] = await Promise.all([
    c.env.DB.prepare(`SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`)
      .bind(user.id, invitee.id, invitee.id, user.id).first(),
    c.env.DB.prepare('SELECT role FROM board_collaborators WHERE board_id = ? AND user_id = ?').bind(board.id, invitee.id).first<{ role: string }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM board_collaborators WHERE board_id = ?').bind(board.id).first<{ n: number }>(),
  ]);
  if (blocked) fail(403, 'You cannot invite this person.');
  if (existing) fail(409, existing.role === 'editor' ? 'Already a collaborator.' : 'Already invited.');
  if ((total?.n ?? 0) >= MAX_COLLABORATORS) fail(422, `Boards can have up to ${MAX_COLLABORATORS} collaborators.`);
  const now = Date.now();
  const statements = [c.env.DB.prepare(`INSERT INTO board_collaborators (board_id, user_id, role, invited_by, created_at)
    VALUES (?, ?, 'invited', ?, ?)`).bind(board.id, invitee.id, user.id, now)];
  const note = noteFor(c.env, { userId: invitee.id, actorId: user.id, type: 'board_invite' as NotificationType,
    body: `${user.name} invited you to collaborate on "${board.title}".`, link: `/boards/${board.id}` }, now);
  if (note) statements.push(note);
  await c.env.DB.batch(statements);
  track(c, 'social_board_collaborator_invited', { board_id: board.id });
  const cards = await userCards(c.env, [invitee.id]);
  return c.json({ collaborator: { user: cards.get(invitee.id), role: 'invited' } }, 201);
});

boards.post('/:id/collaborators/accept', async c => {
  const user = requireUser(c);
  const { board, role } = await loadBoard(c, c.req.param('id'));
  if (role === 'editor') return c.json({ role: 'editor' });
  if (role !== 'invited') fail(404, 'No invitation found.');
  const now = Date.now();
  const statements = [c.env.DB.prepare(`UPDATE board_collaborators SET role = 'editor' WHERE board_id = ? AND user_id = ?`).bind(board.id, user.id)];
  const note = noteFor(c.env, { userId: board.owner_id, actorId: user.id, type: 'board_join' as NotificationType,
    body: `${user.name} joined your board "${board.title}".`, link: `/boards/${board.id}` }, now);
  if (note) statements.push(note);
  await c.env.DB.batch(statements);
  track(c, 'social_board_collaborator_joined', { board_id: board.id });
  return c.json({ role: 'editor' });
});

boards.delete('/:id/collaborators/:handle', async c => {
  const user = requireUser(c);
  const { board, role } = await loadBoard(c, c.req.param('id'));
  const target = await userByHandle(c.env, c.req.param('handle'));
  if (!target) fail(404, 'User not found.');
  if (role !== 'owner' && target.id !== user.id) fail(403, 'Only the board owner can do that.');
  const res = await c.env.DB.prepare('DELETE FROM board_collaborators WHERE board_id = ? AND user_id = ?').bind(board.id, target.id).run();
  if (!res.meta.changes) fail(404, 'Not a collaborator.');
  return c.json({ ok: true });
});

export default boards;
