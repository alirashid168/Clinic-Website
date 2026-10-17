// "New registrations": patients who made their own login on the website (views/register.js) and wait for the clinic's word (the owner,
// 17 Oct 2026: "the staff get a button for new user approvals for the patients who registered themselves"). Each row shows what the
// patient typed beside the patient file it matched (name, Mr#, phone, branch), with Approve and Reject. Until approved, the login opens
// only a waiting screen; a rejection removes the login again. For the people who create patient logins (portal.invite).
import { h, mount, toast, friendlyError, modal, field, empty, shortDate, phoneLink, busy } from '../../ui/dom.js';
import { state, branchName } from '../../state.js';

export async function renderRegistrations(root) {
  const d = state.data;
  const list = h('div', {});
  const count = (n) => window.dispatchEvent(new CustomEvent('registrations-count', { detail: n }));

  const reject = (r) => {
    const reason = h('input', { type: 'text', maxlength: 300, placeholder: 'For example: the number is not this patient\'s' });
    modal(`Reject the registration of ${r.typed_name}?`, h('div', {},
      h('p', {}, 'The login made by this registration is removed; the patient can register again or ask the clinic for a login.'),
      field('Reason (optional, for the audit log)', reason)), [
      { label: 'Cancel' },
      { label: 'Reject', primary: true, onClick: async () => {
        try { await d.rejectRegistration(r.patient_id, reason.value.trim()); } catch (e) { toast(friendlyError(e), 'error'); return false; }
        toast('Registration rejected.', 'ok');
        await draw();
        return undefined;
      } },
    ], { initialFocus: reason });
  };

  const approve = async (r) => {
    try { await d.approveRegistration(r.patient_id); } catch (e) { toast(friendlyError(e), 'error'); return; }
    toast(`${r.full_name} can log in now.`, 'ok');
    await draw();
  };

  async function draw() {
    let rows;
    try { rows = await d.pendingRegistrations(); } catch (e) { mount(list, h('p', { class: 'status-bad' }, friendlyError(e))); return; }
    count(rows.length);
    mount(list, rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list registrations-list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Registered'), h('th', { scope: 'col' }, 'Typed on the website'), h('th', { scope: 'col' }, 'Patient file it matched'), h('th', { scope: 'col' }, 'Decision'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'nowrap' }, shortDate(r.created_at.slice(0, 10))),
        h('td', {}, h('strong', {}, r.typed_name), h('div', { class: 'muted' }, `Mobile ${r.typed_phone}`)),
        h('td', {}, h('a', { href: `#/staff/patient/${r.patient_id}` }, r.full_name), ' ', h('span', { class: 'mr' }, `Mr# ${r.mr_number}`),
          h('div', { class: 'muted' }, r.phone ? phoneLink(r.phone) : 'No phone on file', r.first_branch_id ? ` · ${branchName(r.first_branch_id)}` : '')),
        h('td', { class: 'nowrap' }, h('span', { class: 'inline' },
          h('button', { class: 'btn btn-small btn-primary', onclick: busy(() => approve(r)) }, 'Approve'),
          h('button', { class: 'btn btn-small', onclick: () => reject(r) }, 'Reject'))))))))
      : empty('Nobody is waiting. Patients who register on the website (Patient login → Register) appear here.'));
  }

  mount(root,
    h('p', {}, h('a', { href: '#/staff/patients' }, '← Patients')),
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'New registrations'),
      h('p', { class: 'muted' }, 'Patients who made their own login on the website with their name, Mr# and mobile number. The details already matched their file; check that the person is who they say (a shared family number, say), then Approve. Until then they see only a waiting screen.'))),
    h('section', { class: 'panel' }, list));
  await draw();
}
