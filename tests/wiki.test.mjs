import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anon, as } from './helpers.mjs';

const alice = as('alice'), bob = as('bob'), carol = as('carol'), kevin = as('kevin');
const suffix = () => Math.random().toString(36).slice(2, 8);

async function space(owner = alice, extra = {}) {
  const slug = `w-${suffix()}`;
  const res = await owner.post('wiki', { slug, title: 'Test wiki', description: 'For tests.', ...extra });
  assert.equal(res.status, 201, res.text);
  return res.body.space;
}

const page = (s, slug, rest = '') => `wiki/${s.slug}/pages/${encodeURIComponent(slug)}${rest}`;

async function save(who, s, slug, content, base = null, summary = '') {
  return who.put(page(s, slug), { content, summary, base_revision_id: base });
}

async function png(who) {
  const bytes = new Uint8Array(500);
  const { body } = await who.post('media', { kind: 'image', content_type: 'image/png', size: bytes.length, width: 10, height: 10 });
  await who.put(`media/${body.id}/chunks/0`, bytes);
  return (await who.post(`media/${body.id}/complete`)).body;
}

async function notificationsFor(who) {
  return (await who.get('notifications?limit=50')).body.items;
}

test('wiki: spaces, validation and the main page', async () => {
  const s = await space();
  assert.equal(s.role, 'owner');
  assert.equal(s.page_count, 1);
  assert.equal(s.edit_policy, 'anyone');

  for (const slug of ['ab', 'has space', 'x'.repeat(41), '-dash', 'new', 'a--b']) {
    const res = await alice.post('wiki', { slug, title: 'Bad' });
    assert.ok([409, 422].includes(res.status), `${slug} -> ${res.status}`);
  }
  assert.equal((await bob.post('wiki', { slug: s.slug.toUpperCase(), title: 'Dup' })).status, 409, 'addresses are unique ignoring case');
  assert.equal((await bob.post('wiki', { slug: `w-${suffix()}` })).status, 422, 'a name is required');
  const unauth = await fetch(`${process.env.BASE || 'http://localhost:8799'}/api/wiki`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);

  const info = await anon.get(`wiki/${s.slug}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.viewer.can_edit, false, 'signed-out people cannot edit');
  assert.equal(info.body.main_page, 'Main_Page');
  assert.equal((await bob.get(`wiki/${s.slug}`)).body.viewer.can_edit, true, 'anyone signed in can edit by default');
  assert.equal((await anon.get('wiki/no-such-wiki-here')).status, 404);

  const main = await anon.get(`wiki/${s.slug}/pages/Main_Page`);
  assert.equal(main.status, 200);
  assert.equal(main.body.page.title, 'Main Page');
  assert.match(main.body.content, /Test wiki/);
  assert.equal(main.body.revision.author.handle, 'alice');
  assert.deepEqual(main.body.missing, ['first_page'], 'links to missing pages are reported');
  assert.equal((await anon.get(`wiki/${s.slug}/pages/main%20page`)).body.page.slug, 'Main_Page', 'titles match ignoring case and underscores');

  assert.ok((await alice.get('wiki?tab=mine')).body.items.some(x => x.slug === s.slug));
  assert.ok(!(await bob.get('wiki?tab=mine')).body.items.some(x => x.slug === s.slug));
  assert.ok((await anon.get(`wiki?q=${s.slug}`)).body.items.some(x => x.slug === s.slug));
  assert.equal((await anon.get('wiki?q=%25%25nothing%25')).body.items.length, 0, 'search terms are escaped');

  assert.equal((await bob.patch(`wiki/${s.slug}`, { title: 'Mine' })).status, 403);
  const patched = await alice.patch(`wiki/${s.slug}`, { title: 'Renamed wiki', edit_policy: 'members' });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.body.space.title, 'Renamed wiki');
  assert.equal(patched.body.space.edit_policy, 'members');
});

test('wiki: edit policy, members and protected pages', async () => {
  const s = await space(alice, { edit_policy: 'members' });
  assert.equal((await save(bob, s, 'Rules', 'Be nice.')).status, 403, 'non-members cannot edit a members-only wiki');
  assert.equal((await bob.get(`wiki/${s.slug}`)).body.viewer.can_edit, false);

  assert.equal((await bob.put(`wiki/${s.slug}/members/carol`, { role: 'editor' })).status, 403, 'only admins add members');
  const added = await alice.put(`wiki/${s.slug}/members/bob`, { role: 'editor' });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.body.member.role, 'editor');
  assert.ok((await notificationsFor(bob)).some(n => n.link === `/wiki/${s.slug}` && /added you/.test(n.body)));
  const created = await save(bob, s, 'Rules', 'Be nice.');
  assert.equal(created.status, 201, created.text);
  assert.equal((await save(carol, s, 'Rules', 'Be mean.', created.body.revision.id)).status, 403);
  const members = await anon.get(`wiki/${s.slug}/members`);
  assert.deepEqual(members.body.items.map(m => [m.user.handle, m.role]), [['alice', 'owner'], ['bob', 'editor']]);
  assert.equal((await alice.del(`wiki/${s.slug}/members/alice`)).status, 409, 'the owner stays');

  // Protection: admins only.
  assert.equal((await bob.put(page(s, 'Rules', '/protect'), { protected: true })).status, 403);
  const protectedRes = await alice.put(page(s, 'Rules', '/protect'), { protected: true });
  assert.equal(protectedRes.body.page.protected, true);
  const base = protectedRes.body.page.current_revision_id;
  const blocked = await save(bob, s, 'Rules', 'Be nicer.', base);
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /protected/);
  assert.equal((await bob.get(page(s, 'Rules'))).body.viewer.can_edit, false);
  assert.equal((await bob.post(page(s, 'Rules', '/move'), { title: 'Laws' })).status, 403, 'protected pages cannot be moved by editors');
  const adminEdit = await save(alice, s, 'Rules', 'Be nicer.', base);
  assert.equal(adminEdit.status, 200, adminEdit.text);
  await alice.put(page(s, 'Rules', '/protect'), { protected: false });
  assert.equal((await save(bob, s, 'Rules', 'Be nicest.', adminEdit.body.revision.id)).status, 200);

  // Bob leaves and can no longer edit.
  assert.equal((await bob.del(`wiki/${s.slug}/members/bob`)).status, 200);
  assert.equal((await bob.get(`wiki/${s.slug}`)).body.viewer.can_edit, false);

  // A promoted admin can protect.
  await alice.put(`wiki/${s.slug}/members/carol`, { role: 'admin' });
  assert.equal((await carol.put(page(s, 'Rules', '/protect'), { protected: true })).status, 200);
});

test('wiki: community wikis follow community roles', async () => {
  const name = `w_${suffix()}`;
  const community = await alice.post('communities', { name, title: 'Wiki community' });
  assert.equal(community.status, 201, community.text);
  assert.equal((await bob.post('wiki', { slug: `w-${suffix()}`, title: 'Hijack', community: name })).status, 403, 'only moderators link a community');
  const s = await space(alice, { community: name, edit_policy: 'members' });
  assert.equal(s.community.name, name);
  assert.ok((await anon.get(`wiki?community=${name}`)).body.items.some(x => x.slug === s.slug));
  assert.equal((await save(bob, s, 'Page', 'Hello.')).status, 403);
  await bob.post(`communities/${name}/join`);
  assert.equal((await bob.get(`wiki/${s.slug}`)).body.viewer.role, 'editor', 'community members are editors');
  assert.equal((await save(bob, s, 'Page', 'Hello.')).status, 201);
});

test('wiki: create, edit, conflicts, history, revisions and diff', async () => {
  const s = await space();
  const v1 = await save(bob, s, 'Kevin', 'Line one\nLine two\nLine three', null, 'First');
  assert.equal(v1.status, 201, v1.text);
  assert.equal(v1.body.page.title, 'Kevin');
  assert.equal(v1.body.revision.summary, 'First');
  assert.equal(v1.body.revision.delta, 'Line one\nLine two\nLine three'.length);
  assert.equal((await save(carol, s, 'Kevin', 'Other text')).status, 409, 'creating an existing page is a conflict');
  assert.equal((await bob.post(`wiki/${s.slug}/pages`, { title: 'Kevin', content: 'x' })).status, 409);
  assert.equal((await save(bob, s, 'Bad|title', 'x')).status, 422);
  assert.equal((await save(bob, s, 'Special:Thing', 'x')).status, 422);
  assert.equal((await save(bob, s, 'Empty', '   ')).status, 422);
  assert.equal((await save(bob, s, 'Huge', 'x'.repeat(100_001))).status, 422);

  const v2 = await save(carol, s, 'Kevin', 'Line one\nLine 2\nLine three\nLine four', v1.body.revision.id, 'Second');
  assert.equal(v2.status, 200, v2.text);
  const stale = await save(bob, s, 'Kevin', 'Line one\nMy edit', v1.body.revision.id);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'Someone edited this page while you were editing. Review the changes and try again.');
  assert.equal(stale.body.latest.id, v2.body.revision.id);
  assert.equal(stale.body.latest.content, 'Line one\nLine 2\nLine three\nLine four');
  assert.equal(stale.body.latest.author.handle, 'carol');
  const v3 = await save(bob, s, 'Kevin', 'Line one\nLine 2\nLine three\nLine four\nLine five', stale.body.latest.id, 'Third');
  assert.equal(v3.status, 200, v3.text);

  // Two saves from the same base: exactly one wins.
  const race = await Promise.all([
    save(bob, s, 'Kevin', 'Race A', v3.body.revision.id),
    save(carol, s, 'Kevin', 'Race B', v3.body.revision.id),
  ]);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  const afterRace = await anon.get(page(s, 'Kevin'));
  assert.equal(afterRace.body.content, race[0].status === 200 ? 'Race A' : 'Race B');

  const history = await anon.get(page(s, 'Kevin', '/history?limit=2'));
  assert.equal(history.body.items.length, 2);
  assert.ok(history.body.next);
  assert.equal(history.body.items[0].current, true);
  assert.deepEqual(history.body.items.map(r => r.summary), ['', 'Third'], 'newest first');
  const rest = await anon.get(page(s, 'Kevin', `/history?limit=10&cursor=${history.body.next}`));
  assert.deepEqual(rest.body.items.map(r => r.summary), ['Second', 'First']);
  assert.equal(rest.body.next, null);

  const old = await anon.get(page(s, 'Kevin', `/revisions/${v1.body.revision.id}`));
  assert.equal(old.body.content, 'Line one\nLine two\nLine three');
  assert.equal(old.body.revision.current, false);
  assert.equal((await anon.get(page(s, 'Kevin', '/revisions/nope'))).status, 404);

  const diff = await anon.get(page(s, 'Kevin', `/diff?from=${v1.body.revision.id}&to=${v2.body.revision.id}`));
  assert.equal(diff.status, 200, diff.text);
  assert.deepEqual(diff.body.lines, [
    { op: 'same', text: 'Line one' },
    { op: 'del', text: 'Line two' },
    { op: 'add', text: 'Line 2' },
    { op: 'same', text: 'Line three' },
    { op: 'add', text: 'Line four' },
  ]);
  assert.equal(diff.body.added, 2);
  assert.equal(diff.body.removed, 1);
  const swapped = await anon.get(page(s, 'Kevin', `/diff?from=${v2.body.revision.id}&to=${v1.body.revision.id}`));
  assert.equal(swapped.body.from.id, v1.body.revision.id, 'older revision always on the left');
  const previous = await anon.get(page(s, 'Kevin', `/diff?to=${v2.body.revision.id}`));
  assert.equal(previous.body.from.id, v1.body.revision.id, 'diff defaults to the previous revision');
  const first = await anon.get(page(s, 'Kevin', `/diff?to=${v1.body.revision.id}`));
  assert.equal(first.body.from, null);
  assert.equal(first.body.added, 3);

  // Long unchanged runs collapse to context.
  const long = Array.from({ length: 40 }, (_, i) => `Row ${i}`);
  const l1 = await save(bob, s, 'Long', long.join('\n'));
  const changed = [...long]; changed[20] = 'Row twenty';
  const l2 = await save(bob, s, 'Long', changed.join('\n'), l1.body.revision.id);
  const longDiff = await anon.get(page(s, 'Long', `/diff?to=${l2.body.revision.id}`));
  assert.deepEqual(longDiff.body.lines.map(l => l.op), ['skip', 'same', 'same', 'same', 'del', 'add', 'same', 'same', 'same', 'skip']);
  assert.equal(longDiff.body.lines[0].count, 17);
});

test('wiki: revert, recent changes and random page', async () => {
  const s = await space();
  const v1 = await save(bob, s, 'Revert me', 'Good text.');
  const v2 = await save(carol, s, 'Revert me', 'Vandalised.', v1.body.revision.id);
  assert.equal((await anon.get(page(s, 'Revert me'))).body.content, 'Vandalised.');
  assert.equal((await bob.post(page(s, 'Revert me', '/revert'), { revision_id: v2.body.revision.id })).status, 409, 'already current');
  const reverted = await bob.post(page(s, 'Revert me', '/revert'), { revision_id: v1.body.revision.id });
  assert.equal(reverted.status, 200, reverted.text);
  assert.match(reverted.body.revision.summary, /Reverted to the version by @bob/);
  assert.equal((await anon.get(page(s, 'Revert me'))).body.content, 'Good text.');
  assert.equal((await anon.get(page(s, 'Revert me', '/history'))).body.items.length, 3, 'reverting adds a revision');

  const recent = await anon.get(`wiki/${s.slug}/recent?limit=3`);
  assert.deepEqual(recent.body.items.map(r => r.page.title), ['Revert me', 'Revert me', 'Revert me']);
  assert.equal(recent.body.items[0].author.handle, 'bob');
  assert.ok(recent.body.next);

  const random = await anon.get(`wiki/${s.slug}/random`);
  assert.ok(['Main_Page', 'Revert_me'].includes(random.body.slug));
});

test('wiki: move with redirect, links table and what links here', async () => {
  const s = await space();
  const a = await save(bob, s, 'Alpha', 'See [[Beta]], [[beta|again]], [[Gamma#Part|g]] and [[File:abcdefgh12345]].');
  assert.equal(a.status, 201, a.text);
  const alpha = await anon.get(page(s, 'Alpha'));
  assert.deepEqual(alpha.body.missing.sort(), ['beta', 'gamma']);
  assert.deepEqual(alpha.body.files, {}, 'unknown images are left out');
  assert.deepEqual((await anon.get(page(s, 'Beta', '/links'))).body.items.map(x => x.title), ['Alpha'], 'red links have backlinks');

  await save(carol, s, 'Beta', 'Beta page.');
  assert.deepEqual((await anon.get(page(s, 'Alpha'))).body.missing, ['gamma']);
  const resolve = await bob.post(`wiki/${s.slug}/resolve`, { slugs: ['Beta', 'Gamma', 'Main Page'] });
  assert.deepEqual(resolve.body.missing, ['gamma']);

  // Move Beta to Delta, leaving a redirect.
  assert.equal((await bob.post(page(s, 'Beta', '/move'), { title: 'Alpha' })).status, 409, 'cannot move over an existing page');
  assert.equal((await anon.get(`wiki/${s.slug}`)).status, 200);
  const moved = await bob.post(page(s, 'Beta', '/move'), { title: 'Delta' });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.body.page.slug, 'Delta');
  assert.equal(moved.body.redirect, 'Beta');
  const viaOld = await anon.get(page(s, 'Beta'));
  assert.equal(viaOld.body.page.slug, 'Delta');
  assert.deepEqual(viaOld.body.redirected_from, { slug: 'Beta', title: 'Beta' });
  assert.equal(viaOld.body.content, 'Beta page.');
  const raw = await anon.get(page(s, 'Beta', '?redirect=no'));
  assert.equal(raw.body.page.redirect_to, 'Delta');
  assert.equal(raw.body.content, '#REDIRECT [[Delta]]');
  assert.deepEqual((await anon.get(page(s, 'Delta', '/links'))).body.items.map(x => [x.title, x.redirect_to]), [['Beta', 'Delta']]);
  assert.match((await anon.get(page(s, 'Delta', '/history'))).body.items[0].summary, /Moved Beta to Delta/);
  assert.equal((await anon.get(`wiki/${s.slug}`)).body.space.page_count, 3, 'redirects are not counted as pages');

  // Moving back over our own redirect works.
  const back = await bob.post(page(s, 'Delta', '/move'), { title: 'Beta', redirect: false });
  assert.equal(back.status, 200, back.text);
  assert.equal((await anon.get(page(s, 'Delta'))).status, 404, 'no redirect left behind');
  assert.equal((await anon.get(page(s, 'Beta'))).body.redirected_from, null);

  // Editing updates the links table.
  const alphaRev = (await anon.get(page(s, 'Alpha'))).body.page.current_revision_id;
  await save(bob, s, 'Alpha', 'Only [[Gamma]] now.', alphaRev);
  assert.deepEqual((await anon.get(page(s, 'Beta', '/links'))).body.items, []);
  assert.deepEqual((await anon.get(page(s, 'Gamma', '/links'))).body.items.map(x => x.slug), ['Alpha']);

  // Saving content that is a redirect makes the page a redirect.
  const r = await save(bob, s, 'Old name', '#REDIRECT [[Alpha]]');
  assert.equal(r.body.page.redirect_to, 'Alpha');
  assert.equal((await anon.get(page(s, 'Old name'))).body.page.slug, 'Alpha');
});

test('wiki: delete and undelete are for admins', async () => {
  const s = await space();
  await save(bob, s, 'Doomed', 'Text.');
  assert.equal((await bob.del(page(s, 'Doomed'))).status, 403);
  assert.equal((await alice.del(page(s, 'Main_Page'))).status, 409, 'the main page stays');
  assert.equal((await alice.del(page(s, 'Doomed'))).status, 200);
  assert.equal((await anon.get(page(s, 'Doomed'))).status, 404);
  assert.equal((await bob.get(page(s, 'Doomed', '/history'))).status, 404);
  const seen = await alice.get(page(s, 'Doomed'));
  assert.equal(seen.status, 200);
  assert.equal(seen.body.page.deleted, true);
  assert.equal(seen.body.viewer.can_edit, false);
  assert.equal((await save(bob, s, 'Doomed', 'Again.')).status, 409, 'deleted pages are not recreated over');
  assert.ok((await alice.get(`wiki/${s.slug}/pages?deleted=1`)).body.items.some(p => p.slug === 'Doomed'));
  assert.ok(!(await anon.get(`wiki/${s.slug}/pages`)).body.items.some(p => p.slug === 'Doomed'));
  assert.equal((await alice.get(`wiki/${s.slug}`)).body.space.page_count, 1);
  assert.equal((await bob.post(page(s, 'Doomed', '/undelete'))).status, 404);
  assert.equal((await alice.post(page(s, 'Doomed', '/undelete'))).status, 200);
  assert.equal((await anon.get(page(s, 'Doomed'))).status, 200);
  assert.equal((await alice.get(`wiki/${s.slug}`)).body.space.page_count, 2);

  const all = await anon.get(`wiki/${s.slug}/pages?limit=1`);
  assert.equal(all.body.items[0].slug, 'Doomed', 'all pages are A to Z');
  assert.equal(all.body.next, 'Doomed');
  assert.equal((await anon.get(`wiki/${s.slug}/pages?limit=1&cursor=Doomed`)).body.items[0].slug, 'Main_Page');
});

test('wiki: talk threads', async () => {
  const s = await space();
  await save(bob, s, 'Topic', 'Text.');
  assert.equal((await anon.get(page(s, 'Topic', '/talk'))).body.items.length, 0);
  const first = await bob.post(page(s, 'Topic', '/talk'), { body: 'Should we add more?' });
  assert.equal(first.status, 201, first.text);
  assert.equal(first.body.comment.depth, 0);
  assert.equal(first.body.comment.author.handle, 'bob');
  const reply = await carol.post(page(s, 'Topic', '/talk'), { body: 'Yes.', parent_id: first.body.comment.id });
  assert.equal(reply.body.comment.depth, 1);
  assert.equal(reply.body.comment.parent_id, first.body.comment.id);
  assert.ok((await notificationsFor(bob)).some(n => /replied to you/.test(n.body) && n.link === `/wiki/${s.slug}/Topic/talk`));
  assert.equal((await carol.post(page(s, 'Topic', '/talk'), { body: '' })).status, 422);
  assert.equal((await carol.post(page(s, 'Topic', '/talk'), { body: 'x', parent_id: 'nope' })).status, 404);
  assert.equal((await anon.get(page(s, 'Nothing', '/talk'))).status, 404);

  assert.equal((await carol.del(page(s, 'Topic', `/talk/${first.body.comment.id}`))).status, 403);
  assert.equal((await bob.del(page(s, 'Topic', `/talk/${first.body.comment.id}`))).status, 200);
  assert.equal((await alice.del(page(s, 'Topic', `/talk/${reply.body.comment.id}`))).status, 200, 'admins can delete');
  const talk = await anon.get(page(s, 'Topic', '/talk'));
  assert.equal(talk.body.items.length, 2);
  assert.ok(talk.body.items.every(c => c.deleted && c.body === '' && c.author === null));
  assert.equal(talk.body.count, 0);
});

test('wiki: watchers are notified of edits and talk', async () => {
  const s = await space();
  const v1 = await save(bob, s, 'Watched', 'Text.');
  // The creator watches automatically.
  assert.equal((await bob.get(page(s, 'Watched'))).body.viewer.watching, true);
  assert.equal((await kevin.put(page(s, 'Watched', '/watch'))).body.watching, true);
  assert.equal((await kevin.get(page(s, 'Watched'))).body.viewer.watching, true);

  const v2 = await save(carol, s, 'Watched', 'More text.', v1.body.revision.id, 'Expanded');
  const expectedLink = `/wiki/${s.slug}/Watched/diff?from=${v1.body.revision.id}&to=${v2.body.revision.id}`;
  for (const who of [bob, kevin]) {
    const n = (await notificationsFor(who)).find(x => x.link === expectedLink);
    assert.ok(n, 'watchers hear about the edit with a link to the diff');
    assert.equal(n.type, 'system');
    assert.equal(n.actor.handle, 'carol');
    assert.match(n.body, /edited Watched/);
  }
  assert.ok(!(await notificationsFor(carol)).some(x => x.link === expectedLink), 'editors are not notified of their own edit');

  assert.equal((await kevin.del(page(s, 'Watched', '/watch'))).body.watching, false);
  const v3 = await save(carol, s, 'Watched', 'Even more.', v2.body.revision.id);
  const link3 = `/wiki/${s.slug}/Watched/diff?from=${v2.body.revision.id}&to=${v3.body.revision.id}`;
  assert.ok(!(await notificationsFor(kevin)).some(x => x.link === link3), 'unwatched pages are quiet');
  assert.ok((await notificationsFor(bob)).some(x => x.link === link3));

  await carol.post(page(s, 'Watched', '/talk'), { body: 'Thoughts?' });
  assert.ok((await notificationsFor(bob)).some(x => x.link === `/wiki/${s.slug}/Watched/talk` && /commented/.test(x.body)));
  assert.equal((await anon.get(page(s, 'Watched'))).body.viewer.watching, false);
});

test('wiki: search titles and text', async () => {
  const s = await space();
  await save(bob, s, 'Bag fees', 'Everything about the 100% guarantee and snake_case names.');
  await save(bob, s, 'Other', 'Mentions bag fees once.');
  await save(bob, s, 'Third', 'Nothing here. 100 percent.');
  const res = await anon.get(`wiki/${s.slug}/search?q=${encodeURIComponent('bag fees')}`);
  assert.deepEqual(res.body.items.map(i => [i.title, i.title_match]), [['Bag fees', true], ['Other', false]]);
  assert.match(res.body.items[1].snippet, /bag fees/);
  const pct = await anon.get(`wiki/${s.slug}/search?q=${encodeURIComponent('100%')}`);
  assert.deepEqual(pct.body.items.map(i => i.title), ['Bag fees'], '% is literal');
  const under = await anon.get(`wiki/${s.slug}/search?q=${encodeURIComponent('e_c')}`);
  assert.deepEqual(under.body.items.map(i => i.title), ['Bag fees'], '_ is literal');
  assert.equal((await anon.get(`wiki/${s.slug}/search?q=a`)).body.items.length, 0, 'two characters minimum');
});

test('wiki: images and logos stay while in use', async () => {
  const logo = await png(alice);
  const s = await space(alice, { logo_media_id: logo.id });
  assert.equal(s.logo_url, `/media/${logo.id}`);
  assert.equal((await alice.del(`media/${logo.id}`)).status, 409, 'logos are in use');
  const pic = await png(bob);
  const saved = await save(bob, s, 'Pictures', `[[File:${pic.id}|A test picture]]`);
  assert.equal(saved.status, 201, saved.text);
  const view = await anon.get(page(s, 'Pictures'));
  assert.deepEqual(view.body.files[pic.id], { url: `/media/${pic.id}`, width: 10, height: 10 });
  // Removed from the text, still in history: the file stays.
  await save(bob, s, 'Pictures', 'No pictures now.', saved.body.revision.id);
  assert.equal((await bob.del(`media/${pic.id}`)).status, 409, 'files in page history are in use');
  const foreign = await png(carol);
  assert.equal((await bob.post('wiki', { slug: `w-${suffix()}`, title: 'Logo', logo_media_id: foreign.id })).status, 422, 'logos must be your own upload');
});
