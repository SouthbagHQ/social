// Chunked uploads into D1. The browser shrinks photos before sending (public/js/upload.js), then:
//   POST /api/media                      { kind, content_type, size, width?, height?, duration?, poster_id?, alt? }
//                                        → { id, chunk_size, chunk_count }
//   PUT  /api/media/:id/chunks/:idx      raw bytes of chunk idx (each exactly chunk_size, the last may be shorter)
//   POST /api/media/:id/complete         → media JSON once every chunk is in
//   DELETE /api/media/:id                abandon an upload / delete an unused file
// Files are served from GET /media/:id (see index.ts).

import { Hono } from 'hono';
import type { AppEnv, Ctx } from '../env';
import { body, fail, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { track } from '../lib/palantir';
import {
  CHUNK_SIZE, allowedTypes, deleteMedia, getMedia, limits, mediaInUse, mediaJson, reserveShard, shardDb, type MediaRow,
} from '../lib/media';

const media = new Hono<AppEnv>();

const num = (value: unknown, max: number): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
};

media.post('/', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const kind = input.kind as keyof typeof limits;
  if (!(kind in limits)) fail(422, 'Only photos, videos and audio can be uploaded.');
  const contentType = str(input.content_type, 100).toLowerCase();
  if (!allowedTypes[kind].test(contentType)) fail(422, `That kind of ${kind} is not supported.`);
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size <= 0) fail(422, 'File size is required.');
  if (size > limits[kind]) fail(413, `That ${kind} is too big. The limit is ${Math.round(limits[kind] / 1048576)} MB.`);

  let posterId: string | null = null;
  if (typeof input.poster_id === 'string') {
    const poster = await getMedia(c.env, input.poster_id);
    if (!poster || poster.owner_id !== user.id || poster.kind !== 'image' || poster.status !== 'ready')
      fail(422, 'Poster image not found.');
    posterId = poster.id;
  }

  const shard = await reserveShard(c.env, size).catch(e => fail(503, (e as Error).message));
  const id = newId();
  const chunkCount = Math.ceil(size / CHUNK_SIZE);
  await c.env.DB.prepare(`INSERT INTO media (id, owner_id, kind, content_type, size, chunk_size, chunk_count, shard,
    width, height, duration, poster_id, alt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, user.id, kind, contentType, size, CHUNK_SIZE, chunkCount, shard,
      num(input.width, 20000), num(input.height, 20000), num(input.duration, 86400), posterId,
      str(input.alt, 500), Date.now()).run();
  track(c, 'social_upload_started', { media_id: id, kind, content_type: contentType, size, chunk_count: chunkCount });
  return c.json({ id, chunk_size: CHUNK_SIZE, chunk_count: chunkCount }, 201);
});

async function ownUpload(c: Ctx, id: string): Promise<MediaRow> {
  const user = requireUser(c);
  const row = await getMedia(c.env, id);
  if (!row || row.owner_id !== user.id) fail(404, 'Upload not found.');
  return row;
}

media.put('/:id/chunks/:idx', async c => {
  const row = await ownUpload(c, c.req.param('id'));
  if (row.status !== 'uploading') fail(409, 'That upload is already finished.');
  const idx = Number(c.req.param('idx'));
  if (!Number.isInteger(idx) || idx < 0 || idx >= row.chunk_count) fail(422, 'Chunk out of range.');
  const expected = idx === row.chunk_count - 1 ? row.size - idx * row.chunk_size : row.chunk_size;
  const data = await c.req.arrayBuffer();
  if (data.byteLength !== expected) fail(422, `Chunk ${idx} should be ${expected} bytes, got ${data.byteLength}.`);
  await shardDb(c.env, row.shard).prepare('INSERT OR REPLACE INTO chunks (media_id, idx, data) VALUES (?, ?, ?)')
    .bind(row.id, idx, data).run();
  return c.json({ ok: true, idx });
});

media.post('/:id/complete', async c => {
  const row = await ownUpload(c, c.req.param('id'));
  if (row.status === 'ready') return c.json(mediaJson(row));
  const count = await shardDb(c.env, row.shard).prepare('SELECT COUNT(*) AS n FROM chunks WHERE media_id = ?')
    .bind(row.id).first<{ n: number }>();
  if ((count?.n ?? 0) !== row.chunk_count) fail(409, `Still waiting on ${row.chunk_count - (count?.n ?? 0)} chunk(s).`);
  await c.env.DB.prepare(`UPDATE media SET status = 'ready', chunks_received = chunk_count WHERE id = ?`).bind(row.id).run();
  track(c, 'social_upload_completed', { media_id: row.id, kind: row.kind, content_type: row.content_type, size: row.size, chunk_count: row.chunk_count, duration: row.duration ?? null });
  return c.json(mediaJson({ ...row, status: 'ready' }));
});

media.get('/:id', async c => {
  const row = await getMedia(c.env, c.req.param('id'));
  if (!row || row.status !== 'ready') fail(404, 'File not found.');
  return c.json(mediaJson(row));
});

media.delete('/:id', async c => {
  const row = await ownUpload(c, c.req.param('id'));
  if (await mediaInUse(c.env, row.id)) fail(409, 'That file is in use.');
  await deleteMedia(c.env, [row.id]);
  return c.json({ ok: true });
});

export default media;
