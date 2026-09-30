// The post card: every surface renders posts with this (feed, profiles, groups, search, threads).
//
//   postCard(post, { compact, onDeleted, onReply, link = true })
//
// Handles reposts ("@x reposted"), quotes, reactions (click = like, hover/long-press = picker),
// comments, reposting/quoting, sharing, bookmarks, amending and "requesting deletion".

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { count, fullDate, timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { login, store } from '../store.js';
import { confetti, confirm, dialog, menu, share, shake, toast, toastError } from '../ui.js';
import { postMedia } from './media.js';
import { avatar, userName } from './user.js';

export const REACTIONS = {
  like: { emoji: '❤️', label: 'Like' },
  love: { emoji: '😍', label: 'Love' },
  haha: { emoji: '😂', label: 'Haha' },
  wow: { emoji: '😮', label: 'Wow' },
  sad: { emoji: '😢', label: 'Sad' },
  angry: { emoji: '😡', label: 'Angry' },
  bag: { emoji: '💰', label: 'Bag' },
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

const visibilityIcon = v => v === 'friends' ? icon('users') : v === 'followers' ? icon('lock') : null;

function header(post, { onDeleted, onEdited }) {
  const a = post.author;
  const sub = h('div.sub',
    h('span.handle', `@${a.handle}`),
    h('span', '·'),
    h('a', { href: postUrl(post), title: fullDate(post.created_at) }, h('time', { datetime: new Date(post.created_at).toISOString() }, timeAgo(post.created_at))),
    post.edited_at ? h('span', { title: `Amended ${fullDate(post.edited_at)}. The original is retained.` }, '· amended') : null,
    visibilityIcon(post.visibility) ? h('span', { title: `Visible to ${post.visibility}` }, visibilityIcon(post.visibility)) : null,
    post.sponsored ? h('span.sponsored-tag', 'SPONSORED') : null,
  );
  const more = h('button.icon-btn', { type: 'button', 'aria-label': 'More options' }, icon('more'));
  more.addEventListener('click', e => { e.stopPropagation(); postMenu(more, post, { onDeleted, onEdited }); });
  return h('div.post-head',
    avatar(a),
    h('div.meta',
      h('div', userName(a, { handle: false }),
        post.wall_user ? h('span.muted', ' ▸ ', h('a', { href: `/@${post.wall_user.handle}` }, post.wall_user.name)) : null,
        post.group ? h('span.muted', ' ▸ ', h('a', { href: `/g/${post.group.slug}` }, post.group.name)) : null),
      sub),
    more);
}

function postMenu(anchor, post, { onDeleted, onEdited }) {
  const mine = post.viewer?.can_edit;
  menu(anchor, [
    { label: 'Copy link', icon: 'link', onClick: () => share(postUrl(post)) },
    store.me ? { label: 'Send in a message', icon: 'send', href: `/messages?share=${post.id}` } : null,
    { label: post.viewer?.bookmarked ? 'Remove bookmark' : 'Bookmark', icon: 'bookmark', onClick: () => toggleBookmark(post) },
    mine ? { label: 'Amend', icon: 'edit', onClick: () => amend(post, onEdited) } : null,
    mine || post.viewer?.can_delete ? { label: 'Request deletion', icon: 'trash', danger: true, onClick: () => remove(post, onDeleted) } : null,
    'divider',
    { label: 'Why am I seeing this?', icon: 'eye', onClick: () => dialog({ title: 'Algorithmic transparency', body: 'Kevin.' }) },
    !mine ? { label: 'Report to Kevin', icon: 'flag', onClick: () => toast('Reported. Kevin has already seen it.') } : null,
  ]);
}

async function toggleBookmark(post) {
  if (!store.me) return login();
  try {
    if (post.viewer.bookmarked) await api.del(`posts/${post.id}/bookmark`);
    else await api.put(`posts/${post.id}/bookmark`);
    post.viewer.bookmarked = !post.viewer.bookmarked;
    toast(post.viewer.bookmarked ? 'Bookmarked. Southbag has bookmarked it too.' : 'Bookmark removed. The copy we kept is not.');
    document.querySelectorAll(`[data-post-id="${post.id}"] .bm`).forEach(b => b.classList.toggle('bookmarked', post.viewer.bookmarked));
  } catch (err) { toastError(err); }
}

async function amend(post, onEdited) {
  let title, textarea;
  const ok = await dialog({
    title: 'Amend post',
    wide: true,
    body: h('div',
      post.kind === 'video' ? h('label.field', h('span', 'Title'), title = h('input.input', { value: post.title || '', maxLength: 120 })) : null,
      h('label.field', h('span', 'Text'), textarea = h('textarea.textarea.boxed', { rows: 5 }, post.body)),
      h('p.fine', 'Amendments are logged. The original is retained.')),
    actions: [{ label: 'Cancel', value: false }, { label: 'Amend', value: true, primary: true }],
  });
  if (!ok) return;
  try {
    const { post: updated } = await api.patch(`posts/${post.id}`, { body: textarea.value, ...(title && { title: title.value }) });
    toast('Amended. The original is retained.');
    onEdited ? onEdited(updated) : replaceCards(updated);
  } catch (err) { toastError(err); }
}

async function remove(post, onDeleted) {
  if (!(await confirm('Request deletion of this post? Deletion is advisory.', { ok: 'Request deletion' }))) return;
  try {
    await api.del(`posts/${post.id}`);
    toast('Deletion request filed. Posts are never fully deleted.');
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

/** Summary like "❤️😂 12". */
export function reactionSummary(post) {
  if (!post.counts.reactions) return null;
  const top = post.reactions.slice(0, 3).map(([type]) => REACTIONS[type]?.emoji || '❤️');
  return h('span.reaction-summary', { title: post.reactions.map(([t, n]) => `${REACTIONS[t]?.label}: ${n}`).join(', ') },
    h('span.emo', top.join('')), count(post.counts.reactions));
}

/** Like button with a Facebook-style picker on hover / long press. Updates `post` in place. */
export function reactionButton(post, { onChange } = {}) {
  const wrap = h('span', { style: 'position:relative;display:inline-flex' });
  const btn = h('button.icon-btn', { type: 'button' });
  const paint = () => {
    const r = post.viewer.reaction;
    btn.classList.toggle('on', Boolean(r));
    btn.setAttribute('aria-pressed', r ? 'true' : 'false');
    btn.title = r ? 'Withdraw reaction (processing: 1–3 business days)' : 'Like (fees apply)';
    mount(btn, r && r !== 'like' ? h('span', { style: 'font-size:1.1rem' }, REACTIONS[r].emoji) : icon('heart'),
      post.counts.reactions ? h('span', count(post.counts.reactions)) : h('span.sr-only', 'Like'));
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
      if (!removing && !before.viewer.reaction && Math.random() < 0.25) toast(`${REACTIONS[type].label}d.`, { fee: 'Appreciation surcharge' });
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
      }, r.emoji)));
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
  const btn = h('button.icon-btn', { type: 'button', title: 'Repost', class: { reposted: post.viewer.reposted } },
    icon('repost'), post.counts.reposts ? h('span', count(post.counts.reposts)) : h('span.sr-only', 'Repost'));
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (!store.me) return login();
    menu(btn, [
      post.viewer.reposted
        ? { label: 'Undo repost', icon: 'repost', onClick: () => doRepost(false) }
        : { label: 'Repost', icon: 'repost', onClick: () => doRepost(true) },
      { label: 'Quote', icon: 'edit', onClick: () => quote(post) },
    ]);
  });
  async function doRepost(on) {
    try {
      const { post: fresh } = on ? await api.post(`posts/${post.id}/repost`) : await api.del(`posts/${post.id}/repost`);
      Object.assign(post, { viewer: fresh.viewer, counts: fresh.counts });
      btn.classList.toggle('reposted', post.viewer.reposted);
      btn.querySelector('span').textContent = post.counts.reposts ? count(post.counts.reposts) : 'Repost';
      btn.querySelector('span').className = post.counts.reposts ? '' : 'sr-only';
      toast(on ? 'Reposted. Kevin was first.' : 'Repost withdrawn.');
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
        placeholder: 'Add a comment. Keep it compliant.',
        quoteOf: post,
        autofocus: true,
        onPosted: () => { close(); toast('Quoted. The original author has been notified and logged.'); },
      }),
      h('div.quote', embeddedPost(post))),
  });
}

/** The compact original inside a quote or repost. */
function embeddedPost(post) {
  if (!post) return h('p.deleted', 'This post is unavailable. It may have been deleted, or Kevin may simply prefer you not see it.');
  return h('div', { onclick: e => { if (!e.target.closest('a, button, video')) navigate(postUrl(post)); } },
    h('div.row', avatar(post.author, { size: 'xs', link: false }), userName(post.author), h('span.muted', `· ${timeAgo(post.created_at)}`)),
    post.title ? h('div.post-title', post.title) : null,
    post.body ? h('div.post-body', richText(post.body)) : null,
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
    el.append(h('div.post-context', icon('repost'), h('a', { href: `/@${input.author.handle}` }, input.author.name), ' reposted'));
  } else if (input.reply_to && !compact) {
    el.append(h('div.post-context', icon('comment'), 'Replying to ', input.reply_to.author
      ? h('a', { href: `/@${input.reply_to.author.handle}` }, `@${input.reply_to.author.handle}`)
      : 'a post'));
  }
  if (post.deleted) {
    el.append(h('p.deleted', 'This post was deleted. The deletion request was approved. A copy was retained.'));
    return el;
  }
  el.append(header(post, { onDeleted, onEdited }));
  if (post.title) el.append(h('h3.post-title', link ? h('a', { href: postUrl(post), style: 'color:inherit' }, post.title) : post.title));
  if (post.body) el.append(h('div.post-body', richText(post.body)));
  const media = postMedia(post);
  if (media) el.append(h('div.post-media', media));
  if (post.repost_of && post.body) el.append(h('div.quote', embeddedPost(post.repost_of)));

  const commentBtn = h('button.icon-btn', { type: 'button', title: 'Comment' },
    icon('comment'), post.counts.replies ? h('span', count(post.counts.replies)) : h('span.sr-only', 'Comment'));
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
      ? h('span.icon-btn', { title: 'Views' }, icon('eye'), count(post.counts.views)) : null,
    h('span.spacer'),
    reactionSummary(post),
    h('button.icon-btn.bm', { type: 'button', title: 'Bookmark', class: { bookmarked: post.viewer.bookmarked }, onclick: e => { e.stopPropagation(); toggleBookmark(post); } }, icon('bookmark')),
    h('button.icon-btn', { type: 'button', title: 'Share', onclick: e => { e.stopPropagation(); share(postUrl(post)); } }, icon('share')),
  ));

  if (link) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', e => {
      if (e.target.closest('a, button, video, audio, input, textarea, .carousel, .media-grid, .reaction-picker') || getSelection()?.toString()) return;
      navigate(postUrl(post));
    });
  }
  return el;
}

/** First post celebration, used by the composer. */
export function celebrateFirstPost() {
  try {
    if (localStorage.getItem('sb_first_post')) return;
    localStorage.setItem('sb_first_post', '1');
  } catch { return; }
  confetti();
  toast('Your first post. It will be retained permanently.');
}
