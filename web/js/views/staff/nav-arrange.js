// "Arrange my menu": each staff member puts the pages they use most on the top bar, in their own order (the owner's request,
// 12 Oct 2026). The rules are in ../../lib/menu-arrange.js. This file keeps the person's arrangement, applies it to shell.js's
// menu, keeps the top bar on one line, and has the dialog (opened from the name menu and from the phone drawer).
//
// Where the arrangement lives: one row per staff member in the database (public.staff_menu_prefs, 20261015000100), so it
// follows them to any computer, plus a copy on this computer (localStorage, per staff id) so the menu draws at once. The row
// is read again at every sign-in (loadArrangement) and its answer replaces the copy. Until that database update is run the
// website works as before: the default menu for everyone, and Save keeps the arrangement on this computer only (it says so).
// The first sign-in after the update is run sends such a copy up, so it then follows the person as Save promised.
// The copy holds only page keys, nothing about patients, so it is left behind at logout like the other per-person settings.
import { h, modal, toast, announce } from '../../ui/dom.js';
import { state } from '../../state.js';
import { menuEntries, topKeys, arrangeMenu, arrangementFor, cleanArrangement, barLabel, atAddress, pageKey } from '../../lib/menu-arrange.js';

const COPY_KEY = (staffId) => `staff-menu:${staffId}`;
// The longest copy Save can write is about 5,000 characters (60 keys of at most 81). Anything much longer was not written by
// this page (damaged, or planted by someone else on a shared computer) and is not even read: the menu is drawn from it on
// every page change, so a huge one would freeze each one.
const MAX_COPY = 6000;
const LONG_BAR = 9; // more entries than this on the top bar: the dialog warns that it may not fit on a small laptop
const inMemory = new Map(); // staff id -> arrangement, for a browser that blocks storage
const onlyHere = new Set(); // staff ids whose arrangement on this computer is not in the database yet (Save then goes through unchanged)
let loadGen = 0; // a sign-in's read that answers after a Save must not undo it
let sending = Promise.resolve(); // a copy that is being sent up (loadArrangement): a Save waits for it, so it is never overtaken

function readCopy(staffId) {
  try {
    const text = localStorage.getItem(COPY_KEY(staffId));
    return text === null || text.length > MAX_COPY ? null : cleanArrangement(JSON.parse(text));
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
 * page. No row (never saved, or the database update not run yet) keeps the copy as it is, and a copy that is not the default
 * was saved while the update was not run: it is sent up once, in the background (while the update is still not run it stays
 * on this computer only, and the next sign-in tries again).
 */
export function loadArrangement({ wait = 2500 } = {}) {
  const id = state.session?.staff?.id;
  if (!id || typeof state.data?.myMenuArrangement !== 'function') return Promise.resolve();
  const gen = ++loadGen;
  const load = state.data.myMenuArrangement()
    .then((list) => {
      if (gen !== loadGen || state.session?.staff?.id !== id) return;
      if (list !== null) { onlyHere.delete(id); keep(id, cleanArrangement(list)); return; }
      const copy = readCopy(id) ?? inMemory.get(id);
      if (!copy?.length) return;
      onlyHere.add(id);
      sending = state.data.saveMyMenuArrangement(copy)
        .then(() => { onlyHere.delete(id); }, () => { /* not run yet, or no connection: kept on this computer, tried again next time */ });
    })
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
  followTabs([topnav, drawerLinks], signal);
}

/**
 * A page put on the top bar with its tab (Reminders, a Reports group, an Admin tab) is marked as the page on screen only while
 * that tab is. The pages change tabs with history.replaceState, which fires no event, so the address is looked at again around
 * every click, key press and change: before it (so the phone drawer opens on the right page) and just after it (once the page
 * has changed tab). shell.js does the same for a drop-down's links each time it opens. The clinic's own menu has no such links.
 */
function followTabs(lists, signal) {
  const mark = () => {
    for (const list of lists) {
      for (const a of list.querySelectorAll(':scope > a.nav-link[href*="?"]')) {
        const on = atAddress(pageKey(a.getAttribute('href')), location.hash);
        if (on === a.hasAttribute('aria-current')) continue;
        a.classList.toggle('current', on);
        if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      }
    }
  };
  const look = () => { mark(); setTimeout(mark); };
  for (const type of ['click', 'keydown', 'change']) document.addEventListener(type, look, { capture: true, signal });
}

/**
 * Keeps the top bar on one line: when the menus, the search box (which first shrinks to its smallest) and the name menu do
 * not fit (a long arrangement on a 1366px laptop), the last entries of the top bar go into More, one at a time, until they do.
 * Looked at again when the bar's width changes (the window's size, or the page's scrollbar, which a dialog hides while it is
 * open and which a long page brings once it has loaded) and when the web fonts arrive. build(n) returns the bar's entries with
 * n moved. Not while the person is in the menu (keyboard focus in it, or a drop-down opened with a click): that would pull it
 * from under them, so it waits until focus leaves the bar. Returns the function that draws the bar afresh (with nothing moved)
 * and fits it.
 */
function fitTopBar(nav, build, signal) {
  let spill = 0;
  let waiting = false;
  let sizes = null; // watches the bar's width (below), from its first fit on the page
  let watching = false;
  const barOf = () => nav.closest('.topbar') || nav.parentElement;
  const tooWide = () => { const bar = barOf(); return bar.scrollWidth > bar.clientWidth; };
  const draw = (n) => { spill = n; nav.replaceChildren(...build(n)); };
  const fit = () => {
    if (signal?.aborted || !nav.isConnected || !nav.getClientRects().length) return; // not on the page yet, or the phone drawer is in use at this width
    if (sizes && !watching) { watching = true; sizes.observe(barOf()); }
    if (nav.contains(document.activeElement) || nav.querySelector('.menu.open')) { waiting = true; return; }
    waiting = false;
    if (spill) draw(0);
    const most = nav.childElementCount;
    for (let n = 1; tooWide() && n <= most; n++) draw(n);
  };
  let frame = 0;
  const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
  window.addEventListener('resize', later, { signal });
  // The bar's width also changes with no window resize: Save in "Arrange my menu" fits the bar while the dialog has hidden the
  // page's scrollbar, and the scrollbar comes back (about 15px narrower) when the dialog closes. Only the width counts: the
  // bar's height does not decide whether it fits.
  if (typeof ResizeObserver === 'function') {
    let width = null;
    sizes = new ResizeObserver(([e]) => { if (e.contentRect.width !== width) { width = e.contentRect.width; later(); } });
    signal?.addEventListener('abort', () => sizes.disconnect());
  }
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
  await sending;
  try {
    await state.data.saveMyMenuArrangement(list);
  } catch (e) {
    if (e?.code !== 'MENU_PREFS_MISSING') throw e;
    keep(id, list);
    onlyHere.add(id);
    return { here: true };
  }
  keep(id, list);
  onlyHere.delete(id);
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
  // A page is named as the top bar names it (barLabel: "Aaj ki List (today)", "Patients (Reports)"), and a drop-down's page that
  // the bar leaves plain still says which drop-down it is in: "Queue board (Aaj ki List)".
  const name = (e) => {
    if (e.kind === 'group') return `${e.label} drop-down`;
    const onBar = barLabel(entries, e);
    return onBar === e.label && e.groupLabel ? `${e.label} (${e.groupLabel})` : onBar;
  };

  const topId = 'arrange-top-title';
  const topHeading = h('h3', { id: topId, tabindex: '-1' }, 'On the top bar');
  const topList = h('ol', { class: 'arrange-list', 'aria-labelledby': topId });
  const rest = h('div', { class: 'arrange-rest' });
  const count = h('p', { class: 'arrange-count' });
  let buttons = new Map(); // `${key} ${action}` -> the button, to keep focus on the same row after a change
  let pointer = 'mouse'; // what pressed a button last: 'mouse', 'touch' or 'pen' (from its pointerdown)
  // The second click of a double-click: only with a mouse. A browser counts quick taps on a touch screen the same way (Chrome:
  // 1, 2, 3, then 1 again), and every tap there is meant (nobody double-taps a button), so each one acts.
  const doubleClick = (ev) => ev?.detail === 2 && (ev.pointerType || pointer) === 'mouse';

  const button = (key, action, text, label, onclick, stuck = null) => {
    // The name says which page ("Move up: Patients"), starting with the words on the button. One that cannot act (Move up on the
    // first row) only looks disabled: it keeps focus, so one Enter too many says why instead of moving the page back down.
    // The second click of a mouse double-click is left alone, focus included, so a double-click does one thing (as most people
    // who double-click a button mean). The clicks of a quick series after it act again: under the pointer is still the same
    // page's Move up (or the next page's Put on the top bar), and a person clicking fast wants it to go on moving.
    const act = stuck ? () => announce(stuck) : onclick;
    const b = h('button', {
      type: 'button', class: 'btn btn-small', 'aria-disabled': stuck ? 'true' : null,
      onpointerdown: (ev) => { pointer = ev.pointerType || 'mouse'; },
      onmousedown: (ev) => { if (doubleClick(ev)) ev.preventDefault(); },
      onclick: (ev) => { if (!doubleClick(ev)) act(ev); }, 'aria-label': `${text}: ${label}`,
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
  // A mouse click on Move up / Move down keeps the moved page's button under the pointer (keepAt, below), so the next click
  // moves the same page again instead of the one that took its place, all the way to the first or last place.
  const move = (key, by, ev) => {
    const i = top.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= top.length) return;
    const id = `${key} ${by < 0 ? 'up' : 'down'}`;
    const place = ev?.detail ? { next: [id], y: buttons.get(id).getBoundingClientRect().top } : null;
    [top[i], top[j]] = [top[j], top[i]];
    draw({ focus: [id], moved: key, place });
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

  // Space the dialog adds so that a clicked button can stay under the pointer where scrolling alone cannot bring it there: above
  // the top-bar list when the dialog is scrolled to the top already (Move up near the top), below everything when it cannot
  // scroll down any further (Move down at the end of a short list). The space above shrinks again as the page goes back down,
  // goes once it is scrolled out of sight (dropLift), and goes at the next change made with the keyboard or Reset.
  let lift = 0;
  let room = 0;
  // (In fractions of a pixel as measured, so many clicks in a row never add up to a drift.)
  const setLift = (px) => { lift = px > 0.01 ? px : 0; topList.style.paddingTop = lift ? `${lift}px` : ''; };
  const setRoom = (px) => { room = px > 0.01 ? px : 0; body.style.paddingBottom = room ? `${room}px` : ''; };
  // Brings `el` (a button just drawn) back to `y` on the screen, where the pointer is: the dialog scrolls by the shift, as far
  // as it can, and the space above or below makes up the rest.
  function keepAt(el, y) {
    const scroller = el.closest('.modal-body');
    if (!scroller) return;
    setLift(0); // worked out afresh each time
    for (let n = 0; n < 3; n++) {
      const shift = el.getBoundingClientRect().top - y; // > 0: the button went down, so the dialog scrolls down
      if (Math.abs(shift) < 0.5) return;
      const want = scroller.scrollTop + shift;
      if (want < 0) {
        scroller.scrollTop = 0;
        setLift(lift - want);
      } else {
        const most = scroller.scrollHeight - scroller.clientHeight;
        if (want > most) setRoom(room + want - most);
        scroller.scrollTop = want;
      }
    }
  }
  // The space above the list once the person scrolled it out of sight: taken away with the dialog scrolled back by as much, so
  // nothing on the screen moves. (The scroll position is read first: once the space is gone, the browser would pull a position
  // near the end back to the new end before the dialog scrolls back.)
  function dropLift(scroller) {
    if (!lift || topList.getBoundingClientRect().top + lift > scroller.getBoundingClientRect().top) return;
    const at = scroller.scrollTop - lift;
    setLift(0);
    scroller.scrollTop = at;
  }

  // `moved`: the page just moved, whose row stands out until the next change, so the eye can follow it after a click.
  function draw({ focus = [], moved = null, place = null } = {}) {
    // A click: the dialog keeps the height it has, so the lists growing or shrinking scroll inside it instead of moving the whole
    // dialog (it is centred on the screen), and the button under the pointer with it.
    const box = topList.closest('.modal');
    if (place && box && !box.style.height) box.style.height = `${box.getBoundingClientRect().height}px`;
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
          button(key, 'up', 'Move up', name(e), (ev) => move(key, -1, ev), i === 0 ? `${name(e)} is already first on the top bar.` : null),
          button(key, 'down', 'Move down', name(e), (ev) => move(key, 1, ev), i === top.length - 1 ? `${name(e)} is already last on the top bar.` : null),
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

    // After a mouse click: the button to stay under the pointer (the moved page's own, or after a page went to the other list
    // the next button of the same kind), brought back there.
    const stay = place?.next.map((k) => buttons.get(k)).find(Boolean);
    if (stay) {
      stay.focus({ preventScroll: true });
      keepAt(stay, place.y);
    } else {
      setLift(0);
      setRoom(0);
      // Focus stays with the row that was changed (the same button, or its first one for a page that changed lists), or the list heading.
      if (focus.length) (focus.map((k) => buttons.get(k)).find(Boolean) || topHeading).focus();
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
  const { dialog } = modal('Arrange my menu', body, [
    { label: 'Reset to default', onClick: () => {
      top = [...defaults];
      draw();
      topHeading.focus();
      announce('Back to the clinic\'s menu. Press Save to keep it.');
      return false;
    } },
    { label: 'Cancel' },
    { label: 'Save', primary: true, onClick: async () => {
      // Unchanged but kept on this computer only: Save tries the database again (its update may have been run since).
      const unchanged = top.length === start.length && top.every((k, i) => k === start[i]);
      if (unchanged && !onlyHere.has(state.session?.staff?.id)) { toast('Nothing changed.'); return false; }
      const { here } = await saveArrangement(arrangementFor(entries, top));
      toast(here ? 'Menu saved on this computer. It will follow you to other computers once the database update for it is run.' : 'Menu saved. It follows you to any computer you log in on.', 'ok');
      // Only the menus are drawn again: the page stays as it is, with anything typed on it and where it was scrolled to.
      redraw?.();
    } },
  ], { initialFocus: topHeading });
  const scroller = dialog.querySelector('.modal-body');
  scroller.addEventListener('scroll', () => dropLift(scroller), { passive: true });
}
