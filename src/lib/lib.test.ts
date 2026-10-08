import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidance, canTreat, canCheck, protocolFor, parseMonthCell, BRACES_PROTOCOL } from './protocol.ts';
import { parseAmount, cleanLegacyName, parseTreatmentDetails, summariseDetails, matchClinician, splitPeople } from './legacy.ts';
import { defaultGrid, hasPermission, discountNeedsApproval, PERMISSIONS } from './permissions.ts';
import { AutosaveQueue, PermanentSaveError, clearForUser, type PendingEdit, type SaveState } from './autosave.ts';

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
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
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

const tick = () => new Promise<void>((r) => setImmediate(r));
/** A promise the test settles by hand, to hold a send in flight. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

test('autosave: an edit typed while the same row is being sent is saved too, not merged into the send and lost', async () => {
  const sent: PendingEdit[] = [];
  const g = gate();
  let first = true;
  const timers = manualTimers();
  const states: SaveState[] = [];
  const q = new AutosaveQueue({
    store: memoryStore(), ...timers, onState: (s) => states.push(s),
    send: async (e) => {
      sent.push(structuredClone(e));
      if (first) { first = false; await g.wait; }
    },
  });
  q.edit('visits', 'r1', 'treatment_label', 'Monthly');
  const running = q.flush();
  await tick();
  assert.equal(sent.length, 1, 'the first edit is in flight');
  q.edit('visits', 'r1', 'details_text', 'U L 018');
  q.edit('visits', 'r1', 'notes', 'wire changed');
  assert.notEqual(states.at(-1), 'saved', 'not reported as saved while edits wait');
  g.open();
  await running;
  assert.equal(sent.length, 2, 'the later edits went out as their own save');
  assert.deepEqual(sent[0].changes, { treatment_label: 'Monthly' });
  assert.deepEqual(sent[1].changes, { details_text: 'U L 018', notes: 'wire changed' }, 'edits made meanwhile still merge with each other');
  assert.equal(q.pendingCount, 0);
  assert.equal(states.at(-1), 'saved');
  q.dispose();
});

test('autosave: the sender gets a copy, so changing it cannot change the queue', async () => {
  const timers = manualTimers();
  const q = new AutosaveQueue({ store: memoryStore(), ...timers, send: async (e) => { e.changes.status = 'tampered'; } });
  q.edit('visits', 'r1', 'status', 'completed');
  await q.flush();
  assert.equal(q.pendingCount, 0);
  q.dispose();
});

test('autosave: stored edits belong to one person; edits from before logins existed, and old ones, are listed, not sent', async () => {
  const store = memoryStore();
  const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
  store.setItem('aaj', JSON.stringify([{ table: 'visits', rowId: 'legacy', changes: { notes: 'old' }, firstEditedAt: Date.now(), attempts: 0 }]));
  store.setItem('aaj:alice', JSON.stringify([
    { table: 'visits', rowId: 'stale', changes: { notes: 'two days ago' }, firstEditedAt: old, attempts: 0 },
    { table: 'visits', rowId: 'fresh', changes: { notes: 'today' }, firstEditedAt: Date.now() - 1000, attempts: 0 },
  ]));
  const timers = manualTimers();
  const sent: string[] = [];
  const send = async (e: PendingEdit) => void sent.push(e.rowId);

  const bob = new AutosaveQueue({ store, storageKey: 'aaj', userId: 'bob', send, ...timers });
  assert.equal(bob.pendingCount, 0, "Bob does not get Alice's edits");
  assert.equal(bob.failedCount, 1, 'the un-owned edit is listed for whoever opens the list first');
  bob.dispose();
  assert.equal(store.getItem('aaj'), null, 'the un-owned queue is removed once listed');

  const alice = new AutosaveQueue({ store, storageKey: 'aaj', userId: 'alice', send, ...timers });
  assert.equal(alice.pendingCount, 1);
  assert.deepEqual(alice.failedEdits.map((f) => f.rowId), ['stale']);
  assert.equal(JSON.parse(store.getItem('aaj:alice:failed')!).length, 1, 'failed list is kept on the device');
  await alice.flush();
  assert.deepEqual(sent, ['fresh'], 'only the recent edit is sent');
  alice.dispose();
});

test('autosave: a failed save is reported with its row, can be retried, and is replaced by newer typing', async () => {
  const store = memoryStore();
  const timers = manualTimers();
  const heard: Array<{ key: string; error: string; hasRetry: boolean }> = [];
  const doc = new EventTarget();
  (globalThis as { document?: unknown }).document = doc;
  doc.addEventListener('app:save-failed', (ev) => {
    const d = (ev as CustomEvent).detail;
    heard.push({ key: d.key, error: d.error.message, hasRetry: typeof d.retry === 'function' });
  });
  let reject = true;
  const sent: string[] = [];
  const onFailed: string[] = [];
  const q = new AutosaveQueue({
    store, userId: 'u1', ...timers,
    onFailed: (d) => onFailed.push(d.key),
    send: async (e) => {
      if (reject) throw new PermanentSaveError('DUES_HOLD: clear dues first');
      sent.push(JSON.stringify(e.changes));
    },
  });
  try {
    q.edit('visits', 'r9', 'status', 'in_treatment');
    await q.flush();
    assert.deepEqual(heard, [{ key: 'visits:r9', error: 'DUES_HOLD: clear dues first', hasRetry: true }], 'document event');
    assert.deepEqual(onFailed, ['visits:r9'], 'options.onFailed');
    assert.equal(q.failedCount, 1);
    assert.equal(q.pendingCount, 0);

    reject = false;
    q.retryFailed('visits:r9');
    await q.flush();
    assert.deepEqual(sent, ['{"status":"in_treatment"}']);
    assert.equal(q.failedCount, 0);
    assert.equal(store.getItem('clinic-autosave-v1:u1:failed'), null, 'failed key removed when empty');

    reject = true;
    q.edit('visits', 'r9', 'notes', 'a');
    q.edit('visits', 'r9', 'status', 'completed');
    await q.flush();
    assert.equal(q.failedCount, 1);
    reject = false;
    q.edit('visits', 'r9', 'notes', 'b'); // typing the same field again replaces the failed value
    assert.deepEqual(q.failedEdits[0].changes, { status: 'completed' });
    q.discardFailed();
    assert.equal(q.failedCount, 0);
  } finally {
    q.dispose();
    delete (globalThis as { document?: unknown }).document;
  }
});

test('clearForUser stops every queue, keeps unsent edits under their owner and counts them', async () => {
  await clearForUser(); // start from a clean module state (earlier tests leave queues open)
  const store = memoryStore();
  const timers = manualTimers();
  // One failed entry on the device already (an edit that waited more than a day before the list was opened).
  store.setItem('clinic-autosave-v1:u1:failed', JSON.stringify([{ key: 'visits:c', edit: { table: 'visits', rowId: 'c', changes: { notes: 'z' }, firstEditedAt: 1 }, error: 'x', at: 1 }]));
  const q = new AutosaveQueue({ store, userId: 'u1', ...timers, send: async () => { throw new Error('Failed to fetch'); } });
  q.edit('visits', 'a', 'notes', 'x');
  q.edit('visits', 'b', 'notes', 'y');
  const detail = await clearForUser({ flush: true, timeoutMs: 200 });
  assert.deepEqual(detail, { pending: 2, failed: 1 }, 'pending edits are sent at the next login, failed ones wait for Try again');
  assert.equal(q.disposed, true);
  assert.deepEqual(JSON.parse(store.getItem('clinic-autosave-v1:u1')!).map((e: PendingEdit) => e.rowId), ['a', 'b'], 'still on the device');

  // A new session of the same person finds them again.
  const next = new AutosaveQueue({ store, userId: 'u1', ...timers, send: async () => {} });
  assert.equal(next.pendingCount, 2);
  assert.deepEqual(await clearForUser(), { pending: 2, failed: 1 }, 'a new session of the same person finds the same edits');
  const gone = new AutosaveQueue({ store, userId: 'u1', ...timers, send: async () => {} });
  await clearForUser({ discard: true });
  assert.equal(store.getItem('clinic-autosave-v1:u1'), null, 'discard: true deletes them');
  assert.equal(gone.pendingCount, 0);

  // After logout a late edit is refused, not saved under the next login.
  const events: SaveState[] = [];
  const late = new AutosaveQueue({ store, userId: 'u1', ...timers, send: async () => {}, onState: (s) => events.push(s) });
  late.dispose();
  late.edit('visits', 'a', 'notes', 'too late');
  assert.equal(late.pendingCount, 0);
  assert.equal(events.at(-1), 'error');
});

test('clearForUser({ flush: true }) waits for a save already in progress, and for what was typed behind it', async () => {
  await clearForUser();
  const store = memoryStore();
  const timers = manualTimers();
  const g = gate();
  const sent: string[] = [];
  const q = new AutosaveQueue({
    store, userId: 'u1', ...timers,
    send: async (e) => { sent.push(e.rowId); if (e.rowId === 'a') await g.wait; },
  });
  q.edit('visits', 'a', 'notes', 'one');
  void q.flush(); // the timer-driven flush is mid-save
  await tick();
  q.edit('visits', 'b', 'notes', 'two'); // typed just before logout
  let settled = false;
  const closing = clearForUser({ flush: true, timeoutMs: 5000 }).then((r) => { settled = true; return r; });
  await tick();
  assert.equal(settled, false, 'logout waits while the save is in flight');
  g.open();
  assert.deepEqual(await closing, { pending: 0, failed: 0 });
  assert.deepEqual(sent, ['a', 'b']);
  assert.equal(store.getItem('clinic-autosave-v1:u1'), '[]');
});

test('clearForUser gives up on a save that hangs, and a failure that arrives after logout is kept, not announced', async () => {
  await clearForUser();
  const store = memoryStore();
  const timers = manualTimers();
  const g = gate();
  const announced: string[] = [];
  const q = new AutosaveQueue({
    store, userId: 'u1', ...timers, onFailed: (d) => announced.push(d.key),
    send: async () => { await g.wait; throw new PermanentSaveError('permission denied'); },
  });
  q.edit('visits', 'a', 'notes', 'one');
  void q.flush();
  await tick();
  const left = await clearForUser({ flush: true, timeoutMs: 20 });
  assert.deepEqual(left, { pending: 1, failed: 0 }, 'did not wait forever');
  g.open();
  await tick();
  await tick();
  assert.deepEqual(announced, [], 'no message for a person who has logged out');
  assert.deepEqual(JSON.parse(store.getItem('clinic-autosave-v1:u1:failed')!).map((f: { key: string }) => f.key), ['visits:a'], 'kept for their next login');
});
