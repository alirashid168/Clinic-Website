// Patient portal: invoices, dues, X-rays and photos, visit history, the
// "see Dr. Ali" message, ratings and the complaint button.
import { h, mount, rupees, shortDate, toast, friendlyError, modal, field, empty, localISO, srOnly, showFormErrors, clearFieldErrors, announce } from '../ui/dom.js';
import { state, branchName } from '../state.js';
import { signThumbs } from '../ui/photos.js';
import { checkPortalPassword, PASSWORD_MIN } from '../lib/portal-login.js';

// Invoice printing and installment tables live with the staff invoice screens;
// they load only when a patient has a plan or opens an invoice.
const invoiceModule = () => import('./staff/invoice.js');

/** Patients never see staff instructions or database text (see friendlyError in ui/dom.js). */
const patientError = (err) => friendlyError(err, { audience: 'public' });

/** What went wrong with a new password, in the patient's words. */
function passwordProblem(err) {
  const msg = err?.message || '';
  if (err?.code === 'same_password' || /different from the old password/i.test(msg)) return 'Choose a password that is different from your current one.';
  if (err?.code === 'weak_password' || /weak|easy to guess|pwned|compromised/i.test(msg)) return 'That password is too easy to guess. Choose a longer or less common one.';
  if (/reauthenticat|recent login/i.test(msg)) return 'For your safety, log out and log in again, then change your password.';
  return patientError(err);
}

/** Two password boxes (the new one, and again) with their checks. read() returns the password, or null after marking what to fix. */
function newPasswordFields() {
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const body = h('div', {}, field('New password', next, `At least ${PASSWORD_MIN} characters.`, { required: true }), field('Type it again', again, null, { required: true }));
  const read = () => {
    clearFieldErrors(body);
    const problem = checkPortalPassword(next.value);
    const errors = [];
    if (problem) errors.push({ input: next, message: problem });
    else if (again.value !== next.value) errors.push({ input: again, message: 'The two passwords are different. Type them again.' });
    if (errors.length) { showFormErrors(body, errors); return null; }
    return next.value;
  };
  return { body, next, read };
}

/**
 * The first screen after a login the clinic made: the patient chooses their own password before anything else (no
 * patient data is loaded until they have). Then the portal opens.
 */
function renderChoosePassword(root, signOut) {
  const d = state.data;
  const fields = newPasswordFields();
  const problem = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit', style: { width: '100%' } }, 'Save my password');
  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      problem.hidden = true;
      const password = fields.read();
      if (!password) return;
      submit.disabled = true;
      try {
        await d.changePassword(password);
      } catch (err) {
        problem.textContent = passwordProblem(err);
        problem.hidden = false;
        announce(problem.textContent, { assertive: true });
        submit.disabled = false;
        return;
      }
      // The password is saved; the flag is off on the server now. Nothing else to ask the network before opening the portal.
      state.session = { ...state.session, mustChangePassword: false };
      toast('Your password is saved.', 'ok');
      try { await renderPortal(root, signOut); } catch (err) { console.error(err); toast(patientError(err), 'error'); }
    },
  }, fields.body, problem, submit);
  mount(root, h('div', { class: 'login-wrap' },
    h('main', { class: 'login-card' },
      h('h1', {}, 'Choose your own password'),
      h('p', {}, 'The clinic gave you a first password to get in. Choose a new one that only you know. You will use it every time you log in.'),
      form,
      h('p', { style: { marginTop: '16px' } }, h('button', { type: 'button', class: 'link-btn', onclick: signOut }, 'Log out')))));
  fields.next.focus();
}

function loading(root, text) {
  mount(root, h('main', { class: 'public-main', 'aria-busy': 'true' }, h('p', { class: 'empty', role: 'status' }, text)));
}

export async function renderPortal(root, signOut) {
  const d = state.data;
  const me = state.session?.patient;
  // The route guard checked the login, but it can end (another tab signed out) while this page's code was loading.
  if (!me) { location.replace('#/login/patient'); return; }
  // A login the clinic made: the patient chooses their own password before anything else.
  if (state.session?.mustChangePassword) return renderChoosePassword(root, signOut);
  loading(root, 'Loading your account…');
  const [p, ratings] = await Promise.all([d.getPatient(me.id), d.myRatings().catch(() => [])]);
  return portalPage(root, { d, p, ratings, signOut, preview: false });
}

/** Public demo: a made-up sample patient, so anyone can see what the portal looks like before logging in. */
let demoAdapter, demoBranches = [];
export async function renderPortalDemo(root) {
  loading(root, 'Loading the sample account…');
  if (!demoAdapter) {
    const { createDemoAdapter } = await import('../data/demo.js');
    const adapter = createDemoAdapter();
    await adapter.signInDemo('p-demo');
    demoBranches = await adapter.branches();
    demoAdapter = adapter; // only once it works, so a failed load is tried again next time
  }
  const d = demoAdapter;
  // The sample login lives in memory (nothing to lose to a bad connection); sign in again rather than fail if it was ever cleared.
  const me = (await d.getSession())?.patient || (await d.signInDemo('p-demo')).patient;
  const [p, ratings] = await Promise.all([d.getPatient(me.id), d.myRatings().catch(() => [])]);
  // The sample's visits use the sample clinic's own branch ids, so their names come from the sample data.
  // Never copied into state.ref: during an outage the public pages would list sample branches as real ones.
  const branchLabel = (id) => demoBranches.find((b) => b.id === Number(id))?.name || '';
  return portalPage(root, { d, p, ratings, signOut: null, preview: 'demo', branchLabel });
}

/** Staff preview: exactly what this patient sees in their account (buttons switched off). */
export async function renderPortalPreview(root, patientId) {
  const d = state.data;
  const p = await d.getPatient(patientId);
  // Patients only ever see edited photos and non-internal replies; the staff view carries more.
  p.photos = (p.photos || []).filter((ph) => ph.kind === 'edited');
  p.complaints = (p.complaints || []).map((c) => ({ ...c, messages: (c.messages || []).filter((m) => !m.internal_note) }));
  p.invoices = (p.invoices || []).filter((i) => i.status === 'issued');
  return portalPage(root, { d, p, ratings: [], signOut: null, preview: true });
}

/**
 * Small thumbnails for the photo grid. The data layer normally signs them with the record (thumb_url, one batch: the stored
 * small copy when the photo has one); if it did not, sign the missing ones here (signThumbs). Without signedUrls, the full-size url stays.
 */
async function addThumbnails(d, photos) {
  const need = photos.filter((ph) => !ph.thumb_url && ph.storage_path);
  if (!need.length || typeof d.signedUrls !== 'function') return;
  try {
    const thumbs = await signThumbs(d, need, 240);
    for (const ph of need) ph.thumb_url = thumbs.get(ph.storage_path) || null;
  } catch { /* keep the full-size links that came with the record */ }
}

/** Signed links expire after an hour: a thumbnail that fails, or a full-size link that has expired, is signed again. */
function photoImg(d, ph) {
  const canSign = ph.storage_path && typeof d.signedUrls === 'function';
  // First failure: sign the thumbnail again (it may have expired). Second: show the full-size photo instead, as the staff grid does.
  let failures = 0;
  const img = h('img', {
    src: ph.thumb_url || ph.url || '', alt: ph.view_label || 'Treatment photo', loading: 'lazy', decoding: 'async',
    onerror: async () => {
      failures += 1;
      if (failures === 1 && canSign) {
        try { const url = (await signThumbs(d, [ph], 240)).get(ph.storage_path); if (url && url !== img.src) { img.src = url; return; } } catch { /* fall through to the original */ }
      }
      if (failures <= 2 && ph.url && img.src !== ph.url) img.src = ph.url;
    },
  });
  if (!ph.url) return img;
  const link = h('a', {
    href: ph.url, target: '_blank', rel: 'noopener',
    onclick: async (e) => {
      if (!canSign || !ph.url_expires_at || Date.now() < ph.url_expires_at - 60000) return; // still valid
      e.preventDefault();
      const tab = window.open('', '_blank'); // opened now, while the click still counts, then pointed at the fresh link
      if (tab) tab.opener = null;
      try {
        const url = (await d.signedUrls([ph.storage_path])).get(ph.storage_path);
        if (!url) throw new Error('No link');
        ph.url = link.href = url;
        ph.url_expires_at = Date.now() + 3600 * 1000;
        if (tab) tab.location = url;
      } catch (err) { tab?.close(); toast(patientError(err), 'error'); }
    },
  }, img, srOnly(' (full size, opens in a new tab)'));
  return link;
}

async function portalPage(root, { d, p, ratings, signOut, preview, branchLabel = branchName }) {
  const rated = new Set(ratings.map((r) => r.visit_id));
  const completed = p.visits.filter((v) => v.status === 'completed');
  const complaints = p.complaints || [];
  const off = preview === true ? { disabled: true, title: 'Switched off in the preview' } : {};
  const [inv] = await Promise.all([(p.plans || []).length ? invoiceModule().catch(() => null) : null, addThumbnails(d, p.photos || [])]);

  // Rated visits swap their button for a badge in place: the page is not rebuilt, so focus and reading position stay.
  const markRated = (button) => {
    const badge = h('span', { class: 'badge badge-ok', tabindex: '-1' }, 'Rated');
    button.replaceWith(badge);
    setTimeout(() => badge.focus(), 0); // after the dialog has closed
  };

  const rate = (visit, button) => {
    let stars = 0;
    const comment = h('textarea', { placeholder: 'Anything we should know? (optional)' });
    const labelId = 'rate-' + Math.random().toString(36).slice(2, 8);
    const starRow = h('div', { class: 'stars', role: 'radiogroup', 'aria-labelledby': labelId, tabindex: '-1' });
    const form = h('div', {}, h('span', { class: 'field-label', id: labelId }, 'Your rating (required)'), starRow, field('Comment', comment));
    // A radio group: one tab stop, arrow keys move the choice, and the buttons are updated in place (never rebuilt).
    const buttons = [1, 2, 3, 4, 5].map((n) => h('button', {
      type: 'button', role: 'radio', 'aria-label': `${n} of 5 stars`,
      onclick: () => choose(n),
      onkeydown: (e) => {
        const to = { ArrowRight: n + 1, ArrowDown: n + 1, ArrowLeft: n - 1, ArrowUp: n - 1, Home: 1, End: 5 }[e.key];
        if (!to) return;
        e.preventDefault();
        choose(Math.min(5, Math.max(1, to)));
        buttons[stars - 1].focus();
      },
    }));
    const paint = () => buttons.forEach((b, i) => {
      b.className = i < stars ? 'on' : '';
      b.textContent = i < stars ? '★' : '☆'; // filled or outlined, not colour alone
      b.setAttribute('aria-checked', String(i + 1 === stars));
      b.tabIndex = i === (stars ? stars - 1 : 0) ? 0 : -1;
    });
    const choose = (n) => { stars = n; paint(); clearFieldErrors(form); };
    starRow.append(...buttons);
    paint();
    modal(`Rate your visit on ${shortDate(visit.visit_date)}`, form, [
      { label: 'Cancel' },
      { label: 'Send rating', primary: true, onClick: async () => {
        if (!stars) { showFormErrors(form, [{ input: starRow, message: 'Choose from 1 to 5 stars.' }]); return false; }
        try { await d.rateVisit(visit.id, stars, comment.value); } catch (e) { toast(patientError(e), 'error'); return false; }
        toast('Thank you for your rating.', 'ok');
        markRated(button);
      } },
    ], { initialFocus: buttons[0] });
  };

  /** "Change password" in the portal menu, for any time after the first login. */
  const changePassword = () => {
    const fields = newPasswordFields();
    modal('Change your password', fields.body, [
      { label: 'Cancel' },
      { label: 'Save password', primary: true, onClick: async () => {
        const password = fields.read();
        if (!password) return false;
        try { await d.changePassword(password); } catch (e) { toast(passwordProblem(e), 'error'); return false; }
        toast('Your password has been changed.', 'ok');
      } },
    ], { initialFocus: fields.next });
  };

  const messagesHost = h('div', {});
  const drawMessages = () => mount(messagesHost, complaints.length ? h('section', { class: 'panel' },
    h('h2', {}, 'Your messages to Dr. Ali'),
    h('table', { class: 'list' }, h('tbody', {}, complaints.map((c) => h('tr', {},
      h('td', {}, h('strong', {}, c.subject), h('div', { class: 'muted' }, c.body),
        (c.messages || []).filter((m) => !m.internal_note).map((m) => h('div', { class: 'alert alert-info', style: { marginTop: '6px' } }, h('strong', {}, 'Reply from the clinic: '), m.body))),
      h('td', { class: 'right nowrap' }, h('span', { class: ['badge', c.status === 'resolved' ? 'badge-ok' : 'badge-warn'] }, String(c.status || 'new').replace('_', ' ')))))))) : null);

  const complain = () => {
    const subject = h('input', { placeholder: 'For example: waiting time, treatment, billing' });
    const body = h('textarea', { placeholder: 'Tell Dr. Ali what happened' });
    const form = h('div', {},
      h('p', { class: 'muted' }, 'Your message goes directly to Dr. Ali and the clinic coordinator.'),
      field('Subject', subject, null, { required: true }), field('Message', body, null, { required: true }));
    modal('Report or complain to Dr. Ali Rashid', form, [
      { label: 'Cancel' },
      { label: 'Send to Dr. Ali', primary: true, onClick: async () => {
        clearFieldErrors(form);
        const errors = [];
        if (!subject.value.trim()) errors.push({ input: subject, message: 'Add a subject.' });
        if (!body.value.trim()) errors.push({ input: body, message: 'Write your message to Dr. Ali.' });
        if (errors.length) { showFormErrors(form, errors); return false; }
        const item = { subject: subject.value.trim(), body: body.value.trim() };
        let saved;
        try { saved = await d.fileComplaint(item); } catch (e) { toast(patientError(e), 'error'); return false; }
        toast(preview === 'demo' ? 'Sent (sample account: nothing is really sent).' : 'Sent to Dr. Ali.', 'ok');
        complaints.unshift({ status: 'new', messages: [], ...(saved && typeof saved === 'object' ? saved : {}), ...item });
        drawMessages();
      } },
    ]);
  };
  drawMessages();

  const issued = p.invoices.filter((i) => i.status === 'issued');
  const today = localISO();
  const next = p.visits.filter((v) => v.status === 'scheduled' && v.visit_date >= today).sort((a, b) => a.visit_date.localeCompare(b.visit_date))[0];
  const viewInvoice = async (i) => {
    try { (await invoiceModule()).printInvoice(i, p, { patientView: true }); } catch (e) { toast(patientError(e), 'error'); }
  };
  mount(root,
    preview === true ? h('div', { class: 'alert alert-info inline', style: { justifyContent: 'space-between', margin: '0 0 8px' } },
      h('span', {}, h('strong', {}, 'Patient view. '), `This is what ${p.full_name} sees after logging in to their account. Buttons are switched off here.`),
      h('a', { class: 'btn btn-small', href: `#/staff/patient/${p.id}` }, 'Back to the record')) : null,
    preview === 'demo' ? h('div', { class: 'alert alert-warning inline sample-banner', style: { justifyContent: 'space-between', margin: '0 0 8px' } },
      h('span', {}, h('strong', {}, 'Sample account'), ' with made-up data.'),
      h('span', { class: 'nowrap' }, h('a', { class: 'btn btn-small btn-primary', href: '#/login/patient' }, 'Patient login'), ' ', h('a', { class: 'btn btn-small', href: '#/' }, 'Home'))) : null,
    preview ? null : h('header', { class: 'mobile-bar' },
      h('strong', {}, "Dr. Ali Rashid's Dental Clinic"),
      h('span', { class: 'inline', style: { gap: 'var(--space-4)' } },
        typeof d.changePassword === 'function' ? h('button', { type: 'button', class: 'link-btn', onclick: changePassword }, 'Change password') : null,
        h('button', { type: 'button', class: 'link-btn', onclick: signOut }, 'Log out'))),
    h('main', { class: 'public-main stack', style: { paddingTop: '24px' } },
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, `Hello, ${p.full_name.split(' ')[0]}`), h('p', {}, `Mr# ${p.mr_number}`)),
        h('button', { class: 'btn btn-primary', onclick: complain, ...off }, 'Report / complain to Dr. Ali Rashid')),
      p.flag ? h('div', { class: 'alert alert-warning' }, h('strong', {}, 'Please get your next appointment done by Dr. Ali Rashid. '),
        'Check ', h('a', { href: '#/clinics' }, "Dr. Ali's days at each branch"), ' and come on one of those days.') : null,
      next ? h('div', { class: 'alert alert-info' }, h('strong', {}, 'Your next appointment: '), `${shortDate(next.visit_date)}${branchLabel(next.branch_id) ? ` at ${branchLabel(next.branch_id)}` : ''}`, next.treatment_label ? ` · ${next.treatment_label}` : '') : null,
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat' }, h('strong', {}, rupees(Math.max(0, p.dues))), h('span', {}, p.dues > 0 ? 'Pending dues' : 'No pending dues')),
        p.braces_case ? h('div', { class: 'stat' }, h('strong', {}, `Month ${p.braces_case.next_month - 1 || 0}`), h('span', {}, 'Braces months completed')) : null,
        h('div', { class: 'stat' }, h('strong', {}, completed.length), h('span', {}, 'Visits completed')),
        (() => { const seen = [...new Set(completed.map((v) => v.branch_id))].map((id) => branchLabel(id)).filter(Boolean); return seen.length ? h('div', { class: 'stat' }, h('strong', {}, seen.length), h('span', {}, seen.length === 1 ? `Branch: ${seen[0]}` : `Branches: ${seen.join(', ')}`)) : null; })()),
      h('div', { class: 'grid-2' },
        h('section', { class: 'panel' },
          h('h2', {}, 'Your visits'),
          completed.length ? h('ul', { class: 'timeline' }, completed.map((v) => h('li', {},
            h('strong', {}, shortDate(v.visit_date)), branchLabel(v.branch_id) ? ` · ${branchLabel(v.branch_id)}` : null,
            h('div', {}, [v.treatment_label, v.braces_month ? `braces month ${v.braces_month}` : null].filter(Boolean).join(', ')),
            h('div', { class: 'muted' }, v.staff.filter((s) => s.role === 'doctor').map((s) => s.name).join(', ')),
            rated.has(v.id) ? h('span', { class: 'badge badge-ok' }, 'Rated')
              : h('button', { class: 'btn btn-small', onclick: (e) => rate(v, e.currentTarget), ...off }, 'Rate this visit', srOnly(` on ${shortDate(v.visit_date)}`))))) : empty('Your visits will appear here.')),
        h('section', { class: 'panel' },
          h('h2', {}, 'Invoices and payments'),
          issued.length ? h('table', { class: 'list' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Invoice'), h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col', class: 'right' }, 'Amount'), h('th', { scope: 'col' }, srOnly('Actions')))),
            h('tbody', {}, issued.map((i) => h('tr', {},
              h('td', {}, i.invoice_no), h('td', {}, shortDate(i.issue_date)), h('td', { class: 'right' }, rupees(i.total)),
              h('td', { class: 'right' }, h('button', { class: 'btn btn-small', onclick: () => viewInvoice(i) }, 'View', srOnly(` invoice ${i.invoice_no}`))))))) : empty('No invoices yet.'),
          p.payments.length ? h('p', { class: 'muted', style: { marginTop: '10px' } }, `Paid so far: ${rupees(p.payments.reduce((s, x) => s + Number(x.amount), 0))}`) : null,
          inv ? h('div', { style: { marginTop: '12px' } }, h('h3', {}, 'Your installment plan'), p.plans.map((plan) => inv.planTable(plan, p.payments)))
            // The plan module did not load (dropped connection): say so, so a missing plan never reads as "nothing is owed".
            // A page reload, not a retry button: a browser can keep a failed dynamic import failed until the page reloads.
            : (p.plans || []).length ? h('div', { style: { marginTop: '12px' } }, h('h3', {}, 'Your installment plan'),
              h('p', { class: 'muted', role: 'status' }, 'Your installment plan could not load. Reload the page to try again.'),
              h('button', { type: 'button', class: 'btn btn-small', onclick: () => location.reload() }, 'Reload the page')) : null)),
      h('section', { class: 'panel' },
        h('h2', {}, 'Photos and X-rays'),
        p.photos.length ? h('div', { class: 'photo-grid' }, p.photos.map((ph) => h('figure', {},
          photoImg(d, ph),
          h('figcaption', {}, [shortDate(ph.taken_on), ph.view_label].filter(Boolean).join(' · '))))) : empty('Your before, progress and after photos will appear here after the clinic uploads them.')),
      messagesHost));
}
