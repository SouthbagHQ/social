// Careers (LinkedIn): career profiles, endorsements, recommendations, company pages and jobs.
// Mounted at /api/careers.
//
// Career profile
//   GET    /profile/:handle                 -> CareerProfile (see profileJson below)
//   PATCH  /profile                         { headline?, open_to_work? } -> { headline, open_to_work }
//   POST   /experiences                     { company_id?, company_name, title, employment_type, location, start_month, end_month?, description } -> 201 { experience }
//   PATCH  /experiences/:id                 same fields, all optional -> { experience }
//   PUT    /experiences/order               { ids: [...] } -> { ok }   (every one of your ids, in the new order)
//   POST   /educations                      { school, degree, field, start_year?, end_year?, description } -> 201 { education }
//   PATCH  /educations/:id, PUT /educations/order { ids }
//   POST   /skills                          { name } -> 201 { skill }
//   PUT    /skills/order                    { names: [...] } -> { ok }
//   PUT    /endorse/:handle/:skill          DELETE ... -> { skill: { name, endorsement_count, endorsed } }
//                                           (friends, or people who follow each other, only)
// Recommendations (one per author per person; new and edited ones wait for approval)
//   GET    /recommendations                 -> { received: Rec[], written: Rec[], requests: [{ user, message, created_at }] }
//   POST   /recommendations/requests/:handle { message? } -> { requested: true }   (ask :handle to write one)
//   DELETE /recommendations/requests/:handle -> { ok }   (decline a request from :handle)
//   PUT    /recommendations/:handle         { relationship, body } -> { recommendation }   (write or edit yours about :handle)
//   PATCH  /recommendations/:id             { status: 'visible' | 'hidden' } -> { recommendation }   (the person it is about)
// Companies
//   GET    /companies                       ?q&mine=1&cursor -> { items: Company[], next }
//   POST   /companies                       { name, slug?, description, website, industry, size, location, logo_media_id? } -> 201 { company }
//   GET    /companies/:slug                 -> { company, employees: [UserCard + { headline, title }], admins: UserCard[] }
//   PATCH  /companies/:slug                 admins: same fields -> { company }
//   PUT    /companies/:slug/follow          DELETE ... -> { is_following, follower_count }
//   PUT    /companies/:slug/admins/:handle  admins -> { admins }
//   DELETE /companies/:slug/admins/:handle  owner, or an admin removing themselves -> { admins }
// Jobs
//   GET    /jobs                            ?q&location&workplace&type&company&cursor -> { items: JobCard[], next }   (open jobs)
//   POST   /jobs                            company admins: { company_id, title, location, workplace, employment_type,
//                                           salary_min?, salary_max?, description, apply_url? } -> 201 { job }
//   GET    /jobs/:id                        -> { job: Job }
//   PATCH  /jobs/:id                        managers: same fields + status open|closed -> { job }
//   POST   /jobs/:id/close                  managers -> { job }
//   PUT    /jobs/:id/save                   DELETE ... -> { saved }
//   POST   /jobs/:id/apply                  { note } -> 201 { application }   (once; 409 after that)
//   DELETE /jobs/:id/apply                  withdraw -> { ok }
//   GET    /jobs/:id/applications           managers: ?status&cursor -> { items: Application[], next, counts }
//   PATCH  /applications/:id                managers: { status: viewed|shortlisted|rejected } -> { application }  (notifies the applicant)
//   GET    /me/applications                 ?cursor -> { items: [Application + { job: JobCard }], next }
//   GET    /me/saved                        ?cursor -> { items: JobCard[], next }
//   GET    /me/jobs                         ?cursor -> { items: JobCard[], next }   (jobs you can manage, open and closed)
//   GET    /me/companies                    -> { items: Company[] }   (companies you admin)
//   GET    /recommended                     -> { items: JobCard[], basis: { terms, location } }
//
// "Managers" of a job are its poster and the admins of its company.
// Salaries are whole Australian dollars a year. Months are 'YYYY-MM'.

import { Hono } from 'hono';
import type { AppEnv, Ctx, Env, SessionUser } from '../env';
import { body, cursor, fail, limit, page, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { deleteUnusedMedia, getMedia } from '../lib/media';
import { notify, notifyStatement } from '../lib/notify';
import { track } from '../lib/palantir';
import { userCard, userCardColumns, type UserRow } from '../lib/users';

const careers = new Hono<AppEnv>();

// -- Shared bits -----------------------------------------------------------

const u = (alias: string, prefix = '') =>
  userCardColumns.split(', ').map(col => `${alias}.${col}${prefix ? ` AS ${prefix}${col}` : ''}`).join(', ');

/** Pulls a prefixed user card out of a joined row (`a_id`, `a_handle`, …). */
const prefixedCard = (row: Record<string, unknown>, prefix: string) => userCard({
  id: row[`${prefix}id`] as string,
  handle: row[`${prefix}handle`] as string,
  name: row[`${prefix}name`] as string,
  avatar_media_id: row[`${prefix}avatar_media_id`] as string | null,
  identity_picture: row[`${prefix}identity_picture`] as string | null,
  verified: row[`${prefix}verified`] as number,
});

const EXPERIENCE_TYPES = ['full_time', 'part_time', 'contract', 'casual', 'internship', 'self_employed', 'volunteer'] as const;
const JOB_TYPES = ['full_time', 'part_time', 'contract', 'casual', 'internship'] as const;
const WORKPLACES = ['onsite', 'hybrid', 'remote'] as const;
const COMPANY_SIZES = ['', '1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+'] as const;
const APPLICATION_STATUSES = ['submitted', 'viewed', 'shortlisted', 'rejected'] as const;

const MAX = { experiences: 50, educations: 30, skills: 50, companiesOwned: 10 };

const oneOf = <T extends string>(list: readonly T[], value: unknown, message: string, fallback?: T): T => {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  if (typeof value === 'string' && (list as readonly string[]).includes(value)) return value as T;
  fail(422, message);
};

function month(value: unknown, label: string): string {
  const s = str(value, 7);
  const m = s.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!m || Number(m[1]) < 1900 || Number(m[1]) > 2100) fail(422, `${label} must be a month, like 2022-03.`);
  return s;
}

function year(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1900 || n > 2100) fail(422, `${label} must be a year, like 2019.`);
  return n;
}

function required(value: unknown, max: number, message: string): string {
  const s = str(value, max);
  if (!s) fail(422, message);
  return s;
}

function webAddress(value: unknown): string {
  const s = str(value, 300);
  if (!s) return '';
  if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(s)) fail(422, 'Enter a web address starting with https://.');
  return s;
}

function money(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) fail(422, `${label} must be a whole number of dollars.`);
  return n;
}

/** `%text%` for LIKE … ESCAPE '\'. */
const like = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

async function personByHandle(env: Env, handle: string) {
  const row = await env.DB.prepare(`SELECT ${userCardColumns}, headline, open_to_work, location FROM users WHERE handle = ?`)
    .bind(handle.replace(/^@/, '')).first<UserRow & { headline: string; open_to_work: number; location: string }>();
  if (!row) fail(404, 'User not found.');
  return row;
}

/** Friends, or people who follow each other; and whether either has blocked the other. */
async function relation(env: Env, a: string, b: string): Promise<{ connected: boolean; blocked: boolean }> {
  const row = await env.DB.prepare(`SELECT
      (EXISTS (SELECT 1 FROM friendships WHERE status = 'accepted'
          AND ((requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)))
        OR (EXISTS (SELECT 1 FROM follows WHERE follower_id = ?1 AND followee_id = ?2)
          AND EXISTS (SELECT 1 FROM follows WHERE follower_id = ?2 AND followee_id = ?1))) AS connected,
      EXISTS (SELECT 1 FROM blocks WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1)) AS blocked`)
    .bind(a, b).first<{ connected: number; blocked: number }>();
  return { connected: Boolean(row?.connected) && !row?.blocked, blocked: Boolean(row?.blocked) };
}

/** Somebody else the signed-in user wants to do something career-related with. */
async function connectedPerson(c: Ctx, selfMessage: string, notConnectedMessage: string) {
  const me = requireUser(c);
  const them = await personByHandle(c.env, c.req.param('handle')!);
  if (them.id === me.id) fail(422, selfMessage);
  const rel = await relation(c.env, me.id, them.id);
  if (rel.blocked) fail(403, 'You cannot do that.');
  if (!rel.connected) fail(403, notConnectedMessage);
  return { me, them };
}

// -- Career profile --------------------------------------------------------

interface ExperienceRow {
  id: string; user_id: string; company_id: string | null; company_name: string; title: string;
  employment_type: string; location: string; start_month: string; end_month: string | null;
  description: string; position: number; created_at: number;
  company_slug?: string | null; company_logo?: string | null;
}
interface EducationRow {
  id: string; user_id: string; school: string; degree: string; field: string;
  start_year: number | null; end_year: number | null; description: string; position: number; created_at: number;
}
interface RecommendationRow {
  id: string; user_id: string; author_id: string; relationship: string; body: string;
  status: 'pending' | 'visible' | 'hidden'; created_at: number; updated_at: number;
  a_headline?: string;
  [key: string]: unknown;
}

const experienceJson = (e: ExperienceRow) => ({
  id: e.id,
  company: e.company_id && e.company_slug
    ? { id: e.company_id, slug: e.company_slug, name: e.company_name, logo_url: e.company_logo ? `/media/${e.company_logo}` : null }
    : null,
  company_name: e.company_name,
  title: e.title,
  employment_type: e.employment_type,
  location: e.location,
  start_month: e.start_month,
  end_month: e.end_month,
  current: !e.end_month,
  description: e.description,
  position: e.position,
});

const educationJson = (e: EducationRow) => ({
  id: e.id, school: e.school, degree: e.degree, field: e.field,
  start_year: e.start_year, end_year: e.end_year, description: e.description, position: e.position,
});

const recommendationJson = (r: RecommendationRow) => ({
  id: r.id,
  user_id: r.user_id,
  author: { ...prefixedCard(r, 'a_'), headline: r.a_headline ?? '' },
  relationship: r.relationship,
  body: r.body,
  status: r.status,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const experienceSelect = `SELECT e.*, c.slug AS company_slug, c.logo_media_id AS company_logo
  FROM experiences e LEFT JOIN companies c ON c.id = e.company_id`;
const recommendationSelect = `SELECT r.*, ${u('a', 'a_')}, a.headline AS a_headline
  FROM recommendations r JOIN users a ON a.id = r.author_id`;

careers.get('/profile/:handle', async c => {
  const viewer = c.get('user');
  const them = await personByHandle(c.env, c.req.param('handle'));
  const v = viewer?.id ?? '';
  const isMe = v === them.id;
  const rel = viewer && !isMe ? await relation(c.env, v, them.id) : { connected: false, blocked: false };
  if (rel.blocked) fail(403, 'This profile is not available.');
  const [exp, edu, skills, recs, asks] = await c.env.DB.batch([
    c.env.DB.prepare(`${experienceSelect} WHERE e.user_id = ? ORDER BY e.position, e.created_at DESC LIMIT ${MAX.experiences}`).bind(them.id),
    c.env.DB.prepare(`SELECT * FROM educations WHERE user_id = ? ORDER BY position, created_at DESC LIMIT ${MAX.educations}`).bind(them.id),
    c.env.DB.prepare(`SELECT s.name, s.endorsement_count, s.position,
        EXISTS (SELECT 1 FROM endorsements en WHERE en.user_id = s.user_id AND en.skill = s.name AND en.endorser_id = ?2) AS endorsed
      FROM skills s WHERE s.user_id = ?1 ORDER BY s.position, s.created_at LIMIT ${MAX.skills}`).bind(them.id, v),
    // Everyone sees visible ones; the subject sees all of theirs; an author sees their own pending one.
    c.env.DB.prepare(`${recommendationSelect} WHERE r.user_id = ?1 AND (r.status = 'visible' OR ?2 = 1 OR r.author_id = ?3)
      ORDER BY r.created_at DESC LIMIT 50`).bind(them.id, isMe ? 1 : 0, v),
    c.env.DB.prepare(`SELECT
        EXISTS (SELECT 1 FROM recommendation_requests WHERE user_id = ?1 AND author_id = ?2) AS asked_you,
        EXISTS (SELECT 1 FROM recommendation_requests WHERE user_id = ?2 AND author_id = ?1) AS you_asked`).bind(them.id, v),
  ]);
  const ask = (asks.results[0] ?? {}) as { asked_you?: number; you_asked?: number };
  return c.json({
    user: { ...userCard(them), headline: them.headline, open_to_work: Boolean(them.open_to_work), location: them.location },
    viewer: {
      is_me: isMe,
      connected: rel.connected,
      can_endorse: rel.connected,
      can_recommend: rel.connected,
      asked_you: !isMe && Boolean(ask.asked_you),
      you_asked: !isMe && Boolean(ask.you_asked),
    },
    experiences: (exp.results as unknown as ExperienceRow[]).map(experienceJson),
    educations: (edu.results as unknown as EducationRow[]).map(educationJson),
    skills: (skills.results as { name: string; endorsement_count: number; position: number; endorsed: number }[])
      .map(s => ({ name: s.name, endorsement_count: s.endorsement_count, endorsed: Boolean(s.endorsed) })),
    recommendations: (recs.results as unknown as RecommendationRow[]).map(recommendationJson),
  });
});

careers.patch('/profile', async c => {
  const me = requireUser(c);
  const input = await body(c);
  const sets: string[] = [], params: unknown[] = [];
  if ('headline' in input) { sets.push('headline = ?'); params.push(str(input.headline, 120)); }
  if ('open_to_work' in input) { sets.push('open_to_work = ?'); params.push(input.open_to_work ? 1 : 0); }
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...params, Date.now(), me.id).run();
  }
  const row = await c.env.DB.prepare('SELECT headline, open_to_work FROM users WHERE id = ?').bind(me.id)
    .first<{ headline: string; open_to_work: number }>();
  if (sets.length) track(c, 'social_career_profile_updated', { fields: sets.map(part => part.split(' ')[0]), open_to_work: Boolean(row?.open_to_work) });
  return c.json({ headline: row?.headline ?? '', open_to_work: Boolean(row?.open_to_work) });
});

// -- Experience ------------------------------------------------------------

/** Validated experience fields. `partial` leaves out anything not sent. */
async function experienceInput(env: Env, input: Record<string, unknown>, existing?: ExperienceRow) {
  const has = (k: string) => !existing || k in input;
  const out: Partial<ExperienceRow> = {};
  if (has('company_id') || has('company_name')) {
    let companyId: string | null = null;
    let companyName = str(input.company_name, 100);
    const wanted = str(input.company_id, 40);
    if (wanted) {
      const company = await env.DB.prepare('SELECT id, name FROM companies WHERE id = ? OR slug = ?').bind(wanted, wanted).first<{ id: string; name: string }>();
      if (!company) fail(422, 'Company not found.');
      companyId = company.id;
      companyName = companyName || company.name;
    } else {
      if (!companyName && existing && !('company_name' in input)) companyName = existing.company_name;
      // Typing a company's exact name links its page.
      const matches = await env.DB.prepare('SELECT id FROM companies WHERE name = ? COLLATE NOCASE LIMIT 2').bind(companyName).all<{ id: string }>();
      if (companyName && matches.results.length === 1) companyId = matches.results[0].id;
    }
    if (!companyName) fail(422, 'Enter a company.');
    out.company_id = companyId;
    out.company_name = companyName;
  }
  if (has('title')) out.title = required(input.title, 100, 'Enter a title.');
  if (has('employment_type')) out.employment_type = oneOf(EXPERIENCE_TYPES, input.employment_type, 'Choose an employment type.', 'full_time');
  if (has('location')) out.location = str(input.location, 100);
  if (has('start_month')) out.start_month = month(input.start_month, 'Start date');
  if (has('end_month')) out.end_month = input.end_month ? month(input.end_month, 'End date') : null;
  if (has('description')) out.description = str(input.description, 2000);
  const start = out.start_month ?? existing?.start_month;
  const end = out.end_month !== undefined ? out.end_month : existing?.end_month;
  if (start && end && end < start) fail(422, 'The end date is before the start date.');
  return out;
}

careers.post('/experiences', async c => {
  const me = requireUser(c);
  const fields = await experienceInput(c.env, await body(c));
  const id = newId();
  const now = Date.now();
  // New entries go to the top; the limit is checked in the same statement.
  const res = await c.env.DB.prepare(`INSERT INTO experiences (id, user_id, company_id, company_name, title, employment_type, location,
      start_month, end_month, description, position, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE((SELECT MIN(position) FROM experiences WHERE user_id = ?2), 1) - 1, ?11
    WHERE (SELECT COUNT(*) FROM experiences WHERE user_id = ?2) < ${MAX.experiences}`)
    .bind(id, me.id, fields.company_id ?? null, fields.company_name!, fields.title!, fields.employment_type!, fields.location ?? '',
      fields.start_month!, fields.end_month ?? null, fields.description ?? '', now).run();
  if (!res.meta.changes) fail(422, `You can list up to ${MAX.experiences} roles.`);
  track(c, 'social_experience_added', { experience_id: id, employment_type: fields.employment_type, linked_company: Boolean(fields.company_id), current: !fields.end_month });
  const row = await c.env.DB.prepare(`${experienceSelect} WHERE e.id = ?`).bind(id).first<ExperienceRow>();
  return c.json({ experience: experienceJson(row!) }, 201);
});

async function ownExperience(c: Ctx, me: SessionUser): Promise<ExperienceRow> {
  const row = await c.env.DB.prepare('SELECT * FROM experiences WHERE id = ? AND user_id = ?').bind(c.req.param('id'), me.id).first<ExperienceRow>();
  if (!row) fail(404, 'Role not found.');
  return row;
}

careers.put('/experiences/order', c => reorder(c, 'experiences'));

careers.patch('/experiences/:id', async c => {
  const me = requireUser(c);
  const existing = await ownExperience(c, me);
  const fields = await experienceInput(c.env, await body(c), existing);
  const keys = Object.keys(fields) as (keyof ExperienceRow)[];
  if (keys.length) {
    await c.env.DB.prepare(`UPDATE experiences SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...keys.map(k => fields[k] ?? null), existing.id, me.id).run();
  }
  const row = await c.env.DB.prepare(`${experienceSelect} WHERE e.id = ?`).bind(existing.id).first<ExperienceRow>();
  return c.json({ experience: experienceJson(row!) });
});

/** PUT /:section/order — every id (or skill name) the user has, in the new order. */
async function reorder(c: Ctx, table: 'experiences' | 'educations' | 'skills') {
  const me = requireUser(c);
  const input = await body<{ ids?: unknown; names?: unknown }>(c);
  const key = table === 'skills' ? 'name' : 'id';
  const raw = table === 'skills' ? input.names : input.ids;
  if (!Array.isArray(raw) || raw.length > 60) fail(422, 'Send the new order.');
  const wanted = raw.map(x => str(x, 100));
  const { results } = await c.env.DB.prepare(`SELECT ${key} AS k FROM ${table} WHERE user_id = ?`).bind(me.id).all<{ k: string }>();
  const have = new Map(results.map(r => [r.k.toLowerCase(), r.k]));
  const seen = new Set(wanted.map(w => w.toLowerCase()));
  if (seen.size !== wanted.length || wanted.length !== have.size || wanted.some(w => !have.has(w.toLowerCase())))
    fail(422, 'The list has changed. Reload and try again.');
  if (wanted.length) {
    await c.env.DB.batch(wanted.map((w, i) =>
      c.env.DB.prepare(`UPDATE ${table} SET position = ? WHERE user_id = ? AND ${key} = ?`).bind(i, me.id, have.get(w.toLowerCase())!)));
  }
  return c.json({ ok: true });
}

// -- Education -------------------------------------------------------------

function educationInput(input: Record<string, unknown>, existing?: EducationRow) {
  const has = (k: string) => !existing || k in input;
  const out: Partial<EducationRow> = {};
  if (has('school')) out.school = required(input.school, 120, 'Enter a school.');
  if (has('degree')) out.degree = str(input.degree, 120);
  if (has('field')) out.field = str(input.field, 120);
  if (has('start_year')) out.start_year = year(input.start_year, 'Start year');
  if (has('end_year')) out.end_year = year(input.end_year, 'End year');
  if (has('description')) out.description = str(input.description, 1000);
  const start = out.start_year !== undefined ? out.start_year : existing?.start_year;
  const end = out.end_year !== undefined ? out.end_year : existing?.end_year;
  if (start && end && end < start) fail(422, 'The end year is before the start year.');
  return out;
}

careers.post('/educations', async c => {
  const me = requireUser(c);
  const f = educationInput(await body(c));
  const id = newId();
  const res = await c.env.DB.prepare(`INSERT INTO educations (id, user_id, school, degree, field, start_year, end_year, description, position, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE((SELECT MIN(position) FROM educations WHERE user_id = ?2), 1) - 1, ?9
    WHERE (SELECT COUNT(*) FROM educations WHERE user_id = ?2) < ${MAX.educations}`)
    .bind(id, me.id, f.school!, f.degree ?? '', f.field ?? '', f.start_year ?? null, f.end_year ?? null, f.description ?? '', Date.now()).run();
  if (!res.meta.changes) fail(422, `You can list up to ${MAX.educations} schools.`);
  track(c, 'social_education_added', { education_id: id });
  const row = await c.env.DB.prepare('SELECT * FROM educations WHERE id = ?').bind(id).first<EducationRow>();
  return c.json({ education: educationJson(row!) }, 201);
});

async function ownEducation(c: Ctx, me: SessionUser): Promise<EducationRow> {
  const row = await c.env.DB.prepare('SELECT * FROM educations WHERE id = ? AND user_id = ?').bind(c.req.param('id'), me.id).first<EducationRow>();
  if (!row) fail(404, 'Education not found.');
  return row;
}

careers.put('/educations/order', c => reorder(c, 'educations'));

careers.patch('/educations/:id', async c => {
  const me = requireUser(c);
  const existing = await ownEducation(c, me);
  const fields = educationInput(await body(c), existing);
  const keys = Object.keys(fields) as (keyof EducationRow)[];
  if (keys.length) {
    await c.env.DB.prepare(`UPDATE educations SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...keys.map(k => fields[k] ?? null), existing.id, me.id).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM educations WHERE id = ?').bind(existing.id).first<EducationRow>();
  return c.json({ education: educationJson(row!) });
});

// -- Skills and endorsements -----------------------------------------------

const skillName = (value: unknown) => str(value, 50).replace(/\s+/g, ' ');

careers.post('/skills', async c => {
  const me = requireUser(c);
  const name = skillName((await body(c)).name);
  if (!name) fail(422, 'Enter a skill.');
  const exists = await c.env.DB.prepare('SELECT 1 FROM skills WHERE user_id = ? AND name = ?').bind(me.id, name).first();
  if (exists) fail(409, 'You have already added that skill.');
  const res = await c.env.DB.prepare(`INSERT OR IGNORE INTO skills (user_id, name, position, endorsement_count, created_at)
    SELECT ?1, ?2, COALESCE((SELECT MAX(position) FROM skills WHERE user_id = ?1), -1) + 1, 0, ?3
    WHERE (SELECT COUNT(*) FROM skills WHERE user_id = ?1) < ${MAX.skills}`).bind(me.id, name, Date.now()).run();
  if (!res.meta.changes) fail(422, `You can list up to ${MAX.skills} skills.`);
  track(c, 'social_skill_added');
  return c.json({ skill: { name, endorsement_count: 0, endorsed: false } }, 201);
});

careers.put('/skills/order', c => reorder(c, 'skills'));

async function endorse(c: Ctx, on: boolean) {
  const { me, them } = await connectedPerson(c, 'You cannot endorse yourself.',
    'Only friends, or people who follow each other, can endorse skills.');
  const skill = await c.env.DB.prepare('SELECT name FROM skills WHERE user_id = ? AND name = ?')
    .bind(them.id, skillName(c.req.param('skill'))).first<{ name: string }>();
  if (!skill) fail(404, 'Skill not found.');
  const now = Date.now();
  const recount = c.env.DB.prepare(`UPDATE skills SET endorsement_count =
      (SELECT COUNT(*) FROM endorsements WHERE user_id = ?1 AND skill = ?2) WHERE user_id = ?1 AND name = ?2`).bind(them.id, skill.name);
  if (on) {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT OR IGNORE INTO endorsements (user_id, skill, endorser_id, created_at) VALUES (?, ?, ?, ?)')
        .bind(them.id, skill.name, me.id, now),
      // Only the first time, so toggling does not spam.
      c.env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, body, link, created_at)
        SELECT ?, ?, ?, 'system', ?, ?, ? WHERE changes() > 0`)
        .bind(newId(now), them.id, me.id, `${me.name} endorsed you for ${skill.name}.`, `/@${them.handle}/career`, now),
      recount,
    ]);
  } else {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM endorsements WHERE user_id = ? AND skill = ? AND endorser_id = ?').bind(them.id, skill.name, me.id),
      recount,
    ]);
  }
  const row = await c.env.DB.prepare('SELECT endorsement_count FROM skills WHERE user_id = ? AND name = ?').bind(them.id, skill.name)
    .first<{ endorsement_count: number }>();
  track(c, on ? 'social_skill_endorsed' : 'social_skill_unendorsed', { target_user_id: them.id });
  return c.json({ skill: { name: skill.name, endorsement_count: row?.endorsement_count ?? 0, endorsed: on } });
}

careers.put('/endorse/:handle/:skill', c => endorse(c, true));
careers.delete('/endorse/:handle/:skill', c => endorse(c, false));

// -- Recommendations -------------------------------------------------------

careers.get('/recommendations', async c => {
  const me = requireUser(c);
  const [received, written, requests] = await c.env.DB.batch([
    c.env.DB.prepare(`${recommendationSelect} WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 50`).bind(me.id),
    c.env.DB.prepare(`SELECT r.*, ${u('s', 's_')}, ${u('a', 'a_')}, a.headline AS a_headline FROM recommendations r
      JOIN users s ON s.id = r.user_id JOIN users a ON a.id = r.author_id
      WHERE r.author_id = ? ORDER BY r.created_at DESC LIMIT 50`).bind(me.id),
    c.env.DB.prepare(`SELECT q.message, q.created_at, ${u('s')}, s.headline FROM recommendation_requests q JOIN users s ON s.id = q.user_id
      WHERE q.author_id = ? ORDER BY q.created_at DESC LIMIT 50`).bind(me.id),
  ]);
  return c.json({
    received: (received.results as RecommendationRow[]).map(recommendationJson),
    written: (written.results as RecommendationRow[]).map(r => ({ ...recommendationJson(r), user: prefixedCard(r, 's_') })),
    requests: (requests.results as (UserRow & { headline: string; message: string; created_at: number })[])
      .map(r => ({ user: { ...userCard(r), headline: r.headline }, message: r.message, created_at: r.created_at })),
  });
});

careers.post('/recommendations/requests/:handle', async c => {
  const { me, them } = await connectedPerson(c, 'You cannot ask yourself.',
    'Only friends, or people who follow each other, can ask for recommendations.');
  const message = str((await body(c)).message, 500);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO recommendation_requests (user_id, author_id, message, created_at) VALUES (?, ?, ?, ?)')
      .bind(me.id, them.id, message, now),
    c.env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, body, link, created_at)
      SELECT ?, ?, ?, 'system', ?, ?, ? WHERE changes() > 0`)
      .bind(newId(now), them.id, me.id, `${me.name} asked you for a recommendation.`, `/@${me.handle}/career`, now),
  ]);
  track(c, 'social_recommendation_requested', { target_user_id: them.id, has_message: Boolean(message) });
  return c.json({ requested: true });
});

careers.delete('/recommendations/requests/:handle', async c => {
  const me = requireUser(c);
  const them = await personByHandle(c.env, c.req.param('handle'));
  await c.env.DB.prepare('DELETE FROM recommendation_requests WHERE (user_id = ?1 AND author_id = ?2) OR (user_id = ?2 AND author_id = ?1)')
    .bind(them.id, me.id).run();
  return c.json({ ok: true });
});

careers.put('/recommendations/:handle', async c => {
  const { me, them } = await connectedPerson(c, 'You cannot recommend yourself.',
    'Only friends, or people who follow each other, can write recommendations.');
  const input = await body(c);
  const text = required(input.body, 3000, 'Write your recommendation.');
  const relationship = str(input.relationship, 100);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO recommendations (id, user_id, author_id, relationship, body, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT (user_id, author_id) DO UPDATE SET relationship = excluded.relationship, body = excluded.body,
        status = 'pending', updated_at = excluded.updated_at`)
      .bind(newId(now), them.id, me.id, relationship, text, now, now),
    c.env.DB.prepare('DELETE FROM recommendation_requests WHERE user_id = ? AND author_id = ?').bind(them.id, me.id),
    notifyStatement(c.env, { userId: them.id, actorId: me.id, type: 'system',
      body: `${me.name} wrote you a recommendation. Review it on your Career tab.`, link: `/@${them.handle}/career` }, now)!,
  ]);
  const row = await c.env.DB.prepare(`${recommendationSelect} WHERE r.user_id = ? AND r.author_id = ?`).bind(them.id, me.id).first<RecommendationRow>();
  track(c, 'social_recommendation_written', { recommendation_id: row?.id ?? null, target_user_id: them.id });
  return c.json({ recommendation: recommendationJson(row!) });
});

careers.patch('/recommendations/:id', async c => {
  const me = requireUser(c);
  const status = oneOf(['visible', 'hidden'] as const, (await body(c)).status, 'Choose show or hide.');
  const res = await c.env.DB.prepare('UPDATE recommendations SET status = ? WHERE id = ? AND user_id = ?').bind(status, c.req.param('id'), me.id).run();
  if (!res.meta.changes) fail(404, 'Recommendation not found.');
  const row = await c.env.DB.prepare(`${recommendationSelect} WHERE r.id = ?`).bind(c.req.param('id')).first<RecommendationRow>();
  return c.json({ recommendation: recommendationJson(row!) });
});

// -- Companies -------------------------------------------------------------

interface CompanyRow {
  id: string; slug: string; name: string; description: string; website: string; industry: string; size: string;
  location: string; logo_media_id: string | null; owner_id: string; follower_count: number; created_at: number;
  is_following?: number; is_admin?: number;
}

const logoUrl = (id: string | null | undefined) => (id ? `/media/${id}` : null);

const companyPublic = (co: CompanyRow) => ({
  id: co.id,
  slug: co.slug,
  name: co.name,
  description: co.description,
  website: co.website,
  industry: co.industry,
  size: co.size,
  location: co.location,
  logo_url: logoUrl(co.logo_media_id),
  follower_count: co.follower_count,
});

const companyJson = (co: CompanyRow, viewerId: string | null = null) => ({
  id: co.id,
  slug: co.slug,
  name: co.name,
  description: co.description,
  website: co.website,
  industry: co.industry,
  size: co.size,
  location: co.location,
  logo_url: logoUrl(co.logo_media_id),
  follower_count: co.follower_count,
  created_at: co.created_at,
  is_following: Boolean(co.is_following),
  is_admin: Boolean(co.is_admin),
  is_owner: viewerId === co.owner_id,
});

const companyViewerColumns = (alias = 'co') => `
  EXISTS (SELECT 1 FROM company_follows f WHERE f.company_id = ${alias}.id AND f.user_id = ?) AS is_following,
  EXISTS (SELECT 1 FROM company_admins ad WHERE ad.company_id = ${alias}.id AND ad.user_id = ?) AS is_admin`;

const RESERVED_SLUGS = new Set(['new', 'mine', 'me', 'southbag', 'admin', 'jobs']);

export const slugify = (text: string): string =>
  text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

async function logoId(env: Env, userId: string, value: unknown): Promise<string | null> {
  if (value === null || value === '' || value === undefined) return null;
  const file = typeof value === 'string' ? await getMedia(env, value) : null;
  if (!file || file.owner_id !== userId || file.kind !== 'image' || file.status !== 'ready') fail(422, 'Upload an image first.');
  return file.id;
}

/** Deletes an old logo if nothing else uses the file. */
async function dropLogo(env: Env, id: string | null): Promise<void> {
  await deleteUnusedMedia(env, [id]);
}

function companyFields(input: Record<string, unknown>, partial: boolean) {
  const has = (k: string) => !partial || k in input;
  const out: Record<string, string> = {};
  if (has('name')) {
    const name = str(input.name, 80);
    if (name.length < 2) fail(422, 'Enter a company name.');
    out.name = name;
  }
  if (has('description')) out.description = str(input.description, 2000);
  if (has('website')) out.website = webAddress(input.website);
  if (has('industry')) out.industry = str(input.industry, 80);
  if (has('size')) out.size = oneOf(COMPANY_SIZES, input.size ?? '', 'Choose a company size.');
  if (has('location')) out.location = str(input.location, 100);
  return out;
}

careers.get('/companies', async c => {
  const viewer = c.get('user');
  const v = viewer?.id ?? '';
  const size = limit(c, 20, 50);
  const q = str(c.req.query('q'), 80);
  const mine = c.req.query('mine') === '1' && Boolean(viewer);
  const after = cursor(c);
  const where: string[] = [];
  const params: unknown[] = [v, v];
  if (q) { where.push("(co.name LIKE ? ESCAPE '\\' OR co.industry LIKE ? ESCAPE '\\')"); params.push(like(q), like(q)); }
  if (mine) { where.push('EXISTS (SELECT 1 FROM company_admins m WHERE m.company_id = co.id AND m.user_id = ?)'); params.push(v); }
  if (after) { where.push('co.id < ?'); params.push(after); }
  const { results } = await c.env.DB.prepare(`SELECT co.*, ${companyViewerColumns()} FROM companies co
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY co.id DESC LIMIT ?`)
    .bind(...params, size + 1).all<CompanyRow>();
  const p = page(results, size);
  return c.json({ items: p.items.map(co => companyJson(co, v)), next: p.next });
});

careers.post('/companies', async c => {
  const me = requireUser(c);
  const input = await body(c);
  const fields = companyFields(input, false);
  const slug = slugify(str(input.slug, 60) || fields.name);
  if (slug.length < 2 || RESERVED_SLUGS.has(slug)) fail(422, 'Choose a different address.');
  const owned = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM companies WHERE owner_id = ?').bind(me.id).first<{ n: number }>();
  if ((owned?.n ?? 0) >= MAX.companiesOwned) fail(422, `You can create up to ${MAX.companiesOwned} company pages.`);
  const logo = await logoId(c.env, me.id, input.logo_media_id);
  const id = newId();
  const now = Date.now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO companies (id, slug, name, description, website, industry, size, location, logo_media_id, owner_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, slug, fields.name, fields.description, fields.website, fields.industry, fields.size, fields.location, logo, me.id, now),
      c.env.DB.prepare('INSERT INTO company_admins (company_id, user_id, created_at) VALUES (?, ?, ?)').bind(id, me.id, now),
    ]);
  } catch (err) {
    if (String(err).includes('UNIQUE')) fail(409, 'That address is taken.');
    throw err;
  }
  track(c, 'social_company_created', { company_id: id, size: fields.size || null, has_logo: Boolean(logo) });
  return c.json({ company: await companyById(c.env, id, me.id) }, 201);
});

async function companyById(env: Env, id: string, viewerId: string | null) {
  const row = await env.DB.prepare(`SELECT co.*, ${companyViewerColumns()} FROM companies co WHERE co.id = ?`)
    .bind(viewerId ?? '', viewerId ?? '', id).first<CompanyRow>();
  return row ? companyJson(row, viewerId) : null;
}

/** The company by slug, with the viewer's relationship to it. */
async function loadCompany(c: Ctx): Promise<CompanyRow> {
  const v = c.get('user')?.id ?? '';
  const row = await c.env.DB.prepare(`SELECT co.*, ${companyViewerColumns()} FROM companies co WHERE co.slug = ?`)
    .bind(v, v, c.req.param('slug')).first<CompanyRow>();
  if (!row) fail(404, 'Company not found.');
  return row;
}

async function adminList(env: Env, companyId: string) {
  const { results } = await env.DB.prepare(`SELECT ${u('x')} FROM company_admins ad JOIN users x ON x.id = ad.user_id
      WHERE ad.company_id = ? ORDER BY ad.created_at LIMIT 50`).bind(companyId).all<UserRow>();
  return results.map(userCard);
}

careers.get('/companies/:slug', async c => {
  const viewer = c.get('user');
  const co = await loadCompany(c);
  const [employees, counts, admins] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT ${u('x')}, x.headline, MIN(e.title) AS title FROM experiences e JOIN users x ON x.id = e.user_id
        WHERE e.company_id = ? AND e.end_month IS NULL GROUP BY x.id ORDER BY MIN(e.start_month) LIMIT 30`).bind(co.id),
    c.env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM jobs WHERE company_id = ?1 AND status = 'open') AS open_jobs,
        (SELECT COUNT(DISTINCT user_id) FROM experiences WHERE company_id = ?1 AND end_month IS NULL) AS employees`).bind(co.id),
    c.env.DB.prepare(`SELECT ${u('x')} FROM company_admins ad JOIN users x ON x.id = ad.user_id
        WHERE ad.company_id = ? ORDER BY ad.created_at LIMIT 50`).bind(co.id),
  ]);
  const n = (counts.results[0] ?? {}) as { open_jobs?: number; employees?: number };
  return c.json({
    company: { ...companyJson(co, viewer?.id ?? null), open_job_count: n.open_jobs ?? 0, employee_count: n.employees ?? 0 },
    employees: (employees.results as (UserRow & { headline: string; title: string })[])
      .map(r => ({ ...userCard(r), headline: r.headline, title: r.title })),
    admins: (admins.results as UserRow[]).map(userCard),
  });
});

careers.patch('/companies/:slug', async c => {
  const me = requireUser(c);
  const co = await loadCompany(c);
  if (!co.is_admin) fail(403, 'Only company admins can edit this page.');
  const input = await body(c);
  const fields: Record<string, string | null> = companyFields(input, true);
  let oldLogo: string | null = null;
  if ('logo_media_id' in input) {
    const next = await logoId(c.env, me.id, input.logo_media_id);
    if (next !== co.logo_media_id) { fields.logo_media_id = next; oldLogo = co.logo_media_id; }
  }
  const keys = Object.keys(fields);
  if (keys.length) {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE companies SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map(k => fields[k]), co.id),
      // Keep the name on linked roles in step.
      ...(fields.name ? [c.env.DB.prepare('UPDATE experiences SET company_name = ? WHERE company_id = ?').bind(fields.name, co.id)] : []),
    ]);
  }
  if (oldLogo) await dropLogo(c.env, oldLogo);
  return c.json({ company: await companyById(c.env, co.id, me.id) });
});

careers.put('/companies/:slug/follow', async c => {
  const me = requireUser(c);
  const co = await loadCompany(c);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE companies SET follower_count = follower_count + 1 WHERE id = ?1
      AND NOT EXISTS (SELECT 1 FROM company_follows WHERE company_id = ?1 AND user_id = ?2)`).bind(co.id, me.id),
    c.env.DB.prepare('INSERT OR IGNORE INTO company_follows (company_id, user_id, created_at) VALUES (?, ?, ?)').bind(co.id, me.id, Date.now()),
  ]);
  const row = await c.env.DB.prepare('SELECT follower_count FROM companies WHERE id = ?').bind(co.id).first<{ follower_count: number }>();
  track(c, 'social_company_followed', { company_id: co.id });
  return c.json({ is_following: true, follower_count: row?.follower_count ?? 0 });
});

careers.delete('/companies/:slug/follow', async c => {
  const me = requireUser(c);
  const co = await loadCompany(c);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE companies SET follower_count = MAX(0, follower_count - 1) WHERE id = ?1
      AND EXISTS (SELECT 1 FROM company_follows WHERE company_id = ?1 AND user_id = ?2)`).bind(co.id, me.id),
    c.env.DB.prepare('DELETE FROM company_follows WHERE company_id = ? AND user_id = ?').bind(co.id, me.id),
  ]);
  const row = await c.env.DB.prepare('SELECT follower_count FROM companies WHERE id = ?').bind(co.id).first<{ follower_count: number }>();
  track(c, 'social_company_unfollowed', { company_id: co.id });
  return c.json({ is_following: false, follower_count: row?.follower_count ?? 0 });
});

careers.put('/companies/:slug/admins/:handle', async c => {
  const me = requireUser(c);
  const co = await loadCompany(c);
  if (!co.is_admin) fail(403, 'Only company admins can add admins.');
  const them = await personByHandle(c.env, c.req.param('handle'));
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM company_admins WHERE company_id = ?').bind(co.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 50) fail(422, 'A company can have up to 50 admins.');
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO company_admins (company_id, user_id, created_at) VALUES (?, ?, ?)').bind(co.id, them.id, now),
    c.env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, body, link, created_at)
      SELECT ?, ?, ?, 'system', ?, ?, ? WHERE changes() > 0 AND ? != ?`)
      .bind(newId(now), them.id, me.id, `${me.name} made you an admin of ${co.name}.`, `/jobs?company=${co.slug}`, now, them.id, me.id),
  ]);
  return c.json({ admins: await adminList(c.env, co.id) });
});

careers.delete('/companies/:slug/admins/:handle', async c => {
  const me = requireUser(c);
  const co = await loadCompany(c);
  const them = await personByHandle(c.env, c.req.param('handle'));
  if (them.id === co.owner_id) fail(422, 'The owner is always an admin.');
  if (co.owner_id !== me.id && them.id !== me.id) fail(403, 'Only the owner can remove admins.');
  await c.env.DB.prepare('DELETE FROM company_admins WHERE company_id = ? AND user_id = ?').bind(co.id, them.id).run();
  return c.json({ admins: await adminList(c.env, co.id) });
});

careers.get('/me/companies', async c => {
  const me = requireUser(c);
  const { results } = await c.env.DB.prepare(`SELECT co.*, ${companyViewerColumns()} FROM company_admins m JOIN companies co ON co.id = m.company_id
      WHERE m.user_id = ? ORDER BY co.name COLLATE NOCASE LIMIT 50`).bind(me.id, me.id, me.id).all<CompanyRow>();
  return c.json({ items: results.map(co => companyJson(co, me.id)) });
});

// -- Jobs ------------------------------------------------------------------

interface JobRow {
  id: string; company_id: string; poster_id: string | null; title: string; location: string;
  workplace: string; employment_type: string; salary_min: number | null; salary_max: number | null; currency: string;
  description: string; apply_url: string | null; status: 'open' | 'closed'; applicant_count: number;
  created_at: number; updated_at: number; closed_at: number | null;
  c_slug: string; c_name: string; c_logo: string | null; c_location: string;
  saved: number; application_status: string | null; can_manage: number;
}

/** Job columns joined with the company and the viewer's saved/applied/manage state. Binds (viewer, viewer, viewer). */
const jobSelect = `SELECT j.*, co.slug AS c_slug, co.name AS c_name, co.logo_media_id AS c_logo, co.location AS c_location, co.industry AS c_industry,
    EXISTS (SELECT 1 FROM saved_jobs s WHERE s.job_id = j.id AND s.user_id = ?1) AS saved,
    (SELECT a.status FROM job_applications a WHERE a.job_id = j.id AND a.user_id = ?1) AS application_status,
    (j.poster_id = ?1 OR EXISTS (SELECT 1 FROM company_admins ad WHERE ad.company_id = j.company_id AND ad.user_id = ?1)) AS can_manage
  FROM jobs j JOIN companies co ON co.id = j.company_id`;

const jobCard = (j: JobRow) => ({
  id: j.id,
  title: j.title,
  company: { id: j.company_id, slug: j.c_slug, name: j.c_name, logo_url: logoUrl(j.c_logo) },
  location: j.location,
  workplace: j.workplace,
  employment_type: j.employment_type,
  salary_min: j.salary_min,
  salary_max: j.salary_max,
  currency: j.currency,
  status: j.status,
  applicant_count: j.applicant_count,
  created_at: j.created_at,
  saved: Boolean(j.saved),
  application_status: j.application_status,
  can_manage: Boolean(j.can_manage),
});
type JobCard = ReturnType<typeof jobCard>;

async function loadJob(c: Ctx, id = c.req.param('id')): Promise<JobRow> {
  const v = c.get('user')?.id ?? '';
  const row = await c.env.DB.prepare(`${jobSelect} WHERE j.id = ?2`).bind(v, id).first<JobRow>();
  if (!row) fail(404, 'Job not found.');
  return row;
}

async function jobJson(env: Env, j: JobRow) {
  const [company, poster] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind(j.company_id),
    env.DB.prepare(`SELECT ${userCardColumns}, headline FROM users WHERE id = ?`).bind(j.poster_id ?? ''),
  ]);
  const co = company.results[0] as CompanyRow | undefined;
  const p = poster.results[0] as (UserRow & { headline: string }) | undefined;
  return {
    ...jobCard(j),
    description: j.description,
    apply_url: j.apply_url,
    updated_at: j.updated_at,
    closed_at: j.closed_at,
    company: co ? companyPublic(co) : jobCard(j).company,
    poster: p ? { ...userCard(p), headline: p.headline } : null,
  };
}

function jobFields(input: Record<string, unknown>, existing?: JobRow) {
  const has = (k: string) => !existing || k in input;
  const out: Record<string, string | number | null> = {};
  if (has('title')) out.title = required(input.title, 100, 'Enter a job title.');
  if (has('location')) out.location = str(input.location, 100);
  if (has('workplace')) out.workplace = oneOf(WORKPLACES, input.workplace, 'Choose on-site, hybrid or remote.', 'onsite');
  if (has('employment_type')) out.employment_type = oneOf(JOB_TYPES, input.employment_type, 'Choose an employment type.', 'full_time');
  if (has('salary_min')) out.salary_min = money(input.salary_min, 'Minimum salary');
  if (has('salary_max')) out.salary_max = money(input.salary_max, 'Maximum salary');
  if (has('description')) {
    if (typeof input.description === 'string' && input.description.trim().length > 10000) fail(422, 'Descriptions are limited to 10,000 characters.');
    out.description = str(input.description, 10000);
  }
  if (has('apply_url')) out.apply_url = webAddress(input.apply_url) || null;
  const min = out.salary_min !== undefined ? out.salary_min : existing?.salary_min;
  const max = out.salary_max !== undefined ? out.salary_max : existing?.salary_max;
  if (min != null && max != null && Number(max) < Number(min)) fail(422, 'The maximum salary is below the minimum.');
  return out;
}

const CARD_PAGE = 20;

careers.get('/jobs', async c => {
  const v = c.get('user')?.id ?? '';
  const size = limit(c, CARD_PAGE, 50);
  const where = ["j.status = 'open'"];
  const params: unknown[] = [];
  const words = str(c.req.query('q'), 100).split(/\s+/).filter(Boolean).slice(0, 5);
  for (const w of words) {
    where.push(`(j.title LIKE ? ESCAPE '\\' OR j.description LIKE ? ESCAPE '\\' OR co.name LIKE ? ESCAPE '\\')`);
    params.push(like(w), like(w), like(w));
  }
  const location = str(c.req.query('location'), 100);
  if (location) { where.push(`j.location LIKE ? ESCAPE '\\'`); params.push(like(location)); }
  const workplace = c.req.query('workplace');
  if (workplace) { where.push('j.workplace = ?'); params.push(oneOf(WORKPLACES, workplace, 'Unknown workplace.')); }
  const type = c.req.query('type');
  if (type) { where.push('j.employment_type = ?'); params.push(oneOf(JOB_TYPES, type, 'Unknown employment type.')); }
  const company = str(c.req.query('company'), 60);
  if (company) { where.push('co.slug = ?'); params.push(company); }
  const after = cursor(c);
  if (after) { where.push('j.id < ?'); params.push(after); }
  // jobSelect uses ?1 for the viewer; number the rest after it.
  let n = 1;
  const sql = `${jobSelect} WHERE ${where.join(' AND ').replace(/\?(?!\d)/g, () => `?${++n}`)} ORDER BY j.id DESC LIMIT ?${++n}`;
  const { results } = await c.env.DB.prepare(sql).bind(v, ...params, size + 1).all<JobRow>();
  const p = page(results, size);
  return c.json({ items: p.items.map(jobCard), next: p.next });
});

careers.post('/jobs', async c => {
  const me = requireUser(c);
  const input = await body(c);
  const companyKey = str(input.company_id, 60);
  const co = companyKey ? await c.env.DB.prepare(`SELECT co.id, co.name,
      EXISTS (SELECT 1 FROM company_admins ad WHERE ad.company_id = co.id AND ad.user_id = ?) AS is_admin
      FROM companies co WHERE co.id = ? OR co.slug = ?`).bind(me.id, companyKey, companyKey).first<{ id: string; name: string; is_admin: number }>() : null;
  if (!co) fail(422, 'Choose a company.');
  if (!co.is_admin) fail(403, 'Only company admins can post jobs.');
  const f = jobFields(input);
  const open = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE company_id = ? AND status = 'open'`).bind(co.id).first<{ n: number }>();
  if ((open?.n ?? 0) >= 100) fail(422, 'A company can have up to 100 open jobs.');
  const id = newId();
  const now = Date.now();
  await c.env.DB.prepare(`INSERT INTO jobs (id, company_id, poster_id, title, location, workplace, employment_type, salary_min, salary_max,
      currency, description, apply_url, status, applicant_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUD', ?, ?, 'open', 0, ?, ?)`)
    .bind(id, co.id, me.id, f.title, f.location, f.workplace, f.employment_type, f.salary_min, f.salary_max, f.description, f.apply_url, now, now).run();
  track(c, 'social_job_posted', { job_id: id, company_id: co.id, workplace: f.workplace, employment_type: f.employment_type, has_salary: f.salary_min != null || f.salary_max != null, external_apply: Boolean(f.apply_url) });
  return c.json({ job: await jobJson(c.env, await loadJob(c, id)) }, 201);
});

careers.get('/jobs/:id', async c => c.json({ job: await jobJson(c.env, await loadJob(c)) }));

async function manageJob(c: Ctx): Promise<{ me: SessionUser; job: JobRow }> {
  const me = requireUser(c);
  const job = await loadJob(c);
  if (!job.can_manage) fail(403, 'Only the poster and company admins can manage this job.');
  return { me, job };
}

careers.patch('/jobs/:id', async c => {
  const { job } = await manageJob(c);
  const input = await body(c);
  const f = jobFields(input, job);
  if ('status' in input) {
    const status = oneOf(['open', 'closed'] as const, input.status, 'Choose open or closed.');
    if (status !== job.status) { f.status = status; f.closed_at = status === 'closed' ? Date.now() : null; }
  }
  const keys = Object.keys(f);
  if (keys.length) {
    await c.env.DB.prepare(`UPDATE jobs SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map(k => f[k]), Date.now(), job.id).run();
  }
  return c.json({ job: await jobJson(c.env, await loadJob(c)) });
});

careers.post('/jobs/:id/close', async c => {
  const { job } = await manageJob(c);
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE jobs SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'`).bind(now, now, job.id).run();
  if (job.status === 'open') track(c, 'social_job_closed', { job_id: job.id, applicant_count: job.applicant_count });
  return c.json({ job: await jobJson(c.env, await loadJob(c)) });
});

careers.put('/jobs/:id/save', async c => {
  const me = requireUser(c);
  const job = await loadJob(c);
  await c.env.DB.prepare('INSERT OR IGNORE INTO saved_jobs (user_id, job_id, created_at) VALUES (?, ?, ?)').bind(me.id, job.id, Date.now()).run();
  track(c, 'social_job_saved', { job_id: job.id });
  return c.json({ saved: true });
});

careers.delete('/jobs/:id/save', async c => {
  const me = requireUser(c);
  await c.env.DB.prepare('DELETE FROM saved_jobs WHERE user_id = ? AND job_id = ?').bind(me.id, c.req.param('id')).run();
  return c.json({ saved: false });
});

interface ApplicationRow {
  id: string; job_id: string; user_id: string; note: string; status: string; created_at: number; updated_at: number;
  [key: string]: unknown;
}

const applicationJson = (a: ApplicationRow) => ({
  id: a.id, job_id: a.job_id, note: a.note, status: a.status, created_at: a.created_at, updated_at: a.updated_at,
});

careers.post('/jobs/:id/apply', async c => {
  const me = requireUser(c);
  const job = await loadJob(c);
  if (job.status !== 'open') fail(422, 'This job is no longer taking applications.');
  if (job.apply_url) fail(422, 'Apply for this job on the company site.');
  if (job.can_manage) fail(422, 'You cannot apply for a job you manage.');
  const note = str((await body(c)).note, 2000);
  const id = newId();
  const now = Date.now();
  const [inserted] = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR IGNORE INTO job_applications (id, job_id, user_id, note, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'submitted', ?, ?)`).bind(id, job.id, me.id, note, now, now),
    c.env.DB.prepare('UPDATE jobs SET applicant_count = applicant_count + 1 WHERE id = ? AND changes() > 0').bind(job.id),
    c.env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, body, link, created_at)
      SELECT ?, ?, ?, 'system', ?, ?, ? WHERE changes() > 0 AND ? IS NOT NULL AND ? != ?`)
      .bind(newId(now), job.poster_id, me.id, `${me.name} applied for ${job.title}.`, `/jobs/${job.id}`, now, job.poster_id, job.poster_id, me.id),
  ]);
  if (!inserted.meta.changes) fail(409, 'You have already applied for this job.');
  track(c, 'social_job_applied', { job_id: job.id, application_id: id, has_note: Boolean(note) });
  const row = await c.env.DB.prepare('SELECT * FROM job_applications WHERE id = ?').bind(id).first<ApplicationRow>();
  return c.json({ application: applicationJson(row!) }, 201);
});

careers.delete('/jobs/:id/apply', async c => {
  const me = requireUser(c);
  const jobId = c.req.param('id');
  const [deleted] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM job_applications WHERE job_id = ? AND user_id = ?').bind(jobId, me.id),
    c.env.DB.prepare('UPDATE jobs SET applicant_count = MAX(0, applicant_count - 1) WHERE id = ? AND changes() > 0').bind(jobId),
  ]);
  if (!deleted.meta.changes) fail(404, 'Application not found.');
  track(c, 'social_job_application_withdrawn', { job_id: jobId });
  return c.json({ ok: true });
});

careers.get('/jobs/:id/applications', async c => {
  const { job } = await manageJob(c);
  const size = limit(c, 20, 50);
  const status = c.req.query('status') ? oneOf(APPLICATION_STATUSES, c.req.query('status'), 'Unknown status.') : null;
  const after = cursor(c);
  const params: unknown[] = [job.id];
  if (status) params.push(status);
  if (after) params.push(after);
  const [list, counts] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT a.*, ${u('x', 'x_')}, x.headline AS x_headline, x.open_to_work AS x_open, x.location AS x_location
        FROM job_applications a JOIN users x ON x.id = a.user_id
        WHERE a.job_id = ? ${status ? 'AND a.status = ?' : ''} ${after ? 'AND a.id < ?' : ''} ORDER BY a.id DESC LIMIT ?`)
      .bind(...params, size + 1),
    c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM job_applications WHERE job_id = ? GROUP BY status').bind(job.id),
  ]);
  const p = page(list.results as ApplicationRow[], size);
  const tally: Record<string, number> = { submitted: 0, viewed: 0, shortlisted: 0, rejected: 0 };
  for (const r of counts.results as { status: string; n: number }[]) tally[r.status] = r.n;
  return c.json({
    items: p.items.map(a => ({
      ...applicationJson(a),
      user: { ...prefixedCard(a, 'x_'), headline: a.x_headline as string, open_to_work: Boolean(a.x_open), location: a.x_location as string },
    })),
    next: p.next,
    counts: tally,
  });
});

const STATUS_MESSAGES: Record<string, (title: string, company: string) => string> = {
  submitted: (t, co) => `Your application for ${t} at ${co} is back under review.`,
  viewed: (t, co) => `Your application for ${t} at ${co} was viewed.`,
  shortlisted: (t, co) => `You have been shortlisted for ${t} at ${co}.`,
  rejected: (t, co) => `Your application for ${t} at ${co} was not successful.`,
};

careers.patch('/applications/:id', async c => {
  requireUser(c);
  const app = await c.env.DB.prepare('SELECT * FROM job_applications WHERE id = ?').bind(c.req.param('id')).first<ApplicationRow>();
  if (!app) fail(404, 'Application not found.');
  const job = await loadJob(c, app.job_id);
  if (!job.can_manage) fail(404, 'Application not found.');
  const status = oneOf(APPLICATION_STATUSES, (await body(c)).status, 'Choose a status.');
  if (status !== app.status) {
    const now = Date.now();
    await c.env.DB.prepare('UPDATE job_applications SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, app.id).run();
    await notify(c.env, { userId: app.user_id, actorId: null, type: 'system', body: STATUS_MESSAGES[status](job.title, job.c_name), link: `/jobs/${job.id}` });
    track(c, 'social_job_application_reviewed', { application_id: app.id, job_id: job.id, from_status: app.status, status });
    app.status = status;
    app.updated_at = now;
  }
  return c.json({ application: applicationJson(app) });
});

// -- The signed-in user's lists --------------------------------------------

/** "<ms>.<id>" keyset cursor for lists ordered by a timestamp. */
function timeCursor(c: Ctx): [number, string] | null {
  const m = cursor(c)?.match(/^(\d+)\.(\w+)$/);
  return m ? [Number(m[1]), m[2]] : null;
}

careers.get('/me/applications', async c => {
  const me = requireUser(c);
  const size = limit(c, 20, 50);
  const after = cursor(c);
  const { results } = await c.env.DB.prepare(`SELECT a.id AS app_id, a.note AS app_note, a.status AS app_status,
        a.created_at AS app_created, a.updated_at AS app_updated, sub.*
      FROM job_applications a JOIN (${jobSelect}) sub ON sub.id = a.job_id
      WHERE a.user_id = ?1 ${after ? 'AND a.id < ?3' : ''} ORDER BY a.id DESC LIMIT ?2`)
    .bind(me.id, size + 1, ...(after ? [after] : [])).all<JobRow & { app_id: string; app_note: string; app_status: string; app_created: number; app_updated: number }>();
  const slice = results.slice(0, size);
  return c.json({
    items: slice.map(r => ({
      id: r.app_id, job_id: r.id, note: r.app_note, status: r.app_status, created_at: r.app_created, updated_at: r.app_updated,
      job: jobCard(r),
    })),
    next: results.length > size ? slice[slice.length - 1].app_id : null,
  });
});

careers.get('/me/saved', async c => {
  const me = requireUser(c);
  const size = limit(c, 20, 50);
  const after = timeCursor(c);
  const { results } = await c.env.DB.prepare(`SELECT sv.created_at AS saved_at, sub.* FROM saved_jobs sv JOIN (${jobSelect}) sub ON sub.id = sv.job_id
      WHERE sv.user_id = ?1 ${after ? 'AND (sv.created_at < ?3 OR (sv.created_at = ?3 AND sv.job_id < ?4))' : ''}
      ORDER BY sv.created_at DESC, sv.job_id DESC LIMIT ?2`)
    .bind(me.id, size + 1, ...(after ?? [])).all<JobRow & { saved_at: number }>();
  const slice = results.slice(0, size);
  const last = slice[slice.length - 1];
  return c.json({ items: slice.map(jobCard), next: results.length > size && last ? `${last.saved_at}.${last.id}` : null });
});

careers.get('/me/jobs', async c => {
  const me = requireUser(c);
  const size = limit(c, 20, 50);
  const after = cursor(c);
  const { results } = await c.env.DB.prepare(`${jobSelect} WHERE (j.poster_id = ?1
        OR EXISTS (SELECT 1 FROM company_admins ad WHERE ad.company_id = j.company_id AND ad.user_id = ?1))
      ${after ? 'AND j.id < ?3' : ''} ORDER BY j.id DESC LIMIT ?2`)
    .bind(me.id, size + 1, ...(after ? [after] : [])).all<JobRow>();
  const p = page(results, size);
  return c.json({ items: p.items.map(jobCard), next: p.next });
});

// -- Recommended jobs ------------------------------------------------------

const STOPWORDS = new Set(('the and for with from into your you our are was were has have had not but who what when where how all any ' +
  'can will just about over more most some such than that this these those their them they its it\'s at of on in to by an a ' +
  'senior junior lead head principal staff open work looking new role roles job jobs team manager specialist officer').split(' '));

careers.get('/recommended', async c => {
  const me = requireUser(c);
  const [profile, skills, current] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT headline, location FROM users WHERE id = ?').bind(me.id),
    c.env.DB.prepare('SELECT name FROM skills WHERE user_id = ? ORDER BY position LIMIT 8').bind(me.id),
    c.env.DB.prepare('SELECT title, location FROM experiences WHERE user_id = ? ORDER BY (end_month IS NULL) DESC, position LIMIT 1').bind(me.id),
  ]);
  const p = (profile.results[0] ?? {}) as { headline?: string; location?: string };
  const role = (current.results[0] ?? {}) as { title?: string; location?: string };
  const words = (text = '') => text.toLowerCase().split(/[^\p{L}\p{N}+#.]+/u).map(w => w.replace(/^\.+|\.+$/g, ''))
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
  const terms = [...new Set([
    ...(skills.results as { name: string }[]).map(s => s.name.toLowerCase()).filter(s => s.length >= 2),
    ...words(p.headline),
    ...words(role.title),
  ])].slice(0, 12);
  const location = ((p.location || role.location || '').split(',')[0] || '').trim();
  if (!terms.length) return c.json({ items: [], basis: { terms, location } });
  // ?1 viewer, ?2 location pattern, ?3 limit, ?4… terms.
  const score = terms.map((_, i) => `(CASE WHEN sub.title LIKE ?${i + 4} ESCAPE '\\' THEN 3
      WHEN sub.description LIKE ?${i + 4} ESCAPE '\\' OR sub.c_industry LIKE ?${i + 4} ESCAPE '\\' THEN 1 ELSE 0 END)`).join(' + ');
  const { results } = await c.env.DB.prepare(`SELECT * FROM (SELECT sub.*, (${score}) AS term_score,
        (CASE WHEN ?2 != '' AND sub.location LIKE ?2 ESCAPE '\\' THEN 2 WHEN sub.workplace = 'remote' THEN 1 ELSE 0 END) AS place_score
      FROM (${jobSelect} WHERE j.status = 'open') sub)
    WHERE term_score > 0 AND application_status IS NULL AND can_manage = 0
    ORDER BY term_score + place_score DESC, id DESC LIMIT ?3`)
    .bind(me.id, location ? like(location) : '', CARD_PAGE, ...terms.map(like)).all<JobRow>();
  const items: JobCard[] = results.map(jobCard);
  return c.json({ items, basis: { terms, location } });
});

export default careers;
