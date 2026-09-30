// /groups - "Your groups" and "Discover".  GET /api/groups?tab=mine|discover&q&cursor

import { api } from '../api.js';
import { h } from '../dom.js';
import { plural } from '../format.js';
import { navigate } from '../router.js';
import { empty, infiniteList, tabs } from '../ui.js';

const roleLabels = { owner: 'Owner', admin: 'Admin', member: 'Member', pending: 'Requested' };

/** A group as an inset tile: banner, picture, name, privacy and members. */
export function groupTile(g) {
  return h('a.south-item.group-tile', { href: `/g/${g.slug}` },
    groupBanner(g, 'div.group-tile-banner'),
    groupAvatar(g),
    h('div.group-tile-body',
      h('strong', g.name),
      h('div.group-tile-meta', `${g.privacy === 'private' ? 'Private' : 'Public'} group, ${plural(g.member_count, 'member')}`),
      g.description ? h('p.group-tile-desc', g.description) : null,
      g.role ? h('span.chip', roleLabels[g.role]) : null));
}

/** A fixed-height box; the banner image is stretched to fill it. Plain grey without one. */
export function groupBanner(g, tag = 'div.group-banner') {
  return h(tag, g.banner_url ? h('img', { src: g.banner_url, alt: '', loading: 'lazy' }) : null);
}

/** A square box; the group picture is stretched to fill it. */
export function groupAvatar(g, size = '') {
  return h('span.group-avatar', { class: { [size]: Boolean(size) } },
    g.avatar_url ? h('img', { src: g.avatar_url, alt: '' }) : h('span.initial', (g.name || 'g').trim().charAt(0).toLowerCase()));
}

export default function groupsView(ctx) {
  ctx.title('Groups');
  const signedIn = Boolean(ctx.me);
  const tab = signedIn && ctx.query.get('tab') !== 'discover' ? 'mine' : 'discover';
  const q = ctx.query.get('q') || '';

  const search = h('input.input', { type: 'search', name: 'q', value: q, placeholder: 'Search groups', 'aria-label': 'Search groups' });
  const list = infiniteList({
    className: 'group-grid',
    signal: ctx.signal,
    load: cursor => api.get('groups', { tab, q: tab === 'discover' ? q : '', cursor }, { signal: ctx.signal }),
    render: groupTile,
    empty: tab === 'mine'
      ? empty({ title: 'No groups yet.', action: h('a.btn-small', { href: '/groups?tab=discover' }, 'Discover') })
      : empty({ title: q ? 'No results.' : 'No groups yet.',
          action: signedIn && !q ? h('a.btn-small', { href: '/groups/new' }, 'Create group') : null }),
  });

  return h('div.groups-page',
    h('div.page-head',
      h('h1', 'Groups'),
      h('span.spacer'),
      signedIn ? h('a.btn', { href: '/groups/new' }, 'Create group') : null),
    signedIn ? tabs([
      { href: '/groups', label: 'Your groups', current: tab === 'mine' },
      { href: '/groups?tab=discover', label: 'Discover', current: tab === 'discover' },
    ]) : null,
    tab === 'discover' ? h('form.group-search.row', { role: 'search', onsubmit: e => {
      e.preventDefault();
      navigate(`/groups?tab=discover${search.value.trim() ? `&q=${encodeURIComponent(search.value.trim())}` : ''}`, { scroll: false });
    } }, search, h('button.btn', { type: 'submit' }, 'Search')) : null,
    list);
}
