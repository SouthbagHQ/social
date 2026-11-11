// Southbag Ads: paid sponsored placements in the feeds. An advertiser prepays a budget from
// their Southbag Online Banking account (charge() in lib/banking.ts, the same flow Southbag
// Verified uses); every showing costs IMPRESSION_CENTS and every first visit per viewer costs
// CLICK_CENTS, drawn down from the prepaid budget. A campaign ends itself when the budget runs
// out. Nothing is refunded and campaigns are never deleted.

import type { Ctx, SessionUser } from '../env';
import { placeholders } from './http';
import { hydrate, visibleTo, type PostJson, type PostRow } from './posts';
import { userCards, type UserCard } from './users';

export const IMPRESSION_CENTS = 5;
export const CLICK_CENTS = 25;
export const MIN_BUDGET_CENTS = 500;
export const MAX_BUDGET_CENTS = 50000;

export type CampaignKind = 'post' | 'listing' | 'page';
export type CampaignStatus = 'active' | 'paused' | 'ended' | 'rejected';

export interface CampaignRow {
  id: string;
  user_id: string;
  name: string;
  kind: CampaignKind;
  target_id: string;
  budget_cents: number;
  spent_cents: number;
  impressions: number;
  clicks: number;
  status: CampaignStatus;
  created_at: number;
  updated_at: number;
}

export interface AdListingJson { id: string; title: string; price: number; photo_url: string | null; status: string }
export interface AdPageJson { user: UserCard; bio: string | null }

/** A sponsored placement, ready for the feed. Exactly one of post/listing/page is set. */
export interface AdJson {
  campaign_id: string;
  kind: CampaignKind;
  sponsor: UserCard;
  post?: PostJson;
  listing?: AdListingJson;
  page?: AdPageJson;
}

interface ListingRow { id: string; title: string; price: number; status: string; photo_id: string | null }

// An advertiser's own campaigns are never served to them (they would be paying to see their
// own ad), and a placement is dropped quietly when its target is gone, hidden or blocked.
export async function serveAds(c: Ctx, viewer: SessionUser, size = 2): Promise<AdJson[]> {
  const env = c.env;
  const now = Date.now();
  const { results: candidates } = await env.DB.prepare(
    `SELECT * FROM ad_campaigns
     WHERE status = 'active' AND spent_cents < budget_cents AND user_id != ?
     ORDER BY RANDOM() LIMIT 12`)
    .bind(viewer.id).all<CampaignRow>();
  if (!candidates.length) return [];

  const idsOf = (kind: CampaignKind) => candidates.filter(r => r.kind === kind).map(r => r.target_id);
  const postIds = idsOf('post');
  const listingIds = idsOf('listing');
  const pageIds = idsOf('page');
  const v = visibleTo(viewer.id);

  const [postsRes, listingsRes, pagesRes] = await Promise.all([
    postIds.length
      ? env.DB.prepare(`SELECT p.* FROM posts p WHERE p.id IN (${placeholders(postIds.length)})
          AND p.deleted_at IS NULL AND ${v.sql}`).bind(...postIds, ...v.params).all<PostRow>()
      : Promise.resolve({ results: [] as PostRow[] }),
    listingIds.length
      ? env.DB.prepare(`SELECT l.id, l.title, l.price, l.status,
            (SELECT p.media_id FROM marketplace_photos p WHERE p.listing_id = l.id ORDER BY p.position LIMIT 1) AS photo_id
          FROM marketplace_listings l
          WHERE l.id IN (${placeholders(listingIds.length)}) AND l.deleted_at IS NULL AND l.status = 'available'
            AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = l.seller_id)
              OR (b.blocker_id = l.seller_id AND b.blocked_id = ?))`)
          .bind(...listingIds, viewer.id, viewer.id).all<ListingRow>()
      : Promise.resolve({ results: [] as ListingRow[] }),
    pageIds.length
      ? env.DB.prepare(`SELECT id FROM users u WHERE u.id IN (${placeholders(pageIds.length)})
            AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = ?))`)
          .bind(...pageIds, viewer.id, viewer.id).all<{ id: string }>()
      : Promise.resolve({ results: [] as { id: string }[] }),
  ]);
  const posts = new Map(postsRes.results.map(r => [r.id, r]));
  const listings = new Map(listingsRes.results.map(r => [r.id, r]));
  const pages = new Set(pagesRes.results.map(r => r.id));

  const chosen = candidates.filter(r =>
    r.kind === 'post' ? posts.has(r.target_id)
    : r.kind === 'listing' ? listings.has(r.target_id)
    : pages.has(r.target_id)).slice(0, size);
  if (!chosen.length) return [];

  // Serving is the impression: charge it now, ending anything this showing pays off.
  await env.DB.batch(chosen.map(r => env.DB.prepare(
    `UPDATE ad_campaigns SET impressions = impressions + 1,
       spent_cents = MIN(budget_cents, spent_cents + ?),
       status = CASE WHEN spent_cents + ? >= budget_cents THEN 'ended' ELSE status END,
       updated_at = ?
     WHERE id = ? AND status = 'active'`)
    .bind(IMPRESSION_CENTS, IMPRESSION_CENTS, now, r.id)));

  const sponsors = await userCards(env, chosen.map(r => r.user_id));
  const pageCards = await userCards(env, chosen.filter(r => r.kind === 'page').map(r => r.target_id));
  const hydrated = await hydrate(env, viewer, chosen.filter(r => r.kind === 'post')
    .map(r => posts.get(r.target_id)!));
  const postJson = new Map(hydrated.map(p => [p.id, p]));
  const bios = new Map<string, string | null>();
  const bioIds = chosen.filter(r => r.kind === 'page').map(r => r.target_id);
  if (bioIds.length) {
    const { results } = await env.DB.prepare(`SELECT id, bio FROM users WHERE id IN (${placeholders(bioIds.length)})`)
      .bind(...bioIds).all<{ id: string; bio: string | null }>();
    for (const r of results) bios.set(r.id, r.bio);
  }

  const ads: AdJson[] = [];
  for (const r of chosen) {
    const sponsor = sponsors.get(r.user_id);
    if (!sponsor) continue;
    if (r.kind === 'post') {
      const post = postJson.get(r.target_id);
      if (!post) continue;
      post.sponsored = true;
      ads.push({ campaign_id: r.id, kind: 'post', sponsor, post });
    } else if (r.kind === 'listing') {
      const l = listings.get(r.target_id)!;
      ads.push({
        campaign_id: r.id, kind: 'listing', sponsor,
        listing: { id: l.id, title: l.title, price: l.price, photo_url: l.photo_id ? `/media/${l.photo_id}` : null, status: l.status },
      });
    } else {
      const user = pageCards.get(r.target_id);
      if (!user) continue;
      ads.push({ campaign_id: r.id, kind: 'page', sponsor, page: { user, bio: bios.get(r.target_id) ?? null } });
    }
  }
  return ads;
}
