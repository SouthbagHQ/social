// /activity - Activity log: your own actions, newest first.
//   GET /api/me/activity?before -> { items: [{ type, text, link, created_at }], next }

import { api } from '../api.js';
import { h } from '../dom.js';
import { fullDate, timeAgo } from '../format.js';
import { empty, infiniteList } from '../ui.js';

export default function activity(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Activity log');
  const list = infiniteList({
    signal: ctx.signal,
    load: before => api.get('me/activity', { before }, { signal: ctx.signal }),
    render: item => h('div.activity-row',
      h('span.grow', item.link ? h('a', { href: item.link }, item.text) : item.text),
      h('time.muted', { datetime: new Date(item.created_at).toISOString(), title: fullDate(item.created_at) }, timeAgo(item.created_at))),
    empty: empty({ title: 'No activity.' }),
    className: 'south-card activity-list',
  });
  return h('div.activity-page', h('h1', 'Activity log'), list);
}
