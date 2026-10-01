// Push notifications with no push provider account. Browsers each come with a push service (Google's
// for Chrome, Mozilla's, Apple's, Microsoft's); we POST to the address the browser gave us, encrypted
// for that browser (RFC 8291, aes128gcm from RFC 8188) and signed with our own VAPID key (RFC 8292).
// Everything is WebCrypto, so there is nothing to install.
//
// Keys: `node scripts/vapid-keys.mjs` makes a pair. Store both as secrets (VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY). Without them push is off: the settings card says so and nothing is sent.
//
// Sending: no route sends pushes. pushPending() claims recent notifications nobody has pushed yet
// (UPDATE … RETURNING, so two requests never push the same one) and sends one message per browser.
// src/index.ts runs it after every write request and after the hourly cron.

// Only type imports, so tests/push.test.mjs can import this file straight into Node.
import type { Env } from '../env';

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url (65 bytes). Browsers subscribe with this. */
  publicKey: string;
  /** The private scalar `d`, base64url (32 bytes). */
  privateKey: string;
}

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the service worker (public/sw.js) shows. */
export interface PushMessage {
  title: string;
  body: string;
  url: string;
}

/** Only notifications this recent are pushed; older ones wait in the app. */
export const WINDOW_MS = 10 * 60 * 1000;
/** Per run. The free plan allows 50 subrequests per invocation, and analytics needs some too. */
const MAX_CLAIM = 20;
const MAX_SENDS = 30;
/** How long a push service keeps a message for a browser that's offline. */
const TTL_SECONDS = 24 * 3600;
const SUBJECT = 'https://social.southbag.cc';

const enc = new TextEncoder();
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export function base64url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const decodes = (value: string, length: number) => {
  try { return /^[\w-]+$/.test(value) && fromBase64url(value).length === length; } catch { return false; }
};

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const utf8 = (text: string) => concat(enc.encode(text));

export function vapidKeys(env: Env): VapidKeys | null {
  const publicKey = typeof env.VAPID_PUBLIC_KEY === 'string' ? env.VAPID_PUBLIC_KEY.trim() : '';
  const privateKey = typeof env.VAPID_PRIVATE_KEY === 'string' ? env.VAPID_PRIVATE_KEY.trim() : '';
  return decodes(publicKey, 65) && decodes(privateKey, 32) ? { publicKey, privateKey } : null;
}

/** A browser's keys from PushSubscription.toJSON(): a P-256 point and a 16-byte secret. */
export const validSubscriptionKeys = (p256dh: string, auth: string): boolean =>
  decodes(p256dh, 65) && fromBase64url(p256dh)[0] === 4 && decodes(auth, 16);

const isLocal = (hostname: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[\w-]+\.notify\.windows\.com)$/;

/**
 * Only the browsers' push services, so the Worker can't be told to POST anywhere else. Local
 * requests (wrangler dev, the tests) may also use a push service on localhost.
 */
export function pushEndpointAllowed(endpoint: string, requestHostname: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (isLocal(requestHostname) && isLocal(url.hostname) && ['http:', 'https:'].includes(url.protocol)) return true;
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && PUSH_HOSTS.test(url.hostname);
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8) as ArrayBuffer);
}

/**
 * Encrypts a push message for one browser (RFC 8291) as a single aes128gcm record (RFC 8188).
 * `fixed` is only for the RFC's test vector; real messages get a fresh key pair and salt.
 */
export async function encryptPayload(
  payload: Uint8Array, p256dh: string, auth: string,
  fixed?: { keyPair: CryptoKeyPair; salt: Uint8Array<ArrayBuffer> },
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromBase64url(p256dh);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const local = fixed?.keyPair ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey) as ArrayBuffer);
  // (workers-types spells the `public` member `$public`; the runtime wants `public`.)
  const ecdh = { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256) as ArrayBuffer);

  const ikm = await hkdf(fromBase64url(auth), shared, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record, so the padding delimiter is 2 ("last record") and there is no further padding.
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2])));

  // Header: salt (16) | record size (uint32) | key id length (1) | key id (our public key).
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, new Uint8Array(sealed));
}

/** `Authorization` header for a push service (RFC 8292): an ES256 JWT for its origin, and our key. */
export async function vapidAuthorization(audience: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const json = (value: unknown) => base64url(enc.encode(JSON.stringify(value)));
  const unsigned = `${json({ typ: 'JWT', alg: 'ES256' })}.${json({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: SUBJECT })}`;
  const point = fromBase64url(keys.publicKey);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', x: base64url(point.slice(1, 33)), y: base64url(point.slice(33, 65)), d: keys.privateKey,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto's ECDSA signature is already r || s, which is what a JWT wants.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(unsigned));
  return `vapid t=${unsigned}.${base64url(signature)}, k=${keys.publicKey}`;
}

/**
 * Sends one message to one browser and returns the push service's status (201 when accepted;
 * 404 or 410 when the subscription is gone). `signed` reuses one JWT per push service per run.
 */
export async function sendPush(
  sub: Pick<PushSubscriptionRow, 'endpoint' | 'p256dh' | 'auth'>, message: PushMessage, keys: VapidKeys,
  signed = new Map<string, Promise<string>>(),
): Promise<number> {
  const audience = new URL(sub.endpoint).origin;
  let authorization = signed.get(audience);
  if (!authorization) signed.set(audience, authorization = vapidAuthorization(audience, keys));
  const body = await encryptPayload(utf8(JSON.stringify(message)), sub.p256dh, sub.auth);
  const response = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await authorization,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(TTL_SECONDS),
      urgency: 'normal',
    },
    body,
  });
  await response.body?.cancel();
  return response.status;
}

// -- What a notification says (same words as public/js/views/notifications.js) --

interface ClaimedRow {
  id: string;
  user_id: string;
  actor_id: string | null;
  type: string;
  post_id: string | null;
  group_id: string | null;
  body: string | null;
  link: string | null;
}

interface Lookups {
  actors: Map<string, { handle: string; name: string }>;
  groups: Map<string, { slug: string; name: string }>;
  posts: Map<string, { kind: string }>;
}

export function describe(n: ClaimedRow, { actors, groups }: Lookups): string {
  const actor = n.actor_id ? actors.get(n.actor_id) : null;
  const a = actor ? actor.name || `@${actor.handle}` : 'Someone';
  const group = (n.group_id && groups.get(n.group_id)?.name) || 'a group';
  switch (n.type) {
    case 'follow': return `${a} followed you.`;
    case 'friend_request': return `${a} sent you a friend request.`;
    case 'friend_accept': return `${a} accepted your friend request.`;
    case 'reaction': return !n.body || n.body === 'like' ? `${a} liked your post.` : `${a} reacted to your post.`;
    case 'reply': return `${a} replied to your post.`;
    case 'repost': return `${a} reposted your post.`;
    case 'quote': return `${a} quoted your post.`;
    case 'mention': return `${a} mentioned you.`;
    case 'wall_post': return `${a} wrote on your wall.`;
    case 'group_join': return `${a} joined ${group}.`;
    case 'group_post': return `${a} posted in ${group}.`;
    case 'story_view': return `${a} viewed your story.`;
    case 'system': return n.body || 'Southbag Social';
    default: return n.body || `${a} interacted with you.`;
  }
}

export function target(n: ClaimedRow, { actors, groups, posts }: Lookups): string {
  if (n.link && n.link.startsWith('/') && !n.link.startsWith('//')) return n.link;
  if (n.type === 'friend_request') return '/friends';
  const post = n.post_id ? posts.get(n.post_id) : null;
  if (post) return post.kind === 'video' ? `/watch/${n.post_id}` : post.kind === 'short' ? `/shorts/${n.post_id}` : `/post/${n.post_id}`;
  const group = n.group_id ? groups.get(n.group_id) : null;
  if (group) return `/g/${group.slug}`;
  const actor = n.actor_id ? actors.get(n.actor_id) : null;
  if (actor) return `/@${actor.handle}`;
  return '/notifications';
}

const BODY_MAX = 200;
const clip = (text: string) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > BODY_MAX ? chars.slice(0, BODY_MAX - 3).join('') + '...' : chars.join('');
};

/** One message per person: the notification itself, or a count when several arrived at once. */
export function messageFor(mine: ClaimedRow[], lookups: Lookups): PushMessage {
  if (mine.length === 1) return { title: 'Southbag Social', body: clip(describe(mine[0], lookups)), url: target(mine[0], lookups) };
  return { title: 'Southbag Social', body: `${mine.length} new notifications.`, url: '/notifications' };
}

// -- Sending what's pending --

/** Ids start with the time in base36, so `id > recentIds()` is "created in the last WINDOW_MS" on the primary key. */
export const recentIds = (now = Date.now()) => (now - WINDOW_MS).toString(36).padStart(9, '0');

/** `IN (…)` values that match nothing when the list is empty. */
const inList = (ids: string[]) => (ids.length ? ids : ['']);

/**
 * Pushes notifications from the last few minutes that haven't been pushed, read, or sent by
 * someone the recipient blocked, to every browser of theirs with a live session. Never throws
 * for a single failed browser; subscriptions the push service says are gone are dropped.
 */
export async function pushPending(env: Env, now = Date.now()): Promise<void> {
  const keys = vapidKeys(env);
  if (!keys) return;
  const since = recentIds(now);
  const { results: claimed } = await env.DB.prepare(`UPDATE notifications SET pushed_at = ?
      WHERE id IN (SELECT n.id FROM notifications n
        WHERE n.id > ? AND n.pushed_at IS NULL AND n.read_at IS NULL
          AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = n.user_id)
          AND (n.actor_id IS NULL OR NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = n.user_id AND b.blocked_id = n.actor_id))
        ORDER BY n.id LIMIT ?)
      RETURNING id, user_id, actor_id, type, post_id, group_id, body, link`)
    .bind(now, since, MAX_CLAIM).all<ClaimedRow>();
  if (!claimed.length) return;

  const unique = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => Boolean(v)))];
  const userIds = unique(claimed.map(n => n.user_id));
  const actorIds = inList(unique(claimed.map(n => n.actor_id)));
  const groupIds = inList(unique(claimed.map(n => n.group_id)));
  const postIds = inList(unique(claimed.map(n => n.post_id)));
  const [subs, actors, groups, posts] = await env.DB.batch([
    env.DB.prepare(`SELECT ps.id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps
        JOIN sessions s ON s.token_hash = ps.session_hash
        WHERE ps.user_id IN (${placeholders(userIds.length)}) AND s.expires_at > ? ORDER BY ps.id DESC`).bind(...userIds, now),
    env.DB.prepare(`SELECT id, handle, name FROM users WHERE id IN (${placeholders(actorIds.length)})`).bind(...actorIds),
    env.DB.prepare(`SELECT id, slug, name FROM groups WHERE id IN (${placeholders(groupIds.length)})`).bind(...groupIds),
    env.DB.prepare(`SELECT id, kind FROM posts WHERE id IN (${placeholders(postIds.length)})`).bind(...postIds),
  ]);
  const byId = <T extends { id: string }>(rows: unknown[]) => new Map((rows as T[]).map(r => [r.id, r]));
  const lookups: Lookups = {
    actors: byId<{ id: string; handle: string; name: string }>(actors.results),
    groups: byId<{ id: string; slug: string; name: string }>(groups.results),
    posts: byId<{ id: string; kind: string }>(posts.results),
  };

  const messages = new Map<string, PushMessage>();
  for (const userId of userIds) {
    const mine = claimed.filter(n => n.user_id === userId).sort((x, y) => (x.id < y.id ? -1 : 1));
    messages.set(userId, messageFor(mine, lookups));
  }

  const signed = new Map<string, Promise<string>>();
  const gone: string[] = [];
  await Promise.all((subs.results as unknown as PushSubscriptionRow[]).slice(0, MAX_SENDS).map(async sub => {
    try {
      const status = await sendPush(sub, messages.get(sub.user_id)!, keys, signed);
      if (status === 404 || status === 410) gone.push(sub.id);
      else if (status >= 400) console.error('push refused', new URL(sub.endpoint).hostname, status);
    } catch (err) {
      console.error('push failed', new URL(sub.endpoint).hostname, err);
    }
  }));
  if (gone.length) await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id IN (${placeholders(gone.length)})`).bind(...gone).run();
}
