// Patient portal: invoices, dues, X-rays and photos, visit history, the
// "see Dr. Ali" message, ratings and the complaint button.
import { h, mount, rupees, shortDate, toast, friendlyError, modal, field, empty } from '../ui/dom.js';
import { state, branchName } from '../state.js';
import { printInvoice } from './staff/invoice.js';

export async function renderPortal(root, signOut) {
  const d = state.data;
  const me = state.session.patient;
  const [p, ratings] = await Promise.all([d.getPatient(me.id), d.myRatings().catch(() => [])]);
  const rated = new Set(ratings.map((r) => r.visit_id));
  const completed = p.visits.filter((v) => v.status === 'completed');

  const rate = (visit) => {
    let stars = 0;
    const comment = h('textarea', { placeholder: 'Anything we should know? (optional)' });
    const starRow = h('div', { class: 'stars', role: 'radiogroup', 'aria-label': 'Rating' });
    const draw = () => mount(starRow, [1, 2, 3, 4, 5].map((n) => h('button', {
      type: 'button', class: n <= stars ? 'on' : '', 'aria-label': `${n} star${n > 1 ? 's' : ''}`, onclick: () => { stars = n; draw(); },
    }, '★')));
    draw();
    modal(`Rate your visit on ${shortDate(visit.visit_date)}`, h('div', {}, starRow, field('Comment', comment)), [
      { label: 'Cancel' },
      { label: 'Send rating', primary: true, onClick: async () => {
        if (!stars) { toast('Tap a star first.'); return false; }
        try { await d.rateVisit(visit.id, stars, comment.value); toast('Thank you for your rating.', 'ok'); renderPortal(root, signOut); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  const complain = () => {
    const subject = h('input', { placeholder: 'For example: waiting time, treatment, billing' });
    const body = h('textarea', { placeholder: 'Tell Dr. Ali what happened' });
    modal('Report or complain to Dr. Ali Rashid', h('div', {},
      h('p', { class: 'muted' }, 'Your message goes directly to Dr. Ali and the clinic coordinator.'),
      field('Subject', subject), field('Message', body)), [
      { label: 'Cancel' },
      { label: 'Send to Dr. Ali', primary: true, onClick: async () => {
        if (!subject.value.trim() || !body.value.trim()) { toast('Add a subject and a message.'); return false; }
        try { await d.fileComplaint({ subject: subject.value.trim(), body: body.value.trim() }); toast('Sent to Dr. Ali.', 'ok'); renderPortal(root, signOut); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  const issued = p.invoices.filter((i) => i.status === 'issued');
  mount(root,
    h('div', { class: 'mobile-bar', style: { display: 'flex' } },
      h('strong', {}, "Dr. Ali Rashid's Dental Clinic"),
      h('button', { class: 'link-btn', onclick: signOut }, 'Log out')),
    h('main', { class: 'public-main stack', style: { paddingTop: '24px' } },
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, `Hello, ${p.full_name.split(' ')[0]}`), h('p', {}, `Mr# ${p.mr_number}`)),
        h('button', { class: 'btn btn-primary', onclick: complain }, 'Report / complain to Dr. Ali Rashid')),
      p.flag ? h('div', { class: 'alert alert-warning' }, h('strong', {}, 'Please get your next appointment done by Dr. Ali Rashid. '),
        'Check ', h('a', { href: '#/' }, "Dr. Ali's days at each branch"), ' and come on one of those days.') : null,
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat' }, h('strong', {}, rupees(Math.max(0, p.dues))), h('span', {}, p.dues > 0 ? 'Pending dues' : 'No pending dues')),
        p.braces_case ? h('div', { class: 'stat' }, h('strong', {}, `Month ${p.braces_case.next_month - 1 || 0}`), h('span', {}, 'Braces months completed')) : null,
        h('div', { class: 'stat' }, h('strong', {}, completed.length), h('span', {}, 'Visits completed'))),
      h('div', { class: 'grid-2' },
        h('section', { class: 'panel' },
          h('h2', {}, 'Your visits'),
          completed.length ? h('ul', { class: 'timeline' }, completed.map((v) => h('li', {},
            h('strong', {}, shortDate(v.visit_date)), ' · ', branchName(v.branch_id),
            h('div', {}, [v.treatment_label, v.braces_month ? `braces month ${v.braces_month}` : null].filter(Boolean).join(', ')),
            h('div', { class: 'muted' }, v.staff.filter((s) => s.role === 'doctor').map((s) => s.name).join(', ')),
            rated.has(v.id) ? h('span', { class: 'badge badge-ok' }, 'Rated') : h('button', { class: 'btn btn-small', onclick: () => rate(v) }, 'Rate this visit')))) : empty('Your visits will appear here.')),
        h('section', { class: 'panel' },
          h('h2', {}, 'Invoices and payments'),
          issued.length ? h('table', { class: 'list' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Invoice'), h('th', {}, 'Date'), h('th', { class: 'right' }, 'Amount'), h('th', {}))),
            h('tbody', {}, issued.map((i) => h('tr', {},
              h('td', {}, i.invoice_no), h('td', {}, shortDate(i.issue_date)), h('td', { class: 'right' }, rupees(i.total)),
              h('td', { class: 'right' }, h('button', { class: 'btn btn-small', onclick: () => printInvoice(i, p) }, 'View')))))) : empty('No invoices yet.'),
          p.payments.length ? h('p', { class: 'muted', style: { marginTop: '10px' } }, `Paid so far: ${rupees(p.payments.reduce((s, x) => s + Number(x.amount), 0))}`) : null)),
      h('section', { class: 'panel' },
        h('h2', {}, 'Photos and X-rays'),
        p.photos.length ? h('div', { class: 'photo-grid' }, p.photos.map((ph) => h('figure', {},
          h('img', { src: ph.url || '', alt: ph.view_label || 'Treatment photo', loading: 'lazy' }),
          h('figcaption', {}, [shortDate(ph.taken_on), ph.view_label].filter(Boolean).join(' · '))))) : empty('Your before, progress and after photos will appear here after the clinic uploads them.')),
      p.complaints.length ? h('section', { class: 'panel' },
        h('h2', {}, 'Your messages to Dr. Ali'),
        h('table', { class: 'list' }, h('tbody', {}, p.complaints.map((c) => h('tr', {},
          h('td', {}, h('strong', {}, c.subject), h('div', { class: 'muted' }, c.body)),
          h('td', { class: 'right nowrap' }, h('span', { class: ['badge', c.status === 'resolved' ? 'badge-ok' : 'badge-warn'] }, c.status.replace('_', ' ')))))))) : null));
}
