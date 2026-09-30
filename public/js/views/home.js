// The home feed (/). Signed-in only: app.js shows the landing page to signed-out visitors.
//   stories bar -> composer -> Following / For you tabs -> infinite list of posts (+ the odd sponsored card)
//   GET /api/feed?tab=following|foryou&cursor -> { items, next, tab, fallback? }

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { empty, infiniteList, tabs } from '../ui.js';
import { composerCard } from '../components/composer.js';
import { postCard } from '../components/post.js';
import { storiesBar } from '../components/stories-bar.js';
import { childController, pref, withSponsored } from './feed-kit.js';

const TAB_KEY = 'sb_feed_tab';

export default async function home(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Feed');

  let tab = pref.get(TAB_KEY, 'following') === 'foryou' ? 'foryou' : 'following';
  let controller = null;
  let list = null;

  const tabBar = h('div');
  const notice = h('div');
  const listHost = h('div');

  const paintTabs = () => mount(tabBar, tabs([
    { label: 'Following', selected: tab === 'following', onClick: () => select('following') },
    { label: 'For you', selected: tab === 'foryou', onClick: () => select('foryou') },
  ]));

  function load() {
    controller?.abort();
    controller = childController(ctx.signal);
    const signal = controller.signal;
    mount(notice);
    list = infiniteList({
      signal,
      load: cursor => api.get('feed', { tab, cursor }, { signal }),
      render: withSponsored(post => postCard(post)),
      onPage: (items, data) => {
        if (data.fallback && !notice.firstChild) {
          mount(notice, h('div.notice.feed-notice',
            h('strong', 'You are not following anyone yet.'), ' Showing popular posts instead. ',
            h('a', { href: '/explore' }, 'Find people to follow')));
        }
      },
      empty: empty({
        title: 'No posts yet.',
        text: tab === 'following' ? 'Posts from people you follow appear here.' : null,
        action: h('a.btn-small', { href: '/explore' }, 'Explore'),
      }),
    });
    mount(listHost, list);
  }

  function select(next) {
    if (next === tab) return;
    tab = next;
    pref.set(TAB_KEY, tab);
    paintTabs();
    load();
  }

  paintTabs();
  load();

  const stories = storiesBar?.(ctx);
  return h('div.feed-page',
    stories || null,
    composerCard({
      onPosted: post => {
        const card = postCard(post);
        if (card) list?.prepend(card);
      },
    }),
    tabBar,
    notice,
    listHost);
}
