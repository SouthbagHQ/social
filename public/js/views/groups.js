// /groups — "Your groups" and "Discover" (Facebook).  GET /api/groups?tab=mine|discover&q&cursor

import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { plural } from '../format.js';
import { navigate } from '../router.js';
import { empty, infiniteList, tabs } from '../ui.js';

const roleLabels = { owner: 'Owner', admin: 'Admin', member: 'Member', pending: 'Requested' };

/** A group as an inset tile: banner, avatar, name, privacy and members. Shared with group.js. */
export function groupTile(g) {
  return h('a.south-item.group-tile', { href: `/g/${g.slug}` },
    h('div.group-tile-banner', { style: g.banner_url ? { backgroundImage: `url("${g.banner_url}")` } : null }),
    groupAvatar(g),
    h('div.group-tile-body',
      h('strong', g.name),
      h('div.group-tile-meta', icon(g.privacy === 'private' ? 'lock' : 'globe'),
        `${g.privacy === 'private' ? 'Private' : 'Public'} · ${plural(g.member_count, 'member')}`),
      g.description ? h('p.group-tile-desc', g.description) : null,
      g.role ? h('span.chip', { class: { teal: g.role !== 'pending', red: g.role === 'pending' } }, roleLabels[g.role]) : null));
}

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
      ? empty({ icon: 'users', title: 'You are not in any groups.', text: 'Kevin is a member of every group. You could join one of His.',
          action: h('a.btn-small', { href: '/groups?tab=discover' }, 'Discover groups') })
      : empty({ icon: 'users', title: q ? 'No groups match that.' : 'No groups to discover.',
          text: q ? 'The ones you wanted are on Floor 3.' : 'Kevin is a member of every group. There is no room left.',
          action: signedIn ? h('a.btn-small', { href: '/groups/new' }, 'Create group') : null }),
  });

  return h('div.groups-page',
    h('div.page-head',
      h('h1', 'Groups'),
      h('span.spacer'),
      signedIn ? h('a.btn', { href: '/groups/new' }, icon('plus'), 'Create group') : null),
    h('p.muted', { style: 'margin:-4px 0 12px' }, 'Gather with people who share your interests. Kevin is a member of every group.'),
    signedIn ? tabs([
      { href: '/groups', label: 'Your groups', current: tab === 'mine' },
      { href: '/groups?tab=discover', label: 'Discover', current: tab === 'discover' },
    ]) : null,
    tab === 'discover' ? h('form.group-search', { role: 'search', onsubmit: e => {
      e.preventDefault();
      navigate(`/groups?tab=discover${search.value.trim() ? `&q=${encodeURIComponent(search.value.trim())}` : ''}`, { scroll: false });
    } }, icon('search'), search) : null,
    list);
}
