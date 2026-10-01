// Servers (Discord style): members, roles, categories, text channels and messages. Mounted at /api/servers.
//
// Servers
//   GET    /api/servers                               your servers -> { items: [{ id, name, icon_url, member_count, owner_id, unread, mention_count }] }
//   POST   /api/servers                               { name, description?, icon_media_id? } -> 201 { server } (with #general and @everyone)
//   GET    /api/servers/invite/:code                  invite preview -> { server, is_member, banned }
//   POST   /api/servers/join/:code                    join -> { server, joined }
//   GET    /api/servers/:id                           -> ServerDetail (server, categories, channels, roles, me, online_count)
//   PATCH  /api/servers/:id                           manage_server: { name?, description?, icon_media_id? } -> { server }
//   DELETE /api/servers/:id                           owner only
//   POST   /api/servers/:id/invite                    manage_server: new invite code -> { invite_code }
//   POST   /api/servers/:id/leave                     leave (the owner must delete instead)
//   POST   /api/servers/:id/reorder                   manage_channels: { categories: [id], channels: [{ id, category_id }] } (in order)
// Members, bans
//   GET    /api/servers/:id/members                   -> { items: [{ user, nickname, display_name, role_ids, online, is_owner, joined_at }], online_count }
//   PATCH  /api/servers/:id/members/:userId           { nickname } (yourself, or manage_server for others; "me" works)
//   DELETE /api/servers/:id/members/:userId           kick_members
//   PUT    /api/servers/:id/members/:userId/roles/:roleId    manage_roles: assign
//   DELETE /api/servers/:id/members/:userId/roles/:roleId    manage_roles: remove
//   GET    /api/servers/:id/bans                      ban_members -> { items: [{ user, reason, created_at }] }
//   PUT    /api/servers/:id/bans/:userId              ban_members: { reason? } (removes them from the server)
//   DELETE /api/servers/:id/bans/:userId              ban_members: unban
// Roles
//   POST   /api/servers/:id/roles                     manage_roles: { name, permissions? } -> 201 { role }
//   PATCH  /api/servers/:id/roles/:roleId             manage_roles: { name?, permissions? } -> { role }
//   DELETE /api/servers/:id/roles/:roleId             manage_roles
//   POST   /api/servers/:id/roles/reorder             manage_roles: { ids: [roleId, ...] } highest first (not @everyone)
// Channels and categories
//   POST   /api/servers/:id/channels                  manage_channels: { name, category_id?, kind?, topic?, slowmode_seconds? } -> 201 { channel }
//   PATCH  /api/servers/:id/channels/:cid             manage_channels: { name?, topic?, kind?, slowmode_seconds?, category_id? } -> { channel }
//   DELETE /api/servers/:id/channels/:cid             manage_channels (its messages go with it)
//   POST   /api/servers/:id/categories                manage_channels: { name } -> 201 { category }
//   PATCH  /api/servers/:id/categories/:catId         manage_channels: { name } -> { category }
//   DELETE /api/servers/:id/categories/:catId         manage_channels (its channels become uncategorised)
// Messages (every member can read every channel)
//   GET    .../channels/:cid/messages?before=&limit=  newest first -> { items: MessageJson[], next, now }
//   POST   .../channels/:cid/messages                 { body?, reply_to_id?, media_id? } -> 201 { message }
//   PATCH  .../channels/:cid/messages/:mid            own only: { body } -> { message }
//   DELETE .../channels/:cid/messages/:mid            own, or manage_messages
//   PUT    .../channels/:cid/messages/:mid/pin        manage_messages (DELETE to unpin) -> { message }
//   PUT    .../channels/:cid/messages/:mid/reactions/:word   (DELETE to remove) -> { message }
//   GET    .../channels/:cid/pins                     -> { items: MessageJson[] } newest pin first
//   POST   .../channels/:cid/read                     marks the channel read
//   POST   .../channels/:cid/typing                   "is typing" for 6 s
//   GET    .../channels/:cid/poll?after=<id>&since=<ms>&read=1   see below
//
// "Realtime" by polling. The free plan has no WebSockets/Durable Objects, and allows 100k Worker requests
// and 5M D1 row reads a day. So each open channel polls ONE endpoint, which answers in one D1 batch (plus a
// second only when there are messages to hydrate): messages newer than `after`, messages edited, pinned,
// reacted to or deleted since `since` (the `now` of the previous poll, minus a few seconds for clock drift
// between Workers), who is typing (channel_typing.until > now), how many members were seen in the last
// 60 s, unread and mention counts for the server's channels and `structure_at` (reload the server when it
// changes). The poll also refreshes the caller's presence (a write at most every 30 s) and, with read=1,
// moves their read position (a write only when it changes).
// The client polls every 3 s while the channel is focused and something happened in the last minute, then
// 10 s, then 25 s after five quiet minutes, and not at all while the tab is hidden. One person chatting
// actively for an hour is ~1,200 requests, an idle open tab ~150 an hour, so the daily free allowance covers
// roughly 80 hours of busy chatting or 650 hours of idle open tabs. Slow the intervals before reaching for a
// paid feature.
//
// Permissions are a bitmask on roles (PERMS). Every member has @everyone (role id = server id, position 0).
// The owner has everything. Acting on another member (kick, ban, nickname, roles) needs a higher top role.

import { Hono } from 'hono';
import type { AppEnv, Ctx, Env, SessionUser } from '../env';
import { body, fail, limit, placeholders, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { mediaJson, ownedReadyMedia, type MediaJson, type MediaRow } from '../lib/media';
import { notifyStatement } from '../lib/notify';
import { track } from '../lib/palantir';
import { userCard, userCardColumns, type UserCard, type UserRow } from '../lib/users';

const servers = new Hono<AppEnv>();

// -- Limits and constants -------------------------------------------------

export const PERMS = {
  manage_server: 1,
  manage_channels: 2,
  manage_roles: 4,
  kick_members: 8,
  ban_members: 16,
  manage_messages: 32,
  mention_everyone: 64,
} as const;
export type Perm = keyof typeof PERMS;
const ALL_PERMS = Object.values(PERMS).reduce((a, b) => a | b, 0);

export const REACTIONS = ['like', 'agree', 'laugh', 'thanks', 'wow', 'sad'] as const;
export const MAX_BODY = 4000;
const MAX_SERVER_NAME = 100;
const MAX_DESCRIPTION = 500;
const MAX_CHANNEL_NAME = 40;
const MAX_TOPIC = 300;
const MAX_CATEGORY_NAME = 40;
const MAX_ROLE_NAME = 40;
const MAX_NICKNAME = 32;
const MAX_CHANNELS = 50;
const MAX_CATEGORIES = 20;
const MAX_ROLES = 25;
const MAX_PINS = 50;
const MAX_OWNED = 25;
const MAX_JOINED = 100;
const MAX_MENTIONS = 10; // explicit @handles notified per message
const MAX_EVERYONE_NOTIFY = 100; // members notified by @everyone
const MAX_MEMBERS_LIST = 500;
export const SLOWMODES = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
const TYPING_MS = 6000;
const ONLINE_MS = 60000;
const PRESENCE_EVERY_MS = 30000;
const CLOCK_SLACK_MS = 3000;

// -- Rows and JSON --------------------------------------------------------

interface ServerRow {
  id: string;
  name: string;
  description: string;
  icon_media_id: string | null;
  owner_id: string;
  invite_code: string;
  member_count: number;
  structure_at: number;
  created_at: number;
}

interface ChannelRow {
  id: string;
  server_id: string;
  category_id: string | null;
  name: string;
  topic: string;
  kind: 'text' | 'announcement';
  position: number;
  slowmode_seconds: number;
  last_message_id: string | null;
  created_at: number;
}

interface CategoryRow { id: string; server_id: string; name: string; position: number; created_at: number }

interface RoleRow {
  id: string;
  server_id: string;
  name: string;
  colour: string | null;
  position: number;
  permissions: number;
  created_at: number;
  member_count?: number;
}

interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string | null;
  body: string;
  reply_to_id: string | null;
  media_id: string | null;
  mention_everyone: number;
  pinned: number;
  pinned_at: number | null;
  edited_at: number | null;
  deleted_at: number | null;
  updated_at: number | null;
  created_at: number;
}

export type MemberCard = UserCard & { nickname: string | null; display_name: string };

export interface MessageJson {
  id: string;
  channel_id: string;
  author: MemberCard | null;
  body: string;
  media: MediaJson | null;
  reply_to: { id: string; author: MemberCard | null; body: string; has_media: boolean; deleted: boolean } | null;
  mention_everyone: boolean;
  mentions_me: boolean;
  pinned: boolean;
  pinned_at: number | null;
  edited_at: number | null;
  created_at: number;
  reactions: { reaction: string; count: number; me: boolean }[];
}

const iconUrl = (s: Pick<ServerRow, 'icon_media_id'>) => (s.icon_media_id ? `/media/${s.icon_media_id}` : null);

const serverJson = (s: ServerRow) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  icon_url: iconUrl(s),
  owner_id: s.owner_id,
  invite_code: s.invite_code,
  member_count: s.member_count,
  structure_at: s.structure_at,
  created_at: s.created_at,
});

const permsJson = (bits: number) =>
  Object.fromEntries(Object.entries(PERMS).map(([k, v]) => [k, (bits & v) === v])) as Record<Perm, boolean>;

const roleJson = (r: RoleRow) => ({
  id: r.id,
  name: r.name,
  position: r.position,
  permissions: r.permissions,
  is_everyone: r.id === r.server_id,
  member_count: r.member_count ?? null,
});

const categoryJson = (c: CategoryRow) => ({ id: c.id, name: c.name, position: c.position });

const channelJson = (c: ChannelRow, state?: { unread: boolean; mention_count: number }) => ({
  id: c.id,
  server_id: c.server_id,
  category_id: c.category_id,
  name: c.name,
  topic: c.topic,
  kind: c.kind,
  position: c.position,
  slowmode_seconds: c.slowmode_seconds,
  last_message_id: c.last_message_id,
  unread: state?.unread ?? false,
  mention_count: state?.mention_count ?? 0,
});

const u = (alias: string) => userCardColumns.split(', ').map(col => `${alias}.${col}`).join(', ');

const memberCard = (row: UserRow & { nickname?: string | null }): MemberCard => ({
  ...userCard(row),
  nickname: row.nickname ?? null,
  display_name: row.nickname || row.name,
});

// -- Input helpers --------------------------------------------------------

/** "Book Club!" -> "book-club". Channel names are lowercase words joined by dashes. */
export function channelName(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  return raw.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, MAX_CHANNEL_NAME).replace(/-$/, '');
}

function inviteCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(8))) s += alphabet[b % alphabet.length];
  return s;
}

const excerpt = (text: string, max = 100) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : chars.join('');
};

function permissionBits(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value & ALL_PERMS;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    let bits = 0;
    for (const [k, v] of Object.entries(value)) if (v && k in PERMS) bits |= PERMS[k as Perm];
    return bits;
  }
  if (Array.isArray(value)) {
    let bits = 0;
    for (const k of value) if (typeof k === 'string' && k in PERMS) bits |= PERMS[k as Perm];
    return bits;
  }
  return 0;
}

// -- Access ---------------------------------------------------------------

interface Access {
  server: ServerRow;
  userId: string;
  isOwner: boolean;
  perms: number;
  /** Highest role position (Infinity for the owner, 0 with only @everyone). */
  top: number;
  roleIds: string[];
  nickname: string | null;
  channel: ChannelRow | null;
}

const NOT_FOUND = 'Server not found.';
const NO_PERMISSION = 'You do not have permission to do that.';

/** Loads the server (404 unless the viewer is a member), the viewer's permissions and optionally a channel. */
async function access(env: Env, userId: string, serverId: string, channelId?: string): Promise<Access> {
  const statements = [
    env.DB.prepare(`SELECT s.*, sm.nickname AS member_nickname FROM servers s
        JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = ?2 WHERE s.id = ?1`).bind(serverId, userId),
    env.DB.prepare(`SELECT id, position, permissions FROM server_roles WHERE server_id = ?1
        AND (id = ?1 OR id IN (SELECT role_id FROM server_member_roles WHERE server_id = ?1 AND user_id = ?2))`).bind(serverId, userId),
  ];
  if (channelId) statements.push(env.DB.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').bind(channelId, serverId));
  const [serverRes, rolesRes, channelRes] = await env.DB.batch(statements);
  const server = serverRes.results[0] as (ServerRow & { member_nickname: string | null }) | undefined;
  if (!server) fail(404, NOT_FOUND);
  const roles = rolesRes.results as { id: string; position: number; permissions: number }[];
  const isOwner = server.owner_id === userId;
  let perms = 0, top = 0;
  for (const r of roles) {
    perms |= r.permissions;
    if (r.id !== serverId) top = Math.max(top, r.position);
  }
  const channel = channelId ? (channelRes.results[0] as ChannelRow | undefined) ?? null : null;
  if (channelId && !channel) fail(404, 'Channel not found.');
  return {
    server,
    userId,
    isOwner,
    perms: isOwner ? ALL_PERMS : perms & ALL_PERMS,
    top: isOwner ? Infinity : top,
    roleIds: roles.filter(r => r.id !== serverId).map(r => r.id),
    nickname: server.member_nickname,
    channel,
  };
}

/** Route param inside helpers typed with the plain Ctx. */
const param = (c: Ctx, name: string): string => c.req.param(name) ?? '';

const can = (a: Access, perm: Perm) => (a.perms & PERMS[perm]) === PERMS[perm];
function need(a: Access, ...perms: Perm[]) {
  if (!perms.some(p => can(a, p))) fail(403, NO_PERMISSION);
}

/** Can the viewer post in this channel? Announcement channels are for moderators. */
const canPost = (a: Access, ch: ChannelRow) => ch.kind !== 'announcement' || can(a, 'manage_channels') || can(a, 'manage_messages');

interface Target { member: boolean; isOwner: boolean; top: number }

async function target(env: Env, serverId: string, userId: string, ownerId: string): Promise<Target> {
  const row = await env.DB.prepare(`SELECT sm.user_id, (SELECT MAX(r.position) FROM server_member_roles mr
        JOIN server_roles r ON r.id = mr.role_id WHERE mr.server_id = sm.server_id AND mr.user_id = sm.user_id) AS top
      FROM server_members sm WHERE sm.server_id = ? AND sm.user_id = ?`).bind(serverId, userId).first<{ user_id: string; top: number | null }>();
  return { member: Boolean(row), isOwner: userId === ownerId, top: row?.top ?? 0 };
}

/** The viewer can act on this member only from a higher top role (the owner outranks everyone). */
function mustOutrank(a: Access, t: Target) {
  if (t.isOwner || !(a.isOwner || a.top > t.top)) fail(403, 'You can only manage members below your highest role.');
}

const bump = (env: Env, serverId: string, now: number) =>
  env.DB.prepare('UPDATE servers SET structure_at = ? WHERE id = ?').bind(now, serverId);

const recount = (env: Env, serverId: string) =>
  env.DB.prepare('UPDATE servers SET member_count = (SELECT COUNT(*) FROM server_members WHERE server_id = ?1) WHERE id = ?1').bind(serverId);

/** Statements that remove someone from a server (leave, kick, ban). */
const removeMember = (env: Env, serverId: string, userId: string) => [
  env.DB.prepare('DELETE FROM server_member_roles WHERE server_id = ? AND user_id = ?').bind(serverId, userId),
  env.DB.prepare('DELETE FROM server_presence WHERE server_id = ? AND user_id = ?').bind(serverId, userId),
  env.DB.prepare('DELETE FROM channel_typing WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE server_id = ?)').bind(userId, serverId),
  env.DB.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').bind(serverId, userId),
  recount(env, serverId),
];

/** Refreshes presence at most every 30 s (a write only when stale), and only for members. */
const presenceStatement = (env: Env, serverId: string, userId: string, now: number) =>
  env.DB.prepare(`INSERT INTO server_presence (server_id, user_id, last_seen_at)
      SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM server_members WHERE server_id = ?1 AND user_id = ?2)
      ON CONFLICT (server_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
      WHERE excluded.last_seen_at > server_presence.last_seen_at + ${PRESENCE_EVERY_MS}`).bind(serverId, userId, now);

/** Moves the viewer's read position to the channel's newest message (a write only when it moves). */
const readStatement = (env: Env, serverId: string, channelId: string, userId: string) =>
  env.DB.prepare(`INSERT INTO channel_reads (channel_id, user_id, last_read_id)
      SELECT c.id, ?1, c.last_message_id FROM channels c WHERE c.id = ?2 AND c.server_id = ?3 AND c.last_message_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM server_members WHERE server_id = ?3 AND user_id = ?1)
      ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_id = excluded.last_read_id
      WHERE excluded.last_read_id > channel_reads.last_read_id`).bind(userId, channelId, serverId);

/** Every channel of a server with the viewer's unread flag and mention count. */
const channelStateStatement = (env: Env, serverId: string, userId: string) =>
  env.DB.prepare(`SELECT c.*, COALESCE(r.last_read_id, '') AS read_id,
        (SELECT COUNT(*) FROM channel_mentions m WHERE m.user_id = ?1 AND m.channel_id = c.id
          AND m.message_id > COALESCE(r.last_read_id, '')) +
        (SELECT COUNT(*) FROM channel_messages x WHERE x.channel_id = c.id AND x.mention_everyone = 1
          AND x.id > COALESCE(r.last_read_id, '') AND x.deleted_at IS NULL AND x.author_id IS NOT ?1) AS mentions
      FROM channels c LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = ?1
      WHERE c.server_id = ?2 ORDER BY c.position, c.id`).bind(userId, serverId);

type ChannelStateRow = ChannelRow & { read_id: string; mentions: number };
const channelState = (c: ChannelStateRow) => ({ unread: (c.last_message_id ?? '') > c.read_id, mention_count: c.mentions });

// -- Messages -------------------------------------------------------------

const mentionHandles = (text: string) =>
  [...new Set([...text.matchAll(/(^|[^\w])@(\w{3,20})/g)].map(m => m[2].toLowerCase()))].filter(h => h !== 'everyone' && h !== 'here');
const mentionsEveryone = (text: string) => /(^|[^\w])@(everyone|here)\b/.test(text);

/** Message rows -> JSON, batching authors (with server nicknames), files, quoted replies and reactions. */
async function hydrate(env: Env, viewer: SessionUser, serverId: string, rows: MessageRow[]): Promise<MessageJson[]> {
  if (!rows.length) return [];
  const authorIds = [...new Set(rows.map(m => m.author_id).filter((x): x is string => Boolean(x)))];
  const mediaIds = [...new Set(rows.map(m => m.media_id).filter((x): x is string => Boolean(x)))];
  const replyIds = [...new Set(rows.map(m => m.reply_to_id).filter((x): x is string => Boolean(x)))];
  const ids = rows.map(m => m.id);
  const statements: [string, D1PreparedStatement][] = [
    ['reactions', env.DB.prepare(`SELECT message_id, reaction, COUNT(*) AS n, MAX(user_id = ?) AS me FROM channel_reactions
        WHERE message_id IN (${placeholders(ids.length)}) GROUP BY message_id, reaction ORDER BY MIN(created_at)`).bind(viewer.id, ...ids)],
  ];
  if (authorIds.length) statements.push(['authors', env.DB.prepare(`SELECT ${u('u')}, sm.nickname FROM users u
      LEFT JOIN server_members sm ON sm.server_id = ? AND sm.user_id = u.id WHERE u.id IN (${placeholders(authorIds.length)})`)
    .bind(serverId, ...authorIds)]);
  if (mediaIds.length) statements.push(['media', env.DB.prepare(`SELECT * FROM media WHERE status = 'ready' AND id IN (${placeholders(mediaIds.length)})`)
    .bind(...mediaIds)]);
  if (replyIds.length) statements.push(['replies', env.DB.prepare(`SELECT m.id AS message_id, m.body, m.media_id, m.deleted_at,
        m.author_id AS id, u.handle, u.name, u.avatar_media_id, u.identity_picture, u.verified, sm.nickname
      FROM channel_messages m LEFT JOIN users u ON u.id = m.author_id
      LEFT JOIN server_members sm ON sm.server_id = ? AND sm.user_id = m.author_id
      WHERE m.id IN (${placeholders(replyIds.length)})`).bind(serverId, ...replyIds)]);
  const results = await env.DB.batch(statements.map(s => s[1]));
  const out = Object.fromEntries(statements.map(([name], i) => [name, results[i].results as unknown[]]));

  const authors = new Map((out.authors as (UserRow & { nickname: string | null })[] ?? []).map(r => [r.id, memberCard(r)]));
  const media = new Map((out.media as MediaRow[] ?? []).map(m => [m.id, mediaJson(m)]));
  type ReplyRow = UserRow & { message_id: string; nickname: string | null; body: string; media_id: string | null; deleted_at: number | null };
  const replies = new Map((out.replies as ReplyRow[] ?? []).map(r => [r.message_id, r]));
  const reactions = new Map<string, MessageJson['reactions']>();
  for (const r of out.reactions as { message_id: string; reaction: string; n: number; me: number }[]) {
    if (!reactions.has(r.message_id)) reactions.set(r.message_id, []);
    reactions.get(r.message_id)!.push({ reaction: r.reaction, count: r.n, me: Boolean(r.me) });
  }
  const mine = new RegExp(`(^|[^\\w])@${viewer.handle.replace(/[^\w]/g, '')}(?!\\w)`, 'i');

  return rows.map(m => {
    const r = m.reply_to_id ? replies.get(m.reply_to_id) : undefined;
    const replyAuthor = r && r.id && r.handle ? memberCard(r) : null;
    return {
      id: m.id,
      channel_id: m.channel_id,
      author: m.author_id ? authors.get(m.author_id) ?? null : null,
      body: m.body,
      media: m.media_id ? media.get(m.media_id) ?? null : null,
      reply_to: m.reply_to_id ? {
        id: m.reply_to_id,
        author: r && !r.deleted_at ? replyAuthor : null,
        body: r && !r.deleted_at ? excerpt(r.body, 120) : '',
        has_media: Boolean(r && !r.deleted_at && r.media_id),
        deleted: !r || Boolean(r.deleted_at),
      } : null,
      mention_everyone: Boolean(m.mention_everyone),
      mentions_me: Boolean(m.author_id !== viewer.id && (m.mention_everyone || mine.test(m.body)
        || (replyAuthor && replyAuthor.id === viewer.id && r && !r.deleted_at))),
      pinned: Boolean(m.pinned),
      pinned_at: m.pinned_at,
      edited_at: m.edited_at,
      created_at: m.created_at,
      reactions: reactions.get(m.id) ?? [],
    };
  });
}

async function loadMessage(env: Env, channelId: string, messageId: string): Promise<MessageRow> {
  const row = await env.DB.prepare('SELECT * FROM channel_messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL')
    .bind(messageId, channelId).first<MessageRow>();
  if (!row) fail(404, 'Message not found.');
  return row;
}

async function oneMessage(env: Env, viewer: SessionUser, serverId: string, channelId: string, messageId: string) {
  const row = await loadMessage(env, channelId, messageId);
  return (await hydrate(env, viewer, serverId, [row]))[0];
}

// -- Servers --------------------------------------------------------------

servers.get('/', async c => {
  const user = requireUser(c);
  const [list, unread, mentions, everyone] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT s.* FROM server_members sm JOIN servers s ON s.id = sm.server_id
        WHERE sm.user_id = ? ORDER BY sm.joined_at, s.id LIMIT ${MAX_JOINED}`).bind(user.id),
    c.env.DB.prepare(`SELECT c.server_id, MAX(COALESCE(c.last_message_id, '') > COALESCE(r.last_read_id, '')) AS unread
        FROM server_members sm JOIN channels c ON c.server_id = sm.server_id
        LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = sm.user_id
        WHERE sm.user_id = ? GROUP BY c.server_id`).bind(user.id),
    c.env.DB.prepare(`SELECT c.server_id, COUNT(*) AS n FROM channel_mentions m JOIN channels c ON c.id = m.channel_id
        LEFT JOIN channel_reads r ON r.channel_id = m.channel_id AND r.user_id = m.user_id
        WHERE m.user_id = ? AND m.message_id > COALESCE(r.last_read_id, '') GROUP BY c.server_id`).bind(user.id),
    c.env.DB.prepare(`SELECT c.server_id, COUNT(*) AS n FROM server_members sm JOIN channels c ON c.server_id = sm.server_id
        LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = sm.user_id
        JOIN channel_messages x ON x.channel_id = c.id AND x.mention_everyone = 1 AND x.deleted_at IS NULL
          AND x.id > COALESCE(r.last_read_id, '') AND x.author_id IS NOT sm.user_id
        WHERE sm.user_id = ? GROUP BY c.server_id`).bind(user.id),
  ]);
  const unreadBy = new Map((unread.results as { server_id: string; unread: number }[]).map(r => [r.server_id, Boolean(r.unread)]));
  const mentionBy = new Map<string, number>();
  for (const r of [...mentions.results, ...everyone.results] as { server_id: string; n: number }[])
    mentionBy.set(r.server_id, (mentionBy.get(r.server_id) ?? 0) + r.n);
  return c.json({
    items: (list.results as unknown as ServerRow[]).map(s => ({
      id: s.id,
      name: s.name,
      icon_url: iconUrl(s),
      member_count: s.member_count,
      owner_id: s.owner_id,
      unread: unreadBy.get(s.id) ?? false,
      mention_count: mentionBy.get(s.id) ?? 0,
    })),
  });
});

servers.post('/', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const name = str(input.name, MAX_SERVER_NAME);
  if (!name) fail(422, 'Give the server a name.');
  const description = str(input.description, MAX_DESCRIPTION);
  let iconId: string | null = null;
  if (typeof input.icon_media_id === 'string' && input.icon_media_id) {
    const [m] = await ownedReadyMedia(c.env, user.id, [input.icon_media_id]).catch(() => fail(422, 'The icon has not finished uploading.'));
    if (m.kind !== 'image') fail(422, 'The icon must be a photo.');
    iconId = m.id;
  }
  const counts = await c.env.DB.prepare(`SELECT (SELECT COUNT(*) FROM servers WHERE owner_id = ?1) AS owned,
      (SELECT COUNT(*) FROM server_members WHERE user_id = ?1) AS joined`).bind(user.id).first<{ owned: number; joined: number }>();
  if ((counts?.owned ?? 0) >= MAX_OWNED) fail(422, `You can own up to ${MAX_OWNED} servers.`);
  if ((counts?.joined ?? 0) >= MAX_JOINED) fail(422, `You can be in up to ${MAX_JOINED} servers.`);

  const now = Date.now();
  const id = newId(now), categoryId = newId(now), channelId = newId(now);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO servers (id, name, description, icon_media_id, owner_id, invite_code, member_count, structure_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).bind(id, name, description, iconId, user.id, inviteCode(), now, now),
    c.env.DB.prepare(`INSERT INTO server_roles (id, server_id, name, position, permissions, created_at) VALUES (?1, ?1, '@everyone', 0, 0, ?2)`)
      .bind(id, now),
    c.env.DB.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)').bind(id, user.id, now),
    c.env.DB.prepare('INSERT INTO server_presence (server_id, user_id, last_seen_at) VALUES (?, ?, ?)').bind(id, user.id, now),
    c.env.DB.prepare(`INSERT INTO channel_categories (id, server_id, name, position, created_at) VALUES (?, ?, 'Text channels', 0, ?)`)
      .bind(categoryId, id, now),
    c.env.DB.prepare(`INSERT INTO channels (id, server_id, category_id, name, topic, kind, position, created_at)
        VALUES (?, ?, ?, 'general', '', 'text', 0, ?)`).bind(channelId, id, categoryId, now),
  ]);
  const server = await c.env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first<ServerRow>();
  track(c, 'social_server_created', { server_id: id, has_icon: Boolean(iconId) });
  return c.json({ server: serverJson(server!), channel_id: channelId }, 201);
});

servers.get('/invite/:code', async c => {
  const user = requireUser(c);
  const s = await c.env.DB.prepare(`SELECT s.*, EXISTS (SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = ?1) AS is_member,
      EXISTS (SELECT 1 FROM server_bans WHERE server_id = s.id AND user_id = ?1) AS banned
      FROM servers s WHERE s.invite_code = ?2`).bind(user.id, c.req.param('code').toLowerCase())
    .first<ServerRow & { is_member: number; banned: number }>();
  if (!s) fail(404, 'This invite is invalid or has expired.');
  return c.json({
    server: { id: s.id, name: s.name, description: s.description, icon_url: iconUrl(s), member_count: s.member_count },
    is_member: Boolean(s.is_member),
    banned: Boolean(s.banned),
  });
});

servers.post('/join/:code', async c => {
  const user = requireUser(c);
  const s = await c.env.DB.prepare(`SELECT s.*, EXISTS (SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = ?1) AS is_member,
      EXISTS (SELECT 1 FROM server_bans WHERE server_id = s.id AND user_id = ?1) AS banned,
      (SELECT COUNT(*) FROM server_members WHERE user_id = ?1) AS joined
      FROM servers s WHERE s.invite_code = ?2`).bind(user.id, c.req.param('code').trim().toLowerCase())
    .first<ServerRow & { is_member: number; banned: number; joined: number }>();
  if (!s) fail(404, 'This invite is invalid or has expired.');
  if (s.banned) fail(403, 'You are banned from this server.');
  if (s.is_member) return c.json({ server: serverJson(s), joined: false });
  if (s.joined >= MAX_JOINED) fail(422, `You can be in up to ${MAX_JOINED} servers.`);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)').bind(s.id, user.id, now),
    recount(c.env, s.id),
    // New members start with everything read, so old @everyone messages don't count as mentions.
    c.env.DB.prepare(`INSERT OR REPLACE INTO channel_reads (channel_id, user_id, last_read_id)
        SELECT id, ?, last_message_id FROM channels WHERE server_id = ? AND last_message_id IS NOT NULL`).bind(user.id, s.id),
    c.env.DB.prepare('INSERT OR REPLACE INTO server_presence (server_id, user_id, last_seen_at) VALUES (?, ?, ?)').bind(s.id, user.id, now),
  ]);
  const server = await c.env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(s.id).first<ServerRow>();
  track(c, 'social_server_joined', { server_id: s.id, member_count: server?.member_count ?? null });
  return c.json({ server: serverJson(server!), joined: true });
});

servers.get('/:id', async c => {
  const user = requireUser(c);
  const id = c.req.param('id');
  const now = Date.now();
  const [, categories, channels, roles, online] = await c.env.DB.batch([
    presenceStatement(c.env, id, user.id, now),
    c.env.DB.prepare('SELECT * FROM channel_categories WHERE server_id = ? ORDER BY position, id').bind(id),
    channelStateStatement(c.env, id, user.id),
    c.env.DB.prepare(`SELECT r.*, (SELECT COUNT(*) FROM server_member_roles mr WHERE mr.role_id = r.id) AS member_count
        FROM server_roles r WHERE r.server_id = ? ORDER BY r.position DESC, r.id`).bind(id),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM server_presence WHERE server_id = ? AND last_seen_at > ?').bind(id, now - ONLINE_MS),
  ]);
  const a = await access(c.env, user.id, id);
  return c.json({
    server: serverJson(a.server),
    categories: (categories.results as unknown as CategoryRow[]).map(categoryJson),
    channels: (channels.results as unknown as ChannelStateRow[]).map(ch => channelJson(ch, channelState(ch))),
    roles: (roles.results as unknown as RoleRow[]).map(roleJson),
    me: {
      id: user.id,
      is_owner: a.isOwner,
      nickname: a.nickname,
      role_ids: a.roleIds,
      top_position: a.isOwner ? null : a.top,
      permissions: permsJson(a.perms),
    },
    online_count: (online.results[0] as { n: number }).n,
    limits: { max_body: MAX_BODY, slowmodes: SLOWMODES, reactions: REACTIONS },
  });
});

servers.patch('/:id', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'manage_server');
  const input = await body(c);
  const sets: string[] = [], values: unknown[] = [];
  if (input.name !== undefined) {
    const name = str(input.name, MAX_SERVER_NAME);
    if (!name) fail(422, 'Give the server a name.');
    sets.push('name = ?'); values.push(name);
  }
  if (input.description !== undefined) { sets.push('description = ?'); values.push(str(input.description, MAX_DESCRIPTION)); }
  if (input.icon_media_id !== undefined) {
    let iconId: string | null = null;
    if (typeof input.icon_media_id === 'string' && input.icon_media_id) {
      const [m] = await ownedReadyMedia(c.env, user.id, [input.icon_media_id]).catch(() => fail(422, 'The icon has not finished uploading.'));
      if (m.kind !== 'image') fail(422, 'The icon must be a photo.');
      iconId = m.id;
    }
    sets.push('icon_media_id = ?'); values.push(iconId);
  }
  if (sets.length) {
    const now = Date.now();
    await c.env.DB.prepare(`UPDATE servers SET ${sets.join(', ')}, structure_at = ? WHERE id = ?`).bind(...values, now, a.server.id).run();
  }
  const server = await c.env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(a.server.id).first<ServerRow>();
  return c.json({ server: serverJson(server!) });
});

servers.delete('/:id', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  if (!a.isOwner) fail(403, 'Only the owner can delete the server.');
  await c.env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(a.server.id).run();
  track(c, 'social_server_deleted', { server_id: a.server.id, member_count: a.server.member_count });
  return c.json({ ok: true });
});

servers.post('/:id/invite', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'manage_server');
  const code = inviteCode();
  await c.env.DB.prepare('UPDATE servers SET invite_code = ?, structure_at = ? WHERE id = ?').bind(code, Date.now(), a.server.id).run();
  return c.json({ invite_code: code });
});

servers.post('/:id/leave', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  if (a.isOwner) fail(422, 'Owners cannot leave. Delete the server instead.');
  await c.env.DB.batch(removeMember(c.env, a.server.id, user.id));
  track(c, 'social_server_left', { server_id: a.server.id });
  return c.json({ ok: true });
});

servers.post('/:id/reorder', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'manage_channels');
  const input = await body<{ categories?: unknown; channels?: unknown }>(c);
  const [cats, chans] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id FROM channel_categories WHERE server_id = ?').bind(a.server.id),
    c.env.DB.prepare('SELECT id FROM channels WHERE server_id = ?').bind(a.server.id),
  ]);
  const catIds = new Set((cats.results as { id: string }[]).map(r => r.id));
  const chanIds = new Set((chans.results as { id: string }[]).map(r => r.id));
  const statements: D1PreparedStatement[] = [];
  if (Array.isArray(input.categories)) {
    const order = input.categories.filter((x): x is string => typeof x === 'string' && catIds.has(x));
    statements.push(c.env.DB.prepare(`UPDATE channel_categories SET position = j.pos
        FROM (SELECT value AS id, key AS pos FROM json_each(?)) AS j WHERE channel_categories.id = j.id AND channel_categories.server_id = ?`)
      .bind(JSON.stringify(order), a.server.id));
  }
  if (Array.isArray(input.channels)) {
    const order = input.channels
      .filter((x): x is { id: string; category_id?: unknown } => Boolean(x) && typeof x === 'object' && chanIds.has((x as { id: string }).id))
      .map((x, i) => ({ id: x.id, pos: i, cat: typeof x.category_id === 'string' && catIds.has(x.category_id) ? x.category_id : null }));
    statements.push(c.env.DB.prepare(`UPDATE channels SET position = j.pos, category_id = j.cat
        FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.pos') AS pos, json_extract(value, '$.cat') AS cat
              FROM json_each(?)) AS j WHERE channels.id = j.id AND channels.server_id = ?`)
      .bind(JSON.stringify(order), a.server.id));
  }
  if (!statements.length) fail(422, 'Nothing to reorder.');
  statements.push(bump(c.env, a.server.id, Date.now()));
  await c.env.DB.batch(statements);
  return c.json({ ok: true });
});

// -- Members and bans -----------------------------------------------------

servers.get('/:id/members', async c => {
  const user = requireUser(c);
  const id = c.req.param('id');
  const now = Date.now();
  const [, members, memberRoles] = await c.env.DB.batch([
    presenceStatement(c.env, id, user.id, now),
    c.env.DB.prepare(`SELECT ${u('u')}, sm.nickname, sm.joined_at, p.last_seen_at FROM server_members sm
        JOIN users u ON u.id = sm.user_id
        LEFT JOIN server_presence p ON p.server_id = sm.server_id AND p.user_id = sm.user_id
        WHERE sm.server_id = ? ORDER BY sm.joined_at, sm.user_id LIMIT ${MAX_MEMBERS_LIST}`).bind(id),
    c.env.DB.prepare('SELECT user_id, role_id FROM server_member_roles WHERE server_id = ?').bind(id),
  ]);
  const a = await access(c.env, user.id, id);
  const rolesBy = new Map<string, string[]>();
  for (const r of memberRoles.results as { user_id: string; role_id: string }[]) {
    if (!rolesBy.has(r.user_id)) rolesBy.set(r.user_id, []);
    rolesBy.get(r.user_id)!.push(r.role_id);
  }
  const rows = members.results as unknown as (UserRow & { nickname: string | null; joined_at: number; last_seen_at: number | null })[];
  const items = rows.map(m => ({
    user: userCard(m),
    nickname: m.nickname,
    display_name: m.nickname || m.name,
    role_ids: rolesBy.get(m.id) ?? [],
    online: m.id === user.id || (m.last_seen_at ?? 0) > now - ONLINE_MS,
    is_owner: m.id === a.server.owner_id,
    joined_at: m.joined_at,
  }));
  return c.json({ items, online_count: items.filter(m => m.online).length, member_count: a.server.member_count });
});

servers.patch('/:id/members/:userId', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  const userId = c.req.param('userId') === 'me' ? user.id : c.req.param('userId');
  if (userId !== user.id) {
    need(a, 'manage_server');
    const t = await target(c.env, a.server.id, userId, a.server.owner_id);
    if (!t.member) fail(404, 'Member not found.');
    if (!a.isOwner) mustOutrank(a, t);
  }
  const input = await body(c);
  const nickname = str(input.nickname, MAX_NICKNAME) || null;
  const { meta } = await c.env.DB.prepare('UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?')
    .bind(nickname, a.server.id, userId).run();
  if (!meta.changes) fail(404, 'Member not found.');
  return c.json({ nickname });
});

servers.delete('/:id/members/:userId', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  const userId = c.req.param('userId');
  if (userId === user.id || userId === 'me') fail(422, 'Use Leave server instead.');
  need(a, 'kick_members');
  const t = await target(c.env, a.server.id, userId, a.server.owner_id);
  if (!t.member) fail(404, 'Member not found.');
  mustOutrank(a, t);
  await c.env.DB.batch(removeMember(c.env, a.server.id, userId));
  return c.json({ ok: true });
});

async function roleFor(env: Env, serverId: string, roleId: string): Promise<RoleRow> {
  const role = await env.DB.prepare('SELECT * FROM server_roles WHERE id = ? AND server_id = ?').bind(roleId, serverId).first<RoleRow>();
  if (!role) fail(404, 'Role not found.');
  return role;
}

/** Roles can only be managed below the viewer's highest role (the owner manages all). */
function mustManageRole(a: Access, role: RoleRow) {
  if (!a.isOwner && role.position >= a.top) fail(403, 'You can only manage roles below your highest role.');
}

async function memberRole(c: Ctx, add: boolean) {
  const user = requireUser(c);
  const a = await access(c.env, user.id, param(c, 'id'));
  need(a, 'manage_roles');
  const userId = param(c, 'userId') === 'me' ? user.id : param(c, 'userId');
  const role = await roleFor(c.env, a.server.id, param(c, 'roleId'));
  if (role.id === a.server.id) fail(422, 'Everyone has the @everyone role.');
  mustManageRole(a, role);
  const t = await target(c.env, a.server.id, userId, a.server.owner_id);
  if (!t.member) fail(404, 'Member not found.');
  if (userId !== user.id && !a.isOwner && !t.isOwner && t.top >= a.top) fail(403, 'You can only manage members below your highest role.');
  const now = Date.now();
  await c.env.DB.batch([
    add
      ? c.env.DB.prepare('INSERT OR IGNORE INTO server_member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').bind(a.server.id, userId, role.id)
      : c.env.DB.prepare('DELETE FROM server_member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?').bind(a.server.id, userId, role.id),
    bump(c.env, a.server.id, now),
  ]);
  return c.json({ ok: true });
}
servers.put('/:id/members/:userId/roles/:roleId', c => memberRole(c, true));
servers.delete('/:id/members/:userId/roles/:roleId', c => memberRole(c, false));

servers.get('/:id/bans', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'ban_members');
  const { results } = await c.env.DB.prepare(`SELECT ${u('u')}, b.reason, b.created_at AS banned_at FROM server_bans b
      JOIN users u ON u.id = b.user_id WHERE b.server_id = ? ORDER BY b.created_at DESC LIMIT 200`).bind(a.server.id)
    .all<UserRow & { reason: string; banned_at: number }>();
  return c.json({ items: results.map(r => ({ user: userCard(r), reason: r.reason, created_at: r.banned_at })) });
});

servers.put('/:id/bans/:userId', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'ban_members');
  const userId = c.req.param('userId');
  if (userId === user.id) fail(422, 'You cannot ban yourself.');
  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(userId).first();
  if (!exists) fail(404, 'Member not found.');
  const t = await target(c.env, a.server.id, userId, a.server.owner_id);
  if (t.member || t.isOwner) mustOutrank(a, t);
  const input = await body(c);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR REPLACE INTO server_bans (server_id, user_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(a.server.id, userId, user.id, str(input.reason, 200), Date.now()),
    ...removeMember(c.env, a.server.id, userId),
  ]);
  track(c, 'social_server_member_banned', { server_id: a.server.id, target_user_id: userId, has_reason: Boolean(str(input.reason, 200)) });
  return c.json({ ok: true });
});

servers.delete('/:id/bans/:userId', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'ban_members');
  await c.env.DB.prepare('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?').bind(a.server.id, c.req.param('userId')).run();
  return c.json({ ok: true });
});

// -- Roles ----------------------------------------------------------------

servers.post('/:id/roles/reorder', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'manage_roles');
  const input = await body<{ ids?: unknown }>(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM server_roles WHERE server_id = ?1 AND id != ?1').bind(a.server.id).all<RoleRow>();
  const ids = Array.isArray(input.ids) ? input.ids.filter((x): x is string => typeof x === 'string') : [];
  if (ids.length !== results.length || new Set(ids).size !== ids.length || !results.every(r => ids.includes(r.id)))
    fail(422, 'List every role once.');
  const next = new Map(ids.map((id, i) => [id, ids.length - i]));
  for (const r of results) {
    const pos = next.get(r.id)!;
    if (pos !== r.position && !a.isOwner && (r.position >= a.top || pos >= a.top))
      fail(403, 'You can only move roles below your highest role.');
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE server_roles SET position = j.pos
        FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS pos FROM json_each(?)) AS j
        WHERE server_roles.id = j.id AND server_roles.server_id = ?`).bind(JSON.stringify([...next]), a.server.id),
    bump(c.env, a.server.id, Date.now()),
  ]);
  return c.json({ ok: true });
});

servers.post('/:id/roles', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'manage_roles');
  const input = await body(c);
  const name = str(input.name, MAX_ROLE_NAME);
  if (!name) fail(422, 'Give the role a name.');
  if (name.toLowerCase() === '@everyone') fail(422, 'That name is taken.');
  const permissions = permissionBits(input.permissions);
  if (!a.isOwner && (permissions & ~a.perms)) fail(403, 'You cannot grant permissions you do not have.');
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM server_roles WHERE server_id = ?').bind(a.server.id).first<{ n: number }>();
  if ((count?.n ?? 0) > MAX_ROLES) fail(422, `Servers can have up to ${MAX_ROLES} roles.`);
  const now = Date.now();
  const id = newId(now);
  // New roles go to the bottom, just above @everyone.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE server_roles SET position = position + 1 WHERE server_id = ?1 AND id != ?1').bind(a.server.id),
    c.env.DB.prepare('INSERT INTO server_roles (id, server_id, name, position, permissions, created_at) VALUES (?, ?, ?, 1, ?, ?)')
      .bind(id, a.server.id, name, permissions, now),
    bump(c.env, a.server.id, now),
  ]);
  return c.json({ role: roleJson({ ...(await roleFor(c.env, a.server.id, id)), member_count: 0 }) }, 201);
});

servers.patch('/:id/roles/:roleId', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'manage_roles');
  const role = await roleFor(c.env, a.server.id, c.req.param('roleId'));
  mustManageRole(a, role);
  const input = await body(c);
  const sets: string[] = [], values: unknown[] = [];
  if (input.name !== undefined && role.id !== a.server.id) {
    const name = str(input.name, MAX_ROLE_NAME);
    if (!name || name.toLowerCase() === '@everyone') fail(422, 'Give the role a name.');
    sets.push('name = ?'); values.push(name);
  }
  if (input.permissions !== undefined) {
    const permissions = permissionBits(input.permissions);
    // Only the bits that change need to be ones the editor holds.
    if (!a.isOwner && ((permissions ^ role.permissions) & ~a.perms)) fail(403, 'You cannot grant permissions you do not have.');
    sets.push('permissions = ?'); values.push(permissions);
  }
  if (input.colour !== undefined) { sets.push('colour = ?'); values.push(str(input.colour, 20) || null); }
  if (sets.length) {
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE server_roles SET ${sets.join(', ')} WHERE id = ?`).bind(...values, role.id),
      bump(c.env, a.server.id, now),
    ]);
  }
  return c.json({ role: roleJson(await roleFor(c.env, a.server.id, role.id)) });
});

servers.delete('/:id/roles/:roleId', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'manage_roles');
  const role = await roleFor(c.env, a.server.id, c.req.param('roleId'));
  if (role.id === a.server.id) fail(422, 'The @everyone role cannot be deleted.');
  mustManageRole(a, role);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM server_roles WHERE id = ?').bind(role.id),
    c.env.DB.prepare('UPDATE server_roles SET position = position - 1 WHERE server_id = ?1 AND id != ?1 AND position > ?2').bind(a.server.id, role.position),
    bump(c.env, a.server.id, Date.now()),
  ]);
  return c.json({ ok: true });
});

// -- Channels and categories ----------------------------------------------

async function categoryFor(env: Env, serverId: string, value: unknown): Promise<string | null> {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail(422, 'Category not found.');
  const row = await env.DB.prepare('SELECT id FROM channel_categories WHERE id = ? AND server_id = ?').bind(value, serverId).first<{ id: string }>();
  if (!row) fail(404, 'Category not found.');
  return row.id;
}

function slowmode(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return SLOWMODES.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), 0);
}

servers.post('/:id/channels', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'manage_channels');
  const input = await body(c);
  const name = channelName(input.name);
  if (!name) fail(422, 'Give the channel a name.');
  const categoryId = await categoryFor(c.env, a.server.id, input.category_id);
  const kind = input.kind === 'announcement' ? 'announcement' : 'text';
  const stats = await c.env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(CASE WHEN category_id IS ?2 THEN position END), -1) AS last
      FROM channels WHERE server_id = ?1`).bind(a.server.id, categoryId).first<{ n: number; last: number }>();
  if ((stats?.n ?? 0) >= MAX_CHANNELS) fail(422, `Servers can have up to ${MAX_CHANNELS} channels.`);
  const now = Date.now();
  const id = newId(now);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO channels (id, server_id, category_id, name, topic, kind, position, slowmode_seconds, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, a.server.id, categoryId, name, str(input.topic, MAX_TOPIC), kind, (stats?.last ?? -1) + 1, slowmode(input.slowmode_seconds), now),
    bump(c.env, a.server.id, now),
  ]);
  const ch = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
  track(c, 'social_channel_created', { server_id: a.server.id, channel_id: id, kind });
  return c.json({ channel: channelJson(ch!) }, 201);
});

servers.patch('/:id/channels/:cid', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'), c.req.param('cid'));
  need(a, 'manage_channels');
  const input = await body(c);
  const sets: string[] = [], values: unknown[] = [];
  if (input.name !== undefined) {
    const name = channelName(input.name);
    if (!name) fail(422, 'Give the channel a name.');
    sets.push('name = ?'); values.push(name);
  }
  if (input.topic !== undefined) { sets.push('topic = ?'); values.push(str(input.topic, MAX_TOPIC)); }
  if (input.kind !== undefined) { sets.push('kind = ?'); values.push(input.kind === 'announcement' ? 'announcement' : 'text'); }
  if (input.slowmode_seconds !== undefined) { sets.push('slowmode_seconds = ?'); values.push(slowmode(input.slowmode_seconds)); }
  if (input.category_id !== undefined) { sets.push('category_id = ?'); values.push(await categoryFor(c.env, a.server.id, input.category_id)); }
  if (sets.length) {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).bind(...values, a.channel!.id),
      bump(c.env, a.server.id, Date.now()),
    ]);
  }
  const ch = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(a.channel!.id).first<ChannelRow>();
  return c.json({ channel: channelJson(ch!) });
});

servers.delete('/:id/channels/:cid', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'), c.req.param('cid'));
  need(a, 'manage_channels');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(a.channel!.id),
    bump(c.env, a.server.id, Date.now()),
  ]);
  return c.json({ ok: true });
});

servers.post('/:id/categories', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'manage_channels');
  const input = await body(c);
  const name = str(input.name, MAX_CATEGORY_NAME);
  if (!name) fail(422, 'Give the category a name.');
  const stats = await c.env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS last FROM channel_categories WHERE server_id = ?')
    .bind(a.server.id).first<{ n: number; last: number }>();
  if ((stats?.n ?? 0) >= MAX_CATEGORIES) fail(422, `Servers can have up to ${MAX_CATEGORIES} categories.`);
  const now = Date.now();
  const category: CategoryRow = { id: newId(now), server_id: a.server.id, name, position: (stats?.last ?? -1) + 1, created_at: now };
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO channel_categories (id, server_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(category.id, category.server_id, name, category.position, now),
    bump(c.env, a.server.id, now),
  ]);
  return c.json({ category: categoryJson(category) }, 201);
});

servers.patch('/:id/categories/:catId', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'manage_channels');
  const input = await body(c);
  const name = str(input.name, MAX_CATEGORY_NAME);
  if (!name) fail(422, 'Give the category a name.');
  const [res] = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE channel_categories SET name = ? WHERE id = ? AND server_id = ?').bind(name, c.req.param('catId'), a.server.id),
    bump(c.env, a.server.id, Date.now()),
  ]);
  if (!res.meta.changes) fail(404, 'Category not found.');
  const row = await c.env.DB.prepare('SELECT * FROM channel_categories WHERE id = ?').bind(c.req.param('catId')).first<CategoryRow>();
  return c.json({ category: categoryJson(row!) });
});

servers.delete('/:id/categories/:catId', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'));
  need(a, 'manage_channels');
  const [res] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM channel_categories WHERE id = ? AND server_id = ?').bind(c.req.param('catId'), a.server.id),
    bump(c.env, a.server.id, Date.now()),
  ]);
  if (!res.meta.changes) fail(404, 'Category not found.');
  return c.json({ ok: true });
});

// -- Messages -------------------------------------------------------------

servers.get('/:id/channels/:cid/messages', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'), c.req.param('cid'));
  const size = limit(c, 50, 50);
  const before = c.req.query('before') || null;
  const now = Date.now();
  const { results } = await c.env.DB.prepare(`SELECT * FROM channel_messages WHERE channel_id = ? AND deleted_at IS NULL
      ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`).bind(a.channel!.id, ...(before ? [before] : []), size + 1).all<MessageRow>();
  const rows = results.slice(0, size);
  return c.json({
    items: await hydrate(c.env, user, a.server.id, rows),
    next: results.length > size ? rows[rows.length - 1].id : null,
    // Pass as `since` to the first poll, so changes made from here on are not missed.
    now,
  });
});

servers.post('/:id/channels/:cid/messages', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'), c.req.param('cid'));
  const ch = a.channel!;
  if (!canPost(a, ch)) fail(403, 'Only moderators can post in this channel.');
  const input = await body<{ body?: unknown; reply_to_id?: unknown; media_id?: unknown }>(c);
  const text = typeof input.body === 'string' ? input.body.trim() : '';
  if ([...text].length > MAX_BODY) fail(422, `Messages are limited to ${MAX_BODY.toLocaleString('en-AU')} characters.`);

  const now = Date.now();
  // Slowmode: one message per N seconds per person, except for moderators.
  if (ch.slowmode_seconds > 0 && !can(a, 'manage_messages') && !can(a, 'manage_channels')) {
    const last = await c.env.DB.prepare(`SELECT created_at FROM channel_messages WHERE channel_id = ? AND author_id = ?
        ORDER BY id DESC LIMIT 1`).bind(ch.id, user.id).first<{ created_at: number }>();
    const wait = last ? Math.ceil((last.created_at + ch.slowmode_seconds * 1000 - now) / 1000) : 0;
    if (wait > 0) fail(429, `Slowmode is on. Wait ${wait} ${wait === 1 ? 'second' : 'seconds'}.`);
  }

  let media: MediaRow | null = null;
  if (input.media_id != null && input.media_id !== '') {
    if (typeof input.media_id !== 'string') fail(422, 'Attachment not found.');
    [media] = await ownedReadyMedia(c.env, user.id, [input.media_id]).catch(() => fail(422, 'The attachment has not finished uploading.'));
    if (media.kind !== 'image') fail(422, 'Only photos can be attached.');
  }
  if (!text && !media) fail(422, 'Write a message first.');

  let replyAuthor: string | null = null;
  let replyTo: string | null = null;
  if (typeof input.reply_to_id === 'string' && input.reply_to_id) {
    const parent = await c.env.DB.prepare('SELECT id, author_id FROM channel_messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL')
      .bind(input.reply_to_id, ch.id).first<{ id: string; author_id: string | null }>();
    if (!parent) fail(404, 'The message you replied to was deleted.');
    replyTo = parent.id;
    replyAuthor = parent.author_id;
  }

  const everyone = mentionsEveryone(text) && can(a, 'mention_everyone');
  const handles = mentionHandles(text).slice(0, MAX_MENTIONS);
  let mentioned: { id: string }[] = [];
  if (handles.length || replyAuthor) {
    const { results } = await c.env.DB.prepare(`SELECT u.id FROM server_members sm JOIN users u ON u.id = sm.user_id
        WHERE sm.server_id = ? AND sm.user_id != ? AND (u.handle IN (${handles.length ? placeholders(handles.length) : "''"}) OR u.id = ?)`)
      .bind(a.server.id, user.id, ...handles, replyAuthor ?? '').all<{ id: string }>();
    mentioned = results;
  }

  const id = newId(now);
  const who = a.nickname || user.name;
  const where = `#${ch.name} (${a.server.name})`;
  const note = `${who} mentioned you in ${where}: ${excerpt(text || 'Photo', 80)}`;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO channel_messages (id, channel_id, author_id, body, reply_to_id, media_id, mention_everyone, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, ch.id, user.id, text, replyTo, media?.id ?? null, everyone ? 1 : 0, now),
    c.env.DB.prepare('UPDATE channels SET last_message_id = ? WHERE id = ? AND (last_message_id IS NULL OR last_message_id < ?)').bind(id, ch.id, id),
    c.env.DB.prepare(`INSERT INTO channel_reads (channel_id, user_id, last_read_id) VALUES (?, ?, ?)
        ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`).bind(ch.id, user.id, id),
    c.env.DB.prepare('DELETE FROM channel_typing WHERE channel_id = ? AND user_id = ?').bind(ch.id, user.id),
    // @everyone is counted from the message's flag, so only explicit mentions get rows.
    ...(everyone ? [] : mentioned).map(m => c.env.DB.prepare('INSERT OR IGNORE INTO channel_mentions (message_id, channel_id, user_id) VALUES (?, ?, ?)')
      .bind(id, ch.id, m.id)),
  ];
  if (everyone) {
    // One statement for the whole server instead of a notify() per member (capped; D1 free-plan writes).
    statements.push(c.env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, post_id, group_id, body, link, created_at)
        SELECT substr(?1, 1, 9) || substr(lower(hex(randomblob(4))), 1, 7), sm.user_id, ?2, 'mention', NULL, NULL, ?3, ?6, ?4
        FROM server_members sm WHERE sm.server_id = ?5 AND sm.user_id != ?2 ORDER BY sm.joined_at DESC LIMIT ${MAX_EVERYONE_NOTIFY}`)
      .bind(id, user.id, note, now, a.server.id, `/servers/${a.server.id}/${ch.id}`));
  } else {
    for (const m of mentioned) {
      const s = notifyStatement(c.env, { userId: m.id, actorId: user.id, type: 'mention', postId: null, body: note, link: `/servers/${a.server.id}/${ch.id}` }, now);
      if (s) statements.push(s);
    }
  }
  await c.env.DB.batch(statements);
  track(c, 'social_channel_message_sent', { server_id: a.server.id, channel_id: ch.id, message_id: id, reply: Boolean(replyTo), has_photo: Boolean(media), mention_count: everyone ? null : mentioned.length, mention_everyone: everyone, length: [...text].length });
  const row: MessageRow = {
    id, channel_id: ch.id, author_id: user.id, body: text, reply_to_id: replyTo, media_id: media?.id ?? null,
    mention_everyone: everyone ? 1 : 0, pinned: 0, pinned_at: null, edited_at: null, deleted_at: null, updated_at: null, created_at: now,
  };
  const [message] = await hydrate(c.env, user, a.server.id, [row]);
  return c.json({ message }, 201);
});

servers.patch('/:id/channels/:cid/messages/:mid', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'), c.req.param('cid'));
  const row = await loadMessage(c.env, a.channel!.id, c.req.param('mid'));
  if (row.author_id !== user.id) fail(403, 'You can only edit your own messages.');
  const input = await body(c);
  const text = typeof input.body === 'string' ? input.body.trim() : '';
  if ([...text].length > MAX_BODY) fail(422, `Messages are limited to ${MAX_BODY.toLocaleString('en-AU')} characters.`);
  if (!text && !row.media_id) fail(422, 'Write a message first.');
  if (text !== row.body) {
    const now = Date.now();
    await c.env.DB.prepare('UPDATE channel_messages SET body = ?, edited_at = ?, updated_at = ? WHERE id = ?').bind(text, now, now, row.id).run();
  }
  return c.json({ message: await oneMessage(c.env, user, a.server.id, a.channel!.id, row.id) });
});

servers.delete('/:id/channels/:cid/messages/:mid', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'), c.req.param('cid'));
  const row = await loadMessage(c.env, a.channel!.id, c.req.param('mid'));
  if (row.author_id !== user.id) need(a, 'manage_messages');
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE channel_messages SET body = '', media_id = NULL, pinned = 0, pinned_at = NULL, mention_everyone = 0,
        deleted_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, row.id),
    c.env.DB.prepare('DELETE FROM channel_reactions WHERE message_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM channel_mentions WHERE message_id = ?').bind(row.id),
  ]);
  return c.json({ ok: true });
});

async function pin(c: Ctx, on: boolean) {
  const user = requireUser(c);
  const a = await access(c.env, user.id, param(c, 'id'), param(c, 'cid'));
  need(a, 'manage_messages');
  const row = await loadMessage(c.env, a.channel!.id, param(c, 'mid'));
  if (Boolean(row.pinned) !== on) {
    if (on) {
      const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE channel_id = ? AND pinned = 1')
        .bind(a.channel!.id).first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_PINS) fail(422, `Channels can have up to ${MAX_PINS} pinned messages.`);
    }
    const now = Date.now();
    await c.env.DB.prepare('UPDATE channel_messages SET pinned = ?, pinned_at = ?, updated_at = ? WHERE id = ?')
      .bind(on ? 1 : 0, on ? now : null, now, row.id).run();
  }
  return c.json({ message: await oneMessage(c.env, user, a.server.id, a.channel!.id, row.id) });
}
servers.put('/:id/channels/:cid/messages/:mid/pin', c => pin(c, true));
servers.delete('/:id/channels/:cid/messages/:mid/pin', c => pin(c, false));

async function react(c: Ctx, on: boolean) {
  const user = requireUser(c);
  const word = param(c, 'reaction').toLowerCase();
  if (!(REACTIONS as readonly string[]).includes(word)) fail(422, 'Unknown reaction.');
  const a = await access(c.env, user.id, param(c, 'id'), param(c, 'cid'));
  const row = await loadMessage(c.env, a.channel!.id, param(c, 'mid'));
  const now = Date.now();
  await c.env.DB.batch([
    on
      ? c.env.DB.prepare('INSERT OR IGNORE INTO channel_reactions (message_id, user_id, reaction, created_at) VALUES (?, ?, ?, ?)').bind(row.id, user.id, word, now)
      : c.env.DB.prepare('DELETE FROM channel_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?').bind(row.id, user.id, word),
    c.env.DB.prepare('UPDATE channel_messages SET updated_at = ? WHERE id = ?').bind(now, row.id),
  ]);
  track(c, on ? 'social_channel_reaction_added' : 'social_channel_reaction_removed', { server_id: a.server.id, channel_id: a.channel!.id, message_id: row.id, reaction: word });
  return c.json({ message: await oneMessage(c.env, user, a.server.id, a.channel!.id, row.id) });
}
servers.put('/:id/channels/:cid/messages/:mid/reactions/:reaction', c => react(c, true));
servers.delete('/:id/channels/:cid/messages/:mid/reactions/:reaction', c => react(c, false));

servers.get('/:id/channels/:cid/pins', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'), c.req.param('cid'));
  const { results } = await c.env.DB.prepare(`SELECT * FROM channel_messages WHERE channel_id = ? AND pinned = 1 AND deleted_at IS NULL
      ORDER BY pinned_at DESC LIMIT ${MAX_PINS}`).bind(a.channel!.id).all<MessageRow>();
  return c.json({ items: await hydrate(c.env, user, a.server.id, results) });
});

servers.post('/:id/channels/:cid/read', async c => {
  const user = requireUser(c);
  const serverId = c.req.param('id'), channelId = c.req.param('cid');
  const { meta } = await readStatement(c.env, serverId, channelId, user.id).run();
  if (!meta.changes) {
    // Nothing moved: either already read, or not a member / no such channel.
    await access(c.env, user.id, serverId, channelId);
  }
  return c.json({ ok: true });
});

servers.post('/:id/channels/:cid/typing', async c => {
  const user = requireUser(c);
  const a = await access(c.env, user.id, c.req.param('id'), c.req.param('cid'));
  if (!canPost(a, a.channel!)) fail(403, 'Only moderators can post in this channel.');
  const until = Date.now() + TYPING_MS;
  await c.env.DB.prepare(`INSERT INTO channel_typing (channel_id, user_id, until) VALUES (?, ?, ?)
      ON CONFLICT (channel_id, user_id) DO UPDATE SET until = excluded.until`).bind(a.channel!.id, user.id, until).run();
  return c.json({ ok: true, until });
});

servers.get('/:id/channels/:cid/poll', async c => {
  const user = requireUser(c);
  const serverId = c.req.param('id'), channelId = c.req.param('cid');
  const now = Date.now();
  const after = c.req.query('after') || '';
  const sinceRaw = Number(c.req.query('since'));
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw - CLOCK_SLACK_MS : now;
  const markRead = c.req.query('read') === '1';

  const statements: D1PreparedStatement[] = [
    // Membership check and channel details (topic changes show up without a reload).
    c.env.DB.prepare(`SELECT c.*, s.structure_at, s.member_count FROM channels c JOIN servers s ON s.id = c.server_id
        JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = ? WHERE c.id = ? AND c.server_id = ?`)
      .bind(user.id, channelId, serverId),
    presenceStatement(c.env, serverId, user.id, now),
    c.env.DB.prepare('SELECT * FROM channel_messages WHERE channel_id = ? AND id > ? AND deleted_at IS NULL ORDER BY id LIMIT 51')
      .bind(channelId, after),
    c.env.DB.prepare(`SELECT * FROM channel_messages WHERE channel_id = ? AND updated_at > ? AND id <= ?
        ORDER BY updated_at LIMIT 50`).bind(channelId, since, after),
    c.env.DB.prepare(`SELECT ${u('u')}, sm.nickname FROM channel_typing t JOIN users u ON u.id = t.user_id
        JOIN server_members sm ON sm.server_id = ? AND sm.user_id = t.user_id
        WHERE t.channel_id = ? AND t.until > ? AND t.user_id != ? LIMIT 10`).bind(serverId, channelId, now, user.id),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM server_presence WHERE server_id = ? AND last_seen_at > ?').bind(serverId, now - ONLINE_MS),
  ];
  if (markRead) statements.push(readStatement(c.env, serverId, channelId, user.id));
  statements.push(channelStateStatement(c.env, serverId, user.id));
  const results = await c.env.DB.batch(statements);
  const [ctxRes, , newRes, changedRes, typingRes, onlineRes] = results;
  const channelsRes = results[results.length - 1];

  const ch = ctxRes.results[0] as (ChannelRow & { structure_at: number; member_count: number }) | undefined;
  if (!ch) fail(404, 'Channel not found.');
  const fresh = (newRes.results as unknown as MessageRow[]).slice(0, 50);
  const changed = changedRes.results as unknown as MessageRow[];
  const deleted = changed.filter(m => m.deleted_at).map(m => m.id);
  const [items, updated] = await Promise.all([
    hydrate(c.env, user, serverId, fresh),
    hydrate(c.env, user, serverId, changed.filter(m => !m.deleted_at)),
  ]);
  // More than a page of changes: resume from the last one next time (the client re-applies duplicates).
  const changedFull = changed.length >= 50;
  return c.json({
    now: changedFull ? changed[changed.length - 1].updated_at! + CLOCK_SLACK_MS : now,
    items,
    more: newRes.results.length > 50 || changedFull,
    updated,
    deleted,
    typing: (typingRes.results as unknown as (UserRow & { nickname: string | null })[]).map(memberCard),
    online_count: (onlineRes.results[0] as { n: number }).n,
    member_count: ch.member_count,
    structure_at: ch.structure_at,
    channel: channelJson(ch),
    channels: (channelsRes.results as unknown as ChannelStateRow[]).map(x => ({ id: x.id, ...channelState(x) })),
  });
});

export default servers;
