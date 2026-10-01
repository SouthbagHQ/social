// Poll voting. Polls are created with the post (POST /api/posts with `poll`, see createPost) and
// come back on every post as `post.poll` (see hydrate).
//   POST   /api/polls/:postId/vote   { option_ids: string[] } → { post }   (replaces the viewer's vote)
//   DELETE /api/polls/:postId/vote   → { post }                             (withdraws it)
//   POST   /api/polls/:postId/close  → { post }                             (author ends the poll early)

import { Hono } from 'hono';
import type { AppEnv, Ctx, SessionUser } from '../env';
import { body, fail, placeholders, requireUser } from '../lib/http';
import { hydrateIds, loadVisiblePost, type PostRow } from '../lib/posts';
import { track } from '../lib/palantir';

const polls = new Hono<AppEnv>();

interface PollRow { post_id: string; closes_at: number; multiple: number }

/** The post and its poll, if the viewer can see it. */
async function loadPoll(c: Ctx, user: SessionUser): Promise<{ post: PostRow; poll: PollRow }> {
  const post = await loadVisiblePost(c.env, user.id, c.req.param('postId')!);
  if (!post || post.deleted_at) fail(404, 'Post not found.');
  const poll = await c.env.DB.prepare('SELECT post_id, closes_at, multiple FROM polls WHERE post_id = ?').bind(post.id).first<PollRow>();
  if (!poll) fail(404, 'Poll not found.');
  return { post, poll };
}

/** Recounts the poll's totals from the votes (runs at the end of the same batch). */
const recount = (c: Ctx, postId: string): D1PreparedStatement[] => [
  c.env.DB.prepare(`UPDATE poll_options SET vote_count = (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id = poll_options.id)
    WHERE post_id = ?`).bind(postId),
  c.env.DB.prepare('UPDATE polls SET voter_count = (SELECT COUNT(DISTINCT user_id) FROM poll_votes WHERE post_id = ?) WHERE post_id = ?')
    .bind(postId, postId),
];

const fresh = async (c: Ctx, user: SessionUser, id: string) => c.json({ post: (await hydrateIds(c.env, user, [id]))[0] });

polls.post('/:postId/vote', async c => {
  const user = requireUser(c);
  const { post, poll } = await loadPoll(c, user);
  const now = Date.now();
  if (poll.closes_at <= now) fail(409, 'This poll has closed.');
  const input = await body<{ option_ids?: unknown }>(c);
  const picked = [...new Set(Array.isArray(input.option_ids) ? input.option_ids.filter((x): x is string => typeof x === 'string') : [])];
  if (!picked.length) fail(422, 'Pick an option.');
  if (!poll.multiple && picked.length > 1) fail(422, 'Pick one option.');
  const { results: valid } = await c.env.DB.prepare(`SELECT id FROM poll_options WHERE post_id = ? AND id IN (${placeholders(picked.length)})`)
    .bind(post.id, ...picked).all<{ id: string }>();
  if (valid.length !== picked.length) fail(422, 'That option is not in this poll.');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM poll_votes WHERE post_id = ? AND user_id = ?').bind(post.id, user.id),
    ...picked.map(optionId => c.env.DB.prepare('INSERT INTO poll_votes (post_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(post.id, optionId, user.id, now)),
    ...recount(c, post.id),
  ]);
  track(c, 'social_poll_voted', { post_id: post.id, option_count: picked.length, multiple: Boolean(poll.multiple) });
  return fresh(c, user, post.id);
});

polls.delete('/:postId/vote', async c => {
  const user = requireUser(c);
  const { post, poll } = await loadPoll(c, user);
  if (poll.closes_at <= Date.now()) fail(409, 'This poll has closed.');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM poll_votes WHERE post_id = ? AND user_id = ?').bind(post.id, user.id),
    ...recount(c, post.id),
  ]);
  track(c, 'social_poll_vote_withdrawn', { post_id: post.id });
  return fresh(c, user, post.id);
});

polls.post('/:postId/close', async c => {
  const user = requireUser(c);
  const { post, poll } = await loadPoll(c, user);
  if (post.author_id !== user.id) fail(403, 'Only the author can end this poll.');
  const now = Date.now();
  if (poll.closes_at > now) await c.env.DB.prepare('UPDATE polls SET closes_at = ? WHERE post_id = ?').bind(now, post.id).run();
  if (poll.closes_at > now) track(c, 'social_poll_closed', { post_id: post.id });
  return fresh(c, user, post.id);
});

export default polls;
