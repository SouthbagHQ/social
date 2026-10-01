// Push notifications: the encryption and signing in src/lib/push.ts (imported straight into Node),
// and the API end to end against a fake push service on localhost. Messages are decrypted here with
// node:crypto, independently of the WebCrypto code that encrypted them.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { BASE, anon, as } from './helpers.mjs';
import { encryptPayload, messageFor, pushEndpointAllowed, vapidAuthorization } from '../src/lib/push.ts';

const alice = as('alice'), bob = as('bob'), carol = as('carol');
const b64 = value => Buffer.from(value, 'base64url');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A browser's side of a subscription: its ECDH key pair and auth secret. */
function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') } };
}

/** RFC 8291 decryption with node:crypto. */
function decrypt(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096, 'record size');
  const keyId = body.subarray(21, 21 + body[20]);
  const sealed = body.subarray(21 + body[20]);
  const hkdf = (ikm, salt, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), length));
  const ikm = hkdf(ecdh.computeSecret(keyId), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), keyId]), 32);
  const decipher = crypto.createDecipheriv('aes-128-gcm', hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16), hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12));
  decipher.setAuthTag(sealed.subarray(-16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  assert.equal(plain[end], 2, 'last-record delimiter');
  return plain.subarray(0, end);
}

/** Checks the VAPID header's JWT signature and returns its claims. */
function vapidClaims(header, publicKey) {
  const [, h, c, s, k] = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/) || [];
  assert.ok(h, `VAPID header: ${header}`);
  assert.equal(k, publicKey);
  const point = b64(k);
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, b64(s)), 'JWT signature');
  assert.deepEqual(JSON.parse(b64(h)), { typ: 'JWT', alg: 'ES256' });
  return JSON.parse(b64(c));
}

test('encryptPayload matches the RFC 8291 test vector', async () => {
  const asPublic = b64('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
  const keyPair = {
    privateKey: await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
      x: asPublic.subarray(1, 33).toString('base64url'), y: asPublic.subarray(33).toString('base64url'),
    }, ecdh, false, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', asPublic, ecdh, true, []),
  };
  const body = await encryptPayload(
    new Uint8Array(b64('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24')),
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
    { keyPair, salt: new Uint8Array(b64('DGv6ra1nlYgDCS1FRnbzlw')) });
  assert.equal(Buffer.from(body).toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('encryptPayload: a fresh key and salt every time, readable by the browser', async () => {
  const browser = browserKeys();
  const message = new TextEncoder().encode('{"body":"Hello"}');
  const first = await encryptPayload(message, browser.keys.p256dh, browser.keys.auth);
  const second = await encryptPayload(message, browser.keys.p256dh, browser.keys.auth);
  assert.notEqual(Buffer.from(first).toString('hex'), Buffer.from(second).toString('hex'));
  assert.equal(decrypt(Buffer.from(first), browser).toString(), '{"body":"Hello"}');
});

test('vapidAuthorization: an ES256 JWT for the push service, under 24 hours', async () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { publicKey: ecdh.getPublicKey('base64url'), privateKey: ecdh.getPrivateKey('base64url') };
  const now = Date.UTC(2026, 9, 1);
  const claims = vapidClaims(await vapidAuthorization('https://fcm.googleapis.com', keys, now), keys.publicKey);
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://social.southbag.cc');
  assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 86400);
});

test('pushEndpointAllowed: only browser push services, plus localhost for local requests', () => {
  const prod = 'social.southbag.cc';
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc', 'https://wns2-sg2p.notify.windows.com/w/?token=abc',
  ]) assert.ok(pushEndpointAllowed(ok, prod), ok);
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com:8443/x', 'https://evil.example/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x', 'http://127.0.0.1:9/push', 'not a url', '',
  ]) assert.ok(!pushEndpointAllowed(bad, prod), bad);
  assert.ok(pushEndpointAllowed('http://127.0.0.1:9/push', 'localhost'));
  assert.ok(!pushEndpointAllowed('http://10.0.0.1/push', 'localhost'));
});

test('messageFor: the same words and links as the notifications page', () => {
  const lookups = {
    actors: new Map([['u-bob', { handle: 'bob', name: 'Bob Southbag' }]]),
    groups: new Map([['g1', { slug: 'knitting', name: 'Knitting' }]]),
    posts: new Map([['p1', { kind: 'text' }], ['v1', { kind: 'video' }]]),
  };
  const n = fields => ({ id: '1', user_id: 'u', actor_id: 'u-bob', type: 'follow', post_id: null, group_id: null, body: null, link: null, ...fields });
  assert.deepEqual(messageFor([n({})], lookups), { title: 'Southbag Social', body: 'Bob Southbag followed you.', url: '/@bob' });
  assert.deepEqual(messageFor([n({ type: 'reaction', post_id: 'v1', body: 'love' })], lookups).url, '/watch/v1');
  assert.equal(messageFor([n({ type: 'reaction', post_id: 'p1', body: 'like' })], lookups).body, 'Bob Southbag liked your post.');
  assert.equal(messageFor([n({ type: 'group_post', group_id: 'g1' })], lookups).url, '/g/knitting');
  assert.deepEqual(messageFor([n({ type: 'system', actor_id: null, body: 'Your order shipped.', link: '/marketplace/1' })], lookups),
    { title: 'Southbag Social', body: 'Your order shipped.', url: '/marketplace/1' });
  assert.equal(messageFor([n({ link: '//evil.example' })], lookups).url, '/@bob', 'only same-origin links');
  assert.deepEqual(messageFor([n({}), n({ id: '2' })], lookups), { title: 'Southbag Social', body: '2 new notifications.', url: '/notifications' });
});

// -- API, against a fake push service --

let service, endpointBase, publicKey;
const received = [];
let reply = 201;

before(async () => {
  service = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(reply, { connection: 'close' }).end();
    });
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  endpointBase = `http://127.0.0.1:${service.address().port}`;
  publicKey = (await anon.get('push')).body.public_key;
});
after(() => service.close());

/**
 * Runs `action` and returns what the fake service received from it: waits for `n` pushes, or with
 * n = 0 waits a while and returns whatever came. Counting starts before the action, because a push
 * can arrive before the response that caused it has been read.
 */
async function pushesFrom(action, n = 1, ms = n ? 8000 : 1500) {
  const start = received.length;
  const result = await action();
  for (let waited = 0; (n ? received.length < start + n : true) && waited < ms; waited += 50) await sleep(50);
  return { result, pushes: received.slice(start) };
}

test('GET /api/push gives the public key; subscribing needs a session and a real push service', async () => {
  const config = await anon.get('push');
  assert.equal(config.body.enabled, true, 'scripts/test.sh sets VAPID keys');
  assert.equal(b64(config.body.public_key).length, 65);

  const { keys } = browserKeys();
  const signedOut = await fetch(`${BASE}/api/push/subscriptions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: `${endpointBase}/x`, keys }),
  });
  assert.equal(signedOut.status, 401);
  const notLocal = await alice.post('push/subscriptions', { endpoint: 'https://evil.example/push', keys });
  assert.equal(notLocal.status, 422);
  const badKeys = await alice.post('push/subscriptions', { endpoint: `${endpointBase}/bad`, keys: { p256dh: 'abc', auth: keys.auth } });
  assert.equal(badKeys.status, 422);
  assert.equal(badKeys.body.error, 'Invalid subscription.');
});

test('subscribe, get pushed, lose the subscription, unsubscribe', async () => {
  const browser = browserKeys();
  const endpoint = `${endpointBase}/alice-${Date.now()}`;
  const subscribe = () => alice.post('push/subscriptions', { endpoint, keys: browser.keys });

  // A new browser gets a confirmation straight away.
  const { result: subscribed, pushes: [confirmation] } = await pushesFrom(subscribe);
  assert.equal(subscribed.status, 200);
  assert.ok(confirmation, 'confirmation push arrived');
  assert.equal(confirmation.path, new URL(endpoint).pathname);
  assert.equal(confirmation.headers['content-encoding'], 'aes128gcm');
  assert.equal(confirmation.headers.ttl, '86400');
  assert.equal(vapidClaims(confirmation.headers.authorization, publicKey).aud, endpointBase);
  assert.deepEqual(JSON.parse(decrypt(confirmation.body, browser)), { title: 'Southbag Social', body: 'Notifications are on.', url: '/notifications' });

  // Sending the same subscription again (every visit does) changes nothing and sends nothing.
  const resent = await pushesFrom(subscribe, 0);
  assert.equal(resent.result.status, 200);
  assert.deepEqual(resent.pushes, []);

  // Anything already read isn't pushed; a new notification is, after the response.
  assert.deepEqual((await pushesFrom(() => alice.post('notifications/read'), 0)).pushes, []);
  const { body: { post } } = await alice.post('posts', { body: 'Push me' });
  const { pushes: [liked] } = await pushesFrom(() => bob.put(`posts/${post.id}/reaction`, { type: 'like' }));
  assert.ok(liked, 'reaction push arrived');
  assert.deepEqual(JSON.parse(decrypt(liked.body, browser)), { title: 'Southbag Social', body: 'Bob Southbag liked your post.', url: `/post/${post.id}` });

  // Pushed once only, however many requests follow.
  assert.deepEqual((await pushesFrom(() => bob.put(`posts/${post.id}/reaction`, { type: 'love' }), 0)).pushes, []);

  // The push service says the subscription is gone: it's dropped, so subscribing again is new.
  reply = 410;
  assert.equal((await pushesFrom(() => carol.put(`posts/${post.id}/reaction`, { type: 'like' }))).pushes.length, 1);
  await sleep(1000); // the Worker drops it once the push service has answered
  reply = 201;
  const { pushes: [again] } = await pushesFrom(subscribe);
  assert.ok(again, 'subscribed again from scratch');
  assert.equal(JSON.parse(decrypt(again.body, browser)).body, 'Notifications are on.');

  // Turned off: nothing more.
  assert.equal((await alice.del(`push/subscriptions?endpoint=${encodeURIComponent(endpoint)}`)).status, 200);
  assert.deepEqual((await pushesFrom(() => bob.post('posts', { body: 'Hello @alice' }), 0)).pushes, []);
  await alice.post('notifications/read');
});
