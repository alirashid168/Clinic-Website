import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, range, weeklyLines, visitRuns, openOn, slotsOn, branchHoursFrom, dateLabel, type ScheduleRow, type BranchHours } from './hours.ts';

const GUL = 1, NN = 2, DHA = 3, LHR = 4, ISB = 5;
const SETTING = {
  mon: '12:00-21:00', // legacy keys stay for older code
  branches: {
    [GUL]: { mode: 'weekly', days: { mon: '12:00-21:00', tue: '12:00-21:00', wed: '12:00-21:00', thu: '12:00-21:00', fri: '15:00-21:00', sat: '12:00-21:00' } },
    [NN]: { mode: 'weekly', days: { mon: '16:00-21:00', thu: '16:00-21:00' } },
    [DHA]: { mode: 'weekly', days: { tue: '16:00-21:00' } },
    [LHR]: { mode: 'visits', hours: '12:00-21:00' },
    [ISB]: { mode: 'visits' },
  },
};
const w = (branch_id: number, weekday: number, s: string, e: string): ScheduleRow => ({ branch_id, weekday, start_time: s + ':00', end_time: e + ':00' });
const d = (branch_id: number, on_date: string, s: string, e: string): ScheduleRow => ({ branch_id, on_date, start_time: s + ':00', end_time: e + ':00' });
const ROWS: ScheduleRow[] = [
  w(GUL, 1, '12:00', '16:00'), w(NN, 1, '16:00', '21:00'),
  w(GUL, 2, '12:00', '16:00'), w(DHA, 2, '16:00', '21:00'),
  w(GUL, 3, '12:00', '21:00'),
  w(GUL, 4, '12:00', '16:00'), w(NN, 4, '16:00', '21:00'),
  w(GUL, 5, '15:00', '21:00'), w(GUL, 6, '12:00', '21:00'),
  d(LHR, '2026-10-08', '12:00', '21:00'), d(LHR, '2026-10-09', '15:00', '21:00'), d(LHR, '2026-10-10', '12:00', '21:00'), d(LHR, '2026-10-11', '12:00', '21:00'),
  d(ISB, '2026-10-12', '16:00', '22:00'), d(ISB, '2026-10-13', '14:00', '20:00'),
  d(LHR, '2026-10-22', '12:00', '21:00'), d(LHR, '2026-10-23', '15:00', '21:00'), d(LHR, '2026-10-24', '12:00', '21:00'), d(LHR, '2026-10-25', '12:00', '21:00'),
  d(ISB, '2026-10-26', '16:00', '22:00'), d(ISB, '2026-10-27', '14:00', '20:00'),
];
const H = branchHoursFrom(JSON.stringify(SETTING)) as Record<string, BranchHours>;

test('times read the way patients say them', () => {
  assert.equal(clock('12:00:00'), '12 PM');
  assert.equal(clock('21:00'), '9 PM');
  assert.equal(clock('14:30'), '2:30 PM');
  assert.equal(range('15:00-21:00'), '3 PM – 9 PM');
  assert.equal(dateLabel('2026-10-08'), 'Thu 8 Oct');
});

test('Karachi branch cards show their own weekdays, Sunday closed', () => {
  assert.deepEqual(weeklyLines((H[GUL] as any).days), ['Mon – Thu: 12 PM – 9 PM', 'Fri: 3 PM – 9 PM', 'Sat: 12 PM – 9 PM', 'Sun: Closed']);
  assert.deepEqual(weeklyLines((H[NN] as any).days), ['Mon: 4 PM – 9 PM', 'Tue – Wed: Closed', 'Thu: 4 PM – 9 PM', 'Fri – Sun: Closed']);
  assert.deepEqual(weeklyLines((H[DHA] as any).days), ['Mon: Closed', 'Tue: 4 PM – 9 PM', 'Wed – Sun: Closed']);
});

test('Lahore lists only visit dates, with clinic hours 12–9 even on Friday', () => {
  assert.deepEqual(visitRuns(ROWS, LHR, '2026-10-06', '12:00-21:00').map((r) => r.text),
    ['Thu 8 Oct – Sun 11 Oct, 12 PM – 9 PM', 'Thu 22 Oct – Sun 25 Oct, 12 PM – 9 PM']);
  assert.deepEqual(visitRuns(ROWS, LHR, '2026-10-12', '12:00-21:00').map((r) => r.text), ['Thu 22 Oct – Sun 25 Oct, 12 PM – 9 PM'], 'past trips drop off');
});

test('Islamabad visit days keep their different times', () => {
  assert.deepEqual(visitRuns(ROWS, ISB, '2026-10-06').map((r) => r.text), ['Mon 12 Oct – Tue 13 Oct', 'Mon 26 Oct – Tue 27 Oct']);
  assert.deepEqual(visitRuns(ROWS, ISB, '2026-10-13').map((r) => r.text), ['Tue 13 Oct, 2 PM – 8 PM', 'Mon 26 Oct – Tue 27 Oct']);
});

test('open today: Karachi by weekday, Lahore/Islamabad only on visit dates', () => {
  assert.equal(openOn(H[GUL], ROWS, GUL, '2026-10-11'), false, 'Gulshan closed Sunday');
  assert.equal(openOn(H[GUL], ROWS, GUL, '2026-10-09'), true, 'Gulshan open while Dr. Ali is in Lahore');
  assert.equal(openOn(H[NN], ROWS, NN, '2026-10-12'), true, 'North Nazimabad open while Dr. Ali is in Islamabad');
  assert.equal(openOn(H[LHR], ROWS, LHR, '2026-10-07'), false);
  assert.equal(openOn(H[LHR], ROWS, LHR, '2026-10-08'), true);
  assert.equal(openOn(H[ISB], ROWS, ISB, '2026-10-14'), false);
  assert.equal(openOn(undefined, ROWS, 9, '2026-10-08'), null);
});

test("Dr. Ali's calendar: normal week, replaced by trip days", () => {
  const at = (date: string) => slotsOn(ROWS, date).slots.map((s) => `${s.branch_id} ${s.start}-${s.end}`);
  assert.deepEqual(at('2026-10-06'), ['1 12:00-16:00', '3 16:00-21:00'], 'Tue: Gulshan then DHA');
  assert.deepEqual(at('2026-10-07'), ['1 12:00-21:00']);
  assert.deepEqual(at('2026-10-08'), ['4 12:00-21:00'], 'Thu in Lahore, not North Nazimabad');
  assert.deepEqual(at('2026-10-09'), ['4 15:00-21:00']);
  assert.deepEqual(at('2026-10-11'), ['4 12:00-21:00'], 'Sunday in Lahore');
  assert.deepEqual(at('2026-10-12'), ['5 16:00-22:00']);
  assert.deepEqual(at('2026-10-13'), ['5 14:00-20:00']);
  assert.deepEqual(at('2026-10-15'), ['1 12:00-16:00', '2 16:00-21:00'], 'back in Karachi');
  assert.deepEqual(at('2026-10-18'), [], 'Sunday off');
  assert.equal(slotsOn(ROWS, '2026-10-08').dated, true);
});

test('a one-off day off removes only that branch from the normal week', () => {
  const rows = [...ROWS, { branch_id: NN, on_date: '2026-10-15', start_time: '16:00:00', end_time: '21:00:00', unavailable: true }];
  assert.deepEqual(slotsOn(rows, '2026-10-15').slots.map((s) => s.branch_id), [GUL]);
});

test('missing or old-style settings give no per-branch hours', () => {
  assert.deepEqual(branchHoursFrom({ mon: '12:00-21:00' }), {});
  assert.deepEqual(branchHoursFrom('not json'), {});
  assert.deepEqual(branchHoursFrom(null), {});
});
