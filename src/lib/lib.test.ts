import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidance, canTreat, canCheck, protocolFor, parseMonthCell, BRACES_PROTOCOL } from './protocol.ts';
import { parseAmount, cleanLegacyName, parseTreatmentDetails, summariseDetails, matchClinician, splitPeople } from './legacy.ts';
import { defaultGrid, hasPermission, discountNeedsApproval, PERMISSIONS } from './permissions.ts';
import { AutosaveQueue, PermanentSaveError, type PendingEdit } from './autosave.ts';

// ---------------------------------------------------------------- protocol
test('protocol table matches the Braces Treatment Module', () => {
  assert.equal(BRACES_PROTOCOL.length, 18);
  const photoMonths = BRACES_PROTOCOL.filter((r) => r.photoRequired).map((r) => r.month);
  assert.deepEqual(photoMonths, [1, 4, 7, 10, 12, 13, 15, 18]);
  assert.deepEqual(protocolFor(3).plannedWire, 'O14');
  assert.deepEqual(protocolFor(8).instructions, ['Dues should be cleared', 'Remind retainer payment to patient']);
  assert.equal(protocolFor(25).month, 18, 'months past 18 reuse the last row');
});

test('who may treat and check', () => {
  assert.equal(canTreat(4, 3), false);
  assert.equal(canTreat(4, 2), true);
  assert.equal(canTreat(2, 3), true);
  assert.equal(canTreat(12, 2), false, 'Month 12 is Group 1 only');
  assert.equal(canTreat(12, null, true), true, 'Dr. Ali can always treat');
  assert.equal(canCheck(4, 2), false);
  assert.equal(canCheck(4, 1), true);
  assert.equal(canCheck(1, 3), true, 'Month 1 has no checker');
});

test('guidance alerts', () => {
  const base = { extractionPlan: 'undecided' as const, extractionsDone: false, hasDrAliPlan: false, dues: 0 };
  const m1 = guidance({ ...base, month: 1 }).alerts.map((a) => a.text);
  assert.ok(m1.some((t) => t.includes('PHOTO MONTH')));
  assert.ok(m1.some((t) => t.includes('treatment plan from Dr. Ali')));

  const m4 = guidance({ ...base, month: 4 }).alerts.map((a) => a.text);
  assert.ok(m4.some((t) => t.includes('Decide and do extractions')));

  const m8 = guidance({ ...base, month: 8, dues: 35000 }).alerts;
  assert.ok(m8.some((a) => a.level === 'stop' && a.text.includes('35,000')));

  const over = guidance({ ...base, month: 13, extractionPlan: 'non_extraction' }).alerts;
  assert.ok(over.some((a) => a.text.startsWith('Overrun')));

  const ext = guidance({ ...base, month: 9, extractionPlan: 'extraction', extractionsDone: false }).alerts;
  assert.ok(ext.some((a) => a.text.includes('extractions not marked done')));

  const beyond = guidance({ ...base, month: 21, extractionPlan: 'extraction', extractionsDone: true });
  assert.equal(beyond.beyondProtocol, true);
  assert.ok(beyond.alerts.some((a) => a.text.includes('beyond the defined protocol')));
});

test('month cells from the old sheet', () => {
  assert.deepEqual(parseMonthCell('04 Photo'), { month: 4, photoMarked: true });
  assert.deepEqual(parseMonthCell('16'), { month: 16, photoMarked: false });
  assert.deepEqual(parseMonthCell(''), { month: null, photoMarked: false });
  assert.deepEqual(parseMonthCell(8), { month: 8, photoMarked: false });
});

// ---------------------------------------------------------------- legacy data
test('amounts typed as text', () => {
  assert.equal(parseAmount('35k'), 35000);
  assert.equal(parseAmount('200k'), 200000);
  assert.equal(parseAmount('24000'), 24000);
  assert.equal(parseAmount('Rs 5,000'), 5000);
  assert.equal(parseAmount('0'), 0);
  assert.equal(parseAmount('1.5 lac'), 150000);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('Bonding'), null);
});

test('branch suffixes removed from names', () => {
  assert.deepEqual(cleanLegacyName('Sana lhr'), { name: 'Sana', branch: 'LHR' });
  assert.deepEqual(cleanLegacyName('Ali Khan N.N'), { name: 'Ali Khan', branch: 'NN' });
  assert.deepEqual(cleanLegacyName('hina mohsin isb'), { name: 'Hina Mohsin', branch: 'ISB' });
  assert.deepEqual(cleanLegacyName('Muhammad Luqman (Kid)'), { name: 'Muhammad Luqman (Kid)', branch: null });
  assert.deepEqual(cleanLegacyName('Dua'), { name: 'Dua', branch: null });
});

test('doctor names with different spellings', () => {
  const list = [
    { displayName: 'Dr. Warda Javed', aliases: ['Dr. Verda Javed', 'Dr Verda'] },
    { displayName: 'Dr. Hameeda Sharaf', aliases: [] },
    { displayName: 'Dr. Haniya Siddiqui', aliases: ['Dr Haniya'] },
  ];
  assert.equal(matchClinician('Dr. Verda Javed', list)?.displayName, 'Dr. Warda Javed');
  assert.equal(matchClinician('Dr Hameeda', list)?.displayName, 'Dr. Hameeda Sharaf');
  assert.equal(matchClinician('Dr. Unknown', list), null);
  assert.deepEqual(splitPeople('Dr. Ali Rashid, Anousha Khan, Dr. Samrah Khan'),
    ['Dr. Ali Rashid', 'Anousha Khan', 'Dr. Samrah Khan']);
});

test('treatment details from the sheet', () => {
  const a = parseTreatmentDetails('U L 018 Pc Refresh');
  assert.equal(a.upperWire, '018'); assert.equal(a.lowerWire, '018');
  assert.ok(a.powerChain && a.refresh); assert.equal(a.unparsed, '');

  const b = parseTreatmentDetails('Brac 32 U 018 L 012');
  assert.deepEqual(b.brackets, [32]); assert.equal(b.upperWire, '018'); assert.equal(b.lowerWire, '012');

  const c = parseTreatmentDetails('Uo18 Lo14 Fig Of 8 Pc Refresh');
  assert.equal(c.upperWire, '018'); assert.equal(c.lowerWire, '014'); assert.ok(c.figureOf8);

  const d = parseTreatmentDetails('Bracket 26 36 Ext 24 34 Ul018 Pc');
  assert.deepEqual(d.brackets, [26, 36]); assert.deepEqual(d.extractions, [24, 34]);
  assert.equal(d.upperWire, '018');

  const e = parseTreatmentDetails('24,34, Extraction, Ulo18, Pc');
  assert.deepEqual(e.extractions, [24, 34]); assert.equal(e.lowerWire, '018'); assert.ok(e.powerChain);

  const f = parseTreatmentDetails('Brac 16 13 45 46 U L 016 Temps 12 21');
  assert.deepEqual(f.brackets, [16, 13, 45, 46]); assert.deepEqual(f.temporaries, [12, 21]);

  const g = parseTreatmentDetails('Bonding 70kit');
  assert.equal(g.kitPrice, 70000); assert.equal(g.bonding, 'both');

  const h = parseTreatmentDetails('Lo16,Uo12,Open Coil Spring');
  assert.equal(h.lowerWire, '016'); assert.equal(h.upperWire, '012'); assert.ok(h.openCoilSpring);

  const i = parseTreatmentDetails('Lower Bonding U016 Ext 24');
  assert.equal(i.bonding, 'lower'); assert.equal(i.upperWire, '016'); assert.deepEqual(i.extractions, [24]);

  const j = parseTreatmentDetails('Brac 45 46 2 Lingual Bitton U L 016');
  assert.ok(j.lingualButtons); assert.deepEqual(j.brackets, [45, 46]);

  const k = parseTreatmentDetails('U L O18 Pc Full Arch And Cross Arch');
  assert.equal(k.upperWire, '018'); assert.ok(k.fullArch && k.crossArch);

  const l = parseTreatmentDetails('Will Come After 6 Months Braces Relapse Case');
  assert.ok(l.unparsed.includes('relapse'), 'free text kept');

  assert.equal(summariseDetails(a), 'U/L 018 · PC refresh');
});

// ---------------------------------------------------------------- permissions
test('permission grid defaults', () => {
  const grid = defaultGrid();
  assert.equal(hasPermission('front_desk', 'patients.create', grid), true);
  assert.equal(hasPermission('assistant', 'patients.create', grid), false);
  assert.equal(hasPermission('assistant', 'patients.create', grid, { 'patients.create': true }), true);
  assert.equal(hasPermission('accountant', 'expenses.manage', grid), true);
  assert.equal(hasPermission('coordinator', 'complaints.view', grid), true);
  assert.equal(hasPermission('front_desk', 'complaints.view', grid), false);
  assert.equal(hasPermission('admin', 'anything.at.all', grid), true);
  assert.equal(hasPermission(null, 'patients.view', grid), false);
  assert.equal(new Set(PERMISSIONS.map((p) => p.key)).size, PERMISSIONS.length, 'no duplicate keys');
});

test('discount caps', () => {
  const cap = { maxPercent: 10, maxAmount: 5000 };
  assert.equal(discountNeedsApproval('front_desk', 20000, 1000, cap, false), false);
  assert.equal(discountNeedsApproval('front_desk', 20000, 4000, cap, false), true, '20% > 10%');
  assert.equal(discountNeedsApproval('front_desk', 100000, 6000, cap, false), true, 'Rs 6,000 > Rs 5,000');
  assert.equal(discountNeedsApproval('accountant', 20000, 4000, cap, true), false);
  assert.equal(discountNeedsApproval('front_desk', 20000, 500, undefined, false), true, 'no cap set = approval');
});

// ---------------------------------------------------------------- autosave
function memoryStore() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}
function manualTimers() {
  const queue: Array<() => void> = [];
  return {
    setTimer: (fn: () => void) => { queue.push(fn); return queue.length; },
    clearTimer: () => {},
    runAll: async () => { while (queue.length) { queue.shift()!(); await new Promise((r) => setImmediate(r)); } },
  };
}

test('autosave merges edits to the same row and saves them', async () => {
  const sent: PendingEdit[] = [];
  const timers = manualTimers();
  const q = new AutosaveQueue({ store: memoryStore(), send: async (e) => void sent.push(structuredClone(e)), ...timers });
  q.edit('visits', 'r1', 'status', 'completed');
  q.edit('visits', 'r1', 'details_text', 'U L 018');
  q.edit('visits', 'r2', 'status', 'waiting');
  await timers.runAll();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].changes, { status: 'completed', details_text: 'U L 018' });
  assert.equal(q.pendingCount, 0);
});

test('autosave keeps edits while offline and survives a page reload', async () => {
  const store = memoryStore();
  const timers = manualTimers();
  const states: string[] = [];
  let online = false;
  const send = async () => { if (!online) throw new Error('network down'); };
  const q = new AutosaveQueue({ store, send, ...timers, onState: (s) => states.push(s) });
  q.setOnline(false);
  q.edit('visits', 'r1', 'status', 'completed');
  await timers.runAll();
  assert.equal(q.pendingCount, 1);
  assert.ok(states.includes('offline'));

  // Page reloads: a new queue picks up the saved edit from the device.
  const sent: PendingEdit[] = [];
  const timers2 = manualTimers();
  const q2 = new AutosaveQueue({ store, send: async (e) => void sent.push(e), ...timers2 });
  assert.equal(q2.pendingCount, 1);
  q2.setOnline(true);
  await timers2.runAll();
  assert.equal(sent.length, 1);
  assert.equal(q2.pendingCount, 0);
  online = true;
});

test('autosave retries network errors but drops permanent ones', async () => {
  const timers = manualTimers();
  let calls = 0;
  const q = new AutosaveQueue({
    store: memoryStore(), ...timers,
    send: async (e) => {
      calls++;
      if (e.rowId === 'bad') throw new PermanentSaveError('GROUP_NOT_ALLOWED');
      if (calls < 3) throw new Error('timeout');
    },
  });
  q.edit('visits', 'ok', 'status', 'completed');
  await timers.runAll();
  assert.equal(q.pendingCount, 0, 'saved after retries');
  q.edit('visits', 'bad', 'doctor', 'x');
  await timers.runAll();
  assert.equal(q.failed.length, 1);
  assert.equal(q.failed[0].error, 'GROUP_NOT_ALLOWED');
});
