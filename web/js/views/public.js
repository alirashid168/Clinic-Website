// Public website: home (3D smile + three doors + Dr. Ali's calendar) and the
// visitor page.
import { h, mount, todayISO } from '../ui/dom.js';
import { state } from '../state.js';
import { VISITOR, WEEKDAYS } from '../content.js';
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
function weekCalendar(schedule) {
  const branches = state.ref.branches;
  const todayIdx = new Date(todayISO() + 'T12:00:00').getDay();
  const order = [1, 2, 3, 4, 5, 6, 0];
  return h('div', { class: 'week' }, order.map((wd) => {
    const slots = schedule.filter((s) => s.weekday === wd && !s.unavailable).sort((a, b) => a.start_time.localeCompare(b.start_time));
    return h('div', { class: ['day', wd === todayIdx && 'today'] },
      h('h3', {}, WEEKDAYS[wd] + (wd === todayIdx ? ' (today)' : '')),
      slots.length
        ? slots.map((s) => {
          const b = branches.find((x) => x.id === s.branch_id);
          return h('div', { class: 'slot' }, h('b', {}, b?.name || 'Branch'), `${s.start_time.slice(0, 5)} – ${s.end_time.slice(0, 5)}`);
        })
        : h('p', { class: 'closed' }, 'Not at the clinic'));
  }));
}

function header(sub) {
  return h('header', { class: ['site-header', sub && 'subpage-header'] },
    h('a', { href: '#/', class: 'wordmark' }, "Dr. Ali Rashid's", h('small', {}, 'Dental Clinic')),
    h('nav', { class: 'inline' },
      h('a', { href: '#/visitor' }, 'Treatments'),
      h('a', { href: '#/login/patient' }, 'Patient login')));
}

function branchesList() {
  return h('div', { class: 'benefits' }, state.ref.branches.map((b) =>
    h('div', { class: 'benefit' }, h('h3', {}, b.name), h('p', { class: 'muted' }, b.address || ''))));
}

function whatsappLink(text) {
  const number = String(state.ref.settings?.whatsapp_number || '').replace(/\D/g, '');
  const msg = encodeURIComponent(text);
  return number ? `https://wa.me/${number.startsWith('0') ? '92' + number.slice(1) : number}?text=${msg}` : `https://wa.me/?text=${msg}`;
}

// ---------------------------------------------------------------- pages
export async function renderHome(root) {
  const schedule = await state.data.schedule().catch(() => []);
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
      h('section', {},
        h('div', { class: 'section-title' }, h('h2', {}, "Dr. Ali's days at each branch"), h('span', { class: 'muted' }, 'Updated by the clinic every week')),
        weekCalendar(schedule)),
      h('section', {},
        h('div', { class: 'section-title' }, h('h2', {}, 'Branches')),
        branchesList())),
    h('footer', { class: 'site-footer' }, `© ${new Date().getFullYear()} ${CONFIG.CLINIC_NAME}`));
}

export async function renderVisitor(root) {
  const cases = await state.data.publicCases().catch(() => []);
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
        cases.length
          ? h('div', { class: 'cases' }, cases.map((c) => h('img', { src: c.url, alt: 'Before and after braces result', loading: 'lazy' })))
          : h('p', { class: 'muted' }, 'Before and after results will appear here once patients have given consent for their photos to be shared.')),
      h('section', {},
        h('div', { class: 'section-title' }, h('h2', {}, 'Other treatments')),
        h('p', {}, VISITOR.otherTreatments.join(', ') + '.')),
      h('section', {},
        h('div', { class: 'cta-band' },
          h('div', {}, h('h2', {}, 'Book a free consultation'), h('p', {}, 'Message us on WhatsApp and we will find a time at your nearest branch.')),
          h('a', { class: 'btn', href: whatsappLink('Hi, I would like to book a free braces consultation.'), target: '_blank', rel: 'noopener' }, 'Message on WhatsApp'))),
      h('section', {},
        h('div', { class: 'section-title' }, h('h2', {}, 'Branches')),
        branchesList())),
    h('footer', { class: 'site-footer' }, `© ${new Date().getFullYear()} ${CONFIG.CLINIC_NAME}`));
}
