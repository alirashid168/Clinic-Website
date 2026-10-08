import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, range, visitRuns, slotsOn, aliSlotsAt, openSpan, branchDay, branchHoursFrom, dateLabel, fullDateLabel, monthTitle, SHORT_DOW, MONTHS, type ScheduleRow, type BranchHours } from './hours.ts';

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
// Times use a no-break space before AM/PM, so "9" and "PM" never land on two lines. nb() turns the spaces
// written in the expectations below into those no-break spaces.
const nb = (s: string) => s.replace(/ (AM|PM)\b/g, '\xa0$1');

test('times read the way patients say them', () => {
  assert.equal(clock('12:00:00'), nb('12 PM'));
  assert.equal(clock('21:00'), nb('9 PM'));
  assert.equal(clock('14:30'), nb('2:30 PM'));
  assert.equal(clock('00:05'), nb('12:05 AM'));
  assert.equal(range('15:00-21:00'), nb('3 PM – 9 PM'));
  assert.equal(range('09:00:00', '13:00:00'), nb('9 AM – 1 PM'));
  assert.equal(dateLabel('2026-10-08'), 'Thu 8 Oct');
});

test('a time never breaks between the number and AM/PM', () => {
  for (const t of ['00:00', '09:00', '12:00', '14:30', '21:00']) {
    assert.match(clock(t), /^\d{1,2}(:\d\d)?\xa0(AM|PM)$/, t);
    assert.ok(!clock(t).includes(' '), 'no plain space inside a time');
  }
  // The dash keeps its normal spaces, so a long range may still wrap between the two times.
  assert.equal(range('12:00', '21:00').split(' ').length, 3);
});

test('Lahore lists only visit dates, with the times of the dated rows (Friday starts at 3 PM)', () => {
  const trip = nb('Thu 12 PM – 9 PM · Fri 3 PM – 9 PM · Sat – Sun 12 PM – 9 PM');
  assert.deepEqual(visitRuns(ROWS, LHR, '2026-10-06').map((r) => r.text),
    [`Thu 8 Oct – Sun 11 Oct, ${trip}`, `Thu 22 Oct – Sun 25 Oct, ${trip}`]);
  assert.deepEqual(visitRuns(ROWS, LHR, '2026-10-12').map((r) => r.label), ['Thu 22 Oct – Sun 25 Oct'], 'past trips drop off');
  assert.equal(visitRuns(ROWS, LHR, '2026-10-06', 10).length, 1, 'the horizon (days ahead) limits the search');
});

test("a trip's times come as pieces that never split, days with the same time grouped", () => {
  const lhr = visitRuns(ROWS, LHR, '2026-10-06')[0];
  assert.deepEqual(lhr.parts, ['Thu 12 PM – 9 PM', 'Fri 3 PM – 9 PM', 'Sat – Sun 12 PM – 9 PM'].map(nb));
  assert.equal(lhr.time, lhr.parts.join(' · '));
  const same = visitRuns([d(LHR, '2026-10-20', '12:00', '21:00'), d(LHR, '2026-10-21', '12:00', '21:00')], LHR, '2026-10-19')[0];
  assert.deepEqual(same.parts, [nb('12 PM – 9 PM')], 'one time for every day: one piece, no weekday names');
  assert.equal(same.text, nb('Tue 20 Oct – Wed 21 Oct, 12 PM – 9 PM'));
  const back = visitRuns([d(LHR, '2026-10-20', '12:00', '21:00'), d(LHR, '2026-10-21', '15:00', '21:00'), d(LHR, '2026-10-22', '12:00', '21:00')], LHR, '2026-10-19')[0];
  assert.deepEqual(back.parts, ['Tue 12 PM – 9 PM', 'Wed 3 PM – 9 PM', 'Thu 12 PM – 9 PM'].map(nb), 'a time that comes back is a new piece');
});

test('Islamabad visit days keep their different times', () => {
  const trip = nb('Mon 4 PM – 10 PM · Tue 2 PM – 8 PM');
  assert.deepEqual(visitRuns(ROWS, ISB, '2026-10-06').map((r) => r.text), [`Mon 12 Oct – Tue 13 Oct, ${trip}`, `Mon 26 Oct – Tue 27 Oct, ${trip}`]);
  assert.deepEqual(visitRuns(ROWS, ISB, '2026-10-13').map((r) => r.text), [nb('Tue 13 Oct, 2 PM – 8 PM'), `Mon 26 Oct – Tue 27 Oct, ${trip}`]);
});

test("one rule for Dr. Ali's times: the strip, cards and trips all read slotsOn", () => {
  // Lahore's old clinic_timings 'hours' (12–9) is not used: Friday's dated row says 3 PM.
  assert.deepEqual(aliSlotsAt(ROWS, LHR, '2026-10-09'), [{ branch_id: LHR, start: '15:00', end: '21:00' }]);
  assert.deepEqual(openSpan(H[LHR], ROWS, LHR, '2026-10-09'), ['15:00', '21:00']);
  assert.equal(openSpan(H[LHR], ROWS, LHR, '2026-10-07'), null, 'no dated row, not open');
  assert.deepEqual(openSpan(H[ISB], ROWS, ISB, '2026-10-12'), ['16:00', '22:00']);
  assert.equal(openSpan(H[ISB], ROWS, ISB, '2026-10-14'), null);
  assert.equal(openSpan(undefined, ROWS, 9, '2026-10-08'), null, 'unknown hours');
});

test('branchDay: Karachi by weekday, Sunday closed, plus where Dr. Ali is', () => {
  assert.deepEqual(branchDay(H[GUL], ROWS, GUL, '2026-10-11'), { date: '2026-10-11', open: null, ali: [] }, 'Gulshan closed Sunday, Dr. Ali is in Lahore');
  assert.deepEqual(branchDay(H[GUL], ROWS, GUL, '2026-10-09'), { date: '2026-10-09', open: ['15:00', '21:00'], ali: [] }, 'Gulshan open while Dr. Ali is in Lahore');
  assert.deepEqual(branchDay(H[NN], ROWS, NN, '2026-10-12'), { date: '2026-10-12', open: ['16:00', '21:00'], ali: [] }, 'North Nazimabad open while Dr. Ali is in Islamabad');
  assert.deepEqual(branchDay(H[GUL], ROWS, GUL, '2026-10-07'), { date: '2026-10-07', open: ['12:00', '21:00'], ali: [['12:00', '21:00']] });
  assert.deepEqual(branchDay(H[LHR], ROWS, LHR, '2026-10-08'), { date: '2026-10-08', open: ['12:00', '21:00'], ali: [['12:00', '21:00']] }, 'a visit branch is open exactly when Dr. Ali is there');
});

test('a normally closed Karachi day opens when Dr. Ali is booked there', () => {
  const rows = [...ROWS, w(DHA, 0, '14:00', '18:00')]; // Sundays at DHA
  assert.deepEqual(openSpan(H[DHA], rows, DHA, '2026-10-18'), ['14:00', '18:00'], 'Sunday: not a weekly day, but Dr. Ali is there');
  assert.deepEqual(branchDay(H[DHA], rows, DHA, '2026-10-18').ali, [['14:00', '18:00']]);
  assert.equal(openSpan(H[DHA], ROWS, DHA, '2026-10-18'), null, 'without the row it stays closed');
});

test('date and month labels', () => {
  assert.equal(fullDateLabel('2026-10-08'), 'Thursday 8 October');
  assert.equal(monthTitle(2026, 10), 'October 2026');
  assert.deepEqual(SHORT_DOW, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  assert.equal(MONTHS[9], 'Oct');
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

// ---------------------------------------------------------------- live status
import { branchStatus, aliNow, aliNext, monthCells, whenLabel, toMin } from './hours.ts';
const T = '2026-10-06'; // Tuesday
const at = (hhmm: string) => toMin(hhmm);

test('branch status reads like a receptionist would say it', () => {
  assert.deepEqual(branchStatus(H[GUL], ROWS, GUL, T, at('17:10')), { open: true, text: nb('Open now · until 9 PM') });
  assert.deepEqual(branchStatus(H[GUL], ROWS, GUL, T, at('10:00')), { open: false, text: nb('Opens today, 12 PM') });
  assert.deepEqual(branchStatus(H[GUL], ROWS, GUL, '2026-10-10', at('22:00')), { open: false, text: nb('Opens Monday, 12 PM') }, 'Sat night skips Sunday');
  assert.deepEqual(branchStatus(H[NN], ROWS, NN, T, at('17:10')), { open: false, text: nb('Opens Thursday, 4 PM') });
  assert.deepEqual(branchStatus(H[DHA], ROWS, DHA, T, at('21:30')), { open: false, text: nb('Opens Tue 13 Oct, 4 PM') });
  assert.deepEqual(branchStatus(H[LHR], ROWS, LHR, T, at('17:10')), { open: false, text: nb('Opens Thursday, 12 PM') });
  assert.deepEqual(branchStatus(H[LHR], ROWS, LHR, '2026-10-09', at('13:00')), { open: false, text: nb('Opens today, 3 PM') }, "Lahore Friday: Dr. Ali's dated row says 3 PM, not the old 12");
  assert.deepEqual(branchStatus(H[LHR], ROWS, LHR, '2026-10-09', at('16:00')), { open: true, text: nb('Open now · until 9 PM') });
  assert.deepEqual(branchStatus(H[ISB], ROWS, ISB, '2026-10-14', at('12:00')), { open: false, text: nb('Next open Mon 26 Oct') });
  assert.deepEqual(branchStatus(H[LHR], ROWS, LHR, '2026-10-26', at('12:00')), { open: false, text: nb('No dates scheduled yet') });
});

test("Dr. Ali's whereabouts: now and next per branch", () => {
  assert.equal(aliNow(ROWS, T, at('17:10'))?.branch_id, DHA);
  assert.equal(aliNow(ROWS, T, at('13:00'))?.branch_id, GUL);
  assert.equal(aliNow(ROWS, T, at('22:00')), null);
  assert.deepEqual(aliNext(ROWS, DHA, T, at('17:10')), { here: true, date: T, start: '16:00', end: '21:00' });
  assert.deepEqual(aliNext(ROWS, GUL, T, at('17:10')), { here: false, date: '2026-10-07', start: '12:00', end: '21:00' });
  assert.deepEqual(aliNext(ROWS, NN, T, at('17:10')), { here: false, date: '2026-10-15', start: '16:00', end: '21:00' }, 'skips Thu 8, he is in Lahore');
  assert.equal(whenLabel('2026-10-07', T), 'tomorrow');
  assert.equal(whenLabel('2026-10-08', T), 'Thursday');
  assert.equal(whenLabel('2026-10-15', T), 'Thu 15 Oct');
});

test('month grid starts on Monday', () => {
  const oct = monthCells(2026, 10);
  assert.equal(oct.length, 35);
  assert.deepEqual(oct.slice(0, 4).map((c) => c.day), [0, 0, 0, 1], 'Oct 1 2026 is a Thursday');
  assert.equal(oct[33].iso, '2026-10-31');
});

test('visit runs carry per-day times when they differ', () => {
  const r = visitRuns(ROWS, ISB, '2026-10-06');
  assert.equal(r[0].label, 'Mon 12 Oct – Tue 13 Oct');
  assert.equal(r[0].time, nb('Mon 4 PM – 10 PM · Tue 2 PM – 8 PM'));
  assert.equal(visitRuns(ROWS, LHR, '2026-10-06')[0].time, nb('Thu 12 PM – 9 PM · Fri 3 PM – 9 PM · Sat – Sun 12 PM – 9 PM'));
});
