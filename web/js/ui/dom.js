// Tiny DOM helpers. No framework: views build elements with h() and
// re-render their own container when data changes.

const TZ = 'Asia/Karachi';
let idSeq = 0;
const uid = (prefix) => `${prefix}-${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * h('div', { class: 'x', onclick: fn }, 'text', child, [children])
 * Props starting with "on" become event listeners; `dataset`, `style` (object)
 * and boolean attributes are handled; null/false children are skipped.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    } else if (key === 'style' && typeof value === 'object') {
      setStyle(el, value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'value' && ('value' in el)) {
      el.value = value;
    } else if (key === 'checked' || key === 'selected' || key === 'disabled' || key === 'hidden' || key === 'required') {
      el[key] = Boolean(value);
    } else if (key === 'html') {
      el.innerHTML = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

// CSS custom properties ('--inv-accent') only work through setProperty;
// Object.assign(el.style, ...) silently drops them.
function setStyle(el, styles) {
  for (const [key, value] of Object.entries(styles)) {
    if (key.startsWith('--')) el.style.setProperty(key, value === null || value === undefined ? '' : String(value));
    else el.style[key] = value ?? '';
  }
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
  return container;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Text only screen readers hear. */
export function srOnly(text) {
  return h('span', { class: 'sr-only' }, text);
}

/** A link that opens in a new tab, and says so to screen readers. */
export function extLink(href, text, props = {}) {
  const note = ' (opens in a new tab)';
  const p = { ...props };
  if (p['aria-label']) p['aria-label'] += note;
  return h('a', { href, target: '_blank', rel: 'noopener', ...p }, text, p['aria-label'] ? null : srOnly(note));
}

// ---------------------------------------------------------------- formatting
export function rupees(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
  const v = Number(n);
  return (v < 0 ? '-' : '') + 'Rs ' + Math.abs(Math.round(v)).toLocaleString('en-PK');
}

export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Phone number shown with a WhatsApp link (Pakistani numbers: 03xx → 923xx). */
export function phoneLink(phone, text = '') {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return h('span', { class: 'muted' }, phone || '');
  const intl = digits.startsWith('0') ? '92' + digits.slice(1) : digits;
  return h('span', { class: 'phone-link' }, phone, ' ',
    h('a', { href: `https://wa.me/${intl}${text ? '?text=' + encodeURIComponent(text) : ''}`, target: '_blank', rel: 'noopener', title: 'Message on WhatsApp', 'aria-label': `Message ${phone} on WhatsApp (opens in a new tab)` }, '💬'));
}

export function timeOf(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------- dates
// Calendar dates are 'YYYY-MM-DD' strings in clinic time (Asia/Karachi).
// Never use new Date().toISOString().slice(0, 10) for them: that is the UTC
// date, which is still yesterday in Pakistan until 5 AM.
const pad2 = (n) => String(n).padStart(2, '0');
const utcISO = (d) => `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/** The calendar date of a moment, in clinic time. */
export function localISO(date = new Date(), tz = TZ) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function todayISO(tz = TZ) {
  return localISO(new Date(), tz);
}

/** '2026-10-07' + 3 days → '2026-10-10'. Works on the date alone, so no time zone can shift it. */
export function addDaysISO(iso, n) {
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n));
  return utcISO(d);
}

/** Adds months, keeping to the last day of a shorter month: 31 Jan + 1 → 28 (or 29) Feb. */
export function addMonthsISO(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const months = y * 12 + (m - 1) + Number(n);
  const year = Math.floor(months / 12);
  const month = months - year * 12; // 0-11
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${pad2(month + 1)}-${pad2(Math.min(d, lastDay))}`;
}

// ---------------------------------------------------------------- live regions
// Screen readers only announce changes to a live region that already exists,
// so the page's regions ship in index.html (or are made once, here) and stay
// empty until there is something to say. Each open dialog has its own pair,
// because content outside an aria-modal dialog is hidden from screen readers.
const openModals = []; // the last one is on top
const clearTimers = new WeakMap();

function pageRegion(assertive) {
  const id = assertive ? 'live-assertive' : 'live-polite';
  let el = document.getElementById(id);
  if (!el) {
    el = h('div', { id, role: assertive ? 'alert' : 'status', 'aria-live': assertive ? 'assertive' : 'polite', 'aria-atomic': 'true' });
    let host = document.getElementById('live-regions');
    if (!host) { host = h('div', { id: 'live-regions', class: 'sr-only' }); document.body.append(host); }
    host.append(el);
  }
  return el;
}

function liveRegion(assertive) {
  const top = openModals[openModals.length - 1];
  if (top) return assertive ? top.assertive : top.polite;
  return pageRegion(assertive);
}

let messageGen = 0; // bumped by clearMessages(), so announcements still waiting to be written are dropped

/** Says a short message to screen-reader users without moving focus. */
export function announce(text, { assertive = false } = {}) {
  const msg = String(text ?? '').trim();
  if (!msg) return;
  // Written a moment later (and into whichever region is current then), so the
  // same message twice is spoken twice and a dialog closing right after does not swallow it.
  const gen = messageGen;
  setTimeout(() => {
    if (gen !== messageGen) return;
    const region = liveRegion(assertive);
    region.textContent = msg;
    clearTimeout(clearTimers.get(region));
    clearTimers.set(region, setTimeout(() => { if (region.textContent === msg) region.textContent = ''; }, 7000));
  }, 60);
}

function toastHost() {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { class: 'toasts', id: 'toasts' }); document.body.append(host); }
  return host;
}

if (typeof document !== 'undefined' && document.body) { pageRegion(false); pageRegion(true); toastHost(); }

// ---------------------------------------------------------------- feedback
/**
 * A short message at the bottom of the screen. It is also spoken (errors
 * straight away). Errors stay at least 10 s and have a close button; any toast
 * stays while the pointer or keyboard focus is on it.
 */
export function toast(message, kind = 'info', ms = 4000) {
  const isError = kind === 'error';
  const text = typeof message === 'string' ? message : (message?.textContent || String(message ?? ''));
  const host = toastHost();
  // The same message again (a retry that fails again) replaces the one on screen instead of stacking.
  for (const old of [...host.children]) if (old.dataset.text === text && old.dataset.kind === kind) old.remove();
  const t = h('div', { class: ['toast', `toast-${kind}`], dataset: { text, kind } }, h('span', {}, message));
  let timer;
  const dismiss = () => { clearTimeout(timer); t.remove(); };
  const arm = () => { clearTimeout(timer); timer = setTimeout(dismiss, isError ? Math.max(ms, 10000) : ms); };
  if (isError) t.append(h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss this message', onclick: dismiss }, '×'));
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', arm);
  t.addEventListener('focusin', () => clearTimeout(timer));
  t.addEventListener('focusout', arm);
  host.append(t);
  arm();
  announce(text, { assertive: isError });
}

/** Takes every toast and spoken message off the screen at once. Logout uses it, because they can name patients. */
export function clearMessages() {
  messageGen++;
  document.getElementById('toasts')?.replaceChildren();
  for (const region of document.querySelectorAll('#live-regions [aria-live]')) region.textContent = '';
}

// Plain connection trouble. The app's own markers count too: a read that gave up (js/data/supabase.js) reaches
// here as "TIMEOUT: ..." (postgrest-js puts the error name in front), and a CDN that never answered says "did not respond".
const NETWORK = /Failed to fetch|NetworkError|Load failed|network (error|request failed)|\bTIMEOUT:|\btimed out\b|did not respond/i;
// The database stopped a slow query (Postgres code 57014). The connection is fine; the request was too big.
const DB_BUSY = /statement timeout|lock timeout|canceling statement/i;

/**
 * Turns database errors into plain sentences. Staff wording by default;
 * { audience: 'public' } for visitors and patients, who never see database text.
 */
export function friendlyError(err, { audience = 'staff' } = {}) {
  const msg = (err && (err.message || err.error_description || String(err))) || 'Something went wrong';
  const isPublic = audience === 'public';
  if (err?.code === '57014' || DB_BUSY.test(msg)) {
    return isPublic
      ? 'The clinic system is busy right now. Please try again in a minute.'
      : 'The database took too long on this. Try a shorter date range or a narrower search.';
  }
  if (NETWORK.test(msg)) {
    return isPublic
      ? 'We could not reach the clinic system. Check your internet connection and try again.'
      : 'No internet connection, so this did not go through. Try again once the connection is back.';
  }
  if (isPublic) {
    if (msg.includes('row-level security')) return 'This is not available from your account. Please contact the clinic.';
    return 'Something went wrong. Please try again, or message the clinic on WhatsApp.';
  }
  const known = [
    ['DUES_HOLD', 'This patient has pending dues. Clear the dues first, or ask the accountant or Dr. Ali to override.'],
    ['PHOTO_REQUIRED', 'This is a photo month. Upload the photos before completing the visit.'],
    ['CHECK_REQUIRED', 'This visit must be checked by the checker group before it can be completed.'],
    ['GROUP_NOT_ALLOWED', null],
    ['CHECKER_NOT_ALLOWED', null],
    ['row-level security', 'You do not have permission to do this. Ask Dr. Ali to tick it in the access list.'],
  ];
  for (const [needle, text] of known) {
    if (msg.includes(needle)) return text || msg.replace(/^[A-Z_]+:\s*/, '');
  }
  return msg.replace(/^[A-Z_]+:\s*/, '');
}

/**
 * Wraps an async click handler: the button is disabled while it runs, a second
 * click is ignored, and a failure shows as an error toast (and returns false,
 * so a dialog action wrapped in busy() stays open).
 */
export function busy(handler) {
  let running = false;
  return async function busyHandler(e) {
    if (running) return undefined;
    running = true;
    const btn = e?.currentTarget instanceof Element ? e.currentTarget : null;
    const hadFocus = btn && document.activeElement === btn;
    if (btn && 'disabled' in btn) btn.disabled = true;
    btn?.setAttribute('aria-busy', 'true');
    try {
      return await handler.call(this, e);
    } catch (err) {
      console.error(err);
      toast(friendlyError(err), 'error');
      return false;
    } finally {
      running = false;
      if (btn) {
        if ('disabled' in btn) btn.disabled = false;
        btn.removeAttribute('aria-busy');
        // Disabling a focused button can drop focus to the page; put it back.
        if (hadFocus && btn.isConnected && (!document.activeElement || document.activeElement === document.body)) btn.focus();
      }
    }
  };
}

// ---------------------------------------------------------------- dialogs
const FOCUSABLE = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length && !el.closest('[inert]'));

// While a dialog is open the rest of the page is inert (not clickable, not
// focusable, hidden from screen readers), except the toasts and live regions.
function syncInert() {
  const top = openModals[openModals.length - 1];
  for (const el of document.body.children) {
    const keep = !top || el === top.backdrop || el.id === 'toasts' || el.id === 'live-regions';
    if (!keep && !el.inert) { el.inert = true; el.dataset.modalInert = ''; }
    else if (keep && 'modalInert' in el.dataset) { el.inert = false; delete el.dataset.modalInert; }
  }
}

function focusEl(el, options) {
  if (!el) return;
  if (!el.matches(FOCUSABLE) && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus(options);
}

/**
 * modal('Title', body, [{ label, primary, danger, onClick }], opts)
 * onClick returning false keeps the dialog open; throwing shows the error and keeps it open.
 * opts.destructive: start on the Cancel (non-primary) button, or the title if there is none.
 * opts.initialFocus: the element to start on. opts.alert: an alertdialog (urgent).
 * opts.onClose(): called once, however the dialog closes.
 * Focus stays inside the dialog and returns to the button that opened it.
 */
export function modal(title, body, actions = [], opts = {}) {
  const opener = document.activeElement;
  const openerFp = fingerprint(opener);
  const titleId = uid('dlg-title');
  const bodyId = uid('dlg-body');
  const heading = h('h2', { id: titleId, tabindex: '-1' }, title);
  const polite = h('div', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const assertive = h('div', { role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true' });
  let closed = false;
  let working = false;

  const buttons = actions.map((a) => h('button', {
    type: 'button',
    class: ['btn', a.danger ? 'btn-danger' : a.primary ? 'btn-primary' : ''],
    onclick: async () => {
      // One click at a time: a double tap must not save (or create) the same thing twice.
      if (working) return;
      working = true;
      const active = document.activeElement;
      buttons.forEach((b) => { b.disabled = true; });
      let keepOpen = false;
      try {
        keepOpen = (await a.onClick?.()) === false;
      } catch (err) {
        console.error(err);
        keepOpen = true;
        toast(friendlyError(err), 'error');
      } finally {
        working = false;
        buttons.forEach((b) => { b.disabled = false; });
        if (keepOpen && !closed && (!document.activeElement || document.activeElement === document.body) && active?.isConnected) active.focus();
      }
      if (!keepOpen) close();
    },
  }, a.label));

  const dialog = h('div', {
    class: 'modal', role: opts.alert ? 'alertdialog' : 'dialog', 'aria-modal': 'true',
    'aria-labelledby': titleId, 'aria-describedby': opts.destructive || opts.alert ? bodyId : null,
  },
  h('div', { class: 'modal-head' },
    heading,
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, '×')),
  h('div', { class: 'modal-body', id: bodyId }, body),
  buttons.length ? h('div', { class: 'modal-actions' }, buttons) : null,
  h('div', { class: 'sr-only' }, polite, assertive));
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, dialog);

  const onKey = (e) => {
    if (openModals[openModals.length - 1] !== entry) return; // only the dialog on top reacts
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = focusables(dialog);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === heading || !dialog.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !dialog.contains(active))) { e.preventDefault(); first.focus(); }
  };

  function finish(restoreFocus) {
    if (closed) return;
    closed = true;
    const i = openModals.indexOf(entry);
    if (i >= 0) openModals.splice(i, 1);
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    syncInert();
    if (restoreFocus) returnFocus(opener, openerFp);
    opts.onClose?.();
  }
  const close = () => finish(true);
  const entry = { backdrop, dialog, polite, assertive, close: finish };

  document.body.append(backdrop);
  openModals.push(entry);
  syncInert();
  document.addEventListener('keydown', onKey);

  const isSafe = (i) => !actions[i].primary && !actions[i].danger;
  const start = opts.initialFocus
    || (opts.destructive ? (buttons.find((b, i) => isSafe(i)) || heading) : null)
    || dialog.querySelector('.modal-body input:not([type="hidden"]):not([disabled]), .modal-body select:not([disabled]), .modal-body textarea:not([disabled])')
    || buttons.find((b, i) => actions[i].primary && !actions[i].danger)
    || heading;
  focusEl(start);
  return { close, dialog };
}

// ---- keeping the person's place after a dialog
// A dialog action usually saves and then re-renders the page, which replaces the button that opened the dialog,
// and focus would drop to <body> (back to the top of the page for a keyboard or screen-reader user). So a dialog
// remembers what its opener looked like: the same kind of control with the same name in the same row. If the
// opener is replaced, focus goes to its twin in the new page, or failing that to the page heading.
const ROW = 'tr, li, [role="row"], .card';
const nameOf = (el) => (el.getAttribute('aria-label') || el.textContent).replace(/\s+/g, ' ').trim();
const rowOf = (el) => (el.closest(ROW)?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
const twinsOf = (app, tag, name) => [...app.querySelectorAll(tag)].filter((n) => nameOf(n) === name);

function fingerprint(el) {
  const app = document.getElementById('app');
  if (!app || !el || !app.contains(el) || !nameOf(el)) return null;
  return { tag: el.localName, name: nameOf(el), row: rowOf(el), index: twinsOf(app, el.localName, nameOf(el)).indexOf(el) };
}

// Same row if the row's text still matches, otherwise the same position among the controls of that name.
function findTwin(fp) {
  const app = document.getElementById('app');
  if (!fp || !app) return null;
  const twins = twinsOf(app, fp.tag, fp.name);
  return twins.find((n) => rowOf(n) === fp.row) || twins[Math.min(fp.index, twins.length - 1)] || null;
}

// The opener still exists when the dialog closes, but the page re-renders a moment later (after a save).
// Watch the page for that one re-render. The watch ends at the first key press or tap, when focus is
// somewhere real, or after 10 seconds, so focus is never moved from under the person.
function watchRerender(opener, fp) {
  const app = document.getElementById('app');
  if (!app || !app.contains(opener)) return;
  const ctl = new AbortController();
  let settle;
  const stop = () => { ctl.abort(); observer.disconnect(); clearTimeout(settle); clearTimeout(giveUp); };
  const lost = () => !document.activeElement || document.activeElement === document.body || document.activeElement === document.documentElement;
  const refocus = (last) => { // true once the watch is over
    if (!lost()) { stop(); return true; }
    const target = findTwin(fp) || (last ? app.querySelector('h1') : null);
    if (!target) return false;
    stop();
    focusEl(target, { preventScroll: true });
    return true;
  };
  const observer = new MutationObserver(() => {
    if (opener.isConnected) return; // not replaced yet
    if (refocus(false)) return;
    clearTimeout(settle);
    settle = setTimeout(() => refocus(true), 150); // the page finished re-rendering and has no twin: the heading
  });
  observer.observe(app, { childList: true, subtree: true });
  const giveUp = setTimeout(stop, 10000);
  for (const type of ['keydown', 'pointerdown']) document.addEventListener(type, stop, { capture: true, signal: ctl.signal });
}

function returnFocus(opener, fp) {
  if (opener && opener !== document.body && opener.isConnected && !opener.closest('[inert]')) {
    opener.focus();
    watchRerender(opener, fp);
    return;
  }
  // The button that opened the dialog was replaced while it was open: go to the dialog underneath, else to the
  // same button in the new page, else to the page heading.
  const top = openModals[openModals.length - 1];
  focusEl(top ? top.dialog.querySelector('h2') : (findTwin(fp) || document.querySelector('#app h1')), { preventScroll: true });
}

/** Closes every open dialog (route changes and logout), without moving focus. */
export function closeAllModals() {
  for (const m of [...openModals].reverse()) m.close(false);
}

// ---------------------------------------------------------------- forms
const fieldErrors = new WeakMap(); // control → its error element
const errorClearers = new WeakMap(); // control → listener that clears the error once the person edits

// field() may be given a wrapper (an input with buttons beside it): label the real control inside.
function controlOf(el) {
  if (!el?.matches) return el;
  return el.matches('input, select, textarea, button') ? el : (el.querySelector('input:not([type="hidden"]), select, textarea') || el);
}

function addDescribedBy(el, id) {
  const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  if (!ids.includes(id)) ids.push(id);
  el.setAttribute('aria-describedby', ids.join(' '));
}

function removeDescribedBy(el, id) {
  const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== id);
  if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
  else el.removeAttribute('aria-describedby');
}

/**
 * A labelled form field. The hint is linked as a description (not part of the
 * label), and { required: true } marks the field visibly and for screen readers.
 */
export function field(label, input, hint, { required = false } = {}) {
  const control = controlOf(input);
  const id = control.id || uid('f');
  control.id = id;
  const hintEl = hint ? h('span', { class: 'field-hint', id: `${id}-hint` }, hint) : null;
  if (hintEl) addDescribedBy(control, hintEl.id);
  if (required && control.matches?.('input, select, textarea')) {
    control.required = true;
    control.setAttribute('aria-required', 'true');
  }
  return h('div', { class: 'field' },
    h('label', { class: 'field-label', for: id }, label, required ? h('span', { class: 'req' }, ' (required)') : null),
    input,
    hintEl);
}

function clearOne(control) {
  const err = fieldErrors.get(control);
  control.removeAttribute('aria-invalid');
  if (err) { removeDescribedBy(control, err.id); err.remove(); fieldErrors.delete(control); }
  const off = errorClearers.get(control);
  if (off) { control.removeEventListener('input', off); control.removeEventListener('change', off); errorClearers.delete(control); }
}

/** Shows an error message under a field and marks it invalid. It clears once the person edits the field. */
export function setFieldError(input, message) {
  const control = controlOf(input);
  if (!control.id) control.id = uid('f');
  let err = fieldErrors.get(control);
  if (!err) {
    err = h('span', { class: 'field-error', id: `${control.id}-error`, dataset: { fieldError: '' } });
    fieldErrors.set(control, err);
  }
  err.textContent = message;
  if (!err.isConnected) {
    // Inside field(): straight after the input (or its wrapper), before the hint.
    const wrap = control.closest('.field');
    const anchor = (wrap && [...wrap.children].find((c) => c.contains(control))) || input;
    anchor.after(err);
  }
  control.setAttribute('aria-invalid', 'true');
  addDescribedBy(control, err.id);
  if (!errorClearers.has(control)) {
    const off = () => clearOne(control);
    errorClearers.set(control, off);
    control.addEventListener('input', off);
    control.addEventListener('change', off);
  }
}

/** Removes every field error setFieldError() made inside root (other .field-error text is left alone). */
export function clearFieldErrors(root) {
  if (!root) return;
  for (const el of root.querySelectorAll('[aria-invalid="true"]')) clearOne(el);
  for (const el of root.querySelectorAll('[data-field-error]')) el.remove();
}

/**
 * showFormErrors(dialog, [{ input, message }]): marks every field, moves focus to
 * the first one and says how many need fixing. Returns false when there were
 * errors, so a dialog action can `return showFormErrors(...)` to stay open.
 */
export function showFormErrors(root, errors = []) {
  clearFieldErrors(root);
  const list = errors.filter(Boolean);
  if (!list.length) return true;
  const withField = list.filter((e) => e.input);
  for (const e of list) if (!e.input) toast(e.message, 'error');
  for (const e of withField) setFieldError(e.input, e.message);
  if (withField.length) {
    controlOf(withField[0].input).focus();
    const n = withField.length;
    announce(n === 1 ? `1 thing to fix: ${withField[0].message}` : `${n} things to fix. The first: ${withField[0].message}`);
  }
  return false;
}

export function select(options, value, props = {}) {
  return h('select', props, options.map((o) => {
    const opt = typeof o === 'object' ? o : { value: o, label: o };
    return h('option', { value: opt.value, selected: String(opt.value) === String(value ?? '') }, opt.label);
  }));
}

// ---------------------------------------------------------------- tabs
/**
 * tabs({ label, items: [{ id, label }], current, onChange, panel, class })
 * → { el, setCurrent, panel, panelId }
 * A full ARIA tab strip: arrow keys, Home and End move between tabs; Enter,
 * Space or a click selects one and calls onChange(id). The strip is never
 * rebuilt, so focus stays on the tab. Render the content into `panel` (made for
 * you, or pass your own element) so the tabs and the panel are linked.
 */
export function tabs({ label, items = [], current, onChange, panel, class: extra } = {}) {
  const base = uid('tabs');
  // An id that matches no tab (an old link, a tab this person may not use) falls back to the first one, so
  // exactly one tab is always selected and reachable by keyboard. Callers pick the same fallback for their panel.
  const known = (id) => items.some((it) => String(it.id) === String(id));
  let selected = known(current) ? current : items[0]?.id;
  const tabId = (id) => `${base}-${String(id).replace(/[^\w-]/g, '_')}`;
  const panelEl = panel || h('div', {});
  panelEl.setAttribute('role', 'tabpanel');
  if (!panelEl.id) panelEl.id = `${base}-panel`;
  if (!panelEl.hasAttribute('tabindex')) panelEl.tabIndex = 0;

  const buttons = items.map((it) => h('button', { type: 'button', role: 'tab', class: 'tab', id: tabId(it.id), onclick: () => choose(it.id) }, it.label));
  const el = h('div', { class: ['tabs', extra], role: 'tablist', 'aria-label': label || null }, buttons);

  function paint() {
    buttons.forEach((b, i) => {
      const on = String(items[i].id) === String(selected);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    panelEl.setAttribute('aria-labelledby', tabId(selected));
  }
  // aria-controls only once the panel is on the page, so it never points at nothing.
  function wire() {
    for (const b of buttons) {
      if (panelEl.isConnected) b.setAttribute('aria-controls', panelEl.id);
      else b.removeAttribute('aria-controls');
    }
  }
  function choose(id) {
    wire();
    if (String(id) === String(selected)) return;
    selected = id;
    paint();
    onChange?.(id);
  }
  el.addEventListener('focusin', wire);
  el.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const next = e.key === 'ArrowRight' ? (i + 1) % buttons.length
      : e.key === 'ArrowLeft' ? (i - 1 + buttons.length) % buttons.length
        : e.key === 'Home' ? 0
          : e.key === 'End' ? buttons.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    buttons[next].focus();
  });
  paint();
  return { el, panel: panelEl, panelId: panelEl.id, setCurrent(id) { selected = known(id) ? id : items[0]?.id; paint(); } };
}

export function downloadCSV(filename, rows) {
  if (!rows.length) return toast('Nothing to download yet.');
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

export function empty(text, action) {
  return h('div', { class: 'empty' }, h('p', {}, text), action || null);
}
