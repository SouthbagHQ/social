// The signed-in account: GET /api/me (also used as the session probe) and PATCH /api/me, plus
//   GET /api/me/data                    -> { items: [{ label, value }], since }   what Southbag Social keeps
//   GET /api/me/activity?before&limit   -> { items: [{ type, text, link, created_at }], next }   your own actions,
//                                          newest first; `next` is the `before` (ms) for the next page

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { money } from '../lib/banking';
import { body, fail, limit, requireUser, str } from '../lib/http';
import { getMedia } from '../lib/media';
import { track } from '../lib/palantir';
import { avatarUrl } from '../lib/users';

const me = new Hono<AppEnv>();

me.get('/', async c => {
  const session = c.get('user');
  if (!session) return c.json({ authenticated: false, user: null });
  const [user, unread] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.id).first<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM notifications WHERE user_id = ?1 AND read_at IS NULL) AS notifications,
        (SELECT COUNT(*) FROM conversation_members cm JOIN conversations cv ON cv.id = cm.conversation_id
          WHERE cm.user_id = ?1 AND cv.last_message_at > cm.last_read_at) AS messages,
        (SELECT COUNT(*) FROM friendships WHERE addressee_id = ?1 AND status = 'pending') AS friend_requests`)
      .bind(session.id).first<{ notifications: number; messages: number; friend_requests: number }>(),
  ]);
  if (!user) return c.json({ authenticated: false, user: null });
  return c.json({
    authenticated: true,
    user: {
      id: user.id,
      handle: user.handle,
      name: user.name,
      email: user.email,
      avatar_url: avatarUrl(user as { avatar_media_id: string | null; identity_picture: string | null }),
      banner_url: user.banner_media_id ? `/media/${user.banner_media_id}` : null,
      bio: user.bio,
      location: user.location,
      website: user.website,
      verified: Boolean(user.verified),
      bag_balance: user.bag_balance,
      follower_count: user.follower_count,
      following_count: user.following_count,
      post_count: user.post_count,
      created_at: user.created_at,
    },
    unread,
  });
});

me.patch('/', async c => {
  const session = requireUser(c);
  const input = await body(c);
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); values.push(value); };

  if ('name' in input) {
    const name = str(input.name, 50);
    if (!name) fail(422, 'Enter a name.');
    set('name', name);
  }
  if ('handle' in input) {
    const handle = str(input.handle, 30).replace(/^@/, '');
    if (!/^\w{3,20}$/.test(handle)) fail(422, 'Handles are 3 to 20 letters, numbers or underscores.');
    // Keeping the handle you already have is always allowed, even a reserved one.
    if (handle.toLowerCase() !== session.handle.toLowerCase() && /^(kevin|southbag|admin|support|api|auth|media|me|suggested|settings|welcome|verified|notifications|friends)$/i.test(handle)) fail(409, 'That handle is not available.');
    const taken = await c.env.DB.prepare('SELECT id FROM users WHERE handle = ? AND id != ?').bind(handle, session.id).first();
    if (taken) fail(409, 'That handle is taken.');
    set('handle', handle);
  }
  if ('bio' in input) set('bio', str(input.bio, 300));
  if ('location' in input) set('location', str(input.location, 60));
  if ('website' in input) {
    const website = str(input.website, 200);
    if (website && !/^https?:\/\/\S+$/i.test(website)) fail(422, 'Websites start with http:// or https://.');
    set('website', website);
  }
  for (const column of ['avatar_media_id', 'banner_media_id'] as const) {
    if (!(column in input)) continue;
    const id = input[column];
    if (id === null) { set(column, null); continue; }
    const file = typeof id === 'string' ? await getMedia(c.env, id) : null;
    if (!file || file.owner_id !== session.id || file.kind !== 'image' || file.status !== 'ready')
      fail(422, 'Upload an image first.');
    set(column, file.id);
  }
  if (!sets.length) fail(422, 'Nothing to change.');
  const fields = sets.map(part => part.split(' ')[0]);
  set('updated_at', Date.now());
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values, session.id).run();
  track(c, 'social_profile_updated', { fields });
  return c.json({ ok: true });
});

// -- What Southbag Social keeps -------------------------------------------------
// Counts only, never contents. Everything here is kept; nothing can be deleted.

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

me.get('/data', async c => {
  const user = requireUser(c);
  const count = (sql: string, ...extra: unknown[]) => c.env.DB.prepare(sql).bind(user.id, ...extra);
  const rows = await c.env.DB.batch<{ n: number; total: number | null }>([
    count('SELECT COUNT(*) AS n FROM posts WHERE author_id = ?'),
    count('SELECT COUNT(*) AS n FROM reactions WHERE user_id = ?'),
    count('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?'),
    count('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?'),
    count('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?'),
    count(`SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (requester_id = ?1 OR addressee_id = ?1)`),
    count('SELECT COUNT(*) AS n FROM conversation_members WHERE user_id = ?'),
    count('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ?'),
    count('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM media WHERE owner_id = ?'),
    count('SELECT COUNT(*) AS n FROM threads WHERE author_id = ?'),
    count('SELECT COUNT(*) AS n FROM thread_comments WHERE author_id = ?'),
    count('SELECT COUNT(*) AS n FROM wiki_revisions WHERE author_id = ?'),
    count('SELECT COUNT(*) AS n FROM marketplace_listings WHERE seller_id = ?'),
    count('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payments WHERE sender_id = ?'),
    count('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payments WHERE recipient_id = ?'),
    count('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?'),
    count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?', Date.now()),
    count('SELECT created_at AS n FROM users WHERE id = ?'),
  ]);
  const [posts, reactions, bookmarks, following, followers, friends, conversations, messages, media, threads, comments,
    wiki, listings, sent, received, notifications, sessions, joined] = rows.map(r => r.results[0] ?? { n: 0, total: 0 });
  return c.json({
    since: joined.n || null,
    items: [
      { label: 'Posts', value: String(posts.n) },
      { label: 'Reactions', value: String(reactions.n) },
      { label: 'Bookmarks', value: String(bookmarks.n) },
      { label: 'Following', value: String(following.n) },
      { label: 'Followers', value: String(followers.n) },
      { label: 'Friends', value: String(friends.n) },
      { label: 'Conversations', value: String(conversations.n) },
      { label: 'Messages sent', value: String(messages.n) },
      { label: 'Photos, videos and audio', value: `${media.n} (${megabytes(media.total ?? 0)})` },
      { label: 'Community posts', value: String(threads.n) },
      { label: 'Community comments', value: String(comments.n) },
      { label: 'Wiki edits', value: String(wiki.n) },
      { label: 'Marketplace listings', value: String(listings.n) },
      { label: 'Payments sent', value: `${sent.n} (${money(sent.total ?? 0)})` },
      { label: 'Payments received', value: `${received.n} (${money(received.total ?? 0)})` },
      { label: 'Notifications', value: String(notifications.n) },
      { label: 'Devices signed in', value: String(sessions.n) },
      { label: 'Deleted items', value: '0' },
    ],
  });
});

// -- Activity log ------------------------------------------------------------------
// The newest of each kind of action (one indexed lookup each, in one batch), merged by time.

interface ActivityRow { type: string; ref: string; at: number; a: string | null; b: string | number | null; c: string | null }

const POST_TEXT: Record<string, string> = { text: 'Posted', photo: 'Posted a photo', video: 'Posted a video', short: 'Posted a short' };

function activityJson(r: ActivityRow) {
  switch (r.type) {
    case 'post': return { text: r.b ? 'Replied to a post' : r.c ? 'Reposted a post' : POST_TEXT[r.a ?? 'text'] ?? 'Posted', link: `/post/${r.ref}` };
    case 'reaction': return { text: 'Reacted to a post', link: `/post/${r.ref}` };
    case 'follow': return { text: `Followed @${r.a}`, link: `/@${r.a}` };
    case 'thread': return { text: `Posted in c/${r.a}`, link: `/c/${r.a}/${r.ref}` };
    case 'comment': return { text: `Commented in c/${r.a}`, link: `/c/${r.a}/${r.ref}` };
    case 'payment': return { text: `Sent ${money(Number(r.b))} to @${r.a}`, link: '/payments' };
    case 'message': return { text: 'Sent a message', link: `/messages/${r.ref}` };
    case 'wiki': return { text: 'Edited a wiki page', link: '/wiki' };
    case 'listing': return { text: 'Listed something on Marketplace', link: `/marketplace/${r.ref}` };
    default: return { text: 'Did something', link: null };
  }
}

me.get('/activity', async c => {
  const user = requireUser(c);
  const size = limit(c, 30);
  const before = Number(c.req.query('before')) || Number.MAX_SAFE_INTEGER;
  // D1 caps how many SELECTs one UNION can hold, so each kind is its own statement in one batch.
  const each = (sql: string) => c.env.DB.prepare(`${sql} LIMIT ?3`).bind(user.id, before, size + 1);
  const batches = await c.env.DB.batch<ActivityRow>([
    each(`SELECT 'post' AS type, p.id AS ref, p.created_at AS at, p.kind AS a, p.reply_to_id AS b, p.repost_of_id AS c
      FROM posts p WHERE p.author_id = ?1 AND p.created_at < ?2 ORDER BY p.id DESC`),
    each(`SELECT 'reaction' AS type, r.post_id AS ref, r.created_at AS at, NULL AS a, NULL AS b, NULL AS c
      FROM reactions r WHERE r.user_id = ?1 AND r.created_at < ?2 ORDER BY r.created_at DESC`),
    each(`SELECT 'follow' AS type, f.followee_id AS ref, f.created_at AS at, u.handle AS a, NULL AS b, NULL AS c
      FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ?1 AND f.created_at < ?2 ORDER BY f.created_at DESC`),
    each(`SELECT 'thread' AS type, t.id AS ref, t.created_at AS at, cm.name AS a, NULL AS b, NULL AS c
      FROM threads t JOIN communities cm ON cm.id = t.community_id WHERE t.author_id = ?1 AND t.created_at < ?2 ORDER BY t.id DESC`),
    each(`SELECT 'comment' AS type, tc.thread_id AS ref, tc.created_at AS at, cm.name AS a, NULL AS b, NULL AS c
      FROM thread_comments tc JOIN threads t ON t.id = tc.thread_id JOIN communities cm ON cm.id = t.community_id
      WHERE tc.author_id = ?1 AND tc.created_at < ?2 ORDER BY tc.id DESC`),
    each(`SELECT 'payment' AS type, p.id AS ref, p.created_at AS at, u.handle AS a, p.amount AS b, NULL AS c
      FROM payments p JOIN users u ON u.id = p.recipient_id WHERE p.sender_id = ?1 AND p.created_at < ?2 ORDER BY p.id DESC`),
    each(`SELECT 'message' AS type, m.conversation_id AS ref, m.created_at AS at, NULL AS a, NULL AS b, NULL AS c
      FROM messages m WHERE m.sender_id = ?1 AND m.payment_id IS NULL AND m.created_at < ?2 ORDER BY m.id DESC`),
    each(`SELECT 'wiki' AS type, w.page_id AS ref, w.created_at AS at, NULL AS a, NULL AS b, NULL AS c
      FROM wiki_revisions w WHERE w.author_id = ?1 AND w.created_at < ?2 ORDER BY w.id DESC`),
    each(`SELECT 'listing' AS type, l.id AS ref, l.created_at AS at, NULL AS a, NULL AS b, NULL AS c
      FROM marketplace_listings l WHERE l.seller_id = ?1 AND l.created_at < ?2 ORDER BY l.id DESC`),
  ]);
  const results = batches.flatMap(b => b.results).sort((x, y) => y.at - x.at).slice(0, size + 1);
  const items = results.slice(0, size);
  return c.json({
    items: items.map(r => ({ type: r.type, ...activityJson(r), created_at: r.at })),
    next: results.length > size ? String(items[items.length - 1].at) : null,
  });
});

export default me;
