// Message streaks (Snapchat style). Mounted at /api/streaks.
//
//   GET  /api/streaks                 your live streaks, longest-running first -> { items: StreakItem[], next: null }
//   GET  /api/streaks/with/:handle    your streak with one person -> StreakItem (current 0 when there isn't one)
//   POST /api/streaks/_test           localhost only: { op: 'tick' | 'reset' | 'row' | 'cron' | 'day', handle?, now? } (tests)
//
// A streak exists between the two people in a one-to-one conversation (never groups or Southbag
// Support). A streak day counts when both of them sent the other at least one message that calendar
// day in Australia/Sydney. `current` is the number of consecutive streak days ending today or
// yesterday; once a whole day passes without both sending, it is 0 again (`longest` stays).
//
// Storage is one row per pair (migrations/0012_streaks.sql), upserted by streakUpsert() in the same
// D1 batch as the message. The upsert does all the arithmetic in SQL against the existing row, so two
// people sending at the same moment can't lose each other's update, and it only writes when the
// sender's day changes: at most a couple of row writes per pair per day, whatever the message count.
//
// The hourly cron (streaksCron, called from src/index.ts) zeroes streaks that have run out and, after
// 6 pm Sydney time, warns people with a streak of 3+ days who haven't messaged today (once a day).

import { Hono } from 'hono';
import type { AppEnv, Ctx, Env } from '../env';
import { body, fail, placeholders, requireUser } from '../lib/http';
import { newId } from '../lib/ids';
import { track } from '../lib/palantir';
import { userByHandle, userCard, userCardColumns, type UserCard, type UserRow } from '../lib/users';

const streaks = new Hono<AppEnv>();

/** Streaks this long or longer get the "ends at midnight" notification. */
export const WARN_FROM_DAYS = 3;
/** Hour of the day (Sydney) from which the warning goes out. */
export const WARN_FROM_HOUR = 18;
/** Rows the cron handles per step per run (D1 allows 100 bound parameters a query). */
const CRON_BATCH = 90;

// -- Days -----------------------------------------------------------------

export const STREAK_TIMEZONE = 'Australia/Sydney';
// Formatters are expensive to build, so build them once per isolate.
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: STREAK_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFormat = new Intl.DateTimeFormat('en-AU', { timeZone: STREAK_TIMEZONE, hour: 'numeric', hourCycle: 'h23' });

/** The Sydney calendar day of a moment, as 'YYYY-MM-DD'. */
export const sydneyDay = (now = Date.now()): string => dayFormat.format(now);

/** The Sydney hour (0-23) of a moment. */
export const sydneyHour = (now = Date.now()): number =>
  Number(hourFormat.formatToParts(now).find(p => p.type === 'hour')?.value ?? 0) % 24;

/** 'YYYY-MM-DD' plus `n` days. */
export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// -- Rows and JSON ----------------------------------------------------------

export interface StreakRow {
  user_a: string;
  user_b: string;
  current: number;
  longest: number;
  last_day: string | null;
  a_last_day: string | null;
  b_last_day: string | null;
  started_day: string | null;
  warned_day: string | null;
  updated_at: number;
}

/** What conversations and the send response carry. null when there is no live streak. */
export interface StreakJson {
  current: number;
  longest: number;
  last_day: string;
  /** Yesterday counted but today hasn't yet: it ends at midnight unless both send something. */
  at_risk: boolean;
  /** Both have sent something today. */
  completed_today: boolean;
}

/** The two user ids in the order rows store them. */
export const streakPair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

/** A row as of `today`: a streak whose last completed day is before yesterday has run out. */
export function streakState(row: Pick<StreakRow, 'current' | 'longest' | 'last_day'> | null | undefined, today = sydneyDay()): StreakJson | null {
  if (!row || !row.last_day || row.current <= 0) return null;
  const yesterday = addDays(today, -1);
  if (row.last_day < yesterday) return null;
  return {
    current: row.current,
    longest: Math.max(row.longest, row.current),
    last_day: row.last_day,
    at_risk: row.last_day === yesterday,
    completed_today: row.last_day >= today,
  };
}

/**
 * The upsert that records `senderId` messaging `otherId` at `now`, for the message batch. Returns a row
 * (RETURNING) only when it wrote, which is only for the sender's first message of the day; if that
 * row's last_day is today, this message completed today's streak day.
 *
 * In an upsert's SET list every column reference is the row as it was, so the CASEs below all read
 * the previous values: a day completes when the other person already sent something today and the
 * day isn't counted yet; it extends the streak when yesterday counted, otherwise it starts over at 1.
 */
export function streakUpsert(env: Env, senderId: string, otherId: string, now = Date.now()): { statement: D1PreparedStatement; day: string } {
  const day = sydneyDay(now);
  const [a, b] = streakPair(senderId, otherId);
  const mine = senderId === a ? 'a_last_day' : 'b_last_day';
  const theirs = senderId === a ? 'b_last_day' : 'a_last_day';
  const completes = `(streaks.${theirs} = ?3 AND (streaks.last_day IS NULL OR streaks.last_day < ?3))`;
  const extends_ = 'streaks.last_day = ?4';
  const next = `CASE WHEN ${extends_} THEN streaks.current + 1 ELSE 1 END`;
  const statement = env.DB.prepare(`INSERT INTO streaks (user_a, user_b, ${mine}, updated_at) VALUES (?1, ?2, ?3, ?5)
      ON CONFLICT (user_a, user_b) DO UPDATE SET
        ${mine} = ?3,
        current = CASE WHEN ${completes} THEN ${next} ELSE streaks.current END,
        longest = CASE WHEN ${completes} THEN MAX(streaks.longest, ${next}) ELSE streaks.longest END,
        started_day = CASE WHEN ${completes} AND NOT COALESCE(${extends_}, 0) THEN ?3 ELSE streaks.started_day END,
        last_day = CASE WHEN ${completes} THEN ?3 ELSE streaks.last_day END,
        updated_at = ?5
      WHERE streaks.${mine} IS NULL OR streaks.${mine} < ?3
      RETURNING current, last_day`)
    .bind(a, b, day, addDays(day, -1), now);
  return { statement, day };
}

/** Reads one pair's row (put it after streakUpsert in the same batch to see the new state). */
export const streakSelect = (env: Env, x: string, y: string): D1PreparedStatement =>
  env.DB.prepare('SELECT * FROM streaks WHERE user_a = ? AND user_b = ?').bind(...streakPair(x, y));

/** The viewer's streak row in a one-to-one conversation (no row for groups). For a batch or .first(). */
export const conversationStreak = (env: Env, viewerId: string, conversationId: string): D1PreparedStatement =>
  env.DB.prepare(`SELECT s.* FROM conversations c
      JOIN conversation_members o ON o.conversation_id = c.id AND o.user_id != ?1
      JOIN streaks s ON s.user_a = MIN(?1, o.user_id) AND s.user_b = MAX(?1, o.user_id)
      WHERE c.id = ?2 AND c.is_group = 0 LIMIT 1`).bind(viewerId, conversationId);

/** The send path: state after the batch, and whether this message completed today's streak day. */
export function streakResult(returned: { current: number; last_day: string | null } | undefined, row: StreakRow | null | undefined, day: string) {
  const extended = Boolean(returned && returned.last_day === day);
  const state = streakState(row, day);
  return state ? { ...state, extended } : null;
}

/** Records the analytics event when a send extends a streak. */
export function trackStreak(c: Ctx, streak: (StreakJson & { extended: boolean }) | null) {
  if (streak?.extended) track(c, 'social_streak_extended', { days: streak.current, longest: streak.longest });
}

// The cron has no request, so no Hono context for track(); pass the bare minimum it could use.
// TODO(palantir): give lib/palantir.ts an env-based variant for scheduled jobs.
function trackFromCron(env: Env, event: string, properties: Record<string, unknown>) {
  try {
    track({ env, get: () => null, var: { user: null } } as unknown as Ctx, event, properties);
  } catch { /* analytics never breaks the cron */ }
}

// -- Routes -------------------------------------------------------------------

/** The newest one-to-one conversation between the viewer (?1) and `otherCol`, as a SQL subquery. */
const conversationIdSql = (otherCol: string) => `(SELECT m1.conversation_id FROM conversation_members m1
    JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id AND m2.user_id = ${otherCol}
    JOIN conversations cv ON cv.id = m1.conversation_id AND cv.is_group = 0
    WHERE m1.user_id = ?1 ORDER BY cv.created_at LIMIT 1)`;

interface ItemRow extends StreakRow, UserRow { conversation_id: string | null }

function itemJson(r: ItemRow, today: string) {
  const state = streakState(r, today);
  return {
    user: userCard(r) as UserCard,
    current: state?.current ?? 0,
    longest: Math.max(r.longest, state?.current ?? 0),
    last_day: r.last_day,
    at_risk: state?.at_risk ?? false,
    completed_today: state?.completed_today ?? false,
    conversation_id: r.conversation_id,
  };
}

streaks.get('/', async c => {
  const user = requireUser(c);
  const today = sydneyDay();
  const ucols = userCardColumns.split(', ').map(col => `u.${col}`).join(', ');
  // Two indexed lookups (primary key for user_a, streaks_user_b for user_b).
  const { results } = await c.env.DB.prepare(`SELECT s.*, ${ucols}, ${conversationIdSql('s.other')} AS conversation_id
      FROM (SELECT *, user_b AS other FROM streaks WHERE user_a = ?1
            UNION ALL SELECT *, user_a AS other FROM streaks WHERE user_b = ?1) s
      JOIN users u ON u.id = s.other
      WHERE s.current > 0 AND s.last_day >= ?2
      ORDER BY s.current DESC, s.last_day DESC LIMIT 50`)
    .bind(user.id, addDays(today, -1)).all<ItemRow>();
  return c.json({ items: results.map(r => itemJson(r, today)).filter(i => i.current > 0), next: null });
});

streaks.get('/with/:handle', async c => {
  const user = requireUser(c);
  const handle = c.req.param('handle').replace(/^@/, '');
  const other = await userByHandle(c.env, handle);
  if (!other) fail(404, `No account called @${handle}.`);
  const [a, b] = streakPair(user.id, other.id);
  const row = await c.env.DB.prepare(`SELECT s.*, ${conversationIdSql('?2')} AS conversation_id FROM streaks s
      WHERE s.user_a = ?3 AND s.user_b = ?4`).bind(user.id, other.id, a, b).first<StreakRow & { conversation_id: string | null }>();
  const empty: StreakRow = { user_a: a, user_b: b, current: 0, longest: 0, last_day: null, a_last_day: null, b_last_day: null, started_day: null, warned_day: null, updated_at: 0 };
  return c.json(itemJson({ ...empty, conversation_id: null, ...(row ?? {}), ...other } as ItemRow, sydneyDay()));
});

// -- Cron -----------------------------------------------------------------------

/**
 * Hourly (src/index.ts). Zeroes streaks whose last streak day is before yesterday, and after 6 pm
 * Sydney time sends "Your 12 day streak with Bob ends at midnight." to each person in a 3+ day
 * streak who hasn't messaged the other today, once per streak per day (warned_day). Each step handles
 * at most CRON_BATCH streaks per run and costs a fixed handful of queries.
 */
export async function streaksCron(env: Env, now = Date.now()): Promise<{ lost: number; warned: number }> {
  const today = sydneyDay(now);
  const yesterday = addDays(today, -1);

  // 1. Streaks that have run out.
  const { results: lost } = await env.DB.prepare(`SELECT rowid AS rid, user_a, user_b, current FROM streaks
      WHERE current > 0 AND last_day < ? ORDER BY last_day LIMIT ${CRON_BATCH}`)
    .bind(yesterday).all<{ rid: number; user_a: string; user_b: string; current: number }>();
  if (lost.length) {
    // A message since the SELECT restarts the streak (and moves last_day), so check again.
    await env.DB.prepare(`UPDATE streaks SET current = 0, updated_at = ? WHERE rowid IN (${placeholders(lost.length)}) AND last_day < ?`)
      .bind(now, ...lost.map(r => r.rid), yesterday).run();
    for (const r of lost) trackFromCron(env, 'social_streak_lost', { days: r.current, user_a: r.user_a, user_b: r.user_b });
  }

  // 2. "Ends at midnight" warnings, from 6 pm.
  let warned = 0;
  if (sydneyHour(now) >= WARN_FROM_HOUR) {
    const due = `SELECT rowid FROM streaks WHERE current > 0 AND last_day = ?1 AND current >= ${WARN_FROM_DAYS}
        AND (warned_day IS NULL OR warned_day < ?2) ORDER BY rowid LIMIT ${CRON_BATCH}`;
    const notYet = (col: string) => `(${col} IS NULL OR ${col} < ?2)`;
    // Notification ids are "<time part of newId><random>", so they sort with the others.
    const idPrefix = newId(now).slice(0, 9);
    const [inserted] = await env.DB.batch([
      env.DB.prepare(`WITH due AS (SELECT * FROM streaks WHERE rowid IN (${due})),
          sides AS (
            SELECT user_a AS uid, user_b AS oid, current FROM due WHERE ${notYet('a_last_day')}
            UNION ALL
            SELECT user_b AS uid, user_a AS oid, current FROM due WHERE ${notYet('b_last_day')}
          )
          INSERT INTO notifications (id, user_id, actor_id, type, post_id, group_id, body, link, created_at)
          SELECT ?3 || substr(lower(hex(randomblob(4))), 1, 7), x.uid, x.oid, 'system', NULL, NULL,
            'Your ' || x.current || ' day streak with ' || o.name || ' ends at midnight.',
            COALESCE('/messages/' || (SELECT m1.conversation_id FROM conversation_members m1
                JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id AND m2.user_id = x.oid
                JOIN conversations cv ON cv.id = m1.conversation_id AND cv.is_group = 0
                WHERE m1.user_id = x.uid ORDER BY cv.created_at LIMIT 1), '/messages?to=' || o.handle),
            ?4
          FROM sides x JOIN users o ON o.id = x.oid`)
        .bind(yesterday, today, idPrefix, now),
      env.DB.prepare(`UPDATE streaks SET warned_day = ?2 WHERE rowid IN (${due})`).bind(yesterday, today),
    ]);
    warned = inserted.meta.changes ?? 0;
  }
  return { lost: lost.length, warned };
}

// -- Local development and tests only (404 anywhere but localhost) -----------------

streaks.post('/_test', async c => {
  const host = new URL(c.req.url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') fail(404, 'Not found.');
  const user = requireUser(c);
  const input = await body<{ op?: unknown; handle?: unknown; now?: unknown }>(c);
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  if (input.op === 'cron') return c.json(await streaksCron(c.env, now));
  if (input.op === 'day') return c.json({ day: sydneyDay(now), hour: sydneyHour(now) });

  const other = typeof input.handle === 'string' ? await userByHandle(c.env, input.handle) : null;
  if (!other) fail(404, 'No such account.');
  if (input.op === 'reset') {
    await c.env.DB.prepare('DELETE FROM streaks WHERE user_a = ? AND user_b = ?').bind(...streakPair(user.id, other.id)).run();
    return c.json({ ok: true });
  }
  if (input.op === 'row') return c.json({ row: await streakSelect(c.env, user.id, other.id).first<StreakRow>() });
  if (input.op === 'tick') {
    // Exactly what sending a message in a one-to-one conversation does, at `now`.
    const { statement, day } = streakUpsert(c.env, user.id, other.id, now);
    const [up, sel] = await c.env.DB.batch([statement, streakSelect(c.env, user.id, other.id)]);
    const row = (sel.results[0] as StreakRow | undefined) ?? null;
    return c.json({ day, row, streak: streakResult(up.results[0] as { current: number; last_day: string | null } | undefined, row, day) });
  }
  fail(422, 'Unknown op.');
});

export default streaks;
