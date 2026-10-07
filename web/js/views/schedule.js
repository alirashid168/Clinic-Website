// Homepage: "This week with Dr. Ali" (dark band) and "Our clinics" (city groups,
// each branch's next seven days, visit-date calendars). Everything is worked out
// from the live schedule and branch hours, in Karachi time, through the one set
// of rules in lib/hours.js, so the strip and the cards always agree.
import { h, todayISO, srOnly, busy } from '../ui/dom.js';
import { state } from '../state.js';
import { CONTACT } from '../content.js';
import {
  MONTHS, SHORT_DOW, addDays, fullDateLabel, weekdayOf, clock, range, toMin, slotsOn, aliSlotsAt,
  branchHoursFrom, visitRuns, branchDay, branchStatus, aliNow, aliNext, whenLabel, monthCells, monthTitle,
} from '../lib/hours.js';

const ICON = {
  plane: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  person: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  nav: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 18-8-8 18-2-8-8-2z"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
};
const icon = (name, cls = 'ico') => h('span', { class: cls, html: ICON[name] });

function nowMinutes() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return get('hour') * 60 + get('minute');
}

const cityOf = (b) => state.ref.cities?.find((c) => c.id === b?.city_id)?.name || '';

/** schedule is the dr_ali_schedule rows, or null when they could not be loaded. */
function ctx(schedule) {
  const hours = branchHoursFrom(state.ref.settings?.clinic_timings);
  const branches = state.ref.branches || [];
  const byId = (id) => branches.find((b) => b.id === id);
  const isVisit = (id) => hours[String(id)]?.mode === 'visits';
  return { schedule: schedule || [], failed: !schedule, hours, branches, cityOf, byId, isVisit, today: todayISO(), now: nowMinutes() };
}

/** ['Karachi', 'Lahore', 'Islamabad'] -> "Karachi, Lahore and Islamabad" */
function joinAnd(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Facts the public wording quotes, worked out from the data so they never go stale (see content.js). */
export function clinicFacts() {
  const hours = branchHoursFrom(state.ref.settings?.clinic_timings);
  const branches = state.ref.branches || [];
  const cities = (list) => joinAnd([...new Set(list.map(cityOf).filter(Boolean))]);
  const walkIn = branches.filter((b) => hours[String(b.id)]?.mode === 'weekly');
  const visits = branches.filter((b) => hours[String(b.id)]?.mode === 'visits');
  return { count: branches.length, cities: cities(branches), walkInCount: walkIn.length, walkInCities: cities(walkIn), visitCities: cities(visits) };
}

/** "22–25 Oct" or "30 Oct – 2 Nov" */
function shortRange(from, to) {
  const [, m1, d1] = from.split('-').map(Number);
  const [, m2, d2] = to.split('-').map(Number);
  if (from === to) return `${d1} ${MONTHS[m1 - 1]}`;
  return m1 === m2 ? `${d1}–${d2} ${MONTHS[m1 - 1]}` : `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]}`;
}

/** A WhatsApp link whose accessible name says where it goes. */
function waAnchor(href, label, cls, context = '') {
  return h('a', { class: cls, href, target: '_blank', rel: 'noopener' }, label, srOnly(`${context} (opens WhatsApp)`));
}

/** Shown instead of schedule text when the schedule could not load, so a failed request never reads as "Dr. Ali is not coming". */
function loadProblem(text, whatsappLink, onRetry) {
  return h('div', { class: 'public-fallback' },
    h('p', {}, text),
    h('div', { class: 'inline' },
      waAnchor(whatsappLink('Hi, which days is Dr. Ali at the clinic?'), 'Ask on WhatsApp', 'btn btn-primary'),
      h('a', { class: 'btn', href: `tel:${CONTACT.tel}` }, `Call ${CONTACT.phone}`),
      onRetry ? h('button', { type: 'button', class: 'btn', onclick: busy(onRetry) }, 'Try again') : null));
}

// ---------------------------------------------------------------- this week
export function aliWeekSection(schedule, whatsappLink, { onRetry } = {}) {
  const c = ctx(schedule);
  const f = clinicFacts();
  const titles = h('div', { class: 'sx-titles' },
    h('span', { class: 'eyebrow' }, 'Where to find Dr. Ali'),
    h('h2', { class: 'display' }, 'This week with Dr. Ali'),
    h('p', {}, `Dr. Ali personally sees patients ${f.cities ? `across ${f.cities}` : 'at our branches'}. Plan your visit around the days he is at your branch.`));
  if (c.failed) {
    return h('section', { class: 'sx', id: 'dr-ali' }, h('div', { class: 'sx-inner' },
      h('div', { class: 'sx-head' }, titles),
      loadProblem("Dr. Ali's schedule could not load just now. Message or call us and we will tell you his days.", whatsappLink, onRetry)));
  }

  const here = aliNow(c.schedule, c.today, c.now);
  let nowLine;
  if (here) nowLine = [h('span', { class: 'sx-live' }), h('span', {}, 'Right now: ', h('b', {}, c.byId(here.branch_id)?.name || 'Clinic'), `, until ${clock(here.end)}`)];
  else {
    let next = null;
    for (let n = 0; n < 21 && !next; n++) {
      const date = addDays(c.today, n);
      const s = slotsOn(c.schedule, date).slots.find((x) => n > 0 || toMin(x.start) > c.now);
      if (s) next = { date, s };
    }
    nowLine = next
      ? [h('span', { class: 'sx-live is-off' }), h('span', {}, 'Next: ', h('b', {}, c.byId(next.s.branch_id)?.name || 'Clinic'), `, ${whenLabel(next.date, c.today)} ${clock(next.s.start)}`)]
      : null;
  }

  const days = [0, 1, 2, 3, 4, 5, 6].map((n) => {
    const date = addDays(c.today, n);
    const { slots } = slotsOn(c.schedule, date);
    const first = c.byId(slots[0]?.branch_id);
    const travel = slots.some((s) => c.isVisit(s.branch_id));
    const [, m, d] = date.split('-').map(Number);
    return h('li', { class: ['sx-day', n === 0 && 'is-today', travel && 'is-travel'] },
      // The visible day, date and "Today" chip are partly hidden on phones, so screen readers get the full date here.
      srOnly(`${n === 0 ? 'Today, ' : ''}${fullDateLabel(date)}`),
      h('div', { class: 'sx-day-top', 'aria-hidden': 'true' },
        h('span', { class: 'sx-dow' }, SHORT_DOW[weekdayOf(date)]),
        n === 0 ? h('span', { class: 'sx-today' }, 'Today') : null),
      h('div', { class: 'sx-date', 'aria-hidden': 'true' }, h('span', { class: 'sx-num' }, String(d)), h('span', { class: 'sx-mon' }, MONTHS[m - 1])),
      h('div', { class: 'sx-rule' }),
      slots.length
        ? h('div', { class: 'sx-slots' },
          h('span', { class: 'sx-city' }, travel ? icon('plane') : null, cityOf(first)),
          slots.map((s) => h('div', { class: 'sx-slot' }, h('b', {}, c.byId(s.branch_id)?.name || 'Clinic'), h('span', {}, range(s.start, s.end)))))
        : h('p', { class: 'sx-off' }, weekdayOf(date) === 0 ? 'Day off' : 'Not at the clinic'));
  });

  // Trips after this 7-day window, as chips.
  const later = [];
  for (const b of c.branches.filter((x) => c.isVisit(x.id))) {
    for (const r of visitRuns(c.schedule, b.id, c.today)) if (r.from > addDays(c.today, 6)) later.push({ city: cityOf(b), r });
  }
  later.sort((a, b) => a.r.from.localeCompare(b.r.from));

  return h('section', { class: 'sx', id: 'dr-ali' },
    h('div', { class: 'sx-inner' },
      h('div', { class: 'sx-head' },
        titles,
        nowLine ? h('div', { class: 'sx-now' }, nowLine) : null),
      h('ol', { class: 'sx-days' }, days),
      h('div', { class: 'sx-foot' },
        f.walkInCities && f.visitCities ? h('p', {}, icon('info'), `Our ${f.walkInCities} branches keep their usual opening hours while Dr. Ali is in ${f.visitCities}.`) : null,
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
      h('h4', { class: 'display' }, b.name),
      h('p', {}, icon('pin'), b.address || ''),
      b.opened_on ? h('p', { class: 'cx-since' }, `Open since ${new Date(b.opened_on + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`) : null));
}

/** The branch's next seven real days (today first): opening hours and Dr. Ali's times, from the same rule as the strip. */
function timeline(days) {
  const spans = days.flatMap((d) => [d.open, ...d.ali].filter(Boolean));
  const lo = Math.min(12, ...spans.map((s) => Math.floor(toMin(s[0]) / 60)));
  const hi = Math.max(22, ...spans.map((s) => Math.ceil(toMin(s[1]) / 60)));
  const pct = (t) => `${((toMin(t) / 60 - lo) / (hi - lo)) * 100}%`;
  const width = (s) => `${((toMin(s[1]) - toMin(s[0])) / 60 / (hi - lo)) * 100}%`;
  const ticks = [];
  for (let t = lo; t < hi; t += 3) ticks.push(t);
  return h('div', { class: 'cx-timeline' },
    h('div', { class: 'cx-row cx-ticks', 'aria-hidden': 'true' },
      h('span', { class: 'cx-day' }),
      h('div', { class: 'cx-track-wrap' }, ticks.map((t) => h('span', { style: { left: `${((t - lo) / (hi - lo)) * 100}%` } }, t === 12 ? '12 PM' : (t > 12 ? t - 12 : t) + (t === ticks[ticks.length - 1] ? ' PM' : '')))),
      h('span', { class: 'cx-time' })),
    days.map((d, n) => h('div', { class: ['cx-row', n === 0 && 'is-today', !d.open && 'is-closed'] },
      h('span', { class: 'cx-day' }, h('span', { 'aria-hidden': 'true' }, SHORT_DOW[weekdayOf(d.date)]), srOnly(n === 0 ? 'Today' : fullDateLabel(d.date))),
      h('div', { class: 'cx-track', role: 'img', 'aria-label': `${d.open ? `Open ${range(d.open[0], d.open[1])}` : 'Closed'}${d.ali.length ? ', Dr. Ali ' + d.ali.map((a) => range(a[0], a[1])).join(' and ') : ''}` },
        d.open ? h('span', { class: 'cx-open', style: { left: pct(d.open[0]), width: width(d.open) } }) : null,
        d.ali.map((a) => h('span', { class: 'cx-ali', style: { left: pct(a[0]), width: width(a) } }))),
      h('span', { class: 'cx-time' }, d.open ? range(d.open[0], d.open[1]).replace(/ PM – /, ' – ') : 'Closed'))));
}

function aliNote(c, b, days) {
  if (c.failed) return h('div', { class: 'cx-note' }, icon('info'), h('span', {}, "Dr. Ali's days here could not load. Please message us to check before visiting."));
  const next = aliNext(c.schedule, b.id, c.today, c.now);
  let text, gold = false;
  if (next && next.here) { text = `Dr. Ali is here today until ${clock(next.end)}`; gold = true; }
  else if (next && next.date === c.today) { text = `Dr. Ali is here today from ${clock(next.start)}`; gold = true; }
  else if (next) text = `Dr. Ali next here ${whenLabel(next.date, c.today)}, ${clock(next.start)}`;
  else text = "Dr. Ali's next visit here will be announced soon";
  // His times in words too, so the gold bars are not the only way to see them.
  const week = days.filter((d) => d.ali.length).map((d) => `${d.date === c.today ? 'Today' : SHORT_DOW[weekdayOf(d.date)]} ${d.ali.map((a) => range(a[0], a[1])).join(', ')}`);
  return h('div', { class: ['cx-note', gold && 'is-gold'] }, icon('person'),
    h('span', {}, text, week.length ? [h('br'), `This week: ${week.join(' · ')}`] : null));
}

function actions(b, whatsappLink, label, light) {
  const phone = String(b.phone || '').replace(/[^\d+]/g, '');
  return h('div', { class: ['cx-actions', light && 'on-dark'] },
    waAnchor(whatsappLink(`Hi, I would like to book an appointment at the ${b.name} branch.`), label, 'cx-btn', `, ${b.name}`),
    phone.length >= 7 ? h('a', { class: 'cx-icon-btn', href: `tel:${phone}`, 'aria-label': `Call ${b.name}, ${b.phone}` }, icon('phone')) : null,
    h('a', { class: 'cx-icon-btn', href: mapsLink(b), target: '_blank', rel: 'noopener', 'aria-label': `Directions to ${b.name} (opens Google Maps)` }, icon('nav')));
}

function monthCal(c, b, runs) {
  const anchor = runs[0]?.from || c.today;
  const [y, m] = anchor.split('-').map(Number);
  const isVisit = (iso) => aliSlotsAt(c.schedule, b.id, iso).length > 0;
  // Visual only: screen readers get the full list of visit dates from the trips list beside it.
  return h('div', { class: 'cx-cal', 'aria-hidden': 'true' },
    h('div', { class: 'cx-cal-head' }, h('span', { class: 'display' }, monthTitle(y, m)), h('span', {}, 'Visit dates highlighted')),
    h('div', { class: 'cx-cal-grid' },
      ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => h('span', { class: 'cx-cal-dow dow' }, d)),
      monthCells(y, m).map((cell) => cell.day
        ? h('span', { class: ['cx-cal-day', isVisit(cell.iso) && 'is-visit', cell.iso === c.today && 'is-today', cell.iso < c.today && 'is-past'] }, String(cell.day))
        : h('span', { class: 'cx-cal-blank' }))));
}

export function clinicsSection(schedule, whatsappLink, { onRetry } = {}) {
  const c = ctx(schedule);
  const f = clinicFacts();
  const byCity = (list) => {
    const groups = [];
    for (const b of list) {
      const city = cityOf(b);
      let g = groups.find((x) => x.city === city);
      if (!g) groups.push(g = { city, list: [] });
      g.list.push(b);
    }
    return groups;
  };
  const weekly = byCity(c.branches.filter((b) => c.hours[String(b.id)]?.mode === 'weekly'));
  const visiting = c.branches.filter((b) => c.isVisit(b.id));
  const unknown = c.branches.filter((b) => !c.hours[String(b.id)]);

  const weeklyCard = (b) => {
    const hrs = c.hours[String(b.id)];
    const st = branchStatus(hrs, c.schedule, b.id, c.today, c.now);
    const days = [0, 1, 2, 3, 4, 5, 6].map((n) => branchDay(hrs, c.schedule, b.id, addDays(c.today, n)));
    return h('article', { class: 'cx-card' },
      cardHead(b, cityOf(b), st),
      timeline(days),
      aliNote(c, b, days),
      actions(b, whatsappLink, 'Book on WhatsApp'));
  };

  const visitCard = (b) => {
    const hrs = c.hours[String(b.id)];
    // Without the schedule we cannot know the visit dates, so say so rather than "No dates scheduled yet".
    const st = c.failed ? null : branchStatus(hrs, c.schedule, b.id, c.today, c.now);
    const runs = visitRuns(c.schedule, b.id, c.today);
    const trip = (r, hidden) => h('div', { class: hidden ? 'sr-only' : 'cx-trip', role: 'listitem' }, h('b', {}, r.label), hidden ? ', ' : null, h('span', {}, r.time));
    return h('article', { class: 'cx-card cx-visit' },
      h('div', { class: 'cx-visit-side' },
        cardHead(b, cityOf(b), st, true),
        c.failed
          ? h('div', { class: 'cx-trips' }, h('div', { class: 'cx-trip' }, h('b', {}, 'Visit dates could not load'), h('span', {}, 'Please message us before visiting')))
          : h('div', { class: 'cx-trips', role: 'list', 'aria-label': `Visit dates at ${b.name}` }, runs.length
            ? [runs.slice(0, 3).map((r) => trip(r, false)), runs.slice(3).map((r) => trip(r, true))]
            : h('div', { class: 'cx-trip', role: 'listitem' }, h('b', {}, 'No dates scheduled yet'), h('span', {}, 'Please message us before visiting'))),
        actions(b, whatsappLink, 'Book a visit date', true)),
      h('div', { class: 'cx-visit-main' },
        c.failed ? null : monthCal(c, b, runs),
        h('p', { class: 'cx-fine' }, 'Closed on all other days. Please message us before travelling to this branch.')));
  };

  const groupHead = (title, sub) => h('div', { class: 'cx-group' }, h('h3', { class: 'display' }, title), sub ? h('span', {}, sub) : null, h('span', { class: 'cx-line' }));
  const swatch = (cls) => h('i', { class: ['legend-swatch', cls], 'aria-hidden': 'true' });

  return h('section', { class: 'cx', id: 'branches' },
    h('div', { class: 'cx-inner' },
      h('div', { class: 'cx-intro' },
        h('div', {}, h('span', { class: 'eyebrow dark' }, f.count ? `${f.count} ${f.count === 1 ? 'branch' : 'branches'}, one standard of care` : 'One standard of care'), h('h2', { class: 'display' }, 'Our clinics')),
        h('div', {},
          h('p', {}, 'Every branch follows the same month-by-month protocol and shares one patient record, so your treatment continues wherever you visit.'),
          h('div', { class: 'cx-legend' },
            h('span', {}, swatch('is-open'), 'Clinic open'),
            h('span', {}, swatch('is-ali'), 'Dr. Ali in clinic')))),
      c.failed && onRetry ? loadProblem("Dr. Ali's days and the visit dates could not load just now. Clinic hours below are still correct.", whatsappLink, onRetry) : null,
      weekly.map((g) => [
        groupHead(g.city, `${g.list.length} ${g.list.length === 1 ? 'branch' : 'branches'} · open whether or not Dr. Ali is travelling`),
        h('div', { class: 'cx-grid' }, g.list.map(weeklyCard))]),
      visiting.length ? [
        groupHead(joinAnd([...new Set(visiting.map(cityOf).filter(Boolean))]), "Open only on Dr. Ali's visit dates"),
        h('div', { class: 'cx-grid cx-grid-2' }, visiting.map(visitCard))] : null,
      unknown.length ? [
        groupHead(unknown.length === c.branches.length ? 'Our branches' : 'More branches'),
        h('div', { class: 'cx-grid' }, unknown.map((b) => h('article', { class: 'cx-card' },
          cardHead(b, cityOf(b), null, true),
          h('div', { class: 'cx-note' }, icon('info'), h('span', {}, 'Please message us on WhatsApp for timings before visiting.')),
          actions(b, whatsappLink, 'Message on WhatsApp'))))] : null));
}
