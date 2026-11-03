// Agent (MCP) endpoint for Southbag Social. Customers issue named, revocable agent tokens at
// https://identity.southbag.cc/agents; an agent presents one as a bearer token here. Identity
// resolves it fresh on every call, so revocation applies immediately.
//
// Protocol: MCP spec 2025-06-18, Streamable HTTP in its JSON-only form - POST of one JSON-RPC
// message, JSON response; no SSE, no sessions, no batching (batching was removed in 2025-06-18).
//
// Fees: every tools/call costs the MCP request fee below, taken from the token owner's Southbag
// Online Banking account through the BANKING binding (the same Billing entrypoint every Social
// fee uses). initialize / tools/list are free so agents can quote fees before spending. v1 tools
// are read-only; nothing that posts, pays or moves money is exposed here.
//
// Exactly-once: tools/call requires an Idempotency-Key header. The mcp_call journal row starts
// 'pending' BEFORE any fee moves and ends 'done' with the full result, so a retried key replays
// the stored answer without charging again. A row left 'pending' is an UNKNOWN outcome: it is
// NEVER re-run and never reclaimed - without a fencing mechanism shared by the fee executor and
// the action executor, no local observation proves the original call cannot still commit. It
// stays reconciliation-required; the response reports what can be verified.

import type { Env } from '../env';
import { centralStatus, FROZEN_TEXT, STATUS_UNKNOWN_TEXT, IDENTITY_ORIGIN } from './identity.ts';
import { charge, money } from './banking.ts';

// Ingo's ruling in the dev Slack thread (2026-11-03): "fee for everything", then "$1" per MCP
// request. One clearly-marked constant so a pricing change is a one-line PR.
export const MCP_REQUEST_FEE_CENTS = 100;
const MCP_REQUEST_FEE_DESCRIPTION = 'MCP request fee';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26']);

type Json = Record<string, unknown>;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

const feeKey = (userId: string, key: string) => `mcp|social|request|${userId}|${key}`;

// Canonical JSON (keys sorted recursively) so {a:1,b:2} and {b:2,a:1} hash alike.
const canonical = (value: unknown): string => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v);
const argsHash = async (name: string, args: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ name, arguments: args ?? {} })));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
};

interface AgentIdentity { user: { id: string; email: string | null; name: string }; tokenId: string; tokenName: string }
type AgentAuth = AgentIdentity | { status: number; text: string };
const authFailed = (status: number, text: string): AgentAuth => ({ status, text });

// Bearer token -> Identity's internal resolution endpoint (shared INTERNAL_API_SECRETS service
// credential, same as the freeze API). 401 unknown/revoked token; 503 Identity down or this
// service unconfigured. No caching: a cached 'valid' answer is a revocation bypass window.
async function resolveAgent(env: Env, token: string): Promise<AgentAuth> {
  const secret = env.IDENTITY_INTERNAL_SECRET as string | undefined;
  if (!secret) return authFailed(503, 'Agent access is not configured on this service.');
  const origin = (env.IDENTITY_ORIGIN as string | undefined) || IDENTITY_ORIGIN;
  let response: Response;
  try {
    response = await fetch(`${origin}/api/internal/agent-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    console.error('identity agent-token resolution failed', error);
    return authFailed(503, 'Southbag Identity is unavailable, so your agent token cannot be checked. Try again shortly.');
  }
  if (response.status === 404) return authFailed(401, 'Unknown or revoked agent token. Tokens are issued at https://identity.southbag.cc/agents');
  if (response.status === 401 || response.status === 403) {
    console.error(`identity agent-token REJECTED the configured secret (HTTP ${response.status}) - check IDENTITY_INTERNAL_SECRET`);
    return authFailed(503, 'Agent access is misconfigured on this service.');
  }
  if (!response.ok) return authFailed(503, 'Southbag Identity is unavailable, so your agent token cannot be checked. Try again shortly.');
  const row = await response.json() as { userId?: string; email?: string | null; name?: string | null; tokenId?: string; tokenName?: string };
  if (!row || typeof row.userId !== 'string' || !row.userId) return authFailed(401, 'Unknown or revoked agent token.');
  return { user: { id: row.userId, email: row.email ?? null, name: row.name ?? row.userId }, tokenId: String(row.tokenId ?? ''), tokenName: String(row.tokenName ?? '') };
}

function toolList() {
  return [
    {
      name: 'get_profile',
      title: 'Get profile',
      description: `The token owner's profile: handle, name, bio, verified status, counts. Costs the ${money(MCP_REQUEST_FEE_CENTS)} MCP request fee; no additional action fee.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_posts',
      title: 'List posts',
      description: `The token owner's own posts, newest first. Costs the ${money(MCP_REQUEST_FEE_CENTS)} MCP request fee; no additional action fee.`,
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

function initializeResult() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'southbag-social', title: 'Southbag Social', version: '1.0.0' },
    instructions: [
      `Fees: every tools/call costs a ${money(MCP_REQUEST_FEE_CENTS)} request fee, charged to the token owner's Southbag Online Banking account, plus any standard action fees quoted in each tool's description. Discovery (initialize, tools/list) is free.`,
      'Every tools/call MUST include an Idempotency-Key header (8-120 characters). A retried key replays the stored result without charging again. A key whose outcome is unknown is never re-run; the response says what can be verified.',
      'Every tools/call returns an itemised receipt.',
      'Agent tokens are issued and revoked at https://identity.southbag.cc/agents. Revocation applies immediately.',
    ].join(' '),
  };
}

async function runSocialTool(env: Env, user: AgentIdentity['user'], name: string): Promise<{ text: string; data: Json }> {
  if (name === 'get_profile') {
    const row = await env.DB.prepare(
      'SELECT handle, name, bio, location, website, verified, follower_count, following_count, post_count FROM users WHERE id = ?')
      .bind(user.id).first<Record<string, unknown>>();
    if (!row) return { text: 'No profile. Identity knows you; Social does not yet.', data: { profile: null } };
    const profile = {
      handle: row.handle, name: row.name, bio: row.bio, location: row.location, website: row.website,
      verified: !!row.verified, followers: row.follower_count, following: row.following_count, posts: row.post_count,
      url: `/user/${row.handle}`,
    };
    return { text: `@${row.handle}: ${row.name}${row.verified ? ' (Verified™)' : ''}.`, data: { profile } };
  }
  // list_posts
  const { results } = await env.DB.prepare(
    `SELECT id, kind, title, body, visibility, sponsored, created_at FROM posts
     WHERE author_id = ? ORDER BY created_at DESC LIMIT 50`).bind(user.id).all<Record<string, unknown>>();
  const posts = results.map(r => ({
    id: r.id, kind: r.kind, title: r.title, body: r.body, visibility: r.visibility,
    sponsored: !!r.sponsored, createdAt: r.created_at, url: `/post/${r.id}`,
  }));
  return { text: posts.length ? `${posts.length} post${posts.length === 1 ? '' : 's'}.` : 'No posts. The feed starves.', data: { posts } };
}

// A 'pending' journal row means a previous call with this key did not finish cleanly. It is NEVER
// re-run and never reclaimed: without a fencing mechanism shared by the fee executor and the
// action executor, no local observation proves the original call cannot still commit. The row
// stays reconciliation-required. The response reports what can be verified locally; the bank's
// own ledger (its charge idempotency key is derived from ours) holds ground truth for the fee.
function unknownOutcome() {
  return {
    content: [{ type: 'text', text: `A previous call with this Idempotency-Key did not complete. Its outcome is unknown and Southbag does not re-run unknown outcomes. If the ${money(MCP_REQUEST_FEE_CENTS)} request fee was charged it is on your banking ledger. Kevin has been notified.` }],
    isError: true,
    structuredContent: { unknownOutcome: true },
  };
}

async function handleToolsCall(request: Request, env: Env, message: { id: unknown; params?: { name?: unknown; arguments?: unknown } }) {
  const auth = await resolveAgent(env, request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1] || '');
  if ('status' in auth) return json(rpcError(message.id, -32001, auth.text), auth.status);
  const name = typeof message.params?.name === 'string' ? message.params.name : '';
  if (!toolList().some(tool => tool.name === name))
    return json(rpcError(message.id, -32602, `Unknown tool '${name}'. tools/list is free and quotes every fee.`));
  const key = request.headers.get('idempotency-key')?.trim() || '';
  if (key.length < 8 || key.length > 120)
    return json(rpcError(message.id, -32602, 'tools/call requires an Idempotency-Key header (8-120 characters). A retried key replays its stored result without charging again.'));

  const db = env.DB;
  const rowKey = `${auth.user.id}|${key}`;
  const hash = await argsHash(name, message.params?.arguments);
  const replay = (storedRow: { response: string }) => {
    const stored = JSON.parse(storedRow.response);
    if (stored.structuredContent?.receipt) stored.structuredContent.receipt.duplicate = true;
    return json(rpcResult(message.id, stored));
  };

  const existing = await db.prepare('SELECT tool, args_hash, status, response FROM mcp_call WHERE idempotency_key = ?').bind(rowKey).first<{ tool: string; args_hash: string; status: string; response: string | null }>();
  if (existing) {
    // An idempotency key names ONE call: this user, this tool, these arguments. A different tool
    // or different arguments under a used key is a caller bug, never a replay.
    if (existing.tool !== name)
      return json(rpcError(message.id, -32602, `This Idempotency-Key was already used for '${existing.tool}'. Keys are not shared across tools.`));
    if (existing.args_hash !== hash)
      return json(rpcError(message.id, -32602, 'This Idempotency-Key was already used with different arguments. Keys name one exact call.'));
    if (existing.status === 'done') return replay(existing as { response: string });
    return json(rpcResult(message.id, unknownOutcome()));
  }

  // Central freeze check BEFORE any fee moves, fresh per call, fail closed. Frozen/unknown
  // answers are not journaled and not charged, so the same key works once the account is back.
  const central = await centralStatus(env, auth.user.id);
  if (central === 'unknown') return json(rpcResult(message.id, { content: [{ type: 'text', text: STATUS_UNKNOWN_TEXT }], isError: true }));
  if (central !== 'off' && central.frozen) return json(rpcResult(message.id, { content: [{ type: 'text', text: FROZEN_TEXT }], isError: true }));

  try {
    await db.prepare("INSERT INTO mcp_call (idempotency_key, user_id, tool, args_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .bind(rowKey, auth.user.id, name, hash, Date.now(), Date.now()).run();
  } catch (error) {
    if (!String(error).includes('UNIQUE constraint failed')) throw error;
    // A concurrent call with the same key claimed it first.
    const raced = await db.prepare('SELECT status, response FROM mcp_call WHERE idempotency_key = ?').bind(rowKey).first<{ status: string; response: string | null }>();
    if (!raced) throw error;
    if (raced.status === 'done') return replay(raced as { response: string });
    return json(rpcResult(message.id, unknownOutcome()));
  }

  // Claimed. Charge the request fee first: the journal row is already 'pending', and the bank's
  // own idempotency key (derived from ours) makes a retry of THIS charge a no-op instead of a
  // second debit. If the charge throws, the row stays 'pending' - unknown, never re-run.
  const chargeResult = await charge(env, auth.user, MCP_REQUEST_FEE_CENTS, MCP_REQUEST_FEE_DESCRIPTION, feeKey(auth.user.id, key));

  let result: Json;
  try {
    const { text, data } = await runSocialTool(env, auth.user, name);
    result = {
      content: [{ type: 'text', text }],
      isError: false,
      structuredContent: {
        ...data,
        receipt: {
          requestFee: { amount: MCP_REQUEST_FEE_CENTS, description: MCP_REQUEST_FEE_DESCRIPTION, duplicate: chargeResult.duplicate ?? false },
          balanceAfter: chargeResult.balance,
          duplicate: false,
        },
      },
    };
  } catch (error) {
    console.error(`mcp tools/call ${name} failed after charging`, error);
    // The request fee was charged; the action's own outcome is unknown. The result is terminal
    // (journaled 'done'): the call is never re-run.
    result = {
      content: [{ type: 'text', text: `The ${money(MCP_REQUEST_FEE_CENTS)} request fee was charged, then the action failed (${String((error as Error).message || error)}). Southbag does not re-run it. Kevin has been notified.` }],
      isError: true,
      structuredContent: {
        receipt: {
          requestFee: { amount: MCP_REQUEST_FEE_CENTS, description: MCP_REQUEST_FEE_DESCRIPTION, duplicate: chargeResult.duplicate ?? false },
          actionFailed: true,
          duplicate: false,
        },
      },
    };
  }
  await db.prepare("UPDATE mcp_call SET status = 'done', response = ?, updated_at = ? WHERE idempotency_key = ?")
    .bind(JSON.stringify(result), Date.now(), rowKey).run();
  return json(rpcResult(message.id, result));
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET' || request.method === 'DELETE')
    return json({ error: 'This endpoint speaks JSON only; no event stream.' }, 405, { allow: 'POST' });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST' });

  const version = request.headers.get('mcp-protocol-version');
  if (version && !SUPPORTED_VERSIONS.has(version))
    return json(rpcError(null, -32600, `Unsupported MCP protocol version '${version}'. This server speaks ${[...SUPPORTED_VERSIONS].join(', ')}.`), 400);

  let message: { id?: unknown; jsonrpc?: string; method?: string; params?: { name?: unknown; arguments?: unknown } };
  try {
    message = await request.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }
  if (Array.isArray(message) || !message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
    return json(rpcError((message as Json)?.id ?? null, -32600, 'Invalid request: one JSON-RPC message per POST; batching is not supported.'), 400);

  // Notifications have no id and get no response body.
  if (message.id === undefined || message.id === null) {
    if (message.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    return json(rpcError(null, -32600, 'Requests must carry an id; notifications use the notifications/* methods.'), 400);
  }

  switch (message.method) {
    case 'initialize':
      return json(rpcResult(message.id, initializeResult()), 200, { 'mcp-protocol-version': PROTOCOL_VERSION });
    case 'ping':
      return json(rpcResult(message.id, {}));
    case 'tools/list': {
      // Discovery is free but authenticated: the catalogue is for customers' agents.
      const auth = await resolveAgent(env, request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1] || '');
      if ('status' in auth) return json(rpcError(message.id, -32001, auth.text), auth.status);
      return json(rpcResult(message.id, { tools: toolList() }));
    }
    case 'tools/call':
      return await handleToolsCall(request, env, message as { id: unknown; params?: { name?: unknown; arguments?: unknown } });
    default:
      return json(rpcError(message.id, -32601, `Method not found: ${message.method}`));
  }
}
