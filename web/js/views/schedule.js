// Homepage: "This week with Dr. Ali" (dark band) and "Our clinics" (city groups,
// weekly timelines, visit-date calendars). Everything is worked out from the
// live schedule and branch hours, in Karachi time.
import { h, todayISO } from '../ui/dom.js';
import { state } from '../state.js';
import {
  addDays, dateLabel, weekdayOf, clock, range, toMin, slotsOn, branchHoursFrom, visitRuns,
  branchStatus, aliNow, aliNext, whenLabel, monthCells, monthTitle, openSpan,
} from '../lib/hours.js';

const SHORT_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ICON = {
  plane: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  person: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  nav: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 18-8-8 18-2-8-8-2z"/></svg>',
};
const icon = (name, cls = 'ico') => h('span', { class: cls, html: ICON[name] });

function nowMinutes() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return get('hour') * 60 + get('minute');
}

function ctx(schedule) {
  const hours = branchHoursFrom(state.ref.settings?.clinic_timings);
  const branches = state.ref.branches;
  const cityOf = (b) => state.ref.cities?.find((c) => c.id === b?.city_id)?.name || '';
  const byId = (id) => branches.find((b) => b.id === id);
  const isVisit = (id) => hours[String(id)]?.mode === 'visits';
  return { schedule, hours, branches, cityOf, byId, isVisit, today: todayISO(), now: nowMinutes() };
}

/** "22–25 Oct" or "30 Oct – 2 Nov" */
function shortRange(from, to) {
  const [, m1, d1] = from.split('-').map(Number);
  const [, m2, d2] = to.split('-').map(Number);
  if (from === to) return `${d1} ${MONTHS[m1 - 1]}`;
  return m1 === m2 ? `${d1}–${d2} ${MONTHS[m1 - 1]}` : `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]}`;
}

// ---------------------------------------------------------------- this week
export function aliWeekSection(schedule, whatsappLink) {
  const c = ctx(schedule);
  const here = aliNow(schedule, c.today, c.now);
  let nowLine;
  if (here) nowLine = [h('span', { class: 'sx-live' }), h('span', {}, 'Right now: ', h('b', {}, c.byId(here.branch_id)?.name || 'Clinic'), `, until ${clock(here.end)}`)];
  else {
    let next = null;
    for (let n = 0; n < 21 && !next; n++) {
      const date = addDays(c.today, n);
      const s = slotsOn(schedule, date).slots.find((x) => n > 0 || toMin(x.start) > c.now);
      if (s) next = { date, s };
    }
    nowLine = next
      ? [h('span', { class: 'sx-live is-off' }), h('span', {}, 'Next: ', h('b', {}, c.byId(next.s.branch_id)?.name || 'Clinic'), `, ${whenLabel(next.date, c.today)} ${clock(next.s.start)}`)]
      : null;
  }

  const days = [0, 1, 2, 3, 4, 5, 6].map((n) => {
    const date = addDays(c.today, n);
    const { slots } = slotsOn(schedule, date);
    const first = c.byId(slots[0]?.branch_id);
    const travel = slots.some((s) => c.isVisit(s.branch_id));
    const [, m, d] = date.split('-').map(Number);
    return h('div', { class: ['sx-day', n === 0 && 'is-today', travel && 'is-travel'] },
      h('div', { class: 'sx-day-top' },
        h('span', { class: 'sx-dow' }, SHORT_DOW[weekdayOf(date)]),
        n === 0 ? h('span', { class: 'sx-today' }, 'Today') : null),
      h('div', { class: 'sx-date' }, h('span', { class: 'sx-num' }, String(d)), h('span', { class: 'sx-mon' }, MONTHS[m - 1])),
      h('div', { class: 'sx-rule' }),
      slots.length
        ? h('div', { class: 'sx-slots' },
          h('span', { class: 'sx-city' }, travel ? icon('plane') : null, c.cityOf(first)),
          slots.map((s) => h('div', { class: 'sx-slot' }, h('b', {}, c.byId(s.branch_id)?.name || 'Clinic'), h('span', {}, range(s.start, s.end)))))
        : h('p', { class: 'sx-off' }, weekdayOf(date) === 0 ? 'Day off' : 'Not at the clinic'));
  });

  // Trips after this 7-day window, as chips.
  const later = [];
  for (const b of c.branches.filter((x) => c.isVisit(x.id))) {
    for (const r of visitRuns(schedule, b.id, c.today)) if (r.from > addDays(c.today, 6)) later.push({ city: c.cityOf(b), r });
  }
  later.sort((a, b) => a.r.from.localeCompare(b.r.from));

  return h('section', { class: 'sx', id: 'dr-ali' },
    h('div', { class: 'sx-inner' },
      h('div', { class: 'sx-head' },
        h('div', { class: 'sx-titles' },
          h('span', { class: 'eyebrow' }, 'Where to find Dr. Ali'),
          h('h2', { class: 'display' }, 'This week with Dr. Ali'),
          h('p', {}, 'Dr. Ali personally sees patients across Karachi, Lahore and Islamabad. Plan your visit around the days he is at your branch.')),
        nowLine ? h('div', { class: 'sx-now' }, nowLine) : null),
      h('div', { class: 'sx-days' }, days),
      h('div', { class: 'sx-foot' },
        h('p', {}, icon('info'), 'Our Karachi branches stay open with our senior doctors while Dr. Ali is in Lahore or Islamabad.'),
        later.length ? h('div', { class: 'sx-chips' }, h('span', {}, 'Next visits'),
          later.slice(0, 3).map((x) => h('span', { class: 'sx-chip' }, `${x.city} · ${shortRange(x.r.from, x.r.to)}`))) : null)));
}

// ---------------------------------------------------------------- clinics
function mapsLink(b) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`Dr. Ali Rashid's Dental Clinic ${b.address || b.name}`)}`;
}

function statusPill(st, dark = true) {
  if (!st) return null;
  return h('span', { class: ['cx-status', st.open && 'is-open', dark && 'on-dark'] }, h('span', { class: 'dot' }), st.text);
}

function cardHead(b, city, st, extra) {
  return h('div', { class: 'cx-head' },
    h('span', { class: 'cx-mono', 'aria-hidden': 'true' }, (b.name || '?').trim()[0]),
    statusPill(st),
    h('div', { class: 'cx-names' },
      extra ? h('span', { class: 'cx-city' }, city) : null,
      h('h3', { class: 'display' }, b.name),
      h('p', {}, icon('pin'), b.address || ''),
      b.opened_on ? h('p', { class: 'cx-since' }, `Open since ${new Date(b.opened_on + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`) : null));
}

function timeline(c, b, hrs) {
  const spans = [];
  const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const aliRows = c.schedule.filter((r) => r.branch_id === b.id && r.weekday !== null && r.weekday !== undefined && !r.on_date && !r.unavailable);
  const rows = DAY_KEYS.map((k, i) => {
    const wd = (i + 1) % 7;
    const open = hrs.days[k] ? hrs.days[k].split('-') : null;
    const ali = aliRows.filter((r) => r.weekday === wd).map((r) => [r.start_time.slice(0, 5), r.end_time.slice(0, 5)]);
    if (open) spans.push(open);
    ali.forEach((a) => spans.push(a));
    return { k, wd, open, ali };
  });
  const lo = Math.min(12, ...spans.map((s) => Math.floor(toMin(s[0]) / 60)));
  const hi = Math.max(22, ...spans.map((s) => Math.ceil(toMin(s[1]) / 60)));
  const pct = (t) => `${((toMin(t) / 60 - lo) / (hi - lo)) * 100}%`;
  const width = (s) => `${((toMin(s[1]) - toMin(s[0])) / 60 / (hi - lo)) * 100}%`;
  const ticks = [];
  for (let t = lo; t < hi; t += 3) ticks.push(t);
  const todayWd = weekdayOf(c.today);
  return h('div', { class: 'cx-timeline' },
    h('div', { class: 'cx-row cx-ticks', 'aria-hidden': 'true' },
      h('span', { class: 'cx-day' }),
      h('div', { class: 'cx-track-wrap' }, ticks.map((t) => h('span', { style: { left: `${((t - lo) / (hi - lo)) * 100}%` } }, t === 12 ? '12 PM' : (t > 12 ? t - 12 : t) + (t === ticks[ticks.length - 1] ? ' PM' : '')))),
      h('span', { class: 'cx-time' })),
    rows.map((r) => h('div', { class: ['cx-row', r.wd === todayWd && 'is-today', !r.open && 'is-closed'] },
      h('span', { class: 'cx-day' }, SHORT_DOW[r.wd]),
      h('div', { class: 'cx-track', role: 'img', 'aria-label': r.open ? `Open ${range(r.open[0], r.open[1])}${r.ali.length ? ', Dr. Ali ' + r.ali.map((a) => range(a[0], a[1])).join(' and ') : ''}` : 'Closed' },
        r.open ? h('span', { class: 'cx-open', style: { left: pct(r.open[0]), width: width(r.open) } }) : null,
        r.ali.map((a) => h('span', { class: 'cx-ali', style: { left: pct(a[0]), width: width(a) } }))),
      h('span', { class: 'cx-time' }, r.open ? range(r.open[0], r.open[1]).replace(/ PM – /, ' – ') : 'Closed'))));
}

function aliNote(c, b, st) {
  const next = aliNext(c.schedule, b.id, c.today, c.now);
  let text, gold = false;
  if (next && next.here) { text = `Dr. Ali is here today until ${clock(next.end)}`; gold = true; }
  else if (next && next.date === c.today) { text = `Dr. Ali is here today from ${clock(next.start)}`; gold = true; }
  else if (next) text = `${st?.open ? 'Senior doctors on duty now · ' : ''}Dr. Ali next here ${whenLabel(next.date, c.today)}, ${clock(next.start)}`;
  else text = "Dr. Ali's next visit here will be announced soon";
  return h('div', { class: ['cx-note', gold && 'is-gold'] }, icon('person'), h('span', {}, text));
}

function actions(b, whatsappLink, label, light) {
  return h('div', { class: ['cx-actions', light && 'on-dark'] },
    h('a', { class: 'cx-btn', href: whatsappLink(`Hi, I would like to book an appointment at the ${b.name} branch.`), target: '_blank', rel: 'noopener' }, label),
    h('a', { class: 'cx-icon-btn', href: mapsLink(b), target: '_blank', rel: 'noopener', 'aria-label': `Directions to ${b.name}` }, icon('nav')));
}

function monthCal(c, b) {
  const dates = new Set(c.schedule.filter((r) => r.branch_id === b.id && r.on_date && !r.unavailable).map((r) => r.on_date));
  const upcoming = [...dates].filter((d) => d >= c.today).sort();
  const anchor = upcoming[0] || c.today;
  const [y, m] = anchor.split('-').map(Number);
  return h('div', { class: 'cx-cal' },
    h('div', { class: 'cx-cal-head' }, h('span', { class: 'display' }, monthTitle(y, m)), h('span', {}, 'Visit dates in gold')),
    h('div', { class: 'cx-cal-grid' },
      ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => h('span', { class: 'cx-cal-dow', 'aria-hidden': 'true' }, d)),
      monthCells(y, m).map((cell) => cell.day
        ? h('span', {
          class: ['cx-cal-day', dates.has(cell.iso) && 'is-visit', cell.iso === c.today && 'is-today', cell.iso < c.today && 'is-past'],
          'aria-label': `${dateLabel(cell.iso)}${dates.has(cell.iso) ? ', open' : ''}`,
        }, String(cell.day))
        : h('span', { class: 'cx-cal-blank' }))));
}

export function clinicsSection(schedule, whatsappLink) {
  const c = ctx(schedule);
  const weekly = c.branches.filter((b) => c.hours[String(b.id)]?.mode === 'weekly');
  const visiting = c.branches.filter((b) => c.isVisit(b.id));
  const unknown = c.branches.filter((b) => !c.hours[String(b.id)]);
  const groups = [];
  for (const b of weekly) {
    const city = c.cityOf(b);
    let g = groups.find((x) => x.city === city);
    if (!g) groups.push(g = { city, list: [] });
    g.list.push(b);
  }

  const weeklyCard = (b) => {
    const hrs = c.hours[String(b.id)];
    const st = branchStatus(hrs, schedule, b.id, c.today, c.now);
    return h('article', { class: 'cx-card' },
      cardHead(b, c.cityOf(b), st),
      timeline(c, b, hrs),
      aliNote(c, b, st),
      actions(b, whatsappLink, 'Book on WhatsApp'));
  };

  const visitCard = (b) => {
    const hrs = c.hours[String(b.id)];
    const st = branchStatus(hrs, schedule, b.id, c.today, c.now);
    const runs = visitRuns(schedule, b.id, c.today, hrs.hours).slice(0, 3);
    return h('article', { class: 'cx-card cx-visit' },
      h('div', { class: 'cx-visit-side' },
        cardHead(b, c.cityOf(b), st, true),
        h('div', { class: 'cx-trips' }, runs.length
          ? runs.map((r) => h('div', { class: 'cx-trip' }, h('b', {}, r.label), h('span', {}, r.time)))
          : h('div', { class: 'cx-trip' }, h('b', {}, 'No dates scheduled yet'), h('span', {}, 'Please message us before visiting'))),
        actions(b, whatsappLink, 'Book a visit date', true)),
      h('div', { class: 'cx-visit-main' },
        monthCal(c, b),
        h('p', { class: 'cx-fine' }, 'Closed on all other days. Please message us before travelling to this branch.')));
  };

  const groupHead = (title, sub) => h('div', { class: 'cx-group' }, h('h3', { class: 'display' }, title), sub ? h('span', {}, sub) : null, h('span', { class: 'cx-line' }));

  return h('section', { class: 'cx', id: 'branches' },
    h('div', { class: 'cx-inner' },
      h('div', { class: 'cx-intro' },
        h('div', {}, h('span', { class: 'eyebrow dark' }, 'Five branches, one standard of care'), h('h2', { class: 'display' }, 'Our clinics')),
        h('div', {},
          h('p', {}, 'Every branch follows the same month-by-month protocol and shares one patient record, so your treatment continues wherever you visit.'),
          h('div', { class: 'cx-legend' },
            h('span', {}, h('i', { class: 'is-open' }), 'Clinic open'),
            h('span', {}, h('i', { class: 'is-ali' }), 'Dr. Ali in clinic')))),
      groups.map((g) => [
        groupHead(g.city, `${g.list.length} ${g.list.length === 1 ? 'branch' : 'branches'} · open whether or not Dr. Ali is travelling`),
        h('div', { class: 'cx-grid' }, g.list.map(weeklyCard))]),
      visiting.length ? [
        groupHead(visiting.map((b) => c.cityOf(b)).filter((v, i, a) => a.indexOf(v) === i).join(' & '), "Open only on Dr. Ali's visit dates"),
        h('div', { class: 'cx-grid cx-grid-2' }, visiting.map(visitCard))] : null,
      unknown.length ? [
        groupHead('More branches'),
        h('div', { class: 'cx-grid' }, unknown.map((b) => h('article', { class: 'cx-card' },
          cardHead(b, c.cityOf(b), null),
          h('div', { class: 'cx-note' }, icon('info'), h('span', {}, 'Please message us on WhatsApp for timings before visiting.')),
          actions(b, whatsappLink, 'Message on WhatsApp'))))] : null));
}
