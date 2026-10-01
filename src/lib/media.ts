// Files live in D1, not R2, in the same database as everything else. A D1 row is capped at 2 MB
// and a free-plan database at 500 MB, so:
//  • files are split into CHUNK_SIZE chunks, one row each in `chunks`, uploaded one request per chunk;
//  • files may take up to FILES_SOFT_LIMIT in total, leaving the rest for posts, users and so on.
// Serving honours Range requests one chunk at a time (a video seek costs one query), and
// chunks are immutable, so they are kept in the Cache API as well.

import type { Env } from '../env';

export const CHUNK_SIZE = 1536 * 1024; // 1.5 MiB, comfortably under D1's 2 MB row limit
export const FILES_SOFT_LIMIT = 400 * 1024 * 1024; // of the 500 MB free cap, shared with everything else

export const limits = {
  image: 10 * 1024 * 1024,
  // Unranged requests stream every chunk in one invocation; free Workers get 50 D1 queries each.
  // 60 MB is 40 chunks, which leaves room for the metadata query. (Audio: an hour-long podcast.)
  audio: 60 * 1024 * 1024,
  video: 60 * 1024 * 1024,
} as const;

export const allowedTypes: Record<keyof typeof limits, RegExp> = {
  image: /^image\/(jpeg|png|gif|webp|avif)$/,
  video: /^video\/(mp4|webm|quicktime)$/,
  audio: /^audio\/(mpeg|mp4|ogg|webm|wav|aac)$/,
};

export interface MediaRow {
  id: string;
  owner_id: string;
  kind: 'image' | 'video' | 'audio';
  content_type: string;
  size: number;
  chunk_size: number;
  chunk_count: number;
  chunks_received: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  poster_id: string | null;
  alt: string;
  status: 'uploading' | 'ready';
  created_at: number;
}

/** Public shape for API responses. */
export const mediaJson = (m: MediaRow) => ({
  id: m.id,
  kind: m.kind,
  url: `/media/${m.id}`,
  content_type: m.content_type,
  size: m.size,
  width: m.width,
  height: m.height,
  duration: m.duration,
  poster_url: m.poster_id ? `/media/${m.poster_id}` : null,
  alt: m.alt,
});
export type MediaJson = ReturnType<typeof mediaJson>;

/** Throws if `size` more bytes of files would go over FILES_SOFT_LIMIT. Unfinished uploads count. */
export async function checkSpace(env: Env, size: number): Promise<void> {
  const row = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM media').first<{ bytes: number }>();
  if ((row?.bytes ?? 0) + size > FILES_SOFT_LIMIT) throw new Error('Storage is full.');
}

export async function getMedia(env: Env, id: string): Promise<MediaRow | null> {
  return env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(id).first<MediaRow>();
}

/** Loads ready media rows owned by `ownerId`, preserving the requested order. Throws on anything else. */
export async function ownedReadyMedia(env: Env, ownerId: string, ids: string[]): Promise<MediaRow[]> {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT * FROM media WHERE owner_id = ? AND status = 'ready' AND id IN (${ids.map(() => '?').join(', ')})`,
  ).bind(ownerId, ...ids).all<MediaRow>();
  const byId = new Map(results.map(m => [m.id, m]));
  return ids.map(id => {
    const m = byId.get(id);
    if (!m) throw new Error(`Media ${id} is not yours or has not finished uploading`);
    return m;
  });
}

/** Deletes files; their chunks go with them (ON DELETE CASCADE). */
export async function deleteMedia(env: Env, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT id, poster_id FROM media WHERE id IN (${ids.map(() => '?').join(', ')})`,
  ).bind(...ids).all<{ id: string; poster_id: string | null }>();
  if (!results.length) return;
  await env.DB.prepare(`DELETE FROM media WHERE id IN (${results.map(() => '?').join(', ')})`).bind(...results.map(m => m.id)).run();
  const posters = results.map(m => m.poster_id).filter((p): p is string => Boolean(p));
  if (posters.length) await deleteMedia(env, posters);
}

const cacheKey = (id: string, idx: number) => `https://social-media-cache.southbag.internal/${id}/${idx}`;

async function readChunk(env: Env, media: MediaRow, idx: number, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Uint8Array> {
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  const key = cacheKey(media.id, idx);
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const row = await env.DB.prepare('SELECT data FROM chunks WHERE media_id = ? AND idx = ?')
    .bind(media.id, idx).first<{ data: ArrayBuffer | number[] }>();
  if (!row) throw new Error(`Chunk ${idx} of ${media.id} is missing`);
  const bytes = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : new Uint8Array(row.data);
  if (cache) ctx.waitUntil(cache.put(key, new Response(bytes, {
    headers: { 'cache-control': 'public, max-age=31536000, immutable' },
  })).catch(() => {}));
  return bytes;
}

/** Serves a file with Range support. */
export async function serveMedia(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }, id: string): Promise<Response> {
  const media = await getMedia(env, id);
  if (!media || media.status !== 'ready') return new Response('Not found', { status: 404 });

  const headers = new Headers({
    'content-type': media.content_type,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000, immutable',
    etag: `"${media.id}"`,
    'x-content-type-options': 'nosniff',
  });
  if (request.headers.get('if-none-match') === `"${media.id}"`) return new Response(null, { status: 304, headers });

  const range = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start: number, end: number;
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), media.size - 1) : media.size - 1;
    } else {
      start = Math.max(0, media.size - Number(range[2]));
      end = media.size - 1;
    }
    if (start >= media.size || start > end) {
      headers.set('content-range', `bytes */${media.size}`);
      return new Response(null, { status: 416, headers });
    }
    // Answer with (at most) the one chunk that holds `start`; players ask again for the rest.
    const idx = Math.floor(start / media.chunk_size);
    const chunkStart = idx * media.chunk_size;
    end = Math.min(end, chunkStart + media.chunk_size - 1);
    const chunk = await readChunk(env, media, idx, ctx);
    const slice = chunk.subarray(start - chunkStart, end - chunkStart + 1);
    headers.set('content-range', `bytes ${start}-${end}/${media.size}`);
    headers.set('content-length', String(slice.byteLength));
    return new Response(request.method === 'HEAD' ? null : slice, { status: 206, headers });
  }

  headers.set('content-length', String(media.size));
  if (request.method === 'HEAD') return new Response(null, { headers });
  if (media.chunk_count === 1) return new Response(await readChunk(env, media, 0, ctx), { headers });
  let next = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next >= media.chunk_count) return controller.close();
      controller.enqueue(await readChunk(env, media, next++, ctx));
    },
  });
  return new Response(stream, { headers });
}

/**
 * SQL condition (for a `media m` alias) that is true while anything still refers to the file.
 * Every table that stores a media id must be listed here, or its files can be deleted from under it.
 */
export const MEDIA_IN_USE = `(
  EXISTS (SELECT 1 FROM post_media pm JOIN posts p ON p.id = pm.post_id WHERE pm.media_id = m.id AND p.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM media v WHERE v.poster_id = m.id)
  OR EXISTS (SELECT 1 FROM stories WHERE media_id = m.id)
  OR EXISTS (SELECT 1 FROM messages WHERE media_id = m.id)
  OR EXISTS (SELECT 1 FROM users WHERE avatar_media_id = m.id OR banner_media_id = m.id)
  OR EXISTS (SELECT 1 FROM groups WHERE avatar_media_id = m.id OR banner_media_id = m.id)
  OR EXISTS (SELECT 1 FROM communities WHERE icon_media_id = m.id OR banner_media_id = m.id)
  OR EXISTS (SELECT 1 FROM threads WHERE media_id = m.id AND deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM events WHERE cover_media_id = m.id)
  OR EXISTS (SELECT 1 FROM shows WHERE cover_media_id = m.id)
  OR EXISTS (SELECT 1 FROM tracks WHERE media_id = m.id OR cover_media_id = m.id)
  OR EXISTS (SELECT 1 FROM servers WHERE icon_media_id = m.id)
  OR EXISTS (SELECT 1 FROM channel_messages WHERE media_id = m.id AND deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM companies WHERE logo_media_id = m.id)
  OR EXISTS (SELECT 1 FROM marketplace_photos mkp JOIN marketplace_listings mkl ON mkl.id = mkp.listing_id WHERE mkp.media_id = m.id AND mkl.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM pins WHERE media_id = m.id)
  OR EXISTS (SELECT 1 FROM wiki_spaces WHERE logo_media_id = m.id)
  OR EXISTS (SELECT 1 FROM wiki_files WHERE media_id = m.id)
)`;

/** True while anything still refers to the file. */
export async function mediaInUse(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${MEDIA_IN_USE} AS used FROM media m WHERE m.id = ?`).bind(id).first<{ used: number }>();
  return Boolean(row?.used);
}

/** Deletes the files among `ids` that nothing refers to any more (replaced covers, deleted threads…). */
export async function deleteUnusedMedia(env: Env, ids: (string | null | undefined)[]): Promise<void> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return;
  const { results } = await env.DB.prepare(
    `SELECT m.id FROM media m WHERE m.id IN (${unique.map(() => '?').join(', ')}) AND NOT ${MEDIA_IN_USE}`,
  ).bind(...unique).all<{ id: string }>();
  await deleteMedia(env, results.map(r => r.id));
}
