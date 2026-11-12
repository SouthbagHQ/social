import assert from 'node:assert/strict';
import { test } from 'node:test';
import { as, anon } from './helpers.mjs';

// The tests run with BANKING_DEV=1 (scripts/test.sh), so charges succeed without a bank.
const alice = as('alice');
const bob = as('bob');

let postId;
let campaignId;

test('ads: starting a campaign charges the whole budget straight away, once', async () => {
  const posted = await alice.post('posts', { body: 'Bags. All types of bags.' });
  assert.equal(posted.status, 201);
  postId = posted.body.post.id;

  const res = await alice.post('ads', { kind: 'post', target_id: postId, name: 'Bag awareness', budget_cents: 500 });
  assert.equal(res.status, 201);
  assert.equal(res.body.charged, 500);
  assert.equal(res.body.campaign.status, 'active');
  assert.equal(res.body.campaign.budget_cents, 500);
  assert.equal(res.body.message, 'Campaign started. $5.00 was taken from your Southbag Online Banking account.');
  campaignId = res.body.campaign.id;

  const mine = await alice.get('ads');
  assert.equal(mine.status, 200);
  const c = mine.body.items.find(i => i.id === campaignId);
  assert.equal(c.impressions, 0);
  assert.equal(c.clicks, 0);
  assert.equal(c.target.href, `/post/${postId}`);
  const notes = (await alice.get('notifications')).body.items;
  assert.ok(notes.some(n => n.body?.includes('Bag awareness') && n.body?.includes('$5.00 was taken')));
});

test('ads: targets and budgets are validated, and you can only boost your own things', async () => {
  assert.equal((await alice.post('ads', { kind: 'post', target_id: postId, budget_cents: 100 })).status, 422, 'below the minimum budget');
  assert.equal((await alice.post('ads', { kind: 'post', target_id: postId, budget_cents: 50001 })).status, 422, 'above the maximum budget');
  assert.equal((await alice.post('ads', { kind: 'banana', target_id: postId, budget_cents: 500 })).status, 422, 'unknown kind');
  assert.equal((await bob.post('ads', { kind: 'post', target_id: postId, budget_cents: 500 })).status, 403, "someone else's post");
  assert.equal((await alice.post('ads', { kind: 'post', target_id: 'nope', budget_cents: 500 })).status, 404, 'missing post');
  assert.equal((await alice.post('ads', { kind: 'page', target_id: 'someone-else', budget_cents: 500 })).status, 403, "someone else's page");
  assert.equal((await anon.get('ads')).status, 401);

  const targets = await alice.get('ads/targets');
  assert.equal(targets.status, 200);
  assert.ok(targets.body.posts.some(p => p.id === postId), 'your own post is boostable');
  assert.equal(targets.body.page.label, 'Your page (@alice)');
});

test('ads: campaigns are served into other people\'s feeds, labelled sponsored, and showings are charged', async () => {
  const feed = await bob.get('feed?tab=foryou&limit=5');
  assert.equal(feed.status, 200);
  const ad = feed.body.ads.find(a => a.campaign_id === campaignId);
  assert.ok(ad, 'the campaign is served to another viewer');
  assert.equal(ad.kind, 'post');
  assert.equal(ad.sponsor.handle, 'alice');
  assert.equal(ad.post.sponsored, true, 'the placement is labelled Sponsored');

  const aliceFeed = await alice.get('feed?tab=foryou&limit=5');
  assert.ok(!aliceFeed.body.ads.some(a => a.campaign_id === campaignId), 'advertisers never see their own campaign');

  const c = (await alice.get('ads')).body.items.find(i => i.id === campaignId);
  assert.equal(c.impressions, 1, 'serving is the showing');
  assert.equal(c.spent_cents, 5, 'a showing costs $0.05');
});

test('ads: a visit is charged once per viewer, and the advertiser\'s own visits are free', async () => {
  const click = await bob.post(`ads/${campaignId}/click`);
  assert.equal(click.status, 200);
  let c = (await alice.get('ads')).body.items.find(i => i.id === campaignId);
  assert.equal(c.clicks, 1);
  assert.equal(c.spent_cents, 30, 'showing plus one visit');

  await bob.post(`ads/${campaignId}/click`);
  c = (await alice.get('ads')).body.items.find(i => i.id === campaignId);
  assert.equal(c.clicks, 1, 'repeat visits by the same person are free');
  assert.equal(c.spent_cents, 30);

  await alice.post(`ads/${campaignId}/click`);
  c = (await alice.get('ads')).body.items.find(i => i.id === campaignId);
  assert.equal(c.clicks, 1, 'the advertiser clicking their own ad is not charged');
  const anonClick = await fetch(`${process.env.BASE || 'http://localhost:8799'}/api/ads/${campaignId}/click`, { method: 'POST' });
  assert.equal(anonClick.status, 401, 'signed-out visits are not recorded');
});

test('ads: a campaign ends itself when the budget is spent', async () => {
  // $5.00 budget, $0.30 spent so far: 94 more showings pay it off.
  let served = true;
  for (let i = 0; i < 120 && served; i++) {
    const feed = await bob.get('feed?tab=foryou&limit=1');
    served = feed.body.ads.some(a => a.campaign_id === campaignId);
  }
  assert.equal(served, false, 'the campaign stops being served');

  const c = (await alice.get('ads')).body.items.find(i => i.id === campaignId);
  assert.equal(c.status, 'ended');
  assert.equal(c.spent_cents, 500, 'never more than the budget');
  assert.ok(c.impressions <= 100);
});

test('ads: campaigns pause and resume, and can never be deleted', async () => {
  const res = await alice.post('ads', { kind: 'page', target_id: (await alice.get('me')).body.user.id, budget_cents: 500 });
  assert.equal(res.status, 201);
  const id = res.body.campaign.id;

  const paused = await alice.post(`ads/${id}/pause`);
  assert.equal(paused.body.status, 'paused');
  const feed = await bob.get('feed?tab=foryou&limit=5');
  assert.ok(!feed.body.ads.some(a => a.campaign_id === id), 'paused campaigns are not served');
  assert.equal((await alice.post(`ads/${id}/pause`)).status, 409, 'pausing twice');

  const resumed = await alice.post(`ads/${id}/resume`);
  assert.equal(resumed.body.status, 'active');
  assert.equal((await alice.post(`ads/${id}/resume`)).status, 409, 'resuming twice');
  assert.equal((await bob.post(`ads/${id}/pause`)).status, 404, "not someone else's campaign");

  const gone = await alice.del(`ads/${id}`);
  assert.equal(gone.status, 403);
  assert.match(gone.body.error, /Deletion isn't available/);

  // Leave nothing running for the other suites.
  await alice.post(`ads/${id}/pause`);
});
