// Paid sponsored placements (Southbag Ads). Every card is labelled Sponsored and reports the
// visit (POST /api/ads/:id/click, charged once per viewer per campaign) when someone opens what
// it promotes.

import { api } from '../api.js';
import { h } from '../dom.js';
import { money } from '../format.js';
import { postCard } from './post.js';
import { avatar, userName } from './user.js';

function trackClick(campaignId) {
  api.post(`ads/${campaignId}/click`).catch(() => {});
}

function sponsorLine(ad) {
  return h('span.muted.tiny', 'Promoted by ', h('a', { href: `/@${ad.sponsor.handle}` }, `@${ad.sponsor.handle}`));
}

/** A paid placement from the feed's `ads` list, or null when it can't be shown. */
export function paidAdCard(ad) {
  if (!ad || !ad.sponsor) return null;
  if (ad.kind === 'post') {
    const node = ad.post ? postCard(ad.post) : null;
    if (!node) return null;
    node.classList.add('paid-ad');
    node.prepend(h('div.post-context', sponsorLine(ad)));
    node.addEventListener('click', e => { if (e.target.closest('a')) trackClick(ad.campaign_id); });
    return node;
  }
  let body;
  let label;
  if (ad.kind === 'listing' && ad.listing) {
    label = ad.listing.title;
    body = [
      ad.listing.photo_url ? h('a.ad-listing-photo', { href: `/marketplace/${ad.listing.id}` },
        h('img', { src: ad.listing.photo_url, alt: '', loading: 'lazy', decoding: 'async' })) : null,
      h('h3.sponsored-brand', h('a', { href: `/marketplace/${ad.listing.id}`, style: 'color:inherit' }, ad.listing.title)),
      h('p', `${money(ad.listing.price)} on Marketplace`),
      h('a.btn-small', { href: `/marketplace/${ad.listing.id}` }, 'View listing'),
    ];
  } else if (ad.kind === 'page' && ad.page) {
    label = ad.page.user.name;
    body = [
      h('div.ad-page-head', avatar(ad.page.user), h('div', userName(ad.page.user))),
      ad.page.bio ? h('p', ad.page.bio) : null,
      h('a.btn-small', { href: `/@${ad.page.user.handle}` }, 'View page'),
    ];
  } else {
    return null;
  }
  const card = h('aside.south-card.sponsored-card.paid-ad', { 'aria-label': `Sponsored: ${label}` },
    h('div.sponsored-head', h('span.sponsored-label', 'Sponsored'), h('span.spacer'), sponsorLine(ad)),
    ...body);
  card.addEventListener('click', e => { if (e.target.closest('a')) trackClick(ad.campaign_id); });
  return card;
}
