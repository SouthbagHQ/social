// Files live in D1, not R2. A D1 row is capped at 2 MB and a free-plan database at 500 MB, so:
//  • files are split into CHUNK_SIZE chunks, one row each, uploaded one request per chunk;
//  • chunks go to a "shard" database — MEDIA, plus MEDIA_1 … MEDIA_9 if you bind more —
//    and new uploads pick the emptiest shard, so storage grows by adding databases.
// Serving honours Range requests one chunk at a time (a video seek costs one query), and
// chunks are immutable, so they are kept in the Cache API as well.

import type { Env } from '../env';

export const CHUNK_SIZE = 1536 * 1024; // 1.5 MiB, comfortably under D1's 2 MB row limit
export const SHARD_SOFT_LIMIT = 450 * 1024 * 1024; // leave headroom under the 500 MB free cap

export const limits = {
  image: 10 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  // Unranged requests stream every chunk in one invocation; free Workers get 50 D1 queries each.
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
  shard: string;
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

/** Every bound chunk store, in order. */
export function shardNames(env: Env): string[] {
  const names = ['MEDIA'];
  for (let i = 1; i <= 9; i++) if (env[`MEDIA_${i}`]) names.push(`MEDIA_${i}`);
  return names;
}

export function shardDb(env: Env, shard: string): D1Database {
  const db = env[shard] as D1Database | undefined;
  if (!db) throw new Error(`Chunk store ${shard} is not bound`);
  return db;
}

/** Picks the emptiest chunk store and reserves `size` bytes in it. */
export async function reserveShard(env: Env, size: number): Promise<string> {
  const names = shardNames(env);
  const { results } = await env.DB.prepare('SELECT shard, bytes FROM media_shards').all<{ shard: string; bytes: number }>();
  const used = new Map(results.map(r => [r.shard, r.bytes]));
  const shard = names
    .map(name => ({ name, bytes: used.get(name) ?? 0 }))
    .sort((a, b) => a.bytes - b.bytes)[0];
  if (shard.bytes + size > SHARD_SOFT_LIMIT)
    throw new Error('Southbag has run out of places to put your content. Bind another MEDIA_n database.');
  await env.DB.prepare(`INSERT INTO media_shards (shard, bytes) VALUES (?, ?)
    ON CONFLICT(shard) DO UPDATE SET bytes = bytes + excluded.bytes`).bind(shard.name, size).run();
  return shard.name;
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

/** Deletes files and their chunks, and gives the space back to their shards. */
export async function deleteMedia(env: Env, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT id, shard, size, poster_id FROM media WHERE id IN (${ids.map(() => '?').join(', ')})`,
  ).bind(...ids).all<{ id: string; shard: string; size: number; poster_id: string | null }>();
  if (!results.length) return;
  for (const m of results) await shardDb(env, m.shard).prepare('DELETE FROM chunks WHERE media_id = ?').bind(m.id).run();
  await env.DB.batch([
    ...results.map(m => env.DB.prepare('UPDATE media_shards SET bytes = MAX(0, bytes - ?) WHERE shard = ?').bind(m.size, m.shard)),
    env.DB.prepare(`DELETE FROM media WHERE id IN (${results.map(() => '?').join(', ')})`).bind(...results.map(m => m.id)),
  ]);
  const posters = results.map(m => m.poster_id).filter((p): p is string => Boolean(p));
  if (posters.length) await deleteMedia(env, posters);
}

const cacheKey = (id: string, idx: number) => `https://social-media-cache.southbag.internal/${id}/${idx}`;

async function readChunk(env: Env, media: MediaRow, idx: number, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Uint8Array> {
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  const key = cacheKey(media.id, idx);
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const row = await shardDb(env, media.shard).prepare('SELECT data FROM chunks WHERE media_id = ? AND idx = ?')
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
