// GENERATED from src/lib by scripts/build-lib.sh. Edit the .ts file, not this one.
// NOTE (2026-10-07 audit fixes): edited directly in this mirror because src/lib is not part of it.
// Port these changes back to src/lib/hours.ts before the next build, or they will be overwritten.
//
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
export const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_BY_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const LONG = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
/** Short weekday names by JS weekday index (0 = Sunday). */
export const SHORT_DOW = DAY_BY_INDEX.map((k) => SHORT[k]);
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// ---------------------------------------------------------------- dates
export function addDays(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
export function weekdayOf(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }
export function dayKeyOf(iso) { return DAY_BY_INDEX[weekdayOf(iso)]; }
/** "Thu 8 Oct" */
export function dateLabel(iso) {
    const [, m, d] = iso.split('-').map(Number);
    return `${SHORT[dayKeyOf(iso)]} ${d} ${MONTHS[m - 1]}`;
}
/** "Thursday 8 October" */
export function fullDateLabel(iso) {
    const [, m, d] = iso.split('-').map(Number);
    return `${LONG[dayKeyOf(iso)]} ${d} ${MONTH_NAMES[m - 1]}`;
}
// ---------------------------------------------------------------- times
/** "16:00" -> "4 PM", "12:00" -> "12 PM", "14:30" -> "2:30 PM" */
export function clock(t) {
    const [hh, mm] = t.slice(0, 5).split(':').map(Number);
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${hh < 12 ? 'AM' : 'PM'}`;
}
/** "12:00-21:00" or ("12:00:00","21:00:00") -> "12 PM – 9 PM" */
export function range(a, b) {
    const [s, e] = b === undefined ? a.split('-') : [a, b];
    return `${clock(s)} – ${clock(e)}`;
}
// ---------------------------------------------------------------- settings
/** Reads the per-branch hours from the clinic_timings setting (object or JSON text). */
export function branchHoursFrom(setting) {
    let t = setting;
    if (typeof t === 'string') {
        try {
            t = JSON.parse(t);
        }
        catch {
            t = {};
        }
    }
    return (t && typeof t === 'object' && t.branches && typeof t.branches === 'object') ? t.branches : {};
}
// ---------------------------------------------------------------- Dr. Ali's calendar
/** Where Dr. Ali is on a date. Dated rows replace the normal week for that day. */
export function slotsOn(rows, date) {
    const dated = rows.filter((r) => r.on_date === date);
    const datedOpen = dated.filter((r) => !r.unavailable);
    const toSlot = (r) => ({ branch_id: r.branch_id, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) });
    const sort = (s) => s.sort((a, b) => a.start.localeCompare(b.start));
    if (datedOpen.length)
        return { slots: sort(datedOpen.map(toSlot)), dated: true };
    const off = new Set(dated.filter((r) => r.unavailable).map((r) => r.branch_id));
    const wd = weekdayOf(date);
    const weekly = rows.filter((r) => r.weekday === wd && !r.on_date && !r.unavailable && !off.has(r.branch_id));
    return { slots: sort(weekly.map(toSlot)), dated: false };
}
/** Dr. Ali's slots at one branch on a date (from slotsOn, so they match the strip). */
export function aliSlotsAt(rows, branchId, date) {
    return slotsOn(rows, date).slots.filter((s) => s.branch_id === branchId);
}
// ---------------------------------------------------------------- branch cards
/** Upcoming visit dates of a branch (days Dr. Ali is there), merged into runs of consecutive days. */
export function visitRuns(rows, branchId, today, horizon = 180) {
    const runs = [];
    for (let n = 0; n < horizon; n++) {
        const d = addDays(today, n);
        const own = aliSlotsAt(rows, branchId, d);
        if (!own.length)
            continue;
        const t = own.map((s) => range(s.start, s.end)).join(', ');
        const last = runs[runs.length - 1];
        if (last && addDays(last.to, 1) === d) {
            last.to = d;
            last.times.push(t);
            last.dates.push(d);
        }
        else
            runs.push({ from: d, to: d, times: [t], dates: [d] });
    }
    return runs.map((r) => {
        const label = r.from === r.to ? dateLabel(r.from) : `${dateLabel(r.from)} – ${dateLabel(r.to)}`;
        const same = r.times.every((x) => x === r.times[0]);
        const time = same ? r.times[0] : r.dates.map((d, i) => `${SHORT[dayKeyOf(d)]} ${r.times[i]}`).join(' · ');
        return { from: r.from, to: r.to, text: `${label}, ${time}`, label, time };
    });
}
// ---------------------------------------------------------------- live status
// Minutes since midnight: "16:30" -> 990.
export function toMin(t) {
    const [h, m] = t.slice(0, 5).split(':').map(Number);
    return h * 60 + (m || 0);
}
/** "today", "tomorrow", "Thursday", or "Thu 15 Oct" further out. */
export function whenLabel(date, today) {
    if (date === today)
        return 'today';
    if (date === addDays(today, 1))
        return 'tomorrow';
    for (let n = 2; n < 7; n++)
        if (date === addDays(today, n))
            return LONG[dayKeyOf(date)];
    return dateLabel(date);
}
/**
 * The branch's opening span on a date, as [start, end] times, or null when closed.
 * Weekly branches: their fixed hours for that weekday (or, on a normally closed day,
 * the hours Dr. Ali is booked there). Visit branches: Dr. Ali's slots there that day.
 */
export function openSpan(h, rows, branchId, date) {
    if (!h)
        return null;
    const own = aliSlotsAt(rows, branchId, date);
    const ali = own.length ? [own[0].start, own.reduce((e, s) => (s.end > e ? s.end : e), own[0].end)] : null;
    if (h.mode === 'weekly') {
        const v = h.days?.[dayKeyOf(date)];
        return v ? v.split('-') : ali;
    }
    return ali;
}
/** One branch on one date: its opening span and Dr. Ali's slots there. Cards and the strip share this rule. */
export function branchDay(h, rows, branchId, date) {
    return { date, open: openSpan(h, rows, branchId, date), ali: aliSlotsAt(rows, branchId, date).map((s) => [s.start, s.end]) };
}
/** "Open now · until 9 PM", "Opens today, 4 PM", "Opens Thursday, 4 PM", "Next open Thu 22 Oct". */
export function branchStatus(h, rows, branchId, today, nowMin) {
    if (!h)
        return null;
    const horizon = h.mode === 'weekly' ? 8 : 180;
    for (let n = 0; n < horizon; n++) {
        const date = addDays(today, n);
        const span = openSpan(h, rows, branchId, date);
        if (!span)
            continue;
        const [s, e] = span.map(toMin);
        if (n === 0 && nowMin >= e)
            continue;
        if (n === 0 && nowMin >= s)
            return { open: true, text: `Open now · until ${clock(span[1])}` };
        const w = whenLabel(date, today);
        if (h.mode === 'visits' && n > 6)
            return { open: false, text: `Next open ${dateLabel(date)}` };
        return { open: false, text: `Opens ${w}, ${clock(span[0])}` };
    }
    return { open: false, text: h.mode === 'visits' ? 'No dates scheduled yet' : 'Closed' };
}
/** Where Dr. Ali is at this moment, if at a clinic. */
export function aliNow(rows, today, nowMin) {
    return slotsOn(rows, today).slots.find((s) => toMin(s.start) <= nowMin && nowMin < toMin(s.end)) || null;
}
/** Dr. Ali's next time at a branch: here now, later today, or a later date. */
export function aliNext(rows, branchId, today, nowMin, horizon = 60) {
    for (let n = 0; n < horizon; n++) {
        const date = addDays(today, n);
        for (const s of aliSlotsAt(rows, branchId, date)) {
            if (n === 0 && nowMin >= toMin(s.end))
                continue;
            return { here: n === 0 && nowMin >= toMin(s.start), date, start: s.start, end: s.end };
        }
    }
    return null;
}
/** Calendar cells for a month (Monday first). Blank cells have day 0. */
export function monthCells(year, month) {
    const first = `${year}-${String(month).padStart(2, '0')}-01`;
    const lead = (weekdayOf(first) + 6) % 7;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < lead; i++)
        cells.push({ day: 0, iso: '' });
    for (let d = 1; d <= days; d++)
        cells.push({ day: d, iso: `${first.slice(0, 8)}${String(d).padStart(2, '0')}` });
    while (cells.length % 7)
        cells.push({ day: 0, iso: '' });
    return cells;
}
export function monthTitle(year, month) {
    return MONTH_NAMES[month - 1] + ' ' + year;
}
