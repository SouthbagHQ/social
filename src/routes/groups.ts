// Groups. Public groups show everything to everyone; private groups show their name,
// description and admins to everyone and their posts only to members. Joining a private group
// files a request that the owner or an admin approves. Posting uses POST /api/posts with group_id.
//
//   POST   /api/groups                        { name, slug?, description, privacy, avatar_media_id?, banner_media_id? } -> { group }
//   GET    /api/groups                        ?tab=mine|discover&q&cursor -> { items: GroupJson[], next }
//   GET    /api/groups/:slug                  -> { group: GroupJson & { owner }, viewer: { role } }
//   PATCH  /api/groups/:slug                  owner/admin: { name?, description?, privacy?, avatar_media_id?, banner_media_id? } -> { group }
//   DELETE /api/groups/:slug                  owner only (posts go with it)
//   POST   /api/groups/:slug/join             -> { viewer: { role } }  public -> member, private -> pending
//   DELETE /api/groups/:slug/join             leave, or withdraw a request (owners must delete instead)
//   GET    /api/groups/:slug/members          ?cursor -> { items: [{ user, role, created_at }], next }
//   POST   /api/groups/:slug/members/:handle  admins: { action: approve|promote|demote|remove } -> { member }
//   GET    /api/groups/:slug/posts            ?cursor -> { items: PostJson[], next }
//
// GroupJson: { id, slug, name, description, privacy, member_count, post_count, avatar_url, banner_url,
//              created_at, role }  (role = the viewer's: owner|admin|member|pending|null)
// Group posts come back with viewer.can_delete = true for owners and admins (they may remove posts).

import { Hono } from 'hono';
import type { AppEnv, Ctx, Env, SessionUser } from '../env';
import { body, cursor, fail, limit, page, placeholders, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { deleteUnusedMedia, getMedia } from '../lib/media';
import { notifyStatement } from '../lib/notify';
import { hydrate, visibleTo, type PostRow } from '../lib/posts';
import { userByHandle, userCard, userCardColumns, type UserRow } from '../lib/users';

const groups = new Hono<AppEnv>();

type Role = 'owner' | 'admin' | 'member' | 'pending';
type Privacy = 'public' | 'private';

interface GroupRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatar_media_id: string | null;
  banner_media_id: string | null;
  owner_id: string;
  privacy: Privacy;
  member_count: number;
  post_count: number;
  created_at: number;
}

const MAX_NAME = 60;
const MAX_DESCRIPTION = 1000;
const RESERVED = new Set(['new', 'discover', 'mine', 'southbag', 'admin']);

const groupJson = (g: GroupRow, role: Role | null) => ({
  id: g.id,
  slug: g.slug,
  name: g.name,
  description: g.description,
  privacy: g.privacy,
  member_count: g.member_count,
  post_count: g.post_count,
  avatar_url: g.avatar_media_id ? `/media/${g.avatar_media_id}` : null,
  banner_url: g.banner_media_id ? `/media/${g.banner_media_id}` : null,
  created_at: g.created_at,
  role,
});

const isAdmin = (role: Role | null) => role === 'owner' || role === 'admin';
const isMember = (role: Role | null) => role === 'owner' || role === 'admin' || role === 'member';

/** "Weekend Cyclists!" -> "weekend-cyclists" */
export const slugify = (text: string): string =>
  text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

/** The group by slug plus the viewer's role in it, or a 404. */
async function load(c: Ctx): Promise<{ group: GroupRow; role: Role | null; user: SessionUser | null }> {
  const user = c.get('user');
  const row = await c.env.DB.prepare(`SELECT g.*, ${user ? '(SELECT role FROM group_members WHERE group_id = g.id AND user_id = ?)' : 'NULL'} AS viewer_role
      FROM groups g WHERE g.slug = ?`)
    .bind(...(user ? [user.id] : []), c.req.param('slug')).first<GroupRow & { viewer_role: Role | null }>();
  if (!row) fail(404, 'Group not found.');
  const { viewer_role: role, ...group } = row;
  return { group, role, user };
}

/** A media id the user may use as a group picture (their own ready image), or null to clear. */
async function pictureId(env: Env, userId: string, value: unknown): Promise<string | null> {
  if (value === null || value === '') return null;
  const file = typeof value === 'string' ? await getMedia(env, value) : null;
  if (!file || file.owner_id !== userId || file.kind !== 'image' || file.status !== 'ready') fail(422, 'Upload an image first.');
  return file.id;
}

/** Deletes files that nothing else refers to any more (old avatars and banners, a deleted group's photos). */
async function dropUnused(env: Env, ids: (string | null)[]): Promise<void> {
  await deleteUnusedMedia(env, ids);
}

function validName(value: unknown): string {
  const name = str(value, MAX_NAME * 2).replace(/\s+/g, ' ');
  if ([...name].length < 3) fail(422, 'Group names need at least 3 characters.');
  if ([...name].length > MAX_NAME) fail(422, `Group names are limited to ${MAX_NAME} characters.`);
  return name;
}

function validDescription(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if ([...text].length > MAX_DESCRIPTION) fail(422, `Descriptions are limited to ${MAX_DESCRIPTION} characters.`);
  return text;
}

const validPrivacy = (value: unknown): Privacy => (value === 'private' ? 'private' : 'public');

// Create and list

groups.post('/', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const name = validName(input.name);
  const description = validDescription(input.description);
  const privacy = validPrivacy(input.privacy);
  const [avatarId, bannerId] = await Promise.all([
    input.avatar_media_id ? pictureId(c.env, user.id, input.avatar_media_id) : null,
    input.banner_media_id ? pictureId(c.env, user.id, input.banner_media_id) : null,
  ]);

  let slug: string;
  if (typeof input.slug === 'string' && input.slug.trim()) {
    slug = slugify(input.slug);
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) fail(422, 'Group addresses are 3 to 40 letters, numbers or dashes.');
    if (RESERVED.has(slug)) fail(409, 'That address is reserved.');
    const taken = await c.env.DB.prepare('SELECT 1 FROM groups WHERE slug = ?').bind(slug).first();
    if (taken) fail(409, 'That address is taken.');
  } else {
    let base = slugify(name);
    if (base.length < 3) base = `group-${base}`.replace(/-+$/, '');
    if (RESERVED.has(base)) base = `${base}-group`;
    const { results } = await c.env.DB.prepare('SELECT slug FROM groups WHERE slug = ? OR slug LIKE ?')
      .bind(base, `${base}-%`).all<{ slug: string }>();
    const used = new Set(results.map(r => r.slug.toLowerCase()));
    slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base.slice(0, 36)}-${n}`;
  }

  const now = Date.now();
  const id = newId(now);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO groups (id, slug, name, description, avatar_media_id, banner_media_id, owner_id, privacy,
      member_count, post_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`)
      .bind(id, slug, name, description, avatarId, bannerId, user.id, privacy, now),
    c.env.DB.prepare(`INSERT INTO group_members (group_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`).bind(id, user.id, now),
  ]);
  const group = await c.env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(id).first<GroupRow>();
  return c.json({ group: groupJson(group!, 'owner') }, 201);
});

groups.get('/', async c => {
  const user = c.get('user');
  const tab = c.req.query('tab') === 'mine' ? 'mine' : 'discover';
  const size = limit(c, 24);
  const after = cursor(c);
  const q = str(c.req.query('q'), 60).replace(/[%_]/g, '');
  if (tab === 'mine' && !user) return c.json({ items: [], next: null });

  const where: string[] = [];
  const params: unknown[] = [];
  if (tab === 'mine') {
    where.push('gm.role IS NOT NULL');
  } else if (user) {
    where.push(`(gm.role IS NULL OR gm.role = 'pending')`);
  }
  if (after) { where.push('g.id < ?'); params.push(after); }
  if (q) { where.push('g.name LIKE ?'); params.push(`%${q}%`); }
  const { results } = await c.env.DB.prepare(`SELECT g.*, ${user ? 'gm.role' : 'NULL'} AS viewer_role FROM groups g
      ${user ? 'LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?' : ''}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY g.id DESC LIMIT ?`)
    .bind(...(user ? [user.id] : []), ...params, size + 1).all<GroupRow & { viewer_role: Role | null }>();
  const { items, next } = page(results, size);
  return c.json({ items: items.map(g => groupJson(g, g.viewer_role)), next });
});

// One group

groups.get('/:slug', async c => {
  const { group, role } = await load(c);
  const owner = await c.env.DB.prepare(`SELECT ${userCardColumns} FROM users WHERE id = ?`).bind(group.owner_id).first<UserRow>();
  return c.json({
    group: { ...groupJson(group, role), owner: owner ? userCard(owner) : null },
    viewer: { role },
  });
});

groups.patch('/:slug', async c => {
  const user = requireUser(c);
  const { group, role } = await load(c);
  if (!isAdmin(role)) fail(403, 'Only the owner and admins can change this group.');
  const input = await body(c);
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); values.push(value); };
  const replaced: (string | null)[] = [];
  if ('name' in input) set('name', validName(input.name));
  if ('description' in input) set('description', validDescription(input.description));
  let openedUp = false;
  if ('privacy' in input) {
    const privacy = validPrivacy(input.privacy);
    openedUp = group.privacy === 'private' && privacy === 'public';
    set('privacy', privacy);
  }
  for (const column of ['avatar_media_id', 'banner_media_id'] as const) {
    if (!(column in input)) continue;
    const id = await pictureId(c.env, user.id, input[column]);
    if (id !== group[column]) replaced.push(group[column]);
    set(column, id);
  }
  if (!sets.length) fail(422, 'Nothing to change.');
  const statements: D1PreparedStatement[] = [];
  if (openedUp) {
    // A group going public lets everyone waiting in.
    statements.push(
      c.env.DB.prepare(`UPDATE groups SET member_count = member_count + (SELECT COUNT(*) FROM group_members
        WHERE group_id = ?1 AND role = 'pending') WHERE id = ?1`).bind(group.id),
      c.env.DB.prepare(`UPDATE group_members SET role = 'member' WHERE group_id = ? AND role = 'pending'`).bind(group.id),
    );
  }
  statements.push(c.env.DB.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).bind(...values, group.id));
  await c.env.DB.batch(statements);
  await dropUnused(c.env, replaced);
  const fresh = await c.env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(group.id).first<GroupRow>();
  return c.json({ group: groupJson(fresh!, role) });
});

groups.delete('/:slug', async c => {
  requireUser(c);
  const { group, role } = await load(c);
  if (role !== 'owner') fail(403, 'Only the owner can delete a group.');
  // Files attached to the group's posts go too (a bounded number per request: free-plan query limits).
  const { results: files } = await c.env.DB.prepare(`SELECT pm.media_id FROM post_media pm JOIN posts p ON p.id = pm.post_id
      WHERE p.group_id = ? LIMIT 20`).bind(group.id).all<{ media_id: string }>();
  await c.env.DB.batch([
    // Keep everyone's post counts right before the posts cascade away.
    c.env.DB.prepare(`UPDATE users SET post_count = MAX(0, post_count - (SELECT COUNT(*) FROM posts p
        WHERE p.group_id = ?1 AND p.author_id = users.id AND p.reply_to_id IS NULL AND p.deleted_at IS NULL))
      WHERE id IN (SELECT DISTINCT author_id FROM posts WHERE group_id = ?1 AND reply_to_id IS NULL AND deleted_at IS NULL)`)
      .bind(group.id),
    c.env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(group.id),
  ]);
  await dropUnused(c.env, [group.avatar_media_id, group.banner_media_id, ...files.map(f => f.media_id)]);
  return c.json({ ok: true });
});

// Membership

groups.post('/:slug/join', async c => {
  const user = requireUser(c);
  const { group, role } = await load(c);
  if (role) return c.json({ viewer: { role } });
  const now = Date.now();
  if (group.privacy === 'public') {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT OR IGNORE INTO group_members (group_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`)
        .bind(group.id, user.id, now),
      c.env.DB.prepare('UPDATE groups SET member_count = member_count + 1 WHERE id = ?').bind(group.id),
    ]);
    return c.json({ viewer: { role: 'member' } });
  }
  const { results: admins } = await c.env.DB.prepare(`SELECT user_id FROM group_members WHERE group_id = ? AND role IN ('owner', 'admin') LIMIT 20`)
    .bind(group.id).all<{ user_id: string }>();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT OR IGNORE INTO group_members (group_id, user_id, role, created_at) VALUES (?, ?, 'pending', ?)`)
      .bind(group.id, user.id, now),
  ];
  for (const a of admins) {
    const s = notifyStatement(c.env, { userId: a.user_id, actorId: user.id, type: 'group_join', groupId: group.id, body: 'request' }, now);
    if (s) statements.push(s);
  }
  await c.env.DB.batch(statements);
  return c.json({ viewer: { role: 'pending' } });
});

groups.delete('/:slug/join', async c => {
  const user = requireUser(c);
  const { group, role } = await load(c);
  if (!role) return c.json({ viewer: { role: null } });
  if (role === 'owner') fail(409, 'Owners cannot leave. Delete the group instead.');
  const statements = [c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').bind(group.id, user.id)];
  if (role !== 'pending') statements.push(c.env.DB.prepare('UPDATE groups SET member_count = MAX(0, member_count - 1) WHERE id = ?').bind(group.id));
  await c.env.DB.batch(statements);
  return c.json({ viewer: { role: null } });
});

groups.get('/:slug/members', async c => {
  const { group, role } = await load(c);
  const size = limit(c, 30);
  const offset = Math.max(0, Number(cursor(c)) || 0);
  // Pending requests are for admins' eyes. Private groups show only their admins to outsiders.
  const roles = isAdmin(role) ? ['owner', 'admin', 'member', 'pending']
    : group.privacy === 'private' && !isMember(role) ? ['owner', 'admin'] : ['owner', 'admin', 'member'];
  const { results } = await c.env.DB.prepare(`SELECT gm.role, gm.created_at AS joined_at, ${userCardColumns.split(', ').map(col => 'u.' + col).join(', ')}
      FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ? AND gm.role IN (${roles.map(() => '?').join(', ')})
      ORDER BY CASE gm.role WHEN 'pending' THEN 0 WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, gm.created_at, gm.user_id
      LIMIT ? OFFSET ?`)
    .bind(group.id, ...roles, size + 1, offset).all<UserRow & { role: Role; joined_at: number }>();
  const items = results.slice(0, size).map(r => ({ user: userCard(r), role: r.role, created_at: r.joined_at }));
  return c.json({ items, next: results.length > size ? String(offset + size) : null });
});

groups.post('/:slug/members/:handle', async c => {
  const user = requireUser(c);
  const { group, role } = await load(c);
  if (!isAdmin(role)) fail(403, 'Only the owner and admins can manage members.');
  const target = await userByHandle(c.env, c.req.param('handle'));
  const membership = target && await c.env.DB.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .bind(group.id, target.id).first<{ role: Role }>();
  if (!target || !membership) fail(404, 'That person is not in this group.');
  const action = (await body(c)).action;
  const now = Date.now();
  const card = userCard(target);
  const setRole = (next: Role) => c.env.DB.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').bind(next, group.id, target.id);

  if (target.id === user.id && action !== 'approve') fail(409, 'You cannot do that to yourself.');
  if (membership.role === 'owner') fail(403, 'The owner cannot be changed.');

  switch (action) {
    case 'approve': {
      if (membership.role !== 'pending') return c.json({ member: { user: card, role: membership.role } });
      const statements = [setRole('member'), c.env.DB.prepare('UPDATE groups SET member_count = member_count + 1 WHERE id = ?').bind(group.id)];
      const note = notifyStatement(c.env, { userId: target.id, actorId: user.id, type: 'group_join', groupId: group.id, body: 'approved' }, now);
      if (note) statements.push(note);
      await c.env.DB.batch(statements);
      return c.json({ member: { user: card, role: 'member' } });
    }
    case 'promote':
      if (membership.role !== 'member') fail(409, membership.role === 'pending' ? 'Approve the request first.' : 'They are already an admin.');
      await setRole('admin').run();
      return c.json({ member: { user: card, role: 'admin' } });
    case 'demote':
      if (role !== 'owner') fail(403, 'Only the owner can demote admins.');
      if (membership.role !== 'admin') fail(409, 'They are not an admin.');
      await setRole('member').run();
      return c.json({ member: { user: card, role: 'member' } });
    case 'remove': {
      if (membership.role === 'admin' && role !== 'owner') fail(403, 'Only the owner can remove admins.');
      const statements = [c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').bind(group.id, target.id)];
      if (membership.role !== 'pending')
        statements.push(c.env.DB.prepare('UPDATE groups SET member_count = MAX(0, member_count - 1) WHERE id = ?').bind(group.id));
      await c.env.DB.batch(statements);
      return c.json({ member: null });
    }
    default:
      fail(422, 'Actions are approve, promote, demote or remove.');
  }
});

// Posts

groups.get('/:slug/posts', async c => {
  const { group, role, user } = await load(c);
  if (group.privacy === 'private' && !isMember(role)) fail(403, 'This group is private.');
  const size = limit(c);
  const after = cursor(c);
  const v = visibleTo(user?.id ?? null);
  const { results } = await c.env.DB.prepare(`SELECT p.* FROM posts p
      WHERE p.group_id = ? AND p.reply_to_id IS NULL AND p.deleted_at IS NULL AND ${v.sql} ${after ? 'AND p.id < ?' : ''}
      ORDER BY p.id DESC LIMIT ?`)
    .bind(group.id, ...v.params, ...(after ? [after] : []), size + 1).all<PostRow>();
  const items = await hydrate(c.env, user, results.slice(0, size));
  const admin = isAdmin(role);
  return c.json({
    items: items.map(p => (admin ? { ...p, viewer: { ...p.viewer, can_delete: true } } : p)),
    next: results.length > size ? results[size - 1].id : null,
  });
});

export default groups;
