// Marketplace (Facebook Marketplace / Gumtree). One module for two routes:
//   /marketplace                 tabs: Browse (search, categories, filters, grid), Saved, Your listings, Sell
//                                ?q&category&condition&min&max&location&sort   browse filters (min/max in dollars)
//                                ?tab=saved|yours|sell   ?status=available|pending|sold (Your listings)
//                                ?tab=sell&edit=<id>     edit a listing
//                                ?seller=<handle>        a seller's listings, rating and reviews
//   /marketplace/:listingId      a listing: photos, details, seller, offers, sale and reviews
// API: /api/marketplace (see src/routes/marketplace.ts for the shapes). Prices are cents.

import { api } from '../api.js';
import { track } from '../analytics.js';
import { h, mount } from '../dom.js';
import { fullDate, money, plural, timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, errorBox, infiniteList, loading, share, shake, tabs, toast, toastError } from '../ui.js';
import { pickFiles, uploadFile } from '../upload.js';
import { carousel } from '../components/media.js';
import { avatar, userName } from '../components/user.js';

export const CATEGORIES = [
  ['electronics', 'Electronics'], ['furniture', 'Furniture'], ['home_garden', 'Home and garden'], ['clothing', 'Clothing'],
  ['vehicles', 'Vehicles'], ['sport_outdoors', 'Sport and outdoors'], ['books', 'Books'], ['toys', 'Toys'], ['other', 'Other'],
];
export const CONDITIONS = [['new', 'New'], ['like_new', 'Like new'], ['good', 'Good'], ['fair', 'Fair'], ['for_parts', 'For parts']];
const SORTS = [['newest', 'Newest'], ['price_low', 'Price: low to high'], ['price_high', 'Price: high to low']];
const STATUS_LABEL = { available: 'Available', pending: 'Pending', sold: 'Sold' };
const OFFER_STATUS = { pending: 'Waiting for a reply', accepted: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn' };
const MAX_PHOTOS = 10;
const enc = encodeURIComponent;

const labelOf = (list, key) => list.find(([k]) => k === key)?.[1] || '';

/** "$120", "$12.50" or "Free". */
export const priceLabel = cents => (cents === 0 ? 'Free' : cents % 100 ? money(cents) : `$${(cents / 100).toLocaleString('en-AU')}`);

/** "12.50" -> 1250; '' -> null; anything else -> NaN. */
function toCents(value) {
  const s = String(value ?? '').replace(/[$,\s]/g, '');
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}
const toDollars = cents => (cents == null ? '' : cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));

function ago(ms) {
  const t = timeAgo(ms);
  return t === 'now' ? 'just now' : /^\d+[mhd]$/.test(t) ? `${t} ago` : `on ${t}`;
}
const when = ms => h('time', { datetime: new Date(ms).toISOString(), title: fullDate(ms) }, ago(ms));

const ratingText = r => (r && r.count ? `${r.average} out of 5 from ${plural(r.count, 'review')}` : 'No reviews yet.');

const delivery = l => (l.pickup && l.postage ? 'Pickup or postage' : l.postage ? 'Postage' : 'Pickup');

export default async function marketplaceView(ctx) {
  ctx.layout('wide');
  if (ctx.params.listingId) return listingPage(ctx, ctx.params.listingId);
  if (ctx.query.get('seller')) return sellerPage(ctx, ctx.query.get('seller'));
  return homePage(ctx);
}

// ── Shared pieces ───────────────────────────────────────────────────────

/** A square box with the photo stretched into it. */
function photoBox(url, status) {
  return h('div.mk-photo',
    url ? h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' }) : h('span.mk-nophoto', 'No photo'),
    status && status !== 'available' ? h('span.mk-status', STATUS_LABEL[status]) : null);
}

/** A listing in a grid. */
export function listingTile(item) {
  return h('a.mk-tile', { href: `/marketplace/${item.id}`, class: { sold: item.status === 'sold' } },
    photoBox(item.photo_url, item.status),
    h('p.mk-price', priceLabel(item.price)),
    h('p.mk-tile-title', item.title),
    h('p.mk-place', item.location));
}

function grid(ctx, load, emptyText = 'No listings found.') {
  return wrapList(infiniteList({
    className: 'mk-grid', signal: ctx.signal,
    load: cursor => load(cursor),
    render: listingTile,
    empty: empty({ title: emptyText }),
  }));
}

/** infiniteList's wrapper is a plain div; keep the halo off it so only the tiles get one. */
const wrapList = list => { list.classList.add('mk-list'); return list; };

function loginCard(text) {
  return h('div.south-card.flat.mk-login', h('p', text), h('button', { type: 'button', onclick: () => login() }, 'Log in'));
}

const field = (label, input, hint) => h('label.field', h('span', label), input, hint ? h('small.fine', hint) : null);
const select = (options, value, props = {}) =>
  h('select.select', props, options.map(([v, label]) => h('option', { value: v, selected: v === (value ?? '') }, label)));
const checkbox = (label, checked) => {
  const input = h('input', { type: 'checkbox', checked });
  return { input, node: h('label.checkbox', input, h('span', label)) };
};

/** A dialog holding a form; `onSubmit()` may throw, which keeps it open. Resolves with its result or null. */
function formDialog({ title, content, ok = 'Save', onSubmit }) {
  return dialog({
    title, actions: [],
    body: close => {
      const submit = h('button', { type: 'submit' }, ok);
      const form = h('form.mk-dialog-form', {
        onsubmit: async e => {
          e.preventDefault();
          submit.disabled = true;
          try { close((await onSubmit()) ?? true); } catch (err) { toastError(err); shake(form); submit.disabled = false; }
        },
      }, content, h('div.mk-dialog-actions', h('button', { type: 'button', onclick: () => close(null) }, 'Cancel'), submit));
      return form;
    },
  });
}

// ── /marketplace ────────────────────────────────────────────────────────

const TABS = [['browse', 'Browse'], ['saved', 'Saved'], ['yours', 'Your listings'], ['sell', 'Sell']];

/** Browse filters from the address bar. */
function readFilters(query) {
  const pick = (list, key) => (list.some(([k]) => k === query.get(key)) ? query.get(key) : '');
  return {
    q: (query.get('q') || '').trim(),
    category: pick(CATEGORIES, 'category'),
    condition: pick(CONDITIONS, 'condition'),
    min: query.get('min') || '',
    max: query.get('max') || '',
    location: (query.get('location') || '').trim(),
    sort: pick(SORTS, 'sort') || 'newest',
  };
}

function browseUrl(f) {
  const params = new URLSearchParams();
  for (const key of ['q', 'category', 'condition', 'min', 'max', 'location']) if (f[key]) params.set(key, f[key]);
  if (f.sort && f.sort !== 'newest') params.set('sort', f.sort);
  const s = params.toString();
  return `/marketplace${s ? `?${s}` : ''}`;
}

/** API query (cents) for browse filters. */
function apiFilters(f) {
  const min = toCents(f.min), max = toCents(f.max);
  return {
    q: f.q, category: f.category, condition: f.condition, location: f.location, sort: f.sort,
    min_price: Number.isInteger(min) ? min : null, max_price: Number.isInteger(max) ? max : null,
  };
}

function homePage(ctx) {
  const tab = TABS.some(([t]) => t === ctx.query.get('tab')) ? ctx.query.get('tab') : 'browse';
  ctx.title(tab === 'sell' ? 'Sell' : 'Marketplace');
  const filters = readFilters(ctx.query);

  const q = h('input.input', { type: 'search', value: filters.q, placeholder: 'Search Marketplace', 'aria-label': 'Search Marketplace', maxLength: 100 });
  const search = h('form.mk-search', {
    role: 'search',
    onsubmit: e => {
      e.preventDefault();
      track('social_listing_searched', { q: q.value.trim() });
      navigate(browseUrl({ ...(tab === 'browse' ? filters : {}), q: q.value.trim() }));
    },
  }, q, h('button', { type: 'submit' }, 'Search'));

  const categories = h('nav.mk-categories', { 'aria-label': 'Categories' },
    h('a', { href: browseUrl({ ...filters, category: '' }), 'aria-current': tab === 'browse' && !filters.category ? 'page' : null }, 'All'),
    CATEGORIES.map(([key, label]) => h('a', {
      href: browseUrl({ ...filters, category: key }),
      'aria-current': tab === 'browse' && filters.category === key ? 'page' : null,
    }, label)));

  const tabBar = tabs(TABS.map(([key, label]) => ({
    href: key === 'browse' ? browseUrl(filters) : `/marketplace?tab=${key}`, label, current: key === tab,
  })));

  let body;
  if (tab === 'saved') body = savedTab(ctx);
  else if (tab === 'yours') body = yoursTab(ctx);
  else if (tab === 'sell') body = sellTab(ctx);
  else body = browseTab(ctx, filters);

  return h('div.mk',
    h('div.page-head', h('h1', 'Marketplace')),
    search, categories, tabBar, body);
}

function browseTab(ctx, filters) {
  const condition = select([['', 'Any'], ...CONDITIONS], filters.condition);
  const min = h('input.input', { value: filters.min, inputMode: 'decimal', placeholder: '0', 'aria-label': 'Minimum price in dollars' });
  const max = h('input.input', { value: filters.max, inputMode: 'decimal', placeholder: 'Any', 'aria-label': 'Maximum price in dollars' });
  const location = h('input.input', { value: filters.location, placeholder: 'Suburb or postcode', maxLength: 80 });
  const sort = select(SORTS, filters.sort);
  const current = () => ({ ...filters, condition: condition.value, min: min.value.trim(), max: max.value.trim(), location: location.value.trim(), sort: sort.value });

  const check = f => {
    for (const v of [f.min, f.max]) if (Number.isNaN(toCents(v))) throw new Error('Prices must be numbers.');
    return f;
  };
  const apply = e => {
    e.preventDefault();
    try { navigate(browseUrl(check(current()))); } catch (err) { toastError(err); }
  };
  const saveSearch = async () => {
    if (!store.me) return login();
    try {
      const f = check(current());
      const a = apiFilters(f);
      await api.post('marketplace/searches', {
        q: a.q, category: a.category || null, condition: a.condition || null, min_price: a.min_price, max_price: a.max_price, location: a.location,
      });
      toast('Search saved. We will let you know about new listings.');
    } catch (err) { toastError(err); }
  };

  const used = [filters.condition, filters.min, filters.max, filters.location].filter(Boolean).length;
  const toggle = h('button.mk-filter-toggle', {
    type: 'button', 'aria-expanded': 'false',
    onclick: () => {
      const open = panel.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Hide filters' : filterLabel;
    },
  });
  const filterLabel = used ? `Filters (${used})` : 'Filters';
  toggle.textContent = filterLabel;
  const panel = h('form.south-card.flat.mk-filters', { onsubmit: apply },
    h('h3', 'Filters'),
    field('Condition', condition),
    h('div.mk-price-range', field('Min price', min), field('Max price', max)),
    field('Location', location),
    field('Sort by', sort),
    h('div.mk-filter-actions',
      h('button', { type: 'submit' }, 'Apply'),
      h('a.btn', { href: browseUrl({ q: filters.q, category: filters.category }) }, 'Clear'),
      h('button', { type: 'button', onclick: saveSearch }, 'Save search')));

  const heading = filters.q ? `Results for "${filters.q}"` : filters.category ? labelOf(CATEGORIES, filters.category) : 'Latest listings';
  return h('div.mk-browse',
    toggle,
    panel,
    h('section.mk-results',
      h('h2.mk-section-title', heading),
      grid(ctx, cursor => api.get('marketplace', { ...apiFilters(filters), cursor }, { signal: ctx.signal }))));
}

function searchSummary(s) {
  const parts = [];
  if (s.q) parts.push(`"${s.q}"`);
  if (s.category) parts.push(labelOf(CATEGORIES, s.category));
  if (s.condition) parts.push(labelOf(CONDITIONS, s.condition));
  if (s.min_price != null && s.max_price != null) parts.push(`${priceLabel(s.min_price)} to ${priceLabel(s.max_price)}`);
  else if (s.min_price != null) parts.push(`From ${priceLabel(s.min_price)}`);
  else if (s.max_price != null) parts.push(`Up to ${priceLabel(s.max_price)}`);
  if (s.location) parts.push(`In ${s.location}`);
  return parts.join(', ');
}

const searchUrl = s => browseUrl({
  q: s.q, category: s.category || '', condition: s.condition || '', location: s.location,
  min: toDollars(s.min_price), max: toDollars(s.max_price),
});

function savedTab(ctx) {
  if (!store.me) return loginCard('Log in to see the listings and searches you have saved.');
  const searches = h('div.mk-searches', loading());
  api.get('marketplace/searches', null, { signal: ctx.signal }).then(({ items }) => {
    if (!items.length) return mount(searches, h('p.muted', 'No saved searches. Use "Save search" on the Browse tab to hear about new listings.'));
    mount(searches, items.map(s => {
      const row = h('div.mk-search-row',
        h('a', { href: searchUrl(s) }, searchSummary(s)),
        h('button.btn-small', {
          type: 'button',
          onclick: async () => {
            try { await api.del(`marketplace/searches/${s.id}`); row.remove(); toast('Removed.'); } catch (err) { toastError(err); }
          },
        }, 'Remove'));
      return row;
    }));
  }).catch(err => { if (err.name !== 'AbortError') mount(searches, errorBox(err)); });

  return h('div.mk-tab',
    h('section.south-card.flat', h('h2.mk-section-title', 'Saved searches'), searches),
    h('section.mk-plain', h('h2.mk-section-title', 'Saved listings'),
      grid(ctx, cursor => api.get('marketplace/saved', { cursor }, { signal: ctx.signal }), 'No saved listings.')));
}

function yoursTab(ctx) {
  if (!store.me) return loginCard('Log in to see your listings.');
  const status = ['available', 'pending', 'sold'].includes(ctx.query.get('status')) ? ctx.query.get('status') : 'available';
  const bar = h('div.mk-status-tabs');
  const paintBar = counts => mount(bar, tabs(['available', 'pending', 'sold'].map(s => ({
    href: `/marketplace?tab=yours&status=${s}`,
    label: counts ? `${STATUS_LABEL[s]} (${counts[s]})` : STATUS_LABEL[s],
    current: s === status,
  }))));
  paintBar(null);
  const list = wrapList(infiniteList({
    className: 'mk-grid', signal: ctx.signal,
    load: async cursor => {
      const res = await api.get('marketplace/mine', { status, cursor }, { signal: ctx.signal });
      paintBar(res.counts);
      return res;
    },
    render: listingTile,
    empty: empty({ title: status === 'available' ? 'No listings yet.' : `No ${STATUS_LABEL[status].toLowerCase()} listings.`,
      action: status === 'available' ? h('a.btn', { href: '/marketplace?tab=sell' }, 'Sell something') : null }),
  }));
  return h('div.mk-tab', bar, list);
}

// ── Sell / edit ─────────────────────────────────────────────────────────

function sellTab(ctx) {
  if (!store.me) return loginCard('Log in to sell on Marketplace.');
  const editId = ctx.query.get('edit');
  if (!editId) return sellForm(ctx, null);
  const holder = h('div.mk-tab', loading());
  api.get(`marketplace/${enc(editId)}`, null, { signal: ctx.signal }).then(({ listing }) => {
    if (!listing.viewer.is_owner) return mount(holder, errorBox(new Error('Only the seller can edit this listing.')));
    ctx.title('Edit listing');
    mount(holder, sellForm(ctx, listing));
  }).catch(err => { if (err.name !== 'AbortError') mount(holder, errorBox(err)); });
  return holder;
}

function sellForm(ctx, existing) {
  // Photos: { id, url } once uploaded; { preview, progress } while uploading. `fresh` ones were uploaded here.
  const photos = existing ? existing.photos.map(p => ({ id: p.id, url: p.url })) : [];
  const photoList = h('div.mk-photo-edit-list');
  const uploading = () => photos.some(p => !p.id);

  const move = (i, dir) => { const [p] = photos.splice(i, 1); photos.splice(i + dir, 0, p); paintPhotos(); };
  const remove = i => {
    const [p] = photos.splice(i, 1);
    p.abort?.abort();
    if (p.fresh && p.id) api.del(`media/${p.id}`).catch(() => {});
    paintPhotos();
  };
  async function addPhotos() {
    const files = await pickFiles({ accept: 'image/*', multiple: true });
    const room = MAX_PHOTOS - photos.length;
    if (files.length > room) toast(`Listings can have up to ${MAX_PHOTOS} photos.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      const item = { preview: URL.createObjectURL(file), progress: 0, abort: new AbortController(), fresh: true };
      photos.push(item);
      uploadFile(file, { signal: item.abort.signal, onProgress: p => { item.progress = p; paintPhotos(); } })
        .then(m => { item.id = m.id; item.url = m.url; paintPhotos(); })
        .catch(err => {
          if (err.name === 'AbortError') return;
          toastError(err);
          const i = photos.indexOf(item);
          if (i >= 0) photos.splice(i, 1);
          paintPhotos();
        });
    }
    paintPhotos();
  }
  function paintPhotos() {
    mount(photoList,
      photos.map((p, i) => h('div.mk-photo-edit',
        h('div.mk-photo',
          h('img', { src: p.url || p.preview, alt: `Photo ${i + 1}` }),
          i === 0 ? h('span.mk-status', 'Cover') : null,
          p.id ? null : h('span.mk-progress', `Uploading ${Math.round((p.progress || 0) * 100)}%`)),
        h('div.mk-photo-buttons',
          h('button.btn-small', { type: 'button', disabled: i === 0, onclick: () => move(i, -1) }, 'Left'),
          h('button.btn-small', { type: 'button', disabled: i === photos.length - 1, onclick: () => move(i, 1) }, 'Right'),
          h('button.btn-small', { type: 'button', onclick: () => remove(i) }, 'Remove')))),
      photos.length < MAX_PHOTOS
        ? h('button.mk-add-photo', { type: 'button', onclick: addPhotos }, photos.length ? 'Add more photos' : 'Add photos')
        : null);
  }
  paintPhotos();

  const title = h('input.input', { value: existing?.title || '', maxLength: 100 });
  const price = h('input.input', { value: existing ? toDollars(existing.price) : '', inputMode: 'decimal', placeholder: '0 for free' });
  const negotiable = checkbox('Open to offers', existing?.negotiable ?? false);
  const category = select([['', 'Choose a category'], ...CATEGORIES], existing?.category || '');
  const condition = select([['', 'Choose a condition'], ...CONDITIONS], existing?.condition || '');
  const description = h('textarea.textarea', { rows: 6, maxLength: 5000 }, existing?.description || '');
  const location = h('input.input', { value: existing?.location || '', maxLength: 80, placeholder: 'Suburb or postcode' });
  const pickup = checkbox('Pickup', existing ? existing.pickup : true);
  const postage = checkbox('Postage', existing?.postage ?? false);
  const submit = h('button.btn-large', { type: 'submit' }, existing ? 'Save' : 'Publish');

  const form = h('form.south-card.flat.mk-sell', {
    onsubmit: async e => {
      e.preventDefault();
      const cents = toCents(price.value);
      const problem = !photos.length ? 'Add at least one photo.'
        : uploading() ? 'Wait for the photos to finish uploading.'
        : !title.value.trim() ? 'Add a title.'
        : cents == null || Number.isNaN(cents) ? 'Enter a price in dollars. Use 0 for free.'
        : !category.value ? 'Choose a category.'
        : !condition.value ? 'Choose a condition.'
        : !location.value.trim() ? 'Add a suburb or postcode.'
        : !pickup.input.checked && !postage.input.checked ? 'Choose pickup, postage or both.'
        : null;
      if (problem) { toastError(new Error(problem)); shake(form); return; }
      const data = {
        title: title.value.trim(), price: cents, negotiable: negotiable.input.checked, category: category.value,
        condition: condition.value, description: description.value.trim(), location: location.value.trim(),
        pickup: pickup.input.checked, postage: postage.input.checked, photo_ids: photos.map(p => p.id),
      };
      submit.disabled = true;
      try {
        const { listing } = existing ? await api.patch(`marketplace/${existing.id}`, data) : await api.post('marketplace', data);
        photos.forEach(p => { p.fresh = false; });
        toast(existing ? 'Saved.' : 'Listed.');
        navigate(`/marketplace/${listing.id}`);
      } catch (err) {
        toastError(err);
        shake(form);
        submit.disabled = false;
      }
    },
  },
  h('h2', existing ? 'Edit listing' : 'Sell something'),
  h('div.field', h('span', 'Photos'), h('small.fine.mk-photo-hint', `Up to ${MAX_PHOTOS}. The first photo is the cover.`), photoList),
  field('Title', title),
  h('div.mk-two',
    field('Price', price, 'In dollars. Use 0 for free.'),
    h('div.field.mk-check-field', negotiable.node)),
  h('div.mk-two', field('Category', category), field('Condition', condition)),
  field('Description', description),
  field('Suburb or postcode', location),
  h('div.field', h('span', 'Delivery'), h('div.mk-checks', pickup.node, postage.node)),
  h('div.mk-sell-actions',
    existing ? h('a.btn', { href: `/marketplace/${existing.id}` }, 'Cancel') : null,
    submit));
  return form;
}

// ── /marketplace/:listingId ─────────────────────────────────────────────

async function listingPage(ctx, id) {
  ctx.title('Marketplace');
  let listing;
  try {
    listing = (await api.get(`marketplace/${enc(id)}`, null, { signal: ctx.signal })).listing;
  } catch (err) {
    if (err.status !== 404) throw err;
    return h('div.south-card.flat', h('h2', 'Listing not found'), h('p', 'It may have been sold or deleted.'),
      h('a.btn', { href: '/marketplace' }, 'Back to Marketplace'));
  }
  ctx.title(listing.title);
  const root = h('div.mk-listing');
  const offersBox = h('div');
  let offers = [];

  const reload = async () => {
    try {
      listing = (await api.get(`marketplace/${listing.id}`)).listing;
      paint();
    } catch (err) { toastError(err); }
  };

  async function loadOffers() {
    if (!listing.viewer.is_owner) return;
    try {
      offers = (await api.get(`marketplace/${listing.id}/offers`, null, { signal: ctx.signal })).items;
      paintOffers();
    } catch (err) { if (err.name !== 'AbortError') mount(offersBox, errorBox(err)); }
  }

  function paintOffers() {
    mount(offersBox, h('section.south-card.flat.mk-offers',
      h('h2.mk-section-title', 'Offers'),
      offers.length ? offers.map(offerRow) : h('p.muted', 'No offers yet.')));
  }

  function offerRow(o) {
    const answer = async decision => {
      if (decision === 'accept' && !(await confirm(`Accept ${priceLabel(o.amount)} from @${o.buyer.handle}? The listing will be marked as pending.`, { title: 'Accept offer', ok: 'Accept' }))) return;
      try {
        const res = await api.post(`marketplace/${listing.id}/offers/${o.id}/${decision}`);
        Object.assign(o, res.offer);
        if (res.listing) listing = res.listing;
        toast(decision === 'accept' ? 'Offer accepted.' : 'Offer declined.');
        paint();
      } catch (err) { toastError(err); }
    };
    return h('div.mk-offer',
      avatar(o.buyer, { size: 'sm' }),
      h('div.grow',
        h('p.mk-offer-head', userName(o.buyer), ' offered ', h('strong', priceLabel(o.amount))),
        o.message ? h('p.mk-offer-message', o.message) : null,
        h('p.fine', OFFER_STATUS[o.status], ', ', when(o.created_at))),
      o.status === 'pending' && listing.status !== 'sold'
        ? h('div.mk-offer-buttons',
          h('button.btn-small', { type: 'button', onclick: () => answer('accept') }, 'Accept'),
          h('button.btn-small', { type: 'button', onclick: () => answer('decline') }, 'Decline'))
        : null);
  }

  // -- Actions --

  async function makeOffer() {
    if (!store.me) return login();
    const amount = h('input.input', { inputMode: 'decimal', value: toDollars(listing.price) || '', placeholder: 'Amount in dollars' });
    const message = h('textarea.textarea', { rows: 3, maxLength: 500, placeholder: 'Optional' });
    const res = await formDialog({
      title: 'Make an offer', ok: 'Send offer',
      content: [
        h('p.muted', `Asking ${priceLabel(listing.price)}${listing.negotiable ? ', open to offers' : ''}.`),
        field('Your offer', amount, 'In dollars.'),
        field('Message', message),
      ],
      onSubmit: () => {
        const cents = toCents(amount.value);
        if (!cents) throw new Error('Enter an amount in dollars.');
        return api.post(`marketplace/${listing.id}/offers`, { amount: cents, message: message.value.trim() });
      },
    });
    if (!res) return;
    toast('Offer sent.');
    listing.viewer.offer = res.offer;
    paint();
  }

  async function withdrawOffer() {
    try {
      const res = await api.del(`marketplace/${listing.id}/offers/${listing.viewer.offer.id}`);
      listing.viewer.offer = res.offer;
      toast('Offer withdrawn.');
      paint();
    } catch (err) { toastError(err); }
  }

  async function toggleSave(btn) {
    if (!store.me) return login();
    btn.disabled = true;
    try {
      const res = listing.saved ? await api.del(`marketplace/${listing.id}/save`) : await api.put(`marketplace/${listing.id}/save`);
      listing.saved = res.saved;
      listing.save_count = res.save_count;
      toast(res.saved ? 'Saved.' : 'Removed from saved.');
      paint();
    } catch (err) { toastError(err); btn.disabled = false; }
  }

  async function setStatus(status, extra = {}) {
    try {
      listing = (await api.post(`marketplace/${listing.id}/status`, { status, ...extra })).listing;
      toast(status === 'sold' ? 'Marked as sold.' : status === 'pending' ? 'Marked as pending.' : 'Marked as available.');
      paint();
    } catch (err) { toastError(err); }
  }

  async function markSold() {
    const people = [...new Map(offers.filter(o => o.status !== 'withdrawn').map(o => [o.buyer.handle, o.buyer])).values()];
    const current = listing.buyer?.handle || '';
    if (current && !people.some(p => p.handle === current)) people.unshift(listing.buyer);
    const who = select([
      ...people.map(p => [p.handle, `${p.name} (@${p.handle})`]),
      ['__other', 'Someone else'],
      ['', 'Sold elsewhere'],
    ], current || (people[0]?.handle ?? '__other'));
    const other = h('input.input', { placeholder: 'Their username', maxLength: 40 });
    const otherField = field('Username', other, 'They must have made an offer or messaged you.');
    const sync = () => otherField.classList.toggle('hidden', who.value !== '__other');
    who.addEventListener('change', sync);
    sync();
    const ok = await formDialog({
      title: 'Mark as sold', ok: 'Mark as sold',
      content: [
        field('Who bought it?', who, 'You and the buyer can review each other afterwards.'),
        otherField,
      ],
      onSubmit: async () => {
        const buyer = who.value === '__other' ? other.value.trim().replace(/^@/, '') : who.value;
        if (who.value === '__other' && !buyer) throw new Error('Enter their username.');
        listing = (await api.post(`marketplace/${listing.id}/status`, { status: 'sold', buyer: buyer || null })).listing;
        return true;
      },
    });
    if (!ok) return;
    toast('Marked as sold.');
    await loadOffers();
    paint();
  }

  async function remove() {
    if (!(await confirm('Delete this listing? This cannot be undone.', { title: 'Delete listing', ok: 'Delete' }))) return;
    try {
      await api.del(`marketplace/${listing.id}`);
      toast('Deleted.');
      navigate('/marketplace?tab=yours');
    } catch (err) { toastError(err); }
  }

  // -- Painting --

  function actions() {
    const v = listing.viewer;
    if (v.is_owner) {
      const locked = listing.status === 'sold' && listing.reviews.length > 0;
      return h('div.mk-actions',
        h('a.btn', { href: `/marketplace?tab=sell&edit=${listing.id}` }, 'Edit'),
        listing.status === 'available' ? h('button', { type: 'button', onclick: () => setStatus('pending') }, 'Mark as pending') : null,
        listing.status !== 'available' && !locked ? h('button', { type: 'button', onclick: () => setStatus('available') }, 'Mark as available') : null,
        listing.status !== 'sold' ? h('button', { type: 'button', onclick: markSold }, 'Mark as sold') : null,
        h('button', { type: 'button', onclick: () => share(`/marketplace/${listing.id}`, listing.title) }, 'Share'),
        h('button', { type: 'button', onclick: remove }, 'Delete'));
    }
    const saveBtn = h('button', { type: 'button', 'aria-pressed': String(listing.saved), onclick: () => toggleSave(saveBtn) }, listing.saved ? 'Saved' : 'Save');
    const offer = v.offer;
    return [
      h('div.mk-actions',
        h('a.btn', { href: `/messages?to=${enc(listing.seller.handle)}` }, 'Message seller'),
        listing.status !== 'sold' ? h('button', { type: 'button', onclick: makeOffer }, offer?.status === 'pending' ? 'Change offer' : 'Make an offer') : null,
        saveBtn,
        h('button', { type: 'button', onclick: () => { track('social_listing_shared', { listing_id: listing.id }); share(`/marketplace/${listing.id}`, listing.title); } }, 'Share')),
      offer ? h('p.mk-your-offer',
        `Your offer: ${priceLabel(offer.amount)}, ${OFFER_STATUS[offer.status].toLowerCase()}.`,
        offer.status === 'pending' && listing.status !== 'sold' ? [' ', h('button.btn-small', { type: 'button', onclick: withdrawOffer }, 'Withdraw')] : null) : null,
    ];
  }

  function sellerCard() {
    const s = listing.seller;
    return h('section.mk-seller',
      h('h3', 'Seller'),
      h('div.mk-seller-row',
        avatar(s, { size: 'lg' }),
        h('div.grow',
          userName(s),
          h('p.mk-rating', ratingText(s.rating)),
          h('a', { href: `/marketplace?seller=${enc(s.handle)}` }, 'See all listings'))));
  }

  function reviewForm() {
    const v = listing.viewer;
    if (!v.can_review) return null;
    const other = v.is_owner ? listing.buyer : listing.seller;
    const stars = select([['5', '5 out of 5'], ['4', '4 out of 5'], ['3', '3 out of 5'], ['2', '2 out of 5'], ['1', '1 out of 5']],
      String(v.review?.rating ?? 5));
    const comment = h('textarea.textarea', { rows: 3, maxLength: 500, placeholder: 'How did it go?' }, v.review?.comment || '');
    const submit = h('button', { type: 'submit' }, v.review ? 'Update review' : 'Post review');
    return h('form.south-card.flat.mk-review-form', {
      onsubmit: async e => {
        e.preventDefault();
        submit.disabled = true;
        try {
          await api.put(`marketplace/${listing.id}/review`, { rating: Number(stars.value), comment: comment.value.trim() });
          toast('Review posted.');
          await reload();
        } catch (err) { toastError(err); submit.disabled = false; }
      },
    },
    h('h2.mk-section-title', v.review ? 'Your review' : `Review @${other?.handle || 'them'}`),
    h('p.muted', v.is_owner ? 'How was the buyer?' : 'How was the seller?'),
    field('Rating', stars),
    field('Comment', comment),
    submit);
  }

  function reviewList() {
    if (!listing.reviews.length) return null;
    return h('section.south-card.flat.mk-reviews',
      h('h2.mk-section-title', 'Reviews for this sale'),
      listing.reviews.map(reviewRow));
  }

  function paint() {
    const l = listing;
    const v = l.viewer;
    const status = l.status !== 'available'
      ? h('p.mk-banner', l.status === 'sold' ? `Sold${l.sold_at ? ` ${ago(l.sold_at)}` : ''}` : 'Pending',
        l.buyer ? [' to ', h('a', { href: `/@${l.buyer.handle}` }, `@${l.buyer.handle}`)] : null)
      : null;
    mount(root,
      h('p.mk-back', h('a', { href: '/marketplace' }, 'Back to Marketplace')),
      h('div.mk-detail',
        h('div.mk-gallery', l.photos.length ? carousel(l.photos.map(p => ({ ...p, alt: l.title }))) : photoBox(null)),
        h('section.south-card.flat.mk-info',
          status,
          h('h1.mk-title', l.title),
          h('p.mk-big-price', priceLabel(l.price), l.negotiable ? h('span.chip', 'Open to offers') : null),
          h('dl.mk-facts',
            h('div', h('dt', 'Condition'), h('dd', labelOf(CONDITIONS, l.condition))),
            h('div', h('dt', 'Category'), h('dd', h('a', { href: browseUrl({ category: l.category }) }, labelOf(CATEGORIES, l.category)))),
            h('div', h('dt', 'Location'), h('dd', l.location)),
            h('div', h('dt', 'Delivery'), h('dd', delivery(l))),
            h('div', h('dt', 'Listed'), h('dd', when(l.created_at)))),
          h('p.fine', `${plural(l.view_count, 'view')}, ${plural(l.save_count, 'save')}`),
          actions(),
          v.is_owner ? null : sellerCard())),
      h('section.south-card.flat.mk-description',
        h('h2.mk-section-title', 'Description'),
        l.description ? h('p.mk-description-text', l.description) : h('p.muted', 'No description.')),
      v.is_owner ? offersBox : null,
      reviewForm(),
      reviewList());
    if (v.is_owner) paintOffers();
  }

  paint();
  if (listing.viewer.is_owner) {
    mount(offersBox, h('section.south-card.flat.mk-offers', h('h2.mk-section-title', 'Offers'), loading()));
    loadOffers();
  }
  return root;
}

function reviewRow(r) {
  return h('div.mk-review',
    avatar(r.reviewer, { size: 'sm' }),
    h('div.grow',
      h('p.mk-review-head', userName(r.reviewer, { handle: false }), ` rated ${r.rating} out of 5`),
      r.comment ? h('p.mk-review-text', r.comment) : null,
      // `role` is the reviewee's part, so a review of the seller was written by the buyer.
      h('p.fine', r.role === 'seller' ? 'Bought ' : 'Sold ', h('a', { href: `/marketplace/${r.listing.id}` }, r.listing.title), ', ', when(r.created_at))));
}

// ── /marketplace?seller=<handle> ────────────────────────────────────────

async function sellerPage(ctx, handle) {
  handle = handle.replace(/^@/, '');
  ctx.title('Marketplace');
  let data;
  try {
    data = await api.get(`marketplace/sellers/${enc(handle)}`, null, { signal: ctx.signal });
  } catch (err) {
    if (err.status !== 404) throw err;
    return h('div.south-card.flat', h('h2', 'Seller not found'), h('a.btn', { href: '/marketplace' }, 'Back to Marketplace'));
  }
  const s = data.seller;
  ctx.title(`${s.name} on Marketplace`);
  return h('div.mk',
    h('p.mk-back', h('a', { href: '/marketplace' }, 'Back to Marketplace')),
    h('section.south-card.flat.mk-seller-head',
      avatar(s, { size: 'xl' }),
      h('div.grow',
        h('h1.mk-seller-name', s.name),
        h('p', h('a', { href: `/@${s.handle}` }, `@${s.handle}`)),
        h('p.mk-rating', ratingText(data.rating)),
        h('p.fine', `${plural(data.listing_count, 'listing')} for sale, ${data.sold_count} sold`),
        store.me && store.me.handle !== s.handle ? h('a.btn', { href: `/messages?to=${enc(s.handle)}` }, 'Message') : null)),
    h('h2.mk-section-title', 'Listings'),
    grid(ctx, cursor => api.get('marketplace', { seller: s.handle, include_sold: 1, cursor }, { signal: ctx.signal })),
    h('section.south-card.flat.mk-reviews',
      h('h2.mk-section-title', 'Reviews'),
      data.reviews.length ? data.reviews.map(reviewRow) : h('p.muted', 'No reviews yet.')));
}
