// Podcasts and music (Spotify / SoundCloud / Apple Podcasts). Mounted at /api/audio.
//
// A show is a podcast (kind 'podcast', tracks are episodes) or an artist page (kind 'artist', tracks
// are songs). Audio and covers are ordinary files uploaded with the media API first
// (public/js/upload.js); a track just points at them. Publishing a track also makes a normal feed
// post with the audio attached (createPost), so followers see it in their feed.
//
// Shows
//   GET    /shows?kind=podcast|artist&sort=new|popular&q=&owner=me|<user id>&cursor&limit → { items: Show[], next }
//   GET    /shows/mine                                  → { items: Show[] }
//   POST   /shows { kind, title, description?, category?, cover_media_id? } → { show }
//   GET    /shows/:id                                   → { show, tracks: Track[], next }
//   GET    /shows/:id/tracks?cursor&limit               → { items: Track[], next }
//   PATCH  /shows/:id { title?, description?, category?, cover_media_id? } → { show }
//   DELETE /shows/:id                                   → { ok } (only once it has no tracks)
//   PUT    /shows/:id/follow · DELETE /shows/:id/follow → { following, follower_count }
// Tracks
//   GET    /tracks?kind=episode|song&sort=new|popular&q=&owner=me|<user id>&cursor&limit → { items, next }
//   POST   /tracks { show_id, title, media_id, description?, cover_media_id?, episode_number?, season?,
//                    album?, genre?, post_to_feed? (default true) } → { track }
//   GET    /tracks/:id                                  → { track, more: Track[] } (more from the show)
//   GET    /tracks/by-media/:mediaId                    → { track } (feed posts use it to find the track)
//   PATCH  /tracks/:id { title?, description?, cover_media_id?, episode_number?, season?, album?, genre? } → { track }
//   DELETE /tracks/:id                                  → { ok } (also deletes its files and feed post)
//   PUT    /tracks/:id/like · DELETE /tracks/:id/like   → { liked, like_count }
//   POST   /tracks/:id/play                             → { counted, play_count } (the player calls it ~30 s in;
//                                                         one count per listener per track every 30 minutes)
//   PUT    /tracks/:id/progress { position, completed? } → { position, completed } (the player saves every ~15 s)
// Discovery
//   GET    /home     → { continue_listening, new_episodes, new_episodes_from: 'following'|'everyone',
//                        new_music, popular, popular_shows }   (Track[] / Show[])
//   GET    /library  → { shows, liked, playlists, uploads, my_shows }
// Playlists
//   GET    /playlists                                   → { items: Playlist[] } (yours)
//   POST   /playlists { title, description?, visibility?: 'public'|'private' } → { playlist }
//   GET    /playlists/:id                               → { playlist, tracks: Track[] } (private: owner only)
//   PATCH  /playlists/:id { title?, description?, visibility? } → { playlist }
//   DELETE /playlists/:id                               → { ok }
//   POST   /playlists/:id/tracks { track_id }           → { playlist } (appended at the end)
//   DELETE /playlists/:id/tracks/:trackId               → { playlist }
//   PUT    /playlists/:id/order { track_ids }           → { tracks } (the full new order)
//
// Shapes
//   Show     { id, kind, title, description, category, cover_url, follower_count, track_count,
//              last_published_at, created_at, owner: UserCard, viewer: { following, can_edit } }
//   Track    { id, kind, title, description, media_id, audio_url, content_type, size, cover_url, duration,
//              episode_number, season, album, genre, post_id, play_count, like_count, published_at, created_at,
//              show: { id, kind, title, cover_url }, owner: UserCard,
//              viewer: { liked, progress (seconds or null), completed, can_edit } }
//   Playlist { id, title, description, visibility, track_count, cover_url, created_at, updated_at,
//              owner: UserCard, viewer: { can_edit } }
//
// Every handler runs a handful of D1 queries (well under the free plan's 50) and batches writes.

import { Hono } from 'hono';
import type { AppEnv, Ctx, Env } from '../env';
import { body, cursor, fail, limit, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { deleteUnusedMedia, ownedReadyMedia, type MediaRow } from '../lib/media';
import { createPost, deletePost } from '../lib/posts';
import { userCard } from '../lib/users';

const audio = new Hono<AppEnv>();

const MAX_TITLE = 200;
const MAX_SHOW_TITLE = 120;
const MAX_DESCRIPTION = 5000;
const MAX_CATEGORY = 40;
const MAX_SHOWS_PER_USER = 20;
const MAX_PLAYLISTS_PER_USER = 100;
const MAX_PLAYLIST_TRACKS = 200;
const PLAY_WINDOW = 30 * 60 * 1000;
const WEEK = 7 * 24 * 3600 * 1000;

type Row = Record<string, unknown>;
const mediaUrl = (id: unknown): string | null => (id ? `/media/${id}` : null);
const offsetOf = (value: string | null) => Math.max(0, Math.min(10000, Math.floor(Number(value) || 0)));
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
const viewerOf = (c: Ctx) => c.get('user')?.id ?? null;

// ── Shared SQL ───────────────────────────────────────────────────────────

const USER_FIELDS = ['id', 'handle', 'name', 'avatar_media_id', 'identity_picture', 'verified'];
const userCols = (alias: string, prefix: string) => USER_FIELDS.map(f => `${alias}.${f} AS ${prefix}${f}`).join(', ');
const pickUser = (r: Row, prefix: string) => userCard({
  id: r[`${prefix}id`] as string,
  handle: r[`${prefix}handle`] as string,
  name: r[`${prefix}name`] as string,
  avatar_media_id: r[`${prefix}avatar_media_id`] as string | null,
  identity_picture: r[`${prefix}identity_picture`] as string | null,
  verified: r[`${prefix}verified`] as number,
});

interface ListOptions {
  join?: string;
  joinParams?: unknown[];
  where?: string;
  params?: unknown[];
  order?: string;
  limit?: number;
  offset?: number;
}

function showJson(r: Row, viewerId: string | null) {
  return {
    id: r.id as string,
    kind: r.kind as 'podcast' | 'artist',
    title: r.title as string,
    description: r.description as string,
    category: r.category as string,
    cover_url: mediaUrl(r.cover_media_id),
    follower_count: r.follower_count as number,
    track_count: r.track_count as number,
    last_published_at: (r.last_published_at as number | null) ?? null,
    created_at: r.created_at as number,
    owner: pickUser(r, 'o_'),
    viewer: { following: Boolean(r.following), can_edit: viewerId === r.owner_id },
  };
}
export type ShowJson = ReturnType<typeof showJson>;

async function listShows(env: Env, viewerId: string | null, o: ListOptions = {}): Promise<ShowJson[]> {
  const { results } = await env.DB.prepare(`SELECT s.*, ${userCols('u', 'o_')},
      ${viewerId ? 'EXISTS (SELECT 1 FROM show_follows f WHERE f.show_id = s.id AND f.user_id = ?)' : '0'} AS following
    FROM shows s JOIN users u ON u.id = s.owner_id ${o.join ?? ''}
    WHERE ${o.where ?? '1 = 1'} ORDER BY ${o.order ?? 's.id DESC'} LIMIT ${o.limit ?? 20} OFFSET ${o.offset ?? 0}`)
    .bind(...(viewerId ? [viewerId] : []), ...(o.joinParams ?? []), ...(o.params ?? [])).all<Row>();
  return results.map(r => showJson(r, viewerId));
}

function trackJson(r: Row, viewerId: string | null) {
  const showCover = mediaUrl(r.show_cover_id);
  return {
    id: r.id as string,
    kind: r.kind as 'episode' | 'song',
    title: r.title as string,
    description: r.description as string,
    media_id: r.media_id as string,
    audio_url: `/media/${r.media_id}`,
    content_type: r.audio_type as string,
    size: r.audio_size as number,
    cover_url: mediaUrl(r.cover_media_id) ?? showCover,
    duration: (r.duration as number | null) ?? (r.audio_duration as number | null) ?? null,
    episode_number: (r.episode_number as number | null) ?? null,
    season: (r.season as number | null) ?? null,
    album: (r.album as string | null) ?? null,
    genre: (r.genre as string | null) ?? null,
    post_id: (r.post_id as string | null) ?? null,
    play_count: r.play_count as number,
    like_count: r.like_count as number,
    published_at: r.published_at as number,
    created_at: r.created_at as number,
    show: { id: r.show_id as string, kind: r.show_kind as 'podcast' | 'artist', title: r.show_title as string, cover_url: showCover },
    owner: pickUser(r, 'o_'),
    viewer: {
      liked: Boolean(r.liked),
      progress: r.completed ? null : (r.progress as number | null) ?? null,
      completed: Boolean(r.completed),
      can_edit: viewerId === r.owner_id,
    },
  };
}
export type TrackJson = ReturnType<typeof trackJson>;

/**
 * One query for a page of tracks with their show, owner, file and the viewer's like and progress.
 * `join` is appended after the standard joins (its params go in joinParams); `lp` is the viewer's
 * listen_progress row (LEFT JOIN, signed in only).
 */
async function listTracks(env: Env, viewerId: string | null, o: ListOptions = {}): Promise<TrackJson[]> {
  const { results } = await env.DB.prepare(`SELECT t.*, s.kind AS show_kind, s.title AS show_title,
      s.cover_media_id AS show_cover_id, ${userCols('u', 'o_')},
      m.content_type AS audio_type, m.size AS audio_size, m.duration AS audio_duration,
      ${viewerId
        ? 'EXISTS (SELECT 1 FROM track_likes tl WHERE tl.track_id = t.id AND tl.user_id = ?) AS liked, lp.position_seconds AS progress, lp.completed AS completed'
        : '0 AS liked, NULL AS progress, 0 AS completed'}
    FROM tracks t
      JOIN shows s ON s.id = t.show_id
      JOIN users u ON u.id = t.owner_id
      JOIN media m ON m.id = t.media_id
      ${viewerId ? 'LEFT JOIN listen_progress lp ON lp.track_id = t.id AND lp.user_id = ?' : ''}
      ${o.join ?? ''}
    WHERE ${o.where ?? '1 = 1'} ORDER BY ${o.order ?? 't.id DESC'} LIMIT ${o.limit ?? 20} OFFSET ${o.offset ?? 0}`)
    .bind(...(viewerId ? [viewerId, viewerId] : []), ...(o.joinParams ?? []), ...(o.params ?? [])).all<Row>();
  return results.map(r => trackJson(r, viewerId));
}

function playlistJson(r: Row, viewerId: string | null) {
  return {
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
    visibility: r.visibility as 'public' | 'private',
    track_count: r.track_count as number,
    cover_url: mediaUrl(r.cover_id),
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
    owner: pickUser(r, 'o_'),
    viewer: { can_edit: viewerId === r.owner_id },
  };
}
export type PlaylistJson = ReturnType<typeof playlistJson>;

async function listPlaylists(env: Env, viewerId: string | null, where: string, params: unknown[], lim = 100): Promise<PlaylistJson[]> {
  const { results } = await env.DB.prepare(`SELECT p.*, ${userCols('u', 'o_')},
      (SELECT COALESCE(t.cover_media_id, s.cover_media_id) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
        JOIN shows s ON s.id = t.show_id WHERE pt.playlist_id = p.id ORDER BY pt.position LIMIT 1) AS cover_id
    FROM playlists p JOIN users u ON u.id = p.owner_id WHERE ${where} ORDER BY p.updated_at DESC LIMIT ${lim}`)
    .bind(...params).all<Row>();
  return results.map(r => playlistJson(r, viewerId));
}

async function oneShow(env: Env, viewerId: string | null, id: string): Promise<ShowJson> {
  const [show] = await listShows(env, viewerId, { where: 's.id = ?', params: [id], limit: 1 });
  if (!show) fail(404, 'Show not found.');
  return show;
}

async function oneTrack(env: Env, viewerId: string | null, id: string): Promise<TrackJson> {
  const [track] = await listTracks(env, viewerId, { where: 't.id = ?', params: [id], limit: 1 });
  if (!track) fail(404, 'Track not found.');
  return track;
}

/** A playlist the viewer may see (public, or their own). */
async function onePlaylist(env: Env, viewerId: string | null, id: string): Promise<PlaylistJson> {
  const [playlist] = await listPlaylists(env, viewerId, `p.id = ? AND (p.visibility = 'public' OR p.owner_id = ?)`, [id, viewerId ?? ''], 1);
  if (!playlist) fail(404, 'Playlist not found.');
  return playlist;
}

// ── Input helpers ────────────────────────────────────────────────────────

function intOrNull(value: unknown, max: number, label: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) fail(422, `${label} must be a whole number.`);
  return n;
}

const textOrNull = (value: unknown, max: number): string | null => str(value, max) || null;

/** A ready file of the right kind owned by the user. */
async function ownedFile(env: Env, userId: string, id: unknown, kind: 'image' | 'audio'): Promise<MediaRow> {
  if (typeof id !== 'string' || !id) fail(422, kind === 'audio' ? 'Choose an audio file.' : 'Cover image not found.');
  let rows: MediaRow[] = [];
  try {
    rows = await ownedReadyMedia(env, userId, [id]);
  } catch {
    fail(422, kind === 'audio' ? 'That audio file is not yours or has not finished uploading.' : 'Cover image not found.');
  }
  if (rows[0].kind !== kind) fail(422, kind === 'audio' ? 'Choose an audio file.' : 'Covers must be images.');
  return rows[0];
}

/** Deletes files nothing else uses any more (covers can be shared between a show and its tracks). */
async function deleteUnused(env: Env, ids: (string | null | undefined)[]): Promise<void> {
  await deleteUnusedMedia(env, ids);
}

async function ownShow(c: Ctx, id: string): Promise<Row> {
  const user = requireUser(c);
  const row = await c.env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(id).first<Row>();
  if (!row) fail(404, 'Show not found.');
  if (row.owner_id !== user.id) fail(403, 'That show is not yours.');
  return row;
}

async function ownTrack(c: Ctx, id: string): Promise<Row> {
  const user = requireUser(c);
  const row = await c.env.DB.prepare(`SELECT t.*, s.cover_media_id AS show_cover_id FROM tracks t
    JOIN shows s ON s.id = t.show_id WHERE t.id = ?`).bind(id).first<Row>();
  if (!row) fail(404, 'Track not found.');
  if (row.owner_id !== user.id) fail(403, 'That track is not yours.');
  return row;
}

async function ownPlaylist(c: Ctx, id: string): Promise<Row> {
  const user = requireUser(c);
  const row = await c.env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(id).first<Row>();
  if (!row || (row.owner_id !== user.id && row.visibility !== 'public')) fail(404, 'Playlist not found.');
  if (row.owner_id !== user.id) fail(403, 'That playlist is not yours.');
  return row;
}

/** `owner=me` or a user id → a WHERE fragment on `alias.owner_id`. */
function ownerFilter(c: Ctx, alias: string, where: string[], params: unknown[]) {
  const owner = c.req.query('owner');
  if (!owner) return;
  if (owner === 'me') {
    where.push(`${alias}.owner_id = ?`);
    params.push(requireUser(c).id);
  } else {
    where.push(`${alias}.owner_id = ?`);
    params.push(owner);
  }
}

// ── Shows ────────────────────────────────────────────────────────────────

audio.get('/shows', async c => {
  const viewerId = viewerOf(c);
  const size = limit(c, 20, 50);
  const after = cursor(c);
  const where: string[] = [];
  const params: unknown[] = [];
  const kind = c.req.query('kind');
  if (kind === 'podcast' || kind === 'artist') { where.push('s.kind = ?'); params.push(kind); }
  const q = str(c.req.query('q'), 100);
  if (q) {
    where.push(`(s.title LIKE ? ESCAPE '\\' OR s.category LIKE ? ESCAPE '\\')`);
    params.push(likePattern(q), likePattern(q));
  }
  ownerFilter(c, 's', where, params);
  if (c.req.query('sort') === 'popular') {
    const offset = offsetOf(after);
    const rows = await listShows(c.env, viewerId, {
      where: where.join(' AND ') || '1 = 1', params,
      order: 's.follower_count DESC, s.track_count DESC, s.id DESC', limit: size + 1, offset,
    });
    return c.json({ items: rows.slice(0, size), next: rows.length > size ? String(offset + size) : null });
  }
  if (after) { where.push('s.id < ?'); params.push(after); }
  const rows = await listShows(c.env, viewerId, { where: where.join(' AND ') || '1 = 1', params, limit: size + 1 });
  const items = rows.slice(0, size);
  return c.json({ items, next: rows.length > size ? items[items.length - 1].id : null });
});

audio.get('/shows/mine', async c => {
  const user = requireUser(c);
  return c.json({ items: await listShows(c.env, user.id, { where: 's.owner_id = ?', params: [user.id], limit: 50 }) });
});

audio.post('/shows', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const kind = input.kind === 'artist' ? 'artist' : input.kind === 'podcast' ? 'podcast' : null;
  if (!kind) fail(422, 'Choose podcast or artist.');
  const title = str(input.title, MAX_SHOW_TITLE);
  if (!title) fail(422, kind === 'podcast' ? 'Give the podcast a name.' : 'Give the artist a name.');
  const description = str(input.description, MAX_DESCRIPTION);
  const category = str(input.category, MAX_CATEGORY);
  const cover = input.cover_media_id ? await ownedFile(c.env, user.id, input.cover_media_id, 'image') : null;
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM shows WHERE owner_id = ?').bind(user.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_SHOWS_PER_USER) fail(422, `You can have up to ${MAX_SHOWS_PER_USER} shows.`);
  const id = newId();
  await c.env.DB.prepare(`INSERT INTO shows (id, owner_id, kind, title, description, cover_media_id, category, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, user.id, kind, title, description, cover?.id ?? null, category, Date.now()).run();
  return c.json({ show: await oneShow(c.env, user.id, id) }, 201);
});

async function showTracksPage(c: Ctx, showId: string) {
  const size = limit(c, 50, 50);
  const after = cursor(c);
  const rows = await listTracks(c.env, viewerOf(c), {
    where: `t.show_id = ?${after ? ' AND t.id < ?' : ''}`, params: after ? [showId, after] : [showId], limit: size + 1,
  });
  const items = rows.slice(0, size);
  return { items, next: rows.length > size ? items[items.length - 1].id : null };
}

audio.get('/shows/:id', async c => {
  const show = await oneShow(c.env, viewerOf(c), c.req.param('id'));
  const { items, next } = await showTracksPage(c, show.id);
  return c.json({ show, tracks: items, next });
});

audio.get('/shows/:id/tracks', async c => {
  const show = await oneShow(c.env, viewerOf(c), c.req.param('id'));
  return c.json(await showTracksPage(c, show.id));
});

audio.patch('/shows/:id', async c => {
  const row = await ownShow(c, c.req.param('id'));
  const user = requireUser(c);
  const input = await body(c);
  const sets: string[] = [];
  const params: unknown[] = [];
  if ('title' in input) {
    const title = str(input.title, MAX_SHOW_TITLE);
    if (!title) fail(422, 'Give it a name.');
    sets.push('title = ?'); params.push(title);
  }
  if ('description' in input) { sets.push('description = ?'); params.push(str(input.description, MAX_DESCRIPTION)); }
  if ('category' in input) { sets.push('category = ?'); params.push(str(input.category, MAX_CATEGORY)); }
  let oldCover: string | null = null;
  if ('cover_media_id' in input) {
    const cover = input.cover_media_id ? await ownedFile(c.env, user.id, input.cover_media_id, 'image') : null;
    if ((cover?.id ?? null) !== row.cover_media_id) {
      oldCover = row.cover_media_id as string | null;
      sets.push('cover_media_id = ?'); params.push(cover?.id ?? null);
    }
  }
  if (sets.length) await c.env.DB.prepare(`UPDATE shows SET ${sets.join(', ')} WHERE id = ?`).bind(...params, row.id).run();
  if (oldCover) await deleteUnused(c.env, [oldCover]);
  return c.json({ show: await oneShow(c.env, user.id, row.id as string) });
});

audio.delete('/shows/:id', async c => {
  const row = await ownShow(c, c.req.param('id'));
  const left = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM tracks WHERE show_id = ?').bind(row.id).first<{ n: number }>();
  if (left?.n) fail(409, row.kind === 'podcast' ? 'Delete its episodes first.' : 'Delete its songs first.');
  await c.env.DB.prepare('DELETE FROM shows WHERE id = ?').bind(row.id).run();
  await deleteUnused(c.env, [row.cover_media_id as string | null]);
  return c.json({ ok: true });
});

async function setFollow(c: Ctx, follow: boolean) {
  const user = requireUser(c);
  const id = c.req.param('id') as string;
  const now = Date.now();
  const [, counted] = await c.env.DB.batch([
    follow
      ? c.env.DB.prepare('INSERT OR IGNORE INTO show_follows (show_id, user_id, created_at) SELECT id, ?, ? FROM shows WHERE id = ?').bind(user.id, now, id)
      : c.env.DB.prepare('DELETE FROM show_follows WHERE show_id = ? AND user_id = ?').bind(id, user.id),
    c.env.DB.prepare(`UPDATE shows SET follower_count = (SELECT COUNT(*) FROM show_follows WHERE show_id = ?1)
      WHERE id = ?1 RETURNING follower_count`).bind(id),
  ]);
  const result = counted.results[0] as { follower_count: number } | undefined;
  if (!result) fail(404, 'Show not found.');
  return c.json({ following: follow, follower_count: result.follower_count });
}
audio.put('/shows/:id/follow', c => setFollow(c, true));
audio.delete('/shows/:id/follow', c => setFollow(c, false));

// ── Tracks ───────────────────────────────────────────────────────────────

audio.get('/tracks', async c => {
  const viewerId = viewerOf(c);
  const size = limit(c, 20, 50);
  const after = cursor(c);
  const where: string[] = [];
  const params: unknown[] = [];
  const kind = c.req.query('kind');
  if (kind === 'episode' || kind === 'song') { where.push('t.kind = ?'); params.push(kind); }
  const q = str(c.req.query('q'), 100);
  if (q) {
    where.push(`(t.title LIKE ? ESCAPE '\\' OR t.album LIKE ? ESCAPE '\\' OR t.genre LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')`);
    params.push(likePattern(q), likePattern(q), likePattern(q), likePattern(q));
  }
  ownerFilter(c, 't', where, params);
  if (c.req.query('sort') === 'popular') {
    const offset = offsetOf(after);
    const rows = await listTracks(c.env, viewerId, {
      where: where.join(' AND ') || '1 = 1', params, order: 't.play_count DESC, t.like_count DESC, t.id DESC', limit: size + 1, offset,
    });
    return c.json({ items: rows.slice(0, size), next: rows.length > size ? String(offset + size) : null });
  }
  if (after) { where.push('t.id < ?'); params.push(after); }
  const rows = await listTracks(c.env, viewerId, { where: where.join(' AND ') || '1 = 1', params, limit: size + 1 });
  const items = rows.slice(0, size);
  return c.json({ items, next: rows.length > size ? items[items.length - 1].id : null });
});

audio.post('/tracks', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const show = await c.env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(str(input.show_id, 40)).first<Row>();
  if (!show) fail(422, 'Choose a podcast or artist first.');
  if (show.owner_id !== user.id) fail(403, 'That show is not yours.');
  const kind = show.kind === 'podcast' ? 'episode' : 'song';
  const title = str(input.title, MAX_TITLE);
  if (!title) fail(422, 'Add a title.');
  const description = str(input.description, MAX_DESCRIPTION);
  if (typeof input.description === 'string' && [...input.description.trim()].length > MAX_DESCRIPTION)
    fail(422, `Descriptions are limited to ${MAX_DESCRIPTION} characters.`);
  const episodeNumber = kind === 'episode' ? intOrNull(input.episode_number, 100000, 'Episode') : null;
  const season = kind === 'episode' ? intOrNull(input.season, 1000, 'Season') : null;
  const album = kind === 'song' ? textOrNull(input.album, MAX_SHOW_TITLE) : null;
  const genre = kind === 'song' ? textOrNull(input.genre, MAX_CATEGORY) : null;

  const file = await ownedFile(c.env, user.id, input.media_id, 'audio');
  const cover = input.cover_media_id ? await ownedFile(c.env, user.id, input.cover_media_id, 'image') : null;
  const used = await c.env.DB.prepare('SELECT 1 FROM tracks WHERE media_id = ?').bind(file.id).first();
  if (used) fail(409, 'That file is already published.');
  const duration = file.duration ?? (Number(input.duration) > 0 && Number(input.duration) < 86400 ? Number(input.duration) : null);

  // The feed post, so followers see it. Its card plays the audio in the global player.
  const postId = input.post_to_feed === false ? null
    : await createPost(c.env, user, { body: `${kind === 'episode' ? 'New episode' : 'New song'}: ${title}`, media_ids: [file.id] });

  const id = newId();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO tracks (id, show_id, owner_id, kind, title, description, media_id, cover_media_id, duration,
      episode_number, season, album, genre, post_id, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, show.id, user.id, kind, title, description, file.id, cover?.id ?? null, duration,
        episodeNumber, season, album, genre, postId, now, now),
    c.env.DB.prepare('UPDATE shows SET track_count = track_count + 1, last_published_at = ? WHERE id = ?').bind(now, show.id),
  ]);
  return c.json({ track: await oneTrack(c.env, user.id, id) }, 201);
});

audio.get('/tracks/by-media/:mediaId', async c => {
  const [track] = await listTracks(c.env, viewerOf(c), { where: 't.media_id = ?', params: [c.req.param('mediaId')], limit: 1 });
  if (!track) fail(404, 'Track not found.');
  return c.json({ track });
});

audio.get('/tracks/:id', async c => {
  const viewerId = viewerOf(c);
  const track = await oneTrack(c.env, viewerId, c.req.param('id'));
  const more = await listTracks(c.env, viewerId, { where: 't.show_id = ? AND t.id != ?', params: [track.show.id, track.id], limit: 5 });
  return c.json({ track, more });
});

audio.patch('/tracks/:id', async c => {
  const row = await ownTrack(c, c.req.param('id'));
  const user = requireUser(c);
  const input = await body(c);
  const episode = row.kind === 'episode';
  const sets: string[] = [];
  const params: unknown[] = [];
  if ('title' in input) {
    const title = str(input.title, MAX_TITLE);
    if (!title) fail(422, 'Add a title.');
    sets.push('title = ?'); params.push(title);
  }
  if ('description' in input) {
    if (typeof input.description === 'string' && [...input.description.trim()].length > MAX_DESCRIPTION)
      fail(422, `Descriptions are limited to ${MAX_DESCRIPTION} characters.`);
    sets.push('description = ?'); params.push(str(input.description, MAX_DESCRIPTION));
  }
  if (episode && 'episode_number' in input) { sets.push('episode_number = ?'); params.push(intOrNull(input.episode_number, 100000, 'Episode')); }
  if (episode && 'season' in input) { sets.push('season = ?'); params.push(intOrNull(input.season, 1000, 'Season')); }
  if (!episode && 'album' in input) { sets.push('album = ?'); params.push(textOrNull(input.album, MAX_SHOW_TITLE)); }
  if (!episode && 'genre' in input) { sets.push('genre = ?'); params.push(textOrNull(input.genre, MAX_CATEGORY)); }
  let oldCover: string | null = null;
  if ('cover_media_id' in input) {
    const cover = input.cover_media_id ? await ownedFile(c.env, user.id, input.cover_media_id, 'image') : null;
    if ((cover?.id ?? null) !== row.cover_media_id) {
      oldCover = row.cover_media_id as string | null;
      sets.push('cover_media_id = ?'); params.push(cover?.id ?? null);
    }
  }
  if (sets.length) await c.env.DB.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).bind(...params, row.id).run();
  if (oldCover) await deleteUnused(c.env, [oldCover]);
  return c.json({ track: await oneTrack(c.env, user.id, row.id as string) });
});

audio.delete('/tracks/:id', async c => {
  const row = await ownTrack(c, c.req.param('id'));
  const user = requireUser(c);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE playlists SET track_count = MAX(0, track_count - 1)
      WHERE id IN (SELECT playlist_id FROM playlist_tracks WHERE track_id = ?)`).bind(row.id),
    c.env.DB.prepare('UPDATE shows SET track_count = MAX(0, track_count - 1) WHERE id = ?').bind(row.show_id),
    c.env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(row.id),
  ]);
  if (row.post_id) {
    const post = await c.env.DB.prepare('SELECT deleted_at FROM posts WHERE id = ?').bind(row.post_id).first<{ deleted_at: number | null }>();
    if (post && !post.deleted_at) await deletePost(c.env, user, row.post_id as string);
  }
  await deleteUnused(c.env, [row.media_id as string, row.cover_media_id as string | null]);
  return c.json({ ok: true });
});

async function setLike(c: Ctx, like: boolean) {
  const user = requireUser(c);
  const id = c.req.param('id') as string;
  const [, counted] = await c.env.DB.batch([
    like
      ? c.env.DB.prepare('INSERT OR IGNORE INTO track_likes (track_id, user_id, created_at) SELECT id, ?, ? FROM tracks WHERE id = ?').bind(user.id, Date.now(), id)
      : c.env.DB.prepare('DELETE FROM track_likes WHERE track_id = ? AND user_id = ?').bind(id, user.id),
    c.env.DB.prepare(`UPDATE tracks SET like_count = (SELECT COUNT(*) FROM track_likes WHERE track_id = ?1)
      WHERE id = ?1 RETURNING like_count`).bind(id),
  ]);
  const result = counted.results[0] as { like_count: number } | undefined;
  if (!result) fail(404, 'Track not found.');
  return c.json({ liked: like, like_count: result.like_count });
}
audio.put('/tracks/:id/like', c => setLike(c, true));
audio.delete('/tracks/:id/like', c => setLike(c, false));

audio.post('/tracks/:id/play', async c => {
  const id = c.req.param('id');
  const listener = viewerOf(c) ?? '';
  const now = Date.now();
  const [, counted] = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO track_plays (track_id, user_id, created_at) SELECT t.id, ?1, ?2 FROM tracks t WHERE t.id = ?3
      AND (?1 = '' OR NOT EXISTS (SELECT 1 FROM track_plays p WHERE p.track_id = t.id AND p.user_id = ?1 AND p.created_at > ?4))`)
      .bind(listener, now, id, now - PLAY_WINDOW),
    c.env.DB.prepare(`UPDATE tracks SET play_count = play_count + 1 WHERE id = ?1
      AND EXISTS (SELECT 1 FROM track_plays p WHERE p.track_id = ?1 AND p.user_id = ?2 AND p.created_at = ?3) RETURNING play_count`)
      .bind(id, listener, now),
    // Only the last week is ever read; trim a little of the rest on every play.
    c.env.DB.prepare('DELETE FROM track_plays WHERE rowid IN (SELECT rowid FROM track_plays WHERE created_at < ? LIMIT 25)')
      .bind(now - WEEK - 86400000),
  ]);
  const result = counted.results[0] as { play_count: number } | undefined;
  if (result) return c.json({ counted: true, play_count: result.play_count });
  const row = await c.env.DB.prepare('SELECT play_count FROM tracks WHERE id = ?').bind(id).first<{ play_count: number }>();
  if (!row) fail(404, 'Track not found.');
  return c.json({ counted: false, play_count: row.play_count });
});

audio.put('/tracks/:id/progress', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const position = Number(input.position);
  if (!Number.isFinite(position) || position < 0 || position > 86400) fail(422, 'Position must be a number of seconds.');
  const completed = input.completed === true ? 1 : 0;
  const result = await c.env.DB.prepare(`INSERT INTO listen_progress (user_id, track_id, position_seconds, completed, updated_at)
      SELECT ?1, t.id, MIN(?2, COALESCE(t.duration, ?2)),
        CASE WHEN ?3 = 1 OR (t.duration IS NOT NULL AND ?2 >= t.duration - 10) THEN 1 ELSE 0 END, ?4
      FROM tracks t WHERE t.id = ?5
    ON CONFLICT (user_id, track_id) DO UPDATE SET position_seconds = excluded.position_seconds,
      completed = excluded.completed, updated_at = excluded.updated_at
    RETURNING position_seconds, completed`)
    .bind(user.id, Math.round(position * 10) / 10, completed, Date.now(), c.req.param('id')).first<{ position_seconds: number; completed: number }>();
  if (!result) fail(404, 'Track not found.');
  return c.json({ position: result.position_seconds, completed: Boolean(result.completed) });
});

// ── Discovery ────────────────────────────────────────────────────────────

audio.get('/home', async c => {
  const viewerId = viewerOf(c);
  const weekAgo = Date.now() - WEEK;
  const [continueListening, followedEpisodes, latestEpisodes, newMusic, weekly, popularShows] = await Promise.all([
    viewerId
      ? listTracks(c.env, viewerId, { where: 'lp.completed = 0 AND lp.position_seconds >= 5', order: 'lp.updated_at DESC', limit: 6 })
      : Promise.resolve([] as TrackJson[]),
    viewerId
      ? listTracks(c.env, viewerId, {
          where: `t.kind = 'episode' AND t.show_id IN (SELECT show_id FROM show_follows WHERE user_id = ?)`, params: [viewerId], limit: 10,
        })
      : Promise.resolve([] as TrackJson[]),
    listTracks(c.env, viewerId, { where: `t.kind = 'episode'`, limit: 10 }),
    listTracks(c.env, viewerId, { where: `t.kind = 'song'`, limit: 10 }),
    listTracks(c.env, viewerId, {
      join: `JOIN (SELECT track_id, COUNT(*) AS week_plays FROM track_plays WHERE created_at > ? GROUP BY track_id
        ORDER BY week_plays DESC LIMIT 10) w ON w.track_id = t.id`,
      joinParams: [weekAgo], order: 'w.week_plays DESC, t.play_count DESC', limit: 10,
    }),
    listShows(c.env, viewerId, { order: 's.follower_count DESC, s.track_count DESC, s.id DESC', where: 's.track_count > 0', limit: 8 }),
  ]);
  const popular = weekly.length ? weekly : await listTracks(c.env, viewerId, { where: 't.play_count > 0', order: 't.play_count DESC, t.id DESC', limit: 10 });
  return c.json({
    continue_listening: continueListening,
    new_episodes: followedEpisodes.length ? followedEpisodes : latestEpisodes,
    new_episodes_from: followedEpisodes.length ? 'following' : 'everyone',
    new_music: newMusic,
    popular,
    popular_shows: popularShows,
  });
});

audio.get('/library', async c => {
  const user = requireUser(c);
  const [shows, liked, playlists, uploads, myShows] = await Promise.all([
    listShows(c.env, user.id, { join: 'JOIN show_follows sf ON sf.show_id = s.id AND sf.user_id = ?', joinParams: [user.id], order: 'sf.created_at DESC', limit: 50 }),
    listTracks(c.env, user.id, { join: 'JOIN track_likes lk ON lk.track_id = t.id AND lk.user_id = ?', joinParams: [user.id], order: 'lk.created_at DESC', limit: 50 }),
    listPlaylists(c.env, user.id, 'p.owner_id = ?', [user.id]),
    listTracks(c.env, user.id, { where: 't.owner_id = ?', params: [user.id], limit: 50 }),
    listShows(c.env, user.id, { where: 's.owner_id = ?', params: [user.id], limit: 50 }),
  ]);
  return c.json({ shows, liked, playlists, uploads, my_shows: myShows });
});

// ── Playlists ────────────────────────────────────────────────────────────

audio.get('/playlists', async c => {
  const user = requireUser(c);
  return c.json({ items: await listPlaylists(c.env, user.id, 'p.owner_id = ?', [user.id]) });
});

const visibilityOf = (value: unknown) => (value === 'private' ? 'private' : 'public');

audio.post('/playlists', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const title = str(input.title, MAX_SHOW_TITLE);
  if (!title) fail(422, 'Give the playlist a name.');
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM playlists WHERE owner_id = ?').bind(user.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PLAYLISTS_PER_USER) fail(422, `You can have up to ${MAX_PLAYLISTS_PER_USER} playlists.`);
  const id = newId();
  const now = Date.now();
  await c.env.DB.prepare(`INSERT INTO playlists (id, owner_id, title, description, visibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, user.id, title, str(input.description, 1000), visibilityOf(input.visibility), now, now).run();
  return c.json({ playlist: await onePlaylist(c.env, user.id, id) }, 201);
});

async function playlistTracks(env: Env, viewerId: string | null, playlistId: string) {
  return listTracks(env, viewerId, {
    join: 'JOIN playlist_tracks pt ON pt.track_id = t.id AND pt.playlist_id = ?', joinParams: [playlistId],
    order: 'pt.position, pt.added_at', limit: MAX_PLAYLIST_TRACKS,
  });
}

audio.get('/playlists/:id', async c => {
  const viewerId = viewerOf(c);
  const playlist = await onePlaylist(c.env, viewerId, c.req.param('id'));
  return c.json({ playlist, tracks: await playlistTracks(c.env, viewerId, playlist.id) });
});

audio.patch('/playlists/:id', async c => {
  const row = await ownPlaylist(c, c.req.param('id'));
  const input = await body(c);
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [Date.now()];
  if ('title' in input) {
    const title = str(input.title, MAX_SHOW_TITLE);
    if (!title) fail(422, 'Give the playlist a name.');
    sets.push('title = ?'); params.push(title);
  }
  if ('description' in input) { sets.push('description = ?'); params.push(str(input.description, 1000)); }
  if ('visibility' in input) { sets.push('visibility = ?'); params.push(visibilityOf(input.visibility)); }
  await c.env.DB.prepare(`UPDATE playlists SET ${sets.join(', ')} WHERE id = ?`).bind(...params, row.id).run();
  return c.json({ playlist: await onePlaylist(c.env, row.owner_id as string, row.id as string) });
});

audio.delete('/playlists/:id', async c => {
  const row = await ownPlaylist(c, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM playlists WHERE id = ?').bind(row.id).run();
  return c.json({ ok: true });
});

audio.post('/playlists/:id/tracks', async c => {
  const row = await ownPlaylist(c, c.req.param('id'));
  const input = await body(c);
  const trackId = str(input.track_id, 40);
  const check = await c.env.DB.prepare(`SELECT EXISTS (SELECT 1 FROM tracks WHERE id = ?1) AS found,
      EXISTS (SELECT 1 FROM playlist_tracks WHERE playlist_id = ?2 AND track_id = ?1) AS already`)
    .bind(trackId, row.id).first<{ found: number; already: number }>();
  if (!check?.found) fail(404, 'Track not found.');
  if (check.already) fail(409, 'Already in this playlist.');
  if ((row.track_count as number) >= MAX_PLAYLIST_TRACKS) fail(422, `Playlists hold up to ${MAX_PLAYLIST_TRACKS} tracks.`);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
      VALUES (?1, ?2, COALESCE((SELECT MAX(position) FROM playlist_tracks WHERE playlist_id = ?1), -1) + 1, ?3)`).bind(row.id, trackId, now),
    c.env.DB.prepare(`UPDATE playlists SET track_count = (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?1), updated_at = ?2
      WHERE id = ?1`).bind(row.id, now),
  ]);
  return c.json({ playlist: await onePlaylist(c.env, row.owner_id as string, row.id as string) }, 201);
});

audio.delete('/playlists/:id/tracks/:trackId', async c => {
  const row = await ownPlaylist(c, c.req.param('id'));
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').bind(row.id, c.req.param('trackId')),
    c.env.DB.prepare(`UPDATE playlists SET track_count = (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?1), updated_at = ?2
      WHERE id = ?1`).bind(row.id, now),
  ]);
  return c.json({ playlist: await onePlaylist(c.env, row.owner_id as string, row.id as string) });
});

audio.put('/playlists/:id/order', async c => {
  const row = await ownPlaylist(c, c.req.param('id'));
  const input = await body<{ track_ids?: unknown }>(c);
  const ids = Array.isArray(input.track_ids) ? input.track_ids.filter((x): x is string => typeof x === 'string') : [];
  const { results } = await c.env.DB.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?').bind(row.id).all<{ track_id: string }>();
  const current = new Set(results.map(r => r.track_id));
  if (ids.length !== current.size || new Set(ids).size !== ids.length || ids.some(id => !current.has(id)))
    fail(422, 'The playlist changed. Reload and try again.');
  if (ids.length) {
    await c.env.DB.batch([
      ...ids.map((trackId, position) => c.env.DB.prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?')
        .bind(position, row.id, trackId)),
      c.env.DB.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').bind(Date.now(), row.id),
    ]);
  }
  return c.json({ tracks: await playlistTracks(c.env, row.owner_id as string, row.id as string) });
});

export default audio;
