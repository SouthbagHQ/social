// Profiles: /@:handle and /@:handle/:tab.
// Twitter header + Facebook friend button + Instagram photo grid + YouTube video grid + TikTok shorts grid
// + Facebook wall. Tabs: posts, replies, photos, videos, shorts, wall, likes; people: followers, following, friends.
//   GET /api/users/:handle → { user, viewer }
//   GET /api/users/:handle/posts?tab&cursor, /followers, /following, /friends

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { count, plural } from '../format.js';
import { navigate, refresh } from '../router.js';
import { login, store } from '../store.js';
import { confirm, copy, empty,infiniteList, menu, tabs, toast, toastError } from '../ui.js';
import { composerCard } from '../components/composer.js';
import { videoThumb } from '../components/media.js';
import { postCard, richText } from '../components/post.js';
import { avatar, followButton, userRow, verifiedBadge } from '../components/user.js';

const POST_TABS = [
  ['posts', 'Posts'], ['replies', 'Replies'], ['photos', 'Photos'], ['videos', 'Videos'],
  ['shorts', 'Shorts'], ['wall', 'Wall'], ['likes', 'Likes'],
];
const PEOPLE_TABS = [['followers', 'The Pile'], ['following', 'Following'], ['friends', 'Friends']];

const isKevin = user => user.handle.toLowerCase() === 'kevin';
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
    ctx.title('Profile not found');
    return h('div.south-card.flat',
      h('p.eyebrow', 'REF: SB-ERR-404'),
      h('h1', 'Kevin has closed this profile.'),
      h('p', `There is no customer called @${handle}. There may never have been. Kevin does not need to explain.`),
      h('p.mono', 'Fee — $12.00 — Policy curiosity'),
      h('a.btn', { href: '/explore' }, 'Find someone who exists'));
  }
  const { user, viewer } = data;
  // Keep the address bar on the canonical handle (e.g. /@me → /@alice).
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
    mount(body, empty({ icon: 'lock', title: `@${user.handle} has blocked you.`, text: 'Their posts are withheld. Kevin can still see both of you.' }));
  } else if (isPeopleTab) {
    mount(body, peopleList(ctx, user, viewer, tab));
  } else {
    mount(body, postsTab(ctx, user, viewer, tab));
  }
  return root;
}

// ── Header ────────────────────────────────────────────────────────────────

function header(user, viewer) {
  const banner = h('div.profile-banner', user.banner_url
    ? h('img', { src: user.banner_url, alt: '' })
    : h('img.watermark', { src: '/img/logo-400.png', alt: '' }));
  const pic = avatar(user, { size: 'xl', link: false, ring: viewer.has_story ? 'unseen' : null });
  const picture = viewer.has_story
    ? h('a.profile-avatar', { href: `/stories/${user.handle}`, title: 'View story', 'aria-label': `View @${user.handle}'s story` }, pic)
    : h('div.profile-avatar', pic);
  if (!viewer.has_story && user.avatar_url) {
    picture.style.cursor = 'zoom-in';
    picture.addEventListener('click', () => import('../ui.js').then(({ lightbox }) => lightbox(user.avatar_url, user.name)));
  }

  const followers = h('strong', count(user.follower_count));
  const kevin = isKevin(user) && !viewer.is_me;
  const chips = h('div.row.wrap.chips',
    viewer.follows_you || kevin ? h('span.chip', 'Follows you') : null,
    viewer.friendship === 'friends' ? h('span.chip.teal', 'Friends') : null,
    user.verified ? h('span.chip.red', 'Verified (purchased)') : null,
    kevin ? h('span.chip', 'Seen') : null);

  const meta = h('div.profile-meta',
    user.location ? h('span', icon('map-pin'), user.location) : null,
    user.website ? h('span', icon('link'), h('a', { href: user.website, target: '_blank', rel: 'noopener noreferrer nofollow' }, user.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))) : null,
    h('span', icon('calendar'), `Joined ${joined(user.created_at)}`));

  const counts = h('div.profile-counts',
    h('a', { href: `/@${user.handle}/followers` }, followers, ' in The Pile'),
    h('a', { href: `/@${user.handle}/following` }, h('strong', kevin ? 'Everyone' : count(user.following_count)), ' following'),
    h('a', { href: `/@${user.handle}/friends` }, h('strong', count(user.friend_count)), user.friend_count === 1 ? ' friend' : ' friends'),
    h('span', h('strong', count(user.post_count)), user.post_count === 1 ? ' post' : ' posts'));

  const setFollowers = n => { followers.textContent = count(n); };

  return h('section.south-card.flat.profile-card',
    banner,
    h('div.profile-top',
      picture,
      h('div.profile-actions', actions(user, viewer, setFollowers))),
    h('div.profile-id',
      h('h1', user.name, user.verified ? verifiedBadge() : null),
      h('div.handle', `@${user.handle}`),
      chips),
    user.bio ? h('p.profile-bio', richText(user.bio)) : null,
    kevin ? h('p.fine', 'Seen · your profile, 4 minutes before you opened it. Kevin has taken action before the event that caused it.') : null,
    meta,
    counts,
    viewer.blocked ? h('div.notice', { style: 'margin:12px 0 0' },
      `You have blocked @${user.handle}. They can still see you. Kevin can still see both of you. `,
      h('button.btn-small', { type: 'button', onclick: () => unblock(user) }, 'Unblock')) : null);
}

function actions(user, viewer, setFollowers) {
  if (viewer.is_me) {
    return [
      h('a.btn.outline', { href: '/settings' }, icon('edit'), 'Edit profile'),
      user.verified
        ? h('a.btn-small.flat', { href: '/verified' }, 'Manage verification')
        : h('a.btn', { href: '/verified' }, 'Get verified ($8.00/wk)'),
    ];
  }
  const more = h('button.icon-btn.boxed-icon', { type: 'button', 'aria-label': 'More options' }, icon('more'));
  more.addEventListener('click', () => menu(more, [
    { label: 'Copy link to profile', icon: 'link', onClick: () => copy(new URL(`/@${user.handle}`, location.origin).href) },
    { label: 'Report to Kevin', icon: 'flag', onClick: () => toast('Reported. Kevin has already seen it.') },
    'divider',
    viewer.blocked
      ? { label: `Unblock @${user.handle}`, icon: 'lock', onClick: () => unblock(user) }
      : { label: `Block @${user.handle}`, icon: 'lock', danger: true, onClick: () => block(user) },
  ]));
  if (viewer.blocked) return [more];

  let follow;
  if (isKevin(user)) {
    follow = h('button.btn', { type: 'button', disabled: true, title: 'Kevin follows everyone. The feeling is not required to be mutual.' }, 'Already following you');
  } else {
    follow = followButton({ ...user, is_following: viewer.is_following }, {
      small: false,
      onChange: following => { user.follower_count += following ? 1 : -1; setFollowers(user.follower_count); },
    });
  }
  return [
    follow,
    friendButton(user, viewer),
    h('a.btn.outline', { href: `/messages?to=${encodeURIComponent(user.handle)}` }, icon('message'), h('span.label', 'Message')),
    more,
  ];
}

/** Add friend / Request sent / Respond / Friends ▾ */
function friendButton(user, viewer) {
  let state = viewer.friendship;
  const btn = h('button.btn.outline', { type: 'button' });
  const paint = () => {
    const labels = { none: ['user-plus', 'Add friend'], requested: ['check', 'Request sent'], incoming: ['user-plus', 'Respond'], friends: ['users', 'Friends ▾'] };
    const [ic, label] = labels[state] || labels.none;
    mount(btn, icon(ic), label);
    btn.classList.toggle('outline', state !== 'incoming');
  };
  const send = async (method, success) => {
    btn.disabled = true;
    try {
      const res = method === 'put' ? await api.put(`users/${user.handle}/friend`) : await api.del(`users/${user.handle}/friend`);
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
    if (state === 'none') return send('put', 'Friend request sent. Friendship is subject to review.');
    if (state === 'requested') return menu(btn, [
      { label: 'Cancel request', icon: 'close', onClick: () => send('del', 'Request withdrawn. It has been retained.') },
    ]);
    if (state === 'incoming') return menu(btn, [
      { label: 'Confirm request', icon: 'check', onClick: () => send('put', 'You are now friends. This has been recorded.') },
      { label: 'Delete request', icon: 'trash', onClick: () => send('del', 'Request declined. They have not been told. They will work it out.') },
    ]);
    menu(btn, [
      { label: 'Unfriend', icon: 'close', danger: true, onClick: async () => {
        if (await confirm(`Unfriend ${user.name}? Your shared history is retained permanently.`, { ok: 'Unfriend' }))
          send('del', 'Unfriended. The friendship has been archived, not deleted.');
      } },
    ]);
  });
  paint();
  return btn;
}

async function block(user) {
  if (!(await confirm(`Block @${user.handle}? They will be removed from The Pile and from your friends. They can still see you. Kevin can still see both of you.`, { ok: 'Block' }))) return;
  try {
    await api.put(`users/${user.handle}/block`);
    toast('Blocked. They can still see you. Kevin can still see both of you.');
    store.refresh();
    refresh();
  } catch (err) { toastError(err); }
}

async function unblock(user) {
  try {
    await api.del(`users/${user.handle}/block`);
    toast(`@${user.handle} is unblocked. The Pile has not forgotten.`);
    refresh();
  } catch (err) { toastError(err); }
}

// ── Tabs ──────────────────────────────────────────────────────────────────

function emptyFor(tab, user, viewer) {
  const me = viewer.is_me;
  const who = me ? 'You have' : `@${user.handle} has`;
  const map = {
    posts: me
      ? { icon: 'edit', title: 'Nothing posted yet.', text: 'Your silence has been noted.' }
      : { icon: 'edit', title: `@${user.handle} has not posted.`, text: isKevin(user) ? 'Kevin does not post. Kevin is posted about.' : 'Their silence has been noted.' },
    replies: { icon: 'comment', title: `${who} not replied to anything.`, text: 'No comments. The silence is compliant.' },
    photos: { icon: 'camera', title: 'No photos.', text: me ? 'We already have your face. You may still upload others.' : 'Southbag has photos of them anyway.' },
    videos: { icon: 'video', title: 'No videos.', text: 'Uploads are retained permanently. None have been made.' },
    shorts: { icon: 'shorts', title: 'No shorts.', text: 'Vertical content is pending.' },
    wall: { icon: 'edit', title: 'The wall is empty.', text: 'A blank wall is compliant. It will not stay that way.' },
    likes: { icon: 'heart', title: `${who} not liked anything.`, text: 'Appreciation is optional. The surcharge is not.' },
  };
  return empty(map[tab]);
}

function postsTab(ctx, user, viewer, tab) {
  const load = cursor => api.get(`users/${user.handle}/posts`, { tab, cursor }, { signal: ctx.signal });
  const emptyNode = emptyFor(tab, user, viewer);

  if (tab === 'photos') {
    return infiniteList({
      load, signal: ctx.signal, empty: emptyNode, className: 'profile-grid',
      render: post => {
        const first = post.media.find(m => m.kind === 'image');
        if (!first) return null;
        return h('a.grid-tile', { href: `/post/${post.id}`, title: post.body || 'Photo', 'aria-label': post.body || 'Photo' },
          h('img', { src: first.url, alt: first.alt || '', loading: 'lazy' }),
          post.media.length > 1 ? h('span.multi', icon('grid')) : null,
          h('span.hover', icon('heart'), count(post.counts.reactions), icon('comment'), count(post.counts.replies)));
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
          h('a.title', { href: `/watch/${post.id}` }, post.title || 'Untitled video (Kevin approved)'),
          h('div.fine', `${plural(post.counts.views, 'view')} · ${relativeDate(post.created_at)}`));
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
        thumb.append(h('span.views', icon('play'), count(post.counts.views)));
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
      placeholder: viewer.is_me ? 'Write on your own wall. Kevin reads walls.' : `Write something on ${user.name}'s wall. It will be retained.`,
      onPosted: post => list.prepend(postCard(post)),
    });
  } else if (tab === 'wall' && store.me) {
    top = h('div.notice', `Only friends can write on ${user.name}'s wall. Friendship is subject to review.`);
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
    followers: me
      ? { icon: 'users', title: 'Nobody has added you to The Pile.', text: 'Kevin is aware.' }
      : { icon: 'users', title: `Nobody has added @${user.handle} to The Pile.`, text: 'Kevin is aware.' },
    following: me
      ? { icon: 'user-plus', title: 'You are not following anyone.', text: 'Kevin follows you. That will have to do.' }
      : { icon: 'user-plus', title: `@${user.handle} is not following anyone.`, text: 'Kevin follows them. That will have to do.' },
    friends: { icon: 'users', title: 'No friends yet.', text: 'Friendship is subject to review.' },
  };
  const headings = {
    followers: me ? 'People who added you to The Pile' : `People who added @${user.handle} to The Pile`,
    following: me ? 'People in your Pile' : `People in @${user.handle}'s Pile`,
    friends: me ? 'Your friends' : `${user.name}'s friends`,
  };
  return h('div.south-card.flat',
    h('h2', headings[tab]),
    tab === 'friends' && me ? h('p.fine', h('a', { href: '/friends' }, 'Manage friends and requests')) : null,
    infiniteList({
      className: 'people-list',
      signal: ctx.signal,
      load: cursor => api.get(`users/${user.handle}/${tab}`, { cursor }, { signal: ctx.signal }),
      render: person => userRow(person),
      empty: empty(empties[tab]),
    }));
}
