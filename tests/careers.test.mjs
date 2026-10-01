import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { anon, as } from './helpers.mjs';

// kevin is used for the social connections so the people tests' counts are unaffected; every
// follow and friendship made here is undone at the end.
const alice = as('alice'), bob = as('bob'), carol = as('carol'), kevin = as('kevin');
const tag = Date.now().toString(36);

const NO_DELETING = "Deletion isn't available. Kevin knows what you did.";

/** Every DELETE of something a user made is refused with the same message. */
async function cannotDelete(who, path) {
  const res = await who.del(path);
  assert.equal(res.status, 403, res.text);
  assert.deepEqual(res.body, { error: NO_DELETING });
}

before(async () => {
  // kevin and alice are friends; kevin and bob follow each other; carol is connected to nobody.
  await kevin.put('users/alice/friend');
  await alice.put('users/kevin/friend');
  await kevin.put('users/bob/follow');
  await bob.put('users/kevin/follow');
});

after(async () => {
  await kevin.del('users/alice/friend');
  await kevin.del('users/bob/follow');
  await bob.del('users/kevin/follow');
});

test('careers: headline and open to work show on the profile', async () => {
  const res = await alice.patch('careers/profile', { headline: 'Engineering manager at Harbour', open_to_work: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { headline: 'Engineering manager at Harbour', open_to_work: true });
  const profile = await anon.get('users/alice');
  assert.equal(profile.body.user.headline, 'Engineering manager at Harbour');
  assert.equal(profile.body.user.open_to_work, true);
  assert.equal((await anon.get('careers/profile/alice')).body.user.open_to_work, true);
  await alice.patch('careers/profile', { open_to_work: false });
  assert.equal((await anon.get('users/alice')).body.user.open_to_work, false);
  assert.equal((await anon.get('careers/profile/nobody-here')).status, 404);
});

test('careers: experiences are added, edited and reordered, not deleted', async () => {
  const add = body => alice.post('careers/experiences', body);
  const a = await add({ company_name: 'First Co', title: 'Graduate', start_month: '2015-02', end_month: '2017-06' });
  assert.equal(a.status, 201);
  const b = await add({ company_name: 'Second Co', title: 'Developer', start_month: '2017-07', end_month: '2022-02', employment_type: 'contract' });
  const cur = await add({ company_name: 'Third Co', title: 'Lead', start_month: '2022-03' });
  assert.equal(cur.body.experience.current, true);
  assert.equal((await add({ company_name: 'X', title: 'Y', start_month: '2022-13' })).status, 422);
  assert.equal((await add({ company_name: 'X', title: 'Y', start_month: '2022-05', end_month: '2021-01' })).status, 422);
  assert.equal((await add({ company_name: 'X', title: '', start_month: '2022-05' })).status, 422);
  assert.equal((await add({ company_name: 'X', title: 'Y', start_month: '2022-05', employment_type: 'pirate' })).status, 422);
  assert.equal((await anon.get('careers/profile/alice')).status, 200);

  // Newest first.
  let list = (await anon.get('careers/profile/alice')).body.experiences.map(e => e.title);
  assert.deepEqual(list.slice(0, 3), ['Lead', 'Developer', 'Graduate']);

  const ids = (await anon.get('careers/profile/alice')).body.experiences.map(e => e.id);
  const reversed = [...ids].reverse();
  assert.equal((await alice.put('careers/experiences/order', { ids: reversed })).status, 200);
  list = (await anon.get('careers/profile/alice')).body.experiences.map(e => e.id);
  assert.deepEqual(list, reversed);
  assert.equal((await alice.put('careers/experiences/order', { ids: reversed.slice(1) })).status, 422, 'must list every entry');
  assert.equal((await bob.put('careers/experiences/order', { ids: reversed })).status, 422, 'not your entries');

  const edit = await alice.patch(`careers/experiences/${b.body.experience.id}`, { title: 'Senior developer', end_month: null });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.experience.title, 'Senior developer');
  assert.equal(edit.body.experience.current, true);
  assert.equal(edit.body.experience.employment_type, 'contract', 'untouched fields stay');
  assert.equal((await bob.patch(`careers/experiences/${b.body.experience.id}`, { title: 'Mine now' })).status, 404);
  await cannotDelete(bob, `careers/experiences/${a.body.experience.id}`);
  await cannotDelete(alice, `careers/experiences/${a.body.experience.id}`);
  assert.ok((await anon.get('careers/profile/alice')).body.experiences.some(e => e.id === a.body.experience.id));
  assert.equal((await anon.get('careers/experiences')).status, 404);
});

test('careers: education is added, edited and reordered, not deleted', async () => {
  const one = await carol.post('careers/educations', { school: 'University of Sydney', degree: 'Bachelor of Arts', field: 'History', start_year: 2010, end_year: 2013 });
  assert.equal(one.status, 201);
  const two = await carol.post('careers/educations', { school: 'TAFE NSW', degree: 'Certificate IV', start_year: 2014 });
  assert.equal((await carol.post('careers/educations', { school: '' })).status, 422);
  assert.equal((await carol.post('careers/educations', { school: 'X', start_year: 2015, end_year: 2012 })).status, 422);
  let schools = (await anon.get('careers/profile/carol')).body.educations.map(e => e.school);
  assert.deepEqual(schools, ['TAFE NSW', 'University of Sydney']);
  await carol.put('careers/educations/order', { ids: [one.body.education.id, two.body.education.id] });
  schools = (await anon.get('careers/profile/carol')).body.educations.map(e => e.school);
  assert.deepEqual(schools, ['University of Sydney', 'TAFE NSW']);
  const edit = await carol.patch(`careers/educations/${two.body.education.id}`, { end_year: 2015 });
  assert.equal(edit.body.education.end_year, 2015);
  assert.equal(edit.body.education.degree, 'Certificate IV');
  assert.equal((await alice.patch(`careers/educations/${two.body.education.id}`, { end_year: 2016 })).status, 404);
  await cannotDelete(carol, `careers/educations/${two.body.education.id}`);
  schools = (await anon.get('careers/profile/carol')).body.educations.map(e => e.school);
  assert.deepEqual(schools, ['University of Sydney', 'TAFE NSW']);
});

test('careers: skills are unique per person, can be reordered and are not deleted', async () => {
  for (const name of ['Logistics', 'Excel', 'Forklift licence']) assert.equal((await kevin.post('careers/skills', { name })).status, 201);
  assert.equal((await kevin.post('careers/skills', { name: 'excel' })).status, 409);
  assert.equal((await kevin.post('careers/skills', { name: '  ' })).status, 422);
  let skills = (await anon.get('careers/profile/kevin')).body.skills.map(s => s.name);
  assert.deepEqual(skills, ['Logistics', 'Excel', 'Forklift licence']);
  assert.equal((await kevin.put('careers/skills/order', { names: ['forklift licence', 'Logistics', 'Excel'] })).status, 200);
  skills = (await anon.get('careers/profile/kevin')).body.skills.map(s => s.name);
  assert.deepEqual(skills, ['Forklift licence', 'Logistics', 'Excel']);
  await cannotDelete(kevin, 'careers/skills/Forklift%20licence');
  skills = (await anon.get('careers/profile/kevin')).body.skills.map(s => s.name);
  assert.deepEqual(skills, ['Forklift licence', 'Logistics', 'Excel']);
});

test('careers: only friends or mutual follows can endorse', async () => {
  await alice.post('careers/skills', { name: 'Leadership' });
  // carol is connected to nobody.
  assert.equal((await carol.put('careers/endorse/kevin/Logistics')).status, 403);
  assert.equal((await kevin.put('careers/endorse/kevin/Logistics')).status, 422);
  // one-way follow is not enough
  await carol.put('users/kevin/follow');
  assert.equal((await carol.put('careers/endorse/kevin/Logistics')).status, 403);
  await carol.del('users/kevin/follow');
  // friends
  let res = await alice.put('careers/endorse/kevin/logistics');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.skill, { name: 'Logistics', endorsement_count: 1, endorsed: true });
  res = await alice.put('careers/endorse/kevin/Logistics');
  assert.equal(res.body.skill.endorsement_count, 1, 'endorsing twice counts once');
  // mutual follows
  res = await bob.put('careers/endorse/kevin/Logistics');
  assert.equal(res.body.skill.endorsement_count, 2);
  assert.equal((await alice.put('careers/endorse/kevin/Juggling')).status, 404);
  const seen = await alice.get('careers/profile/kevin');
  assert.equal(seen.body.viewer.can_endorse, true);
  assert.equal(seen.body.skills.find(s => s.name === 'Logistics').endorsed, true);
  assert.equal((await carol.get('careers/profile/kevin')).body.viewer.can_endorse, false);
  const notes = await kevin.get('notifications');
  assert.ok(notes.body.items.some(n => n.type === 'system' && /endorsed you for Logistics/.test(n.body)));
  res = await bob.del('careers/endorse/kevin/Logistics');
  assert.equal(res.body.skill.endorsement_count, 1);
  assert.equal(res.body.skill.endorsed, false);
});

test('careers: recommendations are requested, written and approved', async () => {
  assert.equal((await carol.post('careers/recommendations/requests/alice', {})).status, 403);
  assert.equal((await kevin.post('careers/recommendations/requests/alice', { message: 'Would you write one?' })).status, 200);
  const inbox = await alice.get('careers/recommendations');
  assert.ok(inbox.body.requests.some(r => r.user.handle === 'kevin' && r.message === 'Would you write one?'));
  assert.equal((await alice.get('careers/profile/kevin')).body.viewer.asked_you, true);

  assert.equal((await carol.put('careers/recommendations/kevin', { body: 'Great.' })).status, 403);
  assert.equal((await alice.put('careers/recommendations/kevin', { body: '' })).status, 422);
  const wrote = await alice.put('careers/recommendations/kevin', { relationship: 'Worked together', body: 'Reliable and careful.' });
  assert.equal(wrote.status, 200);
  assert.equal(wrote.body.recommendation.status, 'pending');
  const id = wrote.body.recommendation.id;
  assert.equal((await alice.get('careers/recommendations')).body.requests.length, 0, 'writing clears the request');

  // Pending: the author and the subject see it, nobody else does.
  assert.equal((await anon.get('careers/profile/kevin')).body.recommendations.length, 0);
  assert.equal((await alice.get('careers/profile/kevin')).body.recommendations[0].status, 'pending');
  assert.equal((await kevin.get('careers/profile/kevin')).body.recommendations[0].author.handle, 'alice');

  assert.equal((await alice.patch(`careers/recommendations/${id}`, { status: 'visible' })).status, 404, 'authors cannot approve');
  assert.equal((await kevin.patch(`careers/recommendations/${id}`, { status: 'shown' })).status, 422);
  assert.equal((await kevin.patch(`careers/recommendations/${id}`, { status: 'visible' })).body.recommendation.status, 'visible');
  let pub = await anon.get('careers/profile/kevin');
  assert.equal(pub.body.recommendations.length, 1);
  assert.equal(pub.body.recommendations[0].body, 'Reliable and careful.');

  // Editing sends it back for approval.
  await alice.put('careers/recommendations/kevin', { relationship: 'Worked together', body: 'Reliable, careful and quick.' });
  assert.equal((await anon.get('careers/profile/kevin')).body.recommendations.length, 0);
  await kevin.patch(`careers/recommendations/${id}`, { status: 'hidden' });
  assert.equal((await anon.get('careers/profile/kevin')).body.recommendations.length, 0);
  assert.equal((await kevin.get('careers/recommendations')).body.received[0].status, 'hidden');
  assert.equal((await alice.get('careers/recommendations')).body.written[0].user.handle, 'kevin');
  await cannotDelete(bob, `careers/recommendations/${id}`);
  await cannotDelete(alice, `careers/recommendations/${id}`);
  assert.equal((await alice.get('careers/recommendations')).body.written[0].id, id);
});

let company, job, remoteJob, externalJob;

test('careers: companies, admins and follows', async () => {
  const res = await alice.post('careers/companies', {
    name: `Harbour Freight ${tag}`, industry: 'Logistics', size: '51-200', location: 'Sydney, NSW',
    website: 'https://harbour.example', description: 'Freight and logistics.',
  });
  assert.equal(res.status, 201);
  company = res.body.company;
  assert.equal(company.slug, `harbour-freight-${tag}`);
  assert.equal(company.is_owner, true);
  assert.equal((await alice.post('careers/companies', { name: `Harbour Freight ${tag}` })).status, 409);
  assert.equal((await alice.post('careers/companies', { name: 'X' })).status, 422);
  assert.equal((await alice.post('careers/companies', { name: 'Webby', website: 'not a url' })).status, 422);
  assert.equal((await alice.post('careers/companies', { name: 'Sized', size: 'huge' })).status, 422);

  assert.equal((await bob.patch(`careers/companies/${company.slug}`, { industry: 'Shipping' })).status, 403);
  assert.equal((await carol.put(`careers/companies/${company.slug}/admins/carol`)).status, 403);
  const added = await alice.put(`careers/companies/${company.slug}/admins/bob`);
  assert.deepEqual(added.body.admins.map(a => a.handle), ['alice', 'bob']);
  assert.equal((await bob.patch(`careers/companies/${company.slug}`, { industry: 'Shipping' })).body.company.industry, 'Shipping');
  assert.equal((await bob.del(`careers/companies/${company.slug}/admins/alice`)).status, 422, 'owner stays');
  await cannotDelete(bob, `careers/companies/${company.slug}`);
  await cannotDelete(alice, `careers/companies/${company.slug}`);

  // Follows are counted once.
  await carol.put(`careers/companies/${company.slug}/follow`);
  const f = await carol.put(`careers/companies/${company.slug}/follow`);
  assert.deepEqual(f.body, { is_following: true, follower_count: 1 });
  assert.equal((await carol.del(`careers/companies/${company.slug}/follow`)).body.follower_count, 0);

  // Employees: current roles that link the page (by id, or by typing the exact name).
  await bob.post('careers/experiences', { company_id: company.id, title: 'Dispatcher', start_month: '2023-01' });
  await carol.post('careers/experiences', { company_name: `harbour freight ${tag}`, title: 'Driver', start_month: '2020-01', end_month: '2021-01' });
  const pageRes = await anon.get(`careers/companies/${company.slug}`);
  assert.equal(pageRes.status, 200);
  assert.deepEqual(pageRes.body.employees.map(e => e.handle), ['bob']);
  assert.equal(pageRes.body.employees[0].title, 'Dispatcher');
  assert.equal((await anon.get('careers/companies/no-such-company')).status, 404);
  const mine = await bob.get('careers/me/companies');
  assert.ok(mine.body.items.some(co => co.id === company.id));
  const search = await anon.get(`careers/companies?q=${encodeURIComponent(`freight ${tag}`)}`);
  assert.equal(search.body.items.length, 1);
});

test('careers: jobs are posted by company admins and searchable', async () => {
  const post = (who, body) => who.post('careers/jobs', { company_id: company.id, ...body });
  assert.equal((await post(carol, { title: 'Nope' })).status, 403);
  assert.equal((await post(alice, { title: '' })).status, 422);
  assert.equal((await post(alice, { title: 'X', salary_min: 100000, salary_max: 90000 })).status, 422);
  assert.equal((await post(alice, { title: 'X', workplace: 'moon' })).status, 422);
  assert.equal((await post(alice, { title: 'X', description: 'a'.repeat(10001) })).status, 422);
  assert.equal((await alice.post('careers/jobs', { company_id: 'nope', title: 'X' })).status, 422);

  const a = await post(alice, {
    title: `Warehouse supervisor ${tag}`, location: 'Sydney, NSW', workplace: 'onsite', employment_type: 'full_time',
    salary_min: 85000, salary_max: 95000, description: 'Run the night shift. Forklift licence needed.',
  });
  assert.equal(a.status, 201);
  job = a.body.job;
  assert.equal(job.currency, 'AUD');
  assert.equal(job.poster.handle, 'alice');
  assert.equal(job.can_manage, true);
  remoteJob = (await post(bob, { title: `Logistics analyst ${tag}`, location: 'Melbourne, VIC', workplace: 'remote', employment_type: 'contract' })).body.job;
  externalJob = (await post(alice, { title: `Customs broker ${tag}`, location: 'Brisbane', apply_url: 'https://harbour.example/careers' })).body.job;

  const ids = async q => (await anon.get(`careers/jobs?${q}`)).body.items.map(j => j.id);
  assert.deepEqual(await ids(`q=${tag}`), [externalJob.id, remoteJob.id, job.id]);
  assert.deepEqual(await ids(`q=supervisor+${tag}`), [job.id]);
  assert.deepEqual(await ids(`q=forklift+${tag}`), [job.id], 'matches the description');
  assert.deepEqual(await ids(`q=${tag}&location=melbourne`), [remoteJob.id]);
  assert.deepEqual(await ids(`q=${tag}&workplace=remote`), [remoteJob.id]);
  assert.deepEqual(await ids(`q=${tag}&type=contract`), [remoteJob.id]);
  assert.deepEqual(await ids(`company=${company.slug}&type=full_time&workplace=onsite&location=Sydney`), [job.id]);
  assert.equal((await anon.get('careers/jobs?workplace=moon')).status, 422);
  const firstPage = await anon.get(`careers/jobs?q=${tag}&limit=2`);
  assert.equal(firstPage.body.items.length, 2);
  const secondPage = await anon.get(`careers/jobs?q=${tag}&limit=2&cursor=${firstPage.body.next}`);
  assert.deepEqual(secondPage.body.items.map(j => j.id), [job.id]);
  assert.equal(secondPage.body.next, null);

  // Editing and closing: managers only.
  assert.equal((await carol.patch(`careers/jobs/${job.id}`, { title: 'Mine' })).status, 403);
  assert.equal((await bob.patch(`careers/jobs/${job.id}`, { salary_max: 99000 })).body.job.salary_max, 99000, 'company admins manage every job');
  const closed = await alice.post(`careers/jobs/${remoteJob.id}/close`);
  assert.equal(closed.body.job.status, 'closed');
  assert.deepEqual(await ids(`q=${tag}&workplace=remote`), []);
  assert.equal((await anon.get(`careers/jobs/${remoteJob.id}`)).body.job.status, 'closed', 'closed jobs still load');
  assert.equal((await carol.post(`careers/jobs/${remoteJob.id}/apply`, { note: 'Hi' })).status, 422);
  const mine = await bob.get('careers/me/jobs');
  assert.ok(mine.body.items.some(j => j.id === remoteJob.id && j.status === 'closed'));
});

test('careers: applying once, statuses and notifications', async () => {
  assert.equal((await anon.get(`careers/jobs/${job.id}`)).body.job.applicant_count, 0);
  assert.equal((await alice.post(`careers/jobs/${job.id}/apply`, { note: 'Me' })).status, 422, 'managers cannot apply');
  assert.equal((await carol.post(`careers/jobs/${externalJob.id}/apply`, { note: 'Hi' })).status, 422, 'external jobs apply elsewhere');
  const applied = await carol.post(`careers/jobs/${job.id}/apply`, { note: 'I have run night shifts for three years.' });
  assert.equal(applied.status, 201);
  assert.equal(applied.body.application.status, 'submitted');
  assert.equal((await carol.post(`careers/jobs/${job.id}/apply`, { note: 'Again' })).status, 409);
  const seen = await carol.get(`careers/jobs/${job.id}`);
  assert.equal(seen.body.job.applicant_count, 1);
  assert.equal(seen.body.job.application_status, 'submitted');
  assert.equal(seen.body.job.can_manage, false);

  const posterNotes = await alice.get('notifications');
  assert.ok(posterNotes.body.items.some(n => n.type === 'system' && n.body === `Carol Southbag applied for Warehouse supervisor ${tag}.`));

  assert.equal((await carol.get(`careers/jobs/${job.id}/applications`)).status, 403);
  const list = await alice.get(`careers/jobs/${job.id}/applications`);
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].user.handle, 'carol');
  assert.equal(list.body.items[0].note, 'I have run night shifts for three years.');
  assert.equal(list.body.counts.submitted, 1);
  const appId = list.body.items[0].id;

  assert.equal((await carol.patch(`careers/applications/${appId}`, { status: 'shortlisted' })).status, 404);
  assert.equal((await alice.patch(`careers/applications/${appId}`, { status: 'hired' })).status, 422);
  const updated = await bob.patch(`careers/applications/${appId}`, { status: 'shortlisted' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.application.status, 'shortlisted');
  const notes = await carol.get('notifications');
  assert.ok(notes.body.items.some(n => n.type === 'system'
    && n.body === `You have been shortlisted for Warehouse supervisor ${tag} at Harbour Freight ${tag}.`));
  assert.equal((await alice.get(`careers/jobs/${job.id}/applications?status=shortlisted`)).body.items.length, 1);
  assert.equal((await alice.get(`careers/jobs/${job.id}/applications?status=rejected`)).body.items.length, 0);

  const mine = await carol.get('careers/me/applications');
  assert.equal(mine.body.items[0].job.id, job.id);
  assert.equal(mine.body.items[0].status, 'shortlisted');
  assert.equal((await bob.get('careers/me/applications')).body.items.length, 0);
  assert.equal((await anon.get('careers/me/applications')).status, 401);

  // Withdrawing frees the slot.
  assert.equal((await carol.del(`careers/jobs/${job.id}/apply`)).status, 200);
  assert.equal((await anon.get(`careers/jobs/${job.id}`)).body.job.applicant_count, 0);
  assert.equal((await carol.post(`careers/jobs/${job.id}/apply`, { note: 'Once more.' })).status, 201);
});

test('careers: saved jobs and recommendations', async () => {
  assert.deepEqual((await kevin.put(`careers/jobs/${job.id}/save`)).body, { saved: true });
  await kevin.put(`careers/jobs/${job.id}/save`);
  assert.equal((await kevin.get(`careers/jobs/${job.id}`)).body.job.saved, true);
  let saved = await kevin.get('careers/me/saved');
  assert.deepEqual(saved.body.items.map(j => j.id), [job.id]);
  await kevin.del(`careers/jobs/${job.id}/save`);
  saved = await kevin.get('careers/me/saved');
  assert.equal(saved.body.items.length, 0);
  assert.equal((await anon.get(`careers/jobs/nope/save`)).status, 404);

  // kevin has "Logistics" as a skill; the remote analyst job is closed, so reopen it.
  await bob.patch(`careers/jobs/${remoteJob.id}`, { status: 'open' });
  await kevin.patch('careers/profile', { headline: 'Warehouse and logistics' });
  const rec = await kevin.get('careers/recommended');
  assert.equal(rec.status, 200);
  const ids = rec.body.items.map(j => j.id);
  assert.ok(ids.includes(remoteJob.id), 'skill matches a title');
  assert.ok(ids.includes(job.id), 'headline word matches a title');
  assert.ok(rec.body.basis.terms.includes('logistics'));
  // Jobs you applied for or manage are left out.
  assert.ok(!(await carol.get('careers/recommended')).body.items.some(j => j.id === job.id));
  assert.equal((await anon.get('careers/recommended')).status, 401);
});
