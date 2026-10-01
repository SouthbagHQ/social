// Jobs (LinkedIn).
//   /jobs?tab=recommended|search|saved|applied|post|companies   the jobs home
//   /jobs?company=<slug>                                         a company page
//   /jobs/:jobId                                                 a job, with its applications for the poster
// API: /api/careers/… (see src/routes/careers.ts)

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { count, fullDate, plural, timeAgo } from '../format.js';
import { navigate, refresh } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, errorBox, infiniteList, loading, refuseDelete, tabs, toast, toastError } from '../ui.js';
import {
  APPLICATION_STATUS, COMPANY_SIZES, JOB_TYPES, WORKPLACES, companyLogo, field, formDialog, jobRow, posted,
  salaryLabel, saveButton, select,
} from '../components/career.js';
import { avatar, userName, userRow } from '../components/user.js';
import { pictureField } from './group-new.js';

const TABS = [
  ['recommended', 'Recommended', true],
  ['search', 'Search', false],
  ['saved', 'Saved', true],
  ['applied', 'Applied', true],
  ['post', 'Post a job', true],
  ['companies', 'Companies', false],
];

export default async function jobsView(ctx) {
  if (ctx.params.jobId) return jobPage(ctx, ctx.params.jobId);
  if (ctx.query.get('company')) return companyPage(ctx, ctx.query.get('company'));

  const signedIn = Boolean(ctx.me);
  const available = TABS.filter(([, , auth]) => signedIn || !auth);
  let tab = ctx.query.get('tab') || (signedIn ? 'recommended' : 'search');
  if (!available.some(([key]) => key === tab)) tab = 'search';
  const label = TABS.find(([key]) => key === tab)[1];
  ctx.title(tab === 'recommended' || tab === 'search' ? 'Jobs' : `Jobs: ${label}`);

  const views = { recommended, search, saved, applied, post: postJob, companies };
  return h('div.jobs-page',
    h('div.page-head', h('h1', 'Jobs')),
    tabs(available.map(([key, text]) => ({ href: `/jobs?tab=${key}`, label: text, current: key === tab }))),
    await views[tab](ctx));
}

// -- Recommended -------------------------------------------------------------

async function recommended(ctx) {
  const box = h('div.jobs-panel', loading());
  api.get('careers/recommended', null, { signal: ctx.signal }).then(res => {
    const basis = [res.basis.terms.slice(0, 6).join(', '), res.basis.location].filter(Boolean).join('; ');
    mount(box,
      basis ? h('p.fine.jobs-basis', `Based on your profile: ${basis}.`) : null,
      res.items.length
        ? h('div.south-board.job-list', res.items.map(job => jobRow(job)))
        : empty({
          title: 'No recommended jobs yet.',
          text: 'Add skills and a headline to your career profile, or search all jobs.',
          action: h('div.row.wrap.jobs-empty-actions',
            h('a.btn-small', { href: `/@${ctx.me.handle}/career` }, 'Career profile'),
            h('a.btn-small', { href: '/jobs?tab=search' }, 'Search')),
        }));
  }).catch(err => { if (err.name !== 'AbortError') mount(box, errorBox(err)); });
  return box;
}

// -- Search ------------------------------------------------------------------

function search(ctx) {
  const q = ctx.query;
  const keywords = h('input.input', { type: 'search', name: 'q', value: q.get('q') || '', placeholder: 'Title, skill or company' });
  const location = h('input.input', { name: 'location', value: q.get('location') || '', placeholder: 'Sydney' });
  const workplace = select([['', 'Any'], ...Object.entries(WORKPLACES)], q.get('workplace') || '', { name: 'workplace' });
  const type = select([['', 'Any'], ...Object.entries(JOB_TYPES)], q.get('type') || '', { name: 'type' });
  const form = h('form.south-card.flat.job-search', { role: 'search', onsubmit: e => {
    e.preventDefault();
    const params = new URLSearchParams({ tab: 'search' });
    for (const [k, el] of [['q', keywords], ['location', location], ['workplace', workplace], ['type', type]])
      if (el.value.trim()) params.set(k, el.value.trim());
    navigate(`/jobs?${params}`, { scroll: false });
  } },
    h('div.job-search-grid',
      field('Keywords', keywords),
      field('Location', location),
      field('Workplace', workplace),
      field('Type', type)),
    h('button.btn', { type: 'submit' }, 'Search'));

  const params = { q: q.get('q'), location: q.get('location'), workplace: q.get('workplace'), type: q.get('type') };
  const list = infiniteList({
    className: 'south-board job-list',
    signal: ctx.signal,
    load: cursor => api.get('careers/jobs', { ...params, cursor }, { signal: ctx.signal }),
    render: job => jobRow(job),
    empty: empty({ title: 'No jobs found.' }),
  });
  return h('div.jobs-panel', form, list);
}

// -- Saved and applied -------------------------------------------------------

function saved(ctx) {
  return infiniteList({
    className: 'south-board job-list',
    signal: ctx.signal,
    load: cursor => api.get('careers/me/saved', { cursor }, { signal: ctx.signal }),
    render: job => jobRow(job),
    empty: empty({ title: 'No saved jobs.', action: h('a.btn-small', { href: '/jobs?tab=search' }, 'Search') }),
  });
}

function applied(ctx) {
  return infiniteList({
    className: 'south-board job-list',
    signal: ctx.signal,
    load: cursor => api.get('careers/me/applications', { cursor }, { signal: ctx.signal }),
    render: app => {
      const withdraw = h('button.btn-small', { type: 'button' }, 'Withdraw');
      const row = jobRow({ ...app.job, application_status: null }, {
        save: false,
        extra: h('div.job-application-line',
          h('span.chip', APPLICATION_STATUS[app.status]),
          h('span.fine', ` Applied ${timeAgoWords(app.created_at)}`),
          app.status !== 'rejected' ? [' ', withdraw] : null),
      });
      withdraw.addEventListener('click', async () => {
        if (!(await confirm(`Withdraw your application for ${app.job.title}?`, { title: 'Withdraw', ok: 'Withdraw' }))) return;
        try {
          await api.del(`careers/jobs/${app.job.id}/apply`);
          toast('Application withdrawn.');
          row.remove();
        } catch (err) { toastError(err); }
      });
      return row;
    },
    empty: empty({ title: 'No applications yet.', action: h('a.btn-small', { href: '/jobs?tab=search' }, 'Search') }),
  });
}

const timeAgoWords = ms => {
  const t = timeAgo(ms);
  return t === 'now' ? 'just now' : /^\d+[mhd]$/.test(t) ? `${t} ago` : `on ${t}`;
};

// -- Post a job ----------------------------------------------------------------

/** Job form fields. Returns { content, values() }. */
function jobFields(job = {}, companies = null, companyId = null) {
  const company = companies ? select(companies.map(c => [c.id, c.name]), companyId || companies[0]?.id) : null;
  const title = h('input.input', { required: true, maxLength: 100, value: job.title || '', placeholder: 'Warehouse supervisor' });
  const location = h('input.input', { maxLength: 100, value: job.location || '', placeholder: 'Sydney, NSW' });
  const workplace = select(Object.entries(WORKPLACES), job.workplace || 'onsite');
  const type = select(Object.entries(JOB_TYPES), job.employment_type || 'full_time');
  const min = h('input.input', { type: 'number', min: 0, step: 1000, value: job.salary_min ?? '', placeholder: '85000' });
  const max = h('input.input', { type: 'number', min: 0, step: 1000, value: job.salary_max ?? '', placeholder: '95000' });
  const description = h('textarea.textarea', { rows: 8, maxLength: 10000, value: job.description || '' });
  const applyUrl = h('input.input', { type: 'url', maxLength: 300, value: job.apply_url || '', placeholder: 'https://' });
  return {
    content: [
      company ? field('Company', company) : null,
      field('Title', title),
      h('div.career-form-grid', field('Location', location), field('Workplace', workplace)),
      h('div.career-form-grid', field('Type', type), h('span')),
      h('div.career-form-grid', field('Salary from (AUD a year)', min), field('Salary to (AUD a year)', max)),
      field('Description', description),
      field('Company site (optional)', applyUrl, 'If set, people apply there instead of here.'),
    ],
    values: () => ({
      ...(company ? { company_id: company.value } : {}),
      title: title.value, location: location.value, workplace: workplace.value, employment_type: type.value,
      salary_min: min.value === '' ? null : Number(min.value), salary_max: max.value === '' ? null : Number(max.value),
      description: description.value, apply_url: applyUrl.value.trim() || null,
    }),
  };
}

async function postJob(ctx) {
  const box = h('div.jobs-panel', loading());
  const { items: companiesList } = await api.get('careers/me/companies', null, { signal: ctx.signal });
  if (!companiesList.length) {
    mount(box, h('div.south-card.flat',
      h('h2', 'Post a job'),
      h('p', 'Jobs are posted by a company page. Create one first.'),
      h('button.btn', { type: 'button', onclick: () => companyDialog(null) }, 'Create company')));
  } else {
    const fields = jobFields({}, companiesList, ctx.query.get('company_id'));
    const submit = h('button.btn', { type: 'submit' }, 'Post job');
    const form = h('form.south-card.flat.job-form', { onsubmit: async e => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const { job } = await api.post('careers/jobs', fields.values());
        toast('Job posted.');
        navigate(`/jobs/${job.id}`);
      } catch (err) { toastError(err); submit.disabled = false; }
    } }, h('h2', 'Post a job'), fields.content, h('div.row.wrap', submit));
    mount(box, form);
  }
  box.append(h('section.south-card.flat',
    h('h2', 'Your job posts'),
    infiniteList({
      className: 'south-board job-list',
      signal: ctx.signal,
      load: cursor => api.get('careers/me/jobs', { cursor }, { signal: ctx.signal }),
      render: job => jobRow(job, { save: false }),
      empty: empty({ title: 'No job posts yet.' }),
    })));
  return box;
}

// -- Companies -----------------------------------------------------------------

function companyRow(co) {
  return h('article.south-item.job-row',
    companyLogo(co),
    h('div.grow',
      h('a.job-title', { href: `/jobs?company=${encodeURIComponent(co.slug)}` }, co.name),
      h('div.job-meta', [co.industry, co.location].filter(Boolean).join(', ')),
      h('div.job-meta.fine', plural(co.follower_count, 'follower'))),
    companyFollowButton(co));
}

function companies(ctx) {
  const q = ctx.query.get('q') || '';
  const input = h('input.input', { type: 'search', name: 'q', value: q, placeholder: 'Search companies', 'aria-label': 'Search companies' });
  return h('div',
    h('div.row.wrap.jobs-toolbar',
      h('form.row.grow', { role: 'search', onsubmit: e => {
        e.preventDefault();
        navigate(`/jobs?tab=companies${input.value.trim() ? `&q=${encodeURIComponent(input.value.trim())}` : ''}`, { scroll: false });
      } }, input, h('button.btn', { type: 'submit' }, 'Search')),
      ctx.me ? h('button.btn', { type: 'button', onclick: () => companyDialog(null) }, 'Create company') : null),
    infiniteList({
      className: 'south-board job-list',
      signal: ctx.signal,
      load: cursor => api.get('careers/companies', { q, cursor }, { signal: ctx.signal }),
      render: companyRow,
      empty: empty({ title: q ? 'No results.' : 'No companies yet.' }),
    }));
}

function companyFollowButton(co, onChange) {
  let following = Boolean(co.is_following);
  const btn = h('button.btn-small', { type: 'button' });
  const paint = () => { btn.textContent = following ? 'Following' : 'Follow'; };
  btn.addEventListener('click', async () => {
    if (!store.me) return login();
    btn.disabled = true;
    try {
      const res = following ? await api.del(`careers/companies/${co.slug}/follow`) : await api.put(`careers/companies/${co.slug}/follow`);
      following = res.is_following;
      co.is_following = following;
      co.follower_count = res.follower_count;
      paint();
      if (following) toast(`Following ${co.name}.`);
      onChange?.(res);
    } catch (err) { toastError(err); }
    btn.disabled = false;
  });
  paint();
  return btn;
}

async function companyDialog(co) {
  const name = h('input.input', { required: true, maxLength: 80, value: co?.name || '', placeholder: 'Harbour Freight' });
  const industry = h('input.input', { maxLength: 80, value: co?.industry || '', placeholder: 'Logistics' });
  const size = select([['', 'Not set'], ...COMPANY_SIZES.map(s => [s, `${s} employees`])], co?.size || '');
  const location = h('input.input', { maxLength: 100, value: co?.location || '', placeholder: 'Sydney, NSW' });
  const website = h('input.input', { type: 'url', maxLength: 300, value: co?.website || '', placeholder: 'https://' });
  const description = h('textarea.textarea', { rows: 4, maxLength: 2000, value: co?.description || '' });
  const logo = pictureField({ label: 'Logo', kind: 'avatar', current: co?.logo_url || null, hint: 'Shown square.' });
  const result = await formDialog({
    title: co ? 'Edit company' : 'Create company',
    ok: co ? 'Save' : 'Create',
    wide: true,
    content: [
      field('Name', name),
      h('div.career-form-grid', field('Industry', industry), field('Size', size)),
      h('div.career-form-grid', field('Location', location), field('Website', website)),
      field('About', description),
      logo,
    ],
    onSubmit: async () => {
      if (logo.busy) throw new Error('Wait for the upload to finish.');
      const payload = {
        name: name.value, industry: industry.value, size: size.value, location: location.value,
        website: website.value.trim(), description: description.value,
      };
      if (logo.value !== undefined) payload.logo_media_id = logo.value;
      return co ? api.patch(`careers/companies/${co.slug}`, payload) : api.post('careers/companies', payload);
    },
  });
  if (!result) return;
  toast(co ? 'Saved.' : 'Company created.');
  if (co && result.company.slug === co.slug) refresh();
  else navigate(`/jobs?company=${encodeURIComponent(result.company.slug)}`);
}

async function adminsDialog(co, admins) {
  const listBox = h('div');
  const paint = list => mount(listBox, list.map(a => userRow(a, {
    bio: false,
    action: (a.id === store.me?.id && !co.is_owner) || (co.is_owner && a.id !== store.me?.id)
      ? h('button.btn-small', { type: 'button', onclick: () => remove(a) }, a.id === store.me?.id ? 'Leave' : 'Remove')
      : null,
  })));
  const remove = async a => {
    try {
      const res = await api.del(`careers/companies/${co.slug}/admins/${a.handle}`);
      toast('Removed.');
      if (a.id === store.me?.id) { refresh(); return; }
      paint(res.admins);
    } catch (err) { toastError(err); }
  };
  const handle = h('input.input', { placeholder: 'Handle, like bob', 'aria-label': 'Handle' });
  const addForm = h('form.row.career-add-admin', { onsubmit: async e => {
    e.preventDefault();
    const value = handle.value.trim().replace(/^@/, '');
    if (!value) return;
    try {
      const res = await api.put(`careers/companies/${co.slug}/admins/${encodeURIComponent(value)}`);
      handle.value = '';
      toast(`@${value} is now an admin.`);
      paint(res.admins);
    } catch (err) { toastError(err); }
  } }, handle, h('button.btn-small', { type: 'submit' }, 'Add'));
  paint(admins);
  await dialog({
    title: 'Admins',
    body: [h('p.fine', 'Admins can edit this page, post jobs and review applications.'), listBox, addForm],
    actions: [{ label: 'Done', value: true, primary: true }],
  });
  refresh();
}

async function companyPage(ctx, slug) {
  let data;
  try {
    data = await api.get(`careers/companies/${encodeURIComponent(slug)}`, null, { signal: ctx.signal });
  } catch (err) {
    if (err.status !== 404) throw err;
    ctx.title('Company not found');
    return h('div.south-card.flat', h('h1', 'Company not found.'), h('a.btn', { href: '/jobs?tab=companies' }, 'Companies'));
  }
  const { company: co, employees, admins } = data;
  ctx.title(co.name);
  const followers = h('span', plural(co.follower_count, 'follower'));
  const facts = [co.industry, co.size ? `${co.size} employees` : '', co.location].filter(Boolean).join(', ');

  const actions = h('div.row.wrap.company-actions',
    companyFollowButton(co, res => { followers.textContent = plural(res.follower_count, 'follower'); }),
    co.is_admin ? [
      h('a.btn-small', { href: `/jobs?tab=post&company_id=${encodeURIComponent(co.id)}` }, 'Post a job'),
      h('button.btn-small', { type: 'button', onclick: () => companyDialog(co) }, 'Edit'),
      h('button.btn-small', { type: 'button', onclick: () => adminsDialog(co, admins) }, 'Admins'),
    ] : null,
    co.is_owner ? h('button.btn-small', { type: 'button', onclick: refuseDelete }, 'Delete') : null);

  return h('div.jobs-page.company-page',
    h('p.fine', h('a', { href: '/jobs?tab=companies' }, 'Companies')),
    h('section.south-card.flat.company-header',
      h('div.company-head',
        companyLogo({ ...co, slug: null }, 'lg'),
        h('div.grow',
          h('h1', co.name),
          facts ? h('div.muted', facts) : null,
          h('div.fine', followers, `, ${plural(co.employee_count, 'employee')} on Southbag Social, ${plural(co.open_job_count, 'open job')}`),
          co.website ? h('div.fine', h('a', { href: co.website, target: '_blank', rel: 'noopener noreferrer nofollow' }, co.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))) : null)),
      actions,
      co.description ? h('p.career-text.company-about', co.description) : null),
    h('section.south-card.flat',
      h('h2', 'Open jobs'),
      infiniteList({
        className: 'south-board job-list',
        signal: ctx.signal,
        load: cursor => api.get('careers/jobs', { company: co.slug, cursor }, { signal: ctx.signal }),
        render: job => jobRow(job),
        empty: empty({ title: 'No open jobs.' }),
      })),
    h('section.south-card.flat',
      h('h2', 'People'),
      employees.length
        ? employees.map(p => userRow({ ...p, bio: [p.title, p.headline].filter(Boolean).join(', ') }))
        : empty({ title: 'Nobody lists this company yet.' })));
}

// -- A job -------------------------------------------------------------------

async function jobPage(ctx, id) {
  let job;
  try {
    ({ job } = await api.get(`careers/jobs/${encodeURIComponent(id)}`, null, { signal: ctx.signal }));
  } catch (err) {
    if (err.status !== 404) throw err;
    ctx.title('Job not found');
    return h('div.south-card.flat', h('h1', 'Job not found.'), h('a.btn', { href: '/jobs' }, 'Jobs'));
  }
  ctx.title(`${job.title} at ${job.company.name}`);
  const co = job.company;
  const meta = [job.location, WORKPLACES[job.workplace], JOB_TYPES[job.employment_type]].filter(Boolean).join(', ');
  const salary = salaryLabel(job);

  return h('div.jobs-page.job-page',
    h('p.fine', h('a', { href: '/jobs' }, 'Jobs')),
    h('article.south-card.flat.job-detail',
      h('div.company-head',
        companyLogo(co, 'lg'),
        h('div.grow',
          h('h1', job.title),
          h('div', h('a', { href: `/jobs?company=${encodeURIComponent(co.slug)}` }, co.name)),
          meta ? h('div.muted', meta) : null,
          salary ? h('div', salary) : null,
          h('div.fine', h('time', { datetime: new Date(job.created_at).toISOString(), title: fullDate(job.created_at) }, posted(job.created_at)),
            `, ${plural(job.applicant_count, 'applicant')}`))),
      job.status === 'closed' ? h('div.notice', 'This job is no longer taking applications.') : null,
      jobActions(job),
      h('h2', 'About the job'),
      job.description ? h('p.career-text', job.description) : h('p.muted', 'No description.'),
      job.poster ? h('div.job-poster', h('h3', 'Posted by'), userRow({ ...job.poster, bio: job.poster.headline }, { action: null })) : null),
    h('section.south-card.flat.company-card',
      h('h2', 'About the company'),
      h('div.company-head',
        companyLogo(co),
        h('div.grow',
          h('a.job-title', { href: `/jobs?company=${encodeURIComponent(co.slug)}` }, co.name),
          h('div.job-meta', [co.industry, co.size ? `${co.size} employees` : '', co.location].filter(Boolean).join(', ')),
          h('div.job-meta.fine', plural(co.follower_count, 'follower')))),
      co.description ? h('p.career-text', co.description.length > 400 ? `${co.description.slice(0, 400)}...` : co.description) : null,
      h('a.btn-small', { href: `/jobs?company=${encodeURIComponent(co.slug)}` }, 'View page')),
    job.can_manage ? applicationsSection(ctx, job) : null);
}

function jobActions(job) {
  const row = h('div.row.wrap.job-actions');
  const paint = () => {
    const parts = [];
    if (job.can_manage) {
      parts.push(
        h('button.btn', { type: 'button', onclick: () => editJob(job) }, 'Edit'),
        job.status === 'open'
          ? h('button.btn', { type: 'button', onclick: () => setStatus('close') }, 'Close job')
          : h('button.btn', { type: 'button', onclick: () => setStatus('open') }, 'Reopen'),
        h('button.btn', { type: 'button', onclick: refuseDelete }, 'Delete'));
    } else if (job.application_status) {
      parts.push(h('span.chip', `Applied: ${APPLICATION_STATUS[job.application_status]}`),
        h('button.btn', { type: 'button', onclick: withdraw }, 'Withdraw'));
    } else if (job.status === 'open') {
      parts.push(job.apply_url
        ? h('a.btn', { href: job.apply_url, target: '_blank', rel: 'noopener noreferrer nofollow' }, 'Apply on company site')
        : h('button.btn', { type: 'button', onclick: apply }, 'Apply'));
    }
    if (!job.can_manage && job.status === 'open') parts.push(saveButton(job, { small: false }));
    mount(row, parts);
  };

  async function apply() {
    if (!store.me) return login();
    const note = h('textarea.textarea', { rows: 6, maxLength: 2000, placeholder: 'Why you are a good fit' });
    const res = await formDialog({
      title: `Apply to ${job.company.name}`,
      ok: 'Submit application',
      wide: true,
      content: [
        h('p', job.title),
        h('p.fine', 'The poster sees your note and your career profile.'),
        field('Note', note),
      ],
      onSubmit: () => api.post(`careers/jobs/${job.id}/apply`, { note: note.value }),
    });
    if (!res) return;
    toast('Application sent.');
    refresh();
  }
  async function withdraw() {
    if (!(await confirm('Withdraw your application?', { title: 'Withdraw', ok: 'Withdraw' }))) return;
    try {
      await api.del(`careers/jobs/${job.id}/apply`);
      toast('Application withdrawn.');
      refresh();
    } catch (err) { toastError(err); }
  }
  async function setStatus(which) {
    try {
      if (which === 'close') await api.post(`careers/jobs/${job.id}/close`);
      else await api.patch(`careers/jobs/${job.id}`, { status: 'open' });
      toast(which === 'close' ? 'Job closed.' : 'Job reopened.');
      refresh();
    } catch (err) { toastError(err); }
  }
  paint();
  return row;
}

async function editJob(job) {
  const fields = jobFields(job);
  const res = await formDialog({
    title: 'Edit job',
    wide: true,
    content: fields.content,
    onSubmit: () => api.patch(`careers/jobs/${job.id}`, fields.values()),
  });
  if (res) { toast('Saved.'); refresh(); }
}

const STATUS_ACTIONS = [['viewed', 'Mark viewed'], ['shortlisted', 'Shortlist'], ['rejected', 'Reject']];

function applicationsSection(ctx, job) {
  const filter = ctx.query.get('status') || '';
  const strip = h('div');
  const paintStrip = tally => mount(strip, tabs([
    { href: `/jobs/${job.id}`, label: `All (${count(Object.values(tally || {}).reduce((a, b) => a + b, 0))})`, current: !filter },
    ...Object.entries(APPLICATION_STATUS).map(([key, label]) => ({
      href: `/jobs/${job.id}?status=${key}`, label: `${label} (${count(tally?.[key] || 0)})`, current: filter === key,
    })),
  ]));
  paintStrip(null);

  const render = app => {
    const status = h('span.chip', APPLICATION_STATUS[app.status]);
    const buttons = h('div.row.wrap.career-controls');
    const paintButtons = () => mount(buttons, STATUS_ACTIONS.filter(([key]) => key !== app.status).map(([key, label]) =>
      h('button.btn-small', { type: 'button', onclick: async () => {
        try {
          const res = await api.patch(`careers/applications/${app.id}`, { status: key });
          app.status = res.application.status;
          status.textContent = APPLICATION_STATUS[app.status];
          paintButtons();
          toast(`Marked ${APPLICATION_STATUS[app.status].toLowerCase()}. The applicant has been told.`);
        } catch (err) { toastError(err); }
      } }, label)));
    paintButtons();
    const u = app.user;
    return h('article.south-item.application',
      h('div.application-head',
        avatar(u, { size: 'sm' }),
        h('div.grow',
          userName(u),
          u.headline ? h('div.fine', u.headline) : null,
          h('div.fine', [u.location, `Applied ${timeAgoWords(app.created_at)}`].filter(Boolean).join(', ')),
          u.open_to_work ? h('span.chip.teal', 'Open to work') : null),
        status),
      app.note ? h('p.career-text.application-note', app.note) : h('p.muted', 'No note.'),
      h('div.row.wrap.career-controls', h('a.btn-small', { href: `/@${u.handle}/career` }, 'Career profile'),
        h('a.btn-small', { href: `/messages?to=${encodeURIComponent(u.handle)}` }, 'Message')),
      buttons);
  };

  return h('section.south-card.flat.applications',
    h('h2', 'Applications'),
    strip,
    infiniteList({
      className: 'south-board application-list',
      signal: ctx.signal,
      load: cursor => api.get(`careers/jobs/${job.id}/applications`, { status: filter, cursor }, { signal: ctx.signal }),
      onPage: (_, pageData) => paintStrip(pageData.counts),
      render,
      empty: empty({ title: filter ? 'No applications with this status.' : 'No applications yet.' }),
    }));
}
