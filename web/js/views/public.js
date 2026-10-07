// Public website: home (hero smile card + three doors + Dr. Ali's week and the
// clinics) and the visitor page. The parts that need no data render at once;
// the schedule, results and clinic cards fill in when the database answers.
import { h, mount, srOnly, extLink } from '../ui/dom.js';
import { state } from '../state.js';
import { VISITOR, HOME, CONTACT, PRICES_APPROVED } from '../content.js';
import { aliWeekSection, clinicsSection, clinicFacts } from './schedule.js';
import { CONFIG } from '../config.js';
import { smileCard } from '../ui/smile-card.js';

// ---------------------------------------------------------------- hero smile
// Fallback dental arch built from CSS 3D teeth. smile-card.js replaces it with
// the real veneer result as a WebGL photo card when WebGL and the photo load.
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

/** The hero picture. The card honours prefers-reduced-motion on its own (js/ui/smile-card.js). */
export function smile3d() {
  const stage = h('div', { class: 'smile-stage', role: 'img', 'aria-label': 'A smile makeover result by Dr. Ali Rashid' }, arch(UPPER, false), arch(LOWER, true));
  smileCard(stage);
  return stage;
}

// ---------------------------------------------------------------- pieces
function header(sub) {
  return h('header', { class: ['site-header', sub && 'subpage-header'] },
    h('a', { href: '#/', class: 'wordmark' }, "Dr. Ali Rashid's", h('small', {}, 'Dental Clinic')),
    h('nav', { class: 'inline', 'aria-label': 'Main' },
      h('a', { href: '#/visitor' }, 'Treatments'),
      h('a', { href: '#/login/patient' }, 'Patient login')));
}

/** wa.me link to the clinic: the number set in staff Settings, or CONTACT when settings could not load. Never a link without a recipient. */
function whatsappLink(text) {
  let number = String(state.ref.settings?.whatsapp_number || '').replace(/\D/g, '') || CONTACT.whatsapp;
  if (number.startsWith('0')) number = '92' + number.slice(1);
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

function waLink(text, label, cls) {
  return h('a', { class: cls, href: whatsappLink(text), target: '_blank', rel: 'noopener' }, label, srOnly(' (opens WhatsApp)'));
}

function waFloat() {
  return h('a', { class: 'wa-float', href: whatsappLink('Hi, I would like to book a free consultation.'), target: '_blank', rel: 'noopener', 'aria-label': 'Message us on WhatsApp (opens WhatsApp)' },
    h('span', { 'aria-hidden': 'true' }, '💬'), 'WhatsApp');
}

function footer() {
  return h('footer', { class: 'site-footer' },
    h('div', { class: 'footer-links' },
      HOME.social.map((s) => extLink(s.url, s.name)),
      extLink(HOME.reviewsUrl, 'Google reviews'),
      h('a', { href: `tel:${CONTACT.tel}` }, `Call ${CONTACT.phone}`)),
    `© ${new Date().getFullYear()} ${CONFIG.CLINIC_NAME}`);
}

function trustStrip(f) {
  return h('ul', { class: 'trust' }, HOME.trust(f).map((t) => h('li', {}, h('b', {}, t.big), ' ', h('span', {}, t.small))));
}

/** Alt text from the photo's label when it is a real description, not a camera file name. */
function caseAlt(c, i) {
  const label = String(c.view_label || '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
  return /[a-z]{3}/i.test(label) && !/^(img|dsc|pxl|photo|image)\s*\d+$/i.test(label) ? `Before and after: ${label}` : `Before and after result ${i + 1}`;
}

/** Only when there are photos to show: no empty "Results" section. */
function resultsSection(cases, { limit, reviews } = {}) {
  if (!cases?.length) return null;
  const shown = limit ? cases.slice(0, limit) : cases;
  return h('section', {},
    h('div', { class: 'section-title' }, h('h2', {}, 'Results'), reviews ? extLink(HOME.reviewsUrl, 'Read our Google reviews') : null),
    // url is a resized rendition when the data layer can make one; srcset/sizes let phones pick a smaller file.
    h('div', { class: 'cases' }, shown.map((c, i) => h('img', { src: c.url, srcset: c.srcset || null, sizes: c.srcset ? '(max-width: 560px) 100vw, 360px' : null, alt: caseAlt(c, i), loading: 'lazy', decoding: 'async' }))),
    cases.length > shown.length ? h('p', {}, h('a', { href: '#/visitor' }, `See all ${cases.length} results`)) : null);
}

// ---------------------------------------------------------------- data
// The schedule and results photos, fetched once and shared by every visit to
// Home and Treatments for a few minutes. A failed fetch is not kept.
const CACHE_MS = 5 * 60 * 1000;
let cached = null;
function publicData() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.promise;
  const settle = (p) => Promise.resolve().then(() => p()).then((value) => ({ value }), (error) => ({ error }));
  const promise = Promise.all([settle(() => state.data.schedule()), settle(() => state.data.publicCases())]).then(([schedule, cases]) => {
    if ((schedule.error || cases.error) && cached?.promise === promise) cached = null;
    if (schedule.error) console.error(schedule.error);
    return { schedule: schedule.error ? null : schedule.value || [], cases: cases.error ? [] : cases.value || [] };
  });
  cached = { at: Date.now(), promise };
  return promise;
}

const loadingBlock = () => h('div', { class: 'public-main' }, h('p', { class: 'empty' }, 'Loading clinic times…'));

/** The database could not be reached: contact details instead of schedule text. No staff wording. */
function fallbackBlock() {
  return h('div', { class: 'public-main' },
    h('section', { class: 'public-fallback', id: 'branches' },
      h('h2', {}, 'Clinic times and booking'),
      h('p', {}, "We couldn't load the latest clinic times and Dr. Ali's schedule just now. Message or call us and we will help you book."),
      h('div', { class: 'inline' },
        waLink('Hi, I would like to book an appointment.', 'Message us on WhatsApp', 'btn btn-primary'),
        h('a', { class: 'btn', href: `tel:${CONTACT.tel}` }, `Call ${CONTACT.phone}`),
        h('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, 'Try again'))));
}

/**
 * Waits for the app to start, then fills `slot` with the data sections.
 * Returns the public data, or null when the database could not be reached.
 */
async function fillData(slot, sections) {
  slot.setAttribute('aria-busy', 'true');
  await state.ready;
  if (state.dataError || !state.data) {
    mount(slot, fallbackBlock());
    slot.removeAttribute('aria-busy');
    return null;
  }
  const data = await publicData();
  const retry = () => fillData(slot, sections);
  mount(slot, sections(data, data.schedule ? undefined : retry));
  slot.removeAttribute('aria-busy');
  return data;
}

// ---------------------------------------------------------------- pages
export async function renderHome(root) {
  const trust = h('section', {});
  const about = h('section', { class: 'about' });
  const fillFacts = () => {
    const f = clinicFacts();
    mount(trust, trustStrip(f));
    mount(about, h('div', {}, h('h2', {}, HOME.aboutTitle), HOME.about(f).map((p) => h('p', {}, p)),
      h('div', { class: 'about-actions' },
        waLink('Hi, I would like to book a free consultation.', 'Book a free consultation', 'btn btn-primary'),
        h('a', { class: 'btn', href: '#/visitor' }, PRICES_APPROVED ? 'Braces options and prices' : 'Braces options'))));
  };
  fillFacts();
  const resultsSlot = document.createComment('results');
  const dataSlot = h('div', {}, loadingBlock());
  root.classList.add('has-fab');
  mount(root,
    h('div', { class: 'hero' },
      header(false),
      h('div', { class: 'hero-body' },
        smile3d(),
        h('h1', {}, 'Your smile, planned month by month'),
        h('p', { class: 'hero-sub' }, 'Braces and smile makeovers in Karachi, Lahore and Islamabad.'),
        h('nav', { class: 'door-row', 'aria-label': 'Choose who you are' },
          h('a', { class: 'door door-primary', href: '#/login/patient' }, h('strong', {}, 'Patient'), h('span', {}, 'See your invoices, X-rays and progress photos')),
          h('a', { class: 'door', href: '#/visitor' }, h('strong', {}, 'Visitor'), h('span', {}, 'Braces options, treatments and how to start')),
          h('a', { class: 'door', href: '#/login/staff' }, h('strong', {}, 'Employee'), h('span', {}, 'Staff login for all branches'))),
        h('p', { class: 'hero-demo' }, 'New here? ', h('a', { href: '#/patient/demo' }, 'See a sample patient account'), ' to find out what you get.'))),
    h('main', { id: 'main' },
      h('div', { class: 'public-main' }, trust, about, resultsSlot),
      dataSlot),
    footer(),
    waFloat());

  const data = await fillData(dataSlot, ({ schedule }, onRetry) => [
    aliWeekSection(schedule, whatsappLink, { onRetry }),
    clinicsSection(schedule, whatsappLink)]);
  if (!data) return;
  fillFacts();
  const results = resultsSection(data.cases, { limit: 6, reviews: true });
  if (results) resultsSlot.replaceWith(results);
}

export async function renderVisitor(root) {
  const benefits = h('div', { class: 'benefits' });
  const fillBenefits = () => mount(benefits, VISITOR.benefits(clinicFacts()).map((b) => h('div', { class: 'benefit' }, h('h3', {}, b.title), h('p', { class: 'muted' }, b.body))));
  fillBenefits();
  const resultsSlot = document.createComment('results');
  const dataSlot = h('div', {}, loadingBlock());
  root.classList.add('has-fab');
  mount(root,
    header(true),
    h('main', { id: 'main' },
      h('div', { class: 'public-main' },
        h('section', {},
          h('h1', {}, 'Why start your braces with us'),
          h('p', { class: 'muted', style: { maxWidth: '62ch' } }, VISITOR.intro),
          h('h2', { class: 'sr-only' }, 'Why patients choose us'),
          benefits),
        h('section', {},
          h('div', { class: 'section-title' }, h('h2', {}, 'Braces options')),
          h('div', { class: 'braces-types' }, VISITOR.braces.map((b) =>
            h('div', { class: 'brace-card' }, h('h3', {}, b.name), h('span', { class: 'price' }, PRICES_APPROVED ? b.price : VISITOR.priceHidden), h('p', { class: 'muted' }, b.body)))),
          h('p', { class: 'muted', style: { marginTop: '12px' } }, PRICES_APPROVED ? VISITOR.bracesNote : VISITOR.bracesNoteUnpriced)),
        resultsSlot,
        h('section', {},
          h('div', { class: 'section-title' }, h('h2', {}, 'Other treatments')),
          h('p', {}, VISITOR.otherTreatments.join(', ') + '.')),
        h('section', {},
          h('div', { class: 'cta-band' },
            h('div', {}, h('h2', {}, 'Book a free consultation'), h('p', {}, 'Message us on WhatsApp and we will find a time at your nearest branch.')),
            waLink('Hi, I would like to book a free braces consultation.', 'Message on WhatsApp', 'btn')))),
      dataSlot),
    footer(),
    waFloat());

  const data = await fillData(dataSlot, ({ schedule }, onRetry) => clinicsSection(schedule, whatsappLink, { onRetry }));
  if (!data) return;
  fillBenefits();
  const results = resultsSection(data.cases);
  if (results) resultsSlot.replaceWith(results);
}
