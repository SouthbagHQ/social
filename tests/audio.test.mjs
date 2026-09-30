import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE, anon, as } from './helpers.mjs';

const alice = as('alice');
const bob = as('bob');
const carol = as('carol');

async function upload(who, { kind = 'audio', type = 'audio/mpeg', size = 3000, duration = 120 } = {}) {
  const { body } = await who.post('media', { kind, content_type: type, size, duration });
  const bytes = new Uint8Array(size).map((_, i) => i % 251);
  await who.put(`media/${body.id}/chunks/0`, bytes);
  return (await who.post(`media/${body.id}/complete`)).body;
}

async function show(who, input) {
  const res = await who.post('audio/shows', input);
  assert.equal(res.status, 201, res.text);
  return res.body.show;
}

async function track(who, showId, input = {}) {
  const file = await upload(who, { duration: input.duration ?? 120 });
  const res = await who.post('audio/tracks', { show_id: showId, title: 'Untitled', media_id: file.id, ...input });
  assert.equal(res.status, 201, res.text);
  return res.body.track;
}

test('audio: shows can be created, listed, searched, edited and deleted by their owner', async () => {
  assert.equal((await anon.get('audio/shows')).status, 200);
  assert.equal((await alice.post('audio/shows', { kind: 'radio', title: 'x' })).status, 422);
  assert.equal((await alice.post('audio/shows', { kind: 'podcast', title: '' })).status, 422);

  const cover = await upload(alice, { kind: 'image', type: 'image/png', size: 500 });
  const pod = await show(alice, { kind: 'podcast', title: 'Morning Briefing Audio', description: 'Weekly.', category: 'News', cover_media_id: cover.id });
  assert.equal(pod.kind, 'podcast');
  assert.equal(pod.cover_url, `/media/${cover.id}`);
  assert.equal(pod.owner.handle, 'alice');
  assert.equal(pod.viewer.can_edit, true);

  // Someone else's cover is refused.
  const bobCover = await upload(bob, { kind: 'image', type: 'image/png', size: 400 });
  assert.equal((await alice.post('audio/shows', { kind: 'artist', title: 'Band', cover_media_id: bobCover.id })).status, 422);

  const list = await anon.get('audio/shows?kind=podcast&q=briefing');
  assert.ok(list.body.items.some(s => s.id === pod.id));
  const artists = await anon.get('audio/shows?kind=artist&q=briefing');
  assert.ok(!artists.body.items.some(s => s.id === pod.id));

  assert.equal((await bob.patch(`audio/shows/${pod.id}`, { title: 'Mine now' })).status, 403);
  const edited = await alice.patch(`audio/shows/${pod.id}`, { title: 'Morning Briefing', category: 'Business' });
  assert.equal(edited.body.show.title, 'Morning Briefing');
  assert.equal(edited.body.show.category, 'Business');

  const mine = await alice.get('audio/shows/mine');
  assert.ok(mine.body.items.some(s => s.id === pod.id));

  // A show with tracks cannot be deleted until they are gone.
  const ep = await track(alice, pod.id, { title: 'Episode one' });
  assert.equal((await alice.del(`audio/shows/${pod.id}`)).status, 409);
  assert.equal((await bob.del(`audio/tracks/${ep.id}`)).status, 403);
  assert.equal((await alice.del(`audio/tracks/${ep.id}`)).status, 200);
  assert.equal((await bob.del(`audio/shows/${pod.id}`)).status, 403);
  assert.equal((await alice.del(`audio/shows/${pod.id}`)).status, 200);
  assert.equal((await anon.get(`audio/shows/${pod.id}`)).status, 404);
  // The cover went with it.
  assert.equal((await fetch(`${BASE}/media/${cover.id}`)).status, 404);
});

test('audio: publishing a track checks ownership and files, makes a feed post, and serves ranges', async () => {
  const band = await show(bob, { kind: 'artist', title: 'The Quarterlies', category: 'Indie' });
  const aliceFile = await upload(alice);
  assert.equal((await alice.post('audio/tracks', { show_id: band.id, title: 'Hijack', media_id: aliceFile.id })).status, 403);
  const bobImage = await upload(bob, { kind: 'image', type: 'image/png', size: 300 });
  assert.equal((await bob.post('audio/tracks', { show_id: band.id, title: 'Not audio', media_id: bobImage.id })).status, 422);
  assert.equal((await bob.post('audio/tracks', { show_id: band.id, title: 'Stolen', media_id: aliceFile.id })).status, 422);
  assert.equal((await bob.post('audio/tracks', { show_id: band.id, title: 'Long', media_id: (await upload(bob)).id, description: 'x'.repeat(5001) })).status, 422);

  const file = await upload(bob, { size: 5000, duration: 200 });
  const res = await bob.post('audio/tracks', {
    show_id: band.id, title: 'Opening Hours', media_id: file.id, album: 'Branch Sessions', genre: 'Indie', description: 'Recorded live. #music',
  });
  assert.equal(res.status, 201);
  const song = res.body.track;
  assert.equal(song.kind, 'song');
  assert.equal(song.album, 'Branch Sessions');
  assert.equal(song.duration, 200);
  assert.equal(song.cover_url, null);
  assert.equal(song.show.id, band.id);
  assert.ok(song.post_id);
  assert.equal((await bob.post('audio/tracks', { show_id: band.id, title: 'Again', media_id: file.id })).status, 409);

  // The feed post carries the audio.
  const post = await bob.get(`posts/${song.post_id}`);
  assert.equal(post.status, 200);
  const p = post.body.post || post.body;
  assert.match(p.body, /New song: Opening Hours/);
  assert.equal(p.media[0].kind, 'audio');
  const byMedia = await anon.get(`audio/tracks/by-media/${file.id}`);
  assert.equal(byMedia.body.track.id, song.id);

  // Range requests work on the audio.
  const ranged = await fetch(`${BASE}${song.audio_url}`, { headers: { range: 'bytes=100-199' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 100-199/5000');
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);

  const detail = await anon.get(`audio/tracks/${song.id}`);
  assert.equal(detail.body.track.title, 'Opening Hours');
  const showPage = await anon.get(`audio/shows/${band.id}`);
  assert.equal(showPage.body.show.track_count, 1);
  assert.equal(showPage.body.tracks[0].id, song.id);

  const found = await anon.get('audio/tracks?kind=song&q=branch%20sessions');
  assert.ok(found.body.items.some(t => t.id === song.id));
  const episodes = await anon.get('audio/tracks?kind=episode&q=opening');
  assert.ok(!episodes.body.items.some(t => t.id === song.id));

  // Editing: owner only; episode fields are ignored on songs.
  assert.equal((await alice.patch(`audio/tracks/${song.id}`, { title: 'x' })).status, 403);
  const cover = await upload(bob, { kind: 'image', type: 'image/png', size: 300 });
  const edited = await bob.patch(`audio/tracks/${song.id}`, { title: 'Opening Hours (Live)', cover_media_id: cover.id, season: 3 });
  assert.equal(edited.body.track.title, 'Opening Hours (Live)');
  assert.equal(edited.body.track.cover_url, `/media/${cover.id}`);
  assert.equal(edited.body.track.season, null);

  // Deleting the track deletes the feed post and the files.
  assert.equal((await bob.del(`audio/tracks/${song.id}`)).status, 200);
  assert.equal((await anon.get(`audio/tracks/${song.id}`)).status, 404);
  const gone = await bob.get(`posts/${song.post_id}`);
  assert.ok(gone.status === 404 || (gone.body.post || gone.body).deleted);
  assert.equal((await fetch(`${BASE}/media/${file.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/media/${cover.id}`)).status, 404);
});

test('audio: follows, likes, play counts and listening progress', async () => {
  const pod = await show(alice, { kind: 'podcast', title: 'Counting Room' });
  const ep1 = await track(alice, pod.id, { title: 'Pilot', episode_number: 1, season: 1, duration: 600, post_to_feed: false });
  assert.equal(ep1.post_id, null);
  assert.equal(ep1.episode_number, 1);

  // Follow is idempotent and counted once.
  assert.equal((await anon.get(`audio/shows/${pod.id}`)).body.show.follower_count, 0);
  assert.equal((await bob.put(`audio/shows/${pod.id}/follow`)).body.follower_count, 1);
  assert.equal((await bob.put(`audio/shows/${pod.id}/follow`)).body.follower_count, 1);
  assert.equal((await carol.put(`audio/shows/${pod.id}/follow`)).body.follower_count, 2);
  assert.equal((await carol.del(`audio/shows/${pod.id}/follow`)).body.follower_count, 1);
  assert.equal((await bob.get(`audio/shows/${pod.id}`)).body.show.viewer.following, true);
  assert.equal((await bob.put('audio/shows/nope/follow')).status, 404);
  assert.equal((await fetch(`${BASE}/api/audio/shows/${pod.id}/follow`, { method: 'PUT' })).status, 401);

  // New episodes from followed podcasts show on Home.
  const ep2 = await track(alice, pod.id, { title: 'Second', episode_number: 2, duration: 900 });
  const home = await bob.get('audio/home');
  assert.equal(home.status, 200);
  assert.equal(home.body.new_episodes_from, 'following');
  assert.equal(home.body.new_episodes[0].id, ep2.id);
  const library = await bob.get('audio/library');
  assert.ok(library.body.shows.some(s => s.id === pod.id));

  // Likes.
  assert.equal((await bob.put(`audio/tracks/${ep1.id}/like`)).body.like_count, 1);
  assert.equal((await bob.put(`audio/tracks/${ep1.id}/like`)).body.like_count, 1);
  assert.equal((await carol.put(`audio/tracks/${ep1.id}/like`)).body.like_count, 2);
  assert.equal((await carol.del(`audio/tracks/${ep1.id}/like`)).body.like_count, 1);
  assert.equal((await bob.get(`audio/tracks/${ep1.id}`)).body.track.viewer.liked, true);
  assert.ok((await bob.get('audio/library')).body.liked.some(t => t.id === ep1.id));

  // Plays: once per listener per half hour; signed-out plays always count.
  const first = await bob.post(`audio/tracks/${ep1.id}/play`);
  assert.deepEqual(first.body, { counted: true, play_count: 1 });
  const again = await bob.post(`audio/tracks/${ep1.id}/play`);
  assert.deepEqual(again.body, { counted: false, play_count: 1 });
  assert.equal((await carol.post(`audio/tracks/${ep1.id}/play`)).body.play_count, 2);
  const anonPlay = await fetch(`${BASE}/api/audio/tracks/${ep1.id}/play`, { method: 'POST' });
  assert.equal((await anonPlay.json()).play_count, 3);
  assert.equal((await bob.post('audio/tracks/nope/play')).status, 404);
  const popular = (await anon.get('audio/home')).body.popular;
  assert.ok(popular.some(t => t.id === ep1.id));

  // Progress: saved per listener, capped at the duration, completed near the end.
  assert.equal((await bob.put(`audio/tracks/${ep2.id}/progress`, { position: -1 })).status, 422);
  assert.equal((await bob.put('audio/tracks/nope/progress', { position: 1 })).status, 404);
  const saved = await bob.put(`audio/tracks/${ep2.id}/progress`, { position: 321.46 });
  assert.deepEqual(saved.body, { position: 321.5, completed: false });
  assert.equal((await bob.get(`audio/tracks/${ep2.id}`)).body.track.viewer.progress, 321.5);
  assert.equal((await carol.get(`audio/tracks/${ep2.id}`)).body.track.viewer.progress, null);
  let cont = (await bob.get('audio/home')).body.continue_listening;
  assert.equal(cont[0].id, ep2.id);
  const done = await bob.put(`audio/tracks/${ep2.id}/progress`, { position: 5000 });
  assert.deepEqual(done.body, { position: 900, completed: true });
  cont = (await bob.get('audio/home')).body.continue_listening;
  assert.ok(!cont.some(t => t.id === ep2.id));
  assert.equal((await bob.get(`audio/tracks/${ep2.id}`)).body.track.viewer.completed, true);
});

test('audio: playlists keep their order and are private when asked', async () => {
  const band = await show(carol, { kind: 'artist', title: 'Carol and the Tellers' });
  const a = await track(carol, band.id, { title: 'A', post_to_feed: false });
  const b = await track(carol, band.id, { title: 'B', post_to_feed: false });
  const c = await track(carol, band.id, { title: 'C', post_to_feed: false });

  assert.equal((await alice.post('audio/playlists', { title: '' })).status, 422);
  const created = await alice.post('audio/playlists', { title: 'Commute', visibility: 'private' });
  assert.equal(created.status, 201);
  const pl = created.body.playlist;
  assert.equal(pl.visibility, 'private');
  for (const t of [a, b, c]) assert.equal((await alice.post(`audio/playlists/${pl.id}/tracks`, { track_id: t.id })).status, 201);
  assert.equal((await alice.post(`audio/playlists/${pl.id}/tracks`, { track_id: a.id })).status, 409);
  assert.equal((await alice.post(`audio/playlists/${pl.id}/tracks`, { track_id: 'nope' })).status, 404);

  let got = await alice.get(`audio/playlists/${pl.id}`);
  assert.deepEqual(got.body.tracks.map(t => t.title), ['A', 'B', 'C']);
  assert.equal(got.body.playlist.track_count, 3);

  // Private: others can't see or change it.
  assert.equal((await bob.get(`audio/playlists/${pl.id}`)).status, 404);
  assert.equal((await anon.get(`audio/playlists/${pl.id}`)).status, 404);
  assert.equal((await bob.post(`audio/playlists/${pl.id}/tracks`, { track_id: a.id })).status, 404);

  // Reorder needs the exact set.
  assert.equal((await alice.put(`audio/playlists/${pl.id}/order`, { track_ids: [c.id, a.id] })).status, 422);
  const reordered = await alice.put(`audio/playlists/${pl.id}/order`, { track_ids: [c.id, a.id, b.id] });
  assert.deepEqual(reordered.body.tracks.map(t => t.title), ['C', 'A', 'B']);

  // Remove, then append goes to the end.
  const removed = await alice.del(`audio/playlists/${pl.id}/tracks/${a.id}`);
  assert.equal(removed.body.playlist.track_count, 2);
  await alice.post(`audio/playlists/${pl.id}/tracks`, { track_id: a.id });
  got = await alice.get(`audio/playlists/${pl.id}`);
  assert.deepEqual(got.body.tracks.map(t => t.title), ['C', 'B', 'A']);

  // Public playlists are visible but only the owner edits.
  const pub = await alice.patch(`audio/playlists/${pl.id}`, { visibility: 'public', title: 'Commute mix' });
  assert.equal(pub.body.playlist.title, 'Commute mix');
  assert.equal((await bob.get(`audio/playlists/${pl.id}`)).status, 200);
  assert.equal((await bob.patch(`audio/playlists/${pl.id}`, { title: 'x' })).status, 403);
  assert.equal((await bob.del(`audio/playlists/${pl.id}`)).status, 403);
  assert.ok((await alice.get('audio/playlists')).body.items.some(p => p.id === pl.id));

  // Deleting a track takes it out of playlists.
  await carol.del(`audio/tracks/${b.id}`);
  got = await alice.get(`audio/playlists/${pl.id}`);
  assert.deepEqual(got.body.tracks.map(t => t.title), ['C', 'A']);
  assert.equal(got.body.playlist.track_count, 2);

  assert.equal((await alice.del(`audio/playlists/${pl.id}`)).status, 200);
  assert.equal((await alice.get(`audio/playlists/${pl.id}`)).status, 404);
});
