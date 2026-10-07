// Tiny DOM helpers. No framework: views build elements with h() and
// re-render their own container when data changes.

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
      Object.assign(el.style, value);
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

// ---------------------------------------------------------------- formatting
export function rupees(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
  const v = Number(n);
  return (v < 0 ? '-' : '') + 'Rs ' + Math.abs(Math.round(v)).toLocaleString('en-PK');
}

export function todayISO(tz = 'Asia/Karachi') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
    h('a', { href: `https://wa.me/${intl}${text ? '?text=' + encodeURIComponent(text) : ''}`, target: '_blank', rel: 'noopener', title: 'Message on WhatsApp', 'aria-label': `WhatsApp ${phone}` }, '💬'));
}

export function timeOf(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------- feedback
let toastHost;
export function toast(message, kind = 'info', ms = 4000) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = h('div', { class: ['toast', `toast-${kind}`] }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Turns database errors into plain sentences for staff. */
export function friendlyError(err) {
  const msg = (err && (err.message || err.error_description || String(err))) || 'Something went wrong';
  const known = [
    ['DUES_HOLD', 'This patient has pending dues. Clear the dues first, or ask the accountant or Dr. Ali to override.'],
    ['PHOTO_REQUIRED', 'This is a photo month. Upload the photos before completing the visit.'],
    ['CHECK_REQUIRED', 'This visit must be checked by the checker group before it can be completed.'],
    ['GROUP_NOT_ALLOWED', null],
    ['CHECKER_NOT_ALLOWED', null],
    ['row-level security', 'You do not have permission to do this. Ask Dr. Ali to tick it in the access list.'],
    ['Failed to fetch', 'No internet connection. On the Aaj ki List your changes wait on this device and go through when you are back online; elsewhere, try again once the connection is back.'],
  ];
  for (const [needle, text] of known) {
    if (msg.includes(needle)) return text || msg.replace(/^[A-Z_]+:\s*/, '');
  }
  return msg.replace(/^[A-Z_]+:\s*/, '');
}

export function modal(title, body, actions = []) {
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, actions.map((a) =>
      h('button', {
        class: a.primary ? 'btn btn-primary' : 'btn',
        onclick: async (e) => {
          // One click at a time: a double tap must not save (or create) the same thing twice.
          const buttons = [...e.currentTarget.parentElement.querySelectorAll('button')];
          if (buttons.some((b) => b.disabled)) return;
          buttons.forEach((b) => { b.disabled = true; });
          let keepOpen = false;
          try { keepOpen = (await a.onClick?.()) === false; } finally { buttons.forEach((b) => { b.disabled = false; }); }
          if (!keepOpen) close();
        },
      }, a.label))) : null);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, dialog);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  const first = dialog.querySelector('input, select, textarea, button.btn-primary');
  first?.focus();
  return { close, dialog };
}

export function field(label, input, hint) {
  const id = input.id || 'f' + Math.random().toString(36).slice(2, 8);
  input.id = id;
  return h('label', { class: 'field', for: id },
    h('span', { class: 'field-label' }, label),
    input,
    hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function select(options, value, props = {}) {
  return h('select', props, options.map((o) => {
    const opt = typeof o === 'object' ? o : { value: o, label: o };
    return h('option', { value: opt.value, selected: String(opt.value) === String(value ?? '') }, opt.label);
  }));
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
