// People: profiles, follows, friends, blocks, profile tabs, suggestions and the
// Southbag Verified subscription. Mounted at /api/users.
//
//   GET    /api/users/suggested?limit&exclude=friends -> { items: [UserCard + { bio, is_following, mutual }] }
//   GET    /api/users/me/friend-requests             -> { incoming: [...], outgoing: [...] }
//   POST   /api/users/me/verify                      -> { verified, tier, charged, bag_balance, message }
//   DELETE /api/users/me/verify                      -> { verified, charged, bag_balance, message }
//   GET    /api/users/:handle                        -> { user, viewer }
//   PUT    /api/users/:handle/follow                 DELETE ...   -> { is_following, follower_count }
//   GET    /api/users/:handle/followers?cursor       -> { items: [UserCard + { bio, is_following }], next }
//   GET    /api/users/:handle/following?cursor       -> same
//   PUT    /api/users/:handle/friend                 -> { friendship }   (request, or accept an incoming one)
//   DELETE /api/users/:handle/friend                 -> { friendship }   (cancel / decline / unfriend)
//   GET    /api/users/:handle/friends?cursor         -> { items, next }
//   PUT    /api/users/:handle/block                  DELETE ...   -> { blocked }
//   GET    /api/users/:handle/posts?tab&cursor       -> { items: PostJson[], next }
//
// `:handle` may also be `me` for the signed-in account.
// Lists of people page by (created_at, rowid) - "<ms>.<rowid>" cursors - because the join
// tables have no time-sortable id.

import { Hono } from 'hono';
import type { AppEnv, Ctx, SessionUser } from '../env';
import { body, cursor, fail, limit, placeholders, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { hydrate, visibleTo, type PostRow } from '../lib/posts';
import { userCard, userCardColumns, type UserRow } from '../lib/users';

const users = new Hono<AppEnv>();

const u = (alias: string) => userCardColumns.split(', ').map(col => `${alias}.${col}`).join(', ');

interface ProfileRow extends UserRow {
  bio: string;
  location: string;
  website: string;
  banner_media_id: string | null;
  created_at: number;
  follower_count: number;
  following_count: number;
  post_count: number;
  pinned_post_id: string | null;
}

type ListRow = UserRow & { bio: string; is_following: number; sort_at: number; rid: number };

/** Looks up the person a route is about. `me` means the signed-in account. */
async function target(c: Ctx): Promise<ProfileRow> {
  const handle = c.req.param('handle')!.replace(/^@/, '');
  const viewer = c.get('user');
  const row = handle.toLowerCase() === 'me' && viewer
    ? await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(viewer.id).first<ProfileRow>()
    : await c.env.DB.prepare('SELECT * FROM users WHERE handle = ?').bind(handle).first<ProfileRow>();
  if (!row) fail(404, 'User not found.');
  return row;
}

/** Someone the signed-in user is acting on (not themselves, and nobody who has blocked them). */
async function actOn(c: Ctx, selfMessage: string): Promise<{ me: SessionUser; them: ProfileRow }> {
  const me = requireUser(c);
  const them = await target(c);
  if (them.id === me.id) fail(422, selfMessage);
  return { me, them };
}

async function blockedEitherWay(c: Ctx, a: string, b: string): Promise<boolean> {
  const row = await c.env.DB.prepare(`SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`)
    .bind(a, b, b, a).first();
  return Boolean(row);
}

/** "<ms>.<rowid>" keyset cursor. */
function parseCursor(c: Ctx): [number, number] | null {
  const raw = cursor(c);
  const m = raw?.match(/^(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function peoplePage(rows: ListRow[], size: number) {
  const slice = rows.slice(0, size);
  const last = slice[slice.length - 1];
  return {
    items: slice.map(r => ({ ...userCard(r), bio: r.bio, is_following: Boolean(r.is_following) })),
    next: rows.length > size && last ? `${last.sort_at}.${last.rid}` : null,
  };
}

const friendshipState = (row: { requester_id: string; status: string } | null, viewerId: string) =>
  !row ? 'none' : row.status === 'accepted' ? 'friends' : row.requester_id === viewerId ? 'requested' : 'incoming';

// -- Suggestions -----------------------------------------------------------

users.get('/suggested', async c => {
  const viewer = c.get('user');
  const size = limit(c, 5, 20);
  const exclude = viewer?.id ?? '';
  // ?exclude=friends also leaves out friends and anyone with a pending friend request either way.
  const noFriends = c.req.query('exclude') === 'friends' && Boolean(viewer);
  const notFriends = (p: string) => `AND NOT EXISTS (SELECT 1 FROM friendships fr
      WHERE (fr.requester_id = ${p} AND fr.addressee_id = u.id) OR (fr.addressee_id = ${p} AND fr.requester_id = u.id))`;
  // People followed by the people you follow, most shared first.
  const { results: fof } = viewer
    ? await c.env.DB.prepare(`SELECT f2.followee_id AS id, COUNT(*) AS mutual
        FROM follows f1 JOIN follows f2 ON f2.follower_id = f1.followee_id
        WHERE f1.follower_id = ?1 AND f2.followee_id != ?1
          AND NOT EXISTS (SELECT 1 FROM follows x WHERE x.follower_id = ?1 AND x.followee_id = f2.followee_id)
        GROUP BY f2.followee_id ORDER BY mutual DESC LIMIT ?2`).bind(viewer.id, size).all<{ id: string; mutual: number }>()
    : { results: [] as { id: string; mutual: number }[] };
  const mutual = new Map(fof.map(r => [r.id, r.mutual]));
  // Then whoever is popular.
  const { results: popular } = await c.env.DB.prepare(`SELECT id FROM users u WHERE u.id != ?1
      AND NOT EXISTS (SELECT 1 FROM follows x WHERE x.follower_id = ?1 AND x.followee_id = u.id)
      ${noFriends ? notFriends('?1') : ''}
      ORDER BY u.follower_count DESC, u.post_count DESC, u.id LIMIT ?2`).bind(exclude, size * 2).all<{ id: string }>();
  const ids = [...new Set([...fof.map(r => r.id), ...popular.map(r => r.id)])];
  if (!ids.length) return c.json({ items: [] });
  const { results } = await c.env.DB.prepare(`SELECT ${u('u')}, u.bio FROM users u WHERE u.id IN (${placeholders(ids.length)})
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?))
      ${noFriends ? notFriends('?') : ''}`)
    .bind(...ids, exclude, exclude, ...(noFriends ? [exclude, exclude] : [])).all<UserRow & { bio: string }>();
  const byId = new Map(results.map(r => [r.id, r]));
  const items = ids.map(id => byId.get(id)).filter((r): r is UserRow & { bio: string } => Boolean(r)).slice(0, size)
    .map(r => ({ ...userCard(r), bio: r.bio, is_following: false, mutual: mutual.get(r.id) ?? 0 }));
  return c.json({ items });
});

// -- Friend requests (the signed-in account) -----------------------------

users.get('/me/friend-requests', async c => {
  const me = requireUser(c);
  const query = (mine: 'requester_id' | 'addressee_id', theirs: 'requester_id' | 'addressee_id') =>
    c.env.DB.prepare(`SELECT ${u('u')}, u.bio, fr.created_at AS requested_at,
        EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ?1 AND f.followee_id = u.id) AS is_following
      FROM friendships fr JOIN users u ON u.id = fr.${theirs}
      WHERE fr.${mine} = ?1 AND fr.status = 'pending' ORDER BY fr.created_at DESC LIMIT 50`)
      .bind(me.id).all<UserRow & { bio: string; requested_at: number; is_following: number }>();
  const [incoming, outgoing] = await Promise.all([query('addressee_id', 'requester_id'), query('requester_id', 'addressee_id')]);
  const shape = (r: UserRow & { bio: string; requested_at: number; is_following: number }) =>
    ({ ...userCard(r), bio: r.bio, is_following: Boolean(r.is_following), requested_at: r.requested_at });
  return c.json({ incoming: incoming.results.map(shape), outgoing: outgoing.results.map(shape) });
});

// -- Southbag Verified (one monthly price; shows "Verified" next to your name) --

const VERIFIED_CENTS = 800;

users.post('/me/verify', async c => {
  const me = requireUser(c);
  const row = await c.env.DB.prepare('UPDATE users SET verified = 1, bag_balance = bag_balance + ?, updated_at = ? WHERE id = ? AND verified = 0 RETURNING bag_balance')
    .bind(VERIFIED_CENTS, Date.now(), me.id).first<{ bag_balance: number }>();
  if (!row) {
    // Already subscribed: nothing to charge.
    const current = await c.env.DB.prepare('SELECT bag_balance FROM users WHERE id = ?').bind(me.id).first<{ bag_balance: number }>();
    return c.json({ verified: true, tier: 'standard', charged: 0, bag_balance: current?.bag_balance ?? 0, message: 'You are already subscribed.' });
  }
  await c.env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, body, created_at) VALUES (?, ?, NULL, 'system', ?, ?)`)
    .bind(newId(), me.id, 'Your Southbag Verified subscription is active.', Date.now()).run();
  return c.json({
    verified: true, tier: 'standard', charged: VERIFIED_CENTS, bag_balance: row.bag_balance,
    message: 'Subscribed to Southbag Verified.',
  });
});

users.delete('/me/verify', async c => {
  const me = requireUser(c);
  const row = await c.env.DB.prepare('UPDATE users SET verified = 0, updated_at = ? WHERE id = ? AND verified = 1 RETURNING bag_balance')
    .bind(Date.now(), me.id).first<{ bag_balance: number }>();
  if (!row) fail(409, 'You are not subscribed.');
  return c.json({
    verified: false, charged: 0, bag_balance: row.bag_balance,
    message: 'Subscription cancelled.',
  });
});

// -- Profiles --------------------------------------------------------------

users.get('/:handle', async c => {
  const viewer = c.get('user');
  const them = await target(c);
  const v = viewer?.id ?? '';
  const now = Date.now();
  const extra = await c.env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM friendships WHERE requester_id = ?1 AND status = 'accepted')
        + (SELECT COUNT(*) FROM friendships WHERE addressee_id = ?1 AND status = 'accepted') AS friend_count,
      EXISTS (SELECT 1 FROM stories WHERE author_id = ?1 AND expires_at > ?3) AS has_story,
      EXISTS (SELECT 1 FROM follows WHERE follower_id = ?2 AND followee_id = ?1) AS is_following,
      EXISTS (SELECT 1 FROM follows WHERE follower_id = ?1 AND followee_id = ?2) AS follows_you,
      EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ?2 AND blocked_id = ?1) AS blocked,
      EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ?1 AND blocked_id = ?2) AS blocked_by`)
    .bind(them.id, v, now)
    .first<{ friend_count: number; has_story: number; is_following: number; follows_you: number; blocked: number; blocked_by: number }>();
  const friendship = viewer && viewer.id !== them.id
    ? await c.env.DB.prepare(`SELECT requester_id, status FROM friendships
        WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`)
        .bind(viewer.id, them.id, them.id, viewer.id).first<{ requester_id: string; status: string }>()
    : null;
  return c.json({
    user: {
      ...userCard(them),
      bio: them.bio,
      location: them.location,
      website: them.website,
      banner_url: them.banner_media_id ? `/media/${them.banner_media_id}` : null,
      created_at: them.created_at,
      follower_count: them.follower_count,
      following_count: them.following_count,
      post_count: them.post_count,
      friend_count: extra?.friend_count ?? 0,
      pinned_post_id: them.pinned_post_id ?? null,
    },
    viewer: {
      is_me: viewer?.id === them.id,
      is_following: Boolean(extra?.is_following),
      follows_you: Boolean(extra?.follows_you),
      friendship: viewer && viewer.id !== them.id ? friendshipState(friendship, viewer.id) : 'none',
      blocked: Boolean(extra?.blocked),
      blocked_by: Boolean(extra?.blocked_by),
      has_story: Boolean(extra?.has_story),
    },
  });
});

// -- Follows ----------------------------------------------------

users.put('/:handle/follow', async c => {
  const { me, them } = await actOn(c, 'You cannot follow yourself.');
  if (await blockedEitherWay(c, me.id, them.id)) fail(403, `You cannot follow @${them.handle}.`);
  const now = Date.now();
  // Every statement is conditional on the follow not existing yet, so repeating the request
  // (or racing it) never double-counts. The batch runs as one transaction.
  const notYet = 'NOT EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?)';
  await c.env.DB.batch([
    // At most one follow notification per person per day, however often they re-follow.
    c.env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, created_at)
      SELECT ?, ?, ?, 'follow', ? WHERE ${notYet}
        AND NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = ? AND actor_id = ? AND type = 'follow' AND created_at > ?)`)
      .bind(newId(now), them.id, me.id, now, me.id, them.id, them.id, me.id, now - 86400000),
    c.env.DB.prepare(`UPDATE users SET following_count = following_count + 1 WHERE id = ? AND ${notYet}`).bind(me.id, me.id, them.id),
    c.env.DB.prepare(`UPDATE users SET follower_count = follower_count + 1 WHERE id = ? AND ${notYet}`).bind(them.id, me.id, them.id),
    c.env.DB.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').bind(me.id, them.id, now),
  ]);
  const row = await c.env.DB.prepare('SELECT follower_count FROM users WHERE id = ?').bind(them.id).first<{ follower_count: number }>();
  return c.json({ is_following: true, follower_count: row?.follower_count ?? 0 });
});

/** Statements that remove a follow and fix both counters, only if it exists. */
function unfollowStatements(c: Ctx, follower: string, followee: string): D1PreparedStatement[] {
  const exists = 'EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?)';
  return [
    c.env.DB.prepare(`UPDATE users SET following_count = MAX(0, following_count - 1) WHERE id = ? AND ${exists}`).bind(follower, follower, followee),
    c.env.DB.prepare(`UPDATE users SET follower_count = MAX(0, follower_count - 1) WHERE id = ? AND ${exists}`).bind(followee, follower, followee),
    c.env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').bind(follower, followee),
  ];
}

users.delete('/:handle/follow', async c => {
  const { me, them } = await actOn(c, 'You cannot unfollow yourself.');
  await c.env.DB.batch(unfollowStatements(c, me.id, them.id));
  const row = await c.env.DB.prepare('SELECT follower_count FROM users WHERE id = ?').bind(them.id).first<{ follower_count: number }>();
  return c.json({ is_following: false, follower_count: row?.follower_count ?? 0 });
});

async function followList(c: Ctx, direction: 'followers' | 'following') {
  const them = await target(c);
  const viewer = c.get('user')?.id ?? '';
  const size = limit(c, 20, 50);
  const after = parseCursor(c);
  // followers: rows where they are the followee; following: rows where they are the follower.
  const [mine, other] = direction === 'followers' ? ['followee_id', 'follower_id'] : ['follower_id', 'followee_id'];
  const { results } = await c.env.DB.prepare(`SELECT ${u('u')}, u.bio, f.created_at AS sort_at, f.rowid AS rid,
      EXISTS (SELECT 1 FROM follows x WHERE x.follower_id = ?1 AND x.followee_id = u.id) AS is_following
    FROM follows f JOIN users u ON u.id = f.${other}
    WHERE f.${mine} = ?2 ${after ? 'AND (f.created_at < ?4 OR (f.created_at = ?4 AND f.rowid < ?5))' : ''}
    ORDER BY f.created_at DESC, f.rowid DESC LIMIT ?3`)
    .bind(viewer, them.id, size + 1, ...(after ?? [])).all<ListRow>();
  return c.json(peoplePage(results, size));
}

users.get('/:handle/followers', c => followList(c, 'followers'));
users.get('/:handle/following', c => followList(c, 'following'));

// -- Friends ----------------------------------------------------
// One row per pair, requester first. A request to someone who already asked you accepts theirs,
// so a reverse duplicate is never created.

users.put('/:handle/friend', async c => {
  const { me, them } = await actOn(c, 'You cannot add yourself as a friend.');
  if (await blockedEitherWay(c, me.id, them.id)) fail(403, `You cannot send @${them.handle} a friend request.`);
  const existing = await c.env.DB.prepare(`SELECT requester_id, status FROM friendships
      WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`)
    .bind(me.id, them.id, them.id, me.id).first<{ requester_id: string; status: string }>();
  const now = Date.now();
  if (existing?.status === 'accepted' || existing?.requester_id === me.id) {
    return c.json({ friendship: friendshipState(existing, me.id) });
  }
  if (existing) {
    // They asked first: accept.
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`)
        .bind(now, them.id, me.id),
      c.env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, created_at) SELECT ?, ?, ?, 'friend_accept', ?
        WHERE changes() > 0`).bind(newId(now), them.id, me.id, now),
    ]);
    return c.json({ friendship: 'friends' });
  }
  await c.env.DB.batch([
    // Guarded against a request crossing in the other direction at the same moment.
    c.env.DB.prepare(`INSERT OR IGNORE INTO friendships (requester_id, addressee_id, status, created_at)
      SELECT ?1, ?2, 'pending', ?3 WHERE NOT EXISTS (SELECT 1 FROM friendships WHERE requester_id = ?2 AND addressee_id = ?1)`)
      .bind(me.id, them.id, now),
    c.env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, created_at) SELECT ?, ?, ?, 'friend_request', ?
      WHERE changes() > 0`).bind(newId(now), them.id, me.id, now),
  ]);
  const row = await c.env.DB.prepare(`SELECT requester_id, status FROM friendships
      WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`)
    .bind(me.id, them.id, them.id, me.id).first<{ requester_id: string; status: string }>();
  return c.json({ friendship: friendshipState(row, me.id) });
});

users.delete('/:handle/friend', async c => {
  const { me, them } = await actOn(c, 'You cannot unfriend yourself.');
  await c.env.DB.prepare(`DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`)
    .bind(me.id, them.id, them.id, me.id).run();
  return c.json({ friendship: 'none' });
});

users.get('/:handle/friends', async c => {
  const them = await target(c);
  const viewer = c.get('user')?.id ?? '';
  const size = limit(c, 20, 50);
  const after = parseCursor(c);
  const { results } = await c.env.DB.prepare(`SELECT ${u('u')}, u.bio, fr.accepted_at AS sort_at, fr.rowid AS rid,
      EXISTS (SELECT 1 FROM follows x WHERE x.follower_id = ?1 AND x.followee_id = u.id) AS is_following
    FROM friendships fr JOIN users u ON u.id = CASE WHEN fr.requester_id = ?2 THEN fr.addressee_id ELSE fr.requester_id END
    WHERE fr.status = 'accepted' AND (fr.requester_id = ?2 OR fr.addressee_id = ?2)
      ${after ? 'AND (fr.accepted_at < ?4 OR (fr.accepted_at = ?4 AND fr.rowid < ?5))' : ''}
    ORDER BY fr.accepted_at DESC, fr.rowid DESC LIMIT ?3`)
    .bind(viewer, them.id, size + 1, ...(after ?? [])).all<ListRow>();
  return c.json(peoplePage(results, size));
});

// -- Blocks ----------------------------------------------------------------

users.put('/:handle/block', async c => {
  const { me, them } = await actOn(c, 'You cannot block yourself.');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').bind(me.id, them.id, Date.now()),
    ...unfollowStatements(c, me.id, them.id),
    ...unfollowStatements(c, them.id, me.id),
    c.env.DB.prepare(`DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`)
      .bind(me.id, them.id, them.id, me.id),
  ]);
  return c.json({ blocked: true });
});

users.delete('/:handle/block', async c => {
  const { me, them } = await actOn(c, 'You cannot unblock yourself.');
  await c.env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(me.id, them.id).run();
  return c.json({ blocked: false });
});

// -- Profile tabs ----------------------------------------------------------

const TABS = ['posts', 'replies', 'media', 'photos', 'videos', 'shorts', 'likes', 'wall'] as const;
type Tab = (typeof TABS)[number];

users.get('/:handle/posts', async c => {
  const them = await target(c);
  const viewer = c.get('user');
  const tab: Tab = (TABS as readonly string[]).includes(c.req.query('tab') || '') ? c.req.query('tab') as Tab : 'posts';
  const size = limit(c, 20, 50);
  const v = visibleTo(viewer?.id ?? null);

  if (tab === 'likes') {
    // Public, like old Twitter. Keyset on (reaction time, post id).
    const raw = cursor(c)?.match(/^(\d+)\.(\w+)$/);
    const { results } = await c.env.DB.prepare(`SELECT p.*, r.created_at AS liked_at FROM reactions r JOIN posts p ON p.id = r.post_id
        WHERE r.user_id = ? AND p.deleted_at IS NULL AND ${v.sql}
          ${raw ? 'AND (r.created_at < ? OR (r.created_at = ? AND r.post_id < ?))' : ''}
        ORDER BY r.created_at DESC, r.post_id DESC LIMIT ?`)
      .bind(them.id, ...v.params, ...(raw ? [Number(raw[1]), Number(raw[1]), raw[2]] : []), size + 1)
      .all<PostRow & { liked_at: number }>();
    const slice = results.slice(0, size);
    const last = slice[slice.length - 1];
    return c.json({
      items: await hydrate(c.env, viewer, slice),
      next: results.length > size && last ? `${last.liked_at}.${last.id}` : null,
    });
  }

  const where: Record<Exclude<Tab, 'likes'>, string> = {
    posts: 'p.author_id = ?1 AND p.reply_to_id IS NULL AND p.group_id IS NULL AND p.wall_user_id IS NULL',
    replies: 'p.author_id = ?1 AND p.reply_to_id IS NOT NULL',
    media: `p.author_id = ?1 AND p.reply_to_id IS NULL AND p.group_id IS NULL AND p.repost_of_id IS NULL
      AND EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.id)`,
    photos: `p.author_id = ?1 AND p.kind = 'photo' AND p.reply_to_id IS NULL AND p.group_id IS NULL`,
    videos: `p.author_id = ?1 AND p.kind = 'video' AND p.reply_to_id IS NULL AND p.group_id IS NULL`,
    shorts: `p.author_id = ?1 AND p.kind = 'short' AND p.reply_to_id IS NULL AND p.group_id IS NULL`,
    // Facebook timeline: what friends wrote on their wall, plus their own posts.
    wall: `p.reply_to_id IS NULL AND (p.wall_user_id = ?1 OR (p.author_id = ?1 AND p.group_id IS NULL AND p.wall_user_id IS NULL))`,
  };
  const after = cursor(c);
  // visibleTo() uses positional `?`; number ours explicitly after its params.
  const n = v.params.length;
  const sql = `SELECT p.* FROM posts p WHERE ${v.sql} AND p.deleted_at IS NULL
      AND ${where[tab].replaceAll('?1', `?${n + 1}`)}
      ${after ? `AND p.id < ?${n + 3}` : ''}
      ORDER BY p.id DESC LIMIT ?${n + 2}`;
  const { results } = await c.env.DB.prepare(sql)
    .bind(...v.params, them.id, size + 1, ...(after ? [after] : [])).all<PostRow>();
  const slice = results.slice(0, size);
  return c.json({
    items: await hydrate(c.env, viewer, slice),
    next: results.length > size ? slice[slice.length - 1].id : null,
  });
});

export default users;
