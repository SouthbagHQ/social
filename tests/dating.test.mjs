import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { BASE, anon, as } from './helpers.mjs';

// kevin is the one who presses Pass (bans are permanent, and no other test file uses Dating).
// alice uses Dating without ever passing, to show one user's ban doesn't touch another's.
const alice = as('alice'), kevin = as('kevin');
const SEEDED = ['alice', 'bob', 'carol', 'kevin'];
const BANNED = 'You no longer have access to Dating.';

const EXPECTED_CARD = {
  name: 'Garlic bread',
  image_url: '/img/garlic-bread.jpg',
};

/** The card is exactly the name and the photo, nothing else. */
function assertGarlicBread(card) {
  assert.deepEqual(card, EXPECTED_CARD);
}

/** Every seeded user's id, handle and name, as they appear through the API. */
async function seededUsers() {
  const out = [];
  for (const handle of SEEDED) {
    const res = await anon.get(`users/${handle}`);
    assert.equal(res.status, 200, `users/${handle}`);
    out.push(res.body.user);
  }
  return out;
}

function assertNoUserData(json, users) {
  const text = JSON.stringify(json).toLowerCase();
  for (const u of users) {
    for (const value of [u.id, u.handle, u.name]) {
      if (value) assert.ok(!text.includes(String(value).toLowerCase()), `response mentions ${value}`);
    }
  }
}

test('dating: signed out is 401', async () => {
  assert.equal((await anon.get('dating')).status, 401);
  for (const path of ['start', 'interested', 'pass']) {
    const res = await fetch(`${BASE}/api/dating/${path}`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401, path);
  }
});

test('dating: start, then the same garlic bread every time', async () => {
  const users = await seededUsers();

  const first = await alice.get('dating');
  assert.equal(first.status, 200);
  assert.equal(first.body.banned, false);
  if (!first.body.started) {
    assert.equal(first.body.card, null, 'no card before starting');
    assert.equal(first.body.interested_count, 0);
  }

  const start = await alice.post('dating/start');
  assert.equal(start.status, 200);
  assert.equal(start.body.started, true);
  assert.equal(start.body.banned, false);
  assertGarlicBread(start.body.card);
  assertNoUserData(start.body, users);

  const again = await alice.post('dating/start');
  assert.equal(again.status, 200, 'start is idempotent');

  const before = (await alice.get('dating')).body.interested_count;
  const cards = [start.body.card];
  for (let i = 1; i <= 5; i++) {
    const res = await alice.post('dating/interested');
    assert.equal(res.status, 200);
    assert.equal(res.body.match, false);
    assert.equal(res.body.banned, false);
    assert.equal(res.body.interested_count, before + i);
    assertGarlicBread(res.body.card);
    assertNoUserData(res.body, users);
    cards.push(res.body.card);
  }
  for (const c of cards) assert.deepEqual(c, cards[0], 'identical card every time');
  assert.equal(new Set(cards.map(c => c.image_url)).size, 1);

  const got = await alice.get('dating');
  assert.deepEqual(got.body.card, cards[0]);
  assert.equal(got.body.interested_count, before + 5);
  assertNoUserData(got.body, users);
});

test('dating: the image is served', async () => {
  const res = await fetch(`${BASE}/img/garlic-bread.jpg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image\/jpeg/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.ok(bytes.length > 10000 && bytes.length < 200 * 1024, `size ${bytes.length}`);
});

test('dating: pass bans permanently', async () => {
  const start = await kevin.post('dating/start');
  assert.equal(start.status, 200);
  assertGarlicBread(start.body.card);
  assert.equal((await kevin.post('dating/interested')).status, 200);

  const pass = await kevin.post('dating/pass');
  assert.equal(pass.status, 200);
  assert.deepEqual(pass.body, { banned: true });

  const got = await kevin.get('dating');
  assert.equal(got.status, 200);
  assert.equal(got.body.banned, true);
  assert.equal(got.body.card, null);

  for (const path of ['dating/start', 'dating/interested', 'dating/pass']) {
    const res = await kevin.post(path);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.error, BANNED);
  }
  // No way back.
  for (const [method, path] of [['del', 'dating/pass'], ['del', 'dating/ban'], ['post', 'dating/unban'], ['post', 'dating/appeal']]) {
    const res = await kevin[method](path);
    assert.ok(res.status === 404 || res.status === 405 || res.status === 403, `${method} ${path} -> ${res.status}`);
  }
  assert.equal((await kevin.get('dating')).body.banned, true);
});

test('dating: the ban survives a new session', async t => {
  if (!process.env.PERSIST_TO) return t.skip('needs PERSIST_TO (run through scripts/test.sh)');
  const token = `dev-kevin-dating-${Date.now().toString(36)}`;
  const hash = createHash('sha256').update(token).digest('base64url');
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', process.env.PERSIST_TO, '--command',
    `INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('${hash}', 'dev-kevin', 9999999999999, ${Date.now()})`],
  { stdio: 'ignore' });
  const headers = { cookie: `southbag_social_session=${token}`, origin: BASE, 'content-type': 'application/json' };
  const me = await (await fetch(`${BASE}/api/me`, { headers })).json();
  assert.equal(me.user?.handle ?? me.handle, 'kevin', 'new session signs in as kevin');
  const got = await (await fetch(`${BASE}/api/dating`, { headers })).json();
  assert.equal(got.banned, true);
  assert.equal(got.card, null);
  const res = await fetch(`${BASE}/api/dating/start`, { method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 403);
});

test("dating: one user's ban doesn't affect another", async () => {
  const got = await alice.get('dating');
  assert.equal(got.body.banned, false);
  assert.equal(got.body.started, true);
  assertGarlicBread(got.body.card);
  const res = await alice.post('dating/interested');
  assert.equal(res.status, 200);
  assertGarlicBread(res.body.card);
  // bob never opened Dating: intro, not banned.
  const bob = await as('bob').get('dating');
  assert.equal(bob.body.banned, false);
});
