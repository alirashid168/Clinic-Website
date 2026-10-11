// Job applications: what visitors sent with the website's "Join our team" form (#/join). Only people with "Job applications
// (CNIC, phone and CV)" in the access list (jobs.view, Dr. Ali by default) see this page, and the database shows the rows,
// the CNIC, the phone and the CV files to nobody else. Newest first, filters for status, job and branch; one dialog per
// application with the CV (a link that works for one minute), the status, internal notes, and who changed what when.
//
// Everything an applicant typed is shown as text (text nodes), never as HTML.
import { h, mount, toast, friendlyError, modal, field, select, empty, shortDate, timeOf, phoneLink, showFormErrors } from '../../ui/dom.js';
import { state, branchName } from '../../state.js';
import { capNote } from './common.js';
import { POSITIONS, POSITION_LABELS, JOB_STATUSES, JOB_STATUS_LABELS, LIMITS, formatPhone } from '../../lib/public-forms.js';

const STATUS_BADGE = { new: 'badge-dues', contacted: 'badge-warn', interview: 'badge-photo', hired: 'badge-ok', rejected: 'badge-muted' };
const when = (ts) => (ts ? `${shortDate(ts)}, ${timeOf(ts)}` : '');
const fileSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const FILE_KIND = { 'application/pdf': 'PDF', 'application/msword': 'Word', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word', 'image/jpeg': 'JPG', 'image/png': 'PNG' };
const branchText = (id) => (id ? branchName(id) || 'A branch that is closed now' : 'Any branch');
const statusBadge = (s) => h('span', { class: ['badge', STATUS_BADGE[s] || 'badge-muted'] }, JOB_STATUS_LABELS[s] || s);

/** Opens the CV in a new tab through a link that works for one minute. The tab is opened at the click, then pointed at the link. */
async function openCv(app) {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const url = await state.data.jobCvUrl(app.cv_path);
    if (tab) tab.location = url; else location.assign(url);
  } catch (e) {
    tab?.close();
    toast(friendlyError(e), 'error');
  }
}

/** One line of the history: "12 Oct 2026, 14:05 · Dr. Ali Rashid · Status: Interview" or the note itself. */
function historyLine(e) {
  return h('li', {},
    h('span', { class: 'muted' }, `${when(e.created_at)} · ${e.by_name || 'Staff'}`),
    e.kind === 'status' ? h('div', {}, 'Status changed to ', h('strong', {}, JOB_STATUS_LABELS[e.status] || e.status))
      : h('div', { class: 'pre-wrap' }, e.body));
}

export async function renderJobs(root, params) {
  const d = state.data;
  const filters = { status: params?.get('status') || '', position: params?.get('position') || '', branch: params?.get('branch') || '' };
  const statusSel = select([{ value: '', label: 'All statuses' }, ...JOB_STATUSES], filters.status, { 'aria-label': 'Status' });
  const positionSel = select([{ value: '', label: 'All jobs' }, ...POSITIONS], filters.position, { 'aria-label': 'Job' });
  const branchSel = select([{ value: '', label: 'All branches' }, ...state.ref.branches.map((b) => ({ value: b.id, label: b.name })), { value: 'any', label: 'Any branch' }],
    filters.branch, { 'aria-label': 'Preferred branch' });
  const cleanup = h('div', {});
  const out = h('div', {});
  let newest = 0;

  // The filters stay in the address, so a reload or a shared link shows the same list.
  const keepInAddress = () => {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
    history.replaceState(null, '', `#/staff/jobs${q ? '?' + q : ''}`);
  };

  async function load() {
    const mine = ++newest; // a slow answer for the filters just left must not overwrite the one on screen
    let rows;
    try { rows = await d.jobApplications(filters); } catch (e) { if (mine === newest) mount(out, empty(friendlyError(e))); return; }
    if (mine !== newest) return;
    const filtered = !!(filters.status || filters.position || filters.branch);
    mount(out, h('section', { class: 'panel' },
      capNote(rows, 'applications', 'use the filters to see the others'),
      rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list jobs-table' },
        h('caption', { class: 'sr-only' }, 'Job applications, newest first'),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Received'), h('th', { scope: 'col' }, 'Applicant'), h('th', { scope: 'col' }, 'Mobile'),
          h('th', { scope: 'col' }, 'Qualification'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Status'))),
        h('tbody', {}, rows.map((a) => h('tr', { dataset: { id: a.id } },
          h('td', { class: 'nowrap' }, shortDate(a.created_at)),
          h('td', {}, h('button', { type: 'button', class: 'link-btn', onclick: () => open(a), 'aria-label': `Open the application of ${a.full_name}` }, a.full_name),
            h('div', { class: 'muted' }, POSITION_LABELS[a.position] || a.position)),
          h('td', { class: 'nowrap' }, formatPhone(a.phone)),
          h('td', {}, a.qualification),
          h('td', {}, branchText(a.branch_id)),
          h('td', {}, statusBadge(a.status)))))))
        : empty(filtered ? 'No applications match these filters.' : 'No applications yet. They arrive here from the "Join our team" form on the website.')));
  }

  // CVs uploaded more than a day ago but never sent with a form (the visitor gave up, or a check failed): listed, and removable.
  async function loadCleanup() {
    let list = [];
    try { list = await d.jobCvOrphans(); } catch { list = []; }
    if (!list.length) { mount(cleanup); return; }
    const button = h('button', { type: 'button', class: 'btn btn-small', onclick: async () => {
      button.disabled = true;
      try { const n = await d.removeJobCvOrphans(list.map((x) => x.path)); toast(`${n} unused file${n === 1 ? '' : 's'} removed.`, 'ok'); } catch (e) { toast(friendlyError(e), 'error'); }
      await loadCleanup();
    } }, 'Remove them');
    mount(cleanup, h('div', { class: 'alert alert-info jobs-cleanup', role: 'status' },
      `${list.length} CV file${list.length === 1 ? ' was' : 's were'} uploaded but never sent with a form (more than a day ago). They belong to no application. `, button));
  }

  function open(a) {
    const statusPick = select(JOB_STATUSES, a.status, {});
    const note = h('textarea', { rows: 3, maxlength: LIMITS.note + 50, placeholder: 'For example: called, interview on Saturday at 4 pm' });
    const detail = (label, value) => (value === null || value === undefined || value === '' ? null : h('div', { class: 'job-detail' }, h('dt', {}, label), h('dd', {}, value)));
    const cvButton = h('button', { type: 'button', class: 'btn btn-small', onclick: () => openCv(a) },
      `Open CV (${FILE_KIND[a.cv_type] || 'file'}, ${fileSize(a.cv_size)})`);
    const body = h('div', { class: 'job-dialog' },
      h('dl', { class: 'job-details' },
        detail('Job', POSITION_LABELS[a.position] || a.position),
        detail('Qualification', a.qualification),
        detail('Graduated', a.graduation_year ? String(a.graduation_year) : null),
        detail('Experience', a.experience),
        detail('Preferred branch', branchText(a.branch_id)),
        detail('Mobile', phoneLink(formatPhone(a.phone))),
        detail('Email', a.email ? h('a', { href: `mailto:${a.email}` }, a.email) : null),
        detail('CNIC', a.cnic),
        detail('Received', when(a.created_at)),
        detail('Message', a.message ? h('div', { class: 'pre-wrap' }, a.message) : null)),
      h('p', {}, cvButton, ' ', h('span', { class: 'muted' }, 'The link works for one minute.')),
      h('div', { class: 'form-grid' }, field('Status', statusPick)),
      field('Internal note', note, 'Only staff who see job applications read notes. The applicant never sees them.'),
      a.events?.length ? h('div', {}, h('h3', {}, 'History'), h('ol', { class: 'job-history' }, a.events.map(historyLine))) : h('p', { class: 'muted' }, 'No changes yet.'));
    modal(a.full_name, body, [
      { label: 'Close' },
      { label: 'Save', primary: true, onClick: async () => {
        const status = statusPick.value !== a.status ? statusPick.value : null;
        const text = note.value.trim();
        if (!status && !text) return showFormErrors(body, [{ input: note, message: 'Choose another status or write a note first.' }]);
        if (text.length > LIMITS.note) return showFormErrors(body, [{ input: note, message: `A note can have at most ${LIMITS.note.toLocaleString('en-PK')} characters.` }]);
        try { await d.updateJobApplication(a.id, { status, note: text || null }); } catch (e) { toast(friendlyError(e), 'error'); return false; }
        toast('Saved.', 'ok');
        await load(); // the list is redrawn before this dialog closes, so focus can return to the page
      } },
    ]);
  }

  for (const [sel, key] of [[statusSel, 'status'], [positionSel, 'position'], [branchSel, 'branch']]) {
    sel.addEventListener('change', () => { filters[key] = sel.value; keepInAddress(); load(); });
  }
  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Job applications'),
        h('p', {}, 'Sent with the "Join our team" form on the website. Only people with "Job applications" in the access list see them.')),
      h('div', { class: 'inline jobs-filters' },
        h('label', { class: 'inline' }, 'Status ', statusSel), h('label', { class: 'inline' }, 'Job ', positionSel), h('label', { class: 'inline' }, 'Branch ', branchSel))),
    cleanup,
    out);
  await Promise.all([load(), loadCleanup()]);
}
