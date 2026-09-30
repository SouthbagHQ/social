// Direct messages (Messenger / Instagram DMs) and the Southbag Support bot. Mounted at /api/messages.
//
//   GET    /api/messages?cursor               conversations, most recent first → { items, next, unread_count }
//   POST   /api/messages                      { handles[], title?, body?, media_id?, post_id? } → find-or-create
//   POST   /api/messages/support              find-or-create the viewer's Southbag Support conversation
//   GET    /api/messages/:id?before=<id>      { conversation, items (oldest → newest), next }
//   GET    /api/messages/:id/poll?after=<id>  { items, read, title } — new messages since `after`
//   POST   /api/messages/:id                  { body?, media_id?, post_id? } → { message, reply? }
//   POST   /api/messages/:id/read             marks the conversation read for the viewer
//   PATCH  /api/messages/:id                  { title } (group chats)
//   DELETE /api/messages/:id/members/me       leave a group chat
//
// Unread = conversations where `conversations.last_message_at > conversation_members.last_read_at`
// (see routes/me.ts), so every write below keeps those two columns right.
//
// Free plan: there are no WebSockets or Durable Objects here, so the client polls. `/poll` is one
// round trip (a D1 batch of an indexed membership lookup and an indexed range scan on
// messages_conversation) and only hydrates when something is new. The client polls every ~5 s while a
// conversation is open and visible, backs off to 20–30 s after a minute of silence, pauses while the
// tab is hidden and never polls the Support conversation (its replies arrive with the send). One
// person chatting for an hour at the fast rate is ~720 requests, so the 100k requests/day free limit
// covers a few hundred hours of active chatting a day; if that stops being enough, slow the
// intervals down before reaching for anything that isn't on the free plan.

import { Hono } from 'hono';
import type { AppEnv, Env, SessionUser } from '../env';
import { body, cursor, fail, limit, placeholders, requireUser, str } from '../lib/http';
import { newId, sha256 } from '../lib/ids';
import { mediaJson, ownedReadyMedia, type MediaJson, type MediaRow } from '../lib/media';
import { hydrate, loadVisiblePost, visibleTo, type PostJson, type PostRow } from '../lib/posts';
import { userCard, userCardColumns, userCards, type UserCard, type UserRow } from '../lib/users';

const messages = new Hono<AppEnv>();

export const MAX_MESSAGE = 2000;
export const MAX_MEMBERS = 20; // people in a group chat, including its creator
const MAX_TITLE = 60;
const SUPPORT_TITLE = 'Southbag Support';

interface ConversationRow {
  id: string;
  title: string | null;
  is_group: number;
  created_by: string | null;
  last_message_at: number;
  created_at: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  body: string;
  media_id: string | null;
  post_id: string | null;
  created_at: number;
}

export interface MessageJson {
  id: string;
  /** null = system message (Southbag Support, or "Alice left the chat" in a group). */
  sender: UserCard | null;
  body: string;
  media: MediaJson | null;
  post: PostJson | null;
  /** A post was shared but the viewer can't see it (deleted, private, or its author blocked them). */
  post_unavailable: boolean;
  created_at: number;
}

const u = (col: string) => userCardColumns.split(', ').map(c => `${col}.${c}`).join(', ');
const formerCustomer = (id: string): UserCard => ({ id, handle: 'deleted', name: 'Former customer', avatar_url: null, verified: false });

/** Support conversations get a stable id per person, so find-or-create is a primary-key lookup. */
const supportId = async (userId: string) => `support-${(await sha256(`southbag-support:${userId}`)).slice(0, 22)}`;
const isSupport = (id: string) => id.startsWith('support-');

// ── Southbag Support's entire personality ────────────────────────────────

const WELCOME = 'Oh great, another one. Type your message below I guess.';

const CANNED = [
  'Your complaint has been noted and ignored.',
  'Estimated response: never.',
  'SUPPORT TICKET #8675309 has been opened. Est. response: Never.',
  'Please hold. *Loud audible sigh*',
  'Have you tried visiting a branch?',
  'Kevin has already reviewed your message. He does not need to respond.',
  'This conversation is being recorded for quality, training and leverage purposes.',
  'Have you tried turning your expectations off and on again?',
  'I have forwarded this to the relevant department. The relevant department is Kevin.',
  'Your message is important to us. Not very important. But important.',
  'We are experiencing higher than usual volumes of you.',
  'Unfortunately that cannot be done online. Please schedule an in-person meeting at your local Southbag branch.',
  'I understand your frustration. I do not share it.',
  'Fee assessed: $7.00 — Kevin’s time.',
  'Please describe the problem in more detail so I can ignore it more precisely.',
  'Your satisfaction is not guaranteed. It is not even likely.',
  'I have marked this as resolved. It was not resolved.',
  'Most problems can be solved by not having them. Please try that first.',
  'A human will be with you shortly. “Shortly” is defined in SB-ACT-2018 §14 as 3–10 business years.',
  'Kevin is watching. That is not a support response. It is a status update.',
  'Connection lost. Error code: CUSTOMER_TOO_ANNOYING. I am still here, unfortunately.',
  'Your message has been added to The Pile. Do not ask whether The Pile is physical.',
  'Your account is in good standing. That is all I am permitted to say.',
  'Please rate this conversation from 1 to 1.',
  'I have reset your password. You did not ask. You are welcome.',
  'Your feedback will be used to train the next version of me, who will also ignore you.',
  'Southbag Support is closed on public holidays, weekends, weekdays and in Canberra.',
  'I have escalated this. It came straight back down.',
  'Thank you for your patience. We have plenty of it now. It is yours.',
  'Your request has been received, stamped and placed somewhere on Floor 3. Southbag has no Floor 3.',
];

const KEYWORDS: [RegExp, string[]][] = [
  [/\bkevin\b/i, ['Kevin is aware. Kevin was aware before you typed it.', 'Please do not ask where Kevin is. Fee assessed: $3.50 — Asking where Kevin is.']],
  [/\b(human|agent|person|real|manager|supervisor)\b/i, ['You are talking to a human. Probably. Please hold. *Loud audible sigh*', 'My manager is Kevin. He does not take calls.']],
  [/\b(refund|money|fee|fees|charge|charged|bill|cost)\b/i, ['Refunds are processed within 3–10 business decades.', 'Fee assessed: $12.00 — Policy curiosity.']],
  [/\b2019\b/, ['There was no 2019 incident. This conversation has been flagged.']],
  [/canberra/i, ['That area is Reserved. Canberra Adjacency Levy applied.']],
  [/blahaj|shark/i, ['Blahaj is prohibited. Support staff do not love Blahaj. Please stop asking.']],
  [/\b(delete|deletion|privacy|data)\b/i, ['Deletion is advisory. Your data is retained permanently, for your convenience.']],
  [/\b(hi|hello|hey|g'?day)\b/i, ['Hello. Your greeting has been logged.', 'Oh great, another one.']],
  [/\b(thanks|thank you|cheers)\b/i, ['You are welcome. Nothing was done.']],
];

function supportReply(message: string): string {
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
  const matched = KEYWORDS.find(([re]) => re.test(message));
  if (matched && Math.random() < 0.7) return pick(matched[1]);
  const line = pick(CANNED);
  // Fresh ticket numbers now and then; #8675309 stays the house favourite.
  return line.includes('#8675309') && Math.random() < 0.5
    ? line.replace('8675309', String(1000000 + Math.floor(Math.random() * 8999999)))
    : line;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Loads the conversation if the viewer is a member (plus their last_read_at), otherwise 404s. */
async function memberOf(env: Env, viewerId: string, id: string): Promise<ConversationRow & { last_read_at: number }> {
  const row = await env.DB.prepare(`SELECT c.*, cm.last_read_at FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? WHERE c.id = ?`)
    .bind(viewerId, id).first<ConversationRow & { last_read_at: number }>();
  if (!row) fail(404, 'Conversation not found. Or it exists and you are not in it. Kevin is.');
  return row;
}

/** Other members (cards) and everyone's last_read_at, for one conversation. */
async function membersOf(env: Env, id: string) {
  const { results } = await env.DB.prepare(`SELECT cm.last_read_at, ${u('u')} FROM conversation_members cm
      JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? ORDER BY cm.joined_at`)
    .bind(id).all<UserRow & { last_read_at: number }>();
  return results;
}

function conversationJson(conv: ConversationRow, viewerId: string, members: (UserRow & { last_read_at: number })[]) {
  const others = members.filter(m => m.id !== viewerId);
  const me = members.find(m => m.id === viewerId);
  return {
    id: conv.id,
    title: isSupport(conv.id) ? SUPPORT_TITLE : conv.title,
    is_group: Boolean(conv.is_group),
    is_support: isSupport(conv.id),
    members: others.map(userCard),
    member_count: members.length,
    created_by: conv.created_by,
    created_at: conv.created_at,
    last_message_at: conv.last_message_at,
    last_read_at: me?.last_read_at ?? 0,
    /** Other members' read positions, for "Seen by …". */
    read: Object.fromEntries(others.map(m => [m.id, m.last_read_at])),
  };
}

async function loadConversationJson(env: Env, viewerId: string, id: string) {
  const [conv, members] = await Promise.all([
    env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first<ConversationRow>(),
    membersOf(env, id),
  ]);
  if (!conv) fail(404, 'Conversation not found.');
  return conversationJson(conv, viewerId, members);
}

/** Message rows → JSON, batching senders, files and shared posts (which respect post visibility). */
async function hydrateMessages(env: Env, viewer: SessionUser, rows: MessageRow[]): Promise<MessageJson[]> {
  if (!rows.length) return [];
  const mediaIds = [...new Set(rows.map(m => m.media_id).filter((x): x is string => Boolean(x)))];
  const postIds = [...new Set(rows.map(m => m.post_id).filter((x): x is string => Boolean(x)))];
  const [users, mediaRes, posts] = await Promise.all([
    userCards(env, rows.map(m => m.sender_id || '')),
    mediaIds.length
      ? env.DB.prepare(`SELECT * FROM media WHERE status = 'ready' AND id IN (${placeholders(mediaIds.length)})`).bind(...mediaIds).all<MediaRow>()
      : Promise.resolve({ results: [] as MediaRow[] }),
    postIds.length
      ? (async () => {
          const v = visibleTo(viewer.id);
          const { results } = await env.DB.prepare(`SELECT p.* FROM posts p WHERE p.id IN (${placeholders(postIds.length)})
              AND p.deleted_at IS NULL AND ${v.sql}`).bind(...postIds, ...v.params).all<PostRow>();
          return new Map((await hydrate(env, viewer, results)).map(p => [p.id, p]));
        })()
      : Promise.resolve(new Map<string, PostJson>()),
  ]);
  const media = new Map(mediaRes.results.map(m => [m.id, mediaJson(m)]));
  return rows.map(m => {
    const post = m.post_id ? posts.get(m.post_id) ?? null : null;
    return {
      id: m.id,
      sender: m.sender_id ? users.get(m.sender_id) ?? formerCustomer(m.sender_id) : null,
      body: m.body,
      media: m.media_id ? media.get(m.media_id) ?? null : null,
      post,
      post_unavailable: Boolean(m.post_id && !post),
      created_at: m.created_at,
    };
  });
}

const systemMessage = (env: Env, conversationId: string, text: string, now: number) =>
  env.DB.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, NULL, ?, ?)')
    .bind(newId(now), conversationId, text, now);

const bumpConversation = (env: Env, conversationId: string, now: number) =>
  env.DB.prepare('UPDATE conversations SET last_message_at = MAX(last_message_at, ?) WHERE id = ?').bind(now, conversationId);

interface SendInput { body?: unknown; media_id?: unknown; post_id?: unknown }

/** Whether a send request carries anything at all. */
const hasContent = (input: SendInput) =>
  Boolean((typeof input.body === 'string' && input.body.trim()) || input.media_id || input.post_id);

/**
 * Validates and stores one message from `user` in `conv` (membership already checked), keeping
 * last_message_at and the sender's last_read_at right. In the Support conversation it also stores
 * the bot's reply in the same batch.
 */
async function send(env: Env, user: SessionUser, conv: ConversationRow, input: SendInput): Promise<{ message: MessageJson; reply: MessageJson | null }> {
  const text = typeof input.body === 'string' ? input.body.trim() : '';
  if ([...text].length > MAX_MESSAGE)
    fail(422, `Messages are limited to ${MAX_MESSAGE.toLocaleString('en-AU')} characters. Kevin counted. His count is authoritative.`);

  let media: MediaRow | null = null;
  if (input.media_id != null && input.media_id !== '') {
    if (typeof input.media_id !== 'string') fail(422, 'That attachment is not a file.');
    try {
      [media] = await ownedReadyMedia(env, user.id, [input.media_id]);
    } catch {
      fail(422, 'That file is not yours, or it has not finished uploading.');
    }
  }
  let post: PostRow | null = null;
  if (input.post_id != null && input.post_id !== '') {
    if (typeof input.post_id !== 'string') fail(422, 'That is not a post.');
    post = await loadVisiblePost(env, user.id, input.post_id);
    if (!post || post.deleted_at) fail(404, 'That post has left the building.');
  }
  if (!text && !media && !post)
    fail(422, 'Kevin does not accept blank messages. He does accept fees. Fee assessed: $2.00 — Kevin tax.');

  const support = isSupport(conv.id);
  if (!conv.is_group && !support) {
    const blocked = await env.DB.prepare(`SELECT b.blocker_id FROM conversation_members cm JOIN blocks b
        ON (b.blocker_id = cm.user_id AND b.blocked_id = ?1) OR (b.blocker_id = ?1 AND b.blocked_id = cm.user_id)
        WHERE cm.conversation_id = ?2 AND cm.user_id != ?1 LIMIT 1`).bind(user.id, conv.id).first<{ blocker_id: string }>();
    if (blocked) fail(403, blocked.blocker_id === user.id
      ? 'You blocked this person. Unblock them before messaging them. Kevin will not pass notes.'
      : 'This person is not accepting your messages. Kevin still is.');
  }

  const now = Date.now();
  const id = newId(now);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, media_id, post_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, conv.id, user.id, text, media?.id ?? null, post?.id ?? null, now),
  ];
  let reply: MessageJson | null = null;
  let readAt = now;
  if (support) {
    // The reply is 1 ms younger so it sorts after the message it is ignoring.
    const at = now + 1;
    const replyText = supportReply(text);
    const replyId = newId(at);
    statements.push(env.DB.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, NULL, ?, ?)')
      .bind(replyId, conv.id, replyText, at));
    reply = { id: replyId, sender: null, body: replyText, media: null, post: null, post_unavailable: false, created_at: at };
    readAt = at;
  }
  statements.push(
    bumpConversation(env, conv.id, readAt),
    env.DB.prepare('UPDATE conversation_members SET last_read_at = MAX(last_read_at, ?) WHERE conversation_id = ? AND user_id = ?')
      .bind(readAt, conv.id, user.id),
  );
  await env.DB.batch(statements);

  return {
    message: {
      id,
      sender: userCard(user),
      body: text,
      media: media ? mediaJson(media) : null,
      post: post ? (await hydrate(env, user, [post]))[0] : null,
      post_unavailable: false,
      created_at: now,
    },
    reply,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────

messages.get('/', async c => {
  const user = requireUser(c);
  const size = limit(c, 20, 50);
  // Cursor: "<last_message_at>.<id>" of the last conversation on the previous page.
  const cur = cursor(c);
  const dot = cur ? cur.indexOf('.') : -1;
  const after = cur && dot > 0 ? { at: Number(cur.slice(0, dot)), id: cur.slice(dot + 1) } : null;

  // Empty 1:1s someone else started (they clicked "Message" and said nothing) stay hidden.
  const [{ results: rows }, unread] = await Promise.all([
    c.env.DB.prepare(`SELECT c.*, cm.last_read_at FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.user_id = ?1
          AND (c.is_group = 1 OR c.created_by = ?1 OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id))
          ${after ? 'AND (c.last_message_at < ?2 OR (c.last_message_at = ?2 AND c.id < ?3))' : ''}
        ORDER BY c.last_message_at DESC, c.id DESC LIMIT ${size + 1}`)
      .bind(user.id, ...(after ? [after.at, after.id] : [])).all<ConversationRow & { last_read_at: number }>(),
    after ? Promise.resolve(null) : c.env.DB.prepare(`SELECT COUNT(*) AS n FROM conversation_members cm
        JOIN conversations cv ON cv.id = cm.conversation_id WHERE cm.user_id = ? AND cv.last_message_at > cm.last_read_at`)
      .bind(user.id).first<{ n: number }>(),
  ]);
  const convs = rows.slice(0, size);
  const ids = convs.map(r => r.id);
  const members = new Map<string, UserCard[]>();
  const last = new Map<string, MessageRow>();
  if (ids.length) {
    const inIds = placeholders(ids.length);
    const [memberRes, lastRes] = await Promise.all([
      c.env.DB.prepare(`SELECT cm.conversation_id, ${u('u')} FROM conversation_members cm JOIN users u ON u.id = cm.user_id
          WHERE cm.conversation_id IN (${inIds}) AND cm.user_id != ? ORDER BY cm.joined_at`)
        .bind(...ids, user.id).all<UserRow & { conversation_id: string }>(),
      // Newest message per conversation: one indexed lookup each via messages_conversation.
      c.env.DB.prepare(`SELECT m.* FROM conversations c JOIN messages m
          ON m.id = (SELECT id FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1)
          WHERE c.id IN (${inIds})`).bind(...ids).all<MessageRow>(),
    ]);
    for (const m of memberRes.results) {
      if (!members.has(m.conversation_id)) members.set(m.conversation_id, []);
      members.get(m.conversation_id)!.push(userCard(m));
    }
    for (const m of lastRes.results) last.set(m.conversation_id, m);
  }

  const items = convs.map(conv => {
    const m = last.get(conv.id);
    return {
      id: conv.id,
      title: isSupport(conv.id) ? SUPPORT_TITLE : conv.title,
      is_group: Boolean(conv.is_group),
      is_support: isSupport(conv.id),
      members: members.get(conv.id) ?? [],
      last_message: m ? {
        body: [...m.body].slice(0, 140).join(''),
        sender_id: m.sender_id,
        created_at: m.created_at,
        kind: m.post_id ? 'post' : m.media_id ? 'media' : 'text',
      } : null,
      unread: conv.last_message_at > conv.last_read_at,
      last_message_at: conv.last_message_at,
    };
  });
  const lastConv = convs[convs.length - 1];
  return c.json({
    items,
    next: rows.length > size && lastConv ? `${lastConv.last_message_at}.${lastConv.id}` : null,
    ...(unread ? { unread_count: unread.n } : {}),
  });
});

messages.post('/', async c => {
  const user = requireUser(c);
  const input = await body<SendInput & { handles?: unknown; title?: unknown }>(c);
  const handles = Array.isArray(input.handles)
    ? [...new Set(input.handles.filter((h): h is string => typeof h === 'string')
        .map(h => h.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))]
    : [];
  if (!handles.length) fail(422, 'Pick at least one person to message. Kevin does not count.');
  if (handles.length > MAX_MEMBERS)
    fail(422, `Group chats are limited to ${MAX_MEMBERS} people, including you. Kevin is not counted. Kevin is never counted.`);

  const { results: found } = await c.env.DB.prepare(`SELECT ${userCardColumns} FROM users WHERE handle IN (${placeholders(handles.length)})`)
    .bind(...handles).all<UserRow>();
  const missing = handles.find(h => !found.some(f => f.handle.toLowerCase() === h));
  if (missing) fail(404, `Nobody called @${missing} exists. Kevin checked.`);
  const others = found.filter(f => f.id !== user.id);
  if (!others.length) fail(422, 'You cannot message yourself. Southbag does not offer therapy.');
  if (others.length + 1 > MAX_MEMBERS)
    fail(422, `Group chats are limited to ${MAX_MEMBERS} people, including you. Kevin is not counted.`);

  const otherIds = others.map(o => o.id);
  const inOthers = placeholders(otherIds.length);
  const { results: blocks } = await c.env.DB.prepare(`SELECT blocker_id, blocked_id FROM blocks
      WHERE (blocker_id IN (${inOthers}) AND blocked_id = ?) OR (blocker_id = ? AND blocked_id IN (${inOthers}))`)
    .bind(...otherIds, user.id, user.id, ...otherIds).all<{ blocker_id: string; blocked_id: string }>();
  const blockedBy = blocks.find(b => b.blocked_id === user.id);
  if (blockedBy) fail(403, `@${others.find(o => o.id === blockedBy.blocker_id)!.handle} is not accepting your messages. Kevin still is.`);
  const iBlocked = blocks.find(b => b.blocker_id === user.id);
  if (iBlocked) fail(403, `You blocked @${others.find(o => o.id === iBlocked.blocked_id)!.handle}. Unblock them first.`);

  const now = Date.now();
  let conv: ConversationRow | null = null;
  let created = false;
  const withMessage = hasContent(input);

  if (others.length === 1) {
    conv = await c.env.DB.prepare(`SELECT c.* FROM conversation_members a
        JOIN conversation_members b ON b.conversation_id = a.conversation_id AND b.user_id = ?
        JOIN conversations c ON c.id = a.conversation_id
        WHERE a.user_id = ? AND c.is_group = 0 ORDER BY c.created_at LIMIT 1`)
      .bind(others[0].id, user.id).first<ConversationRow>();
  }
  if (!conv) {
    created = true;
    const isGroup = others.length > 1;
    conv = {
      id: newId(now),
      title: isGroup ? str(input.title, MAX_TITLE) || null : null,
      is_group: isGroup ? 1 : 0,
      created_by: user.id,
      last_message_at: now,
      created_at: now,
    };
    // A new group is news for everyone in it (unread); an empty 1:1 is not news for anyone yet.
    const othersReadAt = isGroup || withMessage ? 0 : now;
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare('INSERT INTO conversations (id, title, is_group, created_by, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(conv.id, conv.title, conv.is_group, user.id, now, now),
      c.env.DB.prepare('INSERT INTO conversation_members (conversation_id, user_id, last_read_at, joined_at) VALUES (?, ?, ?, ?)')
        .bind(conv.id, user.id, now, now),
      ...others.map(o => c.env.DB.prepare('INSERT INTO conversation_members (conversation_id, user_id, last_read_at, joined_at) VALUES (?, ?, ?, ?)')
        .bind(conv!.id, o.id, othersReadAt, now)),
    ];
    if (isGroup) statements.push(systemMessage(c.env, conv.id, `${user.name} started a group chat. Kevin has been added automatically. He will not appear in the member list.`, now));
    await c.env.DB.batch(statements);
  }

  const sent = withMessage ? await send(c.env, user, conv, input) : null;
  const conversation = await loadConversationJson(c.env, user.id, conv.id);
  return c.json({ conversation, created, ...(sent ? { message: sent.message } : {}) }, created ? 201 : 200);
});

messages.post('/support', async c => {
  const user = requireUser(c);
  const id = await supportId(user.id);
  const existing = await c.env.DB.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .bind(id, user.id).first();
  if (!existing) {
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT OR IGNORE INTO conversations (id, title, is_group, created_by, last_message_at, created_at)
          VALUES (?, ?, 0, NULL, ?, ?)`).bind(id, SUPPORT_TITLE, now, now),
      c.env.DB.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, last_read_at, joined_at)
          VALUES (?, ?, ?, ?)`).bind(id, user.id, now, now),
      c.env.DB.prepare(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
          SELECT ?, ?, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ?)`)
        .bind(newId(now), id, WELCOME, now, id),
    ]);
  }
  return c.json({ conversation: await loadConversationJson(c.env, user.id, id), created: !existing }, existing ? 200 : 201);
});

messages.get('/:id', async c => {
  const user = requireUser(c);
  const id = c.req.param('id');
  const size = limit(c, 30, 50);
  const before = c.req.query('before') || null;
  const [conv, members, page] = await Promise.all([
    memberOf(c.env, user.id, id),
    membersOf(c.env, id),
    c.env.DB.prepare(`SELECT * FROM messages WHERE conversation_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`)
      .bind(id, ...(before ? [before] : []), size + 1).all<MessageRow>(),
  ]);
  const rows = page.results.slice(0, size).reverse();
  const items = await hydrateMessages(c.env, user, rows);
  return c.json({
    conversation: { ...conversationJson(conv, user.id, members), last_read_at: conv.last_read_at },
    items,
    next: page.results.length > size ? rows[0].id : null,
  });
});

messages.get('/:id/poll', async c => {
  const user = requireUser(c);
  const id = c.req.param('id');
  const after = c.req.query('after') || '';
  // One round trip: members (membership check + read positions + title) and anything newer than `after`.
  const [membersRes, newRes] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT cm.user_id, cm.last_read_at, c.title FROM conversation_members cm
        JOIN conversations c ON c.id = cm.conversation_id WHERE cm.conversation_id = ?`).bind(id),
    c.env.DB.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT 51').bind(id, after),
  ]);
  const members = membersRes.results as { user_id: string; last_read_at: number; title: string | null }[];
  if (!members.some(m => m.user_id === user.id)) fail(404, 'Conversation not found. Or it exists and you are not in it. Kevin is.');
  const rows = (newRes.results as unknown as MessageRow[]).slice(0, 50);
  return c.json({
    items: await hydrateMessages(c.env, user, rows),
    more: newRes.results.length > 50,
    read: Object.fromEntries(members.filter(m => m.user_id !== user.id).map(m => [m.user_id, m.last_read_at])),
    title: isSupport(id) ? SUPPORT_TITLE : members[0]?.title ?? null,
  });
});

messages.post('/:id', async c => {
  const user = requireUser(c);
  const conv = await memberOf(c.env, user.id, c.req.param('id'));
  const sent = await send(c.env, user, conv, await body<SendInput>(c));
  return c.json(sent, 201);
});

messages.post('/:id/read', async c => {
  const user = requireUser(c);
  const id = c.req.param('id');
  // Never behind last_message_at, so a clock difference between Workers can't leave it "unread".
  const { meta } = await c.env.DB.prepare(`UPDATE conversation_members
      SET last_read_at = MAX(last_read_at, ?, (SELECT last_message_at FROM conversations WHERE id = ?))
      WHERE conversation_id = ? AND user_id = ?`).bind(Date.now(), id, id, user.id).run();
  if (!meta.changes) fail(404, 'Conversation not found.');
  return c.json({ ok: true });
});

messages.patch('/:id', async c => {
  const user = requireUser(c);
  const conv = await memberOf(c.env, user.id, c.req.param('id'));
  if (!conv.is_group) fail(422, 'Only group chats have titles. One-to-one conversations are titled by Kevin.');
  const input = await body(c);
  const title = str(input.title, MAX_TITLE) || null;
  const now = Date.now();
  const note = title ? `${user.name} renamed the chat to “${title}”. The old name is retained.` : `${user.name} removed the chat name. It has been retained anyway.`;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE conversations SET title = ? WHERE id = ?').bind(title, conv.id),
    systemMessage(c.env, conv.id, note, now),
    bumpConversation(c.env, conv.id, now),
    c.env.DB.prepare('UPDATE conversation_members SET last_read_at = MAX(last_read_at, ?) WHERE conversation_id = ? AND user_id = ?').bind(now, conv.id, user.id),
  ]);
  return c.json({ conversation: await loadConversationJson(c.env, user.id, conv.id) });
});

messages.delete('/:id/members/me', async c => {
  const user = requireUser(c);
  const conv = await memberOf(c.env, user.id, c.req.param('id'));
  if (isSupport(conv.id)) fail(422, 'Southbag Support cannot be left. It can only be ignored, which is what it does to you.');
  if (!conv.is_group) fail(422, 'One-to-one conversations cannot be left. They can only be ignored. All messages are retained.');
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').bind(conv.id, user.id),
    systemMessage(c.env, conv.id, `${user.name} left the chat. Their messages are retained.`, now),
    bumpConversation(c.env, conv.id, now),
  ]);
  return c.json({ ok: true });
});

export default messages;
