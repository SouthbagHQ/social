// Thread page (/post/:id). Works for every kind of post, including videos and shorts.
//   ancestors (compact, joined by a thread line) -> the focused post, large, with its full date,
//   reaction breakdown and counts -> reply composer (focused when the URL hash is #reply) ->
//   replies (Top / New) with "View N replies" links to go deeper.
//   GET /api/posts/:id -> { post, ancestors }      GET /api/posts/:id/replies?sort=top|new&cursor

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { count, fullDate, plural } from '../format.js';
import { store } from '../store.js';
import { dialog, empty, errorBox, infiniteList, loading, tabs } from '../ui.js';
import { composer } from '../components/composer.js';
import { postMedia } from '../components/media.js';
import { REACTIONS, postCard } from '../components/post.js';
import { userRow } from '../components/user.js';
import { childController, pageHead, pref } from './feed-kit.js';

const SORT_KEY = 'sb_replies_sort';

function notFound(ctx) {
  ctx.title('Post not found');
  return h('div.south-card.flat.thread-missing',
    h('h1', 'Post not found.'),
    h('p', 'It may have been deleted or made private.'),
    h('a.btn', { href: '/' }, 'Back to feed'));
}

/** Records one view per post per browser session. Videos count when they start playing instead. */
function countView(post) {
  const key = `sb_viewed_${post.id}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch { return; }
  api.post(`posts/${post.id}/view`).then(({ views }) => {
    post.counts.views = views;
    document.querySelectorAll(`[data-views-for="${post.id}"]`).forEach(el => { el.textContent = count(views); });
  }).catch(() => {});
}

/** Who reacted, in a dialog. */
async function showReactions(post, type) {
  const body = h('div.reactions-dialog', loading());
  dialog({ title: type ? REACTIONS[type]?.label || 'Reactions' : 'Reactions', body, wide: false });
  try {
    const { items } = await api.get(`posts/${post.id}/reactions`, { type });
    mount(body, items.length
      ? items.map(({ user, type: t }) => userRow(user, { bio: false, action: h('span.reaction-word', REACTIONS[t]?.label || t) }))
      : h('p.muted', 'No reactions yet.'));
  } catch (err) { mount(body, errorBox(err)); }
}

/** The big version of a post: postCard plus the details a thread page shows. */
function focusedPost(post, { onReply }) {
  const card = postCard(post, { link: false, onReply });
  if (!card) return h('div');
  card.classList.add('focused-post');
  if (post.deleted) return card;

  // Play videos here rather than linking away to the watch page.
  if (post.kind === 'video' || post.kind === 'short') {
    const mediaHost = card.querySelector('.post-media');
    const player = postMedia(post, { inFeed: false });
    if (mediaHost && player) {
      mount(mediaHost, player);
      const video = mediaHost.querySelector('video');
      video?.addEventListener('play', () => countView(post), { once: true });
      if (post.kind === 'short') mediaHost.classList.add('short-media');
    }
  }

  const audience = post.visibility === 'followers' ? 'Followers' : post.visibility === 'friends' ? 'Friends' : 'Everyone';
  const details = h('div.post-details',
    h('div.when',
      h('time', { datetime: new Date(post.created_at).toISOString() }, fullDate(post.created_at)),
      post.edited_at ? h('span', `Edited ${fullDate(post.edited_at)}`) : null,
      h('span', `Visible to: ${audience}`)),
    h('div.stats',
      h('span', h('strong', { dataset: { viewsFor: post.id } }, count(post.counts.views)), ` ${post.counts.views === 1 ? 'view' : 'views'}`),
      h('span', h('strong', count(post.counts.reposts)), ` ${post.counts.reposts === 1 ? 'repost' : 'reposts'}`),
      h('span', h('strong', count(post.counts.replies)), ` ${post.counts.replies === 1 ? 'reply' : 'replies'}`),
      h('span', h('strong', count(post.counts.reactions)), ` ${post.counts.reactions === 1 ? 'reaction' : 'reactions'}`)),
    post.reactions.length ? h('div.reaction-breakdown', { 'aria-label': 'Reactions by type' },
      h('button.btn-small', { type: 'button', onclick: () => showReactions(post) }, 'All reactions'),
      post.reactions.map(([type, n]) => h('button.btn-small', {
        type: 'button', 'aria-label': `See who reacted with ${REACTIONS[type]?.label || type}`, onclick: () => showReactions(post, type),
      }, `${REACTIONS[type]?.label || type} ${count(n)}`))) : null,
    post.kind === 'video' || post.kind === 'short'
      ? h('p.fine', h('a', { href: post.kind === 'short' ? `/shorts/${post.id}` : `/watch/${post.id}` }, post.kind === 'short' ? 'Open in Shorts' : 'Open in Videos'))
      : null);

  // Put the details between the body/media and the action bar.
  const actions = card.querySelector('.post-actions');
  card.insertBefore(details, actions);
  return card;
}

export default async function thread(ctx) {
  const id = ctx.params.id;
  let data;
  try {
    data = await api.get(`posts/${encodeURIComponent(id)}`, null, { signal: ctx.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (err.status === 404 || err.status === 403) return notFound(ctx);
    throw err;
  }
  const { post, ancestors = [] } = data;
  const name = post.author?.name || 'Someone';
  ctx.title(post.deleted ? 'Deleted post' : `${name}: ${(post.title || post.body || 'Post').slice(0, 50)}`);
  if (!post.deleted && post.kind !== 'video' && post.kind !== 'short') countView(post);

  // -- Ancestors --
  const earliest = ancestors[0];
  const context = ancestors.length ? h('div.thread-ancestors',
    earliest?.reply_to ? h('a.thread-more', { href: `/post/${post.root_id || earliest.reply_to.id}` }, 'Show earlier posts') : null,
    ancestors.map(a => h('div.thread-ancestor', postCard(a, { compact: true, card: false })))) : null;

  // -- Reply composer --
  let replyForm = null;
  let list = null;
  const replyCount = h('span');
  const paintCount = () => { replyCount.textContent = post.counts.replies ? ` (${count(post.counts.replies)})` : ''; };
  paintCount();
  const focusComposer = () => {
    if (!replyForm) return;
    replyForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    replyForm.focus();
  };
  const replyBox = post.deleted
    ? h('p.muted.thread-closed', 'Replies are closed.')
    : store.me
      ? h('div.south-card.flat.reply-box', { id: 'reply' },
          replyForm = composer({
            replyTo: post,
            compact: false,
            placeholder: `Reply to @${post.author.handle}`,
            onPosted: reply => {
              post.counts.replies++;
              paintCount();
              const node = replyNode(reply);
              if (node) list?.prepend(node);
            },
          }))
      : replyForm = composer({ replyTo: post });

  // -- Replies --
  let sort = pref.get(SORT_KEY, 'top') === 'new' ? 'new' : 'top';
  let controller = null;
  const sortBar = h('div');
  const listHost = h('div');
  const paintSort = () => mount(sortBar, tabs([
    { label: 'Top', selected: sort === 'top', onClick: () => setSort('top') },
    { label: 'New', selected: sort === 'new', onClick: () => setSort('new') },
  ]));

  function replyNode(reply) {
    const card = postCard(reply, { compact: true });
    if (!card) return null;
    const more = reply.counts.replies
      ? h('a.view-replies', { href: `/post/${reply.id}` }, `View ${plural(reply.counts.replies, 'reply', 'replies')}`)
      : null;
    return h('div.reply-item', card, more);
  }

  function loadReplies() {
    controller?.abort();
    controller = childController(ctx.signal);
    const signal = controller.signal;
    list = infiniteList({
      signal,
      className: 'thread-replies',
      load: cursor => api.get(`posts/${post.id}/replies`, { sort, cursor }, { signal }),
      render: replyNode,
      empty: empty({ title: 'No replies yet.' }),
    });
    mount(listHost, list);
  }
  function setSort(next) {
    if (next === sort) return;
    sort = next;
    pref.set(SORT_KEY, sort);
    paintSort();
    loadReplies();
  }
  paintSort();
  loadReplies();

  const page = h('div.thread-page',
    pageHead(post.kind === 'video' ? 'Video' : post.kind === 'short' ? 'Short' : post.reply_to ? 'Reply' : 'Post', { back: true }),
    context,
    focusedPost(post, { onReply: focusComposer }),
    replyBox,
    h('div.replies-head', h('h2', 'Replies', replyCount), sortBar),
    listHost);

  if (location.hash === '#reply') {
    // Wait until the page is mounted, then jump to the composer.
    requestAnimationFrame(() => setTimeout(focusComposer, 60));
  } else if (ancestors.length) {
    // Keep the focused post in view rather than the top of the ancestors.
    requestAnimationFrame(() => setTimeout(() => page.querySelector('.focused-post')?.scrollIntoView({ block: 'start' }), 60));
  }
  return page;
}
