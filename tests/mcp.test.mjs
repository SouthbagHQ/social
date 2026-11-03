// /mcp endpoint unit tests (src/lib/mcp.ts): protocol shape, agent-token auth, the $1 request
// fee, freeze enforcement, and the crash-safety journal. Self-contained (node:sqlite + stubs);
// does not need the wrangler dev server the other tests use.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp, MCP_REQUEST_FEE_CENTS } from '../src/lib/mcp.ts';

function d1Shim(db) {
  const prepare = sql => ({
    bind(...params) { this.params = params; return this; },
    async first() { return db.prepare(sql).get(...(this.params || [])) ?? null; },
    async all() { return { results: db.prepare(sql).all(...(this.params || [])) }; },
    async run() {
      const r = db.prepare(sql).run(...(this.params || []));
      return { meta: { changes: Number(r.changes) } };
    },
  });
  let queue = Promise.resolve();
  return {
    prepare,
    batch(statements) {
      const result = queue.then(async () => {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}

function setup(userId, { frozen = false, identityUnreachable = false } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations').sort()) db.exec(readFileSync('migrations/' + file, 'utf8'));
  db.prepare("INSERT INTO users (id, handle, name, bio, verified, created_at, updated_at) VALUES (?, 'ingo', 'Ingo', 'Runs the place', 1, 0, 0)").run(userId);
  db.prepare("INSERT INTO posts (id, author_id, kind, body, created_at) VALUES ('p1', ?, 'text', 'Kevin is watching', 5)").run(userId);
  const charges = [];
  const chargedKeys = new Map();
  const env = {
    DB: d1Shim(db),
    IDENTITY_INTERNAL_SECRET: 'bsec',
    IDENTITY_ORIGIN: 'http://identity.test',
    BANKING: {
      async charge(input) {
        if (input.idempotencyKey && chargedKeys.get(input.idempotencyKey) === input.amount)
          return { balance: 12345, opened: false, duplicate: true };
        if (input.idempotencyKey) chargedKeys.set(input.idempotencyKey, input.amount);
        charges.push(input);
        return { balance: 12345, opened: false, duplicate: false };
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (identityUnreachable) throw new Error('connection refused');
    if (String(url).endsWith('/api/internal/agent-token')) {
      const token = JSON.parse(init.body).token;
      if (!String(token).startsWith('good-')) return new Response(JSON.stringify({ error: 'unknown_token' }), { status: 404 });
      return new Response(JSON.stringify({ tokenId: 'tok1', tokenName: 'test', userId, email: `${userId}@x.test`, name: 'Ingo' }), { status: 200 });
    }
    return new Response(JSON.stringify({ frozen }), { status: 200 });
  };
  return { db, env, charges, restore: () => { globalThis.fetch = originalFetch; } };
}

const post = (body, headers = {}) => new Request('https://social.southbag.cc/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const auth = { authorization: 'Bearer good-token-1' };
const key = { 'idempotency-key': 'test-key-0001' };
const journal = db => db.prepare('SELECT * FROM mcp_call').all();

test('initialize needs no auth; GET is 405; notifications are 202', async () => {
  const { env, restore } = setup('u1');
  const res = await handleMcp(post(rpc(1, 'initialize')), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.serverInfo.name, 'southbag-social');
  assert.equal((await handleMcp(new Request('https://social.southbag.cc/mcp'), env)).status, 405);
  assert.equal((await handleMcp(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), env)).status, 202);
  restore();
});

test('tools/list is authenticated but free', async () => {
  const { env, charges, restore } = setup('u1');
  assert.equal((await handleMcp(post(rpc(1, 'tools/list')), env)).status, 401);
  const res = await handleMcp(post(rpc(2, 'tools/list'), auth), env);
  assert.deepEqual((await res.json()).result.tools.map(t => t.name), ['get_profile', 'list_posts']);
  assert.equal(charges.length, 0);
  restore();
});

test('tools/call get_profile charges $1 and returns the profile with a receipt', async () => {
  const { db, env, charges, restore } = setup('u1');
  const res = await handleMcp(post(rpc(1, 'tools/call', { name: 'get_profile', arguments: {} }), { ...auth, ...key }), env);
  const body = await res.json();
  assert.equal(body.result.isError, false);
  assert.equal(body.result.structuredContent.profile.handle, 'ingo');
  assert.equal(body.result.structuredContent.profile.verified, true);
  assert.equal(body.result.structuredContent.receipt.requestFee.amount, MCP_REQUEST_FEE_CENTS);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].idempotencyKey, 'mcp|social|request|u1|test-key-0001');
  assert.equal(journal(db)[0].status, 'done');
  restore();
});

test('list_posts returns own posts; a retried key replays without charging again', async () => {
  const { env, charges, restore } = setup('u1');
  const first = await handleMcp(post(rpc(1, 'tools/call', { name: 'list_posts' }), { ...auth, ...key }), env);
  assert.equal((await first.json()).result.structuredContent.posts[0].body, 'Kevin is watching');
  const second = await handleMcp(post(rpc(2, 'tools/call', { name: 'list_posts' }), { ...auth, ...key }), env);
  assert.equal((await second.json()).result.structuredContent.receipt.duplicate, true);
  assert.equal(charges.length, 1);
  restore();
});

test('missing key refused; key reuse across tools or args is a caller bug', async () => {
  const { env, charges, restore } = setup('u1');
  assert.equal((await (await handleMcp(post(rpc(1, 'tools/call', { name: 'get_profile' }), auth), env)).json()).error.code, -32602);
  await handleMcp(post(rpc(2, 'tools/call', { name: 'get_profile', arguments: {} }), { ...auth, ...key }), env);
  assert.match((await (await handleMcp(post(rpc(3, 'tools/call', { name: 'list_posts' }), { ...auth, ...key }), env)).json()).error.message, /already used for 'get_profile'/);
  assert.match((await (await handleMcp(post(rpc(4, 'tools/call', { name: 'get_profile', arguments: { x: 1 } }), { ...auth, ...key }), env)).json()).error.message, /different arguments/);
  assert.equal(charges.length, 1);
  restore();
});

test('frozen and unknown both fail closed with no charge and no journal row', async () => {
  for (const opts of [{ frozen: true }, { identityUnreachable: true }]) {
    const { db, env, charges, restore } = setup('u1', opts);
    const res = await handleMcp(post(rpc(1, 'tools/call', { name: 'get_profile' }), { ...auth, ...key }), env);
    assert.ok([200, 503].includes(res.status));
    if (res.status === 200) assert.equal((await res.json()).result.isError, true);
    assert.equal(charges.length, 0);
    assert.equal(journal(db).length, 0);
    restore();
  }
});

test('a pending row is terminal: never re-run, then replays once the original lands', async () => {
  const { db, env, charges, restore } = setup('u1');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{"arguments":{},"name":"get_profile"}'));
  const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  db.prepare("INSERT INTO mcp_call (idempotency_key, user_id, tool, args_hash, status, created_at, updated_at) VALUES ('u1|test-key-0001', 'u1', 'get_profile', ?, 'pending', ?, ?)")
    .run(hash, Date.now() - 120000, Date.now() - 120000);
  const retry = await handleMcp(post(rpc(1, 'tools/call', { name: 'get_profile' }), { ...auth, ...key }), env);
  assert.equal((await retry.json()).result.structuredContent.unknownOutcome, true);
  assert.equal(charges.length, 0);
  assert.equal(journal(db)[0].status, 'pending');
  const stored = { content: [{ type: 'text', text: '@ingo' }], isError: false, structuredContent: { receipt: { duplicate: false } } };
  db.prepare("UPDATE mcp_call SET status = 'done', response = ?, updated_at = ? WHERE idempotency_key = 'u1|test-key-0001'").run(JSON.stringify(stored), Date.now());
  const replay = await handleMcp(post(rpc(2, 'tools/call', { name: 'get_profile' }), { ...auth, ...key }), env);
  assert.equal((await replay.json()).result.structuredContent.receipt.duplicate, true);
  assert.equal(charges.length, 0);
  restore();
});
