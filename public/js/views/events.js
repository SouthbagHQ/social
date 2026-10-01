// /events and /events/:eventId - events (Facebook / Meetup style).
//   /events?tab=upcoming|going|hosting|past   list, soonest first (past: latest first)
//   /events?group=<slug>                      a group's upcoming events
//   /events?new=1[&group=<slug>]              create form
//   /events/:eventId[?edit=1]                 event page (or its edit form)
// API: GET|POST /api/events, GET|PATCH|DELETE /api/events/:id, PUT|DELETE /:id/rsvp, GET /:id/attendees,
//      POST /:id/invite, GET|POST /:id/comments, DELETE /:id/comments/:cid, GET /:id/calendar.ics

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { count, fullDate, timeAgo } from '../format.js';
import { navigate, refresh } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, infiniteList, loading, refuseDelete, share, tabs, toast, toastError } from '../ui.js';
import { pickFiles, uploadFile } from '../upload.js';
import { avatar, userName, userRow } from '../components/user.js';

const LIST_TABS = [
  ['upcoming', 'Upcoming', 'No upcoming events.'],
  ['going', 'Going', 'You are not going to any events.'],
  ['hosting', 'Hosting', 'You are not hosting any events.'],
  ['past', 'Past', 'No past events.'],
];

export const PRIVACY = {
  public: { label: 'Public', text: 'Anyone can see this event.' },
  friends: { label: 'Friends', text: 'Friends of the host can see this event.' },
  group: { label: 'Group members', text: 'Members of the group can see this event.' },
  invite: { label: 'Invite only', text: 'Only people who are invited can see this event.' },
};

const RSVP_LABELS = { going: 'Going', interested: 'Interested', declined: 'Not going' };
const OPEN_ENDED_MS = 3 * 3600000;

// ── Dates (Australian formats, in the event's own time zone) ─────────────

function parts(ms, timeZone, options) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-AU', { timeZone, ...options }); } catch { fmt = new Intl.DateTimeFormat('en-AU', options); }
  return Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
}

/** "SAT 12 OCT" */
export function dateBlock(ms, timeZone) {
  const p = parts(ms, timeZone, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${p.weekday} ${p.day} ${p.month}`.toUpperCase();
}

const clock = (ms, tz) => {
  const p = parts(ms, tz, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.hour}:${p.minute} ${(p.dayPeriod || '').toLowerCase()}`.trim();
};
const dayKey = (ms, tz) => { const p = parts(ms, tz, { year: 'numeric', month: 'numeric', day: 'numeric' }); return `${p.year}-${p.month}-${p.day}`; };
const zoneName = (ms, tz) => parts(ms, tz, { timeZoneName: 'short' }).timeZoneName || tz;
const longDay = (ms, tz) => {
  const p = parts(ms, tz, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
};
const shortDay = (ms, tz) => {
  const p = parts(ms, tz, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${p.weekday} ${p.day} ${p.month}`;
};

/** "6:30 pm to 9:00 pm AEDT" (same day) or "Sat 12 Oct, 6:30 pm to Sun 13 Oct, 2:00 am AEDT". */
export function timeRange(e) {
  const tz = e.timezone;
  const zone = zoneName(e.starts_at, tz);
  if (!e.ends_at) return `${clock(e.starts_at, tz)} ${zone}`;
  if (dayKey(e.starts_at, tz) === dayKey(e.ends_at, tz)) return `${clock(e.starts_at, tz)} to ${clock(e.ends_at, tz)} ${zone}`;
  return `${shortDay(e.starts_at, tz)}, ${clock(e.starts_at, tz)} to ${shortDay(e.ends_at, tz)}, ${clock(e.ends_at, tz)} ${zone}`;
}

const whereText = e => e.location_name || e.location_address || (e.online_url ? 'Online' : 'Location to be confirmed');
const hasEnded = e => (e.ends_at ?? e.starts_at + OPEN_ENDED_MS) < Date.now();
const goingText = e => `${count(e.going_count)} going${e.interested_count ? `, ${count(e.interested_count)} interested` : ''}`;

/** A fixed 16:9 box; the cover is stretched to fill it. Plain grey without one. */
export const eventCover = (e, tag = 'div.event-cover') => h(tag, e.cover_url ? h('img', { src: e.cover_url, alt: '', loading: 'lazy' }) : null);

function statusChip(e) {
  if (e.cancelled) return h('span.chip', 'Cancelled');
  if (e.viewer_rsvp === 'going') return h('span.chip.teal', 'Going');
  if (e.viewer_rsvp === 'interested') return h('span.chip', 'Interested');
  if (e.viewer_invited && !e.viewer_rsvp) return h('span.chip', 'Invited');
  if (e.is_full) return h('span.chip', 'Full');
  return null;
}

/** An event as a row: cover, date block, title, time, place, attendance. */
export function eventRow(e) {
  return h('a.south-item.event-row', { href: `/events/${e.id}`, class: { cancelled: e.cancelled } },
    eventCover(e),
    h('div.event-row-body',
      h('p.event-date', dateBlock(e.starts_at, e.timezone)),
      h('strong.event-row-title', e.title),
      h('p.event-row-line', timeRange(e)),
      h('p.event-row-line', whereText(e)),
      h('p.event-row-line.muted', goingText(e), e.group ? `, ${e.group.name}` : ''),
      statusChip(e)));
}

// ── Router entry ─────────────────────────────────────────────────────────

export default async function eventsView(ctx) {
  if (ctx.params.eventId) {
    if (ctx.query.get('edit') === '1') return editView(ctx);
    return eventView(ctx);
  }
  if (ctx.query.get('new') === '1') return formView(ctx, null);
  return listView(ctx);
}

// ── List ─────────────────────────────────────────────────────────────────

async function listView(ctx) {
  const signedIn = Boolean(ctx.me);
  const groupSlug = ctx.query.get('group') || '';
  const requested = ctx.query.get('tab');
  const tab = signedIn && !groupSlug && LIST_TABS.some(([k]) => k === requested) ? requested : 'upcoming';
  let group = null;
  if (groupSlug) {
    try { group = (await api.get(`groups/${encodeURIComponent(groupSlug)}`, null, { signal: ctx.signal })).group; } catch (err) {
      if (err.status !== 404) throw err;
    }
    if (!group) {
      ctx.title('Group not found');
      return h('div.south-card.flat', empty({ title: 'Group not found.', action: h('a.btn-small', { href: '/events' }, 'All events') }));
    }
  }
  ctx.title(group ? `Events in ${group.name}` : 'Events');
  const emptyText = group ? 'No upcoming events.' : LIST_TABS.find(([k]) => k === tab)[2];
  const canCreateHere = signedIn && (!group || ['owner', 'admin', 'member'].includes(group.role));
  const newHref = group ? `/events?new=1&group=${encodeURIComponent(group.slug)}` : '/events?new=1';

  const list = infiniteList({
    className: 'event-list',
    signal: ctx.signal,
    load: cursor => api.get('events', { tab, group: groupSlug, cursor }, { signal: ctx.signal }),
    render: eventRow,
    empty: empty({ title: emptyText, action: canCreateHere && tab !== 'past' ? h('a.btn-small', { href: newHref }, 'Create event') : null }),
  });

  return h('div.events-page',
    h('div.page-head',
      h('h1', group ? 'Events' : 'Events'),
      h('span.spacer'),
      canCreateHere ? h('a.btn', { href: newHref }, 'Create event') : null),
    group ? h('p.events-sub', 'Upcoming events in ', h('a', { href: `/g/${group.slug}` }, group.name), '. ', h('a', { href: '/events' }, 'All events')) : null,
    signedIn && !group ? tabs(LIST_TABS.map(([key, label]) => ({ href: key === 'upcoming' ? '/events' : `/events?tab=${key}`, label, current: key === tab }))) : null,
    list);
}

// ── One event ────────────────────────────────────────────────────────────

async function loadEvent(ctx) {
  try {
    return await api.get(`events/${encodeURIComponent(ctx.params.eventId)}`, null, { signal: ctx.signal });
  } catch (err) {
    if (err.status !== 404) throw err;
    return null;
  }
}

const notFound = ctx => {
  ctx.title('Event not found');
  return h('div.south-card.flat', empty({ title: 'Event not found.', action: h('a.btn-small', { href: '/events' }, 'Back to events') }));
};

async function eventView(ctx) {
  const data = await loadEvent(ctx);
  if (!data) return notFound(ctx);
  const { event, viewer } = data;
  ctx.title(event.title);
  const ended = hasEnded(event);
  const tz = event.timezone;

  // RSVP buttons: the current choice is shown pressed.
  const rsvpArea = h('div.event-rsvp');
  const counts = h('p.event-counts');
  let rsvp = viewer.rsvp;
  const paintCounts = () => {
    counts.textContent = goingText(event) + (event.capacity ? `. ${count(Math.max(0, event.capacity - event.going_count))} of ${count(event.capacity)} places left.` : '.');
  };
  const paintRsvp = () => {
    if (event.cancelled) return mount(rsvpArea, h('p.event-state', 'This event was cancelled.'));
    if (ended) return mount(rsvpArea, h('p.event-state', rsvp === 'going' ? 'This event has ended. You went.' : 'This event has ended.'));
    mount(rsvpArea,
      Object.entries(RSVP_LABELS).map(([status, label]) => h('button.icon-btn.event-rsvp-btn', {
        type: 'button', 'aria-pressed': rsvp === status ? 'true' : 'false', onclick: () => reply(status),
      }, label)),
      rsvp ? h('span.fine', rsvp === 'going' ? 'You are going.' : rsvp === 'interested' ? 'You are interested.' : 'You are not going.') : null);
  };
  async function reply(status) {
    if (!store.me) return login();
    const clear = rsvp === status;
    try {
      const res = clear ? await api.del(`events/${event.id}/rsvp`) : await api.put(`events/${event.id}/rsvp`, { status });
      rsvp = res.rsvp;
      event.going_count = res.going_count;
      event.interested_count = res.interested_count;
      paintRsvp();
      paintCounts();
      if (!clear && status === 'going') toast('You are going.');
    } catch (err) {
      toastError(err);
    }
  }
  paintRsvp();
  paintCounts();

  // Other actions
  const actions = h('div.event-actions.row.wrap',
    viewer.can_invite ? h('button.btn-small', { type: 'button', onclick: () => inviteDialog(event) }, 'Invite') : null,
    h('a.btn-small', { href: `/api/events/${event.id}/calendar.ics`, download: '' }, 'Add to calendar'),
    h('button.btn-small', { type: 'button', onclick: () => share(`/events/${event.id}`, event.title) }, 'Share'),
    viewer.can_edit ? h('a.btn-small', { href: `/events/${event.id}?edit=1` }, 'Edit') : null,
    viewer.can_cancel ? h('button.btn-small', { type: 'button', onclick: cancelEvent }, 'Cancel event') : null);

  async function cancelEvent() {
    const ok = await confirm('Everyone who replied going or interested will be told.', { title: 'Cancel event?', ok: 'Cancel event', cancel: 'Keep event' });
    if (!ok) return;
    try {
      await api.del(`events/${event.id}`);
      toast('Event cancelled.');
      refresh();
    } catch (err) { toastError(err); }
  }

  // Facts
  const fact = (label, ...value) => h('div.event-fact', h('dt', label), h('dd', ...value));
  const sameDay = !event.ends_at || dayKey(event.starts_at, tz) === dayKey(event.ends_at, tz);
  const when = sameDay
    ? `${longDay(event.starts_at, tz)}, ${timeRange(event)}`
    : `${longDay(event.starts_at, tz)}, ${clock(event.starts_at, tz)} to ${longDay(event.ends_at, tz)}, ${clock(event.ends_at, tz)} ${zoneName(event.starts_at, tz)}`;
  const place = [];
  if (event.location_name) place.push(h('div', event.location_name));
  if (event.location_address) place.push(h('div.muted', event.location_address));
  const facts = h('dl.event-facts',
    fact('When', h('div', when), h('div.fine', `Time zone: ${tz}`)),
    place.length ? fact('Where', place) : null,
    event.online_url ? fact('Online', h('a.event-link', { href: event.online_url, target: '_blank', rel: 'noopener noreferrer' }, event.online_url)) : null,
    !place.length && !event.online_url ? fact('Where', 'Location to be confirmed.') : null,
    fact(event.hosts.length > 1 ? 'Hosts' : 'Host', h('div.event-hosts', event.hosts.map(u => h('span.event-host', avatar(u, { size: 'xs' }), userName(u, { handle: false }))))),
    event.group ? fact('Group', h('a', { href: `/g/${event.group.slug}` }, event.group.name)) : null,
    fact('Privacy', PRIVACY[event.privacy]?.label || event.privacy),
    fact('Capacity', event.capacity ? `${count(event.capacity)} people` : 'No limit'),
  );

  // Tabs
  const body = h('div.event-tab-body');
  const tabBar = h('div');
  let current = 'about';
  const paintTabs = () => mount(tabBar, tabs([
    ['about', 'About'], ['discussion', `Discussion${event.comment_count ? ` (${count(event.comment_count)})` : ''}`], ['attendees', 'Attendees'],
  ].map(([key, label]) => ({ label, selected: key === current, onClick: () => { current = key; paintTabs(); paintBody(); } }))));
  const paintBody = () => mount(body,
    current === 'discussion' ? discussionTab(ctx, event, () => paintTabs())
      : current === 'attendees' ? attendeesTab(ctx, event, viewer)
        : aboutTab(event));
  paintTabs();
  paintBody();

  return h('div.event-page',
    h('article.south-card.flat.event-head',
      event.cancelled ? h('div.notice', 'This event was cancelled.') : null,
      eventCover(event, 'div.event-cover.large'),
      h('p.event-date', dateBlock(event.starts_at, tz)),
      h('h1.event-title', event.title),
      h('p.event-when', timeRange(event)),
      h('p.event-where', whereText(event)),
      counts,
      rsvpArea,
      actions),
    h('section.south-card.flat.event-details', facts),
    h('section.south-card.flat', tabBar, body));
}

function aboutTab(event) {
  return h('div.event-about',
    event.description ? h('p.event-description', event.description) : h('p.muted', 'No description.'),
    event.attendees.length ? h('div.event-faces',
      h('p.fine', 'Going'),
      h('div.row.wrap', event.attendees.map(u => avatar(u, { size: 'sm' })))) : null);
}

function discussionTab(ctx, event, onCount) {
  let list;
  const text = h('textarea.textarea', { rows: 3, maxLength: 2000, placeholder: 'Write a comment', 'aria-label': 'Comment' });
  const post = h('button.btn', { type: 'submit' }, 'Post');
  const form = store.me
    ? h('form.event-comment-form', { onsubmit: async e => {
      e.preventDefault();
      if (!text.value.trim()) return;
      post.disabled = true;
      try {
        const { comment } = await api.post(`events/${event.id}/comments`, { body: text.value });
        text.value = '';
        event.comment_count++;
        onCount();
        list.prepend(commentItem(comment));
        toast('Posted.');
      } catch (err) { toastError(err); }
      post.disabled = false;
    } }, text, h('div.row', h('span.spacer.grow'), post))
    : h('p', h('button.btn-small', { type: 'button', onclick: () => login() }, 'Log in'), ' to comment.');

  const commentItem = c => {
    const el = h('div.event-comment',
      avatar(c.author, { size: 'sm' }),
      h('div.grow',
        h('div.row.wrap', userName(c.author), h('time.fine', { datetime: new Date(c.created_at).toISOString(), title: fullDate(c.created_at) }, timeAgo(c.created_at))),
        h('p.event-comment-body', c.body),
        c.can_delete ? h('button.btn-tiny', { type: 'button', onclick: refuseDelete }, 'Delete') : null));
    return el;
  };
  list = infiniteList({
    className: 'event-comments',
    signal: ctx.signal,
    load: cursor => api.get(`events/${event.id}/comments`, { cursor }, { signal: ctx.signal }),
    render: commentItem,
    empty: empty({ title: 'No comments yet.' }),
  });
  return h('div', form, list);
}

function attendeesTab(ctx, event, viewer) {
  const choices = [['going', 'Going'], ['interested', 'Interested']];
  if (viewer.role) choices.push(['declined', 'Not going']);
  let status = 'going';
  const bar = h('div');
  const holder = h('div');
  const paint = () => {
    mount(bar, tabs(choices.map(([key, label]) => ({ label, selected: key === status, onClick: () => { status = key; paint(); } }))));
    mount(holder, infiniteList({
      className: 'event-attendees',
      signal: ctx.signal,
      load: cursor => api.get(`events/${event.id}/attendees`, { status, cursor }, { signal: ctx.signal }),
      render: a => userRow(a.user, { action: null, bio: false }),
      empty: empty({ title: status === 'going' ? 'No one is going yet.' : status === 'interested' ? 'No one is interested yet.' : 'No one has declined.' }),
    }));
  };
  paint();
  return h('div', bar, holder);
}

async function inviteDialog(event) {
  const picked = new Set();
  const friendList = h('div.event-invite-list', loading());
  const typed = h('input.input', { placeholder: 'Separated by commas', 'aria-label': 'Usernames' });
  api.get('users/me/friends', { limit: 50 }).then(({ items }) => {
    mount(friendList, items.length ? items.map(u => h('label.checkbox',
      h('input', { type: 'checkbox', onchange: e => { if (e.target.checked) picked.add(u.handle); else picked.delete(u.handle); } }),
      avatar(u, { size: 'xs', link: false }), h('span', u.name, h('span.muted', ` @${u.handle}`))))
      : h('p.muted', 'No friends to show.'));
  }).catch(() => mount(friendList, h('p.muted', 'Could not load friends.')));
  const ok = await dialog({
    title: 'Invite',
    body: h('div',
      h('p.fine', 'Friends'),
      friendList,
      h('label.field', h('span', 'Usernames'), typed)),
    actions: [{ label: 'Cancel', value: false }, { label: 'Send invites', value: true, primary: true }],
  });
  if (!ok) return;
  const handles = [...picked, ...typed.value.split(/[\s,]+/).map(s => s.replace(/^@/, '').trim()).filter(Boolean)];
  if (!handles.length) return toast('Choose someone to invite.');
  try {
    const { invited, already } = await api.post(`events/${event.id}/invite`, { handles });
    if (invited.length) toast(`Invited ${invited.length === 1 ? `@${invited[0]}` : `${invited.length} people`}.`);
    else if (already.length) toast('Already invited.');
  } catch (err) { toastError(err); }
}

// ── Create and edit ──────────────────────────────────────────────────────

async function editView(ctx) {
  const data = await loadEvent(ctx);
  if (!data) return notFound(ctx);
  if (!data.viewer.can_edit) {
    ctx.title(data.event.title);
    return h('div.south-card.flat', empty({ title: 'Only hosts can edit this event.', action: h('a.btn-small', { href: `/events/${data.event.id}` }, 'Back') }));
  }
  return formView(ctx, data);
}

/** ms -> "YYYY-MM-DDTHH:MM" in the browser's time zone (for datetime-local inputs). */
const toLocalInput = ms => (ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromLocalInput = value => (value ? new Date(value).getTime() : null);

/** A 16:9 picture box that uploads straight away. `.value` is a media id, null (removed) or undefined (untouched). */
function coverField(current) {
  let value;
  const preview = h('div.event-cover');
  const progress = h('div.progress-bar', { hidden: true }, h('div'));
  const remove = h('button.btn-small', { type: 'button', onclick: () => { value = null; paint(null); } }, 'Remove');
  const paint = url => {
    mount(preview, url ? h('img', { src: url, alt: '' }) : h('span.event-cover-empty', 'No cover'));
    remove.hidden = !url;
  };
  const field = h('div.field.event-cover-field',
    h('span', 'Cover (optional)'),
    preview,
    progress,
    h('div.row.wrap',
      h('button.btn-small', { type: 'button', onclick: async () => {
        const [file] = await pickFiles({ accept: 'image/*' });
        if (!file) return;
        paint(URL.createObjectURL(file));
        field.busy = true;
        progress.hidden = false;
        try {
          const media = await uploadFile(file, { maxEdge: 1920, onProgress: p => { progress.firstChild.style.width = `${Math.round(p * 100)}%`; } });
          value = media.id;
        } catch (err) {
          toastError(err);
          paint(current);
        }
        field.busy = false;
        progress.hidden = true;
      } }, 'Upload'),
      remove),
    h('small.fine', 'Shown wide (16:9).'));
  paint(current);
  Object.defineProperty(field, 'value', { get: () => value });
  field.busy = false;
  return field;
}

async function formView(ctx, data) {
  const editing = Boolean(data);
  const event = data?.event;
  ctx.title(editing ? 'Edit event' : 'Create event');
  if (!ctx.requireAuth()) return null;
  const isMainHost = !editing || data.viewer.role === 'host';
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney';

  // Default start: tomorrow at 6 pm, for two hours.
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(18, 0, 0, 0);

  const title = h('input.input', { maxLength: 100, required: true, value: event?.title || '', placeholder: 'Event name', autocomplete: 'off' });
  const description = h('textarea.textarea', { rows: 5, maxLength: 5000, placeholder: 'What is happening?' }, event?.description || '');
  const startsAt = h('input.input', { type: 'datetime-local', required: true, value: toLocalInput(event?.starts_at ?? start.getTime()) });
  const endsAt = h('input.input', { type: 'datetime-local', value: toLocalInput(event ? event.ends_at : start.getTime() + 2 * 3600000) });
  const locationName = h('input.input', { maxLength: 120, value: event?.location_name || '', placeholder: 'Place name' });
  const locationAddress = h('input.input', { maxLength: 200, value: event?.location_address || '', placeholder: 'Street address' });
  const onlineUrl = h('input.input', { type: 'url', maxLength: 500, value: event?.online_url || '', placeholder: 'https://' });
  const capacity = h('input.input', { type: 'number', min: 1, max: 100000, step: 1, value: event?.capacity ?? '', placeholder: 'No limit' });
  const cohosts = h('input.input', { value: (event?.hosts || []).slice(1).map(u => u.handle).join(', '), placeholder: 'Usernames, separated by commas' });
  const cover = coverField(event?.cover_url || null);

  const privacy = h('select.select', { 'aria-label': 'Privacy' });
  const privacyNote = h('small.fine');
  const groupSelect = h('select.select', { disabled: editing, 'aria-label': 'Group' }, h('option', { value: '' }, 'No group'));
  let groups = [];
  const wantGroup = event?.group?.slug || ctx.query.get('group') || '';
  if (editing) {
    if (event.group) groupSelect.append(h('option', { value: event.group.id, selected: true }, event.group.name));
  } else {
    try {
      groups = (await api.get('groups', { tab: 'mine', limit: 50 }, { signal: ctx.signal })).items.filter(g => g.role && g.role !== 'pending');
    } catch (err) { if (err.name === 'AbortError') throw err; }
    for (const g of groups) groupSelect.append(h('option', { value: g.id, selected: g.slug === wantGroup }, g.name));
  }
  const paintPrivacy = () => {
    const selected = privacy.value || event?.privacy || (groupSelect.value ? 'group' : 'public');
    const hasGroup = Boolean(groupSelect.value);
    const groupPrivate = groups.find(g => g.id === groupSelect.value)?.privacy === 'private';
    mount(privacy, Object.entries(PRIVACY)
      .filter(([key]) => (key !== 'group' || hasGroup) && !(key === 'public' && groupPrivate))
      .map(([key, p]) => h('option', { value: key, selected: key === selected }, p.label)));
    if (!privacy.value) privacy.value = hasGroup ? 'group' : 'public';
    privacyNote.textContent = PRIVACY[privacy.value]?.text || '';
  };
  privacy.addEventListener('change', paintPrivacy);
  groupSelect.addEventListener('change', () => { privacy.value = groupSelect.value ? 'group' : 'public'; paintPrivacy(); });
  paintPrivacy();

  const submit = h('button.btn-large', { type: 'submit' }, editing ? 'Save' : 'Create event');
  const form = h('form.south-card.event-form', { onsubmit: async e => {
    e.preventDefault();
    if (cover.busy) return toast('Wait for the upload to finish.');
    const payload = {
      title: title.value,
      description: description.value,
      starts_at: fromLocalInput(startsAt.value),
      ends_at: fromLocalInput(endsAt.value),
      timezone: localZone,
      location_name: locationName.value,
      location_address: locationAddress.value,
      online_url: onlineUrl.value,
      privacy: privacy.value,
      capacity: capacity.value ? Number(capacity.value) : null,
    };
    if (!payload.starts_at) return toast('Enter a start time.', { error: true });
    if (cover.value !== undefined) payload.cover_media_id = cover.value;
    if (isMainHost) payload.cohosts = cohosts.value.split(/[\s,]+/).map(s => s.replace(/^@/, '').trim()).filter(Boolean);
    if (!editing && groupSelect.value) payload.group_id = groupSelect.value;
    submit.disabled = true;
    try {
      const res = editing ? await api.patch(`events/${event.id}`, payload) : await api.post('events', payload);
      toast(editing ? 'Saved.' : 'Event created.');
      navigate(`/events/${res.event.id}`, { replace: editing });
    } catch (err) {
      toastError(err);
      submit.disabled = false;
    }
  } },
    h('h1', editing ? 'Edit event' : 'Create event'),
    h('label.field', h('span', 'Title'), title),
    h('label.field', h('span', 'Description'), description),
    h('div.event-form-pair',
      h('label.field', h('span', 'Starts'), startsAt),
      h('label.field', h('span', 'Ends (optional)'), endsAt)),
    h('p.fine', `Times are in your time zone (${localZone}).`),
    h('label.field', h('span', 'Place'), locationName),
    h('label.field', h('span', 'Address'), locationAddress),
    h('label.field', h('span', 'Online link'), onlineUrl, h('small.fine', 'For online events. Leave blank otherwise.')),
    cover,
    h('label.field', h('span', 'Group'), groupSelect, editing ? h('small.fine', 'The group cannot be changed.') : null),
    h('label.field', h('span', 'Privacy'), privacy, privacyNote),
    h('label.field', h('span', 'Capacity'), capacity, h('small.fine', 'Leave blank for no limit.')),
    isMainHost ? h('label.field', h('span', 'Co-hosts'), cohosts, h('small.fine', 'Co-hosts can edit the event and invite people.')) : null,
    h('div.row.wrap', submit, h('a.btn', { href: editing ? `/events/${event.id}` : '/events' }, 'Cancel')));

  if (!editing) setTimeout(() => title.focus(), 50);
  return h('div.event-form-page', form);
}
