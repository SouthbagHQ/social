// Push notifications. Mounted at /api/push. Sending is in src/lib/push.ts.
//
//   GET    /api/push                                                -> { enabled, public_key }
//   POST   /api/push/subscriptions { endpoint, keys: { p256dh, auth } } -> { ok }
//   DELETE /api/push/subscriptions?endpoint=                        -> { ok }
//
// The POST body is PushSubscription.toJSON(). Posting the same subscription again changes nothing,
// so browsers re-send it on every visit. A subscription belongs to the session that sent it and
// stops when that session ends. A new browser gets "Notifications are on." straight away, and
// nothing from before it subscribed.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { getCookie, sessionCookie } from '../lib/auth';
import { body, fail, requireUser, str } from '../lib/http';
import { newId, sha256 } from '../lib/ids';
import { track } from '../lib/palantir';
import { pushEndpointAllowed, recentIds, sendPush, validSubscriptionKeys, vapidKeys } from '../lib/push';

const push = new Hono<AppEnv>();

/** Browsers per person; turning notifications on in an eleventh drops the oldest. */
const MAX_PER_USER = 10;

push.get('/', c => {
  const keys = vapidKeys(c.env);
  return c.json({ enabled: Boolean(keys), public_key: keys?.publicKey ?? null });
});

push.post('/subscriptions', async c => {
  const user = requireUser(c);
  const token = getCookie(c.req.raw, sessionCookie);
  if (user.bearer || !token) fail(422, 'Notifications can only be turned on in a browser.');
  const keys = vapidKeys(c.env);
  if (!keys) fail(503, "Notifications aren't available.");
  const input = await body<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>(c);
  const endpoint = typeof input.endpoint === 'string' && input.endpoint.length <= 1000 ? input.endpoint : '';
  if (!pushEndpointAllowed(endpoint, new URL(c.req.url).hostname)) fail(422, "This browser's notifications aren't supported.");
  const p256dh = str(input.keys?.p256dh, 200);
  const auth = str(input.keys?.auth, 100);
  if (!validSubscriptionKeys(p256dh, auth)) fail(422, 'Invalid subscription.');

  const now = Date.now();
  const id = newId(now);
  const sessionHash = await sha256(token);
  // Nothing is written when the same browser sends the same subscription again.
  const row = await c.env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, session_hash, endpoint, p256dh, auth, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, session_hash = excluded.session_hash,
        p256dh = excluded.p256dh, auth = excluded.auth
      WHERE user_id != excluded.user_id OR session_hash != excluded.session_hash OR p256dh != excluded.p256dh OR auth != excluded.auth
      RETURNING id`)
    .bind(id, user.id, sessionHash, endpoint, p256dh, auth, now).first<{ id: string }>();
  const created = row?.id === id;
  if (created) {
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?1 AND id NOT IN
          (SELECT id FROM push_subscriptions WHERE user_id = ?1 ORDER BY id DESC LIMIT ${MAX_PER_USER})`).bind(user.id),
      // Turning notifications on pushes what happens from now on, not the last few minutes.
      c.env.DB.prepare('UPDATE notifications SET pushed_at = ? WHERE user_id = ? AND id > ? AND pushed_at IS NULL').bind(now, user.id, recentIds(now)),
    ]);
    c.executionCtx.waitUntil(sendPush({ endpoint, p256dh, auth }, { title: 'Southbag Social', body: 'Notifications are on.', url: '/notifications' }, keys)
      .catch(err => console.error('push confirmation', err)));
  }
  if (row) track(c, 'social_push_subscribed', { new: created });
  return c.json({ ok: true });
});

push.delete('/subscriptions', async c => {
  const user = requireUser(c);
  const endpoint = c.req.query('endpoint') || '';
  const { meta } = await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(endpoint, user.id).run();
  if (meta.changes) track(c, 'social_push_unsubscribed');
  return c.json({ ok: true });
});

export default push;
