// The post card: every surface renders posts with this (feed, profiles, groups, search, threads).
//
//   postCard(post, { compact, onDeleted, onReply, link = true })
//
// Handles reposts ("x reposted"), quotes, reactions (click = like, hover/long-press = picker),
// comments, reposting/quoting, sharing, saving, editing, deleting, polls (components/poll.js) and
// pinning to your profile. Plain text only: no icons.

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { count, fullDate, timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, menu, share, shake, toast, toastError } from '../ui.js';
import { postMedia } from './media.js';
import { pollSummary, pollView } from './poll.js';
import { avatar, userName } from './user.js';

// Reactions are words. `emoji` is kept as an alias of the label for older call sites.
export const REACTIONS = {
  like: { emoji: 'Like', label: 'Like' },
  love: { emoji: 'Love', label: 'Love' },
  haha: { emoji: 'Haha', label: 'Haha' },
  wow: { emoji: 'Wow', label: 'Wow' },
  sad: { emoji: 'Sad', label: 'Sad' },
  angry: { emoji: 'Angry', label: 'Angry' },
  bag: { emoji: 'Bag', label: 'Bag' },
};

export const postUrl = post =>
  post.kind === 'video' ? `/watch/${post.id}` : post.kind === 'short' ? `/shorts/${post.id}` : `/post/${post.id}`;

/** Turns post text into nodes: #tags, @mentions and URLs become links. */
export function richText(text) {
  const out = [];
  const re = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])|(^|[^\w&])#(\w{1,50})|(^|[^\w])@(\w{3,20})/gu;
  let last = 0, m;
  while ((m = re.exec(text))) {
    let start = m.index;
    if (m[1]) {
      out.push(text.slice(last, start), h('a', { href: m[1], target: '_blank', rel: 'noopener noreferrer nofollow' }, m[1].replace(/^https?:\/\//, '')));
    } else if (m[3]) {
      start += m[2].length;
      out.push(text.slice(last, start), h('a', { href: `/tag/${m[3].toLowerCase()}` }, `#${m[3]}`));
    } else {
      start += m[4].length;
      out.push(text.slice(last, start), h('a', { href: `/@${m[5]}` }, `@${m[5]}`));
    }
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

const visibilityLabel = v => v === 'friends' ? 'Friends' : v === 'followers' ? 'Followers' : null;

function header(post, { onDeleted, onEdited }) {
  const a = post.author;
  const sub = h('div.sub',
    h('span.handle', `@${a.handle}`),
    h('a', { href: postUrl(post), title: fullDate(post.created_at) }, h('time', { datetime: new Date(post.created_at).toISOString() }, timeAgo(post.created_at))),
    post.edited_at ? h('span', { title: `Edited ${fullDate(post.edited_at)}` }, 'edited') : null,
    visibilityLabel(post.visibility) ? h('span', visibilityLabel(post.visibility)) : null,
    post.sponsored ? h('span.sponsored-tag', 'Sponsored') : null,
  );
  const more = h('button.icon-btn', { type: 'button' }, 'More');
  more.addEventListener('click', e => { e.stopPropagation(); postMenu(more, post, { onDeleted, onEdited }); });
  return h('div.post-head',
    avatar(a),
    h('div.meta',
      h('div', userName(a, { handle: false }),
        post.wall_user ? h('span.muted', ' to ', h('a', { href: `/@${post.wall_user.handle}` }, post.wall_user.name)) : null,
        post.group ? h('span.muted', ' in ', h('a', { href: `/g/${post.group.slug}` }, post.group.name)) : null),
      sub),
    more);
}

// The viewer's pinned post id once they pin or unpin in this session (undefined until then), so
// menus on other cards don't go by a stale `viewer.pinned`.
let myPin;
const isPinned = post => (myPin !== undefined ? myPin === post.id : Boolean(post.viewer?.pinned));
const canPin = post => post.viewer?.can_edit && !post.reply_to && !post.group && !(post.repost_of && !post.body);

async function togglePin(post) {
  const pinned = isPinned(post);
  try {
    if (pinned) await api.del('pins');
    else await api.put('pins', { post_id: post.id });
    myPin = pinned ? null : post.id;
    post.viewer.pinned = !pinned;
    toast(pinned ? 'Unpinned.' : 'Pinned to your profile.');
    window.dispatchEvent(new CustomEvent('southbag:pin', { detail: { post_id: myPin } }));
  } catch (err) { toastError(err); }
}

async function endPoll(post) {
  if (!(await confirm('No one will be able to vote after this.', { title: 'End poll', ok: 'End poll' }))) return;
  try {
    const { post: fresh } = await api.post(`polls/${post.id}/close`);
    post.poll = fresh.poll;
    document.querySelectorAll(`.poll[data-poll-id="${post.id}"]`).forEach(el => el.replaceWith(pollView(post)));
    toast('Poll ended.');
  } catch (err) { toastError(err); }
}

function postMenu(anchor, post, { onDeleted, onEdited }) {
  const mine = post.viewer?.can_edit;
  menu(anchor, [
    { label: 'Copy link', onClick: () => share(postUrl(post)) },
    store.me ? { label: 'Send in a message', href: `/messages?share=${post.id}` } : null,
    { label: post.viewer?.bookmarked ? 'Unsave' : 'Save', onClick: () => toggleBookmark(post) },
    post.media?.some(m => m.kind === 'image')
      ? { label: 'Save to board', onClick: () => import('./board-picker.js').then(m => m.saveToBoard({ post })) } : null,
    canPin(post) ? { label: isPinned(post) ? 'Unpin from profile' : 'Pin to profile', onClick: () => togglePin(post) } : null,
    mine && post.poll && !post.poll.closed ? { label: 'End poll', onClick: () => endPoll(post) } : null,
    mine ? { label: 'Edit', onClick: () => amend(post, onEdited) } : null,
    mine || post.viewer?.can_delete ? { label: 'Delete', onClick: () => remove(post, onDeleted) } : null,
    !mine ? { label: 'Report', onClick: () => toast('Reported.') } : null,
  ]);
}

async function toggleBookmark(post) {
  if (!store.me) return login();
  try {
    if (post.viewer.bookmarked) await api.del(`posts/${post.id}/bookmark`);
    else await api.put(`posts/${post.id}/bookmark`);
    post.viewer.bookmarked = !post.viewer.bookmarked;
    toast(post.viewer.bookmarked ? 'Saved.' : 'Removed from saved.');
    document.querySelectorAll(`[data-post-id="${post.id}"] .bm`).forEach(b => { b.textContent = post.viewer.bookmarked ? 'Saved' : 'Save'; });
  } catch (err) { toastError(err); }
}

async function amend(post, onEdited) {
  let title, textarea;
  const ok = await dialog({
    title: 'Edit post',
    wide: true,
    body: h('div',
      post.kind === 'video' ? h('label.field', h('span', 'Title'), title = h('input.input', { value: post.title || '', maxLength: 120 })) : null,
      h('label.field', h('span', 'Text'), textarea = h('textarea.textarea.boxed', { rows: 5 }, post.body))),
    actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }],
  });
  if (!ok) return;
  try {
    const { post: updated } = await api.patch(`posts/${post.id}`, { body: textarea.value, ...(title && { title: title.value }) });
    toast('Saved.');
    onEdited ? onEdited(updated) : replaceCards(updated);
  } catch (err) { toastError(err); }
}

async function remove(post, onDeleted) {
  if (!(await confirm('Delete this post?', { title: 'Delete post', ok: 'Delete' }))) return;
  try {
    await api.del(`posts/${post.id}`);
    toast('Deleted.');
    if (onDeleted) onDeleted(post);
    else document.querySelectorAll(`[data-post-id="${post.id}"]`).forEach(el => el.remove());
  } catch (err) { toastError(err); }
}

/** Re-renders every card showing this post (e.g. the same post in two lists). */
function replaceCards(post) {
  document.querySelectorAll(`.post[data-post-id="${post.id}"]`).forEach(el => {
    const fresh = postCard(post, el._postOptions || {});
    el.replaceWith(fresh);
  });
}

/** Summary like "Like 3, Haha 1". */
export function reactionSummary(post) {
  if (!post.counts.reactions) return null;
  return h('span.reaction-summary', post.reactions.slice(0, 3).map(([t, n]) => `${REACTIONS[t]?.label || t} ${count(n)}`).join(', '));
}

/** Like button with a Facebook-style picker on hover / long press. Updates `post` in place. */
export function reactionButton(post, { onChange } = {}) {
  const wrap = h('span', { style: 'position:relative;display:inline-flex' });
  const btn = h('button.icon-btn', { type: 'button' });
  const paint = () => {
    const r = post.viewer.reaction;
    btn.classList.toggle('on', Boolean(r));
    btn.setAttribute('aria-pressed', r ? 'true' : 'false');
    const word = r ? (r === 'like' ? 'Liked' : REACTIONS[r].label) : 'Like';
    mount(btn, post.counts.reactions ? `${word} (${count(post.counts.reactions)})` : word);
  };
  const react = async type => {
    if (!store.me) return login();
    const before = structuredClone({ viewer: post.viewer, counts: post.counts, reactions: post.reactions });
    const removing = type === null;
    // Optimistic update
    if (removing) post.counts.reactions = Math.max(0, post.counts.reactions - 1);
    else if (!post.viewer.reaction) post.counts.reactions++;
    post.viewer.reaction = type;
    paint();
    try {
      const { post: fresh } = removing ? await api.del(`posts/${post.id}/reaction`) : await api.put(`posts/${post.id}/reaction`, { type });
      Object.assign(post, { viewer: fresh.viewer, counts: fresh.counts, reactions: fresh.reactions });
      paint();
      onChange?.(post);
    } catch (err) {
      Object.assign(post, before);
      paint();
      shake(btn);
      toastError(err);
    }
  };
  let picker = null, hoverTimer = null, pressTimer = null, suppressClick = false;
  const openPicker = () => {
    if (picker) return;
    picker = h('div.reaction-picker', { role: 'menu', onmouseleave: closeSoon, onmouseenter: () => clearTimeout(hoverTimer) },
      Object.entries(REACTIONS).map(([type, r]) => h('button', {
        type: 'button', title: r.label, 'aria-label': r.label,
        onclick: e => { e.stopPropagation(); closePicker(); react(type); },
      }, r.label)));
    wrap.append(picker);
  };
  const closePicker = () => { picker?.remove(); picker = null; };
  const closeSoon = () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(closePicker, 350); };
  btn.addEventListener('mouseenter', () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(openPicker, 550); });
  btn.addEventListener('mouseleave', closeSoon);
  btn.addEventListener('touchstart', () => { pressTimer = setTimeout(() => { suppressClick = true; openPicker(); }, 450); }, { passive: true });
  btn.addEventListener('touchend', () => clearTimeout(pressTimer));
  btn.addEventListener('contextmenu', e => { e.preventDefault(); openPicker(); });
  btn.addEventListener('keydown', e => { if (e.key === 'ArrowUp') { e.preventDefault(); openPicker(); picker.querySelector('button').focus(); } });
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (suppressClick) { suppressClick = false; return; }
    clearTimeout(hoverTimer);
    closePicker();
    react(post.viewer.reaction ? null : 'like');
  });
  paint();
  wrap.append(btn);
  return wrap;
}

/** Repost button: menu with Repost / Quote. */
function repostButton(post) {
  const label = () => `${post.viewer.reposted ? 'Reposted' : 'Repost'}${post.counts.reposts ? ` (${count(post.counts.reposts)})` : ''}`;
  const btn = h('button.icon-btn', { type: 'button', 'aria-pressed': post.viewer.reposted ? 'true' : 'false' }, label());
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (!store.me) return login();
    menu(btn, [
      post.viewer.reposted
        ? { label: 'Undo repost', onClick: () => doRepost(false) }
        : { label: 'Repost', onClick: () => doRepost(true) },
      { label: 'Quote', onClick: () => quote(post) },
    ]);
  });
  async function doRepost(on) {
    try {
      const { post: fresh } = on ? await api.post(`posts/${post.id}/repost`) : await api.del(`posts/${post.id}/repost`);
      Object.assign(post, { viewer: fresh.viewer, counts: fresh.counts });
      btn.textContent = label();
      btn.setAttribute('aria-pressed', post.viewer.reposted ? 'true' : 'false');
      toast(on ? 'Reposted.' : 'Repost removed.');
    } catch (err) { toastError(err); }
  }
  return btn;
}

/** Quote-post dialog. */
export async function quote(post) {
  if (!store.me) return login();
  const { composer } = await import('./composer.js');
  dialog({
    title: 'Quote post',
    wide: true,
    actions: [],
    body: close => h('div',
      composer({
        placeholder: 'Add a comment',
        quoteOf: post,
        autofocus: true,
        onPosted: () => { close(); toast('Posted.'); },
      }),
      h('div.quote', embeddedPost(post))),
  });
}

/** The compact original inside a quote or repost. */
function embeddedPost(post) {
  if (!post) return h('p.deleted', 'This post is unavailable.');
  return h('div', { onclick: e => { if (!e.target.closest('a, button, video')) navigate(postUrl(post)); } },
    h('div.row', avatar(post.author, { size: 'xs', link: false }), userName(post.author), h('span.muted', timeAgo(post.created_at))),
    post.title ? h('div.post-title', post.title) : null,
    post.body ? h('div.post-body', richText(post.body)) : null,
    pollSummary(post),
    post.media?.length ? h('div.post-media', postMedia(post)) : null);
}

/**
 * A post as a card.
 * options: compact (smaller, for replies), link (click body to open), onDeleted(post), onEdited(post),
 *          onReply(post) (instead of navigating to the thread), card (wrap in .south-card, default true)
 */
export function postCard(input, options = {}) {
  const { compact = false, link = true, card = true, onReply, onDeleted, onEdited } = options;
  // A plain repost shows the original with a "reposted" line.
  const isRepost = input.repost_of && !input.body && !input.media.length;
  const post = isRepost ? input.repost_of : input;
  if (isRepost && !post) return null;

  const el = h(card ? 'article.south-card.post' : 'article.post', {
    class: { compact }, dataset: { postId: post.id },
  });
  el._postOptions = options;
  if (isRepost) {
    el.append(h('div.post-context', h('a', { href: `/@${input.author.handle}` }, input.author.name), ' reposted'));
  } else if (input.reply_to && !compact) {
    el.append(h('div.post-context', 'Replying to ', input.reply_to.author
      ? h('a', { href: `/@${input.reply_to.author.handle}` }, `@${input.reply_to.author.handle}`)
      : 'a post'));
  }
  if (post.deleted) {
    el.append(h('p.deleted', 'This post was deleted.'));
    return el;
  }
  el.append(header(post, { onDeleted, onEdited }));
  if (post.title) el.append(h('h3.post-title', link ? h('a', { href: postUrl(post), style: 'color:inherit' }, post.title) : post.title));
  if (post.body) el.append(h('div.post-body', richText(post.body)));
  if (post.poll) el.append(pollView(post));
  const media = postMedia(post);
  if (media) el.append(h('div.post-media', media));
  if (post.repost_of && post.body) el.append(h('div.quote', embeddedPost(post.repost_of)));

  const commentBtn = h('button.icon-btn', { type: 'button' },
    post.counts.replies ? `Comment (${count(post.counts.replies)})` : 'Comment');
  commentBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (onReply) onReply(post);
    else navigate(postUrl(post) + (post.kind === 'text' || post.kind === 'photo' ? '#reply' : ''));
  });
  el.append(h('div.post-actions',
    reactionButton(post),
    commentBtn,
    repostButton(post),
    (post.kind === 'video' || post.kind === 'short') && post.counts.views
      ? h('span.muted', `${count(post.counts.views)} views`) : null,
    h('span.spacer'),
    reactionSummary(post),
    h('button.icon-btn.bm', { type: 'button', onclick: e => { e.stopPropagation(); toggleBookmark(post); } }, post.viewer.bookmarked ? 'Saved' : 'Save'),
    h('button.icon-btn', { type: 'button', onclick: e => { e.stopPropagation(); share(postUrl(post)); } }, 'Share'),
  ));

  if (link) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', e => {
      if (e.target.closest('a, button, video, audio, input, textarea, label, .poll, .carousel, .media-grid, .reaction-picker') || getSelection()?.toString()) return;
      navigate(postUrl(post));
    });
  }
  return el;
}

/** Removed (it used to throw confetti). Kept so older call sites keep working. */
export function celebrateFirstPost() {}
