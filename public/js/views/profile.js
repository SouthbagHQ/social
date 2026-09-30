// Profiles: /@:handle and /@:handle/:tab.
// Header (banner, photo, name, counts, actions), then tabs: posts, replies, photos, videos, shorts,
// wall, likes; and the people tabs: followers, following, friends.
//   GET /api/users/:handle -> { user, viewer }
//   GET /api/users/:handle/posts?tab&cursor, /followers, /following, /friends

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { count, plural } from '../format.js';
import { navigate, refresh } from '../router.js';
import { login, store } from '../store.js';
import { confirm, copy, empty, infiniteList, lightbox, menu, tabs, toast, toastError } from '../ui.js';
import { composerCard } from '../components/composer.js';
import { videoThumb } from '../components/media.js';
import { postCard, richText } from '../components/post.js';
import { avatar, followButton, userRow, verifiedBadge } from '../components/user.js';

const POST_TABS = [
  ['posts', 'Posts'], ['replies', 'Replies'], ['photos', 'Photos'], ['videos', 'Videos'],
  ['shorts', 'Shorts'], ['wall', 'Wall'], ['likes', 'Likes'],
];
const PEOPLE_TABS = [['followers', 'Followers'], ['following', 'Following'], ['friends', 'Friends']];

const joined = ms => new Date(ms).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

export default async function profile(ctx) {
  const handle = ctx.params.handle;
  const tab = ctx.params.tab || 'posts';
  if (![...POST_TABS, ...PEOPLE_TABS].some(([key]) => key === tab)) {
    navigate(`/@${handle}`, { replace: true });
    return null;
  }

  let data;
  try {
    data = await api.get(`users/${encodeURIComponent(handle)}`, null, { signal: ctx.signal });
  } catch (err) {
    if (err.status !== 404) throw err;
    ctx.title('User not found');
    return h('div.south-card.flat',
      h('h1', 'User not found.'),
      h('p', `There is no account called @${handle}.`),
      h('a.btn', { href: '/explore' }, 'Explore'));
  }
  const { user, viewer } = data;
  // Keep the address bar on the canonical handle (e.g. /@me becomes /@alice).
  if (user.handle !== handle) history.replaceState({}, '', `/@${user.handle}${tab === 'posts' ? '' : `/${tab}`}`);
  ctx.title(`${user.name} (@${user.handle})`);

  const base = `/@${user.handle}`;
  const isPeopleTab = PEOPLE_TABS.some(([key]) => key === tab);
  const body = h('div.profile-body');
  const root = h('div.profile',
    header(user, viewer),
    tabs(POST_TABS.map(([key, label]) => ({ href: key === 'posts' ? base : `${base}/${key}`, label, current: key === tab }))),
    isPeopleTab ? tabs(PEOPLE_TABS.map(([key, label]) => ({ href: `${base}/${key}`, label, current: key === tab }))) : null,
    body);

  if (viewer.blocked_by) {
    mount(body, empty({ title: 'Posts unavailable.', text: `@${user.handle} has blocked you.` }));
  } else if (isPeopleTab) {
    mount(body, peopleList(ctx, user, viewer, tab));
  } else {
    mount(body, postsTab(ctx, user, viewer, tab));
  }
  return root;
}

// -- Header ----------------------------------------------------------------

function header(user, viewer) {
  // A fixed-height box. An uploaded banner is stretched to fill it; without one it is plain grey.
  const banner = h('div.profile-banner', { class: { empty: !user.banner_url } },
    user.banner_url ? h('img', { src: user.banner_url, alt: '' }) : null);
  const pic = avatar(user, { size: 'xl', link: false, ring: viewer.has_story ? 'unseen' : null });
  let picture;
  if (viewer.has_story) {
    picture = h('a.profile-avatar', { href: `/stories/${user.handle}`, 'aria-label': `View story from @${user.handle}` }, pic);
  } else if (user.avatar_url) {
    picture = h('a.profile-avatar', {
      href: user.avatar_url, 'aria-label': 'View profile photo',
      onclick: e => { e.preventDefault(); lightbox(user.avatar_url, user.name); },
    }, pic);
  } else {
    picture = h('div.profile-avatar', pic);
  }

  const followers = h('strong', count(user.follower_count));
  const friends = h('strong', count(user.friend_count));
  const chips = h('div.row.wrap.chips',
    viewer.follows_you ? h('span.chip', 'Follows you') : null,
    viewer.friendship === 'friends' ? h('span.chip', 'Friends') : null);

  const meta = h('div.profile-meta',
    user.location ? h('span', user.location) : null,
    user.website ? h('span', h('a', { href: user.website, target: '_blank', rel: 'noopener noreferrer nofollow' }, user.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))) : null,
    h('span', `Joined ${joined(user.created_at)}`));

  const counts = h('div.profile-counts',
    h('a', { href: `/@${user.handle}/followers` }, followers, user.follower_count === 1 ? ' Follower' : ' Followers'),
    h('a', { href: `/@${user.handle}/following` }, h('strong', count(user.following_count)), ' Following'),
    h('a', { href: `/@${user.handle}/friends` }, friends, user.friend_count === 1 ? ' Friend' : ' Friends'),
    h('span', h('strong', count(user.post_count)), user.post_count === 1 ? ' Post' : ' Posts'));

  const setFollowers = n => {
    followers.textContent = count(n);
    followers.nextSibling.textContent = n === 1 ? ' Follower' : ' Followers';
  };
  const setFriends = n => {
    friends.textContent = count(n);
    friends.nextSibling.textContent = n === 1 ? ' Friend' : ' Friends';
  };

  return h('section.south-card.flat.profile-card',
    banner,
    h('div.profile-top',
      picture,
      h('div.profile-actions', actions(user, viewer, setFollowers, setFriends))),
    h('div.profile-id',
      h('h1', user.name),
      h('div.handle', `@${user.handle}`, user.verified ? [' ', verifiedBadge()] : null),
      chips),
    user.bio ? h('p.profile-bio', richText(user.bio)) : null,
    meta,
    counts,
    viewer.blocked ? h('div.notice.profile-notice',
      `You have blocked @${user.handle}. `,
      h('button.btn-small', { type: 'button', onclick: () => unblock(user) }, 'Unblock')) : null);
}

function actions(user, viewer, setFollowers, setFriends) {
  if (viewer.is_me) {
    return [
      h('a.btn', { href: '/settings' }, 'Edit profile'),
      h('a.btn', { href: '/verified' }, user.verified ? 'Southbag Verified' : 'Get verified'),
    ];
  }
  const more = h('button.btn', { type: 'button', 'aria-haspopup': 'menu' }, 'More');
  more.addEventListener('click', () => menu(more, [
    { label: 'Copy link', onClick: () => copy(new URL(`/@${user.handle}`, location.origin).href) },
    'divider',
    viewer.blocked
      ? { label: `Unblock @${user.handle}`, onClick: () => unblock(user) }
      : { label: `Block @${user.handle}`, onClick: () => block(user) },
  ]));
  if (viewer.blocked) return [more];

  const follow = followButton({ ...user, is_following: viewer.is_following }, {
    small: false,
    onChange: following => { user.follower_count += following ? 1 : -1; setFollowers(user.follower_count); },
  });
  return [
    follow,
    friendButton(user, viewer, setFriends),
    h('a.btn', { href: `/messages?to=${encodeURIComponent(user.handle)}` }, 'Message'),
    more,
  ];
}

/** Add friend / Requested / Respond / Friends */
function friendButton(user, viewer, setFriends) {
  let state = viewer.friendship;
  const btn = h('button.btn', { type: 'button' });
  const paint = () => {
    const labels = { none: 'Add friend', requested: 'Requested', incoming: 'Respond', friends: 'Friends' };
    btn.textContent = labels[state] || labels.none;
    btn.setAttribute('aria-haspopup', state === 'none' ? 'false' : 'menu');
  };
  const send = async (method, success) => {
    btn.disabled = true;
    try {
      const res = method === 'put' ? await api.put(`users/${user.handle}/friend`) : await api.del(`users/${user.handle}/friend`);
      if ((state === 'friends') !== (res.friendship === 'friends')) {
        user.friend_count = Math.max(0, user.friend_count + (res.friendship === 'friends' ? 1 : -1));
        setFriends(user.friend_count);
      }
      state = res.friendship;
      viewer.friendship = state;
      paint();
      toast(success);
      if ((method === 'put' && state === 'friends') || method === 'del') store.refresh();
    } catch (err) { toastError(err); }
    btn.disabled = false;
  };
  btn.addEventListener('click', () => {
    if (!store.me) return login();
    if (state === 'none') return send('put', 'Friend request sent.');
    if (state === 'requested') return menu(btn, [
      { label: 'Cancel request', onClick: () => send('del', 'Request cancelled.') },
    ]);
    if (state === 'incoming') return menu(btn, [
      { label: 'Accept', onClick: () => send('put', `You and @${user.handle} are now friends.`) },
      { label: 'Decline', onClick: () => send('del', 'Request declined.') },
    ]);
    menu(btn, [
      { label: 'Unfriend', onClick: async () => {
        if (await confirm(`Remove ${user.name} from your friends?`, { title: 'Unfriend', ok: 'Unfriend' }))
          send('del', 'Unfriended.');
      } },
    ]);
  });
  paint();
  return btn;
}

async function block(user) {
  if (!(await confirm(`@${user.handle} will be removed from your followers, following and friends, and won't be able to follow you or send you friend requests.`, { title: `Block @${user.handle}?`, ok: 'Block' }))) return;
  try {
    await api.put(`users/${user.handle}/block`);
    toast(`Blocked @${user.handle}.`);
    store.refresh();
    refresh();
  } catch (err) { toastError(err); }
}

async function unblock(user) {
  try {
    await api.del(`users/${user.handle}/block`);
    toast(`Unblocked @${user.handle}.`);
    refresh();
  } catch (err) { toastError(err); }
}

// -- Tabs ------------------------------------------------------------------

const EMPTY = {
  posts: 'No posts yet.',
  replies: 'No replies yet.',
  photos: 'No photos yet.',
  videos: 'No videos yet.',
  shorts: 'No shorts yet.',
  wall: 'Nothing on this wall yet.',
  likes: 'No likes yet.',
};

function postsTab(ctx, user, viewer, tab) {
  const load = cursor => api.get(`users/${user.handle}/posts`, { tab, cursor }, { signal: ctx.signal });
  const emptyNode = empty({ title: EMPTY[tab] });

  if (tab === 'photos') {
    return infiniteList({
      load, signal: ctx.signal, empty: emptyNode, className: 'profile-grid',
      render: post => {
        const first = post.media.find(m => m.kind === 'image');
        if (!first) return null;
        const label = post.body || 'Photo';
        return h('a.grid-tile', { href: `/post/${post.id}`, title: label, 'aria-label': label },
          h('img', { src: first.url, alt: first.alt || '', loading: 'lazy' }),
          post.media.length > 1 ? h('span.multi', `${post.media.length} photos`) : null,
          h('span.hover', `${plural(post.counts.reactions, 'like')}, ${plural(post.counts.replies, 'comment')}`));
      },
    });
  }
  if (tab === 'videos') {
    return infiniteList({
      load, signal: ctx.signal, empty: emptyNode, className: 'profile-videos',
      render: post => {
        const video = post.media.find(m => m.kind === 'video');
        if (!video) return null;
        return h('div.video-tile',
          videoThumb(video, { href: `/watch/${post.id}` }),
          h('a.title', { href: `/watch/${post.id}` }, post.title || 'Untitled video'),
          h('div.fine', `${plural(post.counts.views, 'view')}, ${relativeDate(post.created_at)}`));
      },
    });
  }
  if (tab === 'shorts') {
    return infiniteList({
      load, signal: ctx.signal, empty: emptyNode, className: 'profile-shorts',
      render: post => {
        const video = post.media.find(m => m.kind === 'video');
        if (!video) return null;
        const thumb = videoThumb(video, { href: `/shorts/${post.id}`, vertical: true });
        thumb.append(h('span.views', plural(post.counts.views, 'view')));
        return thumb;
      },
    });
  }

  const list = infiniteList({ load, signal: ctx.signal, empty: emptyNode, render: post => postCard(post) });
  let top = null;
  if (tab === 'posts' && viewer.is_me) {
    top = composerCard({ onPosted: post => list.prepend(postCard(post)) });
  } else if (tab === 'wall' && (viewer.is_me || viewer.friendship === 'friends')) {
    top = composerCard({
      wallUserId: user.id,
      placeholder: viewer.is_me ? 'Write on your wall' : `Write on ${user.name}'s wall`,
      onPosted: post => list.prepend(postCard(post)),
    });
  } else if (tab === 'wall' && store.me) {
    top = h('div.notice', `Only friends of ${user.name} can write on this wall.`);
  }
  return h('div', top, list);
}

function relativeDate(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 1) return 'today';
  if (days < 7) return plural(days, 'day') + ' ago';
  if (days < 60) return plural(Math.floor(days / 7), 'week') + ' ago';
  return new Date(ms).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function peopleList(ctx, user, viewer, tab) {
  const me = viewer.is_me;
  const empties = {
    followers: 'No followers yet.',
    following: me ? 'You are not following anyone.' : `@${user.handle} is not following anyone.`,
    friends: 'No friends yet.',
  };
  const headings = { followers: 'Followers', following: 'Following', friends: 'Friends' };
  return h('div.south-card.flat',
    h('h2', headings[tab]),
    tab === 'friends' && me ? h('p.fine', h('a', { href: '/friends' }, 'Friend requests')) : null,
    infiniteList({
      className: 'people-list',
      signal: ctx.signal,
      load: cursor => api.get(`users/${user.handle}/${tab}`, { cursor }, { signal: ctx.signal }),
      render: person => userRow(person),
      empty: empty({ title: empties[tab] }),
    }));
}
