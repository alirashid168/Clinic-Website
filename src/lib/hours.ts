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
export function visitRuns(rows: ScheduleRow[], branchId: number, today: string, hours?: string): { from: string; to: string; text: string }[] {
  const byDate = new Map<string, ScheduleRow[]>();
  for (const r of rows) {
    if (r.branch_id !== branchId || !r.on_date || r.unavailable || r.on_date < today) continue;
    byDate.set(r.on_date, [...(byDate.get(r.on_date) || []), r]);
  }
  const dates = [...byDate.keys()].sort();
  const runs: { from: string; to: string; times: string[] }[] = [];
  for (const d of dates) {
    const own = byDate.get(d)!.sort((a, b) => a.start_time.localeCompare(b.start_time));
    const t = hours ? range(hours) : range(own[0].start_time.slice(0, 5), own[own.length - 1].end_time.slice(0, 5));
    const last = runs[runs.length - 1];
    if (last && addDays(last.to, 1) === d) { last.to = d; last.times.push(t); } else runs.push({ from: d, to: d, times: [t] });
  }
  return runs.map((r) => {
    const label = r.from === r.to ? dateLabel(r.from) : `${dateLabel(r.from)} – ${dateLabel(r.to)}`;
    const same = r.times.every((x) => x === r.times[0]);
    return { from: r.from, to: r.to, text: same ? `${label}, ${r.times[0]}` : label };
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
