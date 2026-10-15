// Arrange my menu: each staff member chooses what is on the top menu bar and in what order (the owner's request, 12 Oct 2026:
// "employees should habe option to rearrange the tabs on the top in any order they want, so they can keep most used things in
// the one click access"). Pure functions, no DOM, no storage, so every rule can be tested in Node (tests/menu-arrange.test.ts).
// The browser side (the saved copy, the dialog, a top bar that must fit on one line) is web/js/views/staff/nav-arrange.js.
//
// The menu is what shell.js's menu() returns, already cut down to what the person's permissions allow: links
// ({ label, href, key }) and drop-downs ({ label, key, items }, the items being links and { divider: true }). Arranging only
// ever reorders and moves those entries, so it never shows a page the person may not open. Every page is known by its address
// without '#/staff/' ('patients', 'reports?group=financial') and every drop-down other than More by 'menu:' and its key
// ('menu:reports'), so a page added to menu() later needs no key of its own.
//
// What is saved (public.staff_menu_prefs.arrangement, at most 60 short strings):
//   'key'   on the top bar, in this order;
//   '-key'  taken off the top bar (only said of what the clinic's menu has on the top bar).
// [] is the clinic's own menu. Whatever the list does not mention is in its default place: something the clinic's menu has on
// the top bar (added since the person saved, or one they may open only now) is put back next to the entry before it, and every
// other page stays in its drop-down. Keys the menu does not have (a page that was removed, or one the person may not open)
// are skipped.
//
// On an arranged top bar the pages that are not on it are under More: first the pages of the clinic's top bar that were taken
// off it, then each drop-down that is not on the top bar under its own name (Aaj ki List, Reports, Coordinator), then More's
// own pages. Such a drop-down is one item of More, a section { heading, key, items } with all its pages and its own lines
// (Reports: the report groups, a line, the Accounts tabs), so a line inside it never cuts its last pages off from its name.
// Every name on the bar is different from the others (barLabel): a page put on it from a drop-down says where it
// comes from when its name is taken ("Patients (Reports)"), and the Aaj ki List page reads "Aaj ki List (today)".

export const MAX_KEYS = 60;
// The same rule as the database's check constraint (supabase/migrations/20261015000100_staff_menu_prefs.sql).
export const KEY_PATTERN = /^-?[A-Za-z0-9:_?=&./-]{1,80}$/;

const MORE = 'more';
/** '#/staff/reports?group=financial' -> 'reports?group=financial' ('' for anything that is not a staff page). */
export const pageKey = (href) => (/^#\/staff\/./.test(String(href || '')) ? String(href).slice('#/staff/'.length) : '');
const groupKey = (key) => `menu:${key}`;
const isLink = (m) => !m.items && !!pageKey(m.href);

/**
 * A saved arrangement as read from storage or the database: only well-formed keys, each once, at most MAX_KEYS. It stops at
 * the 60th key and looks at each entry once, so even a damaged or tampered copy with a huge list is cleaned at once.
 */
export function cleanArrangement(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const k of value) {
    if (out.length >= MAX_KEYS) break;
    if (typeof k === 'string' && KEY_PATTERN.test(k) && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/**
 * Every entry the person can place: { key, label, kind: 'page' | 'group', top (on the clinic's top bar), group (the key of the
 * drop-down a page is in, null for a top-bar page), groupLabel (its name; null in More), item (the menu's own link) or menu
 * (the drop-down) }, in the menu's order. More itself is not an entry: it always comes last and holds the rest.
 */
export function menuEntries(menu) {
  const entries = [];
  const seen = new Set();
  for (const m of menu || []) {
    if (m.items) {
      const inMore = m.key === MORE;
      if (!inMore) entries.push({ key: groupKey(m.key), label: m.label, kind: 'group', top: true, menu: m });
      for (const i of m.items) {
        const key = pageKey(i.href);
        if (i.divider || i.heading || !key || seen.has(key)) continue;
        seen.add(key);
        entries.push({ key, label: i.label, kind: 'page', top: false, group: m.key, groupLabel: inMore ? null : m.label, item: i });
      }
    } else if (isLink(m)) {
      const key = pageKey(m.href);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, label: m.label, kind: 'page', top: true, group: null, groupLabel: null, item: m });
    }
  }
  return entries;
}

// A drop-down's page that has the drop-down's own name (the Aaj ki List page in the Aaj ki List drop-down): on the top bar by
// itself it says what it opens, so it is never a second "Aaj ki List" beside the drop-down. The drop-down keeps the name
// everyone knows from the clinic's menu; only the link the person added reads differently.
const OWN_PAGE_NOTE = { sheet: 'today' }; // #/staff/sheet opens today's list (other days are in History of Aaj ki List)

/**
 * A page's name on the top bar (and in the dialog), different from every other name there. A page from a drop-down whose
 * name another page or a drop-down also has says which drop-down it comes from: "Patients (Reports)". One with its own
 * drop-down's name says what it opens: "Aaj ki List (today)" ("(page)" for one this file has no word for).
 */
export function barLabel(entries, e) {
  if (e.kind !== 'page' || !e.groupLabel) return e.label;
  if (e.label === e.groupLabel) return `${e.label} (${OWN_PAGE_NOTE[e.key] || 'page'})`;
  return entries.some((x) => x !== e && x.label === e.label) ? `${e.label} (${e.groupLabel})` : e.label;
}

const defaultTop = (entries) => entries.filter((e) => e.top).map((e) => e.key);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The keys on the person's top bar, in order (see the top of this file for what the saved list means). */
export function topKeys(entries, saved) {
  const known = new Set(entries.map((e) => e.key));
  const list = cleanArrangement(saved);
  const removed = new Set(list.filter((k) => k.startsWith('-')).map((k) => k.slice(1)));
  const top = [];
  for (const k of list) if (!k.startsWith('-') && known.has(k) && !top.includes(k)) top.push(k);
  const defaults = defaultTop(entries);
  defaults.forEach((k, i) => {
    if (top.includes(k) || removed.has(k)) return;
    // Not mentioned: next to the nearest entry before it on the clinic's top bar that is on this top bar too (else first).
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const p = top.indexOf(defaults[j]);
      if (p >= 0) { at = p + 1; break; }
    }
    top.splice(at, 0, k);
  });
  return top;
}

/** What to save for a top bar of these keys: [] for the clinic's own menu. */
export function arrangementFor(entries, top) {
  const known = new Set(entries.map((e) => e.key));
  const keys = top.filter((k, i) => known.has(k) && top.indexOf(k) === i);
  const defaults = defaultTop(entries);
  if (sameList(keys, defaults)) return [];
  return [...keys, ...defaults.filter((k) => !keys.includes(k)).map((k) => `-${k}`)].slice(0, MAX_KEYS);
}

// Drop dividers at the edges and doubled ones (the pages between them may have moved to the top bar).
function trim(items) {
  const out = [];
  for (const i of items) if (!(i.divider && (!out.length || out[out.length - 1].divider))) out.push(i);
  while (out[out.length - 1]?.divider) out.pop();
  return out;
}
const parse = (key) => { const [path, query = ''] = String(key).replace(/^#\/staff\//, '').split('?'); return { path, params: new URLSearchParams(query) }; };

/**
 * Whether the page `key` ('coordinator?tab=lab') is the one at the address `here` ('#/staff/coordinator?tab=lab'): the same page,
 * with everything after its '?' the same there too (the address may say more: a report's dates, a branch).
 */
export function atAddress(key, here) {
  const page = parse(key);
  const now = parse(here);
  return page.path === now.path && [...page.params].every(([k, v]) => now.params.get(k) === v);
}

/**
 * The menu in the same shape as menu(), arranged by `saved`, and More may hold sections: { heading, key, items } for each drop-down
 * that is not on the top bar. The clinic's own menu comes back unchanged (the same array) when nothing differs from it.
 * { spill: n } moves the last n entries of the top bar into More (a top bar too long for the screen).
 * { here } is the address on screen ('#/staff/coordinator?tab=lab'): a page put on the top bar from a drop-down (or More) is
 * marked as the current one (key = its section, as shell.js's current() expects) only at its own address, on that very tab.
 * shell.js's current() also counts a section's other pages as that drop-down's (Checkups and History of Aaj ki List light
 * up the Aaj ki List drop-down), so going by the key alone would mark "Aaj ki List (today)" as the page on screen beside
 * Checkups. The pages change tabs without a new address event, so nav-arrange.js marks a link with a tab again from the
 * address as it is then (atAddress). The clinic's own top-bar links keep shell.js's rule (Patients on a patient's file).
 */
export function arrangeMenu(menu, saved, { spill = 0, here = '' } = {}) {
  const entries = menuEntries(menu);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const all = topKeys(entries, saved);
  const top = spill > 0 ? all.slice(0, Math.max(0, all.length - spill)) : all;
  if (sameList(top, defaultTop(entries))) return menu;
  const onTop = new Set(top);
  const open = (i) => i.divider || !onTop.has(pageKey(i.href)); // still in its drop-down (anything that is not a page stays too)
  const pinned = (e) => {
    const { path, params } = parse(e.key);
    const tab = [...params.keys()].length > 0;
    const current = (e.group === null && !tab) || atAddress(e.key, here);
    return { ...e.item, label: barLabel(entries, e), key: current ? (e.item.key || path) : `page:${e.key}` };
  };
  const out = [];
  for (const k of top) {
    const e = byKey.get(k);
    if (e.kind === 'page') out.push(pinned(e));
    else {
      const items = trim(e.menu.items.filter(open));
      if (items.length) out.push({ ...e.menu, items });
    }
  }
  // Anything at the top level that is neither a link nor a drop-down (none today) keeps its place on the bar.
  for (const m of menu) if (!m.items && !isLink(m)) out.push(m);
  // More: the clinic's top-bar pages taken off it, each drop-down that is not on the top bar under its own name, then More's own pages.
  // Such a drop-down is one item, a section with its own lines inside it: they never part its last pages from its name.
  const sections = [];
  const loose = entries.filter((e) => e.kind === 'page' && e.top && !onTop.has(e.key)).map((e) => e.item);
  if (loose.length) sections.push({ items: loose });
  const groups = menu.filter((m) => m.items && m.key !== MORE && !onTop.has(groupKey(m.key)));
  for (const m of groups) {
    const inside = trim(m.items.filter(open));
    sections.push({ items: inside.length ? [{ heading: m.label, key: m.key, items: inside }] : [] });
  }
  const more = menu.find((m) => m.items && m.key === MORE);
  if (more) sections.push({ items: trim(more.items.filter(open)) });
  const items = [];
  for (const s of sections.filter((x) => x.items.length)) {
    if (items.length) items.push({ divider: true });
    items.push(...s.items);
  }
  if (items.length) out.push({ ...(more || { label: 'More', key: MORE }), items });
  return out;
}
