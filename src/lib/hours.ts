// Branch opening hours and Dr. Ali's dated calendar.
//
// Two separate things, on purpose:
//  - Branch hours: when a clinic is open. Karachi branches open on fixed
//    weekdays (clinic_timings, mode 'weekly') whether or not Dr. Ali is there.
//    Lahore and Islamabad (mode 'visits') open ONLY on Dr. Ali's visit dates,
//    so their cards list dates, never weekdays.
//  - Dr. Ali's calendar: where he personally is. A normal week follows the
//    recurring weekday rows; a date with its own (on_date) rows, such as a
//    Lahore or Islamabad trip, replaces the normal week for that day.
//
// One rule for Dr. Ali's times: slotsOn(). The "This week" strip, the clinic
// cards' bars, visit-branch opening times, trip lists and calendars all read
// it, so they cannot disagree. The dated rows staff enter in the admin
// calendar are the source for visit days; the old clinic_timings 'hours'
// string of a visit branch is not used, because staff cannot edit it.

export type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
export const DAY_ORDER: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_BY_INDEX: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SHORT: Record<DayKey, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const LONG: Record<DayKey, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
/** Short weekday names by JS weekday index (0 = Sunday). */
export const SHORT_DOW: string[] = DAY_BY_INDEX.map((k) => SHORT[k]);
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Per-branch hours, stored in app_settings.clinic_timings.branches. */
export type BranchHours =
  | { mode: 'weekly'; days: Partial<Record<DayKey, string>> }       // "12:00-21:00"
  | { mode: 'visits'; hours?: string };                              // open only on visit dates (hours is no longer read)

export interface ScheduleRow {
  id?: string;
  branch_id: number;
  weekday?: number | null;
  on_date?: string | null;
  start_time: string;
  end_time: string;
  unavailable?: boolean | null;
  note?: string | null;
}

export interface Slot { branch_id: number; start: string; end: string; }

/** One trip: consecutive days Dr. Ali is at a visit branch. `parts` are the pieces of `time` that must not be split across lines. */
export interface VisitRun { from: string; to: string; text: string; label: string; time: string; parts: string[]; }

/** One branch on one date: when it is open, and when Dr. Ali is there. */
export interface BranchDay { date: string; open: [string, string] | null; ali: [string, string][]; }

// ---------------------------------------------------------------- dates
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function weekdayOf(iso: string): number { return new Date(iso + 'T12:00:00Z').getUTCDay(); }
export function dayKeyOf(iso: string): DayKey { return DAY_BY_INDEX[weekdayOf(iso)]; }

/** "Thu 8 Oct" */
export function dateLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${SHORT[dayKeyOf(iso)]} ${d} ${MONTHS[m - 1]}`;
}
/** "Thursday 8 October" */
export function fullDateLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${LONG[dayKeyOf(iso)]} ${d} ${MONTH_NAMES[m - 1]}`;
}

// ---------------------------------------------------------------- times
/** "16:00" -> "4 PM", "12:00" -> "12 PM", "14:30" -> "2:30 PM" */
export function clock(t: string): string {
  const [hh, mm] = t.slice(0, 5).split(':').map(Number);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${hh < 12 ? 'AM' : 'PM'}`;
}
/** "12:00-21:00" or ("12:00:00","21:00:00") -> "12 PM – 9 PM" */
export function range(a: string, b?: string): string {
  const [s, e] = b === undefined ? a.split('-') : [a, b];
  return `${clock(s)} – ${clock(e)}`;
}

// ---------------------------------------------------------------- settings
/** Reads the per-branch hours from the clinic_timings setting (object or JSON text). */
export function branchHoursFrom(setting: unknown): Record<string, BranchHours> {
  let t: any = setting;
  if (typeof t === 'string') { try { t = JSON.parse(t); } catch { t = {}; } }
  return (t && typeof t === 'object' && t.branches && typeof t.branches === 'object') ? t.branches : {};
}

// ---------------------------------------------------------------- Dr. Ali's calendar
/** Where Dr. Ali is on a date. Dated rows replace the normal week for that day. */
export function slotsOn(rows: ScheduleRow[], date: string): { slots: Slot[]; dated: boolean } {
  const dated = rows.filter((r) => r.on_date === date);
  const datedOpen = dated.filter((r) => !r.unavailable);
  const toSlot = (r: ScheduleRow): Slot => ({ branch_id: r.branch_id, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) });
  const sort = (s: Slot[]) => s.sort((a, b) => a.start.localeCompare(b.start));
  if (datedOpen.length) return { slots: sort(datedOpen.map(toSlot)), dated: true };
  const off = new Set(dated.filter((r) => r.unavailable).map((r) => r.branch_id));
  const wd = weekdayOf(date);
  const weekly = rows.filter((r) => r.weekday === wd && !r.on_date && !r.unavailable && !off.has(r.branch_id));
  return { slots: sort(weekly.map(toSlot)), dated: false };
}

/** Dr. Ali's slots at one branch on a date (from slotsOn, so they match the strip). */
export function aliSlotsAt(rows: ScheduleRow[], branchId: number, date: string): Slot[] {
  return slotsOn(rows, date).slots.filter((s) => s.branch_id === branchId);
}

// ---------------------------------------------------------------- branch cards
/**
 * Upcoming visit dates of a branch (days Dr. Ali is there), merged into runs of consecutive days.
 * When the times differ inside a run, `time` groups the days that share one:
 * "Thu 12 PM – 9 PM · Fri 3 PM – 9 PM · Sat – Sun 12 PM – 9 PM", and `parts` holds those pieces.
 */
export function visitRuns(rows: ScheduleRow[], branchId: number, today: string, horizon = 180): VisitRun[] {
  const runs: { from: string; to: string; times: string[]; dates: string[] }[] = [];
  for (let n = 0; n < horizon; n++) {
    const d = addDays(today, n);
    const own = aliSlotsAt(rows, branchId, d);
    if (!own.length) continue;
    const t = own.map((s) => range(s.start, s.end)).join(', ');
    const last = runs[runs.length - 1];
    if (last && addDays(last.to, 1) === d) { last.to = d; last.times.push(t); last.dates.push(d); } else runs.push({ from: d, to: d, times: [t], dates: [d] });
  }
  return runs.map((r) => {
    const label = r.from === r.to ? dateLabel(r.from) : `${dateLabel(r.from)} – ${dateLabel(r.to)}`;
    const same = r.times.every((x) => x === r.times[0]);
    let parts: string[];
    if (same) parts = [r.times[0]];
    else {
      // Consecutive days with the same time become one piece: "Sat – Sun 12 PM – 9 PM".
      const groups: { first: string; last: string; time: string }[] = [];
      r.dates.forEach((d, i) => {
        const g = groups[groups.length - 1];
        if (g && g.time === r.times[i]) g.last = d; else groups.push({ first: d, last: d, time: r.times[i] });
      });
      parts = groups.map((g) => `${g.first === g.last ? SHORT[dayKeyOf(g.first)] : `${SHORT[dayKeyOf(g.first)]} – ${SHORT[dayKeyOf(g.last)]}`} ${g.time}`);
    }
    const time = parts.join(' · ');
    return { from: r.from, to: r.to, text: `${label}, ${time}`, label, time, parts };
  });
}

// ---------------------------------------------------------------- live status
// Minutes since midnight: "16:30" -> 990.
export function toMin(t: string): number {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** "today", "tomorrow", "Thursday", or "Thu 15 Oct" further out. */
export function whenLabel(date: string, today: string): string {
  if (date === today) return 'today';
  if (date === addDays(today, 1)) return 'tomorrow';
  for (let n = 2; n < 7; n++) if (date === addDays(today, n)) return LONG[dayKeyOf(date)];
  return dateLabel(date);
}

/**
 * The branch's opening span on a date, as [start, end] times, or null when closed.
 * Weekly branches: their fixed hours for that weekday (or, on a normally closed day,
 * the hours Dr. Ali is booked there). Visit branches: Dr. Ali's slots there that day.
 */
export function openSpan(h: BranchHours | undefined, rows: ScheduleRow[], branchId: number, date: string): [string, string] | null {
  if (!h) return null;
  const own = aliSlotsAt(rows, branchId, date);
  const ali: [string, string] | null = own.length ? [own[0].start, own.reduce((e, s) => (s.end > e ? s.end : e), own[0].end)] : null;
  if (h.mode === 'weekly') {
    const v = h.days?.[dayKeyOf(date)];
    return v ? (v.split('-') as [string, string]) : ali;
  }
  return ali;
}

/** One branch on one date: its opening span and Dr. Ali's slots there. Cards and the strip share this rule. */
export function branchDay(h: BranchHours | undefined, rows: ScheduleRow[], branchId: number, date: string): BranchDay {
  return { date, open: openSpan(h, rows, branchId, date), ali: aliSlotsAt(rows, branchId, date).map((s): [string, string] => [s.start, s.end]) };
}

/** "Open now · until 9 PM", "Opens today, 4 PM", "Opens Thursday, 4 PM", "Next open Thu 22 Oct". */
export function branchStatus(h: BranchHours | undefined, rows: ScheduleRow[], branchId: number, today: string, nowMin: number): { open: boolean; text: string } | null {
  if (!h) return null;
  const horizon = h.mode === 'weekly' ? 8 : 180;
  for (let n = 0; n < horizon; n++) {
    const date = addDays(today, n);
    const span = openSpan(h, rows, branchId, date);
    if (!span) continue;
    const [s, e] = span.map(toMin);
    if (n === 0 && nowMin >= e) continue;
    if (n === 0 && nowMin >= s) return { open: true, text: `Open now · until ${clock(span[1])}` };
    const w = whenLabel(date, today);
    if (h.mode === 'visits' && n > 6) return { open: false, text: `Next open ${dateLabel(date)}` };
    return { open: false, text: `Opens ${w}, ${clock(span[0])}` };
  }
  return { open: false, text: h.mode === 'visits' ? 'No dates scheduled yet' : 'Closed' };
}

/** Where Dr. Ali is at this moment, if at a clinic. */
export function aliNow(rows: ScheduleRow[], today: string, nowMin: number): Slot | null {
  return slotsOn(rows, today).slots.find((s) => toMin(s.start) <= nowMin && nowMin < toMin(s.end)) || null;
}

/** Dr. Ali's next time at a branch: here now, later today, or a later date. */
export function aliNext(rows: ScheduleRow[], branchId: number, today: string, nowMin: number, horizon = 60):
  { here: boolean; date: string; start: string; end: string } | null {
  for (let n = 0; n < horizon; n++) {
    const date = addDays(today, n);
    for (const s of aliSlotsAt(rows, branchId, date)) {
      if (n === 0 && nowMin >= toMin(s.end)) continue;
      return { here: n === 0 && nowMin >= toMin(s.start), date, start: s.start, end: s.end };
    }
  }
  return null;
}

/** Calendar cells for a month (Monday first). Blank cells have day 0. */
export function monthCells(year: number, month: number): { day: number; iso: string }[] {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const lead = (weekdayOf(first) + 6) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: { day: number; iso: string }[] = [];
  for (let i = 0; i < lead; i++) cells.push({ day: 0, iso: '' });
  for (let d = 1; d <= days; d++) cells.push({ day: d, iso: `${first.slice(0, 8)}${String(d).padStart(2, '0')}` });
  while (cells.length % 7) cells.push({ day: 0, iso: '' });
  return cells;
}
export function monthTitle(year: number, month: number): string {
  return MONTH_NAMES[month - 1] + ' ' + year;
}
