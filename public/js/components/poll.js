// Polls on post cards (Twitter/Facebook style) and the poll editor used by the composer.
//
//   pollView(post)        → Node | null   the poll on a card: option buttons while open and not voted,
//                                           otherwise bars with percentages and counts
//   pollEditor({ onChange }) → Node with .value() → { options, duration_hours, multiple } and .reset()
//
//   POST /api/polls/:id/vote { option_ids } → { post }, DELETE /api/polls/:id/vote → { post }

import { api } from '../api.js';
import { h } from '../dom.js';
import { count, plural } from '../format.js';
import { login, store } from '../store.js';
import { toastError } from '../ui.js';

export const POLL_MAX_OPTIONS = 4;
export const POLL_OPTION_MAX = 25;
export const POLL_DURATIONS = [[1, '1 hour'], [24, '1 day'], [72, '3 days'], [168, '7 days']];

/** "Closes in 2 days", "Closes in 5 hours", "Closes in 12 minutes". */
export function closesIn(ms) {
  const left = ms - Date.now();
  const hour = 3600000, day = 24 * hour;
  if (left >= day - hour / 2) return `Closes in ${plural(Math.max(1, Math.round(left / day)), 'day')}`;
  if (left >= hour - 30000) return `Closes in ${plural(Math.max(1, Math.round(left / hour)), 'hour')}`;
  if (left > 60000) return `Closes in ${plural(Math.ceil(left / 60000), 'minute')}`;
  return 'Closes soon';
}

const percent = (votes, total) => (total ? Math.round((votes / total) * 100) : 0);

/** Re-renders every poll showing this post. */
function repaint(post) {
  document.querySelectorAll(`.poll[data-poll-id="${post.id}"]`).forEach(el => el.replaceWith(pollView(post)));
}

async function send(post, el, request) {
  if (!store.me) return login();
  el.classList.add('busy');
  el.querySelectorAll('button, input').forEach(b => { b.disabled = true; });
  try {
    const { post: fresh } = await request();
    post.poll = fresh.poll;
  } catch (err) {
    if (err.status === 409) post.poll.closed = true;
    toastError(err);
  }
  repaint(post);
}

const vote = (post, el, ids) => send(post, el, () => api.post(`polls/${post.id}/vote`, { option_ids: ids }));
const unvote = (post, el) => send(post, el, () => api.del(`polls/${post.id}/vote`));

export function pollView(post) {
  const poll = post.poll;
  if (!poll) return null;
  const voted = poll.viewer_votes.length > 0;
  const mine = Boolean(post.viewer?.can_edit);
  const showResults = poll.closed || voted || mine;
  const el = h('div.poll', { dataset: { pollId: post.id }, class: { closed: poll.closed } });

  if (showResults) {
    const top = Math.max(...poll.options.map(o => o.votes));
    el.append(h('div.poll-results', poll.options.map(o => {
      const pct = percent(o.votes, poll.total);
      const chosen = poll.viewer_votes.includes(o.id);
      return h('div.poll-result', { class: { leading: poll.closed && o.votes > 0 && o.votes === top } },
        h('div.poll-result-head',
          h('span.poll-label', o.label, chosen ? h('span.poll-yours', ' (your vote)') : null),
          h('span.poll-pct', `${pct}%`)),
        h('div.poll-track', { role: 'img', 'aria-label': `${o.label}: ${pct}%, ${plural(o.votes, 'vote')}` },
          h('div.poll-fill', { style: { width: `${pct}%` } })),
        h('div.poll-count', plural(o.votes, 'vote')));
    })));
  } else if (poll.multiple) {
    const checks = poll.options.map(o => ({ id: o.id, input: h('input', { type: 'checkbox', value: o.id }) }));
    const submit = h('button.btn-small', { type: 'button', disabled: true }, 'Vote');
    const sync = () => { submit.disabled = !checks.some(c => c.input.checked); };
    checks.forEach(c => c.input.addEventListener('change', sync));
    submit.addEventListener('click', e => {
      e.stopPropagation();
      vote(post, el, checks.filter(c => c.input.checked).map(c => c.id));
    });
    el.append(
      h('div.poll-choices', poll.options.map((o, i) => h('label.checkbox.poll-check', checks[i].input, h('span', o.label)))),
      h('div.poll-submit', submit));
  } else {
    el.append(h('div.poll-choices', poll.options.map(o =>
      h('button.poll-choice', { type: 'button', onclick: e => { e.stopPropagation(); vote(post, el, [o.id]); } }, o.label))));
  }

  el.append(h('div.poll-foot',
    h('span', poll.multiple ? `${plural(poll.total, 'person', 'people')} voted` : plural(poll.total, 'vote')),
    poll.multiple ? h('span', 'Multiple answers') : null,
    h('span', poll.closed ? 'Final results' : closesIn(poll.closes_at)),
    voted && !poll.closed
      ? h('button.btn-small', { type: 'button', onclick: e => { e.stopPropagation(); unvote(post, el); } }, 'Undo vote')
      : null));
  return el;
}

/** A short line for quotes and other compact places. */
export const pollSummary = post => post.poll
  ? h('div.poll-summary.fine', `Poll, ${count(post.poll.total)} ${post.poll.total === 1 ? 'vote' : 'votes'}${post.poll.closed ? ', final results' : ''}`)
  : null;

/** Option inputs, length and "Allow multiple answers" for the composer. */
export function pollEditor({ onChange } = {}) {
  let values = ['', ''];
  const list = h('div.poll-editor-options');
  const add = h('button.btn-small', { type: 'button' }, 'Add option');
  const length = h('select.select', { 'aria-label': 'Poll length' },
    POLL_DURATIONS.map(([hours, label]) => h('option', { value: String(hours), selected: hours === 24 }, label)));
  const multiple = h('input', { type: 'checkbox' });

  const render = focusIndex => {
    list.replaceChildren(...values.map((value, i) => {
      const input = h('input.input', {
        value, maxLength: POLL_OPTION_MAX, placeholder: `Option ${i + 1}`, 'aria-label': `Option ${i + 1}`,
        oninput: e => { values[i] = e.target.value; onChange?.(); },
      });
      return h('div.poll-editor-option', input,
        values.length > 2
          ? h('button.btn-small', { type: 'button', onclick: () => { values.splice(i, 1); render(); onChange?.(); } }, 'Remove')
          : null);
    }));
    add.classList.toggle('hidden', values.length >= POLL_MAX_OPTIONS);
    if (focusIndex !== undefined) list.querySelectorAll('input')[focusIndex]?.focus();
  };
  add.addEventListener('click', () => {
    if (values.length >= POLL_MAX_OPTIONS) return;
    values.push('');
    render(values.length - 1);
    onChange?.();
  });

  const el = h('div.poll-editor',
    list,
    add,
    h('div.poll-editor-settings',
      h('label.poll-editor-length', h('span', 'Poll length'), length),
      h('label.checkbox', multiple, h('span', 'Allow multiple answers'))));
  el.value = () => ({
    options: values.map(v => v.trim()).filter(Boolean),
    duration_hours: Number(length.value),
    multiple: multiple.checked,
  });
  el.reset = () => { values = ['', '']; length.value = '24'; multiple.checked = false; render(); };
  el.focusFirst = () => list.querySelector('input')?.focus();
  render();
  return el;
}
