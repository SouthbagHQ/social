// Southbag Ads. Mounted at /api/ads.
//
//   GET  /api/ads           -> { items: CampaignJson[], rates, min_budget_cents, max_budget_cents }
//   GET  /api/ads/targets   -> { posts: Option[], listings: Option[], page: Option } (things you may boost)
//   POST /api/ads           -> start a campaign; the whole budget is charged straight away
//   POST /api/ads/:id/pause    -> stop serving (the budget already spent stays spent)
//   POST /api/ads/:id/resume
//   POST /api/ads/:id/click -> record a visit; charged once per viewer per campaign
//
// Money: creating a campaign charges its full budget through charge() (Southbag Online Banking,
// the Southbag Verified flow): insert the row first and mark it 'rejected' if the charge throws,
// so two quick clicks can't charge twice and nothing is charged without a record of it.
// Campaigns are never deleted; they pause or end.

import { Hono } from 'hono';
import { body, fail, requireUser, str } from '../lib/http';
import { newId } from '../lib/ids';
import { charge, money } from '../lib/banking';
import { notify } from '../lib/notify';
import { track } from '../lib/palantir';
import {
  CLICK_CENTS, IMPRESSION_CENTS, MAX_BUDGET_CENTS, MIN_BUDGET_CENTS,
  type CampaignKind, type CampaignRow,
} from '../lib/ads';
import type { AppEnv, Ctx } from '../env';

const ads = new Hono<AppEnv>();

const KINDS: readonly CampaignKind[] = ['post', 'listing', 'page'];
const KIND_LABEL: Record<CampaignKind, string> = { post: 'Post', listing: 'Marketplace listing', page: 'Page' };

interface CampaignJson {
  id: string; name: string; kind: CampaignKind; status: string;
  budget_cents: number; spent_cents: number; impressions: number; clicks: number;
  created_at: number; target: { label: string; href: string | null };
}

async function campaignJson(c: { env: AppEnv['Bindings'] }, r: CampaignRow): Promise<CampaignJson> {
  let label = r.name;
  let href: string | null = null;
  if (r.kind === 'post') {
    const post = await c.env.DB.prepare('SELECT body, title, kind FROM posts WHERE id = ?').bind(r.target_id)
      .first<{ body: string; title: string | null; kind: string }>();
    label = post ? (post.title || post.body.slice(0, 60) || `${KIND_LABEL.post} (${post.kind})`) : 'Post (gone)';
    href = post ? `/post/${r.target_id}` : null;
  } else if (r.kind === 'listing') {
    const listing = await c.env.DB.prepare('SELECT title FROM marketplace_listings WHERE id = ?').bind(r.target_id)
      .first<{ title: string }>();
    label = listing?.title ?? 'Listing (gone)';
    href = listing ? `/marketplace/${r.target_id}` : null;
  } else {
    const user = await c.env.DB.prepare('SELECT handle FROM users WHERE id = ?').bind(r.target_id).first<{ handle: string }>();
    label = user ? `@${user.handle}` : 'Page (gone)';
    href = user ? `/@${user.handle}` : null;
  }
  return {
    id: r.id, name: r.name, kind: r.kind, status: r.status,
    budget_cents: r.budget_cents, spent_cents: r.spent_cents, impressions: r.impressions, clicks: r.clicks,
    created_at: r.created_at, target: { label, href },
  };
}

ads.get('/', async c => {
  const me = requireUser(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM ad_campaigns WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .bind(me.id).all<CampaignRow>();
  const items: CampaignJson[] = [];
  for (const r of results) items.push(await campaignJson(c, r));
  return c.json({
    items,
    rates: { impression_cents: IMPRESSION_CENTS, click_cents: CLICK_CENTS },
    min_budget_cents: MIN_BUDGET_CENTS,
    max_budget_cents: MAX_BUDGET_CENTS,
  });
});

/** Things the signed-in person may boost: their own posts, their available listings, their page. */
ads.get('/targets', async c => {
  const me = requireUser(c);
  const [posts, listings] = await Promise.all([
    c.env.DB.prepare(`SELECT id, title, body, kind FROM posts
        WHERE author_id = ? AND deleted_at IS NULL AND repost_of_id IS NULL ORDER BY id DESC LIMIT 25`)
      .bind(me.id).all<{ id: string; title: string | null; body: string; kind: string }>(),
    c.env.DB.prepare(`SELECT id, title, price FROM marketplace_listings
        WHERE seller_id = ? AND deleted_at IS NULL AND status = 'available' ORDER BY id DESC LIMIT 25`)
      .bind(me.id).all<{ id: string; title: string; price: number }>(),
  ]);
  return c.json({
    posts: posts.results.map(p => ({ id: p.id, label: p.title || p.body.slice(0, 60) || `Post (${p.kind})` })),
    listings: listings.results.map(l => ({ id: l.id, label: `${l.title} (${money(l.price)})` })),
    page: { id: me.id, label: `Your page (@${me.handle})` },
  });
});

ads.post('/', async c => {
  const me = requireUser(c);
  const input = await body<{ kind?: unknown; target_id?: unknown; name?: unknown; budget_cents?: unknown }>(c);
  const kind = KINDS.includes(input.kind as CampaignKind) ? (input.kind as CampaignKind) : null;
  if (!kind) fail(422, 'Pick what to promote: a post, a listing or your page.');
  const targetId = str(input.target_id, 64);
  if (!targetId) fail(422, 'Pick what to promote.');
  const budget = typeof input.budget_cents === 'number' && Number.isInteger(input.budget_cents) ? input.budget_cents : 0;
  if (budget < MIN_BUDGET_CENTS || budget > MAX_BUDGET_CENTS)
    fail(422, `Budget is between ${money(MIN_BUDGET_CENTS)} and ${money(MAX_BUDGET_CENTS)}.`);

  // You can only boost your own things: your post, your listing, your page.
  if (kind === 'post') {
    const post = await c.env.DB.prepare('SELECT author_id FROM posts WHERE id = ? AND deleted_at IS NULL').bind(targetId).first<{ author_id: string }>();
    if (!post) fail(404, 'Post not found.');
    if (post.author_id !== me.id) fail(403, 'You can only promote your own posts.');
  } else if (kind === 'listing') {
    const listing = await c.env.DB.prepare('SELECT seller_id, status FROM marketplace_listings WHERE id = ? AND deleted_at IS NULL')
      .bind(targetId).first<{ seller_id: string; status: string }>();
    if (!listing) fail(404, 'Listing not found.');
    if (listing.seller_id !== me.id) fail(403, 'You can only promote your own listings.');
    if (listing.status !== 'available') fail(409, 'That listing is no longer available.');
  } else if (targetId !== me.id) fail(403, 'You can only promote your own page.');

  const now = Date.now();
  const id = newId();
  const name = str(input.name, 80) || `${KIND_LABEL[kind]} promotion`;
  // Claim first, then charge, so two quick clicks can't charge twice.
  await c.env.DB.prepare(`INSERT INTO ad_campaigns (id, user_id, name, kind, target_id, budget_cents, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .bind(id, me.id, name, kind, targetId, budget, now, now).run();
  let bank: Awaited<ReturnType<typeof charge>>;
  try {
    bank = await charge(c.env, me, budget, `Southbag Ads: ${name}`);
  } catch (err) {
    console.error('ad campaign charge', err);
    await c.env.DB.prepare(`UPDATE ad_campaigns SET status = 'rejected', updated_at = ? WHERE id = ?`).bind(now, id).run();
    fail(502, 'Southbag Online Banking is unavailable. Try again later.');
  }
  const taken = `${money(budget)} was taken from your Southbag Online Banking account.`;
  await notify(c.env, { userId: me.id, type: 'system', body: `Your Southbag Ads campaign "${name}" is running. ${taken}`, link: '/ads' });
  track(c, 'social_ad_campaign_created', { campaign_id: id, kind, budget_cents: budget, bank_account_opened: bank.opened });
  const row = await c.env.DB.prepare('SELECT * FROM ad_campaigns WHERE id = ?').bind(id).first<CampaignRow>();
  return c.json({
    campaign: await campaignJson(c, row!), charged: budget, bank_balance: bank.balance,
    message: bank.opened
      ? `Campaign started. Southbag Online Banking opened an account for you. ${taken}`
      : `Campaign started. ${taken}`,
  }, 201);
});

async function setStatus(c: Ctx, from: string, to: string, message: string) {
  const me = requireUser(c);
  const now = Date.now();
  const updated = await c.env.DB.prepare(`UPDATE ad_campaigns SET status = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = ? AND spent_cents < budget_cents RETURNING id`)
    .bind(to, now, c.req.param('id'), me.id, from).first<{ id: string }>();
  if (!updated) {
    const existing = await c.env.DB.prepare('SELECT user_id, status FROM ad_campaigns WHERE id = ?').bind(c.req.param('id'))
      .first<{ user_id: string; status: string }>();
    if (!existing || existing.user_id !== me.id) fail(404, 'Campaign not found.');
    fail(409, existing.status === to ? `Already ${to}.` : 'The budget is spent.');
  }
  track(c, to === 'paused' ? 'social_ad_campaign_paused' : 'social_ad_campaign_resumed', { campaign_id: updated.id });
  return c.json({ ok: true, status: to, message });
}

ads.post('/:id/pause', c => setStatus(c, 'active', 'paused', 'Paused. The budget already spent stays spent.'));
ads.post('/:id/resume', c => setStatus(c, 'paused', 'active', 'Running.'));

/** A visit to what a campaign promotes. Charged once per viewer per campaign; repeats are free. */
ads.post('/:id/click', async c => {
  const me = requireUser(c);
  const id = c.req.param('id');
  const now = Date.now();
  const inserted = await c.env.DB.prepare('INSERT OR IGNORE INTO ad_clicks (campaign_id, viewer_id, created_at) VALUES (?, ?, ?)')
    .bind(id, me.id, now).run();
  if (inserted.meta.changes) {
    await c.env.DB.prepare(`UPDATE ad_campaigns SET clicks = clicks + 1,
        spent_cents = MIN(budget_cents, spent_cents + ?),
        status = CASE WHEN spent_cents + ? >= budget_cents THEN 'ended' ELSE status END,
        updated_at = ?
      WHERE id = ? AND user_id != ? AND status != 'rejected'`)
      .bind(CLICK_CENTS, CLICK_CENTS, now, id, me.id).run();
    track(c, 'social_ad_clicked', { campaign_id: id });
  }
  return c.json({ ok: true });
});

export default ads;
