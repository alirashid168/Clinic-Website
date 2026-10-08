// Public website: home (hero smile card + three doors + Meet Dr. Ali + his week
// and the clinics) and the visitor page. The parts that need no data render at
// once; the schedule, results and clinic cards fill in when the database answers.
import { h, mount, srOnly, extLink, announce } from '../ui/dom.js';
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

// "Meet Dr. Ali": his portrait over a night-coloured block, his name set large beside it.
function stars(score) {
  return h('span', { class: 'mx-stars', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5].map((i) =>
    h('i', { class: score >= i ? 'full' : score >= i - 0.5 ? 'half' : 'empty' })));
}

/** The section is built once; fill(f) writes the wording that quotes clinic facts, so the photo is never rebuilt. */
function meetSection() {
  const m = HOME.meet;
  const body = m.body({}).map(() => h('p', { class: 'mx-body' }));
  return {
    fill: (f) => m.body(f).forEach((text, i) => { body[i].textContent = text; }),
    el: h('section', { class: 'mx', id: 'meet', 'aria-labelledby': 'mx-title' },
      h('div', { class: 'mx-inner' },
        h('figure', { class: 'mx-photo' },
          h('img', { src: m.photo, alt: m.photoAlt, width: m.photoWidth, height: m.photoHeight, loading: 'lazy', decoding: 'async' })),
        h('div', { class: 'mx-copy' },
          h('span', { class: 'eyebrow dark' }, m.role),
          h('h2', { class: 'display mx-name', id: 'mx-title' }, h('span', {}, m.name[0]), ' ', h('span', {}, m.name[1])),
          h('p', { class: 'display mx-cred' }, m.credential),
          h('div', { class: 'mx-rule', 'aria-hidden': 'true' }),
          body,
          h('div', { class: 'mx-actions' },
            waLink('Hi, I would like to book a free consultation.', 'Book a free consultation', 'mx-btn'),
            h('a', { class: 'mx-link', href: '#/visitor' }, PRICES_APPROVED ? 'Braces options and prices' : 'Braces options')),
          extLink(HOME.reviewsUrl, [stars(HOME.rating.score), h('b', {}, String(HOME.rating.score)), h('span', {}, HOME.rating.text)], { class: 'mx-rating' })))),
  };
}

/**
 * Alt text from the photo's label when it is a real description. Published photos are named
 * "YYYY-MM-DD_label_xxxxxxxx.jpg" (publishPhoto in data/supabase.js): the date and the hash are not a
 * description, and neither is the "case" placeholder or a camera file name.
 */
function caseAlt(c, i) {
  const base = String(c.view_label || '').replace(/\.[a-z0-9]+$/i, '');
  const named = base.match(/^\d{4}-\d{2}-\d{2}_(.*)_[0-9a-f]{8}$/i);
  const label = (named ? named[1] : base).replace(/[-_]+/g, ' ').trim();
  return /[a-z]{3}/i.test(label) && !/^(case|img|dsc|pxl|photo|image)\s*\d*$/i.test(label) ? `Before and after: ${label}` : `Before and after result ${i + 1}`;
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
// The schedule and results photos. No cache here: the data layer already keeps both for a few minutes and
// forgets them when staff save a schedule row or publish a photo, so a second cache would show old times.
// A failed fetch is handled apart: the schedule becomes null (so it never reads as "Dr. Ali is not coming")
// and the photos an empty list.
function publicData() {
  const settle = (p) => Promise.resolve().then(() => p()).then((value) => ({ value }), (error) => ({ error }));
  return Promise.all([settle(() => state.data.schedule()), settle(() => state.data.publicCases())]).then(([schedule, cases]) => {
    if (schedule.error) console.error(schedule.error);
    return { schedule: schedule.error ? null : schedule.value || [], cases: cases.error ? [] : cases.value || [] };
  });
}

/** A place in the page for something that may or may not exist (the Results section) and can be filled again after a retry. */
function optionalSlot() {
  let node = document.createComment('results');
  return {
    get node() { return node; },
    set(el) { const next = el || document.createComment('results'); node.replaceWith(next); node = next; },
  };
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
 * `onData(data, retried)` runs after every successful fill, the first one and each "Try again", so everything that
 * depends on the data (the Results photos) is redrawn together with the sections. `focus` is the heading to move to
 * after a retry: the button that was pressed is gone, so without this focus would fall back to the top of the page.
 * Returns the public data, or null when the database could not be reached.
 */
async function fillData(slot, sections, { onData, focus } = {}) {
  slot.setAttribute('aria-busy', 'true');
  await state.ready;
  if (state.dataError || !state.data) {
    mount(slot, fallbackBlock());
    slot.removeAttribute('aria-busy');
    return null;
  }
  const load = async (retried) => {
    slot.setAttribute('aria-busy', 'true');
    const data = await publicData();
    mount(slot, sections(data, data.schedule ? undefined : () => load(true)));
    slot.removeAttribute('aria-busy');
    onData?.(data, retried);
    if (retried && slot.isConnected) { // not when the visitor has already left the page
      // Loaded: the new heading. Failed again: the new "Try again" button. Either way say so, since the old button is gone.
      const target = data.schedule ? slot.querySelector(focus) : slot.querySelector('.public-fallback button');
      if (target) { if (data.schedule) target.setAttribute('tabindex', '-1'); target.focus(); }
      announce(data.schedule ? "Dr. Ali's schedule has loaded." : 'The schedule still could not load.');
    }
    return data;
  };
  return load(false);
}

// ---------------------------------------------------------------- pages
export async function renderHome(root) {
  const meet = meetSection();
  const fillFacts = () => meet.fill(clinicFacts());
  fillFacts();
  const results = optionalSlot();
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
      meet.el,
      results.node,
      dataSlot),
    footer(),
    waFloat());

  await fillData(dataSlot, ({ schedule }, onRetry) => [
    aliWeekSection(schedule, whatsappLink, { onRetry }),
    clinicsSection(schedule, whatsappLink)], {
    focus: '#dr-ali h2',
    onData: (data, retried) => {
      if (!retried) fillFacts(); // the clinic facts are known now; a retry does not change them
      const section = resultsSection(data.cases, { limit: 6, reviews: true });
      results.set(section ? h('div', { class: 'public-main' }, section) : null);
    },
  });
}

export async function renderVisitor(root) {
  const benefits = h('div', { class: 'benefits' });
  const fillBenefits = () => mount(benefits, VISITOR.benefits(clinicFacts()).map((b) => h('div', { class: 'benefit' }, h('h3', {}, b.title), h('p', { class: 'muted' }, b.body))));
  fillBenefits();
  const results = optionalSlot();
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
        results.node,
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

  await fillData(dataSlot, ({ schedule }, onRetry) => clinicsSection(schedule, whatsappLink, { onRetry }), {
    focus: '#branches h2',
    onData: (data, retried) => {
      if (!retried) fillBenefits();
      results.set(resultsSection(data.cases));
    },
  });
}
