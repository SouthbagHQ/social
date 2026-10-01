// Palantir (server-side analytics). The module is imported straight from TypeScript (Node strips
// the types); nothing here touches the network except the local API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE } from './helpers.mjs';
import { capture, capturePayload, palantirContext, palantirHost, tracker } from '../src/lib/palantir.ts';

const KEY = 'phc_rStyYsw4wrB8MwXEsPBJjz57uipHycNVwFPaw2m3aYXo';
const phCookie = value => `ph_${KEY}_posthog=${encodeURIComponent(JSON.stringify(value))}`;
const browserCookie = phCookie({ distinct_id: 'anon-123', $sesid: [1700000000000, 'session-abc', 1700000000000], $window_id: 'window-def' });

/** Runs `fn` with fetch replaced by a recorder, and NODE_TEST_CONTEXT optionally lifted. */
async function withFetch(fn, { liftTestGuard = false } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  const guard = process.env.NODE_TEST_CONTEXT;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{}'); };
  if (liftTestGuard) delete process.env.NODE_TEST_CONTEXT;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (guard !== undefined) process.env.NODE_TEST_CONTEXT = guard;
  }
  return calls;
}

test('palantirContext: reads the PostHog cookie, the client IP and the page without its query', () => {
  const request = new Request('https://social.southbag.cc/api/posts', {
    headers: {
      cookie: `southbag_social_session=x; ${browserCookie}; other=1`,
      'cf-connecting-ip': '203.0.113.7',
      'user-agent': 'Test/1.0',
      referer: 'https://social.southbag.cc/search?q=something+private',
    },
  });
  assert.deepEqual(palantirContext(request), {
    ip: '203.0.113.7',
    userAgent: 'Test/1.0',
    url: 'https://social.southbag.cc/search',
    distinctId: 'anon-123',
    sessionId: 'session-abc',
    windowId: 'window-def',
  });
});

test('palantirContext: no cookie, or a mangled one, still gives a usable context', () => {
  const bare = palantirContext(new Request('https://social.southbag.cc/api/me?x=1'));
  assert.equal(bare.url, 'https://social.southbag.cc/api/me');
  assert.equal(bare.distinctId, undefined);
  const mangled = palantirContext(new Request('https://social.southbag.cc/api/me', { headers: { cookie: `ph_${KEY}_posthog=%7Bnot-json` } }));
  assert.equal(mangled.sessionId, undefined);
});

test('palantirHost: production sends; tests and local dev do not unless PALANTIR_DEV=1', async () => {
  const prod = new Request('https://social.southbag.cc/api/me');
  const local = new Request('http://localhost:8787/api/me');
  const loopback = new Request('http://127.0.0.1:8787/api/me');
  assert.equal(palantirHost(prod, {}), null, 'never under node --test');
  await withFetch(async () => {
    assert.equal(palantirHost(prod, {}), 'https://palantir.southbag.cc');
    assert.equal(palantirHost(prod, { PALANTIR_HOST_OVERRIDE: 'http://127.0.0.1:9' }), 'https://palantir.southbag.cc', 'override ignored in production');
    assert.equal(palantirHost(local, {}), null);
    assert.equal(palantirHost(loopback, {}), null);
    assert.equal(palantirHost(local, { PALANTIR_DEV: '1' }), 'https://palantir.southbag.cc');
    assert.equal(palantirHost(loopback, { PALANTIR_DEV: '1', PALANTIR_HOST_OVERRIDE: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
    assert.equal(palantirHost(prod, { NODE_TEST_CONTEXT: 'child' }), null);
  }, { liftTestGuard: true });
});

test('capturePayload: the shape PostHog /capture/ expects, same as banking', () => {
  const at = new Date('2026-10-01T00:00:00Z');
  const payload = capturePayload('social_post_created', 'user-1', { kind: 'text' },
    { context: { sessionId: 's', windowId: 'w', ip: '1.2.3.4', userAgent: 'UA', url: 'https://x/feed' }, timestamp: at });
  assert.deepEqual(payload, {
    api_key: KEY,
    event: 'social_post_created',
    distinct_id: 'user-1',
    timestamp: '2026-10-01T00:00:00.000Z',
    properties: {
      $lib: 'palantir-server', $process_person_profile: true, southbag_app: 'social', source: 'server',
      $session_id: 's', $window_id: 'w', $ip: '1.2.3.4', $raw_user_agent: 'UA', $current_url: 'https://x/feed', kind: 'text',
    },
  });
});

test('tracker: signed-in id wins over the cookie id; nothing is sent from tests', async () => {
  const request = new Request('https://social.southbag.cc/api/posts', { headers: { cookie: browserCookie } });
  const waited = [];
  const ctx = { waitUntil: p => waited.push(p) };

  const quiet = await withFetch(() => tracker(request, {}, ctx, { id: 'user-1' }).capture('social_post_created'));
  assert.equal(quiet.length, 0, 'NODE_TEST_CONTEXT blocks sends');

  const sent = await withFetch(async () => {
    const t = tracker(request, {}, ctx, { id: 'user-1' });
    assert.equal(t.distinctId, 'user-1');
    await t.capture('social_post_created', { kind: 'photo' });
    assert.equal(tracker(request, {}, ctx).distinctId, 'anon-123');
    await capture('social_nobody', undefined, {}, {}); // no id at all: dropped
  }, { liftTestGuard: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://palantir.southbag.cc/capture/');
  assert.equal(sent[0].body.distinct_id, 'user-1');
  assert.equal(sent[0].body.properties.$session_id, 'session-abc');
  assert.equal(sent[0].body.properties.kind, 'photo');
  assert.equal(waited.length, 1, 'handed to waitUntil');
});

test('API: tracked routes still answer normally with a PostHog cookie present', async () => {
  const headers = { cookie: `southbag_social_session=dev-alice; ${browserCookie}`, origin: BASE, 'content-type': 'application/json' };
  const started = Date.now();
  const created = await fetch(`${BASE}/api/posts`, { method: 'POST', headers, body: JSON.stringify({ body: 'Analytics check' }) });
  assert.equal(created.status, 201);
  const { post } = await created.json();
  const search = await fetch(`${BASE}/api/search?q=analytics&type=posts`, { headers });
  assert.equal(search.status, 200);
  const edited = await fetch(`${BASE}/api/posts/${post.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body: 'Analytics check, edited' }) });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).post.body, 'Analytics check, edited');
  assert.ok(Date.now() - started < 5000, 'analytics never hold up a response');
});
