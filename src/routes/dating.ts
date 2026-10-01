// Dating. Mounted at /api/dating. Signed-in users only.
//
// Nobody's profile is shown to anyone else and nobody is matched with anyone. Every card is the
// same one (CARD below), so no user's data can reach another user through this router. Pressing
// "Pass" removes access to Dating permanently; there is no way to undo it.
//
//   GET  /             -> { banned, started, card: Card | null, interested_count }
//                         (card is null when banned or not started yet)
//   POST /start        -> same shape as GET, started: true   (creates your dating profile)
//   POST /interested   -> same shape as GET + { match: false }   (the same card again)
//   POST /pass         -> { banned: true }   (permanent)
//
// Every POST returns 403 "You no longer have access to Dating." once you are banned.
//
// Card: { name: 'Garlic bread', image_url } and nothing else.

import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { fail, requireUser } from '../lib/http';
import { track } from '../lib/palantir';

const dating = new Hono<AppEnv>();

const BANNED = 'You no longer have access to Dating.';

const CARD = {
  name: 'Garlic bread',
  image_url: '/img/garlic-bread.jpg',
} as const;

/** A fresh copy every time, so nothing downstream can change the original. */
const card = () => ({ ...CARD });

interface State { banned: boolean; started: boolean; interested_count: number }

async function state(env: Env, userId: string): Promise<State> {
  const row = await env.DB.prepare(
    `SELECT (SELECT 1 FROM dating_bans WHERE user_id = ?1) AS banned,
            (SELECT interested_count FROM dating_profiles WHERE user_id = ?1) AS interested_count`,
  ).bind(userId).first<{ banned: number | null; interested_count: number | null }>();
  return {
    banned: Boolean(row?.banned),
    started: row?.interested_count != null,
    interested_count: row?.interested_count ?? 0,
  };
}

const respond = (s: State) => ({
  banned: s.banned,
  started: s.started,
  card: s.banned || !s.started ? null : card(),
  interested_count: s.interested_count,
});

/** The current state, or a 403 if this user has been removed from Dating. */
async function allowed(env: Env, userId: string): Promise<State> {
  const s = await state(env, userId);
  if (s.banned) fail(403, BANNED);
  return s;
}

dating.get('/', async c => {
  const user = requireUser(c);
  const s = await state(c.env, user.id);
  if (s.started && !s.banned) {
    await c.env.DB.prepare('UPDATE dating_profiles SET last_seen_at = ? WHERE user_id = ?').bind(Date.now(), user.id).run();
  }
  return c.json(respond(s));
});

dating.post('/start', async c => {
  const user = requireUser(c);
  const s = await allowed(c.env, user.id);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO dating_profiles (user_id, created_at, interested_count, last_seen_at) VALUES (?1, ?2, 0, ?2)
     ON CONFLICT (user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).bind(user.id, now).run();
  return c.json(respond({ ...s, started: true }));
});

dating.post('/interested', async c => {
  const user = requireUser(c);
  await allowed(c.env, user.id);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `INSERT INTO dating_profiles (user_id, created_at, interested_count, last_seen_at) VALUES (?1, ?2, 1, ?2)
     ON CONFLICT (user_id) DO UPDATE SET interested_count = interested_count + 1, last_seen_at = excluded.last_seen_at
     RETURNING interested_count`,
  ).bind(user.id, now).first<{ interested_count: number }>();
  const interested_count = row?.interested_count ?? 1;
  track(c, 'social_dating_interested', { interested_count });
  return c.json({ ...respond({ banned: false, started: true, interested_count }), match: false });
});

dating.post('/pass', async c => {
  const user = requireUser(c);
  const s = await allowed(c.env, user.id);
  // INSERT OR IGNORE: a second request racing this one keeps the first ban time.
  await c.env.DB.prepare('INSERT OR IGNORE INTO dating_bans (user_id, banned_at) VALUES (?, ?)').bind(user.id, Date.now()).run();
  track(c, 'social_dating_passed', { interested_count: s.interested_count });
  track(c, 'social_dating_banned', { interested_count: s.interested_count });
  return c.json({ banned: true });
});

export default dating;
