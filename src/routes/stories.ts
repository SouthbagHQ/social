// Stories (Instagram): photos and short videos that expire after 24 hours. The hourly janitor in
// index.ts deletes expired stories and their files. Stories are public, like a public Instagram
// account: anyone can watch them, except people the author has blocked.
//
//   POST   /api/stories               { media_id, caption?, background? } → { story }
//   GET    /api/stories               the tray → { items: [{ user, stories_count, latest_at, seen, following }] }
//                                     (yours first, then people you follow, then everyone else; unseen first)
//   GET    /api/stories/:handle       → { user, items: [StoryJson] } oldest first
//   POST   /api/stories/:id/view      records a view (idempotent) → { ok, seen }
//   GET    /api/stories/:id/viewers   owner only → { items: [{ user, created_at }], count }
//   DELETE /api/stories/:id           owner only; deletes the story and its file
//
// StoryJson: { id, media: MediaJson, caption, background, created_at, expires_at, seen, view_count? }
// (view_count only on your own stories). Text-only stories are drawn to a canvas in the browser and
// uploaded as an image; `background` records which preset was used.

import { Hono } from 'hono';
import type { AppEnv, Ctx, Env } from '../env';
import { body, fail, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { deleteMedia, mediaJson, ownedReadyMedia, type MediaRow } from '../lib/media';
import { userByHandle, userCard, userCardColumns, userCards, type UserRow } from '../lib/users';

const stories = new Hono<AppEnv>();

export const STORY_TTL = 24 * 3600 * 1000;
export const MAX_CAPTION = 200;
export const MAX_VIDEO_SECONDS = 60;
const MAX_ACTIVE = 30; // unexpired stories per person
/** Presets the story composer offers; the browser owns the actual gradients. */
export const BACKGROUNDS = ['teal', 'logo', 'promo', 'night', 'paper', 'alert', 'floor3'] as const;

interface StoryRow {
  id: string;
  author_id: string;
  media_id: string;
  caption: string;
  background: string | null;
  created_at: number;
  expires_at: number;
}

const storyJson = (s: StoryRow, media: MediaRow, seen: boolean, viewCount?: number) => ({
  id: s.id,
  media: mediaJson(media),
  caption: s.caption,
  background: s.background,
  created_at: s.created_at,
  expires_at: s.expires_at,
  seen,
  ...(viewCount !== undefined && { view_count: viewCount }),
});

async function liveStory(env: Env, id: string): Promise<StoryRow> {
  const story = await env.DB.prepare('SELECT * FROM stories WHERE id = ? AND expires_at > ?').bind(id, Date.now()).first<StoryRow>();
  if (!story) fail(404, 'That story has expired. It has been retained.');
  return story;
}

stories.post('/', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const mediaId = str(input.media_id, 64);
  if (!mediaId) fail(422, 'A story needs a photo or a video. Kevin does not read.');
  let media: MediaRow;
  try {
    [media] = await ownedReadyMedia(c.env, user.id, [mediaId]);
  } catch (error) {
    fail(422, (error as Error).message);
  }
  if (media.kind !== 'image' && media.kind !== 'video') fail(422, 'Stories are photos or short videos.');
  if (media.kind === 'video') {
    if (media.duration == null) fail(422, 'Kevin could not measure that video. Stories are 60 seconds or less.');
    if (media.duration > MAX_VIDEO_SECONDS + 0.5)
      fail(422, `That video is ${Math.round(media.duration)} seconds. Stories are ${MAX_VIDEO_SECONDS} seconds or less. Kevin timed it.`);
  }
  const background = typeof input.background === 'string' && (BACKGROUNDS as readonly string[]).includes(input.background)
    ? input.background : null;
  const caption = str(input.caption, MAX_CAPTION * 2);
  if ([...caption].length > MAX_CAPTION) fail(422, `Story captions are limited to ${MAX_CAPTION} characters. Kevin counted.`);

  const now = Date.now();
  const check = await c.env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM stories WHERE author_id = ?1 AND expires_at > ?2) AS active,
      EXISTS (SELECT 1 FROM stories WHERE media_id = ?3) OR EXISTS (SELECT 1 FROM post_media WHERE media_id = ?3) AS used`)
    .bind(user.id, now, media.id).first<{ active: number; used: number }>();
  if (check?.used) fail(409, 'That file is already in use. Upload it again. Southbag will keep both.');
  if ((check?.active ?? 0) >= MAX_ACTIVE) fail(429, `You have ${MAX_ACTIVE} live stories. That is enough story. Kevin is aware.`);

  const story: StoryRow = {
    id: newId(now), author_id: user.id, media_id: media.id, caption, background, created_at: now, expires_at: now + STORY_TTL,
  };
  await c.env.DB.prepare(`INSERT INTO stories (id, author_id, media_id, caption, background, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(story.id, story.author_id, story.media_id, story.caption, story.background, story.created_at, story.expires_at).run();
  return c.json({ story: storyJson(story, media, true, 0) }, 201);
});

stories.get('/', async c => {
  const viewer = c.get('user');
  const now = Date.now();
  type TrayRow = { author_id: string; stories_count: number; latest_at: number; unseen: number; following: number };
  let rows: TrayRow[];
  if (viewer) {
    ({ results: rows } = await c.env.DB.prepare(`SELECT s.author_id, COUNT(*) AS stories_count, MAX(s.created_at) AS latest_at,
        SUM(CASE WHEN v.story_id IS NULL THEN 1 ELSE 0 END) AS unseen,
        EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ?1 AND f.followee_id = s.author_id) AS following
      FROM stories s LEFT JOIN story_views v ON v.story_id = s.id AND v.viewer_id = ?1
      WHERE s.expires_at > ?2 AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = s.author_id AND b.blocked_id = ?1)
      GROUP BY s.author_id
      ORDER BY s.author_id = ?1 DESC, following DESC, unseen = 0, latest_at DESC
      LIMIT 50`).bind(viewer.id, now).all<TrayRow>());
  } else {
    ({ results: rows } = await c.env.DB.prepare(`SELECT s.author_id, COUNT(*) AS stories_count, MAX(s.created_at) AS latest_at,
        COUNT(*) AS unseen, 0 AS following
      FROM stories s WHERE s.expires_at > ? GROUP BY s.author_id ORDER BY latest_at DESC LIMIT 30`).bind(now).all<TrayRow>());
  }
  const users = await userCards(c.env, rows.map(r => r.author_id));
  return c.json({
    items: rows.filter(r => users.has(r.author_id)).map(r => ({
      user: users.get(r.author_id)!,
      stories_count: r.stories_count,
      latest_at: r.latest_at,
      // Your own stories count as seen; the ring goes grey once everything is watched.
      seen: viewer?.id === r.author_id ? true : r.unseen === 0,
      following: Boolean(r.following),
    })),
  });
});

stories.get('/:handle', async c => {
  const viewer = c.get('user');
  const author = await userByHandle(c.env, c.req.param('handle'));
  if (!author) fail(404, 'Kevin has closed this story.');
  if (viewer) {
    const blocked = await c.env.DB.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(author.id, viewer.id).first();
    if (blocked) fail(404, 'Kevin has closed this story.');
  }
  const own = viewer?.id === author.id;
  const { results } = await c.env.DB.prepare(`SELECT s.*, m.id AS m_id, m.owner_id, m.kind, m.content_type, m.size, m.chunk_size,
      m.chunk_count, m.chunks_received, m.shard, m.width, m.height, m.duration, m.poster_id, m.alt, m.status, m.created_at AS m_created_at,
      ${viewer ? 'EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.viewer_id = ?)' : '0'} AS seen,
      ${own ? '(SELECT COUNT(*) FROM story_views v WHERE v.story_id = s.id AND v.viewer_id != s.author_id)' : 'NULL'} AS view_count
    FROM stories s JOIN media m ON m.id = s.media_id
    WHERE s.author_id = ? AND s.expires_at > ? ORDER BY s.id ASC LIMIT 100`)
    .bind(...(viewer ? [viewer.id] : []), author.id, Date.now())
    .all<StoryRow & Omit<MediaRow, 'id' | 'created_at'> & { m_id: string; m_created_at: number; seen: number; view_count: number | null }>();
  return c.json({
    user: userCard(author),
    items: results.map(r => storyJson(r, { ...r, id: r.m_id, created_at: r.m_created_at }, own || Boolean(r.seen),
      own ? r.view_count ?? 0 : undefined)),
  });
});

stories.post('/:id/view', async c => {
  const viewer = c.get('user');
  const story = await liveStory(c.env, c.req.param('id'));
  // Signed-out views are not recorded. They are, however, noticed.
  if (!viewer || viewer.id === story.author_id) return c.json({ ok: true, seen: true });
  const blocked = await c.env.DB.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(story.author_id, viewer.id).first();
  if (blocked) fail(404, 'That story has expired. It has been retained.');
  await c.env.DB.prepare('INSERT OR IGNORE INTO story_views (story_id, viewer_id, created_at) VALUES (?, ?, ?)')
    .bind(story.id, viewer.id, Date.now()).run();
  return c.json({ ok: true, seen: true });
});

stories.get('/:id/viewers', async c => {
  const user = requireUser(c);
  const story = await ownStory(c, user.id);
  const [{ results }, total] = await Promise.all([
    c.env.DB.prepare(`SELECT v.created_at AS viewed_at, ${userCardColumns.split(', ').map(col => 'u.' + col).join(', ')}
      FROM story_views v JOIN users u ON u.id = v.viewer_id WHERE v.story_id = ? AND v.viewer_id != ?
      ORDER BY v.created_at DESC LIMIT 100`).bind(story.id, user.id).all<UserRow & { viewed_at: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM story_views WHERE story_id = ? AND viewer_id != ?').bind(story.id, user.id).first<{ n: number }>(),
  ]);
  return c.json({ items: results.map(r => ({ user: userCard(r), created_at: r.viewed_at })), count: total?.n ?? 0 });
});

stories.delete('/:id', async c => {
  const user = requireUser(c);
  const story = await ownStory(c, user.id, true);
  await c.env.DB.prepare('DELETE FROM stories WHERE id = ?').bind(story.id).run();
  const shared = await c.env.DB.prepare(`SELECT EXISTS (SELECT 1 FROM post_media WHERE media_id = ?1)
      OR EXISTS (SELECT 1 FROM stories WHERE media_id = ?1) AS used`).bind(story.media_id).first<{ used: number }>();
  if (!shared?.used) await deleteMedia(c.env, [story.media_id]);
  return c.json({ ok: true });
});

/** The signed-in user's story (expired ones too when `anyAge`), or a 404/403. */
async function ownStory(c: Ctx, userId: string, anyAge = false): Promise<StoryRow> {
  const story = anyAge
    ? await c.env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(c.req.param('id')).first<StoryRow>()
    : await liveStory(c.env, c.req.param('id') as string);
  if (!story) fail(404, 'That story has expired. It has been retained.');
  if (story.author_id !== userId) fail(403, 'That is not your story. Kevin has noted the attempt.');
  return story;
}

export default stories;
