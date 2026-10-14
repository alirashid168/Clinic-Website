// Arrange my menu: the rules (web/js/lib/menu-arrange.js) and the two data layers' "my menu" calls.
// The menu below has the shape of shell.js's menu() (links, drop-downs, dividers), already cut down by permission like menu()
// does it: menuFor(keys) keeps only the pages in `keys`. What it pins down: the clinic's menu comes back untouched, moving and
// pinning pages, putting a drop-down under More (with its name), saved keys of removed pages or pages the person may not open
// are skipped, pages added later appear in their default place, a top bar too long for the screen spills into More, and what
// is saved stays within the database's limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import {
  MAX_KEYS, KEY_PATTERN, pageKey, cleanArrangement, menuEntries, topKeys, arrangementFor, arrangeMenu,
} from '../web/js/lib/menu-arrange.js';

// ---- a menu like shell.js's
type Item = any;
const link = (label: string, path: string): Item => ({ label, href: `#/staff/${path}`, key: path.split('?')[0], show: () => true });
const FULL = (): Item[] => [
  link('Today', 'today'),
  { label: 'Aaj ki List', key: 'sheet', items: [link('Aaj ki List', 'sheet'), link('Queue board', 'queue'), link('Checkups', 'checkups')] },
  link('Patients', 'patients'),
  link('Billing', 'billing'),
  { label: 'Reports', key: 'reports', items: [
    link('Financial', 'reports?group=financial'), link('Patients', 'reports?group=patients'), link('OPD', 'reports?group=opd'),
    { divider: true }, link('Expenses', 'accounts?tab=expenses'), link('Cash closing', 'accounts?tab=cash')] },
  { label: 'Coordinator', key: 'coordinator', items: [link('Reminders', 'coordinator?tab=reminders'), link('Lab work', 'coordinator?tab=lab')] },
  { label: 'More', key: 'more', items: [
    link('Stock', 'stock'), link('Complaints', 'complaints'),
    { divider: true }, link('Staff accounts', 'admin?tab=staff'), link('Audit log', 'admin?tab=audit')] },
];
/** The menu as menu() gives it to a person who may open only these pages (drop-downs with nothing left disappear). */
function menuFor(keys: string[] | null): Item[] {
  const ok = (i: Item) => keys === null || keys.includes(pageKey(i.href));
  return FULL().map((m) => {
    if (!m.items) return ok(m) ? m : null;
    const items = m.items.filter((i: Item) => i.divider || ok(i));
    while (items[0]?.divider) items.shift();
    while (items[items.length - 1]?.divider) items.pop();
    return items.length ? { ...m, items } : null;
  }).filter(Boolean);
}
const ADMIN = () => menuFor(null);
// The top bar as text: links by label, drop-downs as "Label ▾".
const bar = (menu: Item[]) => menu.map((m) => (m.items ? `${m.label} ▾` : m.label));
const more = (menu: Item[]) => (menu.find((m) => m.key === 'more')?.items || []).map((i: Item) => (i.divider ? '---' : i.heading ? `[${i.heading}]` : i.label));
const DEFAULT_TOP = ['today', 'menu:sheet', 'patients', 'billing', 'menu:reports', 'menu:coordinator'];

test('page keys are the address without #/staff/, drop-downs are menu:<key>, More is not an entry', () => {
  assert.equal(pageKey('#/staff/reports?group=financial'), 'reports?group=financial');
  assert.equal(pageKey('#/patient'), '');
  assert.equal(pageKey(undefined), '');
  const e = menuEntries(ADMIN());
  assert.deepEqual(e.filter((x: any) => x.top).map((x: any) => x.key), DEFAULT_TOP);
  assert.ok(!e.some((x: any) => x.key === 'menu:more'));
  const lab = e.find((x: any) => x.key === 'coordinator?tab=lab');
  assert.deepEqual([lab.kind, lab.top, lab.group, lab.groupLabel], ['page', false, 'coordinator', 'Coordinator']);
  const stock = e.find((x: any) => x.key === 'stock');
  assert.deepEqual([stock.group, stock.groupLabel], ['more', null], 'More\'s own pages carry no group name');
  assert.equal(e.filter((x: any) => x.key === 'sheet').length, 1);
  assert.ok(e.every((x: any) => KEY_PATTERN.test(x.key)), 'every key the menu has fits the database rule');
});

test('the clinic\'s own menu comes back untouched (the same array) for [], for nothing saved and for a saved default', () => {
  const m = ADMIN();
  assert.equal(arrangeMenu(m, []), m);
  assert.equal(arrangeMenu(m, null), m);
  assert.equal(arrangeMenu(m, 'not a list'), m);
  assert.equal(arrangeMenu(m, DEFAULT_TOP), m);
  assert.deepEqual(arrangementFor(menuEntries(m), DEFAULT_TOP), [], 'saving the default saves []');
});

test('moving a page up changes the order of the top bar and nothing else', () => {
  const m = ADMIN();
  const top = ['today', 'patients', 'menu:sheet', 'billing', 'menu:reports', 'menu:coordinator'];
  const saved = arrangementFor(menuEntries(m), top);
  assert.deepEqual(saved, top, 'no "-" keys: nothing was taken off');
  const out = arrangeMenu(m, saved);
  assert.deepEqual(bar(out), ['Today', 'Patients', 'Aaj ki List ▾', 'Billing', 'Reports ▾', 'Coordinator ▾', 'More ▾']);
  assert.deepEqual(more(out), ['Stock', 'Complaints', '---', 'Staff accounts', 'Audit log'], 'More is as before');
  assert.equal(out.find((x: Item) => x.label === 'Patients').href, '#/staff/patients');
});

test('pinning a page from More puts it on the top bar as a link and takes it out of More', () => {
  const m = ADMIN();
  const out = arrangeMenu(m, arrangementFor(menuEntries(m), [...DEFAULT_TOP, 'stock']));
  assert.deepEqual(bar(out), ['Today', 'Aaj ki List ▾', 'Patients', 'Billing', 'Reports ▾', 'Coordinator ▾', 'Stock', 'More ▾']);
  assert.deepEqual(more(out), ['Complaints', '---', 'Staff accounts', 'Audit log']);
  const stock = out.find((x: Item) => x.label === 'Stock');
  assert.deepEqual([stock.href, stock.key, stock.items], ['#/staff/stock', 'stock', undefined]);
});

test('a drop-down put in More keeps its name there; a top-bar page taken off goes first in More', () => {
  const m = ADMIN();
  const saved = arrangementFor(menuEntries(m), ['patients', 'today', 'menu:sheet', 'menu:reports']);
  assert.deepEqual(saved, ['patients', 'today', 'menu:sheet', 'menu:reports', '-billing', '-menu:coordinator']);
  const out = arrangeMenu(m, saved);
  assert.deepEqual(bar(out), ['Patients', 'Today', 'Aaj ki List ▾', 'Reports ▾', 'More ▾']);
  assert.deepEqual(more(out), ['Billing', '---', '[Coordinator]', 'Reminders', 'Lab work', '---', 'Stock', 'Complaints', '---', 'Staff accounts', 'Audit log']);
});

test('a page pinned out of a drop-down leaves it; a pinned tab page is "current" only on that very tab; a shared label says where it is from', () => {
  const m = ADMIN();
  const saved = [...DEFAULT_TOP, 'coordinator?tab=lab', 'reports?group=patients'];
  const out = arrangeMenu(m, saved, { here: '#/staff/coordinator?tab=lab' });
  assert.deepEqual(out.find((x: Item) => x.key === 'coordinator').items.map((i: Item) => i.label), ['Reminders']);
  const lab = out.find((x: Item) => x.label === 'Lab work');
  assert.equal(lab.key, 'coordinator', 'on the Lab work tab the pinned link is the current page');
  assert.equal(arrangeMenu(m, saved, { here: '#/staff/coordinator?tab=reminders' }).find((x: Item) => x.label === 'Lab work').key, 'page:coordinator?tab=lab',
    'on another tab of the same section it is not');
  assert.ok(out.some((x: Item) => x.label === 'Patients (Reports)'), 'the Patients report is told apart from the Patients page');
  assert.ok(out.some((x: Item) => x.label === 'Patients' && x.href === '#/staff/patients'));
  assert.deepEqual(out.find((x: Item) => x.key === 'reports').items.map((i: Item) => i.divider ? '---' : i.label), ['Financial', 'OPD', '---', 'Expenses', 'Cash closing']);
});

test('a drop-down whose pages are all on the top bar themselves is not shown; dividers never end up at an edge or doubled', () => {
  const m = ADMIN();
  const out = arrangeMenu(m, [...DEFAULT_TOP, 'coordinator?tab=reminders', 'coordinator?tab=lab', 'admin?tab=staff', 'admin?tab=audit']);
  assert.ok(!out.some((x: Item) => x.key === 'coordinator' && x.items), 'the empty Coordinator drop-down is gone');
  assert.deepEqual(more(out), ['Stock', 'Complaints']);
  const reports = arrangeMenu(m, [...DEFAULT_TOP, 'accounts?tab=expenses', 'accounts?tab=cash']).find((x: Item) => x.key === 'reports');
  assert.deepEqual(reports.items.map((i: Item) => i.divider ? '---' : i.label), ['Financial', 'Patients', 'OPD']);
});

test('nothing on the top bar: everything is under More, with the drop-down names', () => {
  const m = ADMIN();
  const out = arrangeMenu(m, arrangementFor(menuEntries(m), []));
  assert.deepEqual(bar(out), ['More ▾']);
  assert.deepEqual(more(out).slice(0, 6), ['Today', 'Patients', 'Billing', '---', '[Aaj ki List]', 'Aaj ki List']);
  assert.ok(more(out).includes('[Reports]') && more(out).includes('[Coordinator]') && more(out).includes('Audit log'));
});

test('saved keys of removed pages, of pages the person may not open and of badly formed text are skipped', () => {
  // A front desk menu: no admin pages, no Stock, no Coordinator.
  const fd = menuFor(['today', 'sheet', 'queue', 'checkups', 'patients', 'billing', 'reports?group=patients', 'reports?group=opd']);
  // A list saved with a fuller menu (pages this person may not open, a drop-down they do not have), a page the website no
  // longer has, and text that is not a key at all.
  const saved = [...arrangementFor(menuEntries(ADMIN()), ['patients', 'stock', 'today', 'admin?tab=staff', 'menu:sheet', 'billing', 'menu:coordinator', 'menu:reports']),
    'gone-page', 7, '<x>', 'two words'];
  const out = arrangeMenu(fd, saved);
  const everything = JSON.stringify(out);
  for (const word of ['Staff accounts', 'Stock', 'Coordinator', 'gone-page', 'Audit log', '<x>']) assert.ok(!everything.includes(word), `${word} never appears`);
  assert.deepEqual(bar(out), ['Patients', 'Today', 'Aaj ki List ▾', 'Billing', 'Reports ▾'], 'the rest keeps the saved order');
  assert.equal(out.find((x: Item) => x.key === 'more'), undefined, 'this person has no More (nothing of it is theirs)');
  // Entries a list does not mention at all are in their default places.
  assert.deepEqual(bar(arrangeMenu(fd, ['billing'])), ['Today', 'Aaj ki List ▾', 'Patients', 'Billing', 'Reports ▾']);
});

test('permissions win: a pinned page disappears when the person may no longer open it, and comes back to its default place later', () => {
  const withStock = menuFor(['today', 'patients', 'stock', 'complaints']);
  const saved = arrangementFor(menuEntries(withStock), ['stock', 'today', 'patients']);
  assert.deepEqual(bar(arrangeMenu(withStock, saved)), ['Stock', 'Today', 'Patients', 'More ▾']);
  const without = menuFor(['today', 'patients', 'complaints']);
  const out = arrangeMenu(without, saved);
  assert.ok(!JSON.stringify(out).includes('Stock'));
  assert.deepEqual(bar(out), ['Today', 'Patients', 'More ▾']);
});

test('pages added to the menu later appear in their default place, also for someone who arranged theirs', () => {
  const m = ADMIN();
  const saved = arrangementFor(menuEntries(m), ['patients', 'today', 'menu:sheet', 'menu:reports']); // Billing and Coordinator taken off
  // The website gains a top-bar link after Billing, a Coordinator tab, a More page and a whole new drop-down at the end.
  const later = ADMIN();
  later.splice(4, 0, link('End the day', 'dayend'));
  later.find((x: Item) => x.key === 'coordinator').items.push(link('Retainer record', 'coordinator?tab=retainer-record'));
  later.find((x: Item) => x.key === 'more').items.splice(2, 0, link('History', 'history'));
  later.splice(later.length - 1, 0, { label: 'Forms', key: 'forms', items: [link('Homepage forms', 'forms')] });
  const out = arrangeMenu(later, saved);
  assert.deepEqual(bar(out), ['Patients', 'End the day', 'Today', 'Aaj ki List ▾', 'Reports ▾', 'Forms ▾', 'More ▾'],
    'a new top-bar entry goes next to the one before it in the clinic\'s menu that is on this top bar (Billing is not: Patients is)');
  assert.deepEqual(more(out), ['Billing', '---', '[Coordinator]', 'Reminders', 'Lab work', 'Retainer record', '---', 'Stock', 'Complaints', 'History', '---', 'Staff accounts', 'Audit log']);
  // For the clinic's own menu everything simply stays where the menu puts it.
  assert.equal(arrangeMenu(later, []), later);
});

test('a top bar too long for the screen: { spill: n } moves its last n entries into More, in More\'s order', () => {
  const m = ADMIN();
  const one = arrangeMenu(m, [], { spill: 1 });
  assert.deepEqual(bar(one), ['Today', 'Aaj ki List ▾', 'Patients', 'Billing', 'Reports ▾', 'More ▾']);
  assert.deepEqual(more(one), ['[Coordinator]', 'Reminders', 'Lab work', '---', 'Stock', 'Complaints', '---', 'Staff accounts', 'Audit log']);
  const pinned = arrangeMenu(m, [...DEFAULT_TOP, 'stock', 'coordinator?tab=lab'], { spill: 2 });
  assert.deepEqual(bar(pinned), ['Today', 'Aaj ki List ▾', 'Patients', 'Billing', 'Reports ▾', 'Coordinator ▾', 'More ▾']);
  assert.deepEqual(pinned.find((x: Item) => x.key === 'coordinator').items.map((i: Item) => i.label), ['Reminders', 'Lab work'], 'a spilled tab page goes back into its drop-down');
  assert.equal(more(pinned)[0], 'Stock');
  assert.equal(arrangeMenu(m, [...DEFAULT_TOP, 'stock'], { spill: 1 }), m, 'spilling exactly the extra entries gives back the clinic\'s menu');
  assert.deepEqual(bar(arrangeMenu(m, [], { spill: 99 })), ['More ▾']);
});

test('what is saved: known keys once, "-" for the clinic\'s top-bar entries taken off, never more than 60, always within the rule', () => {
  const m = ADMIN();
  const e = menuEntries(m);
  assert.deepEqual(arrangementFor(e, ['stock', 'stock', 'nope', 'today']), ['stock', 'today', '-menu:sheet', '-patients', '-billing', '-menu:reports', '-menu:coordinator']);
  assert.deepEqual(topKeys(e, arrangementFor(e, ['stock', 'today'])), ['stock', 'today']);
  // A menu with very many pages still saves at most 60 keys.
  const big = [{ label: 'More', key: 'more', items: Array.from({ length: 80 }, (_, i) => link(`Page ${i}`, `page${i}`)) }, link('Today', 'today')];
  const all = menuEntries(big).map((x: any) => x.key);
  const saved = arrangementFor(menuEntries(big), all);
  assert.equal(saved.length, MAX_KEYS);
  assert.ok(saved.every((k: string) => KEY_PATTERN.test(k) && k.length <= 81));
});

test('cleanArrangement: only well-formed keys, each once, at most 60', () => {
  assert.deepEqual(cleanArrangement(null), []);
  assert.deepEqual(cleanArrangement({ top: ['today'] }), []);
  assert.deepEqual(cleanArrangement(['today', 'today', '', 'a'.repeat(81), '-billing', 3, null, 'x y', 'admin?tab=import']), ['today', '-billing', 'admin?tab=import']);
  assert.equal(cleanArrangement(Array.from({ length: 70 }, (_, i) => `p${i}`)).length, MAX_KEYS);
});

test('anything at the top level that is neither a link nor a drop-down keeps its place on an arranged bar', () => {
  const m = [...ADMIN()];
  const button = { label: 'Something', key: 'thing', onclick: () => {} };
  m.splice(1, 0, button);
  const out = arrangeMenu(m, [...DEFAULT_TOP, 'stock']);
  assert.ok(out.includes(button));
  assert.equal(arrangeMenu(m, []), m);
});

// ======================================================================================= the data layers
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => (store.has(k) ? store.get(k) : null), setItem: (k: string, v: unknown) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } };
(globalThis as any).window ||= new EventTarget();
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test', onLine: true }, configurable: true, writable: true });
registerHooks({
  resolve(spec, ctx, nextResolve) {
    if (spec.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@')) {
      return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__fakeCreateClient(...a);', shortCircuit: true };
    }
    return nextResolve(spec, ctx);
  },
});
const { createDemoAdapter } = await import('../web/js/data/demo.js');
const { createSupabaseAdapter } = await import('../web/js/data/supabase.js');

test('demo: each staff member reads and saves only their own menu; the database\'s limits are kept', async () => {
  const d: any = createDemoAdapter();
  await d.signInDemo('s-fd-gul');
  assert.equal(await d.myMenuArrangement(), null, 'nothing saved yet');
  await d.saveMyMenuArrangement(['patients', '-billing']);
  assert.deepEqual(await d.myMenuArrangement(), ['patients', '-billing']);
  await d.signInDemo('s-admin');
  assert.equal(await d.myMenuArrangement(), null, 'the admin does not see the front desk\'s order');
  await d.saveMyMenuArrangement([]);
  assert.deepEqual(await d.myMenuArrangement(), []);
  for (const bad of [Array.from({ length: 61 }, (_, i) => `p${i}`), ['a'.repeat(81)], ['ok', 5], { top: [] }, ['two words']]) {
    await assert.rejects(d.saveMyMenuArrangement(bad), /staff_menu_prefs_arrangement_check/);
  }
  await d.signInDemo('s-fd-gul');
  assert.deepEqual(await d.myMenuArrangement(), ['patients', '-billing'], 'still the front desk\'s own');
  await d.signOut();
  await assert.rejects(d.saveMyMenuArrangement([]), /NOT_STAFF/);
  await d.signInDemo('p-demo');
  await assert.rejects(d.saveMyMenuArrangement([]), /NOT_STAFF/, 'a patient has no staff menu');
});

type Op = [string, ...any[]];
function fakeClient(answer: (table: string, ops: Op[]) => any, rpcAnswer: (name: string, args: any) => any) {
  const f: any = { requests: [] as Array<{ table: string; ops: Op[] }>, rpcs: [] as Array<{ name: string; args: any }> };
  const from = (table: string) => {
    const ops: Op[] = [];
    const b: any = new Proxy({}, {
      get(_t, name) {
        if (name === 'then') return (res: any, rej: any) => { f.requests.push({ table, ops }); return Promise.resolve(answer(table, ops)).then(res, rej); };
        return (...a: any[]) => { ops.push([String(name), ...a]); return b; };
      },
    });
    return b;
  };
  f.client = () => ({
    auth: {
      storageKey: 'sb-test-auth-token',
      async getSession() { return { data: { session: { access_token: 'jwt-u1', user: { id: 'u1' } } }, error: null }; },
      async getUser() { return { data: { user: { id: 'u1' } }, error: null }; },
      async signOut() { return { error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      stopAutoRefresh() {},
    },
    from,
    rpc: (name: string, args: any) => { f.rpcs.push({ name, args }); const r: any = Promise.resolve(rpcAnswer(name, args)); r.abortSignal = () => r; return r; },
    channel() { const ch: any = { on: () => ch, subscribe: () => ch }; return ch; },
    removeChannel() {},
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({}) },
  });
  return f;
}
async function livePage(answer: (table: string, ops: Op[]) => any, rpcAnswer: (name: string, args: any) => any = () => ({ data: null, error: null, status: 204 })) {
  const f = fakeClient(answer, rpcAnswer);
  (globalThis as any).__fakeCreateClient = () => f.client();
  return { f, data: await createSupabaseAdapter() };
}

test('live: the saved order is read from staff_menu_prefs (row-level security gives each person only their own row)', async () => {
  const { f, data } = await livePage(() => ({ data: { arrangement: ['patients', '-billing'] }, error: null, status: 200 }));
  assert.deepEqual(await (data as any).myMenuArrangement(), ['patients', '-billing']);
  const { table, ops } = f.requests[0];
  assert.equal(table, 'staff_menu_prefs');
  assert.deepEqual(ops, [['select', 'arrangement'], ['maybeSingle']]);
  const none = await livePage(() => ({ data: null, error: null, status: 200 }));
  assert.equal(await (none.data as any).myMenuArrangement(), null, 'no row: nothing saved');
});

test('live: before 20261012000300 is run the read answers null and Save fails with MENU_PREFS_MISSING; other failures are errors', async () => {
  for (const missing of [{ code: 'PGRST205', status: 404 }, { code: '42P01', status: 400 }]) {
    const { data } = await livePage(() => ({ data: null, error: { code: missing.code, message: 'relation does not exist' }, status: missing.status }),
      () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 }));
    assert.equal(await (data as any).myMenuArrangement(), null);
    await assert.rejects((data as any).saveMyMenuArrangement(['today']), (e: any) => e.code === 'MENU_PREFS_MISSING');
  }
  const down = await livePage(() => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, status: 500 }),
    () => ({ data: null, error: { code: '23514', message: 'new row for relation "staff_menu_prefs" violates check constraint "staff_menu_prefs_arrangement_check"' }, status: 400 }));
  await assert.rejects((down.data as any).myMenuArrangement(), /statement timeout/);
  await assert.rejects((down.data as any).saveMyMenuArrangement(['x y']), /staff_menu_prefs_arrangement_check/);
});

test('live: Save calls save_my_menu with the list', async () => {
  const { f, data } = await livePage(() => ({ data: null, error: null, status: 200 }));
  await (data as any).saveMyMenuArrangement(['stock', 'today', '-menu:sheet']);
  assert.deepEqual(f.rpcs, [{ name: 'save_my_menu', args: { p_arrangement: ['stock', 'today', '-menu:sheet'] } }]);
});

// ======================================================================================= the hook in shell.js
// shell.js hands menu() to arrangeNav() (web/js/views/staff/nav-arrange.js), which draws the top bar and the drawer from
// arrangedMenu(): the signed-in person's saved list applied to whatever menu() has at that moment. Other branches add pages to
// menu() (History of Aaj ki List, Job applications),
// so a page key nobody here has heard of must still turn up in its default place for someone who saved before it existed.
// state.js is a stand-in with one signed-in staff member; the saved list is the copy on this computer that the hook reads.
registerHooks({
  resolve(spec, ctx, nextResolve) {
    if (spec === '../../state.js' && ctx.parentURL?.includes('/web/js/views/staff/nav-arrange.js')) {
      return { url: 'data:text/javascript,export const state = globalThis.__navState;', shortCircuit: true };
    }
    return nextResolve(spec, ctx);
  },
});
(globalThis as any).__navState = { session: { staff: { id: 's-later' } }, data: {} };
const { arrangedMenu, myArrangement } = await import('../web/js/views/staff/nav-arrange.js');

test('through shell.js\'s hook: a page added to menu() later is in its default place for someone who saved an arrangement before it existed', () => {
  // Saved with today's menu: Patients first, Stock pinned, Billing and the Coordinator drop-down taken off.
  const saved = arrangementFor(menuEntries(ADMIN()), ['patients', 'today', 'menu:sheet', 'stock', 'menu:reports']);
  const copy = JSON.stringify(saved);
  store.set('staff-menu:s-later', copy);
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { hash: '#/staff/patients' }, configurable: true, writable: true });
  try {
    assert.deepEqual(bar(arrangedMenu(ADMIN())), ['Patients', 'Today', 'Aaj ki List ▾', 'Stock', 'Reports ▾', 'More ▾'], 'the saved arrangement');
    // Later menu() gains pages with keys nothing above knows: a top-bar link at the end of the clinic's bar, a page inside the
    // Aaj ki List drop-down right after the Aaj ki List, a Coordinator tab (that drop-down is under More for this person) and a
    // More page.
    const later = ADMIN();
    later.splice(later.length - 1, 0, link('Fake new page', 'fake-new-page'));
    later.find((x: Item) => x.key === 'sheet').items.splice(1, 0, link('Fake sheet history', 'fake-sheet-history'));
    later.find((x: Item) => x.key === 'coordinator').items.push(link('Fake coordinator tab', 'coordinator?tab=fake'));
    later.find((x: Item) => x.key === 'more').items.splice(2, 0, link('Fake more page', 'fake-more-page'));
    const out = arrangedMenu(later);
    assert.deepEqual(bar(out), ['Patients', 'Today', 'Aaj ki List ▾', 'Stock', 'Reports ▾', 'Fake new page', 'More ▾'],
      'the new top-bar link follows Reports: the entry before it on the clinic\'s bar (Coordinator) is not on this bar, Reports is');
    const fake = out.find((x: Item) => x.label === 'Fake new page');
    assert.deepEqual([fake.href, fake.key], ['#/staff/fake-new-page', 'fake-new-page']);
    assert.deepEqual(out.find((x: Item) => x.key === 'sheet').items.map((i: Item) => i.label), ['Aaj ki List', 'Fake sheet history', 'Queue board', 'Checkups']);
    assert.deepEqual(more(out), ['Billing', '---', '[Coordinator]', 'Reminders', 'Lab work', 'Fake coordinator tab', '---', 'Complaints', 'Fake more page', '---', 'Staff accounts', 'Audit log']);
    // The dialog (opened with the same menu()) lists every new page, the top-bar one already in its place on the top bar.
    const entries = menuEntries(later);
    assert.deepEqual(topKeys(entries, myArrangement()), ['patients', 'today', 'menu:sheet', 'stock', 'menu:reports', 'fake-new-page']);
    assert.deepEqual(['fake-sheet-history', 'coordinator?tab=fake', 'fake-more-page'].map((k) => entries.find((e: any) => e.key === k)?.group), ['sheet', 'coordinator', 'more']);
    // Too long for the screen, the new link goes into More with the other top-bar pages taken off.
    assert.deepEqual(more(arrangedMenu(later, { spill: 1 })).slice(0, 3), ['Billing', 'Fake new page', '---']);
    assert.equal(store.get('staff-menu:s-later'), copy, 'drawing the menu never rewrites what the person saved');
    // Someone who never arranged anything gets menu() itself.
    store.delete('staff-menu:s-later');
    assert.equal(arrangedMenu(later), later);
  } finally {
    store.delete('staff-menu:s-later');
    if (had) Object.defineProperty(globalThis, 'location', had); else delete (globalThis as any).location;
  }
});
