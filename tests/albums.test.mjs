// Shared albums, powered by Southbag Drive. scripts/test.sh runs a mock Drive user-token API on
// :8797, so uploads really leave the Worker into the uploader's own Drive and come back through
// /media/album/:id via Drive share links. Seed data gives alice, bob and kevin Identity tokens;
// carol has none, so her uploads are asked to sign in again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, as, anon } from './helpers.mjs';

// A real (if tiny) PNG: 1x1, transparent.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function putMedia(who, albumId, bytes = PNG, type = 'image/png') {
  return fetch(`${BASE}/api/albums/${albumId}/media`, {
    method: 'PUT',
    headers: {
      cookie: `southbag_social_session=dev-${who}`,
      origin: BASE,
      'content-type': type,
      'x-sb-filename': 'photo.png',
    },
    body: bytes,
  });
}

async function makeAlbum(who = 'alice', title = 'Holiday 2026') {
  const res = await as(who).post('albums', { title });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.album;
}

test('albums: create, list and roles', async () => {
  const album = await makeAlbum();
  assert.equal(album.title, 'Holiday 2026');
  assert.equal(album.role, 'owner');
  assert.equal(album.member_count, 1);
  assert.equal(album.media_count, 0);

  const mine = await as('alice').get('albums');
  assert.equal(mine.status, 200);
  assert.ok(mine.body.items.some(a => a.id === album.id));

  assert.equal((await anon.get('albums')).status, 401);
  assert.equal((await as('alice').post('albums', { title: '' })).status, 422);
  const longTitle = await as('alice').post('albums', { title: 'x'.repeat(200) });
  assert.equal(longTitle.status, 422);
});

test('albums: invites, membership and privacy', async () => {
  const album = await makeAlbum('alice', 'Secret slides');

  // Non-members cannot see it at all.
  assert.equal((await as('bob').get(`albums/${album.id}`)).status, 404);
  assert.equal((await as('bob').get(`albums/${album.id}/media`)).status, 404);

  // Only the owner invites.
  assert.equal((await as('alice').post(`albums/${album.id}/members`, { handle: 'nobody' })).status, 404);
  const invited = await as('alice').post(`albums/${album.id}/members`, { handle: 'bob' });
  assert.equal(invited.status, 200, JSON.stringify(invited.body));
  assert.equal(invited.body.member.user.handle, 'bob');

  const detail = await as('bob').get(`albums/${album.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.viewer.role, 'member');
  assert.equal(detail.body.members.length, 2);
  assert.ok((await as('bob').get('albums')).body.items.some(a => a.id === album.id));

  // Members cannot invite or rename; the owner can.
  assert.equal((await as('bob').post(`albums/${album.id}/members`, { handle: 'carol' })).status, 403);
  assert.equal((await as('bob').patch(`albums/${album.id}`, { title: 'x' })).status, 403);
  const renamed = await as('alice').patch(`albums/${album.id}`, { title: 'Very secret slides' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.album.title, 'Very secret slides');

  // The invite lands in bob's notifications with a link to the album.
  const notes = await as('bob').get('notifications');
  const note = notes.body.items.find(n => n.type === 'album_invite');
  assert.ok(note, 'invite notification');
  assert.equal(note.link, `/albums/${album.id}`);
});

test('albums: leaving', async () => {
  const album = await makeAlbum('alice', 'Farewell');
  await as('alice').post(`albums/${album.id}/members`, { handle: 'bob' });

  assert.equal((await as('alice').post(`albums/${album.id}/leave`)).status, 409);
  const left = await as('bob').post(`albums/${album.id}/leave`);
  assert.equal(left.status, 200);
  assert.equal((await as('bob').get(`albums/${album.id}`)).status, 404);
});

test('albums: media goes to Drive and comes back for members only', async () => {
  const album = await makeAlbum('alice', 'Drive powered');
  await as('alice').post(`albums/${album.id}/members`, { handle: 'bob' });

  // Members can add media; strangers cannot.
  assert.equal((await putMedia('carol', album.id)).status, 404);
  assert.equal((await putMedia('bob', album.id, PNG, 'text/plain')).status, 422);

  const uploaded = await putMedia('bob', album.id);
  const uploadedText = await uploaded.text();
  assert.equal(uploaded.status, 201, uploadedText);
  const media = JSON.parse(uploadedText).media;
  assert.equal(media.kind, 'image');
  assert.equal(media.content_type, 'image/png');
  assert.equal(media.uploader.handle, 'bob');
  assert.ok(media.url.startsWith('/media/album/'));

  const list = await as('alice').get(`albums/${album.id}/media`);
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].id, media.id);
  const after = await as('alice').get(`albums/${album.id}`);
  assert.equal(after.body.album.media_count, 1);
  assert.equal(after.body.album.cover_url, media.url);

  // Serving: members only, exact bytes, ranges are sliced out of the Drive share download.
  const anonRes = await fetch(`${BASE}${media.url}`);
  assert.equal(anonRes.status, 401);
  const carolRes = await fetch(`${BASE}${media.url}`, { headers: { cookie: 'southbag_social_session=dev-carol' } });
  assert.equal(carolRes.status, 404);

  const full = await fetch(`${BASE}${media.url}`, { headers: { cookie: 'southbag_social_session=dev-alice' } });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), PNG);

  const ranged = await fetch(`${BASE}${media.url}`, {
    headers: { cookie: 'southbag_social_session=dev-alice', range: 'bytes=0-9' },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-9/${PNG.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), PNG.subarray(0, 10));
});

test('albums: media goes to the UPLOADER’S own Drive, and a member without an Identity token is asked to sign in again', async () => {
  const album = await makeAlbum('alice', 'Bring your own Drive');
  await as('alice').post(`albums/${album.id}/members`, { handle: 'carol' });

  // Carol is a member but has no stored Identity token, so she cannot put files in her Drive.
  const noToken = await putMedia('carol', album.id);
  assert.equal(noToken.status, 401);
  assert.match(await noToken.text(), /Sign in again/);
});

test('albums: nothing can be deleted', async () => {
  const album = await makeAlbum('alice', 'Permanent');
  const uploaded = await putMedia('alice', album.id);
  const media = (await uploaded.json()).media;

  const delMedia = await fetch(`${BASE}/api/albums/${album.id}/media/${media.id}`, {
    method: 'DELETE',
    headers: { cookie: 'southbag_social_session=dev-alice', origin: BASE },
  });
  assert.equal(delMedia.status, 403);
  assert.match((await delMedia.json()).error, /Deletion isn't available/);

  const delAlbum = await as('alice').del(`albums/${album.id}`);
  assert.equal(delAlbum.status, 403);
  assert.match(delAlbum.body.error, /Deletion isn't available/);
});
