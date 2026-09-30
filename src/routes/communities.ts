// Communities (Reddit style). Mounted at /api/communities. Threads and comments live in their own
// tables (migrations/0004_communities.sql), so nothing here reaches the social feeds.
//
//   GET    /api/communities                         ?sort=popular|new&tab=mine&q&cursor -> { items: CommunityJson[], next }
//   POST   /api/communities                         { name, title?, description?, rules?, icon_media_id?, banner_media_id? } -> { community }
//   GET    /api/communities/feed                    ?sort=hot|new|top&t&cursor -> { items: ThreadJson[], next, source: 'joined'|'popular' }
//   PUT    /api/communities/votes                   { target_type: thread|comment, target_id, value: 1|-1|0 }
//                                                   -> { target_type, target_id, score, upvotes, downvotes, vote }
//   GET    /api/communities/:name                   -> { community, moderators: [{ user, role }], viewer: { role } }
//   PATCH  /api/communities/:name                   moderators: { title?, description?, rules?, icon_media_id?, banner_media_id? } -> { community }
//   POST   /api/communities/:name/join              -> { viewer: { role }, member_count }
//   DELETE /api/communities/:name/join              -> { viewer: { role: null }, member_count }  (owners cannot leave)
//   PUT    /api/communities/:name/moderators/:handle     owner: make a member a moderator -> { member: { user, role } }
//   DELETE /api/communities/:name/moderators/:handle     owner: back to member -> { member: { user, role } }
//   GET    /api/communities/:name/threads           ?sort=hot|new|top&t=day|week|month|all&cursor -> { items: ThreadJson[], next }
//   POST   /api/communities/:name/threads           { title, kind: text|link|image, body?, url?, media_id? } -> { thread }
//   GET    /api/communities/:name/threads/:id       -> { thread }
//   PATCH  /api/communities/:name/threads/:id       author: { body? }  moderators: { pinned?, locked?, removed? } -> { thread }
//   DELETE /api/communities/:name/threads/:id       author only (moderators remove instead) -> { ok }
//   GET    /api/communities/:name/threads/:id/comments          ?sort=top|new -> { items: CommentJson[] (nested), count }
//   POST   /api/communities/:name/threads/:id/comments          { body, parent_id? } -> { comment }
//   PATCH  /api/communities/:name/threads/:id/comments/:cid     author: { body } -> { comment }
//   DELETE /api/communities/:name/threads/:id/comments/:cid     author (deleted) or moderator (removed) -> { ok }
//
// CommunityJson: { id, name, title, description, rules: string[], icon_url, banner_url, member_count, thread_count,
//                  created_at, role }  (role = the viewer's: owner|moderator|member|null)
// ThreadJson: { id, community: { name, title, icon_url }, author: UserCard|null, title, kind, body, url, image_url,
//               score, upvotes, downvotes, comment_count, pinned, locked, removed, deleted, created_at, edited_at,
//               vote: 1|-1|0, viewer: { can_edit, can_delete, can_moderate } }
// CommentJson: { id, parent_id, depth, author: UserCard|null, body, score, vote, removed, deleted, created_at, edited_at,
//                viewer: { can_edit, can_delete }, children: CommentJson[] }
//
// Ranking: New is id desc; Top is score desc within a time window; Hot is Reddit's
// sign(score) * log10(max(|score|, 1)) + created_seconds / 45000, stored in threads.hot and refreshed on
// each vote (D1 has no log10, so it is computed here). Authors upvote their own threads and comments.
// Comment and reply notifications use type 'reply' with post_id NULL; the body is
// "/c/<name>/<threadId> <snippet>" (the first word is the link).

import { Hono } from 'hono';
import type { AppEnv, Ctx, Env, SessionUser } from '../env';
import { body, cursor, fail, limit, placeholders, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { deleteMedia, getMedia } from '../lib/media';
import { notifyStatement } from '../lib/notify';
import { userByHandle, userCard, userCardColumns, type UserRow } from '../lib/users';

const communities = new Hono<AppEnv>();

type Role = 'owner' | 'moderator' | 'member';
type Kind = 'text' | 'link' | 'image';

interface CommunityRow {
  id: string;
  name: string;
  title: string;
  description: string;
  rules: string;
  icon_media_id: string | null;
  banner_media_id: string | null;
  owner_id: string;
  member_count: number;
  thread_count: number;
  created_at: number;
}

interface ThreadRow {
  id: string;
  community_id: string;
  author_id: string | null;
  title: string;
  kind: Kind;
  body: string;
  url: string | null;
  media_id: string | null;
  score: number;
  upvotes: number;
  downvotes: number;
  comment_count: number;
  hot: number;
  pinned: number;
  locked: number;
  removed: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

/** A thread joined with its community and author (see THREAD_SELECT). */
interface ThreadFullRow extends ThreadRow {
  c_name: string;
  c_title: string;
  c_icon: string | null;
  u_id: string | null;
  u_handle: string | null;
  u_name: string | null;
  u_avatar: string | null;
  u_picture: string | null;
  u_verified: number | null;
}

interface CommentRow {
  id: string;
  thread_id: string;
  parent_id: string | null;
  depth: number;
  author_id: string | null;
  body: string;
  score: number;
  upvotes: number;
  downvotes: number;
  removed: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

const NAME_RE = /^[A-Za-z0-9_]{3,21}$/;
const RESERVED = new Set(['feed', 'votes', 'all', 'popular', 'new', 'create', 'home', 'mod', 'mods', 'admin', 'southbag']);
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 500;
const MAX_RULES = 15;
const MAX_RULE = 200;
const MAX_THREAD_TITLE = 300;
const MAX_THREAD_BODY = 10000;
const MAX_URL = 2000;
const MAX_COMMENT = 5000;
const MAX_DEPTH = 6; // comment levels shown and allowed (depth 0..5)
const MAX_COMMENTS = 500; // loaded per thread in one query
const WINDOWS: Record<string, number> = { day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };

const isMod = (role: Role | null) => role === 'owner' || role === 'moderator';
const mediaUrl = (id: string | null) => (id ? `/media/${id}` : null);

/** Reddit's hot rank. */
export function hotScore(score: number, createdAt: number): number {
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
  return Math.round((sign * order + createdAt / 1000 / 45000) * 1e7) / 1e7;
}

const communityJson = (c: CommunityRow, role: Role | null) => ({
  id: c.id,
  name: c.name,
  title: c.title,
  description: c.description,
  rules: c.rules ? c.rules.split('\n').filter(Boolean) : [],
  icon_url: mediaUrl(c.icon_media_id),
  banner_url: mediaUrl(c.banner_media_id),
  member_count: c.member_count,
  thread_count: c.thread_count,
  created_at: c.created_at,
  role,
});

const THREAD_SELECT = `SELECT t.*, c.name AS c_name, c.title AS c_title, c.icon_media_id AS c_icon,
    u.id AS u_id, u.handle AS u_handle, u.name AS u_name, u.avatar_media_id AS u_avatar, u.identity_picture AS u_picture,
    u.verified AS u_verified
  FROM threads t JOIN communities c ON c.id = t.community_id LEFT JOIN users u ON u.id = t.author_id`;

const authorCard = (r: { u_id: string | null; u_handle: string | null; u_name: string | null; u_avatar: string | null; u_picture: string | null; u_verified: number | null }) =>
  r.u_id ? userCard({ id: r.u_id, handle: r.u_handle!, name: r.u_name!, avatar_media_id: r.u_avatar, identity_picture: r.u_picture, verified: r.u_verified ?? 0 }) : null;

function threadJson(t: ThreadFullRow, vote: number, viewerId: string | null, moderator: boolean) {
  const mine = Boolean(viewerId && t.author_id === viewerId);
  const deleted = Boolean(t.deleted_at);
  const removed = Boolean(t.removed);
  // Removed threads keep their text for their author and the moderators.
  const hidden = deleted || (removed && !mine && !moderator);
  return {
    id: t.id,
    community: { name: t.c_name, title: t.c_title, icon_url: mediaUrl(t.c_icon) },
    author: deleted ? null : authorCard(t),
    title: t.title,
    kind: t.kind,
    body: hidden ? '' : t.body,
    url: hidden ? null : t.url,
    image_url: hidden ? null : mediaUrl(t.media_id),
    score: t.score,
    upvotes: t.upvotes,
    downvotes: t.downvotes,
    comment_count: t.comment_count,
    pinned: Boolean(t.pinned),
    locked: Boolean(t.locked),
    removed,
    deleted,
    created_at: t.created_at,
    edited_at: t.edited_at,
    vote,
    viewer: { can_edit: mine && !deleted && t.kind === 'text', can_delete: mine && !deleted, can_moderate: moderator && !deleted },
  };
}
type ThreadJson = ReturnType<typeof threadJson>;

/** The viewer's votes on a set of targets. */
async function votesFor(env: Env, userId: string | null, type: 'thread' | 'comment', ids: string[]): Promise<Map<string, number>> {
  if (!userId || !ids.length) return new Map();
  const { results } = await env.DB.prepare(`SELECT target_id, value FROM thread_votes
      WHERE user_id = ? AND target_type = ? AND target_id IN (${placeholders(ids.length)})`)
    .bind(userId, type, ...ids).all<{ target_id: string; value: number }>();
  return new Map(results.map(r => [r.target_id, r.value]));
}

/** Thread rows to JSON with the viewer's votes (one extra query). */
async function threadsJson(env: Env, user: SessionUser | null, rows: ThreadFullRow[], moderator = false): Promise<ThreadJson[]> {
  const votes = await votesFor(env, user?.id ?? null, 'thread', rows.map(r => r.id));
  return rows.map(r => threadJson(r, votes.get(r.id) ?? 0, user?.id ?? null, moderator));
}

/** The community by name plus the viewer's role in it, or a 404. */
async function load(c: Ctx): Promise<{ community: CommunityRow; role: Role | null; user: SessionUser | null }> {
  const user = c.get('user');
  const row = await c.env.DB.prepare(`SELECT c.*, ${user ? '(SELECT role FROM community_members WHERE community_id = c.id AND user_id = ?)' : 'NULL'} AS viewer_role
      FROM communities c WHERE c.name = ?`)
    .bind(...(user ? [user.id] : []), c.req.param('name')).first<CommunityRow & { viewer_role: Role | null }>();
  if (!row) fail(404, 'Community not found.');
  const { viewer_role: role, ...community } = row;
  return { community, role, user };
}

/** A thread in the named community, with the viewer's role and vote, or a 404. One query. */
async function loadThread(c: Ctx): Promise<{ thread: ThreadFullRow; role: Role | null; vote: number; user: SessionUser | null }> {
  const user = c.get('user');
  const row = await c.env.DB.prepare(`SELECT t.*, c.name AS c_name, c.title AS c_title, c.icon_media_id AS c_icon,
        u.id AS u_id, u.handle AS u_handle, u.name AS u_name, u.avatar_media_id AS u_avatar, u.identity_picture AS u_picture,
        u.verified AS u_verified,
        (SELECT role FROM community_members WHERE community_id = t.community_id AND user_id = ?1) AS viewer_role,
        (SELECT value FROM thread_votes WHERE target_type = 'thread' AND target_id = t.id AND user_id = ?1) AS viewer_vote
      FROM threads t JOIN communities c ON c.id = t.community_id LEFT JOIN users u ON u.id = t.author_id
      WHERE t.id = ?2 AND c.name = ?3`)
    .bind(user?.id ?? '', c.req.param('id'), c.req.param('name'))
    .first<ThreadFullRow & { viewer_role: Role | null; viewer_vote: number | null }>();
  if (!row) fail(404, 'Post not found.');
  const { viewer_role: role, viewer_vote: vote, ...thread } = row;
  return { thread, role, vote: vote ?? 0, user };
}

/** A media id the user may use as a community picture (their own ready image), or null to clear. */
async function pictureId(env: Env, userId: string, value: unknown): Promise<string | null> {
  if (value === null || value === '' || value === undefined) return null;
  const file = typeof value === 'string' ? await getMedia(env, value) : null;
  if (!file || file.owner_id !== userId || file.kind !== 'image' || file.status !== 'ready') fail(422, 'Upload an image first.');
  return file.id;
}

/** Deletes files that nothing else refers to any more. */
async function dropUnused(env: Env, ids: (string | null)[]): Promise<void> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return;
  const { results } = await env.DB.prepare(`SELECT m.id FROM media m WHERE m.id IN (${placeholders(unique.length)})
      AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.media_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_media_id = m.id OR u.banner_media_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.avatar_media_id = m.id OR g.banner_media_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM communities c WHERE c.icon_media_id = m.id OR c.banner_media_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.media_id = m.id)`)
    .bind(...unique).all<{ id: string }>();
  await deleteMedia(env, results.map(r => r.id));
}

// ── Validation ──────────────────────────────────────────────────────────

function validName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/^c\//i, '') : '';
  if (!NAME_RE.test(name)) fail(422, 'Community names are 3 to 21 letters, numbers or underscores.');
  if (RESERVED.has(name.toLowerCase())) fail(409, 'That name is reserved.');
  return name;
}

function validText(value: unknown, max: number, what: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if ([...text].length > max) fail(422, `${what} are limited to ${max} characters.`);
  return text;
}

function validRules(value: unknown): string {
  const lines = (Array.isArray(value) ? value.map(v => String(v ?? '')) : typeof value === 'string' ? value.split('\n') : [])
    .map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (lines.length > MAX_RULES) fail(422, `Communities can have up to ${MAX_RULES} rules.`);
  if (lines.some(l => [...l].length > MAX_RULE)) fail(422, `Rules are limited to ${MAX_RULE} characters each.`);
  return lines.join('\n');
}

function validUrl(value: unknown): string {
  const text = str(value, MAX_URL + 1);
  if (!text) fail(422, 'Add a link.');
  if (text.length > MAX_URL) fail(422, `Links are limited to ${MAX_URL} characters.`);
  let url: URL;
  try { url = new URL(text); } catch { fail(422, 'That link is not valid.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(422, 'Links must start with http or https.');
  return url.href;
}

function validCommentBody(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) fail(422, 'Write a comment first.');
  if ([...text].length > MAX_COMMENT) fail(422, `Comments are limited to ${MAX_COMMENT} characters.`);
  return text;
}

const snippet = (text: string, max = 120) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? chars.slice(0, max - 3).join('') + '...' : chars.join('');
};

// ── Communities ─────────────────────────────────────────────────────────

communities.get('/', async c => {
  const user = c.get('user');
  const size = limit(c, 24);
  const sort = c.req.query('sort') === 'new' ? 'new' : 'popular';
  const mine = c.req.query('tab') === 'mine';
  const q = str(c.req.query('q'), 40).replace(/[%_\\]/g, m => `\\${m}`);
  if (mine && !user) return c.json({ items: [], next: null });
  const after = cursor(c);
  const offset = Math.max(0, Number(after) || 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (mine) where.push('cm.role IS NOT NULL');
  if (q) { where.push(`(c.name LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')`); params.push(`%${q}%`, `%${q}%`); }
  const keyset = !mine && sort === 'new';
  if (keyset && after) { where.push('c.id < ?'); params.push(after); }
  const order = mine ? 'c.name COLLATE NOCASE, c.id' : sort === 'new' ? 'c.id DESC' : 'c.member_count DESC, c.id DESC';
  const { results } = await c.env.DB.prepare(`SELECT c.*, ${user ? 'cm.role' : 'NULL'} AS viewer_role FROM communities c
      ${user ? 'LEFT JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = ?' : ''}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${order} LIMIT ? ${keyset ? '' : 'OFFSET ?'}`)
    .bind(...(user ? [user.id] : []), ...params, size + 1, ...(keyset ? [] : [offset]))
    .all<CommunityRow & { viewer_role: Role | null }>();
  const items = results.slice(0, size).map(r => communityJson(r, r.viewer_role));
  const more = results.length > size;
  return c.json({ items, next: more ? (keyset ? items[items.length - 1].id : String(offset + size)) : null });
});

communities.post('/', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const name = validName(input.name);
  const title = validText(input.title, MAX_TITLE, 'Titles') || name;
  const description = validText(input.description, MAX_DESCRIPTION, 'Descriptions');
  const rules = validRules(input.rules);
  const [iconId, bannerId] = await Promise.all([
    pictureId(c.env, user.id, input.icon_media_id),
    pictureId(c.env, user.id, input.banner_media_id),
  ]);
  const taken = await c.env.DB.prepare('SELECT 1 FROM communities WHERE name = ?').bind(name).first();
  if (taken) fail(409, 'That name is taken.');
  const now = Date.now();
  const id = newId(now);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO communities (id, name, title, description, rules, icon_media_id, banner_media_id, owner_id,
        member_count, thread_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`)
        .bind(id, name, title, description, rules, iconId, bannerId, user.id, now),
      c.env.DB.prepare(`INSERT INTO community_members (community_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`).bind(id, user.id, now),
    ]);
  } catch (err) {
    if (String(err).includes('UNIQUE')) fail(409, 'That name is taken.');
    throw err;
  }
  const row = await c.env.DB.prepare('SELECT * FROM communities WHERE id = ?').bind(id).first<CommunityRow>();
  return c.json({ community: communityJson(row!, 'owner') }, 201);
});

// Threads from the communities you joined, or from popular communities when signed out (or none joined).
communities.get('/feed', async c => {
  const user = c.get('user');
  let source: 'joined' | 'popular' = 'popular';
  if (user) {
    const joined = await c.env.DB.prepare('SELECT 1 FROM community_members WHERE user_id = ? LIMIT 1').bind(user.id).first();
    if (joined) source = 'joined';
  }
  const scope = source === 'joined'
    ? { sql: 't.community_id IN (SELECT community_id FROM community_members WHERE user_id = ?)', params: [user!.id] }
    : { sql: 't.community_id IN (SELECT id FROM communities ORDER BY member_count DESC, id DESC LIMIT 50)', params: [] };
  const result = await listThreads(c, scope, false);
  return c.json({ ...result, source });
});

// Votes on threads and comments. One read, one batch (the score change reads the old vote inside
// the same transaction, so repeating a vote changes nothing), then the hot rank.
communities.put('/votes', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const type = input.target_type === 'comment' ? 'comment' : input.target_type === 'thread' ? 'thread' : null;
  if (!type) fail(422, 'Votes are for posts or comments.');
  const targetId = str(input.target_id, 40);
  const value = Number(input.value);
  if (![1, -1, 0].includes(value)) fail(422, 'Votes are 1, -1 or 0.');
  const table = type === 'thread' ? 'threads' : 'thread_comments';
  const target = type === 'thread'
    ? await c.env.DB.prepare('SELECT id, deleted_at, removed FROM threads WHERE id = ?').bind(targetId).first<{ id: string; deleted_at: number | null; removed: number }>()
    : await c.env.DB.prepare(`SELECT tc.id, COALESCE(tc.deleted_at, t.deleted_at) AS deleted_at, MAX(tc.removed, t.removed) AS removed
        FROM thread_comments tc JOIN threads t ON t.id = tc.thread_id WHERE tc.id = ?`).bind(targetId).first<{ id: string; deleted_at: number | null; removed: number }>();
  if (!target || target.deleted_at || target.removed) fail(404, type === 'thread' ? 'Post not found.' : 'Comment not found.');

  const old = `(SELECT value FROM thread_votes WHERE target_type = ?1 AND target_id = ?2 AND user_id = ?3)`;
  const now = Date.now();
  const [, , fresh] = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ${table} SET
        score = score + ?4 - COALESCE(${old}, 0),
        upvotes = upvotes + (?4 = 1) - COALESCE(${old} = 1, 0),
        downvotes = downvotes + (?4 = -1) - COALESCE(${old} = -1, 0)
      WHERE id = ?2`).bind(type, target.id, user.id, value),
    value === 0
      ? c.env.DB.prepare('DELETE FROM thread_votes WHERE target_type = ? AND target_id = ? AND user_id = ?').bind(type, target.id, user.id)
      : c.env.DB.prepare(`INSERT INTO thread_votes (target_type, target_id, user_id, value, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (target_type, target_id, user_id) DO UPDATE SET value = excluded.value`).bind(type, target.id, user.id, value, now),
    c.env.DB.prepare(`SELECT score, upvotes, downvotes, created_at FROM ${table} WHERE id = ?`).bind(target.id),
  ]);
  const row = (fresh.results as { score: number; upvotes: number; downvotes: number; created_at: number }[])[0];
  if (type === 'thread') {
    // Guarded by score so a concurrent vote never leaves a stale rank behind: its own update wins.
    await c.env.DB.prepare('UPDATE threads SET hot = ? WHERE id = ? AND score = ?')
      .bind(hotScore(row.score, row.created_at), target.id, row.score).run();
  }
  return c.json({ target_type: type, target_id: target.id, score: row.score, upvotes: row.upvotes, downvotes: row.downvotes, vote: value });
});

communities.get('/:name', async c => {
  const { community, role } = await load(c);
  const { results } = await c.env.DB.prepare(`SELECT cm.role, ${userCardColumns.split(', ').map(col => 'u.' + col).join(', ')}
      FROM community_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.community_id = ? AND cm.role IN ('owner', 'moderator')
      ORDER BY CASE cm.role WHEN 'owner' THEN 0 ELSE 1 END, cm.created_at LIMIT 25`)
    .bind(community.id).all<UserRow & { role: Role }>();
  return c.json({
    community: communityJson(community, role),
    moderators: results.map(r => ({ user: userCard(r), role: r.role })),
    viewer: { role },
  });
});

communities.patch('/:name', async c => {
  const user = requireUser(c);
  const { community, role } = await load(c);
  if (!isMod(role)) fail(403, 'Only moderators can change this community.');
  const input = await body(c);
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); values.push(value); };
  const replaced: (string | null)[] = [];
  if ('title' in input) set('title', validText(input.title, MAX_TITLE, 'Titles') || community.name);
  if ('description' in input) set('description', validText(input.description, MAX_DESCRIPTION, 'Descriptions'));
  if ('rules' in input) set('rules', validRules(input.rules));
  for (const column of ['icon_media_id', 'banner_media_id'] as const) {
    if (!(column in input)) continue;
    const id = await pictureId(c.env, user.id, input[column]);
    if (id !== community[column]) replaced.push(community[column]);
    set(column, id);
  }
  if (!sets.length) fail(422, 'Nothing to change.');
  await c.env.DB.prepare(`UPDATE communities SET ${sets.join(', ')} WHERE id = ?`).bind(...values, community.id).run();
  await dropUnused(c.env, replaced);
  const fresh = await c.env.DB.prepare('SELECT * FROM communities WHERE id = ?').bind(community.id).first<CommunityRow>();
  return c.json({ community: communityJson(fresh!, role) });
});

// ── Membership and moderators ───────────────────────────────────────────

communities.post('/:name/join', async c => {
  const user = requireUser(c);
  const { community, role } = await load(c);
  if (role) return c.json({ viewer: { role }, member_count: community.member_count });
  const [, fresh] = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE communities SET member_count = member_count + 1 WHERE id = ?1
        AND NOT EXISTS (SELECT 1 FROM community_members WHERE community_id = ?1 AND user_id = ?2)`).bind(community.id, user.id),
    c.env.DB.prepare('SELECT member_count FROM communities WHERE id = ?').bind(community.id),
    c.env.DB.prepare(`INSERT OR IGNORE INTO community_members (community_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`)
      .bind(community.id, user.id, Date.now()),
  ]);
  return c.json({ viewer: { role: 'member' }, member_count: (fresh.results[0] as { member_count: number }).member_count });
});

communities.delete('/:name/join', async c => {
  const user = requireUser(c);
  const { community, role } = await load(c);
  if (!role) return c.json({ viewer: { role: null }, member_count: community.member_count });
  if (role === 'owner') fail(409, 'Owners cannot leave their community.');
  const [, fresh] = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE communities SET member_count = MAX(0, member_count - 1) WHERE id = ?1
        AND EXISTS (SELECT 1 FROM community_members WHERE community_id = ?1 AND user_id = ?2)`).bind(community.id, user.id),
    c.env.DB.prepare('SELECT member_count FROM communities WHERE id = ?').bind(community.id),
    c.env.DB.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').bind(community.id, user.id),
  ]);
  return c.json({ viewer: { role: null }, member_count: (fresh.results[0] as { member_count: number }).member_count });
});

async function setModerator(c: Ctx, next: 'moderator' | 'member') {
  requireUser(c);
  const { community, role } = await load(c);
  if (role !== 'owner') fail(403, 'Only the owner can change moderators.');
  const target = await userByHandle(c.env, c.req.param('handle') || '');
  const membership = target && await c.env.DB.prepare('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?')
    .bind(community.id, target.id).first<{ role: Role }>();
  if (!target || !membership) fail(404, 'That person is not a member.');
  if (membership.role === 'owner') fail(409, 'The owner cannot be changed.');
  await c.env.DB.prepare('UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?').bind(next, community.id, target.id).run();
  return c.json({ member: { user: userCard(target), role: next } });
}
communities.put('/:name/moderators/:handle', c => setModerator(c, 'moderator'));
communities.delete('/:name/moderators/:handle', c => setModerator(c, 'member'));

// ── Threads ─────────────────────────────────────────────────────────────

/**
 * A page of threads in `scope`, sorted by ?sort=hot|new|top (&t= for top). New uses keyset paging on
 * id; Hot and Top use offset paging (their order moves with votes anyway). The first Hot page of a
 * single community lists its pinned threads first.
 */
async function listThreads(c: Ctx, scope: { sql: string; params: unknown[] }, withPinned: boolean, moderator = false) {
  const user = c.get('user');
  const sort = ['hot', 'new', 'top'].includes(c.req.query('sort') || '') ? c.req.query('sort')! : 'hot';
  const size = limit(c, 25);
  const after = cursor(c);
  const offset = Math.max(0, Number(after) || 0);
  const where = [scope.sql, 't.deleted_at IS NULL', 't.removed = 0'];
  const params = [...scope.params];
  let order: string;
  if (sort === 'new') {
    order = 't.id DESC';
    if (after) { where.push('t.id < ?'); params.push(after); }
  } else if (sort === 'top') {
    order = 't.score DESC, t.id DESC';
    const window = WINDOWS[c.req.query('t') || ''];
    if (window) { where.push('t.created_at >= ?'); params.push(Date.now() - window); }
  } else {
    order = 't.hot DESC, t.id DESC';
    if (withPinned) where.push('t.pinned = 0');
  }
  const paged = sort !== 'new';
  const statements = [
    c.env.DB.prepare(`${THREAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? ${paged ? 'OFFSET ?' : ''}`)
      .bind(...params, size + 1, ...(paged ? [offset] : [])),
  ];
  const pinnedFirst = withPinned && sort === 'hot' && !after;
  if (pinnedFirst) {
    statements.push(c.env.DB.prepare(`${THREAD_SELECT} WHERE ${scope.sql} AND t.deleted_at IS NULL AND t.removed = 0 AND t.pinned = 1
        ORDER BY t.id DESC LIMIT 5`).bind(...scope.params));
  }
  const [main, pinned] = await c.env.DB.batch<ThreadFullRow>(statements);
  const rows = main.results.slice(0, size);
  const all = [...(pinnedFirst ? pinned.results : []), ...rows];
  const items = await threadsJson(c.env, user, all, moderator);
  const more = main.results.length > size;
  return { items, next: more ? (paged ? String(offset + size) : rows[rows.length - 1].id) : null };
}

communities.get('/:name/threads', async c => {
  const { community, role } = await load(c);
  return c.json(await listThreads(c, { sql: 't.community_id = ?', params: [community.id] }, true, isMod(role)));
});

communities.post('/:name/threads', async c => {
  const user = requireUser(c);
  const { community, role } = await load(c);
  const input = await body(c);
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) fail(422, 'Add a title.');
  if ([...title].length > MAX_THREAD_TITLE) fail(422, `Titles are limited to ${MAX_THREAD_TITLE} characters.`);
  const kind: Kind = input.kind === 'link' ? 'link' : input.kind === 'image' ? 'image' : 'text';
  let text = '';
  let url: string | null = null;
  let mediaId: string | null = null;
  if (kind === 'text') {
    text = validText(input.body, MAX_THREAD_BODY, 'Posts');
  } else if (kind === 'link') {
    url = validUrl(input.url);
  } else {
    if (!input.media_id) fail(422, 'Add an image.');
    mediaId = await pictureId(c.env, user.id, input.media_id);
  }
  const now = Date.now();
  const id = newId(now);
  // Authors upvote their own posts, as on Reddit.
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO threads (id, community_id, author_id, title, kind, body, url, media_id, score, upvotes, hot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`)
      .bind(id, community.id, user.id, title, kind, text, url, mediaId, hotScore(1, now), now),
    c.env.DB.prepare(`INSERT INTO thread_votes (target_type, target_id, user_id, value, created_at) VALUES ('thread', ?, ?, 1, ?)`).bind(id, user.id, now),
    c.env.DB.prepare('UPDATE communities SET thread_count = thread_count + 1 WHERE id = ?').bind(community.id),
  ]);
  const row = await c.env.DB.prepare(`${THREAD_SELECT} WHERE t.id = ?`).bind(id).first<ThreadFullRow>();
  return c.json({ thread: threadJson(row!, 1, user.id, isMod(role)) }, 201);
});

communities.get('/:name/threads/:id', async c => {
  const { thread, role, vote, user } = await loadThread(c);
  const mod = isMod(role);
  if (thread.removed && !mod && thread.author_id !== user?.id && !thread.comment_count) fail(404, 'Post not found.');
  return c.json({ thread: threadJson(thread, vote, user?.id ?? null, mod) });
});

communities.patch('/:name/threads/:id', async c => {
  const user = requireUser(c);
  const { thread, role, vote } = await loadThread(c);
  if (thread.deleted_at) fail(404, 'Post not found.');
  const input = await body(c);
  const mine = thread.author_id === user.id;
  const mod = isMod(role);
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); values.push(value); };
  const statements: D1PreparedStatement[] = [];

  if ('body' in input) {
    if (!mine) fail(403, 'Only the author can edit this post.');
    if (thread.kind !== 'text') fail(422, 'Only text posts can be edited.');
    set('body', validText(input.body, MAX_THREAD_BODY, 'Posts'));
    set('edited_at', Date.now());
  }
  const flags = (['pinned', 'locked', 'removed'] as const).filter(k => k in input);
  if (flags.length && !mod) fail(403, 'Only moderators can do that.');
  for (const flag of flags) set(flag, input[flag] ? 1 : 0);
  if ('removed' in input && Boolean(input.removed) !== Boolean(thread.removed)) {
    statements.push(c.env.DB.prepare(`UPDATE communities SET thread_count = MAX(0, thread_count ${input.removed ? '- 1' : '+ 1'}) WHERE id = ?`)
      .bind(thread.community_id));
    if (input.removed) set('pinned', 0);
  }
  if (!sets.length) fail(422, 'Nothing to change.');
  statements.unshift(c.env.DB.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).bind(...values, thread.id));
  statements.push(c.env.DB.prepare(`${THREAD_SELECT} WHERE t.id = ?`).bind(thread.id));
  const results = await c.env.DB.batch<ThreadFullRow>(statements);
  const fresh = results[results.length - 1].results[0];
  return c.json({ thread: threadJson(fresh, vote, user.id, mod) });
});

communities.delete('/:name/threads/:id', async c => {
  const user = requireUser(c);
  const { thread } = await loadThread(c);
  if (thread.deleted_at) fail(404, 'Post not found.');
  if (thread.author_id !== user.id) fail(403, 'Only the author can delete this post.');
  const statements = [
    c.env.DB.prepare(`UPDATE threads SET deleted_at = ?, body = '', url = NULL, media_id = NULL, pinned = 0 WHERE id = ?`)
      .bind(Date.now(), thread.id),
  ];
  if (!thread.removed) statements.push(c.env.DB.prepare('UPDATE communities SET thread_count = MAX(0, thread_count - 1) WHERE id = ?').bind(thread.community_id));
  await c.env.DB.batch(statements);
  await dropUnused(c.env, [thread.media_id]);
  return c.json({ ok: true });
});

// ── Comments ────────────────────────────────────────────────────────────

interface CommentJson {
  id: string;
  parent_id: string | null;
  depth: number;
  author: ReturnType<typeof authorCard>;
  body: string;
  score: number;
  vote: number;
  removed: boolean;
  deleted: boolean;
  created_at: number;
  edited_at: number | null;
  viewer: { can_edit: boolean; can_delete: boolean };
  children: CommentJson[];
}
function commentJson(r: CommentRow & { u_id: string | null; u_handle: string | null; u_name: string | null; u_avatar: string | null; u_picture: string | null; u_verified: number | null },
  vote: number, viewerId: string | null, moderator: boolean): CommentJson {
  const mine = Boolean(viewerId && r.author_id === viewerId);
  const gone = Boolean(r.deleted_at || r.removed);
  return {
    id: r.id,
    parent_id: r.parent_id,
    depth: r.depth,
    author: r.deleted_at ? null : authorCard(r),
    body: gone ? '' : r.body,
    score: r.score,
    vote,
    removed: Boolean(r.removed),
    deleted: Boolean(r.deleted_at),
    created_at: r.created_at,
    edited_at: r.edited_at,
    viewer: { can_edit: mine && !gone, can_delete: (mine || moderator) && !gone },
    children: [] as CommentJson[],
  };
}

const COMMENT_SELECT = `SELECT tc.*, u.id AS u_id, u.handle AS u_handle, u.name AS u_name, u.avatar_media_id AS u_avatar,
    u.identity_picture AS u_picture, u.verified AS u_verified
  FROM thread_comments tc LEFT JOIN users u ON u.id = tc.author_id`;

communities.get('/:name/threads/:id/comments', async c => {
  const { thread, role, user } = await loadThread(c);
  const sort = c.req.query('sort') === 'new' ? 'new' : 'top';
  const viewerId = user?.id ?? null;
  // Every comment of the thread (up to MAX_COMMENTS) with authors and the viewer's votes in one query.
  const { results } = await c.env.DB.prepare(`SELECT tc.*, u.id AS u_id, u.handle AS u_handle, u.name AS u_name,
        u.avatar_media_id AS u_avatar, u.identity_picture AS u_picture, u.verified AS u_verified, v.value AS viewer_vote
      FROM thread_comments tc LEFT JOIN users u ON u.id = tc.author_id
      LEFT JOIN thread_votes v ON v.target_type = 'comment' AND v.target_id = tc.id AND v.user_id = ?
      WHERE tc.thread_id = ? AND tc.depth < ? ORDER BY tc.id LIMIT ?`)
    .bind(viewerId ?? '', thread.id, MAX_DEPTH, MAX_COMMENTS)
    .all<CommentRow & { u_id: string | null; u_handle: string | null; u_name: string | null; u_avatar: string | null; u_picture: string | null; u_verified: number | null; viewer_vote: number | null }>();

  const mod = isMod(role);
  const byId = new Map<string, CommentJson>();
  const roots: CommentJson[] = [];
  for (const r of results) byId.set(r.id, commentJson(r, r.viewer_vote ?? 0, viewerId, mod));
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : null;
    if (parent) parent.children.push(node);
    else if (!node.parent_id) roots.push(node);
  }
  const compare = sort === 'new'
    ? (a: CommentJson, b: CommentJson) => (a.id < b.id ? 1 : -1)
    : (a: CommentJson, b: CommentJson) => b.score - a.score || (a.id < b.id ? -1 : 1);
  // Sort every level, and drop deleted or removed comments that have no replies left.
  const tidy = (list: CommentJson[]): CommentJson[] => list
    .map(n => ({ ...n, children: tidy(n.children) }))
    .filter(n => !(n.deleted || n.removed) || n.children.length)
    .sort(compare);
  const items = tidy(roots);
  let count = 0;
  const walk = (list: CommentJson[]) => { for (const n of list) { count++; walk(n.children); } };
  walk(items);
  return c.json({ items, count });
});

communities.post('/:name/threads/:id/comments', async c => {
  const user = requireUser(c);
  const { thread, role } = await loadThread(c);
  if (thread.deleted_at || thread.removed) fail(404, 'Post not found.');
  const mod = isMod(role);
  if (thread.locked && !mod) fail(403, 'This post is locked.');
  const input = await body(c);
  const text = validCommentBody(input.body);
  let parent: { id: string; author_id: string | null; depth: number } | null = null;
  if (input.parent_id) {
    parent = await c.env.DB.prepare(`SELECT id, author_id, depth FROM thread_comments
        WHERE id = ? AND thread_id = ? AND deleted_at IS NULL AND removed = 0`)
      .bind(str(input.parent_id, 40), thread.id).first<{ id: string; author_id: string | null; depth: number }>();
    if (!parent) fail(404, 'Comment not found.');
    if (parent.depth >= MAX_DEPTH - 1) fail(422, 'Replies go up to 6 levels deep.');
  }
  const now = Date.now();
  const id = newId(now);
  const statements = [
    c.env.DB.prepare(`INSERT INTO thread_comments (id, thread_id, parent_id, depth, author_id, body, score, upvotes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`)
      .bind(id, thread.id, parent?.id ?? null, parent ? parent.depth + 1 : 0, user.id, text, now),
    c.env.DB.prepare(`INSERT INTO thread_votes (target_type, target_id, user_id, value, created_at) VALUES ('comment', ?, ?, 1, ?)`).bind(id, user.id, now),
    c.env.DB.prepare('UPDATE threads SET comment_count = comment_count + 1 WHERE id = ?').bind(thread.id),
  ];
  const recipient = parent ? parent.author_id : thread.author_id;
  const note = recipient && notifyStatement(c.env, {
    userId: recipient, actorId: user.id, type: 'reply', postId: null, body: `/c/${thread.c_name}/${thread.id} ${snippet(text)}`,
  }, now);
  if (note) statements.push(note);
  await c.env.DB.batch(statements);
  const row = await c.env.DB.prepare(`${COMMENT_SELECT} WHERE tc.id = ?`).bind(id)
    .first<CommentRow & { u_id: string | null; u_handle: string | null; u_name: string | null; u_avatar: string | null; u_picture: string | null; u_verified: number | null }>();
  return c.json({ comment: commentJson(row!, 1, user.id, mod) }, 201);
});

/** A comment of the loaded thread, or a 404. */
async function loadComment(c: Ctx, threadId: string) {
  const row = await c.env.DB.prepare(`${COMMENT_SELECT} WHERE tc.id = ? AND tc.thread_id = ?`).bind(c.req.param('cid'), threadId)
    .first<CommentRow & { u_id: string | null; u_handle: string | null; u_name: string | null; u_avatar: string | null; u_picture: string | null; u_verified: number | null }>();
  if (!row || row.deleted_at || row.removed) fail(404, 'Comment not found.');
  return row;
}

communities.patch('/:name/threads/:id/comments/:cid', async c => {
  const user = requireUser(c);
  const { thread, role } = await loadThread(c);
  const comment = await loadComment(c, thread.id);
  if (comment.author_id !== user.id) fail(403, 'Only the author can edit this comment.');
  const text = validCommentBody((await body(c)).body);
  const now = Date.now();
  await c.env.DB.prepare('UPDATE thread_comments SET body = ?, edited_at = ? WHERE id = ?').bind(text, now, comment.id).run();
  const vote = (await votesFor(c.env, user.id, 'comment', [comment.id])).get(comment.id) ?? 0;
  return c.json({ comment: commentJson({ ...comment, body: text, edited_at: now }, vote, user.id, isMod(role)) });
});

communities.delete('/:name/threads/:id/comments/:cid', async c => {
  const user = requireUser(c);
  const { thread, role } = await loadThread(c);
  const comment = await loadComment(c, thread.id);
  const mine = comment.author_id === user.id;
  if (!mine && !isMod(role)) fail(403, 'Only the author or a moderator can delete this comment.');
  await c.env.DB.batch([
    mine
      ? c.env.DB.prepare(`UPDATE thread_comments SET deleted_at = ?, body = '' WHERE id = ?`).bind(Date.now(), comment.id)
      : c.env.DB.prepare('UPDATE thread_comments SET removed = 1 WHERE id = ?').bind(comment.id),
    c.env.DB.prepare('UPDATE threads SET comment_count = MAX(0, comment_count - 1) WHERE id = ?').bind(thread.id),
  ]);
  return c.json({ ok: true });
});

export default communities;
