// Shared albums, powered by Southbag Drive. Anyone can make an album and invite people by
// handle; members see the album and add their own photos and videos. The bytes live in the
// UPLOADER'S OWN Southbag Drive (src/lib/drive.ts), uploaded with their own Identity token,
// not in Social's database: /media/album/:id serves them back through Drive's share links,
// members only.
//
//   POST   /api/albums             { title } -> { album }
//   GET    /api/albums             ?cursor -> { items: AlbumJson[], next }
//   GET    /api/albums/:id         -> { album, viewer: { role }, members: [{ user, role }] }
//   PATCH  /api/albums/:id         owner: { title } -> { album }
//   POST   /api/albums/:id/members owner: { handle } -> { member: { user, role } }
//   POST   /api/albums/:id/leave   -> { viewer: { role: null } }  (owners cannot leave)
//   GET    /api/albums/:id/media   ?cursor -> { items: AlbumMediaJson[], next }
//   PUT    /api/albums/:id/media   member: raw bytes (content-type, x-sb-filename) -> { media }
//
// AlbumJson:      { id, title, owner, member_count, media_count, cover_url, created_at, role }
// AlbumMediaJson: { id, kind, url, content_type, size, created_at, uploader }
//
// Nothing can be deleted: no route removes an album, a photo or a member. Leaving an album
// is undoing your own membership, which is fine.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Ctx, Env } from '../env';
import { session } from '../lib/auth';
import { body, cursor, fail, limit, page, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { centralStatus, FROZEN_TEXT, STATUS_UNKNOWN_TEXT } from '../lib/identity';
import { allowedTypes, limits } from '../lib/media';
import { notifyStatement } from '../lib/notify';
import { track, type Waiter } from '../lib/palantir';
import { userByHandle, userCard, userCardColumns, type UserRow } from '../lib/users';
import { driveExtension, driveFetchShared, driveShare, driveUpload } from '../lib/drive';
import { driveAccessToken } from '../lib/auth';

const albums = new Hono<AppEnv>();

type Role = 'owner' | 'member';

interface AlbumRow {
  id: string;
  owner_id: string;
  title: string;
  media_count: number;
  created_at: number;
}

interface AlbumMediaRow {
  id: string;
  album_id: string;
  uploader_id: string;
  kind: 'image' | 'video';
  drive_name: string;
  drive_file_id: string | null;
  share_token: string | null;
  content_type: string;
  size: number;
  created_at: number;
}

const MAX_TITLE = 80;
const MAX_MEMBERS = 200;

const mediaJson = (m: AlbumMediaRow, uploader?: UserRow | null) => ({
  id: m.id,
  kind: m.kind,
  url: `/media/album/${m.id}`,
  content_type: m.content_type,
  size: m.size,
  created_at: m.created_at,
  uploader: uploader ? userCard(uploader) : null,
});

// userCardColumns joined onto an album_media row as u_*, so the media row's own id survives.
type JoinedMediaRow = AlbumMediaRow & Record<`u_${string}`, unknown>;
const joinedUserColumns = userCardColumns.split(', ').map(col => `u.${col} AS u_${col}`).join(', ');
const joinedUploader = (row: JoinedMediaRow): UserRow =>
  Object.fromEntries(userCardColumns.split(', ').map(col => [col, row[`u_${col}`]])) as unknown as UserRow;

const albumJson = (a: AlbumRow & { member_count: number; cover_id: string | null }, role: Role | null, owner?: UserRow | null) => ({
  id: a.id,
  title: a.title,
  owner: owner ? userCard(owner) : null,
  member_count: a.member_count,
  media_count: a.media_count,
  cover_url: a.cover_id ? `/media/album/${a.cover_id}` : null,
  created_at: a.created_at,
  role,
});

const albumSelect = `SELECT a.*,
    (SELECT COUNT(*) FROM album_members am WHERE am.album_id = a.id) AS member_count,
    (SELECT m.id FROM album_media m WHERE m.album_id = a.id ORDER BY m.id DESC LIMIT 1) AS cover_id
  FROM albums a`;

/** The album plus the viewer's role in it. Albums are private: non-members get a 404. */
async function load(c: Ctx): Promise<{ album: AlbumRow & { member_count: number; cover_id: string | null }; role: Role | null }> {
  const user = requireUser(c);
  const row = await c.env.DB.prepare(`${albumSelect} WHERE a.id = ?`).bind(c.req.param('id'))
    .first<(AlbumRow & { member_count: number; cover_id: string | null }) | null>();
  if (!row) fail(404, 'Album not found.');
  const membership = await c.env.DB.prepare('SELECT role FROM album_members WHERE album_id = ? AND user_id = ?')
    .bind(row.id, user.id).first<{ role: Role }>();
  return { album: row, role: membership?.role ?? null };
}

const requireMember = (album: { id: string }, role: Role | null): Role => {
  if (!role) fail(404, 'Album not found.');
  return role;
};

function validTitle(value: unknown): string {
  const title = str(value, MAX_TITLE * 2).replace(/\s+/g, ' ');
  if (![...title].length) fail(422, 'Albums need a title.');
  if ([...title].length > MAX_TITLE) fail(422, `Album titles are limited to ${MAX_TITLE} characters.`);
  return title;
}

// Media uploads need the uploader's own Identity token, so Social can put the file in the
// uploader's own Drive. Null means they signed in before token storage (or their refresh
// token died) and must sign in again.
const uploaderToken = async (c: Ctx, userId: string): Promise<string> => {
  const token = await driveAccessToken(c.env, new URL(c.req.url).origin, userId);
  if (!token) fail(401, 'Sign in again to add photos and videos.');
  return token;
};

// Create and list

albums.post('/', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const title = validTitle(input.title);
  const now = Date.now();
  const id = newId(now);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO albums (id, owner_id, title, media_count, created_at) VALUES (?, ?, ?, 0, ?)')
      .bind(id, user.id, title, now),
    c.env.DB.prepare(`INSERT INTO album_members (album_id, user_id, role, invited_by, created_at) VALUES (?, ?, 'owner', NULL, ?)`)
      .bind(id, user.id, now),
  ]);
  track(c, 'social_album_created', { album_id: id });
  return c.json({ album: albumJson({ id, owner_id: user.id, title, media_count: 0, created_at: now, member_count: 1, cover_id: null }, 'owner') }, 201);
});

albums.get('/', async c => {
  const user = requireUser(c);
  const size = limit(c, 24);
  const after = cursor(c);
  const { results } = await c.env.DB.prepare(`${albumSelect}
      JOIN album_members mine ON mine.album_id = a.id AND mine.user_id = ?
      ${after ? 'WHERE a.id < ?' : ''} ORDER BY a.id DESC LIMIT ?`)
    .bind(...(after ? [user.id, after] : [user.id]), size + 1)
    .all<AlbumRow & { member_count: number; cover_id: string | null }>();
  const { items, next } = page(results, size);
  const roles = new Map<string, Role>();
  if (items.length) {
    const { results: memberRows } = await c.env.DB.prepare(`SELECT album_id, role FROM album_members
        WHERE user_id = ? AND album_id IN (${items.map(() => '?').join(', ')})`)
      .bind(user.id, ...items.map(a => a.id)).all<{ album_id: string; role: Role }>();
    for (const row of memberRows) roles.set(row.album_id, row.role);
  }
  return c.json({ items: items.map(a => albumJson(a, roles.get(a.id) ?? null)), next });
});

// One album

albums.get('/:id', async c => {
  const { album, role } = await load(c);
  requireMember(album, role);
  const [owner, { results: members }] = await Promise.all([
    c.env.DB.prepare(`SELECT ${userCardColumns} FROM users WHERE id = ?`).bind(album.owner_id).first<UserRow>(),
    c.env.DB.prepare(`SELECT m.role, ${userCardColumns.split(', ').map(col => 'u.' + col).join(', ')} FROM album_members m
        JOIN users u ON u.id = m.user_id WHERE m.album_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.created_at, m.user_id LIMIT ?`)
      .bind(album.id, MAX_MEMBERS).all<UserRow & { role: Role }>(),
  ]);
  return c.json({
    album: albumJson(album, role, owner),
    viewer: { role },
    members: members.map(m => ({ user: userCard(m), role: m.role })),
  });
});

albums.patch('/:id', async c => {
  requireUser(c);
  const { album, role } = await load(c);
  if (requireMember(album, role) !== 'owner') fail(403, 'Only the owner can change this album.');
  const input = await body(c);
  if (!('title' in input)) fail(422, 'Nothing to change.');
  const title = validTitle(input.title);
  await c.env.DB.prepare('UPDATE albums SET title = ? WHERE id = ?').bind(title, album.id).run();
  track(c, 'social_album_updated', { album_id: album.id, fields: ['title'] });
  return c.json({ album: albumJson({ ...album, title }, role) });
});

// Membership

albums.post('/:id/members', async c => {
  const user = requireUser(c);
  const { album, role } = await load(c);
  if (requireMember(album, role) !== 'owner') fail(403, 'Only the owner can invite people.');
  if (album.member_count >= MAX_MEMBERS) fail(422, `Albums are limited to ${MAX_MEMBERS} members.`);
  const input = await body(c);
  const target = await userByHandle(c.env, str(input.handle, 40));
  if (!target) fail(404, 'Person not found.');
  const now = Date.now();
  const added = await c.env.DB.prepare(`INSERT OR IGNORE INTO album_members (album_id, user_id, role, invited_by, created_at)
      VALUES (?, ?, 'member', ?, ?)`).bind(album.id, target.id, user.id, now).run();
  if (added.meta.changes) {
    const note = notifyStatement(c.env, {
      userId: target.id, actorId: user.id, type: 'album_invite', body: album.title, link: `/albums/${album.id}`,
    }, now);
    if (note) await note.run();
    track(c, 'social_album_member_added', { album_id: album.id, target_user_id: target.id });
  }
  return c.json({ member: { user: userCard(target), role: 'member' as Role } });
});

albums.post('/:id/leave', async c => {
  const user = requireUser(c);
  const { album, role } = await load(c);
  requireMember(album, role);
  if (role === 'owner') fail(409, 'Owners cannot leave.');
  await c.env.DB.prepare('DELETE FROM album_members WHERE album_id = ? AND user_id = ?').bind(album.id, user.id).run();
  track(c, 'social_album_left', { album_id: album.id });
  return c.json({ viewer: { role: null } });
});

// Media

albums.get('/:id/media', async c => {
  requireUser(c);
  const { album, role } = await load(c);
  requireMember(album, role);
  const size = limit(c, 24);
  const after = cursor(c);
  const { results } = await c.env.DB.prepare(`SELECT m.*, ${joinedUserColumns}
      FROM album_media m JOIN users u ON u.id = m.uploader_id
      WHERE m.album_id = ? ${after ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`)
    .bind(...(after ? [album.id, after] : [album.id]), size + 1)
    .all<JoinedMediaRow>();
  const { items, next } = page(results, size);
  return c.json({ items: items.map(m => mediaJson(m, joinedUploader(m))), next });
});

albums.put('/:id/media', async c => {
  const user = requireUser(c);
  const { album, role } = await load(c);
  requireMember(album, role);

  // Same discipline as Drive's own upload route: an absent Content-Length can't be metered,
  // and Number(null) is 0, which would sail past the guards.
  const rawLength = c.req.header('content-length');
  if (rawLength === null) throw new HTTPException(411, { message: 'Upload rejected.' });
  const size = Number(rawLength);
  if (!Number.isInteger(size) || size < 1) fail(400, 'Empty files cannot be uploaded.');

  const contentType = (c.req.header('content-type') || '').split(';')[0].trim().toLowerCase();
  const kind = (['image', 'video'] as const).find(k => allowedTypes[k].test(contentType));
  if (!kind) fail(422, 'Albums take photos and videos.');
  if (size > limits[kind]) fail(413, kind === 'image' ? 'That photo is too big.' : 'That video is too big.');

  const now = Date.now();
  const id = newId(now);
  const driveName = `social-album-${id}${driveExtension(contentType)}`;

  // The file lands in the uploader's OWN Drive, uploaded with their own Identity token, then
  // shared so the other album members can see it through Social.
  const accessToken = await uploaderToken(c, user.id);
  const { response: stored, file } = await driveUpload(c.env, accessToken, driveName, contentType, c.req.raw.body, size);
  if (stored.status === 401) fail(401, 'Sign in again to add photos and videos.');
  if (stored.status === 413) fail(413, 'Your Southbag Drive is full.');
  if (!stored.ok || !file) {
    console.error('drive upload failed', stored.status, await stored.text().catch(() => ''));
    fail(502, 'Southbag Drive could not store that. Try again.');
  }
  const shareToken = await driveShare(c.env, accessToken, file.id);
  if (!shareToken) fail(502, 'Southbag Drive could not share that. Try again.');

  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO album_media
        (id, album_id, uploader_id, kind, drive_name, drive_file_id, share_token, content_type, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, album.id, user.id, kind, driveName, file.id, shareToken, contentType, size, now),
    c.env.DB.prepare('UPDATE albums SET media_count = media_count + 1 WHERE id = ?').bind(album.id),
  ]);
  track(c, 'social_album_media_added', { album_id: album.id, media_id: id, kind, size });
  const row = await c.env.DB.prepare(`SELECT m.*, ${joinedUserColumns}
      FROM album_media m JOIN users u ON u.id = m.uploader_id WHERE m.id = ?`)
    .bind(id).first<JoinedMediaRow>();
  return c.json({ media: mediaJson(row!, joinedUploader(row!)) }, 201);
});

export default albums;

// Serving, at /media/album/:id. Album photos and videos are private to the album, so unlike
// /media/:id this checks the session, the freeze and membership before fetching the bytes
// out of the uploader's Drive through the share link Social created at upload time. The
// share endpoint sends whole files, so ranges are sliced here; videos can still seek.
export async function serveAlbumMedia(
  request: Request,
  env: Env,
  ctx: Waiter | null,
  id: string,
): Promise<Response> {
  const user = await session(request, env, ctx);
  if (!user) return new Response('Log in to see that.', { status: 401 });
  const central = await centralStatus(env, user.id);
  if (central === 'unknown') return new Response(STATUS_UNKNOWN_TEXT, { status: 503 });
  if (central !== 'off' && central.frozen) return new Response(FROZEN_TEXT, { status: 423 });

  const media = await env.DB.prepare('SELECT * FROM album_media WHERE id = ?').bind(id).first<AlbumMediaRow>();
  if (!media) return new Response('Not found', { status: 404 });
  const member = await env.DB.prepare('SELECT 1 FROM album_members WHERE album_id = ? AND user_id = ?')
    .bind(media.album_id, user.id).first();
  if (!member) return new Response('Not found', { status: 404 });

  if (!media.share_token) return new Response('Not found', { status: 404 });
  let fetched;
  try {
    fetched = await driveFetchShared(env, media.share_token, request.headers.get('range'));
  } catch {
    return new Response('Southbag Drive is unavailable. Try again shortly.', { status: 502 });
  }
  if (!fetched) return new Response('Not found', { status: 404 });

  const headers = new Headers({
    'content-type': media.content_type,
    'content-length': String(fetched.contentLength),
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
  if (fetched.status === 206) {
    headers.set('content-range', `bytes ${fetched.start}-${fetched.start + fetched.contentLength - 1}/${fetched.total}`);
  } else if (fetched.status === 416) {
    headers.set('content-range', `bytes */${fetched.total}`);
  }
  return new Response(request.method === 'HEAD' ? null : fetched.body, { status: fetched.status, headers });
}
