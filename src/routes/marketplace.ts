// Marketplace (Facebook Marketplace / Gumtree). Mounted at /api/marketplace. Tables: migrations/0010_marketplace.sql.
// Prices and amounts are whole cents (AUD); 0 is "Free".
//
// Listings
//   GET    /                          ?q&category&condition&min_price&max_price&location&seller=<handle>&include_sold=1
//                                     &sort=newest|price_low|price_high&cursor&limit -> { items: ListingCard[], next }
//                                     (sold listings are left out unless include_sold=1)
//   POST   /                          { title, description, price, negotiable, category, condition, location, pickup, postage,
//                                       photo_ids: [1..10] } -> 201 { listing }   (checks saved searches and notifies matches)
//   GET    /saved                     ?cursor -> { items: ListingCard[], next }   (newest save first)
//   GET    /mine                      ?status=available|pending|sold&cursor -> { items: ListingCard[], next, counts: { available, pending, sold } }
//   GET    /searches                  -> { items: SavedSearch[] }
//   POST   /searches                  { q?, category?, condition?, min_price?, max_price?, location? } -> 201 { search }
//   PATCH  /searches/:id              same fields -> { search }
//   GET    /sellers/:handle           -> { seller: UserCard, rating, listing_count, sold_count, reviews: Review[] }
//                                     (listings: GET /?seller=<handle>&include_sold=1)
//   GET    /:id                       -> { listing: Listing }   (counts one view per viewer per day; not the seller's)
//   PATCH  /:id                       seller: any create fields -> { listing }   (photo_ids replaces the photos)
//   PUT    /:id/photos                seller: { ids: [...] } (new order, may add or drop) -> { listing }
//   PUT    /:id/save, DELETE /:id/save -> { saved, save_count }
//   POST   /:id/status                seller: { status: available|pending|sold, buyer?: handle|null } -> { listing }
//                                     (the buyer must have made an offer or messaged the seller; locked once reviewed)
// Offers
//   GET    /:id/offers                seller: every offer; anyone else: their own -> { items: Offer[] }
//   POST   /:id/offers                { amount, message? } -> 201 { offer }   (replaces your earlier pending offer; notifies the seller)
//   POST   /:id/offers/:offerId/accept   seller -> { offer, listing }   (listing becomes pending to that buyer)
//   POST   /:id/offers/:offerId/decline  seller -> { offer }
//   DELETE /:id/offers/:offerId          buyer withdraws a pending offer -> { offer }
// Reviews (after a sale, between the seller and the buyer it was sold to)
//   PUT    /:id/review                { rating: 1..5, comment? } -> { review }   (one each per listing; editable)
//
// ListingCard: { id, title, price, negotiable, category, condition, location, status, photo_url, created_at, saved }
// Listing: ListingCard + { description, pickup, postage, photos: [{ id, url, width, height }], view_count, save_count,
//          updated_at, sold_at, seller: UserCard + { rating: { average, count } }, buyer: UserCard|null (seller and buyer only),
//          reviews: Review[], viewer: { is_owner, is_buyer, offer: Offer|null, can_review, review: Review|null } }
// Offer: { id, listing_id, buyer: UserCard, amount, message, status: pending|accepted|declined|withdrawn, created_at, responded_at }
// Review: { id, listing: { id, title }, reviewer: UserCard, reviewee_id, role: buyer|seller (the reviewee's part), rating,
//           comment, created_at, updated_at }
// SavedSearch: { id, q, category, condition, min_price, max_price, location, created_at }
//
// Notifications are type 'system' with a `link` to the listing.

import { Hono } from 'hono';
import type { AppEnv, Ctx, Env, SessionUser } from '../env';
import { body, cursor, fail, limit, requireUser, str } from '../lib/http';
import { newId, sha256 } from '../lib/ids';
import { deleteUnusedMedia, ownedReadyMedia } from '../lib/media';
import { notifyStatement } from '../lib/notify';
import { track } from '../lib/palantir';
import { userByHandle, userCard, userCardColumns, type UserRow } from '../lib/users';

const marketplace = new Hono<AppEnv>();

export const CATEGORIES = ['electronics', 'furniture', 'home_garden', 'clothing', 'vehicles', 'sport_outdoors', 'books', 'toys', 'other'] as const;
export const CONDITIONS = ['new', 'like_new', 'good', 'fair', 'for_parts'] as const;
const STATUSES = ['available', 'pending', 'sold'] as const;
type Status = (typeof STATUSES)[number];

const MAX_TITLE = 100;
const MAX_DESCRIPTION = 5000;
const MAX_LOCATION = 80;
const MAX_PRICE = 1_000_000_000; // $10 million, in cents
const MAX_PHOTOS = 10;
const MAX_MESSAGE = 500;
const MAX_COMMENT = 500;
const MAX_QUERY = 100;
const MAX_SEARCHES = 20;
const MAX_LISTINGS_PER_DAY = 50;
const SEARCH_SCAN = 500; // saved searches looked at per new listing
const SEARCH_NOTIFY = 50; // notifications sent per new listing, at most
const DAY = 86400000;

interface ListingRow {
  id: string;
  seller_id: string;
  title: string;
  description: string;
  price: number;
  negotiable: number;
  category: string;
  condition: string;
  location: string;
  pickup: number;
  postage: number;
  status: Status;
  buyer_id: string | null;
  sold_at: number | null;
  view_count: number;
  save_count: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface CardRow extends Pick<ListingRow, 'id' | 'seller_id' | 'title' | 'price' | 'negotiable' | 'category' | 'condition' | 'location' | 'status' | 'created_at'> {
  photo_id: string | null;
  saved: number;
  save_at?: number;
}

// -- Shared bits -----------------------------------------------------------

const u = (alias: string, prefix: string) =>
  userCardColumns.split(', ').map(col => `${alias}.${col} AS ${prefix}${col}`).join(', ');

/** Pulls a prefixed user card out of a joined row (`s_id`, `s_handle`, …), or null. */
const prefixedCard = (row: Record<string, unknown>, prefix: string) => row[`${prefix}id`] ? userCard({
  id: row[`${prefix}id`] as string,
  handle: row[`${prefix}handle`] as string,
  name: row[`${prefix}name`] as string,
  avatar_media_id: row[`${prefix}avatar_media_id`] as string | null,
  identity_picture: row[`${prefix}identity_picture`] as string | null,
  verified: row[`${prefix}verified`] as number,
}) : null;

/** "$120", "$12.50" or "Free". */
export const priceText = (cents: number) => cents === 0 ? 'Free'
  : `$${(cents / 100).toLocaleString('en-AU', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

const BLOCKED = (alias: string) => `EXISTS (SELECT 1 FROM blocks bk WHERE (bk.blocker_id = ? AND bk.blocked_id = ${alias})
  OR (bk.blocker_id = ${alias} AND bk.blocked_id = ?))`;

/** Columns for a listing tile. Binds one parameter (the viewer id, for `saved`). */
const CARD_COLUMNS = `l.id, l.seller_id, l.title, l.price, l.negotiable, l.category, l.condition, l.location, l.status, l.created_at,
  (SELECT p.media_id FROM marketplace_photos p WHERE p.listing_id = l.id ORDER BY p.position LIMIT 1) AS photo_id,
  EXISTS (SELECT 1 FROM marketplace_saves sv WHERE sv.listing_id = l.id AND sv.user_id = ?) AS saved`;

const cardJson = (r: CardRow) => ({
  id: r.id,
  title: r.title,
  price: r.price,
  negotiable: Boolean(r.negotiable),
  category: r.category,
  condition: r.condition,
  location: r.location,
  status: r.status,
  photo_url: r.photo_id ? `/media/${r.photo_id}` : null,
  created_at: r.created_at,
  saved: Boolean(r.saved),
});
export type ListingCard = ReturnType<typeof cardJson>;

/** Integer cents within range, or undefined if missing. Throws on anything else. */
function cents(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_PRICE) fail(422, `${label} must be a whole number of cents.`);
  return n;
}

/** Text that must fit; too long is an error rather than a silent cut. */
function text(value: unknown, max: number, message: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length > max) fail(422, message);
  return s;
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null;

/** Words of a search, lower case, at most six. */
const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
const likeEscape = (s: string) => `%${s.replace(/[\\%_]/g, m => `\\${m}`)}%`;

async function viewerKey(c: Ctx, user: SessionUser | null): Promise<string> {
  if (user) return user.id;
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'local';
  return `anon:${(await sha256(ip)).slice(0, 22)}`;
}

/** The listing row (not deleted) or a 404. */
async function getListing(env: Env, id: string): Promise<ListingRow> {
  const row = await env.DB.prepare('SELECT * FROM marketplace_listings WHERE id = ? AND deleted_at IS NULL').bind(id).first<ListingRow>();
  if (!row) fail(404, 'Listing not found.');
  return row;
}

async function ownListing(c: Ctx, user: SessionUser): Promise<ListingRow> {
  const row = await getListing(c.env, c.req.param('id')!);
  if (row.seller_id !== user.id) fail(403, 'Only the seller can do that.');
  return row;
}

const isBlocked = async (env: Env, a: string, b: string) =>
  Boolean(await env.DB.prepare(`SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`)
    .bind(a, b, b, a).first());

// -- Listing fields --------------------------------------------------------

interface ListingFields {
  title?: string;
  description?: string;
  price?: number;
  negotiable?: number;
  category?: string;
  condition?: string;
  location?: string;
  pickup?: number;
  postage?: number;
}

/** Validates listing fields. With `partial`, only the fields present are checked and returned. */
function readFields(input: Record<string, unknown>, partial: boolean): ListingFields {
  const out: ListingFields = {};
  const has = (k: string) => !partial || k in input;
  if (has('title')) {
    out.title = text(input.title, MAX_TITLE, `Titles are limited to ${MAX_TITLE} characters.`);
    if (!out.title) fail(422, 'Add a title.');
  }
  if (has('description')) out.description = text(input.description, MAX_DESCRIPTION, `Descriptions are limited to ${MAX_DESCRIPTION} characters.`);
  if (has('price')) {
    const p = cents(input.price, 'Price');
    if (p === undefined) fail(422, 'Add a price. Use 0 for free.');
    out.price = p;
  }
  if (has('negotiable')) out.negotiable = input.negotiable ? 1 : 0;
  if (has('category')) {
    const cat = oneOf(CATEGORIES, input.category);
    if (!cat) fail(422, 'Choose a category.');
    out.category = cat;
  }
  if (has('condition')) {
    const cond = oneOf(CONDITIONS, input.condition);
    if (!cond) fail(422, 'Choose a condition.');
    out.condition = cond;
  }
  if (has('location')) {
    out.location = text(input.location, MAX_LOCATION, `Locations are limited to ${MAX_LOCATION} characters.`);
    if (!out.location) fail(422, 'Add a suburb or postcode.');
  }
  if (has('pickup')) out.pickup = input.pickup ? 1 : 0;
  else if (!partial) out.pickup = 1;
  if (has('postage')) out.postage = input.postage ? 1 : 0;
  return out;
}

/** Checks photo ids: 1 to 10 distinct, finished images uploaded by `ownerId`. Returns them in order. */
async function readPhotos(env: Env, ownerId: string, value: unknown): Promise<string[]> {
  if (!Array.isArray(value) || !value.length) fail(422, 'Add at least one photo.');
  const ids = [...new Set(value.filter((x): x is string => typeof x === 'string'))];
  if (ids.length !== value.length) fail(422, 'Each photo can only be used once.');
  if (ids.length > MAX_PHOTOS) fail(422, `Listings can have up to ${MAX_PHOTOS} photos.`);
  let rows;
  try { rows = await ownedReadyMedia(env, ownerId, ids); } catch { fail(422, 'A photo is still uploading or is not yours.'); }
  if (rows.some(m => m.kind !== 'image')) fail(422, 'Only photos can be added to a listing.');
  return ids;
}

/** Statements that replace a listing's photos. */
const photoStatements = (env: Env, listingId: string, ids: string[]) => [
  env.DB.prepare('DELETE FROM marketplace_photos WHERE listing_id = ?').bind(listingId),
  ...ids.map((mediaId, i) => env.DB.prepare('INSERT INTO marketplace_photos (listing_id, media_id, position) VALUES (?, ?, ?)')
    .bind(listingId, mediaId, i)),
];

// -- Reviews and offers JSON -----------------------------------------------

const REVIEW_SELECT = `SELECT r.*, l.title AS l_title, ${u('rv', 'u_')}
  FROM marketplace_reviews r JOIN marketplace_listings l ON l.id = r.listing_id JOIN users rv ON rv.id = r.reviewer_id`;

const reviewJson = (r: Record<string, unknown>) => ({
  id: r.id as string,
  listing: { id: r.listing_id as string, title: r.l_title as string },
  reviewer: prefixedCard(r, 'u_'),
  reviewee_id: r.reviewee_id as string,
  role: r.role as 'buyer' | 'seller',
  rating: r.rating as number,
  comment: r.comment as string,
  created_at: r.created_at as number,
  updated_at: r.updated_at as number,
});
type ReviewJson = ReturnType<typeof reviewJson>;

const OFFER_SELECT = `SELECT o.*, ${u('b', 'u_')} FROM marketplace_offers o JOIN users b ON b.id = o.buyer_id`;

const offerJson = (r: Record<string, unknown>) => ({
  id: r.id as string,
  listing_id: r.listing_id as string,
  buyer: prefixedCard(r, 'u_'),
  amount: r.amount as number,
  message: r.message as string,
  status: r.status as 'pending' | 'accepted' | 'declined' | 'withdrawn',
  created_at: r.created_at as number,
  responded_at: (r.responded_at as number | null) ?? null,
});

const rating = (count: number, avg: number | null) => ({ count, average: count ? Math.round((avg ?? 0) * 10) / 10 : null });

// -- Full listing ----------------------------------------------------------

/** Loads everything the listing page needs (5 queries in one batch). Returns null if missing or blocked. */
async function loadListing(env: Env, id: string, viewer: SessionUser | null) {
  const vid = viewer?.id ?? '';
  const [main, photos, mine, reviews] = await env.DB.batch([
    env.DB.prepare(`SELECT l.*, ${u('s', 's_')}, ${u('b', 'b_')},
        EXISTS (SELECT 1 FROM marketplace_saves sv WHERE sv.listing_id = l.id AND sv.user_id = ?) AS saved,
        ${BLOCKED('l.seller_id')} AS blocked,
        (SELECT COUNT(*) FROM marketplace_reviews WHERE reviewee_id = l.seller_id) AS r_count,
        (SELECT AVG(rating) FROM marketplace_reviews WHERE reviewee_id = l.seller_id) AS r_avg
      FROM marketplace_listings l JOIN users s ON s.id = l.seller_id LEFT JOIN users b ON b.id = l.buyer_id
      WHERE l.id = ? AND l.deleted_at IS NULL`).bind(vid, vid, vid, id),
    env.DB.prepare(`SELECT m.id, m.width, m.height FROM marketplace_photos p JOIN media m ON m.id = p.media_id
      WHERE p.listing_id = ? ORDER BY p.position`).bind(id),
    env.DB.prepare(`${OFFER_SELECT} WHERE o.listing_id = ? AND o.buyer_id = ? ORDER BY o.id DESC LIMIT 1`).bind(id, vid),
    env.DB.prepare(`${REVIEW_SELECT} WHERE r.listing_id = ? ORDER BY r.id`).bind(id),
  ]);
  const row = (main.results as Record<string, unknown>[])[0] as (ListingRow & Record<string, unknown>) | undefined;
  if (!row || (viewer && row.blocked && row.seller_id !== viewer.id)) return null;
  const isOwner = Boolean(viewer && row.seller_id === viewer.id);
  const isBuyer = Boolean(viewer && row.buyer_id === viewer.id);
  const reviewList = (reviews.results as Record<string, unknown>[]).map(reviewJson);
  const myReview: ReviewJson | null = (viewer && reviewList.find(r => r.reviewer?.id === viewer.id)) || null;
  const offerRow = (mine.results as Record<string, unknown>[])[0];
  const seller = prefixedCard(row, 's_')!;
  return {
    ...cardJson({ ...row, photo_id: (photos.results as { id: string }[])[0]?.id ?? null, saved: row.saved as number }),
    description: row.description,
    pickup: Boolean(row.pickup),
    postage: Boolean(row.postage),
    photos: (photos.results as { id: string; width: number | null; height: number | null }[])
      .map(p => ({ id: p.id, url: `/media/${p.id}`, width: p.width, height: p.height })),
    view_count: row.view_count,
    save_count: row.save_count,
    updated_at: row.updated_at,
    sold_at: row.sold_at,
    seller: { ...seller, rating: rating(row.r_count as number, row.r_avg as number | null) },
    buyer: isOwner || isBuyer ? prefixedCard(row, 'b_') : null,
    reviews: reviewList,
    viewer: {
      is_owner: isOwner,
      is_buyer: isBuyer,
      offer: offerRow ? offerJson(offerRow) : null,
      can_review: Boolean(row.status === 'sold' && row.buyer_id && (isOwner || isBuyer)),
      review: myReview,
    },
  };
}

async function listingOr404(env: Env, id: string, viewer: SessionUser | null) {
  const listing = await loadListing(env, id, viewer);
  if (!listing) fail(404, 'Listing not found.');
  return listing;
}

// -- Saved searches ----------------------------------------------------------

interface SearchRow {
  id: string;
  user_id: string;
  q: string;
  category: string | null;
  condition: string | null;
  min_price: number | null;
  max_price: number | null;
  location: string;
  created_at: number;
}

const searchJson = (s: SearchRow) => ({
  id: s.id, q: s.q, category: s.category, condition: s.condition, min_price: s.min_price, max_price: s.max_price,
  location: s.location, created_at: s.created_at,
});

function readSearch(input: Record<string, unknown>) {
  const q = text(input.q, MAX_QUERY, `Searches are limited to ${MAX_QUERY} characters.`);
  const category = input.category ? oneOf(CATEGORIES, input.category) : null;
  if (input.category && !category) fail(422, 'Choose a category.');
  const condition = input.condition ? oneOf(CONDITIONS, input.condition) : null;
  if (input.condition && !condition) fail(422, 'Choose a condition.');
  const min = cents(input.min_price, 'Minimum price') ?? null;
  const max = cents(input.max_price, 'Maximum price') ?? null;
  if (min !== null && max !== null && min > max) fail(422, 'The minimum price is more than the maximum.');
  const location = text(input.location, MAX_LOCATION, `Locations are limited to ${MAX_LOCATION} characters.`);
  if (!q && !category && !condition && min === null && max === null && !location) fail(422, 'Add a search term or a filter.');
  return { q, category, condition, min_price: min, max_price: max, location };
}

/** Notifies people whose saved searches match a new listing. One query to find them, one batch to tell them. */
async function notifySavedSearches(env: Env, listing: ListingRow): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT s.id, s.user_id, s.q, s.location FROM marketplace_searches s
      WHERE s.user_id != ? AND (s.category IS NULL OR s.category = ?) AND (s.condition IS NULL OR s.condition = ?)
        AND (s.min_price IS NULL OR s.min_price <= ?) AND (s.max_price IS NULL OR s.max_price >= ?)
        AND NOT ${BLOCKED('s.user_id')}
      ORDER BY s.id DESC LIMIT ${SEARCH_SCAN}`)
    .bind(listing.seller_id, listing.category, listing.condition, listing.price, listing.price, listing.seller_id, listing.seller_id)
    .all<Pick<SearchRow, 'id' | 'user_id' | 'q' | 'location'>>();
  const haystack = `${listing.title} ${listing.description}`.toLowerCase();
  const place = listing.location.toLowerCase();
  const users = new Set<string>();
  for (const s of results) {
    if (users.size >= SEARCH_NOTIFY) break;
    if (users.has(s.user_id)) continue;
    if (s.location && !place.includes(s.location.toLowerCase())) continue;
    if (!words(s.q).every(w => haystack.includes(w))) continue;
    users.add(s.user_id);
  }
  if (!users.size) return 0;
  const now = Date.now();
  const statements = [...users].map(userId => notifyStatement(env, {
    userId, actorId: listing.seller_id, type: 'system', link: `/marketplace/${listing.id}`,
    body: `New listing for your saved search: ${listing.title} (${priceText(listing.price)})`,
  }, now)).filter((s): s is D1PreparedStatement => Boolean(s));
  if (statements.length) await env.DB.batch(statements);
  return statements.length;
}

// -- Browse ------------------------------------------------------------------

type Sort = 'newest' | 'price_low' | 'price_high';

marketplace.get('/', async c => {
  const viewer = c.get('user');
  const size = limit(c, 24, 48);
  const sort: Sort = oneOf(['newest', 'price_low', 'price_high'] as const, c.req.query('sort')) ?? 'newest';
  const where = ['l.deleted_at IS NULL'];
  const params: unknown[] = [viewer?.id ?? ''];

  const sellerHandle = str(c.req.query('seller'), 40);
  if (sellerHandle) {
    const seller = await userByHandle(c.env, sellerHandle);
    if (!seller) fail(404, 'Seller not found.');
    where.push('l.seller_id = ?');
    params.push(seller.id);
  }
  if (c.req.query('include_sold') !== '1') where.push(`l.status != 'sold'`);
  for (const w of words(str(c.req.query('q'), MAX_QUERY))) {
    where.push(`(l.title LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\')`);
    params.push(likeEscape(w), likeEscape(w));
  }
  const category = oneOf(CATEGORIES, c.req.query('category'));
  if (category) { where.push('l.category = ?'); params.push(category); }
  const condition = oneOf(CONDITIONS, c.req.query('condition'));
  if (condition) { where.push('l.condition = ?'); params.push(condition); }
  const min = Number(c.req.query('min_price'));
  if (c.req.query('min_price') && Number.isInteger(min) && min >= 0) { where.push('l.price >= ?'); params.push(min); }
  const max = Number(c.req.query('max_price'));
  if (c.req.query('max_price') && Number.isInteger(max) && max >= 0) { where.push('l.price <= ?'); params.push(max); }
  const location = str(c.req.query('location'), MAX_LOCATION);
  if (location) { where.push(`l.location LIKE ? ESCAPE '\\'`); params.push(likeEscape(location)); }
  if (viewer) { where.push(`NOT ${BLOCKED('l.seller_id')}`); params.push(viewer.id, viewer.id); }

  const after = cursor(c);
  let order = 'l.id DESC';
  if (sort === 'newest') {
    if (after) { where.push('l.id < ?'); params.push(after); }
  } else {
    order = sort === 'price_low' ? 'l.price ASC, l.id DESC' : 'l.price DESC, l.id DESC';
    const m = after?.match(/^(\d+)_(\w+)$/);
    if (m) {
      where.push(`(l.price ${sort === 'price_low' ? '>' : '<'} ? OR (l.price = ? AND l.id < ?))`);
      params.push(Number(m[1]), Number(m[1]), m[2]);
    }
  }
  const { results } = await c.env.DB.prepare(`SELECT ${CARD_COLUMNS} FROM marketplace_listings l
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).bind(...params, size + 1).all<CardRow>();
  const items = results.slice(0, size);
  const last = items[items.length - 1];
  const next = results.length > size ? (sort === 'newest' ? last.id : `${last.price}_${last.id}`) : null;
  return c.json({ items: items.map(cardJson), next });
});

// -- Create ------------------------------------------------------------------

marketplace.post('/', async c => {
  const user = requireUser(c);
  const input = await body(c);
  const fields = readFields(input, false) as Required<ListingFields>;
  if (!fields.pickup && !fields.postage) fail(422, 'Choose pickup, postage or both.');
  const now = Date.now();
  const recent = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM marketplace_listings WHERE seller_id = ? AND created_at > ?')
    .bind(user.id, now - DAY).first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_LISTINGS_PER_DAY) fail(429, 'You have listed a lot today. Try again tomorrow.');
  const photos = await readPhotos(c.env, user.id, input.photo_ids);
  const id = newId(now);
  const row: ListingRow = {
    id, seller_id: user.id, ...fields, status: 'available', buyer_id: null, sold_at: null, view_count: 0, save_count: 0,
    created_at: now, updated_at: now, deleted_at: null,
  };
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO marketplace_listings (id, seller_id, title, description, price, negotiable, category, condition,
        location, pickup, postage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, user.id, row.title, row.description, row.price, row.negotiable, row.category, row.condition, row.location,
        row.pickup, row.postage, now, now),
    ...photoStatements(c.env, id, photos).slice(1),
  ]);
  const notified = await notifySavedSearches(c.env, row);
  track(c, 'social_listing_created', { listing_id: id, category: row.category, price: row.price, photos: photos.length, search_matches: notified });
  return c.json({ listing: await listingOr404(c.env, id, user) }, 201);
});

// -- Saved, mine, searches, sellers (before /:id) -----------------------------

marketplace.get('/saved', async c => {
  const user = requireUser(c);
  const size = limit(c, 24, 48);
  const params: unknown[] = [user.id, user.id];
  let extra = '';
  const m = cursor(c)?.match(/^(\d+)_(\w+)$/);
  if (m) {
    extra = 'AND (s.created_at < ? OR (s.created_at = ? AND s.listing_id < ?))';
    params.push(Number(m[1]), Number(m[1]), m[2]);
  }
  const { results } = await c.env.DB.prepare(`SELECT ${CARD_COLUMNS}, s.created_at AS save_at
      FROM marketplace_saves s JOIN marketplace_listings l ON l.id = s.listing_id
      WHERE s.user_id = ? AND l.deleted_at IS NULL ${extra}
      ORDER BY s.created_at DESC, s.listing_id DESC LIMIT ?`).bind(...params, size + 1).all<CardRow>();
  const items = results.slice(0, size);
  const last = items[items.length - 1];
  return c.json({ items: items.map(cardJson), next: results.length > size ? `${last.save_at}_${last.id}` : null });
});

marketplace.get('/mine', async c => {
  const user = requireUser(c);
  const size = limit(c, 24, 48);
  const status = oneOf(STATUSES, c.req.query('status'));
  const after = cursor(c);
  const where = ['l.seller_id = ?', 'l.deleted_at IS NULL'];
  const params: unknown[] = [user.id, user.id];
  if (status) { where.push('l.status = ?'); params.push(status); }
  if (after) { where.push('l.id < ?'); params.push(after); }
  const [list, counts] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT ${CARD_COLUMNS} FROM marketplace_listings l WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ?`)
      .bind(...params, size + 1),
    c.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM marketplace_listings WHERE seller_id = ? AND deleted_at IS NULL GROUP BY status`)
      .bind(user.id),
  ]);
  const rows = list.results as CardRow[];
  const items = rows.slice(0, size);
  const tally = { available: 0, pending: 0, sold: 0 };
  for (const r of counts.results as { status: Status; n: number }[]) tally[r.status] = r.n;
  return c.json({ items: items.map(cardJson), next: rows.length > size ? items[items.length - 1].id : null, counts: tally });
});

marketplace.get('/searches', async c => {
  const user = requireUser(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM marketplace_searches WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .bind(user.id, MAX_SEARCHES).all<SearchRow>();
  return c.json({ items: results.map(searchJson) });
});

marketplace.post('/searches', async c => {
  const user = requireUser(c);
  const s = readSearch(await body(c));
  const { results } = await c.env.DB.prepare('SELECT * FROM marketplace_searches WHERE user_id = ?').bind(user.id).all<SearchRow>();
  if (results.length >= MAX_SEARCHES) fail(409, `You can save up to ${MAX_SEARCHES} searches.`);
  if (results.some(r => r.q.toLowerCase() === s.q.toLowerCase() && r.category === s.category && r.condition === s.condition
    && r.min_price === s.min_price && r.max_price === s.max_price && r.location.toLowerCase() === s.location.toLowerCase())) {
    fail(409, 'You have already saved this search.');
  }
  const now = Date.now();
  const row: SearchRow = { id: newId(now), user_id: user.id, ...s, created_at: now };
  await c.env.DB.prepare(`INSERT INTO marketplace_searches (id, user_id, q, category, condition, min_price, max_price, location, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.id, user.id, row.q, row.category, row.condition, row.min_price, row.max_price, row.location, now).run();
  track(c, 'social_listing_search_saved', { category: row.category });
  return c.json({ search: searchJson(row) }, 201);
});

marketplace.patch('/searches/:id', async c => {
  const user = requireUser(c);
  const existing = await c.env.DB.prepare('SELECT * FROM marketplace_searches WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id).first<SearchRow>();
  if (!existing) fail(404, 'Saved search not found.');
  const s = readSearch({ ...searchJson(existing), ...(await body(c)) });
  await c.env.DB.prepare(`UPDATE marketplace_searches SET q = ?, category = ?, condition = ?, min_price = ?, max_price = ?, location = ?
      WHERE id = ?`).bind(s.q, s.category, s.condition, s.min_price, s.max_price, s.location, existing.id).run();
  return c.json({ search: searchJson({ ...existing, ...s }) });
});

marketplace.get('/sellers/:handle', async c => {
  const viewer = c.get('user');
  const seller = await userByHandle(c.env, c.req.param('handle'));
  if (!seller) fail(404, 'Seller not found.');
  if (viewer && viewer.id !== seller.id && await isBlocked(c.env, viewer.id, seller.id)) fail(404, 'Seller not found.');
  const [stats, reviews] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM marketplace_listings WHERE seller_id = ?1 AND deleted_at IS NULL AND status != 'sold') AS active,
        (SELECT COUNT(*) FROM marketplace_listings WHERE seller_id = ?1 AND deleted_at IS NULL AND status = 'sold') AS sold,
        (SELECT COUNT(*) FROM marketplace_reviews WHERE reviewee_id = ?1) AS r_count,
        (SELECT AVG(rating) FROM marketplace_reviews WHERE reviewee_id = ?1) AS r_avg`).bind(seller.id),
    c.env.DB.prepare(`${REVIEW_SELECT} WHERE r.reviewee_id = ? ORDER BY r.id DESC LIMIT 20`).bind(seller.id),
  ]);
  const s = (stats.results as { active: number; sold: number; r_count: number; r_avg: number | null }[])[0];
  return c.json({
    seller: userCard(seller as UserRow),
    rating: rating(s.r_count, s.r_avg),
    listing_count: s.active,
    sold_count: s.sold,
    reviews: (reviews.results as Record<string, unknown>[]).map(reviewJson),
  });
});

// -- One listing -------------------------------------------------------------

marketplace.get('/:id', async c => {
  const viewer = c.get('user');
  const listing = await listingOr404(c.env, c.req.param('id'), viewer);
  if (!listing.viewer.is_owner) {
    const key = await viewerKey(c, viewer);
    const day = Math.floor(Date.now() / DAY);
    const [counted] = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE marketplace_listings SET view_count = view_count + 1 WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM marketplace_views WHERE listing_id = ? AND viewer_key = ? AND day >= ?)`)
        .bind(listing.id, listing.id, key, day),
      c.env.DB.prepare(`INSERT INTO marketplace_views (listing_id, viewer_key, day) VALUES (?, ?, ?)
          ON CONFLICT (listing_id, viewer_key) DO UPDATE SET day = excluded.day WHERE day < excluded.day`).bind(listing.id, key, day),
    ]);
    if (counted.meta.changes) {
      listing.view_count += 1;
      track(c, 'social_listing_viewed', { listing_id: listing.id });
    }
  }
  return c.json({ listing });
});

marketplace.patch('/:id', async c => {
  const user = requireUser(c);
  const row = await ownListing(c, user);
  const input = await body(c);
  const fields = readFields(input, true);
  const pickup = fields.pickup ?? row.pickup, postage = fields.postage ?? row.postage;
  if (!pickup && !postage) fail(422, 'Choose pickup, postage or both.');
  const statements: D1PreparedStatement[] = [];
  let removed: string[] = [];
  if ('photo_ids' in input) {
    const photos = await readPhotos(c.env, user.id, input.photo_ids);
    const { results } = await c.env.DB.prepare('SELECT media_id FROM marketplace_photos WHERE listing_id = ?').bind(row.id).all<{ media_id: string }>();
    removed = results.map(r => r.media_id).filter(id => !photos.includes(id));
    statements.push(...photoStatements(c.env, row.id, photos));
  }
  const keys = Object.keys(fields) as (keyof ListingFields)[];
  const now = Date.now();
  statements.unshift(c.env.DB.prepare(`UPDATE marketplace_listings SET ${keys.map(k => `${k} = ?, `).join('')}updated_at = ? WHERE id = ?`)
    .bind(...keys.map(k => fields[k]), now, row.id));
  await c.env.DB.batch(statements);
  await deleteUnusedMedia(c.env, removed);
  track(c, 'social_listing_updated', { listing_id: row.id });
  return c.json({ listing: await listingOr404(c.env, row.id, user) });
});

marketplace.put('/:id/photos', async c => {
  const user = requireUser(c);
  const row = await ownListing(c, user);
  const photos = await readPhotos(c.env, user.id, (await body(c)).ids);
  const { results } = await c.env.DB.prepare('SELECT media_id FROM marketplace_photos WHERE listing_id = ?').bind(row.id).all<{ media_id: string }>();
  await c.env.DB.batch([
    ...photoStatements(c.env, row.id, photos),
    c.env.DB.prepare('UPDATE marketplace_listings SET updated_at = ? WHERE id = ?').bind(Date.now(), row.id),
  ]);
  await deleteUnusedMedia(c.env, results.map(r => r.media_id).filter(id => !photos.includes(id)));
  return c.json({ listing: await listingOr404(c.env, row.id, user) });
});

// -- Save --------------------------------------------------------------------

async function setSaved(c: Ctx, saved: boolean) {
  const user = requireUser(c);
  const row = await getListing(c.env, c.req.param('id')!);
  const now = Date.now();
  const [, , count] = await c.env.DB.batch([
    saved
      ? c.env.DB.prepare('INSERT OR IGNORE INTO marketplace_saves (user_id, listing_id, created_at) VALUES (?, ?, ?)').bind(user.id, row.id, now)
      : c.env.DB.prepare('DELETE FROM marketplace_saves WHERE user_id = ? AND listing_id = ?').bind(user.id, row.id),
    c.env.DB.prepare('UPDATE marketplace_listings SET save_count = (SELECT COUNT(*) FROM marketplace_saves WHERE listing_id = ?1) WHERE id = ?1')
      .bind(row.id),
    c.env.DB.prepare('SELECT save_count FROM marketplace_listings WHERE id = ?').bind(row.id),
  ]);
  if (saved) track(c, 'social_listing_saved', { listing_id: row.id });
  return c.json({ saved, save_count: (count.results as { save_count: number }[])[0]?.save_count ?? 0 });
}
marketplace.put('/:id/save', c => setSaved(c, true));
marketplace.delete('/:id/save', c => setSaved(c, false));

// -- Status ------------------------------------------------------------------

/** A buyer the seller may name: someone who made an offer on this listing or has messaged the seller. */
async function eligibleBuyer(env: Env, listing: ListingRow, handle: string) {
  const row = await env.DB.prepare(`SELECT u.id, u.handle,
      EXISTS (SELECT 1 FROM marketplace_offers o WHERE o.listing_id = ? AND o.buyer_id = u.id) AS offered,
      EXISTS (SELECT 1 FROM conversation_members a JOIN conversation_members b ON b.conversation_id = a.conversation_id
        JOIN conversations cv ON cv.id = a.conversation_id WHERE cv.is_group = 0 AND a.user_id = u.id AND b.user_id = ?) AS messaged,
      ${BLOCKED('u.id')} AS blocked
    FROM users u WHERE u.handle = ?`).bind(listing.id, listing.seller_id, listing.seller_id, listing.seller_id, handle.replace(/^@/, ''))
    .first<{ id: string; handle: string; offered: number; messaged: number; blocked: number }>();
  if (!row) fail(404, 'No one has that handle.');
  if (row.id === listing.seller_id) fail(422, 'You cannot sell to yourself.');
  if (row.blocked || (!row.offered && !row.messaged)) fail(422, 'Choose someone who made an offer or messaged you.');
  return row;
}

marketplace.post('/:id/status', async c => {
  const user = requireUser(c);
  const row = await ownListing(c, user);
  const input = await body(c);
  const status = oneOf(STATUSES, input.status);
  if (!status) fail(422, 'Choose available, pending or sold.');
  const reviewed = await c.env.DB.prepare('SELECT 1 FROM marketplace_reviews WHERE listing_id = ? LIMIT 1').bind(row.id).first();
  if (reviewed) fail(409, 'This sale has been reviewed and can no longer be changed.');

  let buyerId: string | null = row.buyer_id;
  if (status === 'available') buyerId = null;
  else if ('buyer' in input) {
    const handle = str(input.buyer, 40);
    buyerId = handle ? (await eligibleBuyer(c.env, row, handle)).id : null;
  }
  const now = Date.now();
  const soldAt = status === 'sold' ? (row.status === 'sold' && row.sold_at ? row.sold_at : now) : null;
  const statements = [
    c.env.DB.prepare('UPDATE marketplace_listings SET status = ?, buyer_id = ?, sold_at = ?, updated_at = ? WHERE id = ?')
      .bind(status, buyerId, soldAt, now, row.id),
  ];
  const newlySold = status === 'sold' && (row.status !== 'sold' || row.buyer_id !== buyerId);
  if (newlySold && buyerId) {
    const note = notifyStatement(c.env, {
      userId: buyerId, actorId: user.id, type: 'system', link: `/marketplace/${row.id}`,
      body: `${row.title} was marked as sold to you. You can now leave a review.`,
    }, now);
    if (note) statements.push(note);
  }
  if (status === 'sold') {
    // The buyer's own offer counts as accepted; anyone else still waiting on an answer hears no.
    if (buyerId) {
      statements.push(c.env.DB.prepare(`UPDATE marketplace_offers SET status = 'accepted', responded_at = ?
          WHERE listing_id = ? AND status = 'pending' AND buyer_id = ?`).bind(now, row.id, buyerId));
    }
    statements.push(c.env.DB.prepare(`UPDATE marketplace_offers SET status = 'declined', responded_at = ?
        WHERE listing_id = ? AND status = 'pending' AND buyer_id != ?`).bind(now, row.id, buyerId ?? ''));
  }
  await c.env.DB.batch(statements);
  if (newlySold) track(c, 'social_listing_sold', { listing_id: row.id, price: row.price, to_buyer: Boolean(buyerId) });
  else track(c, 'social_listing_status_changed', { listing_id: row.id, status });
  return c.json({ listing: await listingOr404(c.env, row.id, user) });
});

// -- Offers ------------------------------------------------------------------

marketplace.get('/:id/offers', async c => {
  const user = requireUser(c);
  const row = await getListing(c.env, c.req.param('id'));
  const owner = row.seller_id === user.id;
  const { results } = await c.env.DB.prepare(`${OFFER_SELECT} WHERE o.listing_id = ? ${owner ? '' : 'AND o.buyer_id = ?'}
      ORDER BY o.id DESC LIMIT 50`).bind(...(owner ? [row.id] : [row.id, user.id])).all<Record<string, unknown>>();
  return c.json({ items: results.map(offerJson) });
});

marketplace.post('/:id/offers', async c => {
  const user = requireUser(c);
  const row = await getListing(c.env, c.req.param('id'));
  if (row.seller_id === user.id) fail(403, 'You cannot make an offer on your own listing.');
  if (row.status === 'sold') fail(409, 'This item has been sold.');
  if (await isBlocked(c.env, user.id, row.seller_id)) fail(404, 'Listing not found.');
  const input = await body(c);
  const amount = cents(input.amount, 'Offer');
  if (amount === undefined || amount < 1) fail(422, 'Enter an amount.');
  const message = text(input.message, MAX_MESSAGE, `Messages are limited to ${MAX_MESSAGE} characters.`);
  const now = Date.now();
  const recent = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM marketplace_offers WHERE listing_id = ? AND buyer_id = ? AND created_at > ?')
    .bind(row.id, user.id, now - DAY).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 10) fail(429, 'You have made a lot of offers on this listing today.');
  const id = newId(now);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE marketplace_offers SET status = 'withdrawn', responded_at = ? WHERE listing_id = ? AND buyer_id = ? AND status = 'pending'`)
      .bind(now, row.id, user.id),
    c.env.DB.prepare('INSERT INTO marketplace_offers (id, listing_id, buyer_id, amount, message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, row.id, user.id, amount, message, now),
    notifyStatement(c.env, {
      userId: row.seller_id, actorId: user.id, type: 'system', link: `/marketplace/${row.id}`,
      body: `@${user.handle} offered ${priceText(amount)} for ${row.title}.`,
    }, now)!,
  ]);
  track(c, 'social_listing_offer_made', { listing_id: row.id, amount, price: row.price });
  const offer = await c.env.DB.prepare(`${OFFER_SELECT} WHERE o.id = ?`).bind(id).first<Record<string, unknown>>();
  return c.json({ offer: offerJson(offer!) }, 201);
});

async function respond(c: Ctx, decision: 'accepted' | 'declined') {
  const user = requireUser(c);
  const row = await ownListing(c, user);
  const offer = await c.env.DB.prepare(`${OFFER_SELECT} WHERE o.id = ? AND o.listing_id = ?`).bind(c.req.param('offerId'), row.id)
    .first<Record<string, unknown>>();
  if (!offer) fail(404, 'Offer not found.');
  if (offer.status !== 'pending') fail(409, 'That offer has already been answered.');
  if (decision === 'accepted' && row.status === 'sold') fail(409, 'This item has been sold.');
  const now = Date.now();
  const amount = priceText(offer.amount as number);
  const statements = [
    c.env.DB.prepare('UPDATE marketplace_offers SET status = ?, responded_at = ? WHERE id = ?').bind(decision, now, offer.id),
    notifyStatement(c.env, {
      userId: offer.buyer_id as string, actorId: user.id, type: 'system', link: `/marketplace/${row.id}`,
      body: decision === 'accepted'
        ? `Your offer of ${amount} for ${row.title} was accepted. Message the seller to arrange the sale.`
        : `Your offer of ${amount} for ${row.title} was declined.`,
    }, now)!,
  ];
  if (decision === 'accepted') {
    statements.push(c.env.DB.prepare(`UPDATE marketplace_listings SET status = 'pending', buyer_id = ?, updated_at = ? WHERE id = ?`)
      .bind(offer.buyer_id, now, row.id));
  }
  await c.env.DB.batch(statements);
  track(c, decision === 'accepted' ? 'social_listing_offer_accepted' : 'social_listing_offer_declined', { listing_id: row.id, amount: offer.amount });
  const result = { offer: offerJson({ ...offer, status: decision, responded_at: now }) };
  return c.json(decision === 'accepted' ? { ...result, listing: await listingOr404(c.env, row.id, user) } : result);
}
marketplace.post('/:id/offers/:offerId/accept', c => respond(c, 'accepted'));
marketplace.post('/:id/offers/:offerId/decline', c => respond(c, 'declined'));

marketplace.delete('/:id/offers/:offerId', async c => {
  const user = requireUser(c);
  const offer = await c.env.DB.prepare(`${OFFER_SELECT} WHERE o.id = ? AND o.listing_id = ? AND o.buyer_id = ?`)
    .bind(c.req.param('offerId'), c.req.param('id'), user.id).first<Record<string, unknown>>();
  if (!offer) fail(404, 'Offer not found.');
  if (offer.status !== 'pending') fail(409, 'That offer has already been answered.');
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE marketplace_offers SET status = 'withdrawn', responded_at = ? WHERE id = ?`).bind(now, offer.id).run();
  return c.json({ offer: offerJson({ ...offer, status: 'withdrawn', responded_at: now }) });
});

// -- Reviews -----------------------------------------------------------------

marketplace.put('/:id/review', async c => {
  const user = requireUser(c);
  const row = await getListing(c.env, c.req.param('id'));
  if (row.status !== 'sold' || !row.buyer_id) fail(403, 'Reviews open once the item is sold.');
  const isSeller = row.seller_id === user.id, isBuyer = row.buyer_id === user.id;
  if (!isSeller && !isBuyer) fail(403, 'Only the buyer and seller can review this sale.');
  const input = await body(c);
  const stars = Number(input.rating);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) fail(422, 'Choose a rating from 1 to 5.');
  const comment = text(input.comment, MAX_COMMENT, `Reviews are limited to ${MAX_COMMENT} characters.`);
  const reviewee = isSeller ? row.buyer_id : row.seller_id;
  const role = isSeller ? 'buyer' : 'seller';
  const now = Date.now();
  const existing = await c.env.DB.prepare('SELECT id FROM marketplace_reviews WHERE listing_id = ? AND reviewer_id = ?')
    .bind(row.id, user.id).first<{ id: string }>();
  const id = existing?.id ?? newId(now);
  const statements = [
    c.env.DB.prepare(`INSERT INTO marketplace_reviews (id, listing_id, reviewer_id, reviewee_id, role, rating, comment, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (listing_id, reviewer_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, updated_at = excluded.updated_at`)
      .bind(id, row.id, user.id, reviewee, role, stars, comment, now, now),
  ];
  if (!existing) {
    const note = notifyStatement(c.env, {
      userId: reviewee, actorId: user.id, type: 'system', link: `/marketplace/${row.id}`,
      body: `@${user.handle} reviewed you for ${row.title}: ${stars} out of 5.`,
    }, now);
    if (note) statements.push(note);
  }
  await c.env.DB.batch(statements);
  if (!existing) track(c, 'social_listing_reviewed', { listing_id: row.id, rating: stars, role });
  const review = await c.env.DB.prepare(`${REVIEW_SELECT} WHERE r.id = ?`).bind(id).first<Record<string, unknown>>();
  return c.json({ review: reviewJson(review!) }, existing ? 200 : 201);
});

export default marketplace;
