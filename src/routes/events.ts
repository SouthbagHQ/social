// Events (Facebook / Meetup style). Mounted at /api/events.
//
//   GET    /api/events                    ?tab=upcoming|going|hosting|past&group=<slug>&cursor -> { items: EventJson[], next }
//   POST   /api/events                    { title, description?, starts_at, ends_at?, timezone?, location_name?,
//                                          location_address?, online_url?, cover_media_id?, privacy?, group_id?,
//                                          capacity?, cohosts?: [handle] } -> { event }
//   GET    /api/events/:id                -> { event: EventJson & { hosts, attendees }, viewer }
//   PATCH  /api/events/:id                hosts: any of the create fields (not group_id) -> { event }
//   DELETE /api/events/:id                main host: cancels (the page stays, marked cancelled) -> { event }
//   PUT    /api/events/:id/rsvp           { status: going|interested|declined } -> { rsvp, going_count, interested_count }
//   DELETE /api/events/:id/rsvp           -> same with rsvp null
//   GET    /api/events/:id/attendees      ?status=going|interested|declined&cursor -> { items: [{ user, status, created_at }], next }
//   POST   /api/events/:id/invite         { handles: [handle] } -> { invited, already }
//   GET    /api/events/:id/comments       ?cursor -> { items: CommentJson[], next }   (newest first)
//   POST   /api/events/:id/comments       { body } -> { comment }
//   DELETE /api/events/:id/comments/:cid  author or hosts
//   GET    /api/events/:id/calendar.ics   iCalendar download (no sign-in needed for public events)
//
// EventJson: { id, title, description, starts_at, ends_at, timezone, location_name, location_address,
//   online_url, cover_url, privacy, capacity, going_count, interested_count, comment_count, is_full,
//   cancelled, cancelled_at, created_at, host: UserCard, group: { id, slug, name } | null,
//   viewer_rsvp: going|interested|declined|null, viewer_invited }
// viewer (detail only): { rsvp, invited, role: host|cohost|null, can_edit, can_cancel, can_invite, can_comment }
// CommentJson: { id, body, created_at, author: UserCard, can_delete }
//
// Who can see an event: its hosts, people invited to it, people who have replied to it, and
//   public  everyone (a public event in a private group is shown as a group event)
//   friends the main host's friends
//   group   members of the event's group
//   invite  nobody else
// Nobody sees events from someone they have blocked or who has blocked them.
//
// Reminders: sendEventReminders() runs from the hourly cron in src/index.ts and notifies
// "going" people once about events starting in the next 24 hours.

import { Hono } from 'hono';
import type { AppEnv, Ctx, Env, SessionUser } from '../env';
import { body, fail, limit, placeholders, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { getMedia } from '../lib/media';
import { notifyStatement, type NotificationType } from '../lib/notify';
import { userCard, userCardColumns, userCards, type UserCard, type UserRow } from '../lib/users';

const events = new Hono<AppEnv>();

type Privacy = 'public' | 'friends' | 'group' | 'invite';
type Rsvp = 'going' | 'interested' | 'declined';
type Tab = 'upcoming' | 'going' | 'hosting' | 'past';

interface EventRow {
  id: string;
  host_id: string;
  group_id: string | null;
  title: string;
  description: string;
  starts_at: number;
  ends_at: number | null;
  timezone: string;
  location_name: string;
  location_address: string;
  online_url: string;
  cover_media_id: string | null;
  privacy: Privacy;
  capacity: number | null;
  going_count: number;
  interested_count: number;
  comment_count: number;
  cancelled_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ListRow extends EventRow {
  viewer_rsvp: Rsvp | null;
  viewer_invited: number;
}

interface GroupRef { id: string; slug: string; name: string }

const MAX_TITLE = 100;
const MAX_DESCRIPTION = 5000;
const MAX_COMMENT = 2000;
const MAX_COHOSTS = 5;
const MAX_INVITES = 20;
const MAX_LENGTH_MS = 30 * 86400000;
/** Open-ended events count as running for three hours. */
const OPEN_ENDED_MS = 3 * 3600000;
const END_SQL = (e = 'e') => `COALESCE(${e}.ends_at, ${e}.starts_at + ${OPEN_ENDED_MS})`;
const PRIVACIES: Privacy[] = ['public', 'friends', 'group', 'invite'];
const STATUSES: Rsvp[] = ['going', 'interested', 'declined'];
/** How many people a cancellation notice goes to (free-plan write limits). */
const NOTIFY_LIMIT = 200;

// ── JSON ─────────────────────────────────────────────────────────────────

const eventJson = (e: EventRow, host: UserCard | null, group: GroupRef | null, viewerRsvp: Rsvp | null = null, invited = false) => ({
  id: e.id,
  title: e.title,
  description: e.description,
  starts_at: e.starts_at,
  ends_at: e.ends_at,
  timezone: e.timezone,
  location_name: e.location_name,
  location_address: e.location_address,
  online_url: e.online_url,
  cover_url: e.cover_media_id ? `/media/${e.cover_media_id}` : null,
  privacy: e.privacy,
  capacity: e.capacity,
  going_count: e.going_count,
  interested_count: e.interested_count,
  comment_count: e.comment_count,
  is_full: e.capacity != null && e.going_count >= e.capacity,
  cancelled: Boolean(e.cancelled_at),
  cancelled_at: e.cancelled_at,
  created_at: e.created_at,
  host,
  group,
  viewer_rsvp: viewerRsvp,
  viewer_invited: invited,
});

// ── Visibility ───────────────────────────────────────────────────────────

/** SQL condition (on alias `e`) for events the viewer may see. */
function visibleSql(viewerId: string | null, e = 'e'): { sql: string; params: string[] } {
  const publicGroup = `EXISTS (SELECT 1 FROM groups g WHERE g.id = ${e}.group_id AND g.privacy = 'public')`;
  if (!viewerId) return { sql: `(${e}.privacy = 'public' AND (${e}.group_id IS NULL OR ${publicGroup}))`, params: [] };
  const member = `EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = ${e}.group_id AND gm.user_id = ? AND gm.role != 'pending')`;
  return {
    sql: `(NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${e}.host_id AND b.blocked_id = ?) OR (b.blocker_id = ? AND b.blocked_id = ${e}.host_id))
      AND (${e}.host_id = ?
        OR EXISTS (SELECT 1 FROM event_hosts eh WHERE eh.event_id = ${e}.id AND eh.user_id = ?)
        OR EXISTS (SELECT 1 FROM event_invites ei WHERE ei.event_id = ${e}.id AND ei.user_id = ?)
        OR EXISTS (SELECT 1 FROM event_rsvps er WHERE er.event_id = ${e}.id AND er.user_id = ?)
        OR (${e}.privacy = 'public' AND (${e}.group_id IS NULL OR ${publicGroup} OR ${member}))
        OR (${e}.privacy = 'friends' AND EXISTS (SELECT 1 FROM friendships fr WHERE fr.status = 'accepted'
              AND ((fr.requester_id = ? AND fr.addressee_id = ${e}.host_id) OR (fr.addressee_id = ? AND fr.requester_id = ${e}.host_id))))
        OR (${e}.privacy = 'group' AND ${member})))`,
    params: Array(10).fill(viewerId),
  };
}

interface Loaded {
  event: EventRow;
  user: SessionUser | null;
  group: (GroupRef & { privacy: string }) | null;
  rsvp: Rsvp | null;
  invited: boolean;
  role: 'host' | 'cohost' | null;
  groupRole: string | null;
}

/** The event from `:id` if the viewer may see it, with the viewer's relationship to it; otherwise a 404. */
async function load(c: Ctx): Promise<Loaded> {
  const user = c.get('user');
  const id = c.req.param('id');
  const v = user?.id ?? '';
  const row = await c.env.DB.prepare(`SELECT e.*, g.slug AS g_slug, g.name AS g_name, g.privacy AS g_privacy,
      (SELECT status FROM event_rsvps WHERE event_id = e.id AND user_id = ?1) AS v_rsvp,
      EXISTS (SELECT 1 FROM event_invites WHERE event_id = e.id AND user_id = ?1) AS v_invited,
      EXISTS (SELECT 1 FROM event_hosts WHERE event_id = e.id AND user_id = ?1) AS v_cohost,
      (SELECT role FROM group_members WHERE group_id = e.group_id AND user_id = ?1) AS v_group_role,
      EXISTS (SELECT 1 FROM friendships WHERE status = 'accepted'
        AND ((requester_id = ?1 AND addressee_id = e.host_id) OR (addressee_id = ?1 AND requester_id = e.host_id))) AS v_friend,
      EXISTS (SELECT 1 FROM blocks WHERE (blocker_id = e.host_id AND blocked_id = ?1) OR (blocker_id = ?1 AND blocked_id = e.host_id)) AS v_blocked
    FROM events e LEFT JOIN groups g ON g.id = e.group_id WHERE e.id = ?2`)
    .bind(v, id).first<EventRow & {
      g_slug: string | null; g_name: string | null; g_privacy: string | null; v_rsvp: Rsvp | null; v_invited: number;
      v_cohost: number; v_group_role: string | null; v_friend: number; v_blocked: number;
    }>();
  if (!row) fail(404, 'Event not found.');
  const { g_slug, g_name, g_privacy, v_rsvp, v_invited, v_cohost, v_group_role, v_friend, v_blocked, ...event } = row;
  const role = user && event.host_id === user.id ? 'host' : user && v_cohost ? 'cohost' : null;
  const member = Boolean(v_group_role && v_group_role !== 'pending');
  const visible = role !== null || (user && !v_blocked && (
    v_invited || v_rsvp
    || (event.privacy === 'public' && (!event.group_id || g_privacy === 'public' || member))
    || (event.privacy === 'friends' && v_friend)
    || (event.privacy === 'group' && member)))
    || (!user && event.privacy === 'public' && (!event.group_id || g_privacy === 'public'));
  if (!visible || (user && v_blocked && role === null)) fail(404, 'Event not found.');
  return {
    event, user,
    group: event.group_id && g_slug ? { id: event.group_id, slug: g_slug, name: g_name!, privacy: g_privacy! } : null,
    rsvp: user ? v_rsvp : null,
    invited: Boolean(v_invited),
    role,
    groupRole: v_group_role,
  };
}

const groupRef = (g: Loaded['group']): GroupRef | null => (g ? { id: g.id, slug: g.slug, name: g.name } : null);
const hasEnded = (e: EventRow, now = Date.now()) => (e.ends_at ?? e.starts_at + OPEN_ENDED_MS) < now;
const canInvite = (l: Loaded) => l.role !== null || (l.event.privacy === 'public' && Boolean(l.user));

// ── Input ────────────────────────────────────────────────────────────────

function validTitle(value: unknown): string {
  const title = (typeof value === 'string' ? value.trim() : '').replace(/\s+/g, ' ');
  if (!title) fail(422, 'Give the event a title.');
  if ([...title].length > MAX_TITLE) fail(422, `Titles are limited to ${MAX_TITLE} characters.`);
  return title;
}

function validDescription(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if ([...text].length > MAX_DESCRIPTION) fail(422, `Descriptions are limited to ${MAX_DESCRIPTION} characters.`);
  return text;
}

function validTime(value: unknown, label: string): number {
  const ms = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms < 946684800000 || ms > 4102444800000) fail(422, `Enter a valid ${label} time.`);
  return Math.round(ms);
}

function validTimezone(value: unknown): string {
  const tz = str(value, 64);
  if (!tz) return 'Australia/Sydney';
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return tz;
  } catch {
    fail(422, 'Unknown time zone.');
  }
}

function validUrl(value: unknown): string {
  const text = str(value, 500);
  if (!text) return '';
  let url: URL;
  try { url = new URL(text); } catch { fail(422, 'Online links must start with https://'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(422, 'Online links must start with https://');
  return url.href;
}

function validCapacity(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100000) fail(422, 'Capacity must be a whole number from 1 to 100000.');
  return n;
}

const validPrivacy = (value: unknown): Privacy => (PRIVACIES.includes(value as Privacy) ? value as Privacy : 'public');

/** A media id the host may use as a cover (their own ready image), or null to clear. */
async function coverId(env: Env, userId: string, value: unknown): Promise<string | null> {
  if (value === null || value === '' || value === undefined) return null;
  const file = typeof value === 'string' ? await getMedia(env, value) : null;
  if (!file || file.owner_id !== userId || file.kind !== 'image' || file.status !== 'ready') fail(422, 'Upload an image first.');
  return file.id;
}

/** Co-host handles -> user ids (people who exist and have no block with the host). */
async function cohostIds(env: Env, hostId: string, value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) return [];
  const handles = [...new Set(value.map(v => str(v, 40).replace(/^@/, '').toLowerCase()).filter(Boolean))];
  if (!handles.length) return [];
  if (handles.length > MAX_COHOSTS) fail(422, `Events can have up to ${MAX_COHOSTS} co-hosts.`);
  const { results } = await env.DB.prepare(`SELECT u.id, u.handle FROM users u WHERE u.handle IN (${placeholders(handles.length)})
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = ?) OR (b.blocker_id = ? AND b.blocked_id = u.id))`)
    .bind(...handles, hostId, hostId).all<{ id: string; handle: string }>();
  const found = new Set(results.map(r => r.handle.toLowerCase()));
  const missing = handles.find(h => !found.has(h));
  if (missing) fail(404, `No one called @${missing}.`);
  return results.map(r => r.id).filter(id => id !== hostId);
}

interface Fields {
  title: string;
  description: string;
  starts_at: number;
  ends_at: number | null;
  timezone: string;
  location_name: string;
  location_address: string;
  online_url: string;
  cover_media_id: string | null;
  privacy: Privacy;
  capacity: number | null;
}

function checkTimes(starts: number, ends: number | null) {
  if (ends !== null && ends <= starts) fail(422, 'The event has to end after it starts.');
  if (ends !== null && ends - starts > MAX_LENGTH_MS) fail(422, 'Events can last up to 30 days.');
}

/** Coerces privacy so that a private group's events never become public. */
function groupPrivacy(privacy: Privacy, group: { privacy: string } | null): Privacy {
  if (privacy === 'group' && !group) fail(422, 'Pick a group for a group-only event.');
  if (privacy === 'public' && group?.privacy === 'private') return 'group';
  return privacy;
}

// ── Listings ─────────────────────────────────────────────────────────────

/** Cursor "<starts_at>.<id>". */
function parseCursor(value: string | undefined): { at: number; id: string } | null {
  const m = value?.match(/^(\d+)\.([0-9a-z]+)$/);
  return m ? { at: Number(m[1]), id: m[2] } : null;
}

async function hydrateList(env: Env, rows: ListRow[]) {
  const groupIds = [...new Set(rows.map(r => r.group_id).filter((x): x is string => Boolean(x)))];
  const [hosts, groupsRes] = await Promise.all([
    userCards(env, rows.map(r => r.host_id)),
    groupIds.length
      ? env.DB.prepare(`SELECT id, slug, name FROM groups WHERE id IN (${placeholders(groupIds.length)})`).bind(...groupIds).all<GroupRef>()
      : Promise.resolve({ results: [] as GroupRef[] }),
  ]);
  const groups = new Map(groupsRes.results.map(g => [g.id, g]));
  return rows.map(({ viewer_rsvp, viewer_invited, ...e }) =>
    eventJson(e, hosts.get(e.host_id) ?? null, e.group_id ? groups.get(e.group_id) ?? null : null, viewer_rsvp, Boolean(viewer_invited)));
}

events.get('/', async c => {
  const user = c.get('user');
  const requested = c.req.query('tab');
  const tab: Tab = requested === 'going' || requested === 'hosting' || requested === 'past' ? requested : 'upcoming';
  const size = limit(c, 20, 50);
  const after = parseCursor(c.req.query('cursor'));
  const now = Date.now();
  if (!user && tab !== 'upcoming') return c.json({ items: [], next: null });

  const where: string[] = [];
  const params: unknown[] = [];
  const v = visibleSql(user?.id ?? null);
  where.push(v.sql);
  params.push(...v.params);

  const groupSlug = c.req.query('group');
  if (groupSlug) {
    const group = await c.env.DB.prepare('SELECT id FROM groups WHERE slug = ?').bind(groupSlug).first<{ id: string }>();
    if (!group) fail(404, 'Group not found.');
    where.push('e.group_id = ?');
    params.push(group.id);
  }

  const past = tab === 'past';
  if (tab === 'upcoming') {
    where.push(`e.cancelled_at IS NULL AND ${END_SQL()} >= ?`);
    params.push(now);
  } else if (tab === 'going') {
    where.push(`${END_SQL()} >= ? AND EXISTS (SELECT 1 FROM event_rsvps r WHERE r.event_id = e.id AND r.user_id = ? AND r.status = 'going')`);
    params.push(now, user!.id);
  } else if (tab === 'hosting') {
    where.push(`${END_SQL()} >= ? AND (e.host_id = ? OR EXISTS (SELECT 1 FROM event_hosts h WHERE h.event_id = e.id AND h.user_id = ?))`);
    params.push(now, user!.id, user!.id);
  } else {
    where.push(`${END_SQL()} < ? AND (e.host_id = ? OR EXISTS (SELECT 1 FROM event_hosts h WHERE h.event_id = e.id AND h.user_id = ?)
      OR EXISTS (SELECT 1 FROM event_rsvps r WHERE r.event_id = e.id AND r.user_id = ? AND r.status IN ('going', 'interested')))`);
    params.push(now, user!.id, user!.id, user!.id);
  }
  if (after) {
    where.push(past ? '(e.starts_at < ? OR (e.starts_at = ? AND e.id < ?))' : '(e.starts_at > ? OR (e.starts_at = ? AND e.id > ?))');
    params.push(after.at, after.at, after.id);
  }

  const viewerCols = user
    ? `(SELECT status FROM event_rsvps WHERE event_id = e.id AND user_id = ?) AS viewer_rsvp,
       EXISTS (SELECT 1 FROM event_invites WHERE event_id = e.id AND user_id = ?) AS viewer_invited`
    : 'NULL AS viewer_rsvp, 0 AS viewer_invited';
  const { results } = await c.env.DB.prepare(`SELECT e.*, ${viewerCols} FROM events e
      WHERE ${where.join(' AND ')}
      ORDER BY e.starts_at ${past ? 'DESC' : 'ASC'}, e.id ${past ? 'DESC' : 'ASC'} LIMIT ?`)
    .bind(...(user ? [user.id, user.id] : []), ...params, size + 1).all<ListRow>();
  const rows = results.slice(0, size);
  const last = rows[rows.length - 1];
  return c.json({
    items: await hydrateList(c.env, rows),
    next: results.length > size && last ? `${last.starts_at}.${last.id}` : null,
  });
});

// ── Create ───────────────────────────────────────────────────────────────

events.post('/', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const title = validTitle(input.title);
  const description = validDescription(input.description);
  const starts = validTime(input.starts_at, 'start');
  const ends = input.ends_at === null || input.ends_at === undefined || input.ends_at === '' ? null : validTime(input.ends_at, 'end');
  checkTimes(starts, ends);
  const now = Date.now();
  if (starts < now - 60000) fail(422, 'Pick a start time in the future.');

  let group: { id: string; privacy: string } | null = null;
  if (input.group_id) {
    const ref = str(input.group_id, 60);
    group = await c.env.DB.prepare(`SELECT g.id, g.privacy FROM groups g JOIN group_members gm ON gm.group_id = g.id
        WHERE (g.id = ?1 OR g.slug = ?1) AND gm.user_id = ?2 AND gm.role != 'pending'`)
      .bind(ref, user.id).first<{ id: string; privacy: string }>();
    if (!group) fail(403, 'You are not a member of that group.');
  }
  const privacy = groupPrivacy(validPrivacy(input.privacy), group);
  const fields: Fields = {
    title, description, starts_at: starts, ends_at: ends,
    timezone: validTimezone(input.timezone),
    location_name: str(input.location_name, 120),
    location_address: str(input.location_address, 200),
    online_url: validUrl(input.online_url),
    cover_media_id: await coverId(c.env, user.id, input.cover_media_id),
    privacy,
    capacity: validCapacity(input.capacity),
  };
  const cohosts = await cohostIds(c.env, user.id, input.cohosts);

  const id = newId(now);
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO events (id, host_id, group_id, title, description, starts_at, ends_at, timezone, location_name,
        location_address, online_url, cover_media_id, privacy, capacity, going_count, interested_count, comment_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`)
      .bind(id, user.id, group?.id ?? null, fields.title, fields.description, fields.starts_at, fields.ends_at, fields.timezone,
        fields.location_name, fields.location_address, fields.online_url, fields.cover_media_id, fields.privacy, fields.capacity, now, now),
    // The host is going.
    c.env.DB.prepare(`INSERT INTO event_rsvps (event_id, user_id, status, created_at, updated_at) VALUES (?, ?, 'going', ?, ?)`)
      .bind(id, user.id, now, now),
  ];
  for (const cohost of cohosts) {
    statements.push(c.env.DB.prepare('INSERT OR IGNORE INTO event_hosts (event_id, user_id, created_at) VALUES (?, ?, ?)').bind(id, cohost, now));
    const note = notifyStatement(c.env, { userId: cohost, actorId: user.id, type: 'event_host' as NotificationType,
      body: `${user.name} added you as a host of "${fields.title}".` }, now);
    if (note) statements.push(note);
  }
  await c.env.DB.batch(statements);
  return c.json({ event: await detail(c, id) }, 201);
});

/** Full event JSON for the viewer (used after create/update). */
async function detail(c: Ctx, id: string) {
  const row = await c.env.DB.prepare(`SELECT e.*, g.slug AS g_slug, g.name AS g_name FROM events e LEFT JOIN groups g ON g.id = e.group_id WHERE e.id = ?`)
    .bind(id).first<EventRow & { g_slug: string | null; g_name: string | null }>();
  const { g_slug, g_name, ...event } = row!;
  const user = c.get('user');
  const [hosts, rsvp] = await Promise.all([
    userCards(c.env, [event.host_id]),
    user ? c.env.DB.prepare('SELECT status FROM event_rsvps WHERE event_id = ? AND user_id = ?').bind(id, user.id).first<{ status: Rsvp }>() : null,
  ]);
  return eventJson(event, hosts.get(event.host_id) ?? null,
    event.group_id && g_slug ? { id: event.group_id, slug: g_slug, name: g_name! } : null, rsvp?.status ?? null);
}

// ── One event ────────────────────────────────────────────────────────────

events.get('/:id', async c => {
  const l = await load(c);
  const { event, user } = l;
  const blockFilter = user
    ? `AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = ?) OR (b.blocker_id = ? AND b.blocked_id = u.id))`
    : '';
  const u = userCardColumns.split(', ').map(col => `u.${col}`).join(', ');
  const [hostRows, attendeeRows] = await Promise.all([
    c.env.DB.prepare(`SELECT ${u}, CASE WHEN u.id = ?1 THEN 0 ELSE 1 END AS ord FROM users u
        WHERE u.id = ?1 OR u.id IN (SELECT user_id FROM event_hosts WHERE event_id = ?2) ORDER BY ord, u.handle`)
      .bind(event.host_id, event.id).all<UserRow>(),
    c.env.DB.prepare(`SELECT ${u} FROM event_rsvps r JOIN users u ON u.id = r.user_id
        WHERE r.event_id = ? AND r.status = 'going' ${blockFilter} ORDER BY r.updated_at, r.user_id LIMIT 8`)
      .bind(event.id, ...(user ? [user.id, user.id] : [])).all<UserRow>(),
  ]);
  const hosts = hostRows.results.map(userCard);
  return c.json({
    event: {
      ...eventJson(event, hosts[0] ?? null, groupRef(l.group), l.rsvp, l.invited),
      hosts,
      attendees: attendeeRows.results.map(userCard),
    },
    viewer: {
      rsvp: l.rsvp,
      invited: l.invited,
      role: l.role,
      can_edit: l.role !== null && !event.cancelled_at,
      can_cancel: l.role === 'host' && !event.cancelled_at,
      can_invite: canInvite(l) && !event.cancelled_at,
      can_comment: Boolean(user),
    },
  });
});

events.patch('/:id', async c => {
  const user = requireUser(c);
  const l = await load(c);
  const { event } = l;
  if (l.role === null) fail(403, 'Only hosts can edit this event.');
  if (event.cancelled_at) fail(409, 'This event was cancelled.');
  const input = await body(c);
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); values.push(value); };

  if ('title' in input) set('title', validTitle(input.title));
  if ('description' in input) set('description', validDescription(input.description));
  const starts = 'starts_at' in input ? validTime(input.starts_at, 'start') : event.starts_at;
  const ends = 'ends_at' in input
    ? (input.ends_at === null || input.ends_at === '' ? null : validTime(input.ends_at, 'end'))
    : event.ends_at;
  checkTimes(starts, ends);
  const moved = starts !== event.starts_at;
  if ('starts_at' in input) set('starts_at', starts);
  if ('ends_at' in input) set('ends_at', ends);
  if ('timezone' in input) set('timezone', validTimezone(input.timezone));
  if ('location_name' in input) set('location_name', str(input.location_name, 120));
  if ('location_address' in input) set('location_address', str(input.location_address, 200));
  if ('online_url' in input) set('online_url', validUrl(input.online_url));
  if ('cover_media_id' in input) {
    const id = input.cover_media_id === event.cover_media_id ? event.cover_media_id : await coverId(c.env, user.id, input.cover_media_id);
    set('cover_media_id', id);
  }
  if ('privacy' in input) set('privacy', groupPrivacy(validPrivacy(input.privacy), l.group));
  if ('capacity' in input) set('capacity', validCapacity(input.capacity));

  const statements: D1PreparedStatement[] = [];
  if ('cohosts' in input) {
    if (l.role !== 'host') fail(403, 'Only the host can change co-hosts.');
    const ids = await cohostIds(c.env, event.host_id, input.cohosts);
    const { results: existing } = await c.env.DB.prepare('SELECT user_id FROM event_hosts WHERE event_id = ?').bind(event.id).all<{ user_id: string }>();
    const had = new Set(existing.map(r => r.user_id));
    statements.push(c.env.DB.prepare(`DELETE FROM event_hosts WHERE event_id = ?${ids.length ? ` AND user_id NOT IN (${placeholders(ids.length)})` : ''}`)
      .bind(event.id, ...ids));
    const now = Date.now();
    for (const id of ids) {
      if (had.has(id)) continue;
      statements.push(c.env.DB.prepare('INSERT OR IGNORE INTO event_hosts (event_id, user_id, created_at) VALUES (?, ?, ?)').bind(event.id, id, now));
      const note = notifyStatement(c.env, { userId: id, actorId: user.id, type: 'event_host' as NotificationType,
        body: `${user.name} added you as a host of "${event.title}".` }, now);
      if (note) statements.push(note);
    }
  }
  if (!sets.length && !statements.length) fail(422, 'Nothing to change.');
  if (sets.length) {
    set('updated_at', Date.now());
    statements.push(c.env.DB.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).bind(...values, event.id));
  }
  // A new start time means everyone gets a fresh reminder.
  if (moved) statements.push(c.env.DB.prepare('DELETE FROM event_reminders_sent WHERE event_id = ?').bind(event.id));
  await c.env.DB.batch(statements);
  return c.json({ event: await detail(c, event.id) });
});

/** Cancel: the page stays up, marked cancelled, and everyone who replied going or interested is told. */
events.delete('/:id', async c => {
  const user = requireUser(c);
  const l = await load(c);
  const { event } = l;
  if (l.role !== 'host') fail(403, 'Only the host can cancel this event.');
  if (!event.cancelled_at) {
    const now = Date.now();
    const { results: people } = await c.env.DB.prepare(`SELECT user_id FROM event_rsvps WHERE event_id = ? AND status IN ('going', 'interested')
        AND user_id != ? ORDER BY updated_at LIMIT ${NOTIFY_LIMIT}`).bind(event.id, user.id).all<{ user_id: string }>();
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare('UPDATE events SET cancelled_at = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL').bind(now, now, event.id),
    ];
    for (const p of people) {
      const note = notifyStatement(c.env, { userId: p.user_id, actorId: user.id, type: 'event_cancelled' as NotificationType,
        body: `${user.name} cancelled "${event.title}".` }, now);
      if (note) statements.push(note);
    }
    await c.env.DB.batch(statements);
  }
  return c.json({ event: await detail(c, event.id) });
});

// ── Replies ──────────────────────────────────────────────────────────────

const countsSql = `UPDATE events SET
    going_count = (SELECT COUNT(*) FROM event_rsvps WHERE event_id = ?1 AND status = 'going'),
    interested_count = (SELECT COUNT(*) FROM event_rsvps WHERE event_id = ?1 AND status = 'interested')
  WHERE id = ?1`;

async function counts(env: Env, id: string) {
  return (await env.DB.prepare('SELECT going_count, interested_count FROM events WHERE id = ?').bind(id)
    .first<{ going_count: number; interested_count: number }>())!;
}

events.put('/:id/rsvp', async c => {
  const user = requireUser(c);
  const { event } = await load(c);
  const status = (await body(c)).status as Rsvp;
  if (!STATUSES.includes(status)) fail(422, 'Reply going, interested or declined.');
  if (event.cancelled_at) fail(409, 'This event was cancelled.');
  if (hasEnded(event)) fail(409, 'This event has ended.');
  const now = Date.now();
  // Capacity is checked inside the insert so two people cannot take the last place at once.
  const [write] = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO event_rsvps (event_id, user_id, status, created_at, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?4 WHERE ?3 != 'going'
          OR EXISTS (SELECT 1 FROM event_rsvps WHERE event_id = ?1 AND user_id = ?2 AND status = 'going')
          OR (SELECT capacity IS NULL OR capacity > (SELECT COUNT(*) FROM event_rsvps WHERE event_id = ?1 AND status = 'going') FROM events WHERE id = ?1)
        ON CONFLICT (event_id, user_id) DO UPDATE SET status = excluded.status,
          updated_at = CASE WHEN event_rsvps.status = excluded.status THEN event_rsvps.updated_at ELSE excluded.updated_at END`)
      .bind(event.id, user.id, status, now),
    c.env.DB.prepare(countsSql).bind(event.id),
  ]);
  if (!write.meta.changes) fail(409, 'This event is full.');
  return c.json({ rsvp: status, ...(await counts(c.env, event.id)) });
});

events.delete('/:id/rsvp', async c => {
  const user = requireUser(c);
  const { event } = await load(c);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?').bind(event.id, user.id),
    c.env.DB.prepare(countsSql).bind(event.id),
  ]);
  return c.json({ rsvp: null, ...(await counts(c.env, event.id)) });
});

events.get('/:id/attendees', async c => {
  const l = await load(c);
  const status = (c.req.query('status') || 'going') as Rsvp;
  if (!STATUSES.includes(status)) fail(422, 'Status is going, interested or declined.');
  if (status === 'declined' && l.role === null) fail(403, 'Only hosts can see who declined.');
  const size = limit(c, 30, 50);
  const offset = Math.max(0, Number(c.req.query('cursor')) || 0);
  const user = l.user;
  const u = userCardColumns.split(', ').map(col => `u.${col}`).join(', ');
  const { results } = await c.env.DB.prepare(`SELECT ${u}, r.status, r.updated_at AS replied_at FROM event_rsvps r JOIN users u ON u.id = r.user_id
      WHERE r.event_id = ? AND r.status = ?
      ${user ? 'AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = ?) OR (b.blocker_id = ? AND b.blocked_id = u.id))' : ''}
      ORDER BY r.updated_at, r.user_id LIMIT ? OFFSET ?`)
    .bind(l.event.id, status, ...(user ? [user.id, user.id] : []), size + 1, offset).all<UserRow & { status: Rsvp; replied_at: number }>();
  return c.json({
    items: results.slice(0, size).map(r => ({ user: userCard(r), status: r.status, created_at: r.replied_at })),
    next: results.length > size ? String(offset + size) : null,
  });
});

events.post('/:id/invite', async c => {
  const user = requireUser(c);
  const l = await load(c);
  const { event } = l;
  if (event.cancelled_at) fail(409, 'This event was cancelled.');
  if (!canInvite(l)) fail(403, 'Only hosts can invite people to this event.');
  const raw = (await body(c)).handles;
  const handles = [...new Set((Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [])
    .map(v => str(v, 40).replace(/^@/, '').toLowerCase()).filter(Boolean))];
  if (!handles.length) fail(422, 'Choose someone to invite.');
  if (handles.length > MAX_INVITES) fail(422, `Invite up to ${MAX_INVITES} people at a time.`);
  const { results } = await c.env.DB.prepare(`SELECT u.id, u.handle,
        EXISTS (SELECT 1 FROM event_invites WHERE event_id = ?1 AND user_id = u.id) AS invited,
        EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id IN (?2, ?3)) OR (b.blocked_id = u.id AND b.blocker_id IN (?2, ?3))) AS blocked
      FROM users u WHERE u.handle IN (${handles.map((_, i) => `?${i + 4}`).join(', ')})`)
    .bind(event.id, user.id, event.host_id, ...handles).all<{ id: string; handle: string; invited: number; blocked: number }>();
  const found = new Set(results.map(r => r.handle.toLowerCase()));
  const missing = handles.find(h => !found.has(h));
  if (missing) fail(404, `No one called @${missing}.`);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  const invited: string[] = [];
  const already: string[] = [];
  for (const r of results) {
    if (r.id === user.id) continue;
    // People with a block either way are skipped quietly.
    if (r.invited || r.blocked) { already.push(r.handle); continue; }
    invited.push(r.handle);
    statements.push(c.env.DB.prepare('INSERT OR IGNORE INTO event_invites (event_id, user_id, invited_by, created_at) VALUES (?, ?, ?, ?)')
      .bind(event.id, r.id, user.id, now));
    const note = notifyStatement(c.env, { userId: r.id, actorId: user.id, type: 'event_invite' as NotificationType,
      body: `${user.name} invited you to "${event.title}".` }, now);
    if (note) statements.push(note);
  }
  if (statements.length) await c.env.DB.batch(statements);
  return c.json({ invited, already });
});

// ── Discussion ───────────────────────────────────────────────────────────

interface CommentRow { id: string; event_id: string; author_id: string; body: string; created_at: number; deleted_at: number | null }

const commentJson = (r: CommentRow, author: UserCard | null, canDelete: boolean) => ({
  id: r.id, body: r.body, created_at: r.created_at, author, can_delete: canDelete,
});

events.get('/:id/comments', async c => {
  const l = await load(c);
  const user = l.user;
  const size = limit(c, 20, 50);
  const after = c.req.query('cursor');
  const { results } = await c.env.DB.prepare(`SELECT ec.* FROM event_comments ec
      WHERE ec.event_id = ? AND ec.deleted_at IS NULL ${after ? 'AND ec.id < ?' : ''}
      ${user ? 'AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ec.author_id AND b.blocked_id = ?) OR (b.blocker_id = ? AND b.blocked_id = ec.author_id))' : ''}
      ORDER BY ec.id DESC LIMIT ?`)
    .bind(l.event.id, ...(after ? [after] : []), ...(user ? [user.id, user.id] : []), size + 1).all<CommentRow>();
  const rows = results.slice(0, size);
  const authors = await userCards(c.env, rows.map(r => r.author_id));
  return c.json({
    items: rows.map(r => commentJson(r, authors.get(r.author_id) ?? null, Boolean(user && (r.author_id === user.id || l.role !== null)))),
    next: results.length > size ? rows[rows.length - 1].id : null,
  });
});

events.post('/:id/comments', async c => {
  const user = requireUser(c);
  const { event } = await load(c);
  const input = await body(c);
  const bodyText = typeof input.body === 'string' ? input.body.trim() : '';
  if (!bodyText) fail(422, 'Write something first.');
  if ([...bodyText].length > MAX_COMMENT) fail(422, `Comments are limited to ${MAX_COMMENT} characters.`);
  const now = Date.now();
  const id = newId(now);
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare('INSERT INTO event_comments (id, event_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, event.id, user.id, bodyText, now),
    c.env.DB.prepare('UPDATE events SET comment_count = comment_count + 1 WHERE id = ?').bind(event.id),
  ];
  const note = notifyStatement(c.env, { userId: event.host_id, actorId: user.id, type: 'event_comment' as NotificationType,
    body: `${user.name} commented on "${event.title}".` }, now);
  if (note) statements.push(note);
  await c.env.DB.batch(statements);
  const row: CommentRow = { id, event_id: event.id, author_id: user.id, body: bodyText, created_at: now, deleted_at: null };
  return c.json({ comment: commentJson(row, userCard(user), true) }, 201);
});

events.delete('/:id/comments/:cid', async c => {
  const user = requireUser(c);
  const l = await load(c);
  const row = await c.env.DB.prepare('SELECT * FROM event_comments WHERE id = ? AND event_id = ? AND deleted_at IS NULL')
    .bind(c.req.param('cid'), l.event.id).first<CommentRow>();
  if (!row) fail(404, 'Comment not found.');
  if (row.author_id !== user.id && l.role === null) fail(403, 'You cannot delete this comment.');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE event_comments SET deleted_at = ? WHERE id = ?').bind(Date.now(), row.id),
    c.env.DB.prepare('UPDATE events SET comment_count = MAX(0, comment_count - 1) WHERE id = ?').bind(l.event.id),
  ]);
  return c.json({ ok: true });
});

// ── Calendar file ────────────────────────────────────────────────────────

const icsDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Folds a content line at 75 octets (RFC 5545 3.1), never splitting a UTF-8 character. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (size + n > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function eventIcs(e: EventRow, origin: string, host: { name: string; handle: string } | null, now = Date.now()): string {
  const url = `${origin}/events/${e.id}`;
  const location = [e.location_name, e.location_address].filter(Boolean).join(', ') || e.online_url;
  const description = [e.description, e.online_url ? `Online: ${e.online_url}` : '', url].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Southbag//Southbag Social//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.id}@social.southbag.cc`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(e.starts_at)}`,
    `DTEND:${icsDate(e.ends_at ?? e.starts_at + OPEN_ENDED_MS)}`,
    `SUMMARY:${icsText(e.title)}`,
    description ? `DESCRIPTION:${icsText(description)}` : '',
    location ? `LOCATION:${icsText(location)}` : '',
    `URL:${url}`,
    host ? `ORGANIZER;CN=${icsText(host.name).replace(/"/g, '')}:${url}` : '',
    `STATUS:${e.cancelled_at ? 'CANCELLED' : 'CONFIRMED'}`,
    `LAST-MODIFIED:${icsDate(e.updated_at)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n') + '\r\n';
}

events.get('/:id/calendar.ics', async c => {
  const { event } = await load(c);
  const host = await c.env.DB.prepare('SELECT name, handle FROM users WHERE id = ?').bind(event.host_id).first<{ name: string; handle: string }>();
  const filename = (event.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event') + '.ics';
  return new Response(eventIcs(event, new URL(c.req.url).origin, host), {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
});

// ── Reminders ────────────────────────────────────────────────────────────

const REMINDER_WINDOW_MS = 24 * 3600000;
/** Events handled per run (each costs two bound parameters plus one for the id list; D1 allows 100). */
const REMINDER_BATCH = 25;

function reminderText(e: { title: string; starts_at: number; timezone: string }): string {
  let when: string;
  try {
    when = new Intl.DateTimeFormat('en-AU', {
      timeZone: e.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    }).format(new Date(e.starts_at));
  } catch {
    when = new Date(e.starts_at).toUTCString();
  }
  return `Reminder: "${e.title}" starts ${when}.`;
}

/**
 * Notifies everyone "going" to an event that starts within the next 24 hours, once per person.
 * Called by the hourly cron. Two writes per run however many people are going.
 */
export async function sendEventReminders(env: Env, now = Date.now()): Promise<number> {
  const notSent = `NOT EXISTS (SELECT 1 FROM event_reminders_sent s WHERE s.event_id = r.event_id AND s.user_id = r.user_id)`;
  const { results: due } = await env.DB.prepare(`SELECT e.id, e.title, e.starts_at, e.timezone FROM events e
      WHERE e.cancelled_at IS NULL AND e.starts_at > ? AND e.starts_at <= ?
        AND EXISTS (SELECT 1 FROM event_rsvps r WHERE r.event_id = e.id AND r.status = 'going' AND ${notSent})
      ORDER BY e.starts_at LIMIT ${REMINDER_BATCH}`)
    .bind(now, now + REMINDER_WINDOW_MS).all<{ id: string; title: string; starts_at: number; timezone: string }>();
  if (!due.length) return 0;
  const ids = due.map(e => e.id);
  const bodyCase = `CASE r.event_id ${due.map(() => 'WHEN ? THEN ?').join(' ')} END`;
  const bodyParams = due.flatMap(e => [e.id, reminderText(e)]);
  // Notification ids are "<time part of newId><random>", so they sort with the others.
  const idPrefix = newId(now).slice(0, 9);
  const [inserted] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, post_id, group_id, body, created_at)
        SELECT ? || substr(lower(hex(randomblob(4))), 1, 7), r.user_id, NULL, 'event_reminder', NULL, NULL, ${bodyCase}, ?
        FROM event_rsvps r WHERE r.status = 'going' AND r.event_id IN (${placeholders(ids.length)}) AND ${notSent}`)
      .bind(idPrefix, ...bodyParams, now, ...ids),
    env.DB.prepare(`INSERT OR IGNORE INTO event_reminders_sent (event_id, user_id, created_at)
        SELECT r.event_id, r.user_id, ? FROM event_rsvps r WHERE r.status = 'going' AND r.event_id IN (${placeholders(ids.length)}) AND ${notSent}`)
      .bind(now, ...ids),
  ]);
  return inserted.meta.changes ?? 0;
}

// Local development and tests only: run the reminder job now. Answers 404 anywhere but localhost.
events.post('/_reminders', async c => {
  const host = new URL(c.req.url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') fail(404, 'Not found.');
  return c.json({ sent: await sendEventReminders(c.env) });
});

export default events;
