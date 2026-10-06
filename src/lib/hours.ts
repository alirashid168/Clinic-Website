// Branch opening hours and Dr. Ali's dated calendar.
//
// Two separate things, on purpose:
//  - Branch hours: when a clinic is open. Karachi branches open on fixed
//    weekdays whether or not Dr. Ali is there. Lahore and Islamabad open ONLY
//    on Dr. Ali's visit dates, so their cards list dates, never weekdays.
//  - Dr. Ali's calendar: where he personally is. A normal week follows the
//    recurring weekday rows; a date with its own (on_date) rows, such as a
//    Lahore or Islamabad trip, replaces the normal week for that day.

export type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
export const DAY_ORDER: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_BY_INDEX: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SHORT: Record<DayKey, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Per-branch hours, stored in app_settings.clinic_timings.branches. */
export type BranchHours =
  | { mode: 'weekly'; days: Partial<Record<DayKey, string>> }       // "12:00-21:00"
  | { mode: 'visits'; hours?: string };                              // open only on visit dates

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

// ---------------------------------------------------------------- branch cards
/** Weekday lines such as "Mon – Thu: 12 PM – 9 PM", "Sun: Closed". Consecutive equal days are merged. */
export function weeklyLines(days: Partial<Record<DayKey, string>>): string[] {
  const groups: { from: DayKey; to: DayKey; v: string }[] = [];
  for (const k of DAY_ORDER) {
    const v = days[k] || '';
    const last = groups[groups.length - 1];
    if (last && last.v === v) last.to = k; else groups.push({ from: k, to: k, v });
  }
  return groups.map((g) => {
    const label = g.from === g.to ? SHORT[g.from] : `${SHORT[g.from]} – ${SHORT[g.to]}`;
    return `${label}: ${g.v ? range(g.v) : 'Closed'}`;
  });
}

/** Upcoming visit dates of a branch, merged into runs of consecutive days. */
export function visitRuns(rows: ScheduleRow[], branchId: number, today: string, hours?: string): { from: string; to: string; text: string; label: string; time: string }[] {
  const byDate = new Map<string, ScheduleRow[]>();
  for (const r of rows) {
    if (r.branch_id !== branchId || !r.on_date || r.unavailable || r.on_date < today) continue;
    byDate.set(r.on_date, [...(byDate.get(r.on_date) || []), r]);
  }
  const dates = [...byDate.keys()].sort();
  const runs: { from: string; to: string; times: string[]; dates: string[] }[] = [];
  for (const d of dates) {
    const own = byDate.get(d)!.sort((a, b) => a.start_time.localeCompare(b.start_time));
    const t = hours ? range(hours) : range(own[0].start_time.slice(0, 5), own[own.length - 1].end_time.slice(0, 5));
    const last = runs[runs.length - 1];
    if (last && addDays(last.to, 1) === d) { last.to = d; last.times.push(t); last.dates.push(d); } else runs.push({ from: d, to: d, times: [t], dates: [d] });
  }
  return runs.map((r) => {
    const label = r.from === r.to ? dateLabel(r.from) : `${dateLabel(r.from)} – ${dateLabel(r.to)}`;
    const same = r.times.every((x) => x === r.times[0]);
    const time = same ? r.times[0] : r.dates.map((d, i) => `${SHORT[dayKeyOf(d)]} ${r.times[i]}`).join(' · ');
    return { from: r.from, to: r.to, text: same ? `${label}, ${r.times[0]}` : label, label, time };
  });
}

/** Is the branch open on this date? null when hours are unknown. */
export function openOn(h: BranchHours | undefined, rows: ScheduleRow[], branchId: number, date: string): boolean | null {
  if (!h) return null;
  if (h.mode === 'weekly') return !!h.days[dayKeyOf(date)];
  return rows.some((r) => r.branch_id === branchId && r.on_date === date && !r.unavailable);
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

// ---------------------------------------------------------------- live status
// Minutes since midnight: "16:30" -> 990.
export function toMin(t: string): number {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return h * 60 + (m || 0);
}
const LONG: Record<DayKey, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

/** "today", "tomorrow", "Thursday", or "Thu 15 Oct" further out. */
export function whenLabel(date: string, today: string): string {
  if (date === today) return 'today';
  if (date === addDays(today, 1)) return 'tomorrow';
  for (let n = 2; n < 7; n++) if (date === addDays(today, n)) return LONG[dayKeyOf(date)];
  return dateLabel(date);
}

/** The branch's opening span on a date, as [start, end] times, or null when closed. */
export function openSpan(h: BranchHours | undefined, rows: ScheduleRow[], branchId: number, date: string): [string, string] | null {
  if (!h) return null;
  if (h.mode === 'weekly') {
    const v = h.days[dayKeyOf(date)];
    return v ? (v.split('-') as [string, string]) : null;
  }
  const own = rows.filter((r) => r.branch_id === branchId && r.on_date === date && !r.unavailable)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  if (!own.length) return null;
  if (h.hours) return h.hours.split('-') as [string, string];
  return [own[0].start_time.slice(0, 5), own[own.length - 1].end_time.slice(0, 5)];
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
    for (const s of slotsOn(rows, date).slots) {
      if (s.branch_id !== branchId) continue;
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
  return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][month - 1] + ' ' + year;
}
