// Southbag Identity login. Same flow as banking.southbag.cc:
// the first login from an origin registers a public PKCE client with Identity (dynamic client
// registration) and remembers it in D1; sessions are opaque random tokens stored hashed.
// Southbag Mobile-style clients can instead send an Identity access token as `Bearer …`.

import type { Env, SessionUser } from '../env';
import { newId, randomToken, sha256 } from './ids';

export const issuer = 'https://identity.southbag.cc';
const oauth = {
  authorize: issuer + '/api/auth/oauth2/authorize',
  token: issuer + '/api/auth/oauth2/token',
  register: issuer + '/api/auth/oauth2/register',
  userinfo: issuer + '/api/auth/oauth2/userinfo',
};

export const sessionCookie = 'southbag_social_session';
const stateCookie = 'southbag_social_oauth_state';
const sessionDays = 30;
const bearerSessionMs = 10 * 60 * 1000;

interface IdentityUser {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  preferred_username?: string;
  given_name?: string;
}

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const getCookie = (request: Request, name: string): string | undefined =>
  request.headers.get('cookie')
    ?.split(';').map(v => v.trim().split('=')).find(([key]) => key === name)?.[1];

function redirect(url: string, ...cookies: string[]): Response {
  const headers = new Headers({ location: url });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 302, headers });
}

/** Only same-origin paths may be a post-login destination. */
export const safeReturnTo = (value: unknown): string | null =>
  typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : null;

async function getClient(env: Env, origin: string) {
  const existing = await env.DB.prepare('SELECT * FROM oauth_clients WHERE origin = ?').bind(origin)
    .first<{ client_id: string; client_secret: string; redirect_uri: string }>();
  if (existing) return existing;

  const redirectUri = origin + '/auth/callback';
  const response = await fetch(oauth.register, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Southbag Social',
      client_uri: origin,
      redirect_uris: [redirectUri],
      post_logout_redirect_uris: [origin + '/'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid profile email',
    }),
  });
  const registered = await response.json<{ client_id?: string; client_secret?: string; error?: string; error_description?: string }>()
    .catch(() => ({} as { client_id?: string; client_secret?: string; error?: string; error_description?: string }));
  if (!response.ok || !registered.client_id)
    throw new Error(registered.error_description || registered.error || 'Southbag Identity would not register us as a client.');

  await env.DB.prepare(`INSERT OR IGNORE INTO oauth_clients (origin, client_id, client_secret, redirect_uri, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(origin, registered.client_id, registered.client_secret || '', redirectUri, Date.now()).run();
  return (await env.DB.prepare('SELECT * FROM oauth_clients WHERE origin = ?').bind(origin)
    .first<{ client_id: string; client_secret: string; redirect_uri: string }>())!;
}

export async function login(request: Request, env: Env, returnTo: string | null): Promise<Response> {
  const origin = new URL(request.url).origin;
  const client = await getClient(env, origin);
  const state = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now),
    env.DB.prepare(`INSERT INTO oauth_states (state, origin, verifier, nonce, return_to, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(state, origin, verifier, nonce, returnTo, now + 10 * 60 * 1000),
  ]);
  const target = new URL(oauth.authorize);
  target.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uri,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256',
  }).toString();
  return redirect(target.toString(), cookie(stateCookie, state, 600));
}

/** Sends people back to the landing page with a reason the UI can show. */
const failed = (origin: string, reason: string) =>
  redirect(`${origin}/?login_error=${encodeURIComponent(reason)}`, cookie(stateCookie, '', 0));

export async function callback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (!state || state !== getCookie(request, stateCookie)) return failed(url.origin, 'invalid_state');

  const pending = await env.DB.prepare('SELECT * FROM oauth_states WHERE state = ?').bind(state)
    .first<{ origin: string; verifier: string; return_to: string | null; expires_at: number }>();
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
  if (!pending || pending.expires_at < Date.now()) return failed(url.origin, 'expired');
  if (url.searchParams.get('error')) return failed(url.origin, url.searchParams.get('error')!);
  const iss = url.searchParams.get('iss');
  if (iss && iss !== issuer) return failed(url.origin, 'wrong_issuer');

  const client = await getClient(env, pending.origin);
  const code = url.searchParams.get('code');
  if (!code) return failed(url.origin, 'missing_code');

  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', origin: issuer };
  if (client.client_secret) headers.authorization = 'Basic ' + btoa(client.client_id + ':' + client.client_secret);
  const tokenResponse = await fetch(oauth.token, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: client.redirect_uri,
      code_verifier: pending.verifier,
    }),
  });
  const tokens = await tokenResponse.json<{ access_token?: string }>().catch(() => ({} as { access_token?: string }));
  if (!tokenResponse.ok || !tokens.access_token) return failed(url.origin, 'token_exchange');

  const profile = await fetchIdentityUser(tokens.access_token);
  if (!profile) return failed(url.origin, 'userinfo');

  const now = Date.now();
  const { created } = await upsertUser(env, profile, now);
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), profile.sub, now + sessionDays * 86400000, now).run();
  const destination = created ? '/welcome' : safeReturnTo(pending.return_to) || '/';
  return redirect(pending.origin + destination,
    cookie(sessionCookie, token, sessionDays * 86400), cookie(stateCookie, '', 0));
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const token = getCookie(request, sessionCookie);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return redirect(new URL(request.url).origin + '/?signed_out=1', cookie(sessionCookie, '', 0));
}

async function fetchIdentityUser(accessToken: string): Promise<IdentityUser | null> {
  const response = await fetch(oauth.userinfo, { headers: { authorization: `Bearer ${accessToken}` } });
  const user = await response.json<IdentityUser>().catch(() => null);
  return response.ok && user?.sub ? user : null;
}

/** Turns whatever Identity tells us into a free @handle: letters, digits and underscores, 3–20 chars. */
export function baseHandle(user: IdentityUser): string {
  const source = user.preferred_username || user.email?.split('@')[0] || user.name || 'bagholder';
  let handle = source.normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 16);
  if (handle.length < 3) handle = ('bag_' + handle).slice(0, 16);
  return handle;
}

async function upsertUser(env: Env, user: IdentityUser, now: number): Promise<{ created: boolean }> {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(user.sub).first();
  const name = (user.name || user.given_name || user.email?.split('@')[0] || 'Valued Customer').slice(0, 50);
  if (existing) {
    await env.DB.prepare('UPDATE users SET email = ?, identity_picture = ?, updated_at = ? WHERE id = ?')
      .bind(user.email || null, user.picture || null, now, user.sub).run();
    return { created: false };
  }
  const base = baseHandle(user);
  let handle = base;
  for (let attempt = 0; attempt < 20; attempt++) {
    const taken = await env.DB.prepare('SELECT 1 FROM users WHERE handle = ?').bind(handle).first();
    if (!taken) break;
    handle = base + Math.floor(Math.random() * 10 ** Math.min(2 + attempt, 6));
  }
  await env.DB.prepare(`INSERT INTO users (id, handle, name, email, identity_picture, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .bind(user.sub, handle, name, user.email || null, user.picture || null, now, now).run();
  // Every new account gets a welcome from Kevin.
  await env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, body, created_at)
    VALUES (?, ?, NULL, 'system', ?, ?)`)
    .bind(newId(now), user.sub,
      'Welcome to Southbag Social.', now).run();
  return { created: true };
}

const sessionSelect = `SELECT users.id, users.handle, users.name, users.email, users.avatar_media_id,
  users.identity_picture, users.verified, sessions.expires_at
  FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`;

async function loadSession(env: Env, tokenHash: string): Promise<SessionUser | null> {
  const row = await env.DB.prepare(sessionSelect).bind(tokenHash).first<SessionUser & { expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  const { expires_at: _, ...user } = row;
  return user;
}

/** Cookie session for the website; Identity bearer token for apps. */
export async function session(request: Request, env: Env): Promise<SessionUser | null> {
  const cookieToken = getCookie(request, sessionCookie);
  if (cookieToken) return loadSession(env, await sha256(cookieToken));

  const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer) return null;
  const tokenHash = await sha256(bearer);
  const cached = await loadSession(env, tokenHash);
  if (cached) return { ...cached, bearer: true };

  const profile = await fetchIdentityUser(bearer);
  if (!profile) return null;
  const now = Date.now();
  await upsertUser(env, profile, now);
  await env.DB.prepare('INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, profile.sub, now + bearerSessionMs, now).run();
  const loaded = await loadSession(env, tokenHash);
  return loaded ? { ...loaded, bearer: true } : null;
}
