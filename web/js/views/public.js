// Public website: home (3D smile + three doors + Dr. Ali's calendar) and the
// visitor page.
import { h, mount, todayISO } from '../ui/dom.js';
import { state } from '../state.js';
import { VISITOR, HOME } from '../content.js';
import { addDays, dateLabel, weekdayOf, range, slotsOn, branchHoursFrom, openOn, weeklyLines, visitRuns } from '../lib/hours.js';
import { CONFIG } from '../config.js';

// ---------------------------------------------------------------- 3D smile
// A dental arch built from CSS 3D teeth, turning slowly. No libraries, no images.
const UPPER = [ // [width, height] from centre outwards: central, lateral, canine, premolar, premolar, molar
  [46, 66], [38, 58], [38, 64], [36, 52], [35, 50], [42, 48],
];
const LOWER = [[32, 52], [33, 52], [36, 58], [36, 50], [36, 48], [42, 46]];

function arch(sizes, lower) {
  const teeth = [];
  const R = 190;            // arch radius in px
  const step = 12;        // degrees between tooth centres
  for (let side of [-1, 1]) {
    let angle = side * step / 2;
    sizes.forEach(([w, ht], i) => {
      const a = (angle * Math.PI) / 180;
      const x = Math.sin(a) * R;
      const z = Math.cos(a) * R * 0.62 - R * 0.62;   // flatten into a U shape
      const y = lower ? -ht * 0.1 : -ht * 0.9 + i * 2;
      teeth.push(h('div', {
        class: 'tooth', 'aria-hidden': 'true',
        style: { width: w + 'px', height: ht + 'px', transform: `translate3d(${x - w / 2}px, ${y}px, ${z}px) rotateY(${angle}deg)` },
      }));
      const next = sizes[i + 1];
      if (next) angle += side * (step * (w + next[0]) / 2 / 40);
    });
  }
  return h('div', { class: lower ? 'arch lower' : 'arch' }, h('div', { class: 'gum' }), teeth);
}

export function smile3d() {
  return h('div', { class: 'smile-stage', role: 'img', 'aria-label': 'A turning 3D model of a smile' }, arch(UPPER, false), arch(LOWER, true));
}

// ---------------------------------------------------------------- calendar
// The next 7 days with real dates, so trip days (Lahore, Islamabad) show
// where Dr. Ali actually is instead of his normal Karachi week.
function weekCalendar(schedule) {
  const branches = state.ref.branches;
  const today = todayISO();
  return h('div', { class: 'week' }, [0, 1, 2, 3, 4, 5, 6].map((n) => {
    const date = addDays(today, n);
    const { slots } = slotsOn(schedule, date);
    return h('div', { class: ['day', n === 0 && 'today'] },
      h('h3', {}, dateLabel(date) + (n === 0 ? ' (today)' : '')),
      slots.length
        ? slots.map((s) => {
          const b = branches.find((x) => x.id === s.branch_id);
          return h('div', { class: 'slot' }, h('b', {}, b?.name || 'Branch'), range(s.start, s.end));
        })
        : h('p', { class: 'closed' }, weekdayOf(date) === 0 ? 'Day off' : 'Not at the clinic'));
  }));
}

function header(sub) {
  return h('header', { class: ['site-header', sub && 'subpage-header'] },
    h('a', { href: '#/', class: 'wordmark' }, "Dr. Ali Rashid's", h('small', {}, 'Dental Clinic')),
    h('nav', { class: 'inline' },
      h('a', { href: '#/visitor' }, 'Treatments'),
      h('a', { href: '#/login/patient' }, 'Patient login')));
}

// Each branch shows its own hours. Lahore and Islamabad open only on Dr. Ali's
// visit dates, so they list dates and never weekdays. A branch with no hours
// on file says "message us first" rather than guessing.
function branchHoursBlock(b, schedule) {
  const hrs = branchHoursFrom(state.ref.settings?.clinic_timings)[String(b.id)];
  const today = todayISO();
  const open = openOn(hrs, schedule, b.id, today);
  const badge = open === null ? null : h('span', { class: ['open-badge', open ? 'is-open' : 'is-closed'] }, open ? 'Open today' : 'Closed today');
  if (!hrs) return [h('p', { class: 'hours' }, h('span', {}, 'Please message us on WhatsApp for timings before visiting.'))];
  if (hrs.mode === 'weekly') return [badge, h('p', { class: 'hours' }, weeklyLines(hrs.days).map((x) => h('span', {}, x)))];
  const runs = visitRuns(schedule, b.id, today, hrs.hours);
  return [badge, h('p', { class: 'hours' },
    runs.length
      ? [h('span', { class: 'hours-lead' }, 'Open only on these dates:'), ...runs.map((r) => h('span', {}, r.text)), h('span', {}, 'Closed on all other days.')]
      : h('span', {}, 'No dates scheduled yet. Please message us on WhatsApp before visiting.'))];
}

function branchesList(schedule = []) {
  return h('div', { class: 'branch-grid' }, state.ref.branches.map((b) => {
    const city = state.ref.cities?.find((c) => c.id === b.city_id)?.name;
    const q = encodeURIComponent(`Dr. Ali Rashid's Dental Clinic ${b.address || b.name}`);
    return h('div', { class: 'branch-card' },
      h('span', { class: 'city' }, city || ''),
      h('h3', {}, b.name),
      h('p', { class: 'muted' }, b.address || ''),
      branchHoursBlock(b, schedule),
      h('div', { class: 'branch-actions' },
        h('a', { href: `https://www.google.com/maps/search/?api=1&query=${q}`, target: '_blank', rel: 'noopener' }, 'Directions'),
        h('a', { href: whatsappLink(`Hi, I would like to book an appointment at the ${b.name} branch.`), target: '_blank', rel: 'noopener' }, 'Book on WhatsApp')));
  }));
}

function trustStrip() {
  return h('div', { class: 'trust' }, HOME.trust.map((t) => h('div', {}, h('b', {}, t.big), h('span', {}, t.small))));
}

function casesGrid(cases, emptyText) {
  return cases.length
    ? h('div', { class: 'cases' }, cases.map((c) => h('img', { src: c.url, alt: 'Before and after result', loading: 'lazy' })))
    : h('p', { class: 'muted' }, emptyText);
}

function waFloat() {
  if (!String(state.ref.settings?.whatsapp_number || '').replace(/\D/g, '')) return null;
  return h('a', { class: 'wa-float', href: whatsappLink('Hi, I would like to book a free consultation.'), target: '_blank', rel: 'noopener', 'aria-label': 'Message us on WhatsApp' },
    h('span', { 'aria-hidden': 'true' }, '💬'), 'WhatsApp');
}

function footer() {
  return h('footer', { class: 'site-footer' },
    h('div', { class: 'footer-links' }, HOME.social.map((s) => h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name)),
      h('a', { href: HOME.reviewsUrl, target: '_blank', rel: 'noopener' }, 'Google reviews')),
    `© ${new Date().getFullYear()} ${CONFIG.CLINIC_NAME}`);
}

function whatsappLink(text) {
  const number = String(state.ref.settings?.whatsapp_number || '').replace(/\D/g, '');
  const msg = encodeURIComponent(text);
  return number ? `https://wa.me/${number.startsWith('0') ? '92' + number.slice(1) : number}?text=${msg}` : `https://wa.me/?text=${msg}`;
}

// ---------------------------------------------------------------- pages
export async function renderHome(root) {
  const [schedule, cases] = await Promise.all([state.data.schedule().catch(() => []), state.data.publicCases().catch(() => [])]);
  mount(root,
    h('div', { class: 'hero' },
      header(false),
      h('div', { class: 'hero-body' },
        smile3d(),
        h('h1', {}, 'Your smile, planned month by month'),
        h('p', { class: 'hero-sub' }, 'Braces and smile makeovers in Karachi, Lahore and Islamabad.'),
        h('nav', { class: 'door-row', 'aria-label': 'Choose who you are' },
          h('a', { class: 'door door-primary', href: '#/login/patient' }, h('strong', {}, 'Patient'), h('span', {}, 'See your invoices, X-rays and progress photos')),
          h('a', { class: 'door', href: '#/visitor' }, h('strong', {}, 'Visitor'), h('span', {}, 'Braces options, results and how to start')),
          h('a', { class: 'door', href: '#/login/staff' }, h('strong', {}, 'Employee'), h('span', {}, 'Staff login for all branches'))))),
    h('main', { class: 'public-main' },
      h('section', {}, trustStrip()),
      h('section', { class: 'about' },
        h('div', {}, h('h2', {}, HOME.aboutTitle), HOME.about.map((p) => h('p', {}, p)),
          h('div', { class: 'about-actions' },
            h('a', { class: 'btn btn-primary', href: whatsappLink('Hi, I would like to book a free consultation.'), target: '_blank', rel: 'noopener' }, 'Book a free consultation'),
            h('a', { class: 'btn', href: '#/visitor' }, 'Braces options and prices')))),
      h('section', {},
        h('div', { class: 'section-title' }, h('h2', {}, 'Results'), h('a', { href: HOME.reviewsUrl, target: '_blank', rel: 'noopener' }, 'Read our Google reviews')),
        casesGrid(cases, 'Before and after photos are being added. Ask at any branch to see real results from patients who agreed to share them.')),
      h('section', {},
        h('div', { class: 'section-title' }, h('h2', {}, "Dr. Ali's days at each branch"), h('span', { class: 'muted' }, 'Next 7 days')),
        weekCalendar(schedule),
        h('p', { class: 'muted calendar-note' }, 'Our Karachi branches stay open with our senior doctors when Dr. Ali is in Lahore or Islamabad.')),
      h('section', { id: 'branches' },
        h('div', { class: 'section-title' }, h('h2', {}, 'Our clinics')),
        branchesList(schedule))),
    footer(),
    waFloat());
}

export async function renderVisitor(root) {
  const [schedule, cases] = await Promise.all([state.data.schedule().catch(() => []), state.data.publicCases().catch(() => [])]);
  mount(root,
    header(true),
    h('main', { class: 'public-main' },
      h('section', {},
        h('h1', {}, 'Why start your braces with us'),
        h('p', { class: 'muted', style: { maxWidth: '62ch' } }, VISITOR.intro),
        h('div', { class: 'benefits' }, VISITOR.benefits.map((b) => h('div', { class: 'benefit' }, h('h3', {}, b.title), h('p', { class: 'muted' }, b.body))))),
      h('section', {},
        h('div', { class: 'section-title' }, h('h2', {}, 'Braces options')),
        h('div', { class: 'braces-types' }, VISITOR.braces.map((b) =>
          h('div', { class: 'brace-card' }, h('h3', {}, b.name), h('span', { class: 'price' }, b.price), h('p', { class: 'muted' }, b.body)))),
        h('p', { class: 'muted', style: { marginTop: '12px' } }, VISITOR.bracesNote)),
      h('section', {},
        h('div', { class: 'section-title' }, h('h2', {}, 'Results')),
        casesGrid(cases, 'Before and after results will appear here once patients have given consent for their photos to be shared.')),
      h('section', {},
        h('div', { class: 'section-title' }, h('h2', {}, 'Other treatments')),
        h('p', {}, VISITOR.otherTreatments.join(', ') + '.')),
      h('section', {},
        h('div', { class: 'cta-band' },
          h('div', {}, h('h2', {}, 'Book a free consultation'), h('p', {}, 'Message us on WhatsApp and we will find a time at your nearest branch.')),
          h('a', { class: 'btn', href: whatsappLink('Hi, I would like to book a free braces consultation.'), target: '_blank', rel: 'noopener' }, 'Message on WhatsApp'))),
      h('section', {},
        h('div', { class: 'section-title' }, h('h2', {}, 'Our clinics')),
        branchesList(schedule))),
    footer(),
    waFloat());
}
