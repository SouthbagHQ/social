import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anon, as, BASE } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol'), kevin = as('kevin');
const NO_DELETING = "Deletion isn't available. Kevin knows what you did.";
const word = () => `mk${Math.random().toString(36).slice(2, 9)}`;

async function png(who) {
  const bytes = new Uint8Array(1000);
  const { body } = await who.post('media', { kind: 'image', content_type: 'image/png', size: bytes.length, width: 10, height: 10 });
  await who.put(`media/${body.id}/chunks/0`, bytes);
  return (await who.post(`media/${body.id}/complete`)).body;
}

async function listing(who = alice, extra = {}) {
  const photo = extra.photo_ids ? null : await png(who);
  const res = await who.post('marketplace', {
    title: 'Timber desk', description: 'Solid timber, a few marks.', price: 12000, negotiable: true, category: 'furniture',
    condition: 'good', location: 'Newtown 2042', pickup: true, postage: false, photo_ids: photo ? [photo.id] : undefined, ...extra,
  });
  assert.equal(res.status, 201, res.text);
  return res.body.listing;
}

const notifications = async who => (await who.get('notifications?limit=50')).body.items;

test('marketplace: create, validate, edit, photos, never delete', async () => {
  const [p1, p2, p3] = [await png(alice), await png(alice), await png(alice)];
  const l = await listing(alice, { photo_ids: [p1.id, p2.id] });
  assert.equal(l.title, 'Timber desk');
  assert.equal(l.price, 12000);
  assert.equal(l.negotiable, true);
  assert.equal(l.status, 'available');
  assert.equal(l.seller.handle, 'alice');
  assert.deepEqual(l.photos.map(p => p.id), [p1.id, p2.id]);
  assert.equal(l.photo_url, `/media/${p1.id}`);
  assert.equal(l.viewer.is_owner, true);
  assert.deepEqual(l.seller.rating, { count: 0, average: null });

  const base = { title: 'Lamp', price: 0, category: 'home_garden', condition: 'new', location: 'Glebe', pickup: true, photo_ids: [p3.id] };
  const bad = [
    [{ ...base, photo_ids: [] }, 'photos required'],
    [{ ...base, photo_ids: undefined }, 'photos required'],
    [{ ...base, photo_ids: Array(11).fill(p3.id) }, 'duplicate photos'],
    [{ ...base, title: '' }, 'title required'],
    [{ ...base, title: 'x'.repeat(101) }, 'title too long'],
    [{ ...base, description: 'x'.repeat(5001) }, 'description too long'],
    [{ ...base, price: -1 }, 'negative price'],
    [{ ...base, price: 10.5 }, 'fractional cents'],
    [{ ...base, price: undefined }, 'price required'],
    [{ ...base, category: 'weapons' }, 'bad category'],
    [{ ...base, condition: 'broken' }, 'bad condition'],
    [{ ...base, location: '' }, 'location required'],
    [{ ...base, pickup: false, postage: false }, 'no delivery'],
  ];
  for (const [input, why] of bad) assert.equal((await alice.post('marketplace', input)).status, 422, why);
  const bobPhoto = await png(bob);
  assert.equal((await alice.post('marketplace', { ...base, photo_ids: [bobPhoto.id] })).status, 422, 'someone else\'s photo');
  const unauth = await fetch(`${BASE}/api/marketplace`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);

  const free = await alice.post('marketplace', base);
  assert.equal(free.status, 201);
  assert.equal(free.body.listing.price, 0);

  assert.equal((await anon.get(`marketplace/${l.id}`)).status, 200);
  assert.equal((await bob.patch(`marketplace/${l.id}`, { title: 'Mine' })).status, 403);
  assert.equal((await bob.del(`marketplace/${l.id}`)).status, 403);
  assert.equal((await alice.patch(`marketplace/${l.id}`, { title: '' })).status, 422);
  const edited = await alice.patch(`marketplace/${l.id}`, { title: 'Oak desk', price: 9900, negotiable: false, postage: true });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.body.listing.title, 'Oak desk');
  assert.equal(edited.body.listing.price, 9900);
  assert.equal(edited.body.listing.negotiable, false);
  assert.equal(edited.body.listing.postage, true);
  assert.equal(edited.body.listing.description, 'Solid timber, a few marks.', 'untouched fields stay');

  // Reorder, add one and drop one; the dropped file is deleted.
  const reordered = await alice.put(`marketplace/${l.id}/photos`, { ids: [p2.id, p1.id] });
  assert.deepEqual(reordered.body.listing.photos.map(p => p.id), [p2.id, p1.id]);
  const extra = await png(alice);
  const swapped = await alice.patch(`marketplace/${l.id}`, { photo_ids: [extra.id, p2.id] });
  assert.deepEqual(swapped.body.listing.photos.map(p => p.id), [extra.id, p2.id]);
  assert.equal((await fetch(`${BASE}/media/${p1.id}`)).status, 404, 'removed photo is deleted');
  assert.equal((await fetch(`${BASE}/media/${p2.id}`)).status, 200);
  assert.equal((await alice.del(`media/${p2.id}`)).status, 409, 'photos in a listing are in use');
  assert.equal((await bob.put(`marketplace/${l.id}/photos`, { ids: [bobPhoto.id] })).status, 403);

  const refused = await alice.del(`marketplace/${l.id}`);
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: NO_DELETING }, 'not even the seller can delete a listing');
  const kept = await anon.get(`marketplace/${l.id}`);
  assert.equal(kept.status, 200);
  assert.equal(kept.body.listing.title, 'Oak desk');
  assert.deepEqual(kept.body.listing.photos.map(p => p.id), [extra.id, p2.id]);
  assert.equal((await fetch(`${BASE}/media/${p2.id}`)).status, 200, 'photos stay with the listing');
});

test('marketplace: views count once per viewer per day, never the seller', async () => {
  const l = await listing();
  await alice.get(`marketplace/${l.id}`);
  assert.equal((await bob.get(`marketplace/${l.id}`)).body.listing.view_count, 1);
  assert.equal((await bob.get(`marketplace/${l.id}`)).body.listing.view_count, 1);
  assert.equal((await carol.get(`marketplace/${l.id}`)).body.listing.view_count, 2);
  assert.equal((await alice.get(`marketplace/${l.id}`)).body.listing.view_count, 2);
});

test('marketplace: browse filters, sorting and paging', async () => {
  const tag = word();
  const a = await listing(alice, { title: `Bike ${tag}`, price: 30000, category: 'sport_outdoors', condition: 'good', location: 'Fitzroy 3065' });
  const b = await listing(bob, { title: `Helmet ${tag}`, price: 5000, category: 'sport_outdoors', condition: 'new', location: 'Carlton 3053', postage: true });
  const c = await listing(carol, { title: 'Kettle', description: `Works fine ${tag}`, price: 0, category: 'home_garden', condition: 'like_new', location: 'Fitzroy North' });

  const ids = async q => (await anon.get(`marketplace?q=${tag}${q}`)).body.items.map(x => x.id);
  assert.deepEqual(await ids(''), [c.id, b.id, a.id], 'newest first, description matches too');
  assert.deepEqual(await ids('&category=sport_outdoors'), [b.id, a.id]);
  assert.deepEqual(await ids('&condition=new'), [b.id]);
  assert.deepEqual(await ids('&min_price=1&max_price=10000'), [b.id]);
  assert.deepEqual(await ids('&max_price=0'), [c.id]);
  assert.deepEqual(await ids('&location=fitzroy'), [c.id, a.id]);
  assert.deepEqual(await ids('&sort=price_low'), [c.id, b.id, a.id]);
  assert.deepEqual(await ids('&sort=price_high'), [a.id, b.id, c.id]);
  assert.deepEqual(await ids(`&seller=bob`), [b.id]);
  assert.deepEqual((await anon.get(`marketplace?q=${tag}%20bike`)).body.items.map(x => x.id), [a.id], 'every word must match');
  assert.deepEqual((await anon.get(`marketplace?q=${tag}%25`)).body.items, [], 'LIKE wildcards are literal');

  // Paging through a price sort one at a time.
  const seen = [];
  let next = null;
  do {
    const res = await anon.get(`marketplace?q=${tag}&sort=price_high&limit=1${next ? `&cursor=${next}` : ''}`);
    seen.push(...res.body.items.map(x => x.id));
    next = res.body.next;
  } while (next && seen.length < 10);
  assert.deepEqual(seen, [a.id, b.id, c.id]);

  const card = (await anon.get(`marketplace?q=${tag}&condition=new`)).body.items[0];
  for (const key of ['id', 'title', 'price', 'negotiable', 'category', 'condition', 'location', 'status', 'photo_url', 'created_at', 'saved']) {
    assert.ok(key in card, key);
  }
});

test('marketplace: saving listings', async () => {
  const l = await listing();
  const saved = await bob.put(`marketplace/${l.id}/save`);
  assert.deepEqual(saved.body, { saved: true, save_count: 1 });
  assert.equal((await bob.put(`marketplace/${l.id}/save`)).body.save_count, 1, 'saving twice counts once');
  assert.equal((await bob.get(`marketplace/${l.id}`)).body.listing.saved, true);
  assert.equal((await carol.get(`marketplace/${l.id}`)).body.listing.saved, false);
  assert.equal((await bob.get('marketplace/saved')).body.items[0].id, l.id);
  assert.equal((await bob.get(`marketplace?seller=alice&limit=48`)).body.items.find(x => x.id === l.id).saved, true);
  assert.deepEqual((await bob.del(`marketplace/${l.id}/save`)).body, { saved: false, save_count: 0 });
  assert.ok(!(await bob.get('marketplace/saved')).body.items.some(x => x.id === l.id));
  assert.equal((await anon.get('marketplace/saved')).status, 401);
  assert.equal((await bob.put('marketplace/nope/save')).status, 404);
});

test('marketplace: offers, accept and decline', async () => {
  const l = await listing(alice, { title: 'Couch' });
  assert.equal((await alice.post(`marketplace/${l.id}/offers`, { amount: 100 })).status, 403, 'not on your own listing');
  assert.equal((await bob.post(`marketplace/${l.id}/offers`, { amount: 0 })).status, 422);
  assert.equal((await bob.post(`marketplace/${l.id}/offers`, { amount: 12.5 })).status, 422);
  assert.equal((await bob.post(`marketplace/${l.id}/offers`, { amount: 100, message: 'x'.repeat(501) })).status, 422);

  const first = await bob.post(`marketplace/${l.id}/offers`, { amount: 8000, message: 'Can pick up Saturday.' });
  assert.equal(first.status, 201, first.text);
  assert.equal(first.body.offer.status, 'pending');
  assert.equal(first.body.offer.buyer.handle, 'bob');
  const note = (await notifications(alice)).find(n => n.link === `/marketplace/${l.id}`);
  assert.ok(note, 'seller is notified with a link');
  assert.match(note.body, /\$80/);

  const second = await bob.post(`marketplace/${l.id}/offers`, { amount: 9000 });
  const carolOffer = (await carol.post(`marketplace/${l.id}/offers`, { amount: 7000 })).body.offer;

  const all = (await alice.get(`marketplace/${l.id}/offers`)).body.items;
  assert.deepEqual(all.map(o => [o.buyer.handle, o.amount, o.status]),
    [['carol', 7000, 'pending'], ['bob', 9000, 'pending'], ['bob', 8000, 'withdrawn']], 'a new offer replaces your pending one');
  assert.deepEqual((await carol.get(`marketplace/${l.id}/offers`)).body.items.map(o => o.id), [carolOffer.id], 'buyers only see their own');
  assert.equal((await bob.get(`marketplace/${l.id}`)).body.listing.viewer.offer.amount, 9000);

  assert.equal((await carol.post(`marketplace/${l.id}/offers/${second.body.offer.id}/accept`)).status, 403);
  const declined = await alice.post(`marketplace/${l.id}/offers/${carolOffer.id}/decline`);
  assert.equal(declined.body.offer.status, 'declined');
  assert.ok((await notifications(carol)).some(n => n.link === `/marketplace/${l.id}` && /declined/.test(n.body)));
  assert.equal((await alice.post(`marketplace/${l.id}/offers/${carolOffer.id}/accept`)).status, 409, 'answered already');

  const accepted = await alice.post(`marketplace/${l.id}/offers/${second.body.offer.id}/accept`);
  assert.equal(accepted.body.offer.status, 'accepted');
  assert.equal(accepted.body.listing.status, 'pending');
  assert.equal(accepted.body.listing.buyer.handle, 'bob');
  assert.ok((await notifications(bob)).some(n => n.link === `/marketplace/${l.id}` && /accepted/.test(n.body)));
  assert.equal((await carol.get(`marketplace/${l.id}`)).body.listing.buyer, null, 'only the parties see the buyer');

  const kevinOffer = (await kevin.post(`marketplace/${l.id}/offers`, { amount: 9500 })).body.offer;
  assert.equal((await kevin.del(`marketplace/${l.id}/offers/${kevinOffer.id}`)).body.offer.status, 'withdrawn');
  assert.equal((await bob.del(`marketplace/${l.id}/offers/${kevinOffer.id}`)).status, 404);
});

test('marketplace: sold state and reviews between the two parties', async () => {
  const tag = word();
  const l = await listing(alice, { title: `Fridge ${tag}` });
  assert.equal((await bob.put(`marketplace/${l.id}/review`, { rating: 5 })).status, 403, 'not sold yet');
  await bob.post(`marketplace/${l.id}/offers`, { amount: 10000 });
  await carol.post(`marketplace/${l.id}/offers`, { amount: 9000 });

  assert.equal((await bob.post(`marketplace/${l.id}/status`, { status: 'sold' })).status, 403);
  assert.equal((await alice.post(`marketplace/${l.id}/status`, { status: 'gone' })).status, 422);
  assert.equal((await alice.post(`marketplace/${l.id}/status`, { status: 'sold', buyer: 'kevin' })).status, 422, 'kevin made no offer');
  assert.equal((await alice.post(`marketplace/${l.id}/status`, { status: 'sold', buyer: 'alice' })).status, 422);
  assert.equal((await alice.post(`marketplace/${l.id}/status`, { status: 'sold', buyer: 'nobody_here' })).status, 404);

  const pending = await alice.post(`marketplace/${l.id}/status`, { status: 'pending' });
  assert.equal(pending.body.listing.status, 'pending');
  const sold = await alice.post(`marketplace/${l.id}/status`, { status: 'sold', buyer: 'bob' });
  assert.equal(sold.status, 200, sold.text);
  assert.equal(sold.body.listing.status, 'sold');
  assert.equal(sold.body.listing.buyer.handle, 'bob');
  assert.ok(sold.body.listing.sold_at);
  assert.ok((await notifications(bob)).some(n => n.link === `/marketplace/${l.id}` && /sold to you/.test(n.body)));
  const offers = (await alice.get(`marketplace/${l.id}/offers`)).body.items;
  assert.equal(offers.find(o => o.buyer.handle === 'carol').status, 'declined', 'other offers are closed');
  assert.equal(offers.find(o => o.buyer.handle === 'bob').status, 'accepted', "the buyer's offer is accepted");
  assert.equal((await kevin.post(`marketplace/${l.id}/offers`, { amount: 100 })).status, 409);

  assert.deepEqual((await anon.get(`marketplace?q=${tag}`)).body.items, [], 'sold listings leave the browse list');
  const withSold = (await anon.get(`marketplace?q=${tag}&include_sold=1`)).body.items;
  assert.equal(withSold[0].status, 'sold');
  assert.equal((await alice.get('marketplace/mine?status=sold')).body.items[0].id, l.id);
  assert.ok((await alice.get('marketplace/mine')).body.counts.sold >= 1);

  assert.equal((await bob.get(`marketplace/${l.id}`)).body.listing.viewer.can_review, true);
  assert.equal((await carol.get(`marketplace/${l.id}`)).body.listing.viewer.can_review, false);
  assert.equal((await carol.put(`marketplace/${l.id}/review`, { rating: 1 })).status, 403, 'not a party to the sale');
  assert.equal((await bob.put(`marketplace/${l.id}/review`, { rating: 6 })).status, 422);
  assert.equal((await bob.put(`marketplace/${l.id}/review`, { rating: 0 })).status, 422);
  assert.equal((await bob.put(`marketplace/${l.id}/review`, { rating: 4, comment: 'x'.repeat(501) })).status, 422);

  const before = (await anon.get('marketplace/sellers/alice')).body.rating;
  const review = await bob.put(`marketplace/${l.id}/review`, { rating: 4, comment: 'Easy pickup.' });
  assert.equal(review.status, 201, review.text);
  assert.equal(review.body.review.role, 'seller');
  assert.equal(review.body.review.reviewee_id, 'dev-alice');
  assert.ok((await notifications(alice)).some(n => n.link === `/marketplace/${l.id}` && /reviewed you/.test(n.body)));
  const edited = await bob.put(`marketplace/${l.id}/review`, { rating: 5, comment: 'Easy pickup, as described.' });
  assert.equal(edited.status, 200, 'editing keeps one review');
  assert.equal(edited.body.review.id, review.body.review.id);

  const back = await alice.put(`marketplace/${l.id}/review`, { rating: 5, comment: 'Paid on time.' });
  assert.equal(back.body.review.role, 'buyer');

  const page = (await anon.get('marketplace/sellers/alice')).body;
  assert.equal(page.seller.handle, 'alice');
  assert.equal(page.rating.count, before.count + 1);
  assert.ok(page.reviews.some(r => r.id === review.body.review.id && r.rating === 5 && r.reviewer.handle === 'bob'));
  assert.ok(page.sold_count >= 1);
  assert.equal((await anon.get('marketplace/sellers/bob')).body.reviews[0].rating, 5);
  assert.equal((await anon.get('marketplace/sellers/nobody_here')).status, 404);

  const detail = (await bob.get(`marketplace/${l.id}`)).body.listing;
  assert.equal(detail.reviews.length, 2);
  assert.equal(detail.viewer.review.rating, 5);
  assert.equal((await alice.post(`marketplace/${l.id}/status`, { status: 'available' })).status, 409, 'reviewed sales are final');
});

test('marketplace: saved searches notify on new matching listings', async () => {
  const tag = word();
  assert.equal((await carol.post('marketplace/searches', {})).status, 422, 'needs a term or a filter');
  assert.equal((await carol.post('marketplace/searches', { category: 'weapons' })).status, 422);
  assert.equal((await carol.post('marketplace/searches', { min_price: 500, max_price: 100 })).status, 422);
  const saved = await carol.post('marketplace/searches', { q: `${tag} chair`, max_price: 5000, location: 'Marrickville' });
  assert.equal(saved.status, 201, saved.text);
  assert.equal((await carol.post('marketplace/searches', { q: `${tag} chair`, max_price: 5000, location: 'marrickville' })).status, 409);
  assert.ok((await carol.get('marketplace/searches')).body.items.some(s => s.id === saved.body.search.id));
  const notYours = await bob.del(`marketplace/searches/${saved.body.search.id}`);
  assert.equal(notYours.status, 403);
  assert.deepEqual(notYours.body, { error: NO_DELETING });
  await alice.post('marketplace/searches', { q: tag }); // matches alice's own listings below

  const match = await listing(alice, { title: `Chair ${tag}`, price: 4000, location: 'Marrickville 2204' });
  const tooDear = await listing(alice, { title: `Chair ${tag}`, price: 9000, location: 'Marrickville 2204' });
  const elsewhere = await listing(alice, { title: `Chair ${tag}`, price: 1000, location: 'Bondi' });
  const otherWord = await listing(alice, { title: `Table ${tag}`, price: 1000, location: 'Marrickville' });

  const links = (await notifications(carol)).map(n => n.link);
  assert.ok(links.includes(`/marketplace/${match.id}`));
  for (const l of [tooDear, elsewhere, otherWord]) assert.ok(!links.includes(`/marketplace/${l.id}`), l.title);
  assert.ok(!(await notifications(alice)).some(n => n.link === `/marketplace/${match.id}`), 'never for your own listing');

  const patched = await carol.patch(`marketplace/searches/${saved.body.search.id}`, { max_price: null });
  assert.equal(patched.body.search.max_price, null);
  const refused = await carol.del(`marketplace/searches/${saved.body.search.id}`);
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: NO_DELETING }, 'saved searches cannot be deleted either');
  const searches = (await carol.get('marketplace/searches')).body.items;
  assert.equal(searches.find(s => s.id === saved.body.search.id)?.max_price, null, 'the search stays, as edited');
  assert.equal((await anon.get('marketplace/searches')).status, 401);
});

test('marketplace: your listings by status', async () => {
  const mine = await listing(kevin, { title: 'Spare keyboard', category: 'electronics' });
  await kevin.post(`marketplace/${mine.id}/status`, { status: 'pending' });
  const res = await kevin.get('marketplace/mine?status=pending');
  assert.equal(res.body.items[0].id, mine.id);
  assert.ok(res.body.counts.pending >= 1);
  assert.ok(!(await kevin.get('marketplace/mine?status=available')).body.items.some(x => x.id === mine.id));
  assert.ok(!(await bob.get('marketplace/mine')).body.items.some(x => x.id === mine.id));
  assert.equal((await anon.get('marketplace/mine')).status, 401);
});
