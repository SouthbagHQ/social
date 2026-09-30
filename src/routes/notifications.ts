// Notifications. Mounted at /api/notifications.
//
//   GET  /api/notifications?cursor&limit&unread=1 -> { items: [NotificationJson], next }
//   GET  /api/notifications/unread                -> { notifications, friend_requests }
//   POST /api/notifications/read   { ids? }       -> { ok, unread }   (no ids = mark everything read)
//
// NotificationJson: { id, type, actor: UserCard|null, post: { id, kind, title, body }|null,
//                     group: { slug, name }|null, body, read, created_at }
// Notifications from people you have blocked are hidden. Post excerpts respect visibility.

import { Hono } from 'hono';
import type { AppEnv, Ctx } from '../env';
import { body, cursor, limit, placeholders, requireUser } from '../lib/http';
import { visibleTo } from '../lib/posts';
import { userCards } from '../lib/users';

const notifications = new Hono<AppEnv>();

interface NotificationRow {
  id: string;
  type: string;
  actor_id: string | null;
  post_id: string | null;
  group_id: string | null;
  body: string | null;
  read_at: number | null;
  created_at: number;
}

const EXCERPT = 140;
const excerpt = (text: string) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > EXCERPT ? chars.slice(0, EXCERPT - 1).join('') + '...' : chars.join('');
};

async function unreadCounts(c: Ctx, userId: string) {
  return c.env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM notifications WHERE user_id = ?1 AND read_at IS NULL) AS notifications,
      (SELECT COUNT(*) FROM friendships WHERE addressee_id = ?1 AND status = 'pending') AS friend_requests`)
    .bind(userId).first<{ notifications: number; friend_requests: number }>();
}

notifications.get('/', async c => {
  const me = requireUser(c);
  const size = limit(c, 30, 50);
  const after = cursor(c);
  const unreadOnly = c.req.query('unread') === '1';
  const { results } = await c.env.DB.prepare(`SELECT n.* FROM notifications n
      WHERE n.user_id = ? ${after ? 'AND n.id < ?' : ''} ${unreadOnly ? 'AND n.read_at IS NULL' : ''}
        AND (n.actor_id IS NULL OR NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = n.user_id AND b.blocked_id = n.actor_id))
      ORDER BY n.id DESC LIMIT ?`)
    .bind(me.id, ...(after ? [after] : []), size + 1).all<NotificationRow>();
  const rows = results.slice(0, size);

  const postIds = [...new Set(rows.map(r => r.post_id).filter((x): x is string => Boolean(x)))];
  const groupIds = [...new Set(rows.map(r => r.group_id).filter((x): x is string => Boolean(x)))];
  const v = visibleTo(me.id);
  const [actors, postsRes, groupsRes] = await Promise.all([
    userCards(c.env, rows.map(r => r.actor_id || '')),
    postIds.length
      ? c.env.DB.prepare(`SELECT p.id, p.kind, p.title, p.body, p.deleted_at FROM posts p
          WHERE p.id IN (${placeholders(postIds.length)}) AND ${v.sql}`).bind(...postIds, ...v.params)
          .all<{ id: string; kind: string; title: string | null; body: string; deleted_at: number | null }>()
      : Promise.resolve({ results: [] as { id: string; kind: string; title: string | null; body: string; deleted_at: number | null }[] }),
    groupIds.length
      ? c.env.DB.prepare(`SELECT id, slug, name FROM groups WHERE id IN (${placeholders(groupIds.length)})`).bind(...groupIds)
          .all<{ id: string; slug: string; name: string }>()
      : Promise.resolve({ results: [] as { id: string; slug: string; name: string }[] }),
  ]);
  const posts = new Map(postsRes.results.map(p => [p.id, {
    id: p.id, kind: p.kind, title: p.deleted_at ? null : p.title, body: p.deleted_at ? '' : excerpt(p.body), deleted: Boolean(p.deleted_at),
  }]));
  const groups = new Map(groupsRes.results.map(g => [g.id, { slug: g.slug, name: g.name }]));

  return c.json({
    items: rows.map(r => ({
      id: r.id,
      type: r.type,
      actor: r.actor_id ? actors.get(r.actor_id) ?? null : null,
      post: r.post_id ? posts.get(r.post_id) ?? null : null,
      group: r.group_id ? groups.get(r.group_id) ?? null : null,
      body: r.body,
      read: Boolean(r.read_at),
      created_at: r.created_at,
    })),
    next: results.length > size ? rows[rows.length - 1].id : null,
  });
});

notifications.get('/unread', async c => {
  const me = requireUser(c);
  return c.json(await unreadCounts(c, me.id));
});

notifications.post('/read', async c => {
  const me = requireUser(c);
  const input = await body<{ ids?: unknown }>(c);
  const ids = Array.isArray(input.ids) ? input.ids.filter((x): x is string => typeof x === 'string').slice(0, 100) : null;
  const now = Date.now();
  if (ids) {
    if (ids.length) {
      await c.env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders(ids.length)})`)
        .bind(now, me.id, ...ids).run();
    }
  } else {
    await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(now, me.id).run();
  }
  return c.json({ ok: true, unread: await unreadCounts(c, me.id) });
});

export default notifications;
