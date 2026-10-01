// Direct messages: /messages (conversation list) and /messages/:id (a conversation).
//
// Two ridge-bordered panels on desktop (conversations left, the open conversation right), like
// Identity's dashboard; on phones it's the list OR the conversation, which then takes the whole
// screen with a "Back" button. Plain text only: every control is a word. Styles live in
// public/css/messages.css.
//
// Extra entry points other features can link to:
//   /messages?to=<handle>    find-or-create the 1:1 with that person and open it (profile "Message" button)
//   /messages/support        open (and create if needed) the viewer's Southbag Support conversation
//   /messages?share=<postId> open the "New message" dialog to send that post to someone
//
// Free plan: there is no push, so an open conversation polls /api/messages/:id/poll. See POLL below.
//
// Streaks (src/routes/streaks.ts): one-to-one conversations carry `streak` ({ current, longest,
// at_risk, completed_today } or null). The list and the header show "Streak: 12 days" (Southbag blue
// with ", ends tonight" while today hasn't counted yet), a "Streaks" section tops the list, and the
// chat gets a "Streak extended to 13 days." line when the send response or a poll shows today count.
// Styles for those live in public/css/streaks.css.

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { fullDate, money, plural, timeAgo } from '../format.js';
import { store } from '../store.js';
import { confirm, dialog, empty, errorBox, lightbox, loading, menu, promptDialog, toast, toastError } from '../ui.js';
import { pickFiles, uploadFile } from '../upload.js';
import { avatar } from '../components/user.js';
import { postUrl, richText } from '../components/post.js';
import { videoEl } from '../components/media.js';
import { sendMoneyDialog } from '../components/payments.js';

// Polling budget. The free plan allows 100k Worker requests a day, and every poll is one. So: poll
// every 5 s while a conversation is open, visible and active; after a minute of silence drop to
// 20 s, after five minutes to 30 s; stop entirely while the tab is hidden; never poll Southbag Support
// (its replies arrive with the send). The conversation list refreshes every 30 s while it is on screen.
// An hour of active chatting costs ~720 requests; an idle open tab ~120 an hour.
const POLL = { fast: 5000, slow: 20000, slowest: 30000, idleAfter: 60000, veryIdleAfter: 300000, list: 30000 };
const GROUP_GAP = 5 * 60 * 1000; // consecutive messages within 5 minutes share a bubble group
const MAX_MESSAGE = 2000;
const SUPPORT_AVATAR = '/img/s-256.png';

// The conversation list survives re-renders (back/forward re-runs this view), so it paints instantly.
const cache = { items: null, next: null, error: null };
// GET /api/streaks, for the "Streaks" section. Loaded with the view and when a streak extends; the
// conversation list (refreshed every 30 s) keeps the numbers current in between.
const streakCache = { items: null };
const STREAKS_SHOWN = 5;

const phoneQuery = matchMedia('(max-width: 640px)');

// -- Small helpers -------------------------------------------------------

const me = () => store.me;
const clock = ms => new Date(ms).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
const dayKey = ms => new Date(ms).toDateString();
function dayLabel(ms) {
  const d = new Date(ms), today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() && { year: 'numeric' }) });
}
const firstName = name => (name || '').split(/\s+/)[0];

function names(people, max = 3) {
  const list = people.map(p => firstName(p.name) || `@${p.handle}`);
  if (list.length <= max) return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] || '';
  return `${list.slice(0, max).join(', ')} and ${list.length - max} others`;
}

function convTitle(c) {
  if (c.is_support) return 'Southbag Support';
  if (c.title) return c.title;
  if (!c.members?.length) return 'Empty conversation';
  return c.is_group ? names(c.members) : c.members[0].name;
}

function supportAvatar(size = 'sm') {
  return h('span.avatar.dm-support-av', { class: { [size]: Boolean(size) } },
    h('img', { src: SUPPORT_AVATAR, alt: '' }));
}

/** Avatar for a conversation: the other person, the first member for groups, the bag for Support. */
function convAvatar(c) {
  if (c.is_support) return supportAvatar();
  return avatar(c.members?.[0] || { name: convTitle(c) }, { link: false, size: 'sm' });
}

function excerpt(item) {
  const m = item.last_message;
  if (!m) return item.is_support ? 'Help with your account' : 'No messages.';
  const who = m.sender_id && m.sender_id === me()?.id ? 'You: '
    : item.is_group && m.sender_id ? `${firstName(item.members.find(p => p.id === m.sender_id)?.name) || 'Someone'}: ` : '';
  const text = m.kind === 'payment' ? (m.body ? `Sent money: ${m.body}` : 'Sent money')
    : m.body || (m.kind === 'post' ? 'Shared a post' : m.kind === 'media' ? 'Sent a photo or video' : '');
  return who + text;
}

const itemFromConversation = c => ({
  id: c.id, title: c.title, is_group: c.is_group, is_support: c.is_support, members: c.members,
  last_message: null, unread: false, last_message_at: c.last_message_at, streak: c.streak ?? null,
});

/** "Streak: 12 days", or "Streak: 12 days, ends tonight" while today hasn't counted yet. */
const streakText = s => `Streak: ${plural(s.current, 'day')}${s.at_risk ? ', ends tonight' : ''}`;
function streakLabel(s, cls = '') {
  if (!s || !s.current) return null;
  return h(`span.streak-label${cls ? `.${cls}` : ''}`, { class: { 'at-risk': s.at_risk } }, streakText(s));
}
const sameStreak = (a, b) => (a?.current ?? 0) === (b?.current ?? 0) && Boolean(a?.at_risk) === Boolean(b?.at_risk)
  && (a?.longest ?? 0) === (b?.longest ?? 0) && Boolean(a?.completed_today) === Boolean(b?.completed_today);

function lastMessageSummary(m) {
  return { body: (m.body || '').slice(0, 140), sender_id: m.sender?.id ?? null, created_at: m.created_at, kind: m.post || m.post_unavailable ? 'post' : m.media ? 'media' : 'text' };
}

/** Finds a link to a post on this site in a message ("/post/...", "/watch/...", "/shorts/..."). */
function findPostLink(text) {
  const re = /(?:https?:\/\/([^\s/]+))?\/(?:post|watch|shorts)\/([0-9a-z]{16})(?![\w/])/gi;
  for (const m of text.matchAll(re)) {
    if (m[1] && m[1] !== location.host) continue;
    if (!m[1] && m.index > 0 && !/\s/.test(text[m.index - 1])) continue;
    return { id: m[2].toLowerCase(), match: m[0] };
  }
  return null;
}

// -- The view ------------------------------------------------------------

export default async function view(ctx) {
  if (!ctx.requireAuth()) return null;
  const setLayout = () => ctx.layout(phoneQuery.matches ? 'full' : 'wide');
  setLayout();
  ctx.title('Messages');

  let openId = ctx.params.id || null;
  let chat = null;
  const root = h('div.dm');
  const listPane = h('section.dm-list', { 'aria-label': 'Conversations' });
  const chatPane = h('section.dm-chat', { 'aria-label': 'Conversation' });
  const panes = h('div.dm-panes', listPane, chatPane);
  root.append(
    h('div.page-head.dm-page-head',
      h('h1', 'Messages'),
      h('span.spacer'),
      h('button', { type: 'button', onclick: () => newMessageDialog() }, 'New message')),
    panes);

  // /messages?to=<handle>: find-or-create the 1:1 and open it.
  const to = ctx.query.get('to');
  if (to && !openId) {
    try {
      const { conversation } = await api.post('messages', { handles: [to] });
      if (ctx.signal.aborted) return null;
      upsertItem(itemFromConversation(conversation), { keepExisting: true });
      history.replaceState({}, '', `/messages/${conversation.id}`);
      openId = conversation.id;
    } catch (err) {
      toastError(err);
      history.replaceState({}, '', '/messages');
    }
  }
  // /messages/support: the viewer's Southbag Support conversation.
  if (openId === 'support') {
    try {
      const { conversation } = await api.post('messages/support');
      if (ctx.signal.aborted) return null;
      upsertItem(itemFromConversation(conversation), { keepExisting: true });
      history.replaceState({}, '', `/messages/${conversation.id}`);
      openId = conversation.id;
    } catch (err) {
      toastError(err);
      openId = null;
      history.replaceState({}, '', '/messages');
    }
  }
  const sharePost = ctx.query.get('share');
  if (sharePost) history.replaceState({}, '', openId ? `/messages/${openId}` : '/messages');

  // -- List pane --

  function upsertItem(item, { keepExisting = false } = {}) {
    if (!cache.items) return;
    const i = cache.items.findIndex(x => x.id === item.id);
    if (i >= 0) { if (!keepExisting) cache.items[i] = { ...cache.items[i], ...item }; }
    else cache.items.unshift(item);
    cache.items.sort((a, b) => b.last_message_at - a.last_message_at);
  }

  function listItem(item) {
    const active = item.id === openId;
    return h('li.dm-item', { class: { unread: item.unread, active } },
      convAvatar(item),
      h('div.dm-item-main',
        h('div.dm-item-top',
          h('a.dm-item-name', {
            href: `/messages/${item.id}`, 'aria-current': active ? 'page' : null,
            onclick: e => openFromList(e, item.id),
          }, convTitle(item)),
          item.unread ? h('span.dm-unread', 'Unread') : null,
          h('time.dm-item-time', { datetime: new Date(item.last_message_at).toISOString(), title: fullDate(item.last_message_at) }, timeAgo(item.last_message_at))),
        item.streak ? h('div.dm-item-streak', streakLabel(item.streak)) : null,
        h('div.dm-item-excerpt', excerpt(item))));
  }

  /** Top streaks, with the numbers from the conversation list where it has them (it's fresher). */
  function streaksSection() {
    if (!streakCache.items) return null;
    const live = streakCache.items.map(s => {
      const item = s.conversation_id ? cache.items?.find(i => i.id === s.conversation_id) : null;
      if (!item || !('streak' in item)) return s;
      return item.streak ? { ...s, ...item.streak } : null;
    }).filter(s => s && s.current > 0).sort((a, b) => b.current - a.current).slice(0, STREAKS_SHOWN);
    if (!live.length) return null;
    return h('section.dm-streaks', { 'aria-labelledby': 'dm-streaks-title' },
      h('h3.dm-streaks-title', { id: 'dm-streaks-title' }, 'Streaks'),
      h('ul.dm-streak-list', live.map(s => h('li.dm-streak', { class: { active: s.conversation_id === openId } },
        h('a.dm-streak-name', {
          href: s.conversation_id ? `/messages/${s.conversation_id}` : `/messages?to=${encodeURIComponent(s.user.handle)}`,
          onclick: e => { if (s.conversation_id) openFromList(e, s.conversation_id); },
        }, s.user.name),
        h('span.dm-streak-meta', streakLabel(s), h('span.dm-streak-longest', `Longest: ${plural(s.longest, 'day')}`))))));
  }

  async function refreshStreaks() {
    try {
      const data = await api.get('streaks', {}, { signal: ctx.signal });
      streakCache.items = data.items || [];
      renderList();
    } catch { /* the section is optional; the list still shows each streak */ }
  }

  function supportEntry() {
    const item = cache.items?.find(i => i.is_support);
    const active = item && item.id === openId;
    return h('li.dm-item.dm-pinned', { class: { unread: item?.unread, active } },
      convAvatar({ is_support: true }),
      h('div.dm-item-main',
        h('div.dm-item-top',
          h('a.dm-item-name', {
            href: item ? `/messages/${item.id}` : '/messages/support', 'aria-current': active ? 'page' : null,
            onclick: e => openSupport(e),
          }, 'Southbag Support'),
          item?.unread ? h('span.dm-unread', 'Unread') : null,
          h('span.dm-pin', 'Pinned')),
        h('div.dm-item-excerpt', item?.last_message ? excerpt(item) : 'Help with your account')));
  }

  function renderList() {
    const rest = (cache.items || []).filter(i => !i.is_support);
    let body;
    if (cache.error && !cache.items) body = h('div.dm-pad', errorBox(cache.error), h('button.btn-small', { type: 'button', onclick: refreshList }, 'Try again'));
    else if (!cache.items) body = loading();
    else if (!rest.length) body = empty({ title: 'No messages.' });
    else body = h('ul.dm-items', rest.map(listItem));
    mount(listPane,
      h('div.dm-list-head', h('h2', 'Conversations')),
      h('div.dm-list-scroll',
        streaksSection(),
        h('ul.dm-items.pinned', supportEntry()),
        body,
        cache.next ? h('div.dm-pad.center', h('button.btn-small', { type: 'button', onclick: loadMoreList }, 'Load more')) : null));
  }

  async function refreshList() {
    try {
      const data = await api.get('messages', {}, { signal: ctx.signal });
      // Keep conversations we added locally (an empty 1:1 opened via ?to=) until the server has them.
      const local = (cache.items || []).filter(i => !data.items.some(x => x.id === i.id) && i.id === openId);
      cache.items = [...local, ...data.items].sort((a, b) => b.last_message_at - a.last_message_at);
      cache.next = data.next;
      cache.error = null;
      if (openId) { const it = cache.items.find(i => i.id === openId); if (it && it.unread && document.visibilityState === 'visible') chat?.markRead(); }
      if (typeof data.unread_count === 'number') store.setUnread({ messages: data.unread_count });
    } catch (err) {
      if (err.name === 'AbortError') return;
      cache.error = err;
    }
    renderList();
  }

  async function loadMoreList() {
    try {
      const data = await api.get('messages', { cursor: cache.next }, { signal: ctx.signal });
      cache.items.push(...data.items.filter(i => !cache.items.some(x => x.id === i.id)));
      cache.next = data.next;
      renderList();
    } catch (err) { if (err.name !== 'AbortError') toastError(err); }
  }

  // -- Opening conversations without a full route re-render --

  function openFromList(e, id) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (id === openId) { chat?.focus(); return; }
    history.pushState({ dmFromList: true }, '', `/messages/${id}`);
    openConversation(id);
  }

  async function openSupport(e) {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
    e?.preventDefault();
    let item = cache.items?.find(i => i.is_support);
    if (!item) {
      try {
        const { conversation } = await api.post('messages/support');
        item = itemFromConversation(conversation);
        if (!cache.items) cache.items = [];
        upsertItem(item);
      } catch (err) { toastError(err); return; }
    }
    if (item.id === openId) return;
    history.pushState({ dmFromList: true }, '', `/messages/${item.id}`);
    openConversation(item.id);
  }

  function goBack() {
    if (history.state?.dmFromList) { history.back(); return; }
    history.pushState({}, '', '/messages');
    openConversation(null);
  }

  function lockScroll() {
    document.documentElement.classList.toggle('dm-lock', Boolean(openId) && phoneQuery.matches);
  }

  function openConversation(id) {
    chat?.destroy();
    chat = null;
    openId = id;
    root.classList.toggle('open', Boolean(id));
    lockScroll();
    renderList();
    if (!id) {
      ctx.title('Messages');
      mount(chatPane, h('div.dm-placeholder',
        h('h2', 'No conversation selected'),
        h('p', 'Choose a conversation, or start a new one.'),
        h('button', { type: 'button', onclick: () => newMessageDialog() }, 'New message')));
      return;
    }
    chat = conversationPane(id, {
      onBack: goBack,
      onMessage: (m, { unread = false } = {}) => {
        const item = cache.items?.find(i => i.id === id);
        if (!item) { refreshList(); return; }
        item.last_message = lastMessageSummary(m);
        item.last_message_at = Math.max(item.last_message_at, m.created_at);
        item.unread = unread;
        cache.items.sort((a, b) => b.last_message_at - a.last_message_at);
        renderList();
      },
      onRead: () => {
        const item = cache.items?.find(i => i.id === id);
        if (item?.unread) {
          item.unread = false;
          store.setUnread({ messages: Math.max(0, (store.unread.messages || 0) - 1) });
          renderList();
        } else if (!item) store.refresh();
      },
      onConversation: c => {
        // Keep the list's excerpt and unread state; the conversation payload doesn't carry them.
        const { last_message: _m, unread: _u, ...fresh } = itemFromConversation(c);
        const existing = cache.items?.find(i => i.id === c.id);
        upsertItem(existing ? fresh : { ...fresh, last_message: null, unread: false }, { keepExisting: false });
        renderList();
        ctx.title(convTitle(c));
      },
      onStreak: (streak, { extended }) => {
        const item = cache.items?.find(i => i.id === id);
        if (item) item.streak = streak;
        renderList();
        if (extended) refreshStreaks();
      },
      onLeft: () => {
        if (cache.items) cache.items = cache.items.filter(i => i.id !== id);
        history.pushState({}, '', '/messages');
        openConversation(null);
      },
    });
    mount(chatPane, chat.el);
  }

  // -- New message dialog --

  function newMessageDialog({ postId = null } = {}) {
    const selected = new Map();
    let searchBroken = false, timer = null, seq = 0;
    const input = h('input.input.boxed', {
      type: 'search', placeholder: 'Name or handle', 'aria-label': 'Search people', autocomplete: 'off',
    });
    const results = h('div.dm-results', { role: 'list', 'aria-label': 'People' });
    const chips = h('div.dm-chips', { 'aria-live': 'polite' });
    const titleInput = h('input.input.boxed', { maxLength: 60, placeholder: 'Group name', 'aria-label': 'Group name (optional)' });
    const titleField = h('label.field.hidden', h('span', 'Group name (optional)'), titleInput);
    const startBtn = h('button', { type: 'submit', disabled: true }, postId ? 'Send' : 'Start conversation');
    const note = h('p.fine', { style: 'margin:6px 0 0' });

    const recent = () => {
      const seen = new Map();
      for (const item of cache.items || []) for (const p of item.members || []) if (!seen.has(p.handle)) seen.set(p.handle, p);
      return [...seen.values()].slice(0, 8);
    };

    function renderChips() {
      const label = p => (p.name && p.name !== `@${p.handle}` ? p.name : `@${p.handle}`);
      mount(chips, selected.size ? h('span.dm-chips-to', 'To:') : null, [...selected.values()].map(p => h('span.dm-chip',
        h('span', label(p)),
        h('button.btn-small', {
          type: 'button', 'aria-label': `Remove ${label(p)}`,
          onclick: () => { selected.delete(p.handle.toLowerCase()); renderChips(); search(); input.focus(); },
        }, 'Remove'))));
      titleField.classList.toggle('hidden', selected.size < 2);
      startBtn.disabled = !selected.size;
      startBtn.textContent = postId ? 'Send' : selected.size > 1 ? 'Start group chat' : 'Start conversation';
    }

    function toggle(p) {
      const key = p.handle.toLowerCase();
      if (selected.has(key)) selected.delete(key);
      else {
        if (selected.size >= 19) { toast('Group chats are limited to 20 people, including you.'); return; }
        selected.set(key, p);
      }
      renderChips();
      renderResults(lastResults);
    }

    let lastResults = [], resultsFor = '';
    function renderResults(people, heading, query = '') {
      lastResults = people;
      resultsFor = query;
      const rows = people.filter(p => p.id !== me()?.id).map(p => {
        const on = selected.has(p.handle.toLowerCase());
        return h('div.dm-result', { role: 'listitem', class: { on } },
          avatar(p, { link: false, size: 'xs' }),
          h('span.grow', h('span.dm-result-name', p.name), ' ', h('span.dm-result-handle', `@${p.handle}`)),
          h('button.btn-small', { type: 'button', 'aria-pressed': String(on), 'aria-label': `${on ? 'Remove' : 'Add'} ${p.name}`, onclick: () => toggle(p) }, on ? 'Remove' : 'Add'));
      });
      mount(results, heading ? h('p.eyebrow', heading) : null, rows.length ? rows : null);
    }

    async function search() {
      const q = input.value.trim().replace(/^@/, '');
      clearTimeout(timer);
      if (!q) { renderResults(recent(), recent().length ? 'Recent' : null); mount(note, searchBroken ? 'Type an exact handle and press Enter.' : ''); return; }
      if (searchBroken) { renderResults([], null); mount(note, `Press Enter to add @${q}.`); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const data = await api.get('search', { q, type: 'people', limit: 8 });
          if (mine !== seq) return;
          const list = (data.items || data.people || data.users || []).map(x => x.user || x).filter(x => x && x.handle);
          renderResults(list, null, q);
          mount(note, list.length ? '' : `No results. Press Enter to add @${q} anyway.`);
        } catch {
          // Search is another feature; if it isn't there, fall back to typing handles.
          searchBroken = true;
          mount(note, `People search is unavailable. Press Enter to add @${q}.`);
          renderResults([]);
        }
      }, 220);
    }

    input.addEventListener('input', search);
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = input.value.trim().replace(/^@/, '');
      if (!q) { if (selected.size) start(); return; }
      // Exact handle first; otherwise the top result, but only if the results are for what was typed.
      const match = lastResults.find(p => p.handle.toLowerCase() === q.toLowerCase()) || (resultsFor === q && lastResults[0]);
      const person = match || (/^\w{1,30}$/.test(q) ? { id: null, handle: q, name: `@${q}`, avatar_url: null } : null);
      if (!person) return;
      if (!selected.has(person.handle.toLowerCase())) toggle(person);
      input.value = '';
      search();
    });

    let closeDialog;
    async function start() {
      if (!selected.size) return;
      startBtn.disabled = true;
      try {
        const res = await api.post('messages', {
          handles: [...selected.values()].map(p => p.handle),
          title: selected.size > 1 ? titleInput.value.trim() || undefined : undefined,
          post_id: postId || undefined,
        });
        closeDialog?.();
        if (!cache.items) cache.items = [];
        const item = itemFromConversation(res.conversation);
        if (res.message) { item.last_message = lastMessageSummary(res.message); item.last_message_at = res.message.created_at; }
        upsertItem(item, { keepExisting: !res.message });
        if (postId) toast('Sent.');
        history.pushState({ dmFromList: true }, '', `/messages/${res.conversation.id}`);
        openConversation(res.conversation.id);
      } catch (err) {
        toastError(err);
        startBtn.disabled = false;
      }
    }

    dialog({
      title: postId ? 'Send post' : 'New message',
      actions: [],
      body: close => {
        closeDialog = close;
        return h('form.dm-picker', { onsubmit: e => { e.preventDefault(); start(); } },
          postId ? h('p', { style: 'margin:0 0 8px' }, 'Choose who to send this post to.') : null,
          h('label.field', { style: 'margin-bottom:6px' }, h('span', 'Add people'), input),
          chips, note, results, titleField,
          h('div.row', { style: 'justify-content:flex-end;margin-top:12px;gap:8px' },
            h('button', { type: 'button', onclick: () => close() }, 'Cancel'),
            startBtn));
      },
      onOpen: () => { input.focus(); search(); },
    });
  }

  // -- Wiring --

  renderList();
  openConversation(openId);
  refreshList();
  refreshStreaks();

  const listTimer = setInterval(() => {
    const listVisible = !(phoneQuery.matches && openId);
    if (document.visibilityState === 'visible' && listVisible) refreshList();
  }, POLL.list);

  const measure = () => {
    const top = panes.getBoundingClientRect().top + window.scrollY;
    root.style.setProperty('--dm-top', `${Math.max(0, Math.round(top))}px`);
  };
  const onViewport = () => {
    const vv = window.visualViewport;
    if (!vv) return;
    root.style.setProperty('--dm-vvh', `${Math.round(vv.height)}px`);
    root.style.setProperty('--dm-vvt', `${Math.round(vv.offsetTop)}px`);
  };
  const onPhoneChange = () => { setLayout(); lockScroll(); requestAnimationFrame(measure); };
  requestAnimationFrame(() => { measure(); onViewport(); });
  window.addEventListener('resize', measure);
  window.visualViewport?.addEventListener('resize', onViewport);
  window.visualViewport?.addEventListener('scroll', onViewport);
  phoneQuery.addEventListener('change', onPhoneChange);

  if (sharePost) setTimeout(() => newMessageDialog({ postId: sharePost }));

  ctx.cleanup(() => {
    chat?.destroy();
    clearInterval(listTimer);
    window.removeEventListener('resize', measure);
    window.visualViewport?.removeEventListener('resize', onViewport);
    window.visualViewport?.removeEventListener('scroll', onViewport);
    phoneQuery.removeEventListener('change', onPhoneChange);
    document.documentElement.classList.remove('dm-lock');
  });

  return root;
}

// -- One open conversation -----------------------------------------------

function conversationPane(id, { onBack, onMessage, onRead, onConversation, onStreak, onLeft }) {
  const controller = new AbortController();
  let conv = null;
  let server = []; // confirmed messages, oldest -> newest
  let pending = []; // optimistic sends not yet confirmed
  let next = null; // cursor for older messages
  let after = ''; // newest confirmed id, for polling
  let destroyed = false, ready = false, loadingOlder = false;
  let pollTimer = null, sending = 0, lastActivity = Date.now(), wantRead = false, tempSeq = 0;
  const rows = new Map();
  const localUrls = [];
  const streakNotes = []; // [{ afterId, text }]: "Streak extended to 13 days." after the message that did it

  const head = h('header.dm-head');
  const olderStatus = h('div.dm-older');
  const list = h('div.dm-msgs');
  const typing = h('div.dm-row.theirs.first.last.dm-typing.hidden', { 'aria-live': 'polite' },
    h('div.dm-av', supportAvatar()),
    h('div.dm-col', h('div.dm-bubble', h('em', 'Typing'))));
  const topSentinel = h('div.dm-sentinel');
  const scroller = h('div.dm-scroll', { role: 'log', 'aria-label': 'Messages', tabIndex: 0 }, topSentinel, olderStatus, list, typing);
  const jump = h('button.dm-jump.hidden', { type: 'button', onclick: () => { scrollToBottom(true); jump.classList.add('hidden'); } }, 'New messages');
  const composer = buildComposer();
  const el = h('div.dm-conv', head, h('div.dm-scroll-wrap', scroller, jump), composer.el);

  const backBtn = () => h('button.dm-back', { type: 'button', 'aria-label': 'Back to conversations', onclick: onBack }, 'Back');
  mount(head, backBtn(), h('span.dm-head-loading', 'Loading'));
  mount(list, loading());

  // -- Rendering --

  const all = () => [...server, ...pending];
  const mine = m => Boolean(m.sender && m.sender.id === me()?.id);
  const sameGroup = (a, b) => (a.sender?.id ?? null) === (b.sender?.id ?? null)
    && b.created_at - a.created_at < GROUP_GAP && dayKey(a.created_at) === dayKey(b.created_at);
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  const scrollToBottom = smooth => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });

  function renderHead() {
    let title, sub;
    const actions = [];
    if (conv.is_support) {
      title = h('h2.dm-title', 'Southbag Support');
      sub = 'Help with your account';
    } else if (!conv.is_group && conv.members[0]) {
      const p = conv.members[0];
      title = h('h2.dm-title', h('a', { href: `/@${p.handle}` }, p.name));
      sub = [`@${p.handle}`, conv.streak?.current ? [' ', streakLabel(conv.streak, 'dm-head-streak')] : null];
    } else {
      title = h('h2.dm-title', convTitle(conv));
      sub = `${conv.member_count} ${conv.member_count === 1 ? 'member' : 'members'}`;
    }
    if (!conv.is_support) {
      const more = h('button.dm-more', { type: 'button', 'aria-label': 'Conversation options' }, 'More');
      more.addEventListener('click', () => menu(more, conv.is_group ? [
        { label: 'Rename chat', onClick: rename },
        ...conv.members.map(p => ({ label: `${p.name} (@${p.handle})`, href: `/@${p.handle}` })),
        'divider',
        { label: 'Leave chat', onClick: leave },
      ] : [
        conv.members[0] ? { label: 'View profile', href: `/@${conv.members[0].handle}` } : null,
      ]));
      if (!conv.is_group && conv.members[0]) {
        actions.push(h('button.btn-small', { type: 'button', onclick: async () => {
          if (await sendMoneyDialog(conv.members[0])) { lastActivity = Date.now(); schedule(0); }
        } }, 'Send money'));
      }
      actions.push(more);
    }
    mount(head, backBtn(), h('div.dm-head-text', title, h('div.dm-head-sub', sub)), h('div.dm-head-actions', actions));
  }

  function mediaNode(m, onLoad) {
    if (m.kind === 'image') {
      const img = h('img', { src: m.url, alt: m.alt || 'Photo', width: m.width || undefined, height: m.height || undefined, decoding: 'async' });
      img.addEventListener('load', onLoad, { once: true });
      return h('a.dm-img', {
        href: m.url, 'aria-label': 'Open photo',
        onclick: e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); lightbox(m.url, m.alt); },
      }, img);
    }
    if (m.kind === 'video') {
      const v = videoEl(m, { preload: 'metadata' });
      v.addEventListener('loadedmetadata', onLoad, { once: true });
      return h('div.dm-video', v);
    }
    return h('audio', { src: m.url, controls: true, preload: 'none' });
  }

  function sharedPost(m) {
    const p = m.post;
    if (!p) return h('div.dm-post.unavailable', 'This post is unavailable.');
    const thumb = p.media?.[0];
    const still = thumb ? (thumb.kind === 'image' ? thumb.url : thumb.poster_url) : null;
    return h('a.dm-post', { href: postUrl(p) },
      h('span.dm-post-head', h('strong', p.author.name), h('span.muted', `@${p.author.handle}`)),
      p.title ? h('span.dm-post-title', p.title) : null,
      p.body ? h('span.dm-post-body', p.body) : null,
      still ? h('span.dm-post-thumb', h('img', { src: still, alt: '', loading: 'lazy' }), thumb.kind === 'video' ? h('span.dm-post-play', 'Video') : null) : null,
      h('span.dm-post-foot', p.kind === 'video' ? 'Watch video' : p.kind === 'short' ? 'Watch short' : 'View post'));
  }

  function rowFor(m) {
    const key = m._key || m.id;
    if (rows.has(key)) return rows.get(key);
    let row;
    if (!m.sender && !conv.is_support) {
      row = h('div.dm-note', { title: fullDate(m.created_at) }, m.body);
    } else {
      const own = mine(m);
      const wasNear = () => { if (atBottomOnLoad) scrollToBottom(); };
      const parts = [];
      if (m.payment) {
        parts.push(h('div.dm-payment',
          h('strong', money(m.payment.amount)),
          h('span.tiny', m.payment.sender_id === me()?.id ? 'Sent through Southbag Online Banking' : 'Received through Southbag Online Banking')));
      }
      if (m.media) parts.push(mediaNode(m.media, wasNear));
      if (m.post || m.post_unavailable) parts.push(sharedPost(m));
      else if (m.pending && m.payload?.post_id) parts.push(h('div.dm-post.unavailable', 'Sharing a post'));
      if (m.body) parts.push(h('div.dm-text', richText(m.body)));
      const bubble = h('div.dm-bubble', { class: { 'media-only': Boolean(m.media && !m.body && !m.post && !m.post_unavailable) } },
        h('span.sr-only', own ? 'You: ' : `${m.sender ? m.sender.name : 'Southbag Support'}: `), parts);
      const time = h('time.dm-time', { datetime: new Date(m.created_at).toISOString(), title: fullDate(m.created_at) }, clock(m.created_at));
      let status = null;
      if (m.failed) {
        status = h('div.dm-status.failed', `Not sent. ${m.error || ''} `,
          h('button.btn-small', { type: 'button', onclick: () => retry(m) }, 'Retry'), ' ',
          h('button.btn-small', { type: 'button', onclick: () => discard(m) }, 'Discard'));
      } else if (m.pending) status = h('div.dm-status', 'Sending');
      row = h('div.dm-row', { class: { mine: own, theirs: !own, pending: m.pending, failed: m.failed } },
        own ? null : h('div.dm-av', m.sender ? avatar(m.sender, { size: 'sm' }) : supportAvatar()),
        h('div.dm-col',
          !own && conv.is_group ? h('div.dm-name', m.sender?.name || 'Southbag') : null,
          h('div.dm-line', bubble, time),
          status));
    }
    rows.set(key, row);
    return row;
  }

  let atBottomOnLoad = true;
  const seenEl = h('div.dm-seen');

  function seenText(m) {
    if (conv.is_support) return '';
    const by = conv.members.filter(p => (conv.read?.[p.id] ?? 0) >= m.created_at);
    if (!by.length) return '';
    return conv.is_group ? `Seen by ${names(by, 4)}` : 'Seen';
  }

  function render() {
    const msgs = all();
    const out = [];
    const lastMine = [...server].reverse().find(mine);
    let prevDay = null;
    msgs.forEach((m, i) => {
      const day = dayKey(m.created_at);
      if (day !== prevDay) { out.push(h('div.dm-day', h('span', dayLabel(m.created_at)))); prevDay = day; }
      const row = rowFor(m);
      if (row.classList.contains('dm-row')) {
        const prev = msgs[i - 1], nxt = msgs[i + 1];
        row.classList.toggle('first', !prev || !sameGroup(prev, m));
        row.classList.toggle('last', !nxt || !sameGroup(m, nxt));
      }
      out.push(row);
      for (const note of streakNotes) if (note.afterId === m.id) out.push(h('div.dm-note.dm-streak-note', { role: 'status' }, note.text));
      if (m === lastMine && !pending.length) { seenEl.textContent = seenText(m); if (seenEl.textContent) out.push(seenEl); }
    });
    if (!msgs.length) out.push(h('div.dm-empty', h('p', 'No messages.')));
    list.replaceChildren(...out);
    mount(olderStatus, loadingOlder ? loading('Loading older messages')
      : !next && server.length ? h('p', 'Start of conversation.') : null);
  }

  /**
   * A new streak state from a send response or a poll. `extended` (the send response says so; for a
   * poll, today has just started counting) adds a line to the chat after `afterId`.
   */
  function updateStreak(next, afterId, extended) {
    if (!conv || conv.is_group || conv.is_support) return;
    const before = conv.streak || null;
    if (extended === undefined) extended = Boolean(next?.completed_today && !before?.completed_today);
    conv.streak = next ? { current: next.current, longest: next.longest, last_day: next.last_day, at_risk: next.at_risk, completed_today: next.completed_today } : null;
    if (extended && next && afterId) {
      streakNotes.push({ afterId, text: next.current > 1 ? `Streak extended to ${plural(next.current, 'day')}.` : 'Streak started.' });
    }
    if (!sameStreak(before, conv.streak) || extended) {
      renderHead();
      onStreak(conv.streak, { extended: Boolean(extended) });
    }
  }

  function addServer(items) {
    const known = new Set(server.map(m => m.id));
    const fresh = items.filter(m => !known.has(m.id));
    if (!fresh.length) return [];
    server = [...server, ...fresh].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const newest = server.at(-1).id;
    if (newest > after) after = newest;
    return fresh;
  }

  // -- Loading --

  async function load() {
    try {
      const data = await api.get(`messages/${id}`, {}, { signal: controller.signal });
      if (destroyed) return;
      conv = data.conversation;
      next = data.next;
      addServer(data.items);
      renderHead();
      render();
      onConversation(conv);
      scrollToBottom();
      ready = true;
      composer.enable(conv);
      if (!phoneQuery.matches) composer.focus();
      if (conv.last_message_at > conv.last_read_at) markRead();
      schedule();
    } catch (err) {
      if (err.name === 'AbortError' || destroyed) return;
      mount(head, backBtn(), h('div.dm-head-text', h('h2.dm-title', 'Conversation unavailable')));
      mount(list, h('div.dm-pad', errorBox(err)));
      composer.disable();
    }
  }

  async function loadOlder() {
    if (!ready || !next || loadingOlder || destroyed) return;
    loadingOlder = true;
    render();
    const fromBottom = scroller.scrollHeight - scroller.scrollTop;
    try {
      const data = await api.get(`messages/${id}`, { before: next }, { signal: controller.signal });
      if (destroyed) return;
      next = data.next;
      addServer(data.items);
    } catch (err) {
      if (err.name === 'AbortError') return;
      toastError(err);
    }
    loadingOlder = false;
    atBottomOnLoad = false;
    render();
    scroller.scrollTop = scroller.scrollHeight - fromBottom;
  }

  const olderObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) loadOlder();
  }, { root: scroller, rootMargin: '200px 0px 0px 0px' });
  olderObserver.observe(topSentinel);
  scroller.addEventListener('scroll', () => {
    atBottomOnLoad = nearBottom();
    if (atBottomOnLoad) jump.classList.add('hidden');
  }, { passive: true });

  // -- Polling (see POLL at the top for the budget) --

  function delay() {
    const idle = Date.now() - lastActivity;
    return idle < POLL.idleAfter ? POLL.fast : idle < POLL.veryIdleAfter ? POLL.slow : POLL.slowest;
  }

  function schedule(ms = delay()) {
    clearTimeout(pollTimer);
    if (destroyed || !conv || conv.is_support || document.visibilityState !== 'visible') return;
    pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    if (destroyed || !conv) return;
    if (sending) { schedule(1000); return; }
    let more = false;
    try {
      const data = await api.get(`messages/${id}/poll`, { after }, { signal: controller.signal });
      if (destroyed) return;
      const wasNear = nearBottom();
      const fresh = addServer(data.items);
      conv.read = data.read || conv.read;
      if ('streak' in data) {
        const had = streakNotes.length;
        updateStreak(data.streak, server.at(-1)?.id);
        if (streakNotes.length > had && !fresh.length) { render(); if (wasNear) scrollToBottom(true); }
      }
      if (data.title !== undefined && data.title !== conv.title && conv.is_group) { conv.title = data.title; renderHead(); onConversation(conv); }
      if (fresh.length) {
        lastActivity = Date.now();
        render();
        if (wasNear) scrollToBottom(true);
        else jump.classList.remove('hidden');
        const newest = fresh.at(-1);
        const theirs = fresh.some(m => !mine(m));
        if (theirs) markRead();
        onMessage(newest);
        // Someone joined, left or renamed: refresh the member list.
        if (fresh.some(m => !m.sender) && conv.is_group) refreshMeta();
      } else {
        // Read positions may have moved: repaint if "Seen" changed.
        const lastMine = [...server].reverse().find(mine);
        if (lastMine && !pending.length && seenText(lastMine) !== seenEl.textContent) render();
      }
      more = data.more;
    } catch (err) {
      if (err.name === 'AbortError' || destroyed) return;
      if (err.status === 404) {
        composer.disable('You are no longer in this conversation.');
        return;
      }
    }
    schedule(more ? 0 : undefined);
  }

  async function refreshMeta() {
    try {
      const data = await api.get(`messages/${id}`, { limit: 1 }, { signal: controller.signal });
      if (destroyed) return;
      conv = { ...conv, ...data.conversation };
      renderHead();
      onConversation(conv);
    } catch { /* not important */ }
  }

  async function markRead() {
    if (document.visibilityState !== 'visible') { wantRead = true; return; }
    wantRead = false;
    try {
      await api.post(`messages/${id}/read`);
      onRead();
    } catch { /* it'll be retried on the next message */ }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      if (wantRead) markRead();
      lastActivity = Date.now();
      schedule(0);
    } else clearTimeout(pollTimer);
  };
  document.addEventListener('visibilitychange', onVisibility);

  // -- Sending --

  async function sendPending(m) {
    m.pending = true; m.failed = false; m.error = '';
    rows.delete(m._key);
    render();
    sending++;
    lastActivity = Date.now();
    try {
      const res = await api.post(`messages/${id}`, m.payload);
      if (destroyed) return;
      pending = pending.filter(x => x !== m);
      rows.delete(m._key);
      const sent = res.message;
      if (m.localMedia && sent.media) sent.media = { ...sent.media, url: m.localMedia.url };
      addServer([sent]);
      if ('streak' in res) updateStreak(res.streak, sent.id, Boolean(res.streak?.extended));
      if (res.reply) {
        // Southbag Support: show "Typing" for a moment, then the reply.
        if (res.reply.id > after) after = res.reply.id;
        render();
        scrollToBottom(true);
        onMessage(sent);
        await typingPause();
        if (destroyed) return;
        addServer([res.reply]);
        render();
        scrollToBottom(true);
        onMessage(res.reply);
      } else {
        render();
        scrollToBottom(true);
        onMessage(sent);
      }
    } catch (err) {
      if (destroyed) return;
      m.pending = false; m.failed = true; m.error = err.status && err.status < 500 ? err.message : 'Check your connection and try again.';
      rows.delete(m._key);
      render();
      scrollToBottom(true);
    } finally {
      sending = Math.max(0, sending - 1);
    }
  }

  let typingCount = 0;
  function typingPause() {
    typingCount++;
    typing.classList.remove('hidden');
    scrollToBottom(true);
    return new Promise(resolve => setTimeout(() => {
      if (--typingCount <= 0) typing.classList.add('hidden');
      resolve();
    }, 900 + Math.random() * 600));
  }

  function retry(m) { sendPending(m); }
  function discard(m) {
    pending = pending.filter(x => x !== m);
    rows.delete(m._key);
    render();
  }

  function submit({ body, attachment }) {
    let text = body.trim();
    const link = text ? findPostLink(text) : null;
    if (link && text === link.match) text = '';
    const payload = { body: text || undefined, media_id: attachment?.media?.id, post_id: link?.id };
    if (!payload.body && !payload.media_id && !payload.post_id) return false;
    const m = {
      _key: `tmp-${++tempSeq}`, id: `~tmp-${tempSeq}`, pending: true, sender: me(), body: text,
      media: attachment ? { ...attachment.media, url: attachment.localUrl } : null,
      localMedia: attachment ? { url: attachment.localUrl } : null,
      post: null, post_unavailable: false, created_at: Date.now(), payload,
    };
    if (attachment) localUrls.push(attachment.localUrl);
    pending.push(m);
    sendPending(m);
    return true;
  }

  // -- Composer --

  function buildComposer() {
    let attachment = null; // { file, localUrl, kind, media, controller }
    const textarea = h('textarea.dm-input', { rows: 1, placeholder: 'Write a message', 'aria-label': 'Message', maxLength: MAX_MESSAGE, disabled: true });
    const counter = h('span.dm-counter.hidden');
    const preview = h('div.dm-attachment.hidden');
    const attachBtn = h('button.dm-attach', { type: 'button', title: 'Attach a photo or video', disabled: true }, 'Attach');
    const sendBtn = h('button.dm-send', { type: 'submit', disabled: true }, 'Send');
    const notice = h('div.dm-composer-note.hidden');
    const form = h('form.dm-composer', { onsubmit: e => { e.preventDefault(); send(); } },
      preview, notice,
      h('div.dm-composer-row', attachBtn, h('div.dm-input-wrap', textarea, counter), sendBtn));
    let enabled = false;

    const grow = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    };
    const update = () => {
      const len = [...textarea.value].length;
      counter.textContent = `${len}/${MAX_MESSAGE}`;
      counter.classList.toggle('hidden', len < MAX_MESSAGE - 200);
      counter.classList.toggle('over', len > MAX_MESSAGE);
      const uploading = attachment && !attachment.media;
      sendBtn.disabled = !enabled || uploading || (!textarea.value.trim() && !attachment);
    };

    function renderPreview() {
      if (!attachment) { preview.classList.add('hidden'); mount(preview); update(); return; }
      preview.classList.remove('hidden');
      const bar = h('div.progress-bar.dm-progress', h('div', { style: { width: `${Math.round((attachment.progress || 0) * 100)}%` } }));
      mount(preview,
        h('div.dm-attachment-thumb', attachment.kind === 'video'
          ? h('video', { src: attachment.localUrl, muted: true, playsInline: true, preload: 'metadata' })
          : h('img', { src: attachment.localUrl, alt: '' })),
        h('div.grow',
          h('div.dm-attachment-name', attachment.file.name || 'Photo'),
          attachment.media ? h('div.fine', 'Ready to send.') : h('div.fine', 'Uploading'),
          attachment.media ? null : bar),
        h('button.btn-small', { type: 'button', 'aria-label': 'Remove attachment', onclick: () => clearAttachment() }, 'Remove'));
      attachment.bar = bar.firstChild;
      update();
    }

    function clearAttachment({ keepUrl = false } = {}) {
      if (attachment && !attachment.media) attachment.controller.abort();
      if (attachment && !keepUrl) URL.revokeObjectURL(attachment.localUrl);
      attachment = null;
      renderPreview();
    }

    async function attachFile(file) {
      if (!file) return;
      if (!/^(image|video)\//.test(file.type)) { toast('Only photos and videos can be attached.', { error: true }); return; }
      clearAttachment();
      const a = { file, localUrl: URL.createObjectURL(file), kind: file.type.startsWith('video/') ? 'video' : 'image', media: null, progress: 0, controller: new AbortController() };
      attachment = a;
      renderPreview();
      try {
        const media = await uploadFile(file, {
          signal: a.controller.signal,
          onProgress: p => { a.progress = p; if (a.bar) a.bar.style.width = `${Math.round(p * 100)}%`; },
        });
        if (attachment !== a) return;
        a.media = media;
        renderPreview();
      } catch (err) {
        if (err.name === 'AbortError' || attachment !== a) return;
        toastError(err);
        clearAttachment();
      }
    }

    function send() {
      if (!enabled || (attachment && !attachment.media)) return;
      if ([...textarea.value].length > MAX_MESSAGE) { toast(`Messages are limited to ${MAX_MESSAGE} characters.`, { error: true }); return; }
      const sent = submit({ body: textarea.value, attachment });
      if (!sent) return;
      textarea.value = '';
      clearAttachment({ keepUrl: true });
      grow();
      update();
      textarea.focus();
    }

    textarea.addEventListener('input', () => { grow(); update(); lastActivity = Date.now(); });
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
    });
    textarea.addEventListener('paste', e => {
      const file = [...(e.clipboardData?.files || [])].find(f => /^(image|video)\//.test(f.type));
      if (file) { e.preventDefault(); attachFile(file); }
    });
    attachBtn.addEventListener('click', async () => attachFile((await pickFiles({ accept: 'image/*,video/*' }))[0]));

    return {
      el: form,
      focus: () => textarea.focus(),
      enable(c) {
        enabled = true;
        textarea.disabled = false;
        attachBtn.disabled = false;
        notice.classList.add('hidden');
        update();
      },
      disable(message) {
        enabled = false;
        textarea.disabled = true;
        attachBtn.disabled = true;
        if (message) { notice.textContent = message; notice.classList.remove('hidden'); }
        update();
      },
      destroy: () => { if (attachment) clearAttachment(); },
    };
  }

  // -- Group actions --

  async function rename() {
    const title = await promptDialog('Group name', { title: 'Rename chat', value: conv.title || '', placeholder: 'Group name', ok: 'Rename' });
    if (title === null) return;
    try {
      const data = await api.patch(`messages/${id}`, { title });
      conv = { ...conv, ...data.conversation };
      renderHead();
      onConversation(conv);
      toast('Renamed.');
      poll();
    } catch (err) { toastError(err); }
  }

  async function leave() {
    if (!(await confirm('You will stop receiving messages from this chat.', { title: 'Leave chat?', ok: 'Leave' }))) return;
    try {
      await api.del(`messages/${id}/members/me`);
      toast('Left the chat.');
      onLeft();
    } catch (err) { toastError(err); }
  }

  load();

  return {
    el,
    focus: () => composer.focus(),
    markRead,
    destroy() {
      destroyed = true;
      controller.abort();
      clearTimeout(pollTimer);
      olderObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      composer.destroy();
      for (const url of localUrls) URL.revokeObjectURL(url);
    },
  };
}
