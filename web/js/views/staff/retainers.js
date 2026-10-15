// Retainer Record: the clinic's "Retainer Record" Google Sheet on the website (owner, 12 Oct 2026: "it should habe a layout
// just like this ... its a special thing for them. i want you to make this something special for them too, colours and all",
// "them" being the few people who make most of the retainers).
//   - Laid out like the sheet (record-sheet.js): the sheet's columns in its order (the Karachi tab's Mr# beside the name: a linked
//     row shows its patient file's Mr#, another row the Mr# typed on the sheet), its purple header, coloured drop-down chips, one
//     tab per city (only cities with branches).
//   - Special for the retainer team: the "Retainer Lab" banner with each person's own colour, this month's numbers and all time's
//     (made and delivered for a maker, models checked for a model checker; a name in it filters the list to their rows), the same
//     colour on every chip and filter, and a "Delivered!" moment (a toast with a check mark, no sound) when a status becomes Delivered.
//     Names, colours and "In the banner" are set in Clinic setup; the copy of a tab gives its most active makers the strongest
//     colours and puts them there.
//   - Order: newest first (the sheet read from the bottom: the rows added last on top), or the sheet's own order.
//   - The next retainer check (the old Coordinator -> Retainers list had it): set by itself a month after "Delivered to patient", changed in
//     its own column or the row's "More" dialog; once its day has passed the row says "Overdue", a warning over the sheet names the people
//     to call, and the Status filter has "Checks due" and "Overdue". The column comes after the sheet's nine (they fill a laptop
//     screen), so it sits with Contact: with the name kept at the left, a little scroll to the right shows who to call and when.
import { h, mount, toast, modal, field, select, showFormErrors, localISO, shortDate, busy, announce, empty, phoneLink } from '../../ui/dom.js';
import { state, can, isAdmin, myBranches, cityName, branchName, defaultBranchId } from '../../state.js';
import { patientSearch, commitOnFinish } from './common.js';
import { renderRecordSheet, recordQueue, rowName, notSaved, pill } from './record-sheet.js';
import {
  retainerStatuses, RETAINER_SHEET_OPTIONS, PAYMENT_OPTIONS, teamFor, colourClass, bannerCounts, bannerTeam, friendlyLine, statusMeans,
  monthName, optionKey, checkOverdue, checkDue,
} from '../../lib/records.js';

/**
 * The columns, in the sheet's order (the row number comes first by itself), then the website's own: Next check (the next retainer
 * check), Contact (the Lahore tab's first column, always empty there) and Notes, after Payments, so the sheet's columns fit a laptop
 * screen. `list` names the drop-down a chip column uses: checkers and makers (the team), status (Clinic setup), sheet and payment (fixed).
 */
export const RETAINER_COLUMNS = [
  { key: 'patient', label: 'Patient name', kind: 'who' },
  { key: 'mr_text', label: 'Mr#', kind: 'mr', max: 20, width: 'short' },
  { key: 'impression_date', label: 'Impression date', kind: 'date', textKey: 'impression_text' },
  { key: 'model_check_by', label: 'Model check by', kind: 'pill', list: 'checkers' },
  { key: 'made_by', label: 'Retainer made by', kind: 'pill', list: 'makers' },
  { key: 'retainer_date', label: 'Retainer date', kind: 'date', textKey: 'retainer_text' },
  { key: 'status', label: 'Status', kind: 'pill', list: 'status' },
  { key: 'retainer_sheet', label: 'Retainer sheet', kind: 'pill', list: 'sheet' },
  { key: 'payment', label: 'Payments', kind: 'pill', list: 'payment' },
  { key: 'next_check_date', label: 'Next check', kind: 'date' },
  { key: 'contact', label: 'Contact', kind: 'text', type: 'tel', max: 60, width: 'text' },
  { key: 'notes', label: 'Notes', kind: 'text', max: 2000, width: 'wide' },
];
const MISSING = 'The Retainer Record is not switched on yet. It appears here once the database update has been run.';

const queue = recordQueue({
  storageKey: 'retainer-record-pending-v1', table: 'retainer_cases', page: 'Retainer Record',
  fieldNames: { patient_name: 'Name', mr_text: 'Mr#', contact: 'Contact', notes: 'Notes' },
  send: (id, changes) => state.data.updateRetainerRecord(id, changes),
});

/** "Hassan (sample)" -> "Hassan"; "Dr. Sample Checker" -> "Dr. Sample". */
const firstName = (name) => { const w = String(name || '').replace(/\s*\(.*\)\s*/g, ' ').trim().split(/\s+/); return /\.$/.test(w[0] || '') && w[1] ? `${w[0]} ${w[1]}` : w[0] || ''; };
const initials = (name) => String(name || '').replace(/\(.*\)/g, '').replace(/\bdr\.?\s*/i, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('');

// A small retainer drawn in white, next to the banner's title.
function retainerIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = (d, extra = {}) => { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); for (const [k, v] of Object.entries({ fill: 'none', stroke: '#fff', 'stroke-width': '2.4', 'stroke-linecap': 'round', ...extra })) p.setAttribute(k, v); svg.append(p); };
  path('M7 27c0-11 5.5-17 13-17s13 6 13 17');
  path('M12 27c0-7.5 3.2-11.5 8-11.5s8 4 8 11.5', { stroke: '#e2c48f' });
  path('M5 27h6M29 27h6');
  return svg;
}

export async function renderRetainers(root, params, signal) {
  const d = state.data;
  const canEdit = can('retainers.manage');
  const cities = [...new Set(myBranches().map((b) => b.city_id))].sort((a, b) => a - b).map((id) => ({ id, label: cityName(id) || `City ${id}` }));
  if (!cities.length) { mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Retainer Record')), empty('No branch is open to your account, so there is no city to show.')); return; }
  const want = Number(params.get('city'));
  const home = state.ref.branches.find((b) => b.id === defaultBranchId())?.city_id;
  const tab = cities.some((c) => c.id === want) ? want : cities.some((c) => c.id === home) ? home : cities[0].id;

  let team = [];
  try { team = await d.retainerTeam(); } catch (e) {
    if (e?.code === 'RECORDS_MISSING') { mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Retainer Record')), empty(MISSING)); return; }
    toast(notSaved(e, ''), 'error');
  }
  if (signal?.aborted) return;
  const statuses = retainerStatuses(state.ref.settings);
  const member = (id) => team.find((m) => m.id === id);
  const teamOptions = (role, key) => (row, cityId) => teamFor(team, { role, cityId, includeId: row?.[key] })
    .map((m) => ({ value: m.id, label: m.active === false ? `${m.name} (left)` : m.name, colour: m.colour }));
  const lists = {
    checkers: teamOptions('model_check', 'model_check_by'),
    makers: teamOptions('maker', 'made_by'),
    status: (row) => statuses.filter((s) => s.active || optionKey(s.label) === optionKey(row?.status)).map((s) => ({ value: s.label, label: s.label, colour: s.colour })),
    sheet: () => RETAINER_SHEET_OPTIONS.map((o) => ({ value: o.label, label: o.label, colour: o.colour })),
    payment: () => PAYMENT_OPTIONS.map((o) => ({ value: o.label, label: o.label, colour: o.colour })),
  };
  const columns = RETAINER_COLUMNS.map((c) => (c.list ? { ...c, options: lists[c.list], other: c.list === 'checkers' || c.list === 'makers' ? () => 'Someone not on the team' : null } : c));
  const today = localISO();

  // ---- the "Retainer Lab" banner: this month's numbers and all time's, so it never opens with only zeros for the people it is for
  // (right after the copy of a sheet tab, or early in a month)
  function banner(ctx) {
    const el = h('section', { class: 'rl-banner', 'aria-labelledby': 'rl-title' });
    const num = (n) => h('b', {}, Number(n || 0).toLocaleString('en-PK'));
    function update() {
      const month = ctx.today.slice(0, 7);
      const counts = bannerCounts(ctx.rows, statuses, month);
      const people = bannerTeam(team, ctx.rows, ctx.tab);
      const hadFocus = el.contains(document.activeElement) ? document.activeElement.dataset.member : null;
      mount(el,
        h('div', { class: 'rl-head' },
          h('div', {}, h('h2', { class: 'rl-title', id: 'rl-title' }, retainerIcon(), 'Retainer Lab'), h('p', { class: 'rl-line' }, friendlyLine(ctx.today))),
          h('p', { class: 'rl-month' }, h('span', { class: 'rl-month-label' }, `${monthName(month)} · ${cityName(ctx.tab)}`), ' ',
            h('strong', {}, `${counts.made} made · ${counts.delivered} delivered`), ' ',
            h('span', { class: 'rl-all' }, `All time: ${counts.allMade.toLocaleString('en-PK')} made · ${counts.allDelivered.toLocaleString('en-PK')} delivered`))),
        people.length
          ? h('ul', { class: 'rl-team', 'aria-label': `The retainer team: this month (${monthName(month)}) and all time. Choose a name to see only their retainers.` }, people.map((m) => {
            const c = counts.byMember[m.id] || { made: 0, delivered: 0, checked: 0, allMade: 0, allDelivered: 0, allChecked: 0 };
            // A model checker's chip counts the models checked and filters "Model check by"; a maker's counts and filters what they made.
            const checker = m.role === 'model_check';
            const key = checker ? 'checker' : 'who';
            const on = ctx.filter(key) === m.id; // (the banner is drawn again after every filter change)
            // (two parts: one line on a laptop, one line each on a phone, where two people sit side by side)
            const part = (when, ...rest) => h('span', { class: 'rl-part' }, h('span', { class: 'rl-when' }, when), ' ', ...rest);
            const nums = checker
              ? [part('This month', num(c.checked), ' checked'), h('span', { class: 'rl-sep' }, ' · '), part('All time', num(c.allChecked), ' checked')]
              : [part('This month', num(c.made), ' made, ', num(c.delivered), ' delivered', ...(c.checked ? [', ', num(c.checked), ' checked'] : [])),
                h('span', { class: 'rl-sep' }, ' · '), part('All time', num(c.allMade), ' made')];
            return h('li', {}, h('button', {
              type: 'button', class: ['rl-chip', colourClass(m.colour)], 'aria-pressed': String(on), dataset: { member: m.id },
              title: on ? 'Show everyone again' : checker ? `Show only the models ${m.name} checked` : `Show only ${m.name}'s retainers`,
              onclick: () => ctx.setFilter(key, ctx.filter(key) === m.id ? '' : m.id),
            }, h('span', { class: 'rl-initials', 'aria-hidden': 'true' }, initials(m.name)),
            h('span', { class: 'rl-who' }, h('span', { class: 'rl-name' }, m.name), h('span', { class: 'rl-counts' }, nums))));
          }))
          : h('p', { class: 'rl-note' }, isAdmin() ? 'Put the team here: Clinic setup → Retainer team, then tick "In the banner".' : 'The team shows here once Dr. Ali has set it up in Clinic setup.'));
      if (hadFocus) el.querySelector(`[data-member="${hadFocus}"]`)?.focus();
    }
    return { el, update };
  }

  // ---- the "Delivered!" moment
  function onSaved(row, changes, before) {
    if (!('status' in changes)) return;
    if (statusMeans(statuses, row.status) !== 'delivered' || statusMeans(statuses, before.status) === 'delivered') return;
    const maker = member(row.made_by);
    // (the database set the first retainer check a month later when the row had none: said here, so nobody has to look for it)
    const check = row.next_check_date && row.next_check_date !== before.next_check_date ? ` First check: ${shortDate(row.next_check_date)}.` : '';
    toast(h('span', {}, h('span', { class: 'rl-tick', 'aria-hidden': 'true' }, '✓'), ' ', h('strong', {}, 'Delivered!'), ' ',
      `${rowName(row)} has the retainer. ${maker ? `Well done, ${firstName(maker.name)}.` : 'Well done, team.'}${check}`), 'delivered', 6000);
  }

  // ---- overdue retainer checks: the warning the old Coordinator -> Retainers list had, as a line under the title (a box over the sheet
  // pushed the sheet off the first screen of a laptop): how many, the names (each opens its row's "More" dialog: the phone, the patient file,
  // the check date) and "Show only them". On a phone the names are left out (app.css), so it stays one line and the first rows stay on the
  // first screen.
  function notice(ctx) {
    const head = h('p', { class: 'rs-notice', tabindex: '-1', hidden: true });
    const show = () => ctx.setFilter('status', '__overdue');
    function update() {
      const late = ctx.rows.filter((r) => checkOverdue(r, statuses, ctx.today)).sort((a, b) => a.next_check_date.localeCompare(b.next_check_date));
      const hadFocus = head.contains(document.activeElement);
      head.hidden = !late.length;
      if (!late.length) { mount(head); return; }
      // (a tab cut off at its row limit may have more)
      const words = `${ctx.rows.truncated ? 'At least ' : ''}${late.length} retainer check${late.length > 1 ? 's are' : ' is'} overdue`;
      const on = ctx.filter('status') === '__overdue';
      mount(head, h('strong', {}, words),
        h('span', { class: 'rs-notice-names' }, ': ',
          late.slice(0, 6).map((r, i) => [i ? ', ' : '', h('button', { type: 'button', class: 'link-btn', 'aria-haspopup': 'dialog', title: `Due on ${shortDate(r.next_check_date)}`, onclick: () => ctx.open(r) }, rowName(r))]),
          late.length > 6 ? ', …' : '', '. Call them for a follow-up'),
        '. ', on ? 'They are the rows below.' : h('button', { type: 'button', class: 'link-btn', onclick: show }, late.length > 1 ? 'Show only them' : 'Show only this one'));
      // "Show only them" goes away once they are shown: the focus stays on the line (which now says they are the rows below).
      if (hadFocus && !head.contains(document.activeElement)) head.focus({ preventScroll: true });
    }
    return { head, update };
  }

  // ---- adding a row
  function add(cityId) {
    return new Promise((resolve) => {
      let picked = null;
      const name = h('input', { maxlength: 200, autocomplete: 'off' });
      const contact = h('input', { type: 'tel', maxlength: 60, autocomplete: 'off' });
      const linkNote = h('p', { class: 'muted', hidden: true });
      const unlink = h('button', { type: 'button', class: 'link-btn', hidden: true, onclick: () => { picked = null; linkNote.hidden = true; unlink.hidden = true; announce('The patient file is no longer linked.'); } }, 'Do not link');
      const search = can('patients.view') ? patientSearch({ placeholder: 'Find a patient file (optional)', label: 'Find a patient file (optional): name, Mr# or phone', onPick: (p) => {
        picked = p;
        name.value = p.full_name;
        if (!contact.value) contact.value = p.phone || '';
        linkNote.textContent = `Linked to the patient file Mr# ${p.mr_number}.`;
        linkNote.hidden = false; unlink.hidden = false;
      } }) : null;
      const imp = h('input', { type: 'date', value: today });
      const checker = select([{ value: '', label: 'Not yet' }, ...teamFor(team, { role: 'model_check', cityId }).map((m) => ({ value: m.id, label: m.name }))], '');
      const maker = select([{ value: '', label: 'Not yet' }, ...teamFor(team, { role: 'maker', cityId }).map((m) => ({ value: m.id, label: m.name }))], '');
      const active = statuses.filter((s) => s.active);
      const status = select(active.map((s) => ({ value: s.label, label: s.label })), active[0]?.label || '');
      const here = myBranches().filter((b) => b.city_id === cityId);
      const homeHere = here.some((b) => b.id === defaultBranchId()) ? defaultBranchId() : '';
      const branch = here.length > 1 ? select([{ value: '', label: `No branch (all of ${cityName(cityId)})` }, ...here.map((b) => ({ value: b.id, label: b.name }))], homeHere) : null;
      const notes = h('input', { maxlength: 2000, autocomplete: 'off' });
      const body = h('div', {},
        search ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Patient file (optional)'), search, h('div', { class: 'inline' }, linkNote, unlink)) : null,
        h('div', { class: 'form-grid' },
          field('Patient name', name, null, { required: true }), field('Contact', contact), field('Impression date', imp),
          field('Model check by', checker), field('Retainer made by', maker), field('Status', status), branch ? field('Branch', branch) : null),
        field('Notes', notes));
      modal(`New retainer · ${cityName(cityId)}`, body, [
        { label: 'Cancel' },
        { label: 'Add retainer', primary: true, onClick: async () => {
          if (!name.value.trim() && !picked) return showFormErrors(body, [{ input: name, message: 'Write the patient name.' }]);
          try {
            const row = await d.addRetainerRecord({
              city_id: cityId, branch_id: branch?.value ? Number(branch.value) : null, patient_id: picked?.id || null,
              patient_name: name.value.trim().replace(/\s+/g, ' ') || picked?.full_name, contact: contact.value.trim() || null,
              impression_date: imp.value || null, model_check_by: checker.value || null, made_by: maker.value || null, status: status.value || null,
              notes: notes.value.trim() || null,
            });
            toast(`${rowName(row)} added to the Retainer Record.`, 'ok');
            resolve(row);
          } catch (e) { toast(notSaved(e, 'The retainer was not added.'), 'error', 9000); return false; }
        } },
      ], { onClose: () => resolve(null) });
    });
  }

  // ---- the row's "More" dialog: patient file, branch, amount, next check, where it came from, remove
  function rowOptions(row, { save, removed }) {
    const who = rowName(row);
    let dialog = null;
    const parts = [];
    if (row.patient_id) {
      parts.push(h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Patient file'), h('div', { class: 'inline' },
        row.patient ? h('a', { class: 'btn btn-small', href: `#/staff/patient/${row.patient_id}`, onclick: () => dialog?.close() }, `Mr# ${row.patient.mr_number} · Open the patient file`) : h('span', {}, 'Linked to a patient file.'),
        canEdit ? h('button', { type: 'button', class: 'btn btn-small', onclick: busy(async () => { if (await save({ patient_id: null }, 'the patient file is no longer linked')) dialog?.close(); }) }, 'Unlink') : null)));
    } else if (canEdit && can('patients.view')) {
      if (row.mr_text) parts.push(h('p', { class: 'muted' }, `Mr# ${row.mr_text} is on this row but it is not linked: no patient file has that Mr#, or the file's name does not fit. Find the right file below to link it.`));
      parts.push(h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Link to a patient file'),
        patientSearch({ placeholder: 'Search name, Mr# or phone', label: `Link ${who} to a patient file: search name, Mr# or phone`, onPick: async (p) => {
          if (await save({ patient_id: p.id, contact: row.contact || p.phone || null }, `linked to Mr# ${p.mr_number}`)) { toast(`${who} is linked to Mr# ${p.mr_number}.`, 'ok'); dialog?.close(); }
        } })));
    }
    const here = state.ref.branches.filter((b) => b.city_id === row.city_id);
    if (here.length > 1) {
      if (canEdit) {
        const branch = select([{ value: '', label: `No branch (all of ${cityName(row.city_id)})` }, ...myBranches().filter((b) => b.city_id === row.city_id).map((b) => ({ value: b.id, label: b.name }))], row.branch_id ?? '');
        const ctl = commitOnFinish(branch, async (v, previous) => {
          if (!(await save({ branch_id: v ? Number(v) : null }, `branch ${v ? branchName(v) : 'none'}`))) ctl.set(previous);
        });
        parts.push(field('Branch', branch));
      } else parts.push(h('p', {}, `Branch: ${row.branch_id ? branchName(row.branch_id) : 'none (the whole city)'}`));
    }
    const phone = row.contact || row.patient?.phone;
    if (phone) parts.push(h('p', {}, 'Phone: ', phoneLink(phone)));
    // The check: "Overdue" once its day has passed (drawn again after a change here).
    const late = h('p', {});
    const paintLate = () => {
      late.hidden = !checkOverdue(row, statuses, today);
      mount(late, late.hidden ? null : [pill('Overdue', 'red'), ` The retainer check was due on ${shortDate(row.next_check_date)}.`]);
    };
    paintLate();
    if (canEdit) {
      const price = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: row.price ?? '' });
      price.addEventListener('change', () => {
        const v = price.value === '' ? null : Number(price.value);
        if (v !== null && (!Number.isFinite(v) || v < 0)) { price.value = row.price ?? ''; toast('Write the amount as a number from 0 up, or leave it empty.', 'error'); return; }
        save({ price: v }, `amount ${v ?? 'cleared'}`);
      });
      const labCost = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: row.lab_cost ?? '' });
      labCost.addEventListener('change', () => {
        const v = labCost.value === '' ? null : Number(labCost.value);
        if (v !== null && (!Number.isFinite(v) || v < 0)) { labCost.value = row.lab_cost ?? ''; toast('Write the cost as a number from 0 up, or leave it empty.', 'error'); return; }
        save({ lab_cost: v }, `lab cost ${v ?? 'cleared'}`);
      });
      const check = h('input', { type: 'date', value: row.next_check_date || '' });
      const checkCtl = commitOnFinish(check, async (v, previous) => {
        if (!(await save({ next_check_date: v || null }, `next check ${v ? shortDate(v) : 'cleared'}`))) checkCtl.set(previous);
        paintLate();
      });
      parts.push(h('div', { class: 'form-grid' }, field('Amount (Rs)', price, 'What the patient pays for the retainer.'),
        field('Lab cost (Rs)', labCost, 'What making it cost. Counted in Reports → Lab and retainer costs.'),
        field('Next retainer check', check, 'Set by itself a month after "Delivered to patient". After the check, choose the day of the next one, or clear it when no more checks are needed.')), late);
    } else if (row.price || row.lab_cost || row.next_check_date) {
      parts.push(h('p', {}, [row.price ? `Amount: Rs ${Number(row.price).toLocaleString('en-PK')}` : null, row.lab_cost ? `Lab cost: Rs ${Number(row.lab_cost).toLocaleString('en-PK')}` : null,
        row.next_check_date ? `Next check: ${shortDate(row.next_check_date)}` : null].filter(Boolean).join(' · ')), late);
    }
    if (row.impression_text || row.retainer_text) {
      parts.push(h('p', { class: 'muted' }, 'Typed on the Google Sheet (the date could not be read): ',
        [row.impression_text ? `impression "${row.impression_text}"` : null, row.retainer_text ? `retainer "${row.retainer_text}"` : null].filter(Boolean).join(', '),
        '. Choose the date in its cell to replace it.'));
    }
    parts.push(h('p', { class: 'muted' }, row.source === 'sheet_import' ? `Copied from the Google Sheet, ${cityName(row.city_id)} tab, row ${row.source_row}.`
      : row.source_row ? `Copied from the Google Sheet (${cityName(row.city_id)} tab, row ${row.source_row}); it stayed as the website's own row when that copy was undone, because it had been changed here.`
        : `Added on the website${row.created_at ? ` on ${shortDate(String(row.created_at).slice(0, 10))}` : ''}.`));
    const canRemove = canEdit && (row.source === 'website' || isAdmin());
    dialog = modal(who, h('div', {}, parts), [
      ...(canRemove ? [{ label: 'Remove this row', danger: true, onClick: () => {
        modal('Remove this row?', h('p', {}, `${who} will be taken off the Retainer Record. This cannot be undone.`), [
          { label: 'Keep it' },
          { label: 'Remove', danger: true, onClick: async () => {
            try { await d.deleteRetainerRecord(row.id); toast(`${who} removed.`, 'ok'); removed(); } catch (e) { toast(notSaved(e, `${who} was not removed.`), 'error', 9000); return false; }
          } },
        ], { destructive: true });
      } }] : []),
      { label: 'Done', primary: true },
    ]);
  }

  // ---- the CSV download: the sheet's columns, then the website's
  function csv(rows, cityId) {
    const name = (id) => member(id)?.name || '';
    return {
      filename: `retainer-record_${cityName(cityId).toLowerCase().replace(/\W+/g, '-')}_${today}.csv`,
      rows: rows.map((r, i) => ({
        '#': i + 1, 'Patient name': rowName(r), 'Mr#': r.patient?.mr_number || r.mr_text || '', Contact: r.contact || '',
        'Impression date': r.impression_date || r.impression_text || '', 'Model check by': name(r.model_check_by), 'Retainer made by': name(r.made_by),
        'Retainer date': r.retainer_date || r.retainer_text || '', Status: r.status || '', 'Retainer sheet': r.retainer_sheet || '', Payments: r.payment || '',
        Notes: r.notes || '', Branch: r.branch_id ? branchName(r.branch_id) : '', Delivered: r.delivered_date || '', 'Next check': r.next_check_date || '',
        Overdue: checkOverdue(r, statuses, today) ? 'Overdue' : '',
        From: r.source === 'sheet_import' ? `Google Sheet row ${r.source_row}` : 'Website',
      })),
    };
  }

  // The team filters: the people of that role in the city, and anyone else on the tab's rows (someone who left).
  const peopleOptions = (role, key, none) => (rows, cityId) => {
    const ids = new Set(rows.map((r) => r[key]).filter(Boolean));
    const opts = teamFor(team, { role, cityId }).filter((m) => m.active !== false || ids.has(m.id));
    for (const id of ids) if (!opts.some((m) => m.id === id) && member(id)) opts.push(member(id));
    const out = opts.map((m) => ({ value: m.id, label: m.name, colour: m.colour }));
    if (rows.some((r) => !r[key])) out.push({ value: '__none', label: none });
    return out;
  };
  // A team filter's value that is not among the tab's options (from an address): the member's name, never the id.
  const personWords = (none) => (v) => (v === '__none' ? none : member(v)?.name || 'Someone not on the team');
  const statusOptions = (rows) => {
    const out = statuses.map((s) => ({ value: s.label, label: s.label, colour: s.colour }));
    for (const r of rows) if (r.status && !out.some((o) => o.value === r.status)) out.push({ value: r.status, label: r.status, colour: 'grey' });
    if (rows.some((r) => !r.status)) out.push({ value: '__none', label: 'Not set' });
    // The retainer checks: "Checks due" (overdue, or in the next 7 days) and "Overdue" (the word of the chip; short, so the filter shows it whole).
    out.push({ value: '__due', label: 'Checks due', colour: 'amber' }, { value: '__overdue', label: 'Overdue', colour: 'red' });
    return out;
  };
  const CHECK_FILTERS = { __due: (r) => checkDue(r, statuses, today), __overdue: (r) => checkOverdue(r, statuses, today) };

  await renderRecordSheet(root, params, signal, {
    page: 'Retainer Record', title: 'Retainer Record', accent: 'purple', path: '#/staff/retainers',
    tabs: cities, tab, tabParam: 'city', queue, canEdit, canAdd: canEdit, canDownload: canEdit || can('export.data'),
    columns,
    load: (cityId) => d.retainerRecords({ cityId }),
    save: (id, changes) => d.updateRetainerRecord(id, changes),
    filters: [
      { key: 'status', label: 'Status', always: true, options: statusOptions, test: (r, v) => (v === '__none' ? !r.status : CHECK_FILTERS[v] ? CHECK_FILTERS[v](r) : r.status === v),
        other: (v) => (v === '__none' ? 'Not set' : v) },
      { key: 'who', label: 'Retainer made by', options: peopleOptions('maker', 'made_by', 'No maker yet'), test: (r, v) => (v === '__none' ? !r.made_by : r.made_by === v),
        other: personWords('No maker yet') },
      { key: 'checker', label: 'Model check by', options: peopleOptions('model_check', 'model_check_by', 'Not checked yet'),
        test: (r, v) => (v === '__none' ? !r.model_check_by : r.model_check_by === v), other: personWords('Not checked yet') },
    ],
    monthKeys: ['impression_date', 'retainer_date'],
    // (an overdue check: the "Overdue" chip in its cell, and the red edge at the name, which stays in sight while the row scrolls sideways)
    rowClass: (row, day) => (checkOverdue(row, statuses, day) ? 'rs-late' : null),
    decorate: (col, row, day) => (col.key === 'next_check_date' && checkOverdue(row, statuses, day) ? pill('Overdue', 'red') : null),
    banner, notice, onSaved, add, addLabel: '+ New retainer', rowOptions, csv,
    words: ['retainer', 'retainers'], missingText: MISSING,
    emptyText: (city) => (canEdit ? `No retainers on the ${city} tab yet. Use "+ New retainer" to add the first one.` : `No retainers on the ${city} tab yet.`),
  });
}
