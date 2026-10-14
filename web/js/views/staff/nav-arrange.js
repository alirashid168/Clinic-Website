// "Arrange my menu": each staff member puts the pages they use most on the top bar, in their own order (the owner's request,
// 12 Oct 2026). The rules are in ../../lib/menu-arrange.js. This file keeps the person's arrangement, applies it to shell.js's
// menu, keeps the top bar on one line, and has the dialog (opened from the name menu and from the phone drawer).
//
// Where the arrangement lives: one row per staff member in the database (public.staff_menu_prefs, 20261012000300), so it
// follows them to any computer, plus a copy on this computer (localStorage, per staff id) so the menu draws at once. The row
// is read again at every sign-in (loadArrangement) and its answer replaces the copy. Until that database update is run the
// website works as before: the default menu for everyone, and Save keeps the arrangement on this computer only (it says so).
// The copy holds only page keys, nothing about patients, so it is left behind at logout like the other per-person settings.
import { h, modal, toast, announce } from '../../ui/dom.js';
import { state } from '../../state.js';
import { menuEntries, topKeys, arrangeMenu, arrangementFor, cleanArrangement } from '../../lib/menu-arrange.js';

const COPY_KEY = (staffId) => `staff-menu:${staffId}`;
const LONG_BAR = 9; // more entries than this on the top bar: the dialog warns that it may not fit on a small laptop
const inMemory = new Map(); // staff id -> arrangement, for a browser that blocks storage
let loadGen = 0; // a sign-in's read that answers after a Save must not undo it

function readCopy(staffId) {
  try {
    const text = localStorage.getItem(COPY_KEY(staffId));
    return text === null ? null : cleanArrangement(JSON.parse(text));
  } catch { return null; } // blocked storage or a damaged copy: the menu falls back to the default
}
function keep(staffId, list) {
  inMemory.set(staffId, list);
  try { localStorage.setItem(COPY_KEY(staffId), JSON.stringify(list)); } catch { /* storage blocked: kept for this page only */ }
}

/** The signed-in person's saved arrangement ([] = the clinic's default menu). */
export function myArrangement() {
  const id = state.session?.staff?.id;
  if (!id) return [];
  return readCopy(id) ?? inMemory.get(id) ?? [];
}

/**
 * After a sign-in: reads the person's saved arrangement from the database into the copy on this computer. Never fails, and
 * waits at most `wait` ms (shell.js loads it beside the staff lists it already waits for): a slower answer is kept for the next
 * page. No row (never saved, or the database update not run yet) keeps the copy as it is.
 */
export function loadArrangement({ wait = 2500 } = {}) {
  const id = state.session?.staff?.id;
  if (!id || typeof state.data?.myMenuArrangement !== 'function') return Promise.resolve();
  const gen = ++loadGen;
  const load = state.data.myMenuArrangement()
    .then((list) => { if (list !== null && gen === loadGen && state.session?.staff?.id === id) keep(id, cleanArrangement(list)); })
    .catch(() => { /* no connection or no answer: the copy on this computer is used */ });
  let timer;
  return Promise.race([load, new Promise((resolve) => { timer = setTimeout(resolve, wait); })]).finally(() => clearTimeout(timer));
}

/** shell.js's menu() as this person arranged it. { spill: n } moves the last n top-bar entries into More. */
export const arrangedMenu = (menu, { spill = 0 } = {}) => arrangeMenu(menu, myArrangement(), { spill, here: location.hash });

let redraw = null; // draws the menus of the page on screen again (set by arrangeNav; Save calls it)

/**
 * shell.js's one hook. Fills the top bar (`topnav`, navEntry(m) for each entry) and the phone drawer's list (`drawerLinks`,
 * drawerEntry(m) for each entry) with `menu` (shell.js's menu()) as this person arranged it, keeps the top bar on one line,
 * and draws both again after a Save in the dialog. Only the menus: the page is left alone, so nothing typed on it is lost.
 */
export function arrangeNav(menu, { topnav, navEntry, drawerLinks, drawerEntry, signal }) {
  const fitted = fitTopBar(topnav, (spill) => arrangedMenu(menu, { spill }).map(navEntry), signal);
  const draw = () => { drawerLinks.replaceChildren(...arrangedMenu(menu).map(drawerEntry)); fitted(); };
  draw();
  redraw = draw;
  signal?.addEventListener('abort', () => { if (redraw === draw) redraw = null; });
}

/**
 * Keeps the top bar on one line: when the menus, the search box (which first shrinks to its smallest) and the name menu do
 * not fit (a long arrangement on a 1366px laptop), the last entries of the top bar go into More, one at a time, until they do.
 * Looked at again when the window size changes and when the web fonts arrive. build(n) returns the bar's entries with n moved.
 * Not while the person is in the menu (keyboard focus in it, or a drop-down opened with a click): that would pull it from under
 * them, so it waits until focus leaves the bar. Returns the function that draws the bar afresh (with nothing moved) and fits it.
 */
function fitTopBar(nav, build, signal) {
  let spill = 0;
  let waiting = false;
  const tooWide = () => { const bar = nav.closest('.topbar') || nav.parentElement; return bar.scrollWidth > bar.clientWidth + 1; };
  const draw = (n) => { spill = n; nav.replaceChildren(...build(n)); };
  const fit = () => {
    if (signal?.aborted || !nav.isConnected || !nav.getClientRects().length) return; // not on the page yet, or the phone drawer is in use at this width
    if (nav.contains(document.activeElement) || nav.querySelector('.menu.open')) { waiting = true; return; }
    waiting = false;
    if (spill) draw(0);
    const most = nav.childElementCount;
    for (let n = 1; tooWide() && n <= most; n++) draw(n);
  };
  let frame = 0;
  const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
  window.addEventListener('resize', later, { signal });
  nav.addEventListener('focusout', () => { if (waiting) later(); }, { signal });
  document.fonts?.addEventListener?.('loadingdone', later, { signal });
  document.fonts?.ready?.then(later, () => {});
  // Built before shell.js puts the bar on the page: then it is fitted just before the first paint.
  return () => { draw(0); if (nav.isConnected) fit(); else later(); };
}

/** Saves the arrangement for the signed-in person. Resolves { here: true } when it could only be kept on this computer. */
async function saveArrangement(list) {
  const id = state.session?.staff?.id;
  loadGen++;
  try {
    await state.data.saveMyMenuArrangement(list);
  } catch (e) {
    if (e?.code !== 'MENU_PREFS_MISSING') throw e;
    keep(id, list);
    return { here: true };
  }
  keep(id, list);
  return { here: false };
}

/**
 * The dialog. `menu` is shell.js's menu() (only what the person may open). Two lists: what is on the top bar, in order, with
 * Move up / Move down / Put in More on every row; and everything else, grouped like More, with Put on the top bar. Saving
 * draws the top bar and the phone drawer again with the new arrangement (arrangeNav), not the page under the dialog.
 */
export function openArrangeMenu(menu) {
  const entries = menuEntries(menu);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const defaults = entries.filter((e) => e.top).map((e) => e.key);
  const start = topKeys(entries, myArrangement());
  let top = [...start];
  const name = (e) => (e.kind === 'group' ? `${e.label} drop-down` : e.groupLabel ? `${e.label} (${e.groupLabel})` : e.label);

  const topId = 'arrange-top-title';
  const topHeading = h('h3', { id: topId, tabindex: '-1' }, 'On the top bar');
  const topList = h('ol', { class: 'arrange-list', 'aria-labelledby': topId });
  const rest = h('div', { class: 'arrange-rest' });
  const count = h('p', { class: 'arrange-count' });
  let buttons = new Map(); // `${key} ${action}` -> the button, to keep focus on the same row after a change

  const button = (key, action, text, label, onclick, stuck = null) => {
    // The name says which page ("Move up: Patients"), starting with the words on the button. One that cannot act (Move up on the
    // first row) only looks disabled: it keeps focus, so one Enter too many says why instead of moving the page back down.
    const b = h('button', {
      type: 'button', class: 'btn btn-small', 'aria-disabled': stuck ? 'true' : null,
      onclick: stuck ? () => announce(stuck) : onclick, 'aria-label': `${text}: ${label}`,
    }, text);
    buttons.set(`${key} ${action}`, b);
    return b;
  };
  // The pages of a drop-down that are still in it.
  const pagesOf = (e) => entries.filter((p) => p.kind === 'page' && p.group === e.menu.key && !top.includes(p.key));
  // A mouse click on "Put on the top bar" or "Put in More" sends the page to the other list, far up or down the dialog: focus
  // following it would scroll away from the next page the person wants. So focus goes to the next button of the same kind (the
  // one that takes the clicked one's place), kept where the pointer is. With the keyboard (no clicks counted) focus follows the page.
  const inPlace = (ev, id) => {
    if (!ev?.detail) return null;
    const action = id.slice(id.lastIndexOf(' '));
    const ids = [...buttons.keys()].filter((k) => k.endsWith(action));
    const i = ids.indexOf(id);
    return { next: [...ids.slice(i + 1), ...ids.slice(0, i).reverse()], y: buttons.get(id).getBoundingClientRect().top };
  };
  const move = (key, by) => {
    const i = top.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= top.length) return;
    [top[i], top[j]] = [top[j], top[i]];
    draw({ focus: [`${key} ${by < 0 ? 'up' : 'down'}`], moved: key });
    announce(`${name(byKey.get(key))}: number ${j + 1} of ${top.length} on the top bar.`);
  };
  const toMore = (key, ev) => {
    const place = inPlace(ev, `${key} more`);
    top = top.filter((k) => k !== key);
    draw({ focus: [`${key} pin`], moved: key, place });
    announce(`${name(byKey.get(key))} is no longer on the top bar.`);
  };
  const pin = (key, ev) => {
    const place = inPlace(ev, `${key} pin`);
    top = [...top, key];
    draw({ focus: [`${key} up`, `${key} more`], moved: key, place });
    announce(`${name(byKey.get(key))} is now last on the top bar, number ${top.length}.`);
  };

  // `moved`: the page just moved, whose row stands out until the next change, so the eye can follow it after a click.
  function draw({ focus = [], moved = null, place = null } = {}) {
    buttons = new Map();
    const rowClass = (key) => ['arrange-row', key === moved && 'arrange-moved'];
    topList.replaceChildren(...top.map((key, i) => {
      const e = byKey.get(key);
      const inside = e.kind === 'group' ? pagesOf(e).map((p) => p.label) : [];
      return h('li', { class: rowClass(key) },
        h('span', { class: 'arrange-num', 'aria-hidden': 'true' }, `${i + 1}.`),
        h('span', { class: 'arrange-name' }, name(e),
          e.kind === 'group' ? h('small', {}, inside.length ? inside.join(', ') : 'Empty: all its pages are on the top bar themselves') : null),
        h('span', { class: 'arrange-actions' },
          button(key, 'up', 'Move up', name(e), () => move(key, -1), i === 0 ? `${name(e)} is already first on the top bar.` : null),
          button(key, 'down', 'Move down', name(e), () => move(key, 1), i === top.length - 1 ? `${name(e)} is already last on the top bar.` : null),
          button(key, 'more', 'Put in More', name(e), (ev) => toMore(key, ev))));
    }));
    if (!top.length) topList.append(h('li', { class: 'arrange-row muted' }, 'Nothing on the top bar: everything is under More.'));

    // Everything else, in the order More shows it: the clinic's top-bar pages, each drop-down under its own name, More's own pages.
    const row = (e) => h('li', { class: rowClass(e.key) },
      h('span', { class: 'arrange-name' }, e.kind === 'group' ? `The whole ${e.label} drop-down` : e.label,
        e.kind === 'group' ? h('small', {}, pagesOf(e).map((p) => p.label).join(', ')) : null),
      h('span', { class: 'arrange-actions' }, button(e.key, 'pin', 'Put on the top bar', name(e), (ev) => pin(e.key, ev))));
    const section = (title, note, list) => (list.length ? h('section', { class: 'arrange-section' },
      h('h4', {}, title, note ? h('span', { class: 'muted' }, ` · ${note}`) : null), h('ul', { class: 'arrange-list' }, list.map(row))) : null);
    const off = (e) => !top.includes(e.key);
    const groups = entries.filter((e) => e.kind === 'group');
    // (An empty section is null, and replaceChildren would show a null as the word "null": h() skips them, this does not.)
    rest.replaceChildren(...[
      section('Main pages', 'under More', entries.filter((e) => e.kind === 'page' && e.top && off(e))),
      ...groups.map((g) => (off(g)
        ? section(g.label, 'under More', [g, ...entries.filter((p) => p.kind === 'page' && p.group === g.menu.key && off(p))])
        : section(g.label, `in its drop-down on the top bar`, entries.filter((p) => p.kind === 'page' && p.group === g.menu.key && off(p))))),
      section('More', null, entries.filter((e) => e.kind === 'page' && e.group === 'more' && off(e))),
    ].filter(Boolean));
    if (!rest.childElementCount) rest.append(h('p', { class: 'muted' }, 'Every page is on the top bar.'));

    count.textContent = `${top.length} on the top bar.`;
    count.classList.toggle('alert', top.length > LONG_BAR);
    count.classList.toggle('alert-warning', top.length > LONG_BAR);
    if (top.length > LONG_BAR) count.textContent += ' That is a long top bar: on a small laptop screen the last ones will be under More.';

    // After a mouse click that sent a page to the other list: the next button of the same kind, moved under the pointer.
    const stay = place?.next.map((k) => buttons.get(k)).find(Boolean);
    if (stay) {
      stay.focus({ preventScroll: true });
      const scroller = stay.closest('.modal-body');
      if (scroller) scroller.scrollTop += stay.getBoundingClientRect().top - place.y;
    } else if (focus.length) {
      // Focus stays with the row that was changed (the same button, or its first one for a page that changed lists), or the list heading.
      (focus.map((k) => buttons.get(k)).find(Boolean) || topHeading).focus();
    }
  }

  const body = h('div', { class: 'arrange' },
    h('p', {}, 'Put the pages you use most on the top bar, in the order you like. Everything else stays under More. Only you see this arrangement, on any computer you log in on.'),
    h('p', { class: 'muted' }, 'A long top bar may not fit on a small laptop screen: then the last ones on it go under More by themselves. On a phone the menu button shows the same order.'),
    topHeading,
    count,
    topList,
    h('h3', {}, 'Not on the top bar'),
    rest);
  draw();
  modal('Arrange my menu', body, [
    { label: 'Reset to default', onClick: () => {
      top = [...defaults];
      draw();
      topHeading.focus();
      announce('Back to the clinic\'s menu. Press Save to keep it.');
      return false;
    } },
    { label: 'Cancel' },
    { label: 'Save', primary: true, onClick: async () => {
      if (top.length === start.length && top.every((k, i) => k === start[i])) { toast('Nothing changed.'); return false; }
      const { here } = await saveArrangement(arrangementFor(entries, top));
      toast(here ? 'Menu saved on this computer. It will follow you to other computers once the database update for it is run.' : 'Menu saved. It follows you to any computer you log in on.', 'ok');
      // Only the menus are drawn again: the page stays as it is, with anything typed on it and where it was scrolled to.
      redraw?.();
    } },
  ], { initialFocus: topHeading });
}
