// Feeds (Twitter / Facebook core). Mounted at /api/feed.
//
//   GET /api/feed?tab=following|foryou&cursor&limit → { items: PostJson[], next, tab, fallback? }
//       following: top-level posts (and reposts) by people the viewer follows, the viewer's own posts,
//                  posts on the viewer's wall and posts in groups the viewer belongs to. Newest first,
//                  keyset paging by id. If the viewer follows nobody, the for-you feed is returned
//                  instead with `fallback: true` (and its offset cursor).
//       foryou:    recent top-level posts ranked by engagement with a time decay. Offset paging
//                  (`next` is a stringified number). Signed-out visitors always get this.
//   GET /api/feed/bookmarks?cursor&limit → { items, next }   newest bookmark first
//
// `rankedPosts()` is exported for the search/explore routes.

import { Hono } from 'hono';
import type { AppEnv, Ctx, SessionUser } from '../env';
import { cursor, limit, requireUser } from '../lib/http';
import { hydrate, visibleTo, type PostRow } from '../lib/posts';

const feed = new Hono<AppEnv>();

const HOUR = 3600000;
/** How far back "for you" looks, and how many recent posts it scores. */
const WINDOW = 7 * 24 * HOUR;
const CANDIDATES = 1000;
const FLOOR = 200;

/**
 * Posts from groups are only shown in the general feeds to members of that group
 * (visibleTo() lets public group posts through for everyone; feeds are stricter).
 */
function groupFilter(viewerId: string | null, alias = 'p'): { sql: string; params: string[] } {
  if (!viewerId) return { sql: `${alias}.group_id IS NULL`, params: [] };
  return {
    sql: `(${alias}.group_id IS NULL OR ${alias}.group_id IN
      (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = ? AND gm.role != 'pending'))`,
    params: [viewerId],
  };
}

/** Hides authors the viewer has blocked (visibleTo already hides people who blocked the viewer). */
function notBlockedByViewer(viewerId: string | null, alias = 'p'): { sql: string; params: string[] } {
  if (!viewerId) return { sql: '1', params: [] };
  return {
    sql: `NOT EXISTS (SELECT 1 FROM blocks bb WHERE bb.blocker_id = ? AND bb.blocked_id = ${alias}.author_id)`,
    params: [viewerId],
  };
}

let powMissing = false;

export interface RankOptions {
  /** Extra SQL condition on `p` (and its params). */
  where?: string;
  params?: unknown[];
  offset?: number;
  size: number;
}

/**
 * Visible top-level posts ranked by a cheap engagement score with a time decay:
 *   (reactions + 2·replies + 3·reposts + 1) / (age in hours + 2)^1.5
 * Candidates are the newest CANDIDATES posts of the last WINDOW, plus the newest FLOOR top-level
 * posts whatever their age (so a quiet network still has a feed). Plain reposts are left out (the
 * original is ranked instead). Returns up to size + 1 rows so callers can tell if there is more.
 */
export async function rankedPosts(c: Ctx, opts: RankOptions): Promise<PostRow[]> {
  const viewerId = c.get('user')?.id ?? null;
  const v = visibleTo(viewerId);
  const g = groupFilter(viewerId);
  const b = notBlockedByViewer(viewerId);
  const now = Date.now();
  const age = `((${now} - p.created_at) / 3600000.0 + 2)`;
  const run = (decay: string) => c.env.DB.prepare(`SELECT * FROM (
        SELECT p.* FROM posts p
        WHERE p.reply_to_id IS NULL AND p.deleted_at IS NULL
          AND (p.created_at > ? OR p.id >= COALESCE((SELECT id FROM posts WHERE reply_to_id IS NULL
                ORDER BY id DESC LIMIT 1 OFFSET ${FLOOR - 1}), ''))
          AND (p.repost_of_id IS NULL OR p.body != '')
          AND ${v.sql} AND ${g.sql} AND ${b.sql} ${opts.where ? `AND ${opts.where}` : ''}
        ORDER BY p.id DESC LIMIT ${CANDIDATES}
      ) p
      ORDER BY (p.reaction_count + 2 * p.reply_count + 3 * p.repost_count + 1.0) / ${decay} DESC, p.id DESC
      LIMIT ? OFFSET ?`)
    .bind(now - WINDOW, ...v.params, ...g.params, ...b.params, ...(opts.params ?? []), opts.size + 1, opts.offset ?? 0)
    .all<PostRow>();
  if (!powMissing) {
    try {
      return (await run(`pow(${age}, 1.5)`)).results;
    } catch (error) {
      // Should D1 ever lack SQLite's math functions, fall back to a square decay.
      if (!/pow/i.test(String((error as Error)?.message))) throw error;
      powMissing = true;
    }
  }
  return (await run(`(${age} * ${age})`)).results;
}

const offsetOf = (value: string | null): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 5000) : 0;
};

async function forYou(c: Ctx, size: number, after: string | null) {
  const offset = offsetOf(after);
  const rows = await rankedPosts(c, { size, offset });
  const items = await hydrate(c.env, c.get('user'), rows.slice(0, size));
  return { items, next: rows.length > size ? String(offset + size) : null };
}

async function following(c: Ctx, user: SessionUser, size: number, after: string | null) {
  const v = visibleTo(user.id);
  const b = notBlockedByViewer(user.id);
  const { results } = await c.env.DB.prepare(`SELECT p.* FROM posts p
      WHERE p.reply_to_id IS NULL AND p.deleted_at IS NULL
        AND (
          (p.group_id IS NULL AND (
            p.author_id = ?1 OR p.wall_user_id = ?1
            OR p.author_id IN (SELECT f.followee_id FROM follows f WHERE f.follower_id = ?1)))
          OR p.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = ?1 AND gm.role != 'pending')
        )
        AND ${v.sql.replaceAll('?', '?1')} AND ${b.sql.replaceAll('?', '?1')}
        ${after ? 'AND p.id < ?2' : ''}
      ORDER BY p.id DESC LIMIT ${after ? '?3' : '?2'}`)
    .bind(user.id, ...(after ? [after] : []), size + 1).all<PostRow>();
  const items = await hydrate(c.env, user, results.slice(0, size));
  return { items, next: results.length > size ? items[items.length - 1].id : null };
}

feed.get('/', async c => {
  const user = c.get('user');
  const size = limit(c);
  const after = cursor(c);
  const tab = c.req.query('tab') === 'foryou' || !user ? 'foryou' : 'following';
  if (tab === 'following' && user) {
    const follows = await c.env.DB.prepare('SELECT 1 FROM follows WHERE follower_id = ? LIMIT 1').bind(user.id).first();
    if (!follows) return c.json({ ...(await forYou(c, size, after)), tab: 'foryou', fallback: true });
    // An offset cursor means the previous page was a fallback; keep paging that feed.
    if (after && /^\d+$/.test(after)) return c.json({ ...(await forYou(c, size, after)), tab: 'foryou', fallback: true });
    return c.json({ ...(await following(c, user, size, after)), tab: 'following' });
  }
  return c.json({ ...(await forYou(c, size, after)), tab: 'foryou' });
});

feed.get('/bookmarks', async c => {
  const user = requireUser(c);
  const size = limit(c);
  const after = cursor(c);
  // Cursor: "<bookmark created_at>_<post id>" of the last item.
  const [at, id] = after && /^\d+_\w+$/.test(after) ? after.split('_') : [null, null];
  const v = visibleTo(user.id);
  const { results } = await c.env.DB.prepare(`SELECT p.*, bm.created_at AS bookmarked_at FROM bookmarks bm
      JOIN posts p ON p.id = bm.post_id
      WHERE bm.user_id = ? AND p.deleted_at IS NULL AND ${v.sql}
        ${at ? 'AND (bm.created_at < ? OR (bm.created_at = ? AND bm.post_id < ?))' : ''}
      ORDER BY bm.created_at DESC, bm.post_id DESC LIMIT ?`)
    .bind(user.id, ...v.params, ...(at ? [Number(at), Number(at), id] : []), size + 1)
    .all<PostRow & { bookmarked_at: number }>();
  const rows = results.slice(0, size);
  const items = await hydrate(c.env, user, rows);
  const last = rows[rows.length - 1];
  return c.json({ items, next: results.length > size && last ? `${last.bookmarked_at}_${last.id}` : null });
});

export default feed;
