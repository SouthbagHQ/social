// The signed-in account: GET /api/me (also used as the session probe) and PATCH /api/me.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { body, fail, requireUser, str } from '../lib/http';
import { getMedia } from '../lib/media';
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
    if (!name) fail(422, 'Everyone needs a name. Even you.');
    set('name', name);
  }
  if ('handle' in input) {
    const handle = str(input.handle, 30).replace(/^@/, '');
    if (!/^\w{3,20}$/.test(handle)) fail(422, 'Handles are 3–20 letters, numbers or underscores.');
    // Keeping the handle you already have is always allowed (Kevin is @kevin).
    if (handle.toLowerCase() !== session.handle.toLowerCase() && /^(kevin|southbag|admin|support|api|auth|media|me|suggested|settings|welcome|verified|notifications|friends)$/i.test(handle)) fail(409, 'That handle is reserved for Southbag. And Kevin.');
    const taken = await c.env.DB.prepare('SELECT id FROM users WHERE handle = ? AND id != ?').bind(handle, session.id).first();
    if (taken) fail(409, 'That handle is taken. Someone got there first.');
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
  set('updated_at', Date.now());
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values, session.id).run();
  return c.json({ ok: true });
});

export default me;
