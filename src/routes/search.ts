// Search and discovery. Mounted at /api/search.
//
//   GET /api/search?q=&type=top|posts|people|tags|groups|videos&cursor&limit
//       posts/videos → { items: PostJson[], next }           newest first, keyset by id
//       people       → { items: [UserCard + { bio, is_following, follower_count }], next }   offset cursor
//       tags         → { items: [{ tag, count }], next }      offset cursor
//       groups       → { items: [{ id, slug, name, description, member_count, avatar_url, privacy, is_member }], next }
//       top          → { people: [...≤5], tags: [...≤5], posts: { items, next } }
//   GET /api/search/trending          → { tags: [{ tag, count }] }   top 10, last 7 days (all time as a fallback)
//   GET /api/search/tag/:tag?cursor   → { tag, count, items, next }
//   GET /api/search/explore           → { tags, posts, photos, people }

import { Hono } from 'hono';
import type { AppEnv, Ctx } from '../env';
import { cursor, fail, limit } from '../lib/http';
import { hydrate, visibleTo, type PostRow } from '../lib/posts';
import { userCard, userCardColumns, type UserRow } from '../lib/users';
import { rankedPosts } from './feed';

const search = new Hono<AppEnv>();

const DAY = 86400000;
const types = ['top', 'posts', 'people', 'tags', 'groups', 'videos'] as const;
type SearchType = (typeof types)[number];

/** `%term%` for LIKE … ESCAPE '\', with the wildcards in the term escaped. */
const like = (term: string) => `%${term.replace(/[\\%_]/g, m => '\\' + m)}%`;

const offsetOf = (value: string | null): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 5000) : 0;
};

const uCols = (alias: string) => userCardColumns.split(', ').map(col => `${alias}.${col}`).join(', ');

type PersonRow = UserRow & { bio: string; follower_count: number; is_following: number };

const person = (r: PersonRow) => ({
  ...userCard(r),
  bio: r.bio,
  follower_count: r.follower_count,
  is_following: Boolean(r.is_following),
});

// ── Queries ────────────────────────────────────────────────────────────────

async function searchPosts(c: Ctx, q: string, size: number, after: string | null, videosOnly = false) {
  const viewer = c.get('user');
  const v = visibleTo(viewer?.id ?? null);
  const pattern = like(q);
  const { results } = await c.env.DB.prepare(`SELECT p.* FROM posts p
      WHERE p.deleted_at IS NULL AND (p.body LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\')
        ${videosOnly ? "AND p.kind IN ('video', 'short')" : ''}
        AND ${v.sql} ${after ? 'AND p.id < ?' : ''}
      ORDER BY p.id DESC LIMIT ?`)
    .bind(pattern, pattern, ...v.params, ...(after ? [after] : []), size + 1).all<PostRow>();
  const items = await hydrate(c.env, viewer, results.slice(0, size));
  return { items, next: results.length > size ? items[items.length - 1].id : null };
}

async function searchPeople(c: Ctx, q: string, size: number, offset: number) {
  const viewerId = c.get('user')?.id ?? '';
  const pattern = like(q.replace(/^@/, ''));
  const { results } = await c.env.DB.prepare(`SELECT ${uCols('u')}, u.bio, u.follower_count,
        EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = u.id) AS is_following
      FROM users u
      WHERE (u.handle LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = ?)
      ORDER BY (u.handle = ?) DESC, u.follower_count DESC, u.id
      LIMIT ? OFFSET ?`)
    .bind(viewerId, pattern, pattern, viewerId, q.replace(/^@/, ''), size + 1, offset).all<PersonRow>();
  return { items: results.slice(0, size).map(person), next: results.length > size ? String(offset + size) : null };
}

async function searchTags(c: Ctx, q: string, size: number, offset: number) {
  const tag = q.replace(/^#/, '').trim();
  if (!/^\w+$/u.test(tag)) return { items: [], next: null };
  const { results } = await c.env.DB.prepare(`SELECT tag, COUNT(*) AS count FROM post_tags
      WHERE tag LIKE ? ESCAPE '\\' GROUP BY tag ORDER BY (tag = ?) DESC, count DESC, tag LIMIT ? OFFSET ?`)
    .bind(like(tag), tag, size + 1, offset).all<{ tag: string; count: number }>();
  return { items: results.slice(0, size), next: results.length > size ? String(offset + size) : null };
}

async function searchGroups(c: Ctx, q: string, size: number, offset: number) {
  const viewerId = c.get('user')?.id ?? '';
  const pattern = like(q);
  const { results } = await c.env.DB.prepare(`SELECT g.id, g.slug, g.name, g.description, g.member_count, g.privacy,
        g.avatar_media_id,
        EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = ? AND gm.role != 'pending') AS is_member
      FROM groups g
      WHERE (g.name LIKE ? ESCAPE '\\' OR g.slug LIKE ? ESCAPE '\\' OR g.description LIKE ? ESCAPE '\\')
        AND (g.privacy = 'public' OR EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = ?))
      ORDER BY g.member_count DESC, g.id DESC LIMIT ? OFFSET ?`)
    .bind(viewerId, pattern, pattern, pattern, viewerId, size + 1, offset)
    .all<{ id: string; slug: string; name: string; description: string; member_count: number; privacy: string; avatar_media_id: string | null; is_member: number }>();
  return {
    items: results.slice(0, size).map(g => ({
      id: g.id, slug: g.slug, name: g.name, description: g.description, member_count: g.member_count,
      privacy: g.privacy, avatar_url: g.avatar_media_id ? `/media/${g.avatar_media_id}` : null, is_member: Boolean(g.is_member),
    })),
    next: results.length > size ? String(offset + size) : null,
  };
}

/** Most used tags on public posts: last 7 days, or all time when the week was quiet. */
async function trending(c: Ctx, n = 10): Promise<{ tag: string; count: number }[]> {
  const v = visibleTo(null);
  const run = (since: number) => c.env.DB.prepare(`SELECT pt.tag AS tag, COUNT(*) AS count FROM post_tags pt
      JOIN posts p ON p.id = pt.post_id
      WHERE pt.created_at > ? AND p.deleted_at IS NULL AND ${v.sql}
      GROUP BY pt.tag ORDER BY count DESC, MAX(pt.created_at) DESC LIMIT ?`)
    .bind(since, n).all<{ tag: string; count: number }>();
  const week = await run(Date.now() - 7 * DAY);
  if (week.results.length) return week.results;
  return (await run(0)).results;
}

// ── Routes ─────────────────────────────────────────────────────────────────

search.get('/', async c => {
  const q = (c.req.query('q') || '').trim().slice(0, 100);
  const type: SearchType = (types as readonly string[]).includes(c.req.query('type') || '') ? c.req.query('type') as SearchType : 'top';
  const size = limit(c);
  const after = cursor(c);
  if (!q) {
    if (type === 'top') return c.json({ people: [], tags: [], posts: { items: [], next: null } });
    return c.json({ items: [], next: null });
  }
  switch (type) {
    case 'posts': return c.json(await searchPosts(c, q, size, after));
    case 'videos': return c.json(await searchPosts(c, q, size, after, true));
    case 'people': return c.json(await searchPeople(c, q, size, offsetOf(after)));
    case 'tags': return c.json(await searchTags(c, q, size, offsetOf(after)));
    case 'groups': return c.json(await searchGroups(c, q, size, offsetOf(after)));
    default: {
      const [people, tags, posts] = await Promise.all([
        searchPeople(c, q, 5, 0),
        searchTags(c, q, 5, 0),
        searchPosts(c, q, size, after),
      ]);
      return c.json({ people: people.items, tags: tags.items, posts });
    }
  }
});

search.get('/trending', async c => c.json({ tags: await trending(c) }));

search.get('/tag/:tag', async c => {
  const tag = c.req.param('tag').replace(/^#/, '').toLowerCase();
  if (!/^\w{1,50}$/u.test(tag)) fail(404, 'That is not a tag. Kevin checked.');
  const viewer = c.get('user');
  const size = limit(c);
  const after = cursor(c);
  const v = visibleTo(viewer?.id ?? null);
  const [countRow, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM post_tags pt JOIN posts p ON p.id = pt.post_id
        WHERE pt.tag = ? AND p.deleted_at IS NULL AND ${v.sql}`).bind(tag, ...v.params).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT p.* FROM post_tags pt JOIN posts p ON p.id = pt.post_id
        WHERE pt.tag = ? AND p.deleted_at IS NULL AND ${v.sql} ${after ? 'AND p.id < ?' : ''}
        ORDER BY p.id DESC LIMIT ?`)
      .bind(tag, ...v.params, ...(after ? [after] : []), size + 1).all<PostRow>(),
  ]);
  const items = await hydrate(c.env, viewer, rows.results.slice(0, size));
  return c.json({ tag, count: countRow?.n ?? 0, items, next: rows.results.length > size ? items[items.length - 1].id : null });
});

search.get('/explore', async c => {
  const viewer = c.get('user');
  const v = visibleTo(viewer?.id ?? null);
  const viewerId = viewer?.id ?? '';
  const [tags, top, photos, people] = await Promise.all([
    trending(c),
    rankedPosts(c, { size: 20 }),
    c.env.DB.prepare(`SELECT p.* FROM posts p
        WHERE p.kind = 'photo' AND p.reply_to_id IS NULL AND p.deleted_at IS NULL AND p.group_id IS NULL
          AND EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.id) AND ${v.sql}
        ORDER BY p.id DESC LIMIT 12`).bind(...v.params).all<PostRow>(),
    // People to follow: the most followed, then the newest; not you, not people already in your Pile.
    c.env.DB.prepare(`SELECT ${uCols('u')}, u.bio, u.follower_count, 0 AS is_following FROM users u
        WHERE u.id != ?1 AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ?1 AND f.followee_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = ?1) OR (b.blocker_id = ?1 AND b.blocked_id = u.id))
        ORDER BY u.follower_count DESC, u.created_at DESC LIMIT 6`).bind(viewerId).all<PersonRow>(),
  ]);
  // One hydrate for both lists (it batches every lookup).
  const topRows = top.slice(0, 20);
  const seen = new Set(topRows.map(r => r.id));
  const photoRows = photos.results.filter(r => !seen.has(r.id));
  const hydrated = await hydrate(c.env, viewer, [...topRows, ...photoRows]);
  const byId = new Map(hydrated.map(p => [p.id, p]));
  return c.json({
    tags,
    posts: topRows.map(r => byId.get(r.id)!).filter(Boolean),
    photos: photos.results.map(r => byId.get(r.id)!).filter(Boolean),
    people: people.results.map(person),
  });
});

export default search;
