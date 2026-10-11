// "End the day" on the Aaj ki List and the History of Aaj ki List: the order and the counts of a saved day list, and how its
// day and time are written. The database builds the real copy (private.day_list_rows in
// supabase/migrations/20261012000100_day_list_history.sql); the demo data layer builds its copy with orderDayList below.
// Both follow the same rules as listOrder in views/staff/sheet.js.
import { CONFIG } from '../config.js';

const TZ = CONFIG.TIMEZONE || 'Asia/Karachi';

// Waiting at the top, then In treatment, Scheduled, a checkup patient with no status yet, Completed, Cancelled and No show (owner, 11 Oct 2026).
const STATUS_RANK = { waiting: 0, in_treatment: 1, scheduled: 2, '': 3, completed: 4, cancelled: 5, no_show: 6 };
const COUNTED = ['completed', 'waiting', 'in_treatment', 'scheduled', 'cancelled', 'no_show'];
const tokenNumber = (row) => { const t = String(row.token ?? '').trim(); return /^\d+$/.test(t) ? Number(t) : Infinity; };
const byValue = (x, y) => (x === y ? 0 : x < y ? -1 : 1);

/**
 * The rows of one day list ({ kind: 'patient' | 'checkup', status, token, created_at, id, ... }) in list order, each with its
 * serial number n: by status, the patients before the checkup patients, by token (a token that is not a whole number last),
 * then by when the row was added.
 */
export function orderDayList(rows) {
  return [...rows].sort((a, b) => (STATUS_RANK[a.status || ''] ?? 3) - (STATUS_RANK[b.status || ''] ?? 3)
    || Number(a.kind === 'checkup') - Number(b.kind === 'checkup')
    || byValue(tokenNumber(a), tokenNumber(b))
    || byValue(String(a.created_at || ''), String(b.created_at || ''))
    || byValue(String(a.id ?? ''), String(b.id ?? '')))
    .map((row, i) => ({ ...row, n: i + 1 }));
}

/** The counts of a day list, as the database keeps them: every row, each status, the rows with no status yet, the checkup patients. */
export function countDayList(rows) {
  const counts = { total: 0, completed: 0, waiting: 0, in_treatment: 0, scheduled: 0, cancelled: 0, no_show: 0, not_set: 0, checkups: 0 };
  for (const row of rows || []) {
    counts.total += 1;
    if (!row.status) counts.not_set += 1;
    else if (COUNTED.includes(row.status)) counts[row.status] += 1;
    if (row.kind === 'checkup') counts.checkups += 1;
  }
  return counts;
}

// Written out here, not by the browser: some browsers shorten September to "Sept".
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10-12' -> 'Mon 12 Oct 2026' (a calendar date: no time zone can move it). */
export function dayLabel(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DATE = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
/** The clinic's time of a moment: '21:05'. */
export const clinicTime = (ts) => (ts ? CLOCK.format(new Date(ts)) : '');
/** The clinic's calendar date of a moment: '2026-10-12'. */
export const clinicDate = (ts) => (ts ? DATE.format(new Date(ts)) : '');

/** When a day was ended, for a note: '21:05', or '09:10 on Tue 13 Oct 2026' when it was ended on a later day. */
export function endedAt(closing, listDate) {
  const time = clinicTime(closing?.closed_at);
  const on = clinicDate(closing?.closed_at);
  return on && on !== listDate ? `${time} on ${dayLabel(on)}` : time;
}
