// Southbag Social — one Cloudflare Worker on the free plan.
// Static files in public/ are served by Workers Assets (free, no Worker invocation). Only
// /auth/*, /api/* and /media/* reach this code (see run_worker_first in wrangler.jsonc).

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Env } from './env';
import { callback, login, logout, safeReturnTo, session } from './lib/auth';
import { deleteMedia, serveMedia } from './lib/media';
import feed from './routes/feed';
import groups from './routes/groups';
import me from './routes/me';
import media from './routes/media';
import messages from './routes/messages';
import notifications from './routes/notifications';
import posts from './routes/posts';
import search from './routes/search';
import stories from './routes/stories';
import users from './routes/users';
import videos from './routes/videos';
import polls from './routes/polls';
import pins from './routes/pins';
import communities from './routes/communities';
import events, { sendEventReminders } from './routes/events';
import audio from './routes/audio';
import servers from './routes/servers';
import careers from './routes/careers';
import marketplace from './routes/marketplace';
import boards from './routes/boards';
import streaks, { streaksCron } from './routes/streaks';
import wiki from './routes/wiki';
import dating from './routes/dating';

const app = new Hono<AppEnv>();

// Origins allowed to call /api/* cross-origin with an Identity bearer token (Southbag Mobile).
const apiOrigins = new Set(['https://southbaghq.github.io', 'http://localhost:8000']);

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: 'Something went wrong.' }, 500);
});
app.notFound(c => c.json({ error: 'Not found.' }, 404));

// ── Auth ──
app.get('/auth/login', c => login(c.req.raw, c.env, safeReturnTo(c.req.query('next'))));
app.get('/auth/callback', c => callback(c.req.raw, c.env, c.executionCtx));
app.get('/auth/logout', c => logout(c.req.raw, c.env, c.executionCtx));
app.post('/auth/logout', c => logout(c.req.raw, c.env, c.executionCtx));

// ── Files (public, immutable) ──
app.on(['GET', 'HEAD'], '/media/:id', c => serveMedia(c.req.raw, c.env, c.executionCtx, c.req.param('id')));

// ── API ──
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  const cors = origin && apiOrigins.has(origin);
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: cors ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': c.req.header('access-control-request-headers') || 'authorization, content-type',
        'access-control-max-age': '86400',
        vary: 'origin',
      } : {},
    });
  }
  const user = await session(c.req.raw, c.env, c.executionCtx);
  c.set('user', user);
  // Cookie sessions need a same-origin check against CSRF; a bearer token is proof by itself.
  if (!['GET', 'HEAD'].includes(c.req.method) && user && !user.bearer && origin !== new URL(c.req.url).origin)
    return c.json({ error: 'Invalid origin' }, 403);
  await next();
  c.header('cache-control', 'no-store');
  if (cors) {
    c.header('access-control-allow-origin', origin);
    c.header('vary', 'origin');
  }
});

app.route('/api/me', me);
app.route('/api/media', media);
app.route('/api/posts', posts);
app.route('/api/feed', feed);
app.route('/api/users', users);
app.route('/api/notifications', notifications);
app.route('/api/videos', videos);
app.route('/api/stories', stories);
app.route('/api/groups', groups);
app.route('/api/messages', messages);
app.route('/api/search', search);
app.route('/api/polls', polls);
app.route('/api/pins', pins);
app.route('/api/communities', communities);
app.route('/api/events', events);
app.route('/api/audio', audio);
app.route('/api/servers', servers);
app.route('/api/careers', careers);
app.route('/api/marketplace', marketplace);
app.route('/api/boards', boards);
app.route('/api/streaks', streaks);
app.route('/api/wiki', wiki);
app.route('/api/dating', dating);

/** Hourly: expire stories, drop abandoned uploads and dead sessions. */
async function janitor(env: Env): Promise<void> {
  const now = Date.now();
  const { results: expired } = await env.DB.prepare('SELECT id, media_id FROM stories WHERE expires_at < ? LIMIT 100')
    .bind(now).all<{ id: string; media_id: string }>();
  if (expired.length) {
    await env.DB.prepare(`DELETE FROM stories WHERE id IN (${expired.map(() => '?').join(', ')})`).bind(...expired.map(s => s.id)).run();
    await deleteMedia(env, expired.map(s => s.media_id));
  }
  const { results: abandoned } = await env.DB.prepare(`SELECT id FROM media WHERE status = 'uploading' AND created_at < ? LIMIT 100`)
    .bind(now - 6 * 3600000).all<{ id: string }>();
  await deleteMedia(env, abandoned.map(m => m.id));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now),
    // Servers: typing indicators and presence older than a day are only noise.
    env.DB.prepare('DELETE FROM channel_typing WHERE until < ?').bind(now - 60000),
    env.DB.prepare('DELETE FROM server_presence WHERE last_seen_at < ?').bind(now - 86400000),
  ]);
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(janitor(env));
    // Events: remind people going to events that start in the next 24 hours (once each).
    ctx.waitUntil(sendEventReminders(env).catch(err => console.error('event reminders', err)));
    // Streaks: warn people whose message streaks are about to run out.
    ctx.waitUntil(streaksCron(env).catch(err => console.error('streaks', err)));
  },
} satisfies ExportedHandler<Env>;
