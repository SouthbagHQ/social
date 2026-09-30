// Careers (LinkedIn): the profile headline, the profile's Career tab, and pieces the jobs pages share.
//   profileHeadline(user) -> Node|null     under the name in the profile header
//   careerTab(ctx, user, viewer) -> Node   About, Experience, Education, Skills, Recommendations
//   GET /api/careers/profile/:handle, PATCH /api/careers/profile, /experiences, /educations, /skills,
//   /endorse/:handle/:skill, /recommendations…  (see src/routes/careers.ts)

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { plural, timeAgo } from '../format.js';
import { refresh } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, errorBox, loading, promptDialog, shake, toast, toastError } from '../ui.js';
import { avatar, userName } from './user.js';

// -- Labels and formatting ---------------------------------------------------

export const WORKPLACES = { onsite: 'On-site', hybrid: 'Hybrid', remote: 'Remote' };
export const JOB_TYPES = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', casual: 'Casual', internship: 'Internship' };
export const EMPLOYMENT_TYPES = { ...JOB_TYPES, self_employed: 'Self-employed', volunteer: 'Volunteer' };
export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+'];
export const APPLICATION_STATUS = { submitted: 'Submitted', viewed: 'Viewed', shortlisted: 'Shortlisted', rejected: 'Not selected' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parseMonth = s => { const m = /^(\d{4})-(\d{2})$/.exec(s || ''); return m ? [Number(m[1]), Number(m[2])] : null; };
const thisMonth = () => { const d = new Date(); return [d.getFullYear(), d.getMonth() + 1]; };

/** '2022-03' -> 'Mar 2022' */
export const monthLabel = s => { const p = parseMonth(s); return p ? `${MONTHS[p[1] - 1]} ${p[0]}` : ''; };

/** Inclusive length of a role: '2 yrs 7 mos', '1 yr', '4 mos'. */
export function tenure(start, end) {
  const a = parseMonth(start), b = parseMonth(end) || thisMonth();
  if (!a) return '';
  const months = Math.max(1, (b[0] * 12 + b[1]) - (a[0] * 12 + a[1]) + 1);
  const y = Math.floor(months / 12), m = months % 12;
  return [y ? `${y} ${y === 1 ? 'yr' : 'yrs'}` : '', m ? `${m} ${m === 1 ? 'mo' : 'mos'}` : ''].filter(Boolean).join(' ');
}

/** 'Mar 2022 - Present, 2 yrs 7 mos' */
export const roleDates = e => `${monthLabel(e.start_month)} - ${e.end_month ? monthLabel(e.end_month) : 'Present'}, ${tenure(e.start_month, e.end_month)}`;

const dollars = n => `$${Number(n).toLocaleString('en-AU')}`;

/** '$120,000 - $150,000 AUD a year', or '' when there is no salary. */
export function salaryLabel(job) {
  const { salary_min: min, salary_max: max } = job;
  const cur = job.currency || 'AUD';
  if (min != null && max != null) return min === max ? `${dollars(min)} ${cur} a year` : `${dollars(min)} - ${dollars(max)} ${cur} a year`;
  if (min != null) return `From ${dollars(min)} ${cur} a year`;
  if (max != null) return `Up to ${dollars(max)} ${cur} a year`;
  return '';
}

export const posted = ms => {
  const t = timeAgo(ms);
  return t === 'now' ? 'Posted just now' : /^\d+[mhd]$/.test(t) ? `Posted ${t} ago` : `Posted ${t}`;
};

/** A square box; the company logo is stretched to fill it. Its initial when there is no logo. */
export function companyLogo(company, size = '') {
  const inner = company?.logo_url
    ? h('img', { src: company.logo_url, alt: '', loading: 'lazy' })
    : h('span.initial', (company?.name || 'c').trim().charAt(0).toUpperCase());
  const cls = { [size]: Boolean(size) };
  return company?.slug
    ? h('a.company-logo', { href: `/jobs?company=${encodeURIComponent(company.slug)}`, class: cls, 'aria-label': company.name, tabIndex: -1 }, inner)
    : h('span.company-logo', { class: cls }, inner);
}

// -- Forms -------------------------------------------------------------------

export const field = (label, input, hint) =>
  h('label.field', h('span', label), input, hint ? h('small.fine', hint) : null);

export const select = (options, value, props = {}) =>
  h('select.select', props, options.map(([v, label]) => h('option', { value: v, selected: v === (value ?? '') }, label)));

/**
 * A dialog holding a form. `onSubmit()` may throw; the dialog stays open and shows the error.
 * Resolves with what onSubmit returned, or null if closed.
 */
export function formDialog({ title, content, ok = 'Save', onSubmit, wide = false }) {
  return dialog({
    title, wide, actions: [],
    body: close => {
      const submit = h('button', { type: 'submit' }, ok);
      const form = h('form.career-form', {
        onsubmit: async e => {
          e.preventDefault();
          submit.disabled = true;
          try {
            const result = await onSubmit();
            close(result ?? true);
          } catch (err) {
            toastError(err);
            shake(form);
            submit.disabled = false;
          }
        },
      }, content, h('div.career-form-actions', h('button', { type: 'button', onclick: () => close(null) }, 'Cancel'), submit));
      return form;
    },
  });
}

// -- Job rows (shared with the jobs pages) -----------------------------------

/** A job as a row: logo, title, company, place, salary, posted time and a Save button. */
export function jobRow(job, { extra = null, save = true } = {}) {
  const meta = [job.location, WORKPLACES[job.workplace], JOB_TYPES[job.employment_type]].filter(Boolean).join(', ');
  const salary = salaryLabel(job);
  return h('article.south-item.job-row',
    companyLogo(job.company),
    h('div.grow',
      h('a.job-title', { href: `/jobs/${job.id}` }, job.title),
      h('div.job-company', job.company.slug ? h('a', { href: `/jobs?company=${encodeURIComponent(job.company.slug)}` }, job.company.name) : job.company.name),
      meta ? h('div.job-meta', meta) : null,
      salary ? h('div.job-meta', salary) : null,
      h('div.job-meta.fine',
        posted(job.created_at),
        job.applicant_count ? `, ${plural(job.applicant_count, 'applicant')}` : '',
        job.status === 'closed' ? ', closed' : ''),
      job.application_status ? h('div.row.wrap.job-chips', h('span.chip', `Applied: ${APPLICATION_STATUS[job.application_status]}`)) : null,
      extra),
    save && job.status !== 'closed' && !job.can_manage ? saveButton(job) : null);
}

export function saveButton(job, { small = true } = {}) {
  let saved = Boolean(job.saved);
  const btn = h(small ? 'button.btn-small' : 'button.btn', { type: 'button' });
  const paint = () => { btn.textContent = saved ? 'Saved' : 'Save'; btn.setAttribute('aria-pressed', String(saved)); };
  btn.addEventListener('click', async () => {
    if (!store.me) return login();
    btn.disabled = true;
    try {
      if (saved) await api.del(`careers/jobs/${job.id}/save`);
      else await api.put(`careers/jobs/${job.id}/save`);
      saved = !saved;
      job.saved = saved;
      paint();
      toast(saved ? 'Saved.' : 'Removed from saved jobs.');
    } catch (err) { toastError(err); }
    btn.disabled = false;
  });
  paint();
  return btn;
}

// -- Profile header ----------------------------------------------------------

export function profileHeadline(user) {
  if (!user?.headline && !user?.open_to_work) return null;
  return h('div.career-headline',
    user.headline ? h('p.career-headline-text', user.headline) : null,
    user.open_to_work ? h('span.chip.teal.open-to-work', 'Open to work') : null);
}

// -- Career tab --------------------------------------------------------------

export function careerTab(ctx, user, viewer) {
  const root = h('div.career', loading());
  const load = async () => {
    try {
      const data = await api.get(`careers/profile/${encodeURIComponent(user.handle)}`, null, { signal: ctx.signal });
      const requests = data.viewer.is_me
        ? await api.get('careers/recommendations', null, { signal: ctx.signal }).catch(() => null)
        : null;
      mount(root, render(data, requests, load));
    } catch (err) {
      if (err.name === 'AbortError') return;
      mount(root, errorBox(err));
    }
  };
  load();
  return root;
}

function section(title, action, ...children) {
  return h('section.south-card.flat.career-section',
    h('div.career-section-head', h('h2', title), h('span.spacer'), action || null),
    children);
}

function render(data, inbox, reload) {
  const me = data.viewer.is_me;
  return [
    about(data, me),
    experienceSection(data, me, reload),
    educationSection(data, me, reload),
    skillsSection(data, me, reload),
    recommendationsSection(data, inbox, me, reload),
  ];
}

/** Buttons that move an item within its list, then save the new order. */
function orderControls(list, index, key, path, reload) {
  const move = async delta => {
    const keys = list.map(x => x[key]);
    const [item] = keys.splice(index, 1);
    keys.splice(index + delta, 0, item);
    try {
      await api.put(path, key === 'name' ? { names: keys } : { ids: keys });
      reload();
    } catch (err) { toastError(err); }
  };
  return [
    h('button.btn-small', { type: 'button', disabled: index === 0, onclick: () => move(-1) }, 'Move up'),
    h('button.btn-small', { type: 'button', disabled: index === list.length - 1, onclick: () => move(1) }, 'Move down'),
  ];
}

async function removeItem(message, path, reload) {
  if (!(await confirm(message, { title: 'Remove', ok: 'Remove' }))) return;
  try {
    await api.del(path);
    toast('Removed.');
    reload();
  } catch (err) { toastError(err); }
}

// About: headline and open to work.
function about(data, me) {
  const { user } = data;
  const body = [
    user.headline ? h('p.career-about', user.headline) : h('p.muted', me ? 'Add a headline so people know what you do.' : 'No headline yet.'),
    !me && user.open_to_work ? h('p', h('span.chip.teal', 'Open to work')) : null,
  ];
  if (!me) return section('About', null, body);

  const toggle = h('input', { type: 'checkbox', checked: user.open_to_work });
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      const res = await api.patch('careers/profile', { open_to_work: toggle.checked });
      toast(res.open_to_work ? 'Open to work is on.' : 'Open to work is off.');
      refresh();
    } catch (err) {
      toggle.checked = !toggle.checked;
      toastError(err);
    }
    toggle.disabled = false;
  });
  const edit = h('button.btn-small', { type: 'button', onclick: async () => {
    const value = await promptDialog('Headline', { title: 'Edit headline', value: user.headline, placeholder: 'Warehouse supervisor at Harbour Freight', ok: 'Save' });
    if (value === null) return;
    try {
      await api.patch('careers/profile', { headline: value });
      toast('Saved.');
      refresh();
    } catch (err) { toastError(err); }
  } }, 'Edit');
  return section('About', edit, body,
    h('label.checkbox.career-toggle', toggle, h('span', 'Open to work', h('small.fine', ' Shows on your profile and to recruiters.'))));
}

// Experience
function experienceSection(data, me, reload) {
  const list = data.experiences;
  const add = me ? h('button.btn-small', { type: 'button', onclick: () => experienceDialog(null, reload) }, 'Add') : null;
  const items = list.map((e, i) => h('div.career-item',
    companyLogo(e.company || { name: e.company_name }),
    h('div.grow',
      h('strong.career-item-title', e.title),
      h('div', e.company ? h('a', { href: `/jobs?company=${encodeURIComponent(e.company.slug)}` }, e.company_name) : e.company_name,
        `, ${EMPLOYMENT_TYPES[e.employment_type] || ''}`),
      h('div.fine', roleDates(e)),
      e.location ? h('div.fine', e.location) : null,
      e.description ? h('p.career-text', e.description) : null,
      me ? h('div.career-controls',
        h('button.btn-small', { type: 'button', onclick: () => experienceDialog(e, reload) }, 'Edit'),
        h('button.btn-small', { type: 'button', onclick: () => removeItem(`Remove ${e.title} at ${e.company_name}?`, `careers/experiences/${e.id}`, reload) }, 'Remove'),
        orderControls(list, i, 'id', 'careers/experiences/order', reload)) : null)));
  return section('Experience', add, items.length ? items : h('p.muted', 'No experience added.'));
}

async function experienceDialog(e, reload) {
  const companies = h('datalist#career-companies');
  api.get('careers/companies', { limit: 50 }).then(res => mount(companies, res.items.map(c => h('option', { value: c.name })))).catch(() => {});
  const title = h('input.input', { required: true, maxLength: 100, value: e?.title || '', placeholder: 'Warehouse supervisor' });
  const company = h('input.input', { required: true, maxLength: 100, value: e?.company_name || '', list: 'career-companies', placeholder: 'Company' });
  const type = select(Object.entries(EMPLOYMENT_TYPES), e?.employment_type || 'full_time');
  const location = h('input.input', { maxLength: 100, value: e?.location || '', placeholder: 'Sydney, NSW' });
  const start = h('input.input', { type: 'month', required: true, value: e?.start_month || '', placeholder: 'YYYY-MM' });
  const end = h('input.input', { type: 'month', value: e?.end_month || '', placeholder: 'YYYY-MM', disabled: e ? e.current : true });
  const current = h('input', { type: 'checkbox', checked: e ? e.current : true, onchange: () => { end.disabled = current.checked; } });
  const description = h('textarea.textarea', { rows: 4, maxLength: 2000, value: e?.description || '' });
  const saved = await formDialog({
    title: e ? 'Edit experience' : 'Add experience',
    wide: true,
    content: [
      companies,
      field('Title', title),
      field('Company', company, 'Type the name of a company page to link it.'),
      h('div.career-form-grid', field('Employment type', type), field('Location', location)),
      h('label.checkbox', current, h('span', 'I work here now')),
      h('div.career-form-grid', field('Start', start), field('End', end)),
      field('Description', description),
    ],
    onSubmit: () => {
      const payload = {
        title: title.value, company_name: company.value, employment_type: type.value, location: location.value,
        start_month: start.value, end_month: current.checked ? null : end.value || null, description: description.value,
      };
      return e ? api.patch(`careers/experiences/${e.id}`, payload) : api.post('careers/experiences', payload);
    },
  });
  if (saved) { toast('Saved.'); reload(); }
}

// Education
function educationSection(data, me, reload) {
  const list = data.educations;
  const add = me ? h('button.btn-small', { type: 'button', onclick: () => educationDialog(null, reload) }, 'Add') : null;
  const items = list.map((e, i) => h('div.career-item',
    companyLogo({ name: e.school }),
    h('div.grow',
      h('strong.career-item-title', e.school),
      e.degree || e.field ? h('div', [e.degree, e.field].filter(Boolean).join(', ')) : null,
      e.start_year || e.end_year ? h('div.fine', [e.start_year, e.end_year].filter(Boolean).join(' - ')) : null,
      e.description ? h('p.career-text', e.description) : null,
      me ? h('div.career-controls',
        h('button.btn-small', { type: 'button', onclick: () => educationDialog(e, reload) }, 'Edit'),
        h('button.btn-small', { type: 'button', onclick: () => removeItem(`Remove ${e.school}?`, `careers/educations/${e.id}`, reload) }, 'Remove'),
        orderControls(list, i, 'id', 'careers/educations/order', reload)) : null)));
  return section('Education', add, items.length ? items : h('p.muted', 'No education added.'));
}

async function educationDialog(e, reload) {
  const school = h('input.input', { required: true, maxLength: 120, value: e?.school || '', placeholder: 'University of Sydney' });
  const degree = h('input.input', { maxLength: 120, value: e?.degree || '', placeholder: 'Bachelor of Commerce' });
  const fieldOf = h('input.input', { maxLength: 120, value: e?.field || '', placeholder: 'Accounting' });
  const start = h('input.input', { type: 'number', min: 1900, max: 2100, value: e?.start_year ?? '', placeholder: '2016' });
  const end = h('input.input', { type: 'number', min: 1900, max: 2100, value: e?.end_year ?? '', placeholder: '2019' });
  const description = h('textarea.textarea', { rows: 3, maxLength: 1000, value: e?.description || '' });
  const saved = await formDialog({
    title: e ? 'Edit education' : 'Add education',
    wide: true,
    content: [
      field('School', school),
      h('div.career-form-grid', field('Degree', degree), field('Field of study', fieldOf)),
      h('div.career-form-grid', field('Start year', start), field('End year', end)),
      field('Description', description),
    ],
    onSubmit: () => {
      const payload = {
        school: school.value, degree: degree.value, field: fieldOf.value,
        start_year: start.value || null, end_year: end.value || null, description: description.value,
      };
      return e ? api.patch(`careers/educations/${e.id}`, payload) : api.post('careers/educations', payload);
    },
  });
  if (saved) { toast('Saved.'); reload(); }
}

// Skills and endorsements
function skillsSection(data, me, reload) {
  const list = data.skills;
  const { user, viewer } = data;
  const add = me ? h('button.btn-small', { type: 'button', onclick: async () => {
    const name = await promptDialog('Skill', { title: 'Add skill', placeholder: 'Forklift licence', ok: 'Add' });
    if (!name) return;
    try {
      await api.post('careers/skills', { name });
      toast('Skill added.');
      reload();
    } catch (err) { toastError(err); }
  } }, 'Add') : null;

  const items = list.map((s, i) => {
    const countEl = h('span.fine', plural(s.endorsement_count, 'endorsement'));
    let endorse = null;
    if (!me && viewer.can_endorse) {
      let on = s.endorsed;
      endorse = h('button.btn-small', { type: 'button', 'aria-pressed': String(on) }, on ? 'Endorsed' : 'Endorse');
      endorse.addEventListener('click', async () => {
        endorse.disabled = true;
        try {
          const path = `careers/endorse/${encodeURIComponent(user.handle)}/${encodeURIComponent(s.name)}`;
          const res = on ? await api.del(path) : await api.put(path);
          on = res.skill.endorsed;
          s.endorsement_count = res.skill.endorsement_count;
          countEl.textContent = plural(s.endorsement_count, 'endorsement');
          endorse.textContent = on ? 'Endorsed' : 'Endorse';
          endorse.setAttribute('aria-pressed', String(on));
          if (on) toast(`Endorsed ${user.name} for ${s.name}.`);
        } catch (err) { toastError(err); }
        endorse.disabled = false;
      });
    }
    return h('div.career-skill',
      h('div.grow', h('strong', s.name), ' ', countEl),
      endorse,
      me ? h('div.career-controls',
        h('button.btn-small', { type: 'button', onclick: () => removeItem(`Remove ${s.name}? Its endorsements go with it.`, `careers/skills/${encodeURIComponent(s.name)}`, reload) }, 'Remove'),
        orderControls(list, i, 'name', 'careers/skills/order', reload)) : null);
  });
  const note = !me && store.me && !viewer.can_endorse && list.length
    ? h('p.fine', 'Friends, and people who follow each other, can endorse skills.') : null;
  return section('Skills', add, items.length ? items : h('p.muted', 'No skills added.'), note);
}

// Recommendations
function recommendationCard(r, { me, reload }) {
  const status = r.status === 'pending' ? 'Waiting for approval' : r.status === 'hidden' ? 'Hidden' : null;
  const setStatus = async value => {
    try {
      await api.patch(`careers/recommendations/${r.id}`, { status: value });
      toast(value === 'visible' ? 'Shown on your profile.' : 'Hidden.');
      reload();
    } catch (err) { toastError(err); }
  };
  const mine = store.me && r.author.id === store.me.id;
  return h('div.career-rec',
    avatar(r.author, { size: 'sm' }),
    h('div.grow',
      userName(r.author, { handle: false }),
      r.author.headline ? h('div.fine', r.author.headline) : null,
      r.relationship ? h('div.fine', r.relationship) : null,
      h('p.career-text', r.body),
      h('div.row.wrap.career-controls',
        status ? h('span.chip', status) : null,
        me && r.status !== 'visible' ? h('button.btn-small', { type: 'button', onclick: () => setStatus('visible') }, 'Show') : null,
        me && r.status === 'visible' ? h('button.btn-small', { type: 'button', onclick: () => setStatus('hidden') }, 'Hide') : null,
        me || mine ? h('button.btn-small', { type: 'button', onclick: () => removeItem('Delete this recommendation?', `careers/recommendations/${r.id}`, reload) }, 'Delete') : null)));
}

async function writeRecommendation(person, existing, reload) {
  const relationship = h('input.input', { maxLength: 100, value: existing?.relationship || '', placeholder: 'Worked together at Harbour Freight' });
  const text = h('textarea.textarea', { rows: 6, maxLength: 3000, required: true, value: existing?.body || '' });
  const saved = await formDialog({
    title: 'Recommendation',
    wide: true,
    ok: 'Send',
    content: [
      h('p.fine', `${person.name} approves it before it shows on their profile.`),
      field('How you know them', relationship),
      field('Recommendation', text),
    ],
    onSubmit: () => api.put(`careers/recommendations/${encodeURIComponent(person.handle)}`, { relationship: relationship.value, body: text.value }),
  });
  if (saved) { toast('Sent.'); reload(); }
}

function recommendationsSection(data, inbox, me, reload) {
  const { user, viewer } = data;
  const recs = data.recommendations;
  const children = [];

  if (!me && viewer.can_recommend) {
    const mineExisting = store.me ? recs.find(r => r.author.id === store.me.id) : null;
    const ask = h('button.btn-small', { type: 'button', disabled: viewer.you_asked }, viewer.you_asked ? 'Asked' : 'Ask for a recommendation');
    ask.addEventListener('click', async () => {
      ask.disabled = true;
      try {
        await api.post(`careers/recommendations/requests/${encodeURIComponent(user.handle)}`, {});
        ask.textContent = 'Asked';
        toast('Request sent.');
      } catch (err) { toastError(err); ask.disabled = false; }
    });
    if (viewer.asked_you) children.push(h('p.notice', `${user.name} asked you for a recommendation.`));
    children.push(h('div.row.wrap.career-controls',
      h('button.btn-small', { type: 'button', onclick: () => writeRecommendation(user, mineExisting, reload) }, mineExisting ? 'Edit your recommendation' : 'Write a recommendation'),
      ask));
  }

  if (me && inbox?.requests?.length) {
    children.push(h('div.career-requests',
      h('h3', 'Requests'),
      inbox.requests.map(q => h('div.user-row',
        avatar(q.user, { size: 'sm' }),
        h('div.grow', userName(q.user), q.message ? h('div.bio', q.message) : null),
        h('div.row',
          h('button.btn-small', { type: 'button', onclick: () => writeRecommendation(q.user, null, reload) }, 'Write'),
          h('button.btn-small', { type: 'button', onclick: async () => {
            try { await api.del(`careers/recommendations/requests/${encodeURIComponent(q.user.handle)}`); toast('Declined.'); reload(); }
            catch (err) { toastError(err); }
          } }, 'Decline'))))));
  }

  children.push(recs.length
    ? recs.map(r => recommendationCard(r, { me, reload }))
    : h('p.muted', 'No recommendations yet.'));
  return section('Recommendations', null, children);
}

