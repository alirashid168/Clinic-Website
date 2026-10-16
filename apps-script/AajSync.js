/**
 * AajSync.js: keeps the Google Sheet "Aj ki List" and the website's Aaj ki List the same, both ways,
 * and archives each day's list at night.
 *
 * WHAT IT IS
 *   One Google Apps Script, pasted into the sheet (Extensions -> Apps Script). It is NOT part of the website.
 *   Every minute (08:00 to 23:59 Pakistan time) it sends what staff typed in the five branch tabs to the website,
 *   and writes what the website changed back into the tabs. After midnight it copies each tab's rows of the day into the
 *   spreadsheet "Aj ki List - Archive", once. The rows STAY on the tab (owner, 17 Oct 2026: "please dont delete the aaj ki list
 *   google sheet entries daily, one of my assistant does it after recording the treatments in healthwire"): a row of an earlier
 *   day is a "kept" row, shown calmly, never sent again, and deleting it changes nothing on the website. A row without an Mr# is a
 *   checkup patient (no patient file) when its Treatment says checkup (any other Treatment: "Needs attention: add the Mr#"); at night
 *   the checkup patients are also added to the "Checkup karwaliya" sheet.
 *   A row of today deleted in the sheet is removed from the website too (the website refuses when something real hangs on it); a
 *   patient who is done (Completed, Treatment, Cancelled) only goes off the sheet and stays on the website as it is. Every call says
 *   so to the website (keep_rows); a website that does not know it yet answers as before.
 *   The branch tabs are Google Sheets tables: the Advanced Sheets service ("Sheets", apps-script/appsscript.json) lets Set up widen each
 *   table over the hidden columns, so a sort moves whole rows. Without it the sync still works (the log says what to do by hand).
 *   Setup, step by step: docs/AAJ-SYNC-SETUP.md
 *   Rules and the website's side of the conversation: .omc/handoffs/aaj-sync-design.md (sections 2, 6 and "Changes during build").
 *
 * WHAT THE SECRET CAN DO
 *   Anyone who can edit this sheet can open this script and use the sync secret that Set up stores for Dr. Ali. That is why
 *   the website only lets the secret touch today's lists (and yesterday's until 03:00) of the five branches. Keep edit access
 *   for staff you trust, and ask for a new secret when somebody leaves.
 *
 * HOW IT IS TESTED
 *   `node tests/aaj-sync-script.test.mjs` loads this very file into a fake Google (tests/apps-script-mock.mjs)
 *   and talks to a fake website (tests/aaj-sync-fake-server.mjs). `npm test` runs it.
 *
 * RULES OF THIS FILE
 *   Plain script: no import/export/require, no optional chaining, no nullish operator, no classes.
 *   Every top-level name is a `function` or a `var` and starts with `aaj` or `AAJ` (so it cannot clash with
 *   the old export script if that lives in the same project).
 *   Part 1 reads a row (a copy of web/js/lib/aaj.js; tests/aaj-sync-script.test.mjs proves they agree).
 *   Part 2 is pure logic (no Google calls). Part 3 is the thin layer that talks to Google and the website.
 */

var AAJ = {
  URL: 'https://xbgcthpxwrjntfujejet.supabase.co',
  KEY: 'sb_publishable_TsYhnIoJNDkq-al3_EXqRQ_b_BjNOR1',   // public key, same value as web/js/config.js
  TZ: 'Asia/Karachi',
  TABS: [
    { tab: 'Gulshan KHI', branch: 'GUL' },
    { tab: 'North Nazimabad', branch: 'NN' },
    { tab: 'DHA KHI', branch: 'DHA' },
    { tab: 'Gulberg Lhr', branch: 'LHR' },
    { tab: 'Islamabad', branch: 'ISB' }
  ],   // exact tab names; other tabs ("Website - ...", "Copy of DHA KHI", ...) are never touched
  ARCHIVE_NAME: 'Aj ki List - Archive',
  LOG_TAB: 'Aaj Sync log',
  H_STATUS: 'Website', H_KEY: 'Sync key', H_BASE: 'Sync base', H_EDITED: 'Sync edited',
  SETTLE_MS: 60000,            // a new row waits this long after its last edit before it is sent
  BUSY_MS: 60000,              // a row edited this recently is never overwritten by the script
  BATCH: 25,                   // rows per call (the website's database allows 3 seconds per call)
  MIN_BATCH: 5,
  RETRY_UNLINKED_MS: 300000,   // a row the website could not place is sent again after this long
  SOFT_DEADLINE_MS: 240000,    // no new call after 4 minutes (Google stops a run at 6)
  ACTIVE_FROM: '08:00', ARCHIVE_FROM: '00:05', ARCHIVE_WAIT_UNTIL: '00:30', GRACE_UNTIL: '03:00', FINAL_RETRY_UNTIL: '02:30',
  // Google counts more than the script can (each run's start-up too): stop well before the free account's 90 minutes, so the heading says
  // "paused" instead of going stale. Raise them once a real busy day has been measured in Aaj Sync > Status.
  RUNTIME_SLOW_MS: 3000000,    // 50 min of run time today: work only every 5th minute
  RUNTIME_STOP_MS: 3900000,    // 65 min: stop for today
  // Rows of earlier days stay on the tab until staff delete them, so the limits count TODAY's rows: 400 is also what the website takes in
  // one call's list of present rows. Kept rows cost little (they are read, not sent), but a tab is only read down to MAX_READ_ROWS: a list
  // that reaches within LIST_ROOM rows of it is not synced (a row added below the read rows would be added again every minute).
  MAX_ROWS: 400,               // more of today's rows than this on one tab: that tab is not synced
  MAX_READ_ROWS: 3000,         // rows below this are never read (stray cells far down a tab are ignored)
  LIST_ROOM: 200,
  HEADER_REFRESH_MS: 300000,
  EMPTY_TICKS: 3,
  LOG_KEEP: 2000,
  FULL_EVERY_MS: 300000,       // a quiet minute only asks the website "anything new?"; the tabs are read in full at least this often
  FILTER_EVERY_MS: 600000,     // a tab read in full is checked for its header filter (aajEnsureFilter_) at most this often
  BUSY_SHOW: 3,                // this many "website busy" answers in a row are shown in the tab headings
  // The nightly list of checkup patients (rows with no Mr# that say checkup): the owner's sheet "Checkup karwaliya". Script Properties
  // CHECKUP_SHEET_ID and CHECKUP_TAB (Project Settings) override these. Existing rows there are never edited or deleted.
  CHECKUP_SHEET_ID: '1wdRT8RqHLF-x2X6AVqLnvGkYrFWZEB3BGbx1CowMe_Y',
  CHECKUP_TAB: 'Aj ki List checkups',
  CHECKUP_HEADERS: ['Month', 'Patient Name', 'Phone', 'City', 'Clinic', 'Doctor', 'Treatment / Checkup For', 'Est. Fee (Rs)', 'Status', 'Notes', 'Source Tab'],
  CHECKUP_ID_HEADER: 'Sync id',
  CHECKUP_QUEUE_MAX: 300,
  // how the owner's consolidated checkup list names the clinics and cities
  BRANCH_INFO: {
    GUL: { clinic: 'RJ Mall', city: 'Karachi' }, NN: { clinic: 'North Nazimabad', city: 'Karachi' }, DHA: { clinic: 'DHA Karachi', city: 'Karachi' },
    LHR: { clinic: 'Lahore Gulberg', city: 'Lahore' }, ISB: { clinic: 'Islamabad', city: 'Islamabad' }
  }
};

var AAJ_FIELDS = ['mr', 'name', 'phone', 'month', 'treatment', 'token', 'status', 'group', 'doctors', 'details'];   // two-way
var AAJ_SHEET_ONLY = ['pp', 'healthwire', 'reminder'];                                                               // sheet -> website only
var AAJ_ALL_FIELDS = AAJ_FIELDS.concat(AAJ_SHEET_ONLY);
var AAJ_LABELS = {
  mr: 'Mr#', name: 'Patient name', phone: 'Contact no', month: 'Month', treatment: 'Treatment', token: 'Token', status: 'Status',
  group: 'Group', doctors: "Doctor's name", details: 'Treatment details', pp: 'P.P', healthwire: 'Healthwire', reminder: 'Reminder'
};
var AAJ_KEY_RE = /^(S-[0-9a-f]{12}|W-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
var AAJ_OK_OUTCOMES = { created: true, linked: true, updated: true, unchanged: true };

// =====================================================================================================
// PART 1. Reading a row of the sheet (copy of web/js/lib/aaj.js and the helpers it uses)
// =====================================================================================================

var AAJ_ALIASES = {
  date: ['date', 'day', 'visit date'],
  mr: ['mr #', 'mr#', 'mr', 'mr no', 'mr no.', 'mr number', 'mrn', 'mr num'],
  name: ['patient name', 'name', 'patient', 'patients name', "patient's name"],
  month: ['month', 'months', 'monthly', 'braces month', 'month no'],
  treatment: ['treatment', 'treatments', 'procedure', 'work'],
  token: ['token no', 'token #', 'token', 'token number', 'token no.'],
  status: ['waiting', 'status', 'waiting / status', 'waiting status'],
  group: ['group', 'column 13', 'doctor group', 'grp'],
  doctors: ["doctor's name", 'doctors name', 'doctor name', 'doctors', 'doctor', 'dr', 'dr name', 'dr. name', 'doctor / assistant'],
  details: ['treatment details', 'details', 'treatment detail', 'work done', 'detail'],
  pp: ['p.p', 'pp', 'p p', 'pending payment', 'p.p.', 'pending'],
  healthwire: ['healthwire', 'health wire', 'hw'],
  phone: ['contact no', 'contact', 'phone', 'mobile', 'contact no.', 'contact number', 'phone no', 'cell', 'number'],
  reminder: ['reminder status', 'reminder', 'reminders', 'follow up', 'followup']
};

function aajNorm(h) {
  return String(h === null || h === undefined ? '' : h).toLowerCase().replace(/^tt\s+/, '').replace(/[_\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Header cells -> { field: columnIndex (0-based) }. Exact alias match first, then "starts with". */
function aajDetectColumns(headers) {
  var H = [], i, k;
  for (i = 0; i < headers.length; i++) H.push(aajNorm(headers[i]));
  var out = {};
  var taken = {};
  var fields = Object.keys(AAJ_ALIASES);
  for (var fi = 0; fi < fields.length; fi++) {
    var field = fields[fi], names = AAJ_ALIASES[field];
    var found = -1;
    for (k = 0; k < H.length; k++) {
      if (!taken[k] && names.indexOf(H[k]) >= 0) { found = k; break; }
    }
    if (found < 0) {
      for (k = 0; k < H.length; k++) {
        if (taken[k] || !H[k]) continue;
        var hit = false;
        for (var ni = 0; ni < names.length; ni++) {
          if (H[k].indexOf(names[ni] + ' ') === 0 || H[k].indexOf(names[ni] + '/') === 0) { hit = true; break; }
        }
        if (hit) { found = k; break; }
      }
    }
    if (found >= 0) { out[field] = found; taken[found] = true; }
  }
  return out;
}

function aajIsHeaderRow(cells) {
  var m = aajDetectColumns(cells || []);
  if (m.name === undefined) return false;
  var n = 0, fs = ['treatment', 'doctors', 'token', 'mr', 'month'];
  for (var i = 0; i < fs.length; i++) if (m[fs[i]] !== undefined) n++;
  return n >= 2;
}

function aajText(c) {
  return c === null || c === undefined ? '' : (c instanceof Date ? '' : String(c).trim());
}

var AAJ_SUFFIXES = [
  [/\s*[-(]?\s*\b(lhr|lahore|gulberg)\b\.?\s*\)?$/i, 'LHR'],
  [/\s*[-(]?\s*\b(n\.\s*n\.?|nn|n\.?\s*nazimabad|north\s+nazimabad)\s*\)?$/i, 'NN'],
  [/\s*[-(]?\s*\b(isb|isl|islamabad)\b\.?\s*\)?$/i, 'ISB'],
  [/\s*[-(]?\s*\b(dha)\b\.?\s*\)?$/i, 'DHA'],
  [/\s*[-(]?\s*\b(gul|gulshan|rj\s*mall)\b\.?\s*\)?$/i, 'GUL']
];

/** "sana lhr" -> { name: 'Sana', branch: 'LHR' } (legacy.js cleanLegacyName) */
function aajCleanLegacyName(raw) {
  var name = String(raw).replace(/\s+/g, ' ').trim();
  var branch = null;
  for (var i = 0; i < AAJ_SUFFIXES.length; i++) {
    var pattern = AAJ_SUFFIXES[i][0];
    if (pattern.test(name)) {
      var stripped = name.replace(pattern, '').trim();
      if (stripped.length >= 2) { name = stripped; branch = AAJ_SUFFIXES[i][1]; }
      break;
    }
  }
  var words = name.split(' ');
  for (var w = 0; w < words.length; w++) {
    var x = words[w];
    if ((x === x.toLowerCase() || x === x.toUpperCase()) && /^[a-z]/i.test(x)) words[w] = x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();
  }
  return { name: words.join(' '), branch: branch };
}

/** "Dr. Ali Rashid, Assistant A, Dr. B" -> ['Dr. Ali Rashid', 'Assistant A', 'Dr. B'] (legacy.js splitPeople) */
function aajSplitPeople(cell) {
  var parts = String(cell).split(/,|\/|&|\band\b/i), out = [];
  for (var i = 0; i < parts.length; i++) { var s = parts[i].trim(); if (s) out.push(s); }
  return out;
}

/** "4", "04 Photo", "13 Photo", "Monthly" (protocol.js parseMonthCell) */
function aajParseMonthCell(cell) {
  if (cell === null || cell === undefined) return { month: null, photoMarked: false };
  var text = String(cell).trim();
  var match = text.match(/^(\d{1,2})\b/);
  return { month: match ? Number(match[1]) : null, photoMarked: /photo/i.test(text) };
}

/** healthwire.js phoneOf: digits only, a missing leading 0 put back; null when fewer than 7 digits */
function aajPhoneOf(p) {
  var d = String(p === null || p === undefined ? '' : p).replace(/\D/g, '');
  if (/^\d+e\+\d+$/i.test(String(p))) d = String(Number(p)).replace(/\D/g, '');
  if (d.length === 10 && d.charAt(0) === '3') d = '0' + d;
  if (d.length === 12 && d.indexOf('92') === 0) d = '0' + d.slice(2);
  return d.length >= 7 ? d : null;
}

/** The history import's reading of a status cell (anything that is not cancelled / no-show is "completed"). */
function aajHistoryStatus(raw) {
  var s = String(raw || '').toLowerCase();
  if (/cancel/.test(s)) return 'cancelled';
  if (/no\s*show|not\s*came|didn|absent|left|went\s*back|not\s*come/.test(s)) return 'no_show';
  return 'completed';
}

/** A Contact cell with two numbers ("0300 1111111 / 0321 2222222") -> the first number. */
function aajFirstPhone(cell) {
  var parts = String(cell === null || cell === undefined ? '' : cell).split(/[,;\/]|\s{2,}|\bor\b/i);
  for (var i = 0; i < parts.length; i++) {
    var t = parts[i].trim();
    if (t) return aajPhoneOf(t);
  }
  return null;
}

/** Token cell: only a whole number 1..999 is a token ("Kit 80k", "1 pfm", "Dr Verda" are not). */
function aajTokenOf(text) {
  var m = String(text === null || text === undefined ? '' : text).match(/^\s*(\d{1,3})(?:\.0+)?\s*$/);
  if (!m) return null;
  var n = Number(m[1]);
  return n >= 1 && n <= 999 ? n : null;
}

/** "Group 3" -> '3' (a string, like web/js/lib/aaj.js); "Group 4" -> null; "Group 1, Group 2" -> '1'. */
function aajGroupOf(text) {
  var m = String(text === null || text === undefined ? '' : text).match(/(?:^|[^0-9])([1-3])(?![0-9])/);
  return m ? m[1] : null;
}

/** The live list's status words (the exact inverse of what the website writes). Empty or unknown -> null. */
function aajLiveStatus(raw) {
  var s = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  if (/cancel/.test(s)) return 'cancelled';
  if (/no\s*-?\s*show|not\s*came|not\s*come|didn|absent|\bleft\b|went\s*back/.test(s)) return 'no_show';
  if (/complet|\bdone\b|finish/.test(s)) return 'completed';
  if (/treat|chair|progress|start/.test(s)) return 'in_treatment';
  if (/wait|arriv|present|\bcame\b|\bhere\b/.test(s)) return 'waiting';
  if (/sched|appoint|book|coming|later/.test(s)) return 'scheduled';
  return null;
}

/** Mr# cell -> { mr, isNew }. "NEW" asks for a new patient; "98 51" or "abc" is not a Mr# (mr null, isNew false). A stray dot or space after it ("8602.") is ignored. */
function aajMrOf(text) {
  var s = String(text === null || text === undefined ? '' : text).trim().replace(/\.0$/, '').replace(/[.\s]+$/, '');
  if (/^new$/i.test(s)) return { mr: null, isNew: true };
  if (/^[\w-]+$/.test(s) && /\d/.test(s)) return { mr: s, isNew: false };
  return { mr: null, isNew: false };
}

/** lower case, letters and digits only, single spaces (the same rule as private.aaj_norm_name in the database) */
function aajNormName(t) {
  return String(t === null || t === undefined ? '' : t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
}

var AAJ_NAME_STOP = { m: 1, mr: 1, mrs: 1, ms: 1, miss: 1, dr: 1, md: 1, muhammad: 1, mohammad: 1, muhammed: 1, mohammed: 1, mohd: 1,
  syed: 1, syeda: 1, sayed: 1, hafiz: 1, haji: 1, baby: 1, master: 1, kid: 1 };

/** First real name: "M Umer" and "Muhammad Umer" both give "umer" (private.aaj_given_name). */
function aajGivenName(t) {
  var norm = aajNormName(t);
  var tokens = norm ? norm.split(' ') : [];
  var i = 0;
  while (i < tokens.length && AAJ_NAME_STOP[tokens[i]] === 1) i++;
  if (i < tokens.length) return tokens[i];
  return tokens.length ? tokens[tokens.length - 1] : '';
}

/** Doctor names are compared without "Dr", dots and case (legacy.js normaliseDoctorKey). */
function aajDoctorKey(raw) {
  return String(raw === null || raw === undefined ? '' : raw).toLowerCase().replace(/\bdr\.?\s*/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

/** Lahore and Islamabad sometimes type a doctor ("Dr Verda") in the Token cell: that name is a doctor, not a token and not lost. */
function aajTokenDoctor(text) {
  var t = String(text === null || text === undefined ? '' : text).trim();
  if (!t || aajTokenOf(t) !== null) return '';
  return /^dr\.?\s+[a-z]/i.test(t) ? t : '';
}

/** One row of cells + the detected columns -> what the row says (everything web/js/lib/aaj.js readTab reads, plus the live fields). */
function aajReadRow(r, cols) {
  var get = function (f) { return cols[f] === undefined ? '' : aajText(r[cols[f]]); };
  var rawName = get('name');
  var cl = aajCleanLegacyName(rawName);
  var mr = aajMrOf(get('mr'));
  var pm = aajParseMonthCell(get('month'));
  return {
    mr: mr.mr, isNew: mr.isNew, name: cl.name, legacyName: rawName.trim(), suffixBranch: cl.branch,
    phone: aajFirstPhone(get('phone')), month: pm.month && pm.month <= 60 ? pm.month : null, photoMarked: pm.photoMarked,
    treatment: get('treatment') || null, token: aajTokenOf(get('token')), status: aajHistoryStatus(get('status')),
    liveStatus: aajLiveStatus(get('status')), group: aajGroupOf(get('group')), people: aajSplitPeople(get('doctors')),
    details: get('details') || null, reminder: get('reminder') || null, pp: get('pp') || null, healthwire: get('healthwire') || null
  };
}

// =====================================================================================================
// PART 2. The sync logic (pure: no Google calls, tested directly)
// =====================================================================================================

function aajCollapse(s) {
  var t = String(s === null || s === undefined ? '' : s);
  if (!/[^\S ]|  |^ | $/.test(t)) return t;       // nothing to tidy (no tab, line break, double or outer space): the usual case
  return t.replace(/\s+/g, ' ').replace(/^ | $/g, '');
}

/** The text of a cell as compared between ticks: spaces collapsed; ".0" and phone formats ignored. */
function aajFieldKey(f, text) {
  var s = aajCollapse(text);
  if (f === 'mr' || f === 'token' || f === 'month') s = s.replace(/\.0$/, '');
  if (f === 'mr') s = s.replace(/[.\s]+$/, '');
  if (f === 'phone') s = aajFirstPhone(s) || s;
  return s;
}

function aajParseBase(text) {
  if (!text) return null;
  try {
    var b = JSON.parse(text);
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch (e) { return null; }
}

/** Place of the helper columns in row 1 (0-based, -1 when missing). The Website column is the first header starting with "Website". */
function aajFindHelpers(header) {
  var hc = { status: -1, key: -1, base: -1, edited: -1 };
  for (var i = 0; i < header.length; i++) {
    var t = aajText(header[i]);
    if (hc.status < 0 && t.toLowerCase().indexOf('website') === 0) hc.status = i;
    else if (hc.key < 0 && t === AAJ.H_KEY) hc.key = i;
    else if (hc.base < 0 && t === AAJ.H_BASE) hc.base = i;
    else if (hc.edited < 0 && t === AAJ.H_EDITED) hc.edited = i;
  }
  return hc;
}

/** Day arithmetic on 'yyyy-MM-dd' strings (no time zones involved). */
function aajDateAdd(iso, days) {
  var p = String(iso).split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + days));
  var m = d.getUTCMonth() + 1, dd = d.getUTCDate();
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd;
}

/** What Sheets would do to a string: whole numbers without a leading 0 become numbers; everything else is stored as text. */
function aajCellValue(text) {
  var s = String(text === null || text === undefined ? '' : text);
  if (s === '') return '';
  if (/^[1-9][0-9]{0,5}$/.test(s)) return Number(s);
  return "'" + s;
}

function aajHash32(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  var x = (h >>> 0).toString(16);
  while (x.length < 8) x = '0' + x;
  return x;
}

function aajCopyMap(o) {
  var out = {};
  if (o) for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  return out;
}

var AAJ_ID_FIELDS = ['mr', 'name', 'phone'];      // the cells that say who a row is

function aajLev(a, b) {
  var prev = [], cur, i, j;
  for (j = 0; j <= b.length; j++) prev.push(j);
  for (i = 1; i <= a.length; i++) {
    cur = [i];
    for (j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Could name a be the same person as name b, on the same phone? The same first name or a slip of it (the database's rule in
 * private.aaj_name_close: two letters for six or more, one for five, none for shorter); the surname may be corrected. A family shares one
 * phone: Amna and Zainab, or Sana and Sara, are two people.
 */
function aajNameFits(a, b) {
  var ga = aajGivenName(a), gb = aajGivenName(b);
  if (!ga || !gb) return false;
  if (ga === gb) return true;
  var m = Math.min(ga.length, gb.length);
  return aajLev(ga, gb) <= (m >= 6 ? 2 : m === 5 ? 1 : 0);
}

/** Is the name typed in a linked row the very name the row had (base.s) or the website has (base.w), as typed or as compared (aajNormName)? */
function aajSameName(nameText, s, w) {
  var key = aajFieldKey('name', nameText), now = aajNormName(nameText), names = [s.name || '', w.name || ''];
  for (var i = 0; i < names.length; i++) {
    if (key !== '' && key === aajFieldKey('name', names[i])) return true;
    if (now !== '' && now === aajNormName(names[i])) return true;
  }
  return false;
}

/**
 * Is the person typed in a linked row still the person the row had? s = the row's cells at the last sync (base.s), w = the website's row then
 * (base.w). The same name (also an Urdu name nobody can read, left as it was), or the same phone with a name that fits (aajNameFits).
 */
function aajSamePerson(nameText, phoneNow, s, w) {
  var names = [s.name || '', w.name || ''], i;
  if (aajSameName(nameText, s, w)) return true;
  if (!phoneNow || (phoneNow !== aajPhoneOf(s.phone || '') && phoneNow !== aajPhoneOf(w.phone || ''))) return false;
  for (i = 0; i < names.length; i++) if (names[i] && aajNameFits(nameText, names[i])) return true;
  return false;
}

/** The keys under which a row's exact name and phone are found by aajMovedAway: the name as typed and as compared (aajNormName), each with the phone. */
function aajExactKeys(nameText, phone) {
  var out = [], k = aajFieldKey('name', nameText), n = aajNormName(nameText);
  if (!phone) return out;
  if (k !== '') out.push('k:' + k + '|' + phone);
  if (n !== '') out.push('n:' + n + '|' + phone);
  return out;
}

/**
 * A row that aajSamePerson kept only by its phone and a FITTING first name (not the same name) has moved away from its person when another
 * row of the tab carries that person's exact name (base.s or base.w) with the same phone: a sort of the visible columns, or a cut and paste,
 * moved family members who share one phone and whose first names fit (Ali Raza / Ali Hamza, Hassan / Hussain) onto each other's hidden keys.
 * That other row is the person; this row is a new row (it finds its own checkup or visit again). exact = {key: [row numbers]} of the tab.
 * The same name on ANOTHER phone has moved away too when another row now holds that name with the row's old phone: two people of one name
 * (two walk-ins called "Ayesha") swapped by a sort, whose follow-up notes would otherwise go to the other one's phone (loop 7).
 */
function aajMovedAway(nameText, phoneNow, s, w, exact, r) {
  var names = [s.name || '', w.name || ''], olds = [aajPhoneOf(s.phone || ''), aajPhoneOf(w.phone || '')], i, j, q, ks, at, same = false;
  if (!phoneNow) return false;
  for (i = 0; i < names.length; i++) {
    if (!names[i]) continue;
    if (aajFieldKey('name', nameText) === aajFieldKey('name', names[i]) || (aajNormName(nameText) !== '' && aajNormName(nameText) === aajNormName(names[i]))) same = true;
  }
  if (same) {
    if (phoneNow === olds[0] || phoneNow === olds[1]) return false;
    for (i = 0; i < olds.length; i++) {
      if (!olds[i]) continue;
      for (j = 0; j < names.length; j++) {
        ks = aajExactKeys(names[j], olds[i]);
        for (q = 0; q < ks.length; q++) {
          at = exact[ks[q]] || [];
          if (at.length > 1 || (at.length === 1 && at[0] !== r)) return true;
        }
      }
    }
    return false;
  }
  for (i = 0; i < names.length; i++) {
    ks = aajExactKeys(names[i], phoneNow);
    for (j = 0; j < ks.length; j++) {
      at = exact[ks[j]] || [];
      if (at.length > 1 || (at.length === 1 && at[0] !== r)) return true;
    }
  }
  return false;
}

/**
 * Does a row no longer show the Mr#, name and phone (s, as aajFieldKey reads them) that its key was written with before its first answer
 * came back (base.p)? Then the key is somebody else's now (aajScanTab). Pure.
 */
function aajPendingMoved(cells, cols, s) {
  for (var i = 0; i < AAJ_ID_FIELDS.length; i++) {
    var f = AAJ_ID_FIELDS[i];
    if (cols[f] === undefined) continue;
    if (aajFieldKey(f, cells[cols[f]]) !== (s[f] === undefined ? '' : String(s[f]))) return true;
  }
  return false;
}

/** The Mr#, name and phone a row shows, as aajFieldKey reads them, in one text (two rows that show the same person have the same). Pure. */
function aajIdText(cells, cols) {
  var t = [];
  for (var i = 0; i < AAJ_ID_FIELDS.length; i++) t.push(cols[AAJ_ID_FIELDS[i]] === undefined ? '' : aajFieldKey(AAJ_ID_FIELDS[i], cells[cols[AAJ_ID_FIELDS[i]]]));
  return t.join('\u0001');
}

var AAJ_MOVE_FIELDS = ['mr', 'name', 'phone', 'month', 'treatment', 'status'];     // what a sort of the visible columns carries along

/**
 * A sort of the visible columns (or the sort button of a filter made before Set up) moves the people but leaves the hidden keys behind. When
 * linked rows now show exactly each other's cells as the sheet had them at the last sync (base.s: Mr#, name, phone, Month, Treatment,
 * Status), they only changed places: each takes the key and memory of the person now in it, and nothing is sent for them. This also tells
 * apart two rows whose Mr#, name and phone are the same (a checkup registered as a patient and that patient's visit of the same day), which
 * no identity check can. Only a closed exchange counts: every row whose person moved away is taken over by exactly one other row, and
 * takes over exactly one. Rows the website said "deleted" about (base.g) and rows it could not place (base.u) take part too: their memory
 * goes with their person, so a sort never puts a live patient onto a "deleted" key (her visit would be removed) nor brings back the deleted
 * person as a new row (RSG-1). When the exchange is not closed (a row the website has not answered yet took part in the sort), a "deleted"
 * memory whose row now holds somebody else still goes to the one row that shows exactly its person.
 * Rows that show the same cells (two walk-ins of one name with no phone, a row and its copy) are handed out by position: a sort keeps their
 * order. A key on two rows (a pure copy) is one memory with two places (SB10-1). A memory of an EARLIER day (a kept row, which now
 * stays on the tab for days) goes with its person too, never onto a patient of today (SB10-2). So does the hidden edit time. A key left
 * on a row whose name is blank ("Delete cells, shift up", a cleared row sorted down, a cut and paste) is one more place of its memory
 * (m.lost), never in an exchange (B1/B2).
 * Returns {row number: {key, baseText, from, edited}}. Pure.
 */
function aajFindMoves(grid, cols, hc, listDate, branch) {
  var out = {}, mems = {}, memList = [], places = [], nowOf = {}, fullOf = {}, edOf = {}, blanks = [], i, j, r;
  if (hc.key < 0 || hc.base < 0 || cols.name === undefined) return out;
  var textOf = function (fields, get) {
    var t = [];
    for (var fi = 0; fi < fields.length; fi++) if (cols[fields[fi]] !== undefined) t.push(get(fields[fi]));
    return t.join('\u0001');
  };
  var memOf = function (key, baseText) {
    var b = aajParseBase(baseText);
    if (!b || !b.w || !b.s || !(b.v || b.g || b.u) || (b.d && b.d > listDate) || (b.b && branch && b.b !== branch)) return { bad: true, places: [], lost: [] };
    var bs = function (mf) { return b.s[mf] === undefined ? '' : String(b.s[mf]); };
    return { key: key, baseText: baseText, was: textOf(AAJ_MOVE_FIELDS, bs), full: textOf(AAJ_ALL_FIELDS, bs), idWas: textOf(AAJ_ID_FIELDS, bs),
      gone: !!b.g, old: !!(b.d && b.d < listDate), places: [], lost: [] };
  };
  for (i = 1; i < grid.length; i++) {
    var cells = grid[i];
    if (!aajText(cells[cols.name])) { blanks.push(i); continue; }
    var cellKey = function (mf) { return aajFieldKey(mf, cells[cols[mf]]); };
    nowOf[i + 1] = textOf(AAJ_MOVE_FIELDS, cellKey);
    fullOf[i + 1] = textOf(AAJ_ALL_FIELDS, cellKey);
    edOf[i + 1] = hc.edited >= 0 ? aajText(cells[hc.edited]) : '';
    var key = aajText(cells[hc.key]);
    if (!key || !AAJ_KEY_RE.test(key)) continue;
    if (mems[key]) { mems[key].places.push(i + 1); places.push({ r: i + 1, m: mems[key] }); continue; }   // the key's other place (a pure copy)
    var m = memOf(key, aajText(cells[hc.base]));
    m.places.push(i + 1);
    mems[key] = m;
    if (m.bad) continue;
    memList.push(m);
    places.push({ r: i + 1, m: m });
  }
  // keys on blank rows: another place of a memory above, or a memory of their own
  for (j = 0; j < blanks.length; j++) {
    i = blanks[j];
    var bk = aajText(grid[i][hc.key]);
    if (!bk || !AAJ_KEY_RE.test(bk)) continue;
    edOf[i + 1] = hc.edited >= 0 ? aajText(grid[i][hc.edited]) : '';
    if (!mems[bk]) { mems[bk] = memOf(bk, aajText(grid[i][hc.base])); if (!mems[bk].bad) memList.push(mems[bk]); }
    mems[bk].lost.push(i + 1);
  }
  // places whose person moved away, grouped by that person's cells; rows showing those cells that do not hold their own person take one
  var groups = {}, gl = [], claim = {}, holds = function (p) { return nowOf[p.r] === p.m.was; };
  var groupOf = function (t) { if (!groups[t]) { groups[t] = { cl: [], pl: [] }; gl.push(groups[t]); } return groups[t]; };
  for (i = 0; i < places.length; i++) if (!places[i].m.bad && !holds(places[i])) groupOf(places[i].m.was).pl.push(places[i]);
  for (i = 0; i < places.length; i++) if (!places[i].m.bad && !holds(places[i]) && groups[nowOf[places[i].r]]) groups[nowOf[places[i].r]].cl.push(places[i].r);
  var pair = function (cl, pl) { for (var q = 0; q < cl.length; q++) claim[cl[q]] = pl[q]; };
  var byRow = function (a, b2) { return (a.r || a) - (b2.r || b2); };
  for (i = 0; i < gl.length; i++) {
    var g = gl[i];
    if (!g.cl.length || g.cl.length !== g.pl.length) continue;      // nobody, or a row that is not only a move (typed, added) took part
    g.cl.sort(byRow); g.pl.sort(byRow);
    // rows whose every cell is their person's are paired first, then the rest, each by position
    var sub = {}, sl = [], leftC = [], leftP = [];
    for (j = 0; j < g.pl.length; j++) { if (!sub[g.pl[j].m.full]) { sub[g.pl[j].m.full] = { cl: [], pl: [] }; sl.push(g.pl[j].m.full); } sub[g.pl[j].m.full].pl.push(g.pl[j]); }
    for (j = 0; j < g.cl.length; j++) { if (sub[fullOf[g.cl[j]]]) sub[fullOf[g.cl[j]]].cl.push(g.cl[j]); else leftC.push(g.cl[j]); }
    for (j = 0; j < sl.length; j++) {
      var s1 = sub[sl[j]];
      if (s1.cl.length === s1.pl.length) pair(s1.cl, s1.pl);
      else { leftC = leftC.concat(s1.cl); leftP = leftP.concat(s1.pl); }
    }
    leftC.sort(byRow); leftP.sort(byRow);
    pair(leftC, leftP);
  }
  // only a closed exchange counts
  var stable = false;
  while (!stable) {
    stable = true;
    var takenBy = {};
    for (r in claim) if (Object.prototype.hasOwnProperty.call(claim, r)) takenBy[claim[r].r] = (takenBy[claim[r].r] || 0) + 1;
    for (r in claim) {
      if (!Object.prototype.hasOwnProperty.call(claim, r)) continue;
      if (takenBy[r] !== 1 || takenBy[claim[r].r] !== 1 || !claim[claim[r].r]) { delete claim[r]; stable = false; }
    }
  }
  // an earlier-day memory never takes a stamp of today along: that is the edit of whoever was put in its row after the sort
  var day0 = aajDayStartMs_(listDate), edFor = function (m, from) { return m.old && (Number(edOf[from]) || 0) >= day0 ? '' : edOf[from]; };
  for (r in claim) if (Object.prototype.hasOwnProperty.call(claim, r)) out[r] = { key: claim[r].m.key, baseText: claim[r].m.baseText, from: claim[r].r, edited: edFor(claim[r].m, claim[r].r) };
  // a "deleted" or earlier-day memory left behind by a sort that was not a closed exchange (or on a blank row) goes to the one row that shows
  // exactly its person (and does not hold its own): the deleted visit is not made again, yesterday's patient is never sent as a visit of today.
  // So does any memory whose only place is a blank row: "Delete cells, shift up" (or a sort over a blank row) moved its person off its key. A
  // row the website added a minute ago is claimed only by the next call; sent as a new row it would be added a second time, and with a
  // phone-less checkup a second checkup made (RS12-2)
  var mineHolds = {};
  for (i = 0; i < places.length; i++) if (!places[i].m.bad && holds(places[i])) mineHolds[places[i].r] = true;
  var idOf = function (rr) { return textOf(AAJ_ID_FIELDS, function (mf) { return aajFieldKey(mf, grid[rr - 1][cols[mf]]); }); };
  var keyTaken = function (k) {
    for (var rk in out) if (Object.prototype.hasOwnProperty.call(out, rk) && out[rk].key === k) return true;
    return false;
  };
  for (i = 0; i < memList.length; i++) {
    var gm = memList[i];
    var onBlank = !gm.places.length && gm.lost.length === 1;
    if (!(gm.gone || gm.old || onBlank) || gm.places.length + (gm.places.length ? 0 : gm.lost.length) !== 1) continue;
    var gr = gm.places.length ? gm.places[0] : gm.lost[0];
    if ((gm.places.length && idOf(gr) === gm.idWas) || keyTaken(gm.key)) continue;     // (a place given another memory here still hands on its own)
    var hits = [];
    for (r in nowOf) if (Object.prototype.hasOwnProperty.call(nowOf, r) && Number(r) !== gr && nowOf[r] === gm.was) hits.push(Number(r));
    if (hits.length !== 1 || out[hits[0]] || mineHolds[hits[0]]) continue;
    out[hits[0]] = { key: gm.key, baseText: gm.baseText, from: gr, edited: edFor(gm, gr) };
  }
  // a key on two rows (a row and its copy), the only memory of its person, whose places lost that person: the rows that show its Mr#, name
  // and phone take it (aajScanTab keeps the upper as the record). Before, the second made a second checkup (B1)
  var idN = {};
  for (i = 0; i < memList.length; i++) idN[memList[i].idWas] = (idN[memList[i].idWas] || 0) + 1;
  for (i = 0; i < memList.length; i++) {
    var cm = memList[i];
    if (cm.places.length + cm.lost.length < 2 || idN[cm.idWas] > 1 || keyTaken(cm.key)) continue;
    var lostAt = [];
    for (j = 0; j < cm.places.length; j++) if (out[cm.places[j]] || idOf(cm.places[j]) !== cm.idWas) lostAt.push(cm.places[j]);
    var nl = lostAt.length;           // a blank place may be a copy cleared on purpose
    lostAt = lostAt.concat(cm.lost);
    var cand = [];
    for (r in nowOf) if (!out[r] && !mineHolds[r] && cm.places.indexOf(Number(r)) < 0 && idOf(Number(r)) === cm.idWas) cand.push(Number(r));
    if (!cand.length || cand.length < nl || cand.length > lostAt.length) continue;
    cand.sort(byRow); lostAt.sort(byRow);
    for (j = 0; j < cand.length; j++) out[cand[j]] = { key: cm.key, baseText: cm.baseText, from: lostAt[j], edited: cm.old ? edFor(cm, lostAt[j]) : undefined };
  }
  return out;
}

/** row.read (the full reading of the row) is only made when a row is sent or logged: a quiet minute does not need it. */
function aajLazyRead_(row, cells, cols) {
  var cache = null;
  Object.defineProperty(row, 'read', {
    get: function () { if (cache === null) cache = aajReadRow(cells, cols); return cache; },
    enumerable: false, configurable: true
  });
}

/**
 * Reads one tab. grid = getDisplayValues() of rows 1..lastRow (row 1 = header); cols = aajDetectColumns(row 1);
 * hc = aajFindHelpers(row 1). Returns the rows, what to send, and what to write before sending.
 * opts: { newKey: function () -> 'S-...', busyMs, final, branch, setupStamp }  (final = the last flush before the archive: no settle wait;
 *        setupStamp = the edit stamp Set up wrote on the tab's rows that morning)
 */
function aajScanTab(grid, cols, hc, nowMs, listDate, opts) {
  opts = opts || {};
  var busyMs = opts.busyMs === undefined ? AAJ.BUSY_MS : opts.busyMs;
  var newKey = opts.newKey;
  var scan = {
    listDate: listDate, branch: opts.branch || '', cols: cols, hc: hc, grid: grid, nowMs: nowMs, rows: [], present: [], newKeys: [], rekeys: [], stamps: [],
    releases: [], releaseBusy: false, named: 0, tooMany: false, lastNamed: 1, keyRow: {}, statusText: {}, headers: [], final: !!opts.final, swaps: [],
    kept: 0,                       // named rows of earlier days kept on the tab (not sent, not counted in MAX_ROWS)
    tooLong: false,                // the list reaches within LIST_ROOM rows of MAX_READ_ROWS: not synced
    doubled: [],                   // keys on two rows that show the same person (the lower row is a pure copy, RV-1 / RV-3)
    unanswered: false,             // a key whose first answer never came back left its person (aajPendingMoved): no removal pass this minute
    releasedKeys: {}               // the keys of the rows released this minute (aajReconcileTab never adds their record back in the same minute)
  };
  // rows that only changed places in a sort of the visible columns take the key and memory of the person now in them (written before the send)
  var moves = aajFindMoves(grid, cols, hc, listDate, opts.branch || '');
  // keys on more than one named row (after the moves), with how many of those rows were not edited today: of the rows that show one kept
  // key, the copies made today are today's rows (below)
  var day0 = aajDayStartMs_(listDate), multi = {};
  if (cols.name !== undefined && hc.key >= 0) {
    for (var mi = 1; mi < grid.length; mi++) {
      if (!aajText(grid[mi][cols.name])) continue;
      var mkey = moves[mi + 1] ? moves[mi + 1].key : aajText(grid[mi][hc.key]);
      if (!mkey) continue;
      var med = moves[mi + 1] && moves[mi + 1].edited !== undefined ? (Number(moves[mi + 1].edited) || 0) : (hc.edited >= 0 ? (Number(aajText(grid[mi][hc.edited])) || 0) : 0);
      var mm = multi[mkey] || (multi[mkey] = { n: 0, first: mi + 1, old: 0 });
      mm.n++;
      if (med < day0) mm.old++;
    }
  }
  var h0 = grid[0] || [];
  for (var hi = 0; hi < h0.length; hi++) scan.headers.push(aajText(h0[hi]));
  var seen = {};
  // every named row's exact name and phone (aajMovedAway): a row kept only by its phone and a fitting first name is checked against them
  var exact = {};
  if (cols.name !== undefined && cols.phone !== undefined) {
    for (var xi = 1; xi < grid.length; xi++) {
      var xks = aajExactKeys(aajText(grid[xi][cols.name]), aajFirstPhone(grid[xi][cols.phone]));
      for (var xj = 0; xj < xks.length; xj++) (exact[xks[xj]] = exact[xks[xj]] || []).push(xi + 1);
    }
  }
  for (var i = 1; i < grid.length; i++) {
    var cells = grid[i];
    var r = i + 1;
    var nameText = cols.name === undefined ? '' : aajText(cells[cols.name]);
    var keyText = hc.key >= 0 ? aajText(cells[hc.key]) : '';
    var baseText = hc.base >= 0 ? aajText(cells[hc.base]) : '';
    var swapped = !!moves[r];
    if (swapped) { keyText = moves[r].key; baseText = moves[r].baseText; }
    // a person moved by a sort keeps their own edit time
    var edited = swapped && moves[r].edited !== undefined ? (Number(moves[r].edited) || 0) : (hc.edited >= 0 ? (Number(aajText(cells[hc.edited])) || 0) : 0);
    var swapRec = swapped ? { r: r, key: keyText, base: baseText, edited: moves[r].edited } : null;
    if (hc.status >= 0) scan.statusText[r] = aajText(cells[hc.status]);
    if (!nameText) {
      if (keyText || baseText) {
        scan.releases.push(r);
        if (keyText) scan.releasedKeys[keyText] = true;
        if (edited && (nowMs - edited) < busyMs) scan.releaseBusy = true;      // a name just cleared: it may be retyped in a moment
      }
      continue;
    }
    scan.named++;
    scan.lastNamed = r;
    var mrCell = cols.mr === undefined ? '' : aajText(cells[cols.mr]);
    var mrInfo = aajMrOf(mrCell);
    var bad = null;
    if (mrCell !== '' && !mrInfo.isNew && mrInfo.mr === null) bad = '"' + mrCell + '" is not a Mr#. Type the number only, or leave it empty.';
    var key = keyText, base = null, rekeyed = false;
    if (key && !AAJ_KEY_RE.test(key)) key = '';
    // A row whose key a row above has, and that shows the same Mr#, name and phone, is a pure copy: a Ctrl+Z of rows the sync had already put
    // back (a held deletion, a kept visit), or a whole row copied. It is the same visit or checkup, never a new row: it keeps its cells, is
    // not sent and not in "present", and says so (RV-1). Its key is sent as "doubled": a Ctrl+Z after the sync put back a visit it kept and marked Cancelled gives the visit its status back (RV-3).
    if (key && seen[key] && seen[key].id === aajIdText(cells, cols)) {
      if (scan.doubled.indexOf(key) < 0) scan.doubled.push(key);
      if (swapRec) scan.swaps.push(swapRec);        // a moved copy: its key is written where it is now (SB10-1)
      var cp = { r: r, key: key, state: 'copy', copyOf: seen[key].r, base: null, baseText: baseText, raw: {}, texts: {}, edited: edited, busy: false, bad: null,
        push: false, held: false, fields: [], stamped: false, rekeyed: false, swapped: false, movedStatus: '', fromSetup: false, tokenDoctor: '' };
      aajLazyRead_(cp, cells, cols);
      scan.rows.push(cp);
      continue;
    }
    if (key && seen[key]) { key = ''; rekeyed = true; }            // a copied row typed over with somebody else: the topmost keeps the key
    if (key) {
      base = aajParseBase(baseText);
      // A KEPT row: a row of an EARLIER day that stays on the tab until staff delete it (owner, 17 Oct 2026). The nightly archive copied it
      // and wrote that into its memory (base.a, aajMarkBase_); a row an older version of this script left behind after its nightly clear
      // has no mark and counts while nobody edited it since this day began (RV9-1). It is that day's patient, never a row of today: it is
      // not sent, not in "present" (so deleting it, in any way and in any number, removes nothing and brings nothing back), not counted in
      // MAX_ROWS, and its Website cell says so calmly. Staff may edit it (Healthwire done, a Status) and it stays kept.
      // A row that no longer shows that day's person is today's row, as before: a new patient typed over it, or a sort that put a patient of
      // today here (SB10-2; aajFindMoves takes the memory to the row that shows its person). So is an unmarked row edited today (typed
      // while the sync was off; the archive left it for today), and a copy of a kept row made today (its hidden key too: a returning
      // patient's row copied to save typing): of the rows that show one kept key, the copies edited today are today's rows.
      if (base && base.d && base.d < listDate && (base.a || edited < day0) && !aajPendingMoved(cells, cols, base.s || {})) {
        var mk = multi[key];
        if (mk && mk.n > 1 && edited >= day0 && (mk.old > 0 || mk.first !== r)) { base = null; key = ''; rekeyed = true; }
        else {
          var lo = { r: r, key: key, state: 'kept', day: base.d, base: null, baseText: baseText, raw: {}, texts: {}, edited: edited, busy: false, bad: null,
            push: false, held: false, fields: [], stamped: false, rekeyed: false, swapped: false, movedStatus: '', fromSetup: false, tokenDoctor: '' };
          aajLazyRead_(lo, cells, cols);
          scan.rows.push(lo);
          scan.kept++;
          if (swapRec) scan.swaps.push(swapRec);      // moved: its key is written where it is now
          continue;
        }
      }
      if (base && base.d && base.d !== listDate) { base = null; key = ''; rekeyed = true; }   // belonged to another day
      if (base && base.b && scan.branch && base.b !== scan.branch) { base = null; key = ''; rekeyed = true; }   // copied from another branch's tab
      // A key written just before the row's first call (base.p, aajPrewrite_) whose answer never came back: the call timed out, or the sheet
      // changed while the website answered and nothing was written. The website may have made the visit or checkup under it. The key stays
      // only while the row still shows the Mr#, name and phone it was written with. A sort of the visible columns (or a cut and paste, or the
      // row typed over) during that call left the key under somebody else (SB7-1): that row is a new row with a
      // new key, and the person who was sent finds their own visit again by Mr# (or their checkup by name and phone), wherever they are now.
      // A key with no memory at all is a new row too.
      // The removal pass waits one minute then, so the visit is adopted by its person's row before anything could remove it.
      if (key && (!base || (base.p && !base.v && !base.g && !base.u && aajPendingMoved(cells, cols, base.s || {})))) { base = null; key = ''; rekeyed = true; scan.unanswered = true; }
    }
    if (key && base && base.v && base.w && !bad) {                  // identity check: is this still the same patient?
      // The person the row had (aajSamePerson): its full name (as the sheet had it at the last sync, or as the website has it), or its phone
      // with a name that fits. A row typed over with somebody else, a family member on the same phone, or a sort of the visible columns that
      // left the hidden key behind is then a new row, which adopts that person's own visit or checkup (or makes one).
      var phoneNow = cols.phone === undefined ? null : aajFirstPhone(cells[cols.phone]);
      var samePerson = aajSamePerson(nameText, phoneNow, base.s || {}, base.w);
      // kept only by the phone and a fitting first name, while another row holds this person's exact name and phone: family members on one
      // phone (Ali Raza / Ali Hamza) moved onto each other's keys by a sort. Each is a new row and finds its own checkup or visit.
      if (samePerson && aajMovedAway(nameText, phoneNow, base.s || {}, base.w, exact, r)) samePerson = false;
      var changed;
      // An Mr# cell changed while the row still shows the very name it had (and its person, aajSamePerson) is a slip of a finger as often as a
      // correction (token 7 typed into the Mr# cell, a digit too many): the row stays on its visit or checkup and the new Mr# is sent under its
      // key. The website decides (RW8-1): it writes its own Mr# back, refuses, or lets the row go ("rekey": the
      // patient file the sync made from this row today and the Mr# corrected; an Mr# typed into a checkup row for a patient the website has).
      // A new Mr# with another name (a brother on the same phone typed over the row with his own Mr#) is another person: a new row, as before.
      var keepMr = samePerson && aajSameName(nameText, base.s || {}, base.w);
      if (base.k) {
        // a checkup row has no Mr# to tell it by: a slip fixed (same phone, a name that fits) or a phone fixed (same name) is the same checkup. The
        // Mr# the website wrote back into it (the checkup registered as that patient) keeps it the same checkup.
        // A REGISTERED checkup (the website wrote its Mr# into the row) whose Mr# cell is now empty is another row: its Mr# moved away with its
        // person (a sort of the visible columns), or was cleared, and the row finds its checkup again by name and phone.
        // A Month typed into a checkup row: the person is a braces patient, never a checkup (owner, 13:20). The Month is sent under the
        // checkup's key and the website lets the row go ("rekey"): the row is then sent as a new row, which says "add the Mr#" without an Mr#
        // and is that patient's visit with one (loop 7). The checkup is not changed by it: an unregistered one with no follow-up notes is
        // removed when its key has left the sheet, whatever its status (the website wrote down that it let the row go, RV9-2); a registered one (or one with follow-up notes) is kept and its row comes back.
        // An Mr# typed into a checkup row (the same name) is sent under the checkup's key: the website lets the row go when it is a patient
        // it has whose name fits (an existing patient on recall whose Mr# staff looked up in Healthwire, RS5-E1), and the row
        // then makes that patient's visit as a new row; otherwise the checkup stays and the row says so.
        changed = !samePerson
          || (!!mrInfo.mr && mrInfo.mr !== String(base.w.mr || '') && !keepMr)
          || (!!base.w.mr && cols.mr !== undefined && aajFieldKey('mr', mrCell) === '' && String(base.s && base.s.mr !== undefined ? base.s.mr : '') !== '');
      }
      else if (mrInfo.mr) changed = mrInfo.mr !== String(base.w.mr || '') && !keepMr;    // another Mr# with another name: a new row
      else changed = !samePerson;              // a visit row whose Mr# cell is empty: the same name (an Mr# cleared by mistake) or phone stays
      if (changed) { key = ''; base = null; rekeyed = true; }
    } else if (key && base && base.g && base.s && !bad) {
      // A row the website said "deleted" about (its visit or checkup was deleted on the website, moved to another day, or a Ctrl+Z could not
      // be done) is still the person it was about, nobody else. A new patient typed over it, or another row's person put there by a sort of
      // the visible columns, is a new row: it adopts that person's own visit or checkup, or makes one (RSG-1).
      var phoneG = cols.phone === undefined ? null : aajFirstPhone(cells[cols.phone]);
      var bwG = base.w || {};
      var sameG = aajSamePerson(nameText, phoneG, base.s, bwG) && !aajMovedAway(nameText, phoneG, base.s, bwG, exact, r);
      if ((!!mrInfo.mr && mrInfo.mr !== String(base.s.mr === undefined ? '' : base.s.mr)) || !sameG) { key = ''; base = null; rekeyed = true; }
    }
    var fresh = !key;
    if (swapped && !fresh) scan.swaps.push(swapRec);
    if (!key) { key = newKey(); scan.newKeys.push({ r: r, key: key, rekeyed: rekeyed || !!baseText }); }
    seen[key] = { r: r, id: aajIdText(cells, cols) };
    scan.present.push(key);
    scan.keyRow[key] = r;
    var raw = {}, texts = {};
    for (var fi = 0; fi < AAJ_ALL_FIELDS.length; fi++) {
      var f = AAJ_ALL_FIELDS[fi];
      raw[f] = cols[f] === undefined ? '' : aajText(cells[cols[f]]);
      texts[f] = cols[f] === undefined ? '' : aajFieldKey(f, cells[cols[f]]);
    }
    // the memory a new key is written with (aajPrewrite_): the Mr#, name and phone it will be sent with
    if (fresh) {
      var idS = {};
      for (var pi = 0; pi < AAJ_ID_FIELDS.length; pi++) idS[AAJ_ID_FIELDS[pi]] = texts[AAJ_ID_FIELDS[pi]];
      scan.newKeys[scan.newKeys.length - 1].pending = JSON.stringify({ p: 1, d: listDate, b: scan.branch, s: idS });
    }
    var state;
    if (fresh || !base) state = 'new';
    else if (base.g) state = 'gone';
    else if (base.u) state = 'unlinked';
    else if (base.v) state = 'linked';
    else state = 'new';
    if (state === 'new') base = null;
    var stampNow = false;
    if (state === 'new' && !edited && !opts.final) { stampNow = true; edited = nowMs - Math.floor(busyMs / 2); scan.stamps.push({ r: r, ms: edited }); }
    var busy = edited > 0 && (nowMs - edited) < busyMs;
    var row = { r: r, key: key, state: state, base: base, baseText: fresh ? '' : baseText, isNewMr: mrInfo.isNew, raw: raw, texts: texts, edited: edited,
      busy: busy, bad: bad, push: false, held: false, fields: [], stamped: stampNow, rekeyed: rekeyed, swapped: swapped && !fresh,
      // what the Website cell said about this person in the row the sort took them from (the Website column does not move with the sort)
      movedStatus: swapped && !fresh && hc.status >= 0 && grid[moves[r].from - 1] ? aajText(grid[moves[r].from - 1][hc.status]) : '',
      fromSetup: !!opts.setupStamp && edited === opts.setupStamp,      // not edited since Set up stamped it: no edit time is sent (aajRowPayload)
      tokenDoctor: cols.doctors === undefined ? '' : aajTokenDoctor(raw.token) };
    // A linked row whose Mr#, name or phone is being typed over (edited in the last minute) is held back, like a new row settling: staff type
    // a person over a row one cell at a time, and the first cell must not rename the old person's visit or checkup before the rest shows who
    // this is. Nothing is sent and the row's base stays as it was; once the row is quiet, it is judged against that base (aajSamePerson).
    if (state === 'linked' && busy && !opts.final) {
      var bsH = (base && base.s) || {};
      for (var hi2 = 0; hi2 < AAJ_ID_FIELDS.length; hi2++) {
        var idf = AAJ_ID_FIELDS[hi2];
        if (cols[idf] !== undefined && texts[idf] !== (bsH[idf] === undefined ? '' : bsH[idf])) row.held = true;
      }
    }
    if (!bad && state !== 'gone') {
      var fields = [], f2;
      if (state === 'linked') {
        var bs = (base && base.s) || {};
        for (var li = 0; li < AAJ_ALL_FIELDS.length; li++) {
          f2 = AAJ_ALL_FIELDS[li];
          if (cols[f2] === undefined) continue;
          if (f2 === 'status' && texts.status === '') continue;      // an empty Status cell is never sent
          if (texts[f2] !== (bs[f2] === undefined ? '' : bs[f2])) fields.push(f2);
        }
        if (fields.indexOf('token') >= 0 && row.tokenDoctor && fields.indexOf('doctors') < 0) fields.push('doctors');
        row.pending = fields.length > 0;          // something the website has not taken yet (aajReconcileTab: an old refusal goes once nothing is)
        if (fields.length && !row.held) { row.push = true; row.fields = fields; }
      } else {
        var allFields = [];
        for (var ni = 0; ni < AAJ_ALL_FIELDS.length; ni++) {
          f2 = AAJ_ALL_FIELDS[ni];
          if (cols[f2] === undefined) continue;
          if (f2 === 'mr' || texts[f2] !== '' || (f2 === 'doctors' && row.tokenDoctor)) allFields.push(f2);
        }
        var go = true;
        if (state === 'unlinked') {
          var us = (base && base.s) || {}, diff = false;
          for (var di = 0; di < allFields.length; di++) if (texts[allFields[di]] !== (us[allFields[di]] === undefined ? '' : us[allFields[di]])) diff = true;
          // A row refused as "already on this list in row N" (base.dup) is sent again at every full read, not after five minutes: when staff
          // delete the OTHER row (often the one added from the website, with front desk's notes on its visit), this row adopts that visit in
          // the same call, before the removal pass could delete it (rows are handled first, RW8-2).
          go = diff || !!(base && base.dup) || (nowMs - (Number(base && base.at) || 0)) >= AAJ.RETRY_UNLINKED_MS;
        }
        if (go && (!busy || opts.final)) { row.push = true; row.fields = allFields; }
      }
    }
    aajLazyRead_(row, cells, cols);
    scan.rows.push(row);
  }
  if (scan.named - scan.kept > AAJ.MAX_ROWS) scan.tooMany = true;               // today's rows only: kept rows of earlier days do not count
  if (scan.lastNamed > AAJ.MAX_READ_ROWS - AAJ.LIST_ROOM) scan.tooLong = true;   // too close to the last row that is read
  return scan;
}

/** The value of one field as the website wants it (section 2.1 of the design). */
function aajSetValue(f, row) {
  var read = row.read, t = row.raw[f];
  if (f === 'mr') return read.isNew ? 'NEW' : (read.mr || '');
  if (f === 'name') return read.name;
  if (f === 'phone') return read.phone || '';
  if (f === 'month') return { t: t, v: read.month };
  if (f === 'token') return { t: t, v: read.token };
  if (f === 'status') return { t: t, v: read.liveStatus };
  if (f === 'group') return { t: t, v: read.group ? Number(read.group) : null };
  if (f === 'doctors') {
    var people = read.people.slice(), extra = row.tokenDoctor;
    if (extra) {
      var have = false;
      for (var i = 0; i < people.length; i++) if (aajDoctorKey(people[i]) === aajDoctorKey(extra)) have = true;
      if (!have) people.push(extra);
    }
    return { t: t, v: people };
  }
  return t;
}

function aajRowPayload(row) {
  var set = {}, base = {};
  var linked = row.state === 'linked';
  var w = (row.base && row.base.w) || {};
  for (var i = 0; i < row.fields.length; i++) {
    var f = row.fields[i];
    set[f] = aajSetValue(f, row);
    if (f === 'name') set.legacy_name = row.read.legacyName;
    if (linked && AAJ_FIELDS.indexOf(f) >= 0) base[f] = f === 'doctors' ? aajSplitPeople(w.doctors || '') : (w[f] === undefined ? '' : w[f]);
  }
  // a row Set up stamped and nobody has edited since carries no edit time: it is not newer than anything done on the website (RSI-1)
  var out = { key: row.key, 'new': !linked, edited_at: row.fromSetup ? null : (row.edited || null), set: set };
  if (linked) out.base = base;
  return out;
}

/**
 * One call to the website. entries = [{cfg, scan, hash}] (every tab that is part of this call, all with the same date);
 * chunk = [{si, row}] the rows sent in THIS call; checkRemoved = true only on the last call of a tick for today.
 */
function aajBuildPayload(date, entries, chunk, checkRemoved) {
  var tabs = [];
  for (var i = 0; i < entries.length; i++) {
    tabs.push({ branch: entries[i].cfg.branch, tab: entries[i].cfg.tab, hash: entries[i].hash || null, present: entries[i].scan.present, rows: [] });
    // keys that are on two rows showing the same person (a Ctrl+Z of rows the sync had put back): the website gives a visit it kept and
    // marked Cancelled its status back (RV-3)
    if (entries[i].scan.doubled && entries[i].scan.doubled.length) tabs[i].doubled = entries[i].scan.doubled.slice(0, 400);
  }
  for (var j = 0; j < chunk.length; j++) {
    var rp = aajRowPayload(chunk[j].row);
    // Lahore and Islamabad keep kit / material text in their Token column (owner, 13:20): a bare number there ("2" units) is text, never the
    // website's token number
    var br = entries[chunk[j].si].cfg.branch;
    if ((br === 'LHR' || br === 'ISB') && rp.set.token) rp.set.token = { t: rp.set.token.t, v: null };
    tabs[chunk[j].si].rows.push(rp);
  }
  // keep_rows: this script keeps rows on the tab (no nightly clear), so the website lets a row of a patient who is done (Completed,
  // Treatment, Cancelled) go off the sheet instead of putting it back (20261017000100_aaj_keep_rows.sql). A website without that file
  // ignores the flag and answers as before (the row comes back): both orders of putting the two live are safe.
  return { date: date, check_removed: !!checkRemoved, keep_rows: true, tabs: tabs };
}

function aajDoctorsDiffer(a, b) {
  return aajCollapse(a) !== aajCollapse(b);
}

function aajHeaderText(kind, hhmm, extra) {
  if (kind === 'ok') return 'Website \u00b7 ' + hhmm + ' \u2713';
  if (kind === 'attention') return 'Website \u00b7 ' + hhmm + ' \u00b7 ' + extra + ' need attention';
  if (kind === 'error') return 'Website \u00b7 \u2717 ' + hhmm + ' ' + extra;
  return 'Website \u00b7 ' + extra;
}

/** The header without its clock time: used to decide whether it must be rewritten. */
function aajHeaderState(text) {
  return String(text || '').replace(/\d\d:\d\d/, '');
}

function aajStatusColor(text) {
  var c = String(text || '').charAt(0);
  if (c === '\u26a0') return '#b45309';
  if (c === '\u2717') return '#b91c1c';
  if (AAJ_KEPT_RE.test(String(text || ''))) return '#6b7280';      // a kept row of an earlier day: grey, so today's rows stand out
  return null;
}

/** The Website cell of a row of an earlier day kept on the tab (day = 'yyyy-MM-dd'). */
function aajKeptText(day) {
  var p = String(day).split('-');
  return '\u2713 ' + p[2] + '-' + p[1] + '-' + p[0] + ': kept on the sheet (delete it when it is entered in Healthwire)';
}
var AAJ_KEPT_RE = /^\u2713 \d\d-\d\d-\d{4}: kept on the sheet /;

function aajLabelOf(scan, f) {
  // the Status column is headed "Waiting" in Gulshan, North Nazimabad and DHA: "Website change kept for: Waiting" would read like a status
  if (f === 'status') return AAJ_LABELS.status;
  var idx = scan.cols[f];
  var t = idx === undefined ? '' : (scan.headers[idx] || '');
  return t ? t : AAJ_LABELS[f];
}

/**
 * After the website answered: decides, for every row and field, what to write into the sheet and what to remember.
 * scan = aajScanTab result; resp = {visits: [canon]|null, removed: [..]} (visits null = nothing changed on the website);
 * ctx = { nowMs, results: {key: result}, pushed: {key: {field: true}}, extraBusy: {row: true}, listDate }.
 * Returns { writes: [{r, f, text}], helper: {r: {key, base}}, status: {r: {text, level}}, appends: [..], log: [..],
 *           deferred, again (a row was let go: read the tab again next minute), attention }.
 */
function aajReconcileTab(scan, resp, ctx) {
  var cols = scan.cols;
  var results = ctx.results || {}, pushed = ctx.pushed || {}, extraBusy = ctx.extraBusy || {};
  var nowMs = ctx.nowMs;
  var out = { writes: [], helper: {}, status: {}, appends: [], log: [], deferred: false, again: false, attention: 0, final: {} };
  var visits = resp && resp.visits ? resp.visits : null;
  var removedInfo = {};
  var rl = (resp && resp.removed) || [];
  var byKey = {}, i;
  if (visits) for (i = 0; i < visits.length; i++) byKey[visits[i].key] = visits[i];
  for (i = 0; i < rl.length; i++) removedInfo[rl[i].key] = rl[i];
  var mrRows = {}, ckRows = {};

  function setStatus(row, text, level) {
    out.final[row.r] = text;
    if (text !== (scan.statusText[row.r] || '')) out.status[row.r] = { text: text, level: level };
  }
  var notes = [];
  function note(row, text, always) {
    notes.push({ row: row, text: text, always: !!always });
  }
  // A linked row that still shows a refusal (a cross) although nothing in it is waiting to be sent: the cell it was about is back to what
  // the website took (the Mr# or the name put back). Nothing is left to fix, so it goes back to a tick (a refusal is only ever about a cell
  // the website has not taken; its memory keeps such a cell unsent until it is answered without an error).
  function staleRefusal(row) {
    return row.state === 'linked' && !row.pending && !row.held && !results[row.key] && String(scan.statusText[row.r] || '').charAt(0) === '\u2717';
  }
  function resultStatus(row, res) {
    var level = res.level || 'ok';
    var msg = res.message || '';
    if (res.outcome === 'duplicate' && res.duplicate_of && scan.keyRow[res.duplicate_of]) msg = msg.replace('in another row', 'in row ' + scan.keyRow[res.duplicate_of]);
    var kept = [];
    var kw = res.kept_website || [];
    for (var k = 0; k < kw.length; k++) if (kw[k] !== 'mr') kept.push(aajLabelOf(scan, kw[k]));
    if (kept.length) {
      var keptText = 'Website change kept for: ' + kept.join(', ');
      msg = msg ? msg + ' \u00b7 ' + keptText : keptText;
      if (level === 'ok') level = 'warn';
    }
    if (level === 'error') return { text: '\u2717 ' + (msg || 'Not saved.'), level: 'error' };
    if (level === 'warn') return { text: '\u26a0 ' + msg, level: 'warn' };
    return { text: msg ? '\u2713 ' + msg : '\u2713 On website', level: 'ok' };
  }

  for (i = 0; i < scan.rows.length; i++) {
    var row = scan.rows[i];
    // a pure copy of the row above with its key (aajScanTab): nothing was sent for it. Deleting it removes nothing; deleting the other row
    // instead leaves this one as the row of that visit or checkup
    if (row.state === 'copy') { setStatus(row, '\u2717 Duplicate of row ' + row.copyOf + ': delete this row.', 'error'); continue; }
    // a row of an earlier day kept on the tab (aajScanTab): nothing was sent for it, and it is not something to fix (a tick, never counted
    // in "need attention")
    if (row.state === 'kept') { setStatus(row, aajKeptText(row.day), 'ok'); continue; }
    if (row.bad) { setStatus(row, '\u2717 ' + row.bad, 'error'); continue; }
    // a checkup row (its memory says so) is told "checkup", not "visit"; a row whose visit or checkup the website moved to another branch or
    // day (base.mv) is told so
    var goneKind = row.base && (row.base.k || row.base.gk) ? 'checkup' : 'visit';
    var goneText = '\u2717 This ' + goneKind + (row.base && row.base.mv ? ' was moved to another branch or day on the website.' : ' was deleted on the website.') + ' Delete this row.';
    // A row the website said "deleted" about whose key is in the website's list again (front desk moved the visit back to today, or it was
    // put back) is linked again from that visit: it must not keep saying "delete this row" about a patient who is on the list (RSG-2).
    var relink = row.state === 'gone' && !!byKey[row.key];
    if (row.state === 'gone' && !relink) { setStatus(row, goneText, 'error'); continue; }
    var linkedRow = row.state === 'linked' || relink;
    var res = results[row.key] || null;
    var visit = byKey[row.key] || null;
    if (res && res.outcome === 'rekey') {
      // the website let the row go from its visit or checkup (an Mr# typed into a checkup row for a patient it has; the Mr# corrected on a row
      // whose patient file the sync made from it today): the next minute the row is sent as a new row under a new key, and the old visit or
      // checkup goes like a deleted row, in the call that places the new one (RW8-1)
      out.helper[row.r] = { key: '', base: '' };
      out.again = true;
      setStatus(row, '\u26a0 ' + (res.message || 'Sent again as a new row.'), 'warn');
      note(row, res.message || 'Sent again as a new row.');
      continue;
    }
    var pushedOk = !!(res && AAJ_OK_OUTCOMES[res.outcome] === true && res.level !== 'error');
    var pushedF = pushedOk ? (pushed[row.key] || {}) : {};
    var curBaseText = row.baseText;

    if (!visit) {
      var nb0;
      if (res) {
        var o = res.outcome, msg0 = res.message || '';
        if (o === 'gone') {
          nb0 = { v: null, d: scan.listDate, b: scan.branch, s: aajCopyMap(row.texts), w: {}, g: 1 };
          if (row.base && (row.base.k || row.base.gk)) nb0.gk = 1;      // for the wording only (a checkup's memory flag k would put it on the nightly list)
          out.helper[row.r] = { key: row.key, base: JSON.stringify(nb0) };
          setStatus(row, row.base && (row.base.k || row.base.gk) ? goneText : '\u2717 ' + (msg0 || 'This visit was deleted on the website. Delete this row.'), 'error');
        } else if (o === 'other_list') {
          // its visit or checkup was moved to another branch or day on the website (front desk corrected the Branch on the Checkups page):
          // the row stays as "moved, delete this row", like a deleted one. Let go and sent again as a new row it would make the visit or
          // checkup a second time on this list (RS8-B1). Moved back, its key is in the list again and the row is linked again.
          nb0 = { v: null, d: scan.listDate, b: scan.branch, s: aajCopyMap(row.texts), w: {}, g: 1, mv: 1 };
          if (row.base && (row.base.k || row.base.gk)) nb0.gk = 1;
          out.helper[row.r] = { key: row.key, base: JSON.stringify(nb0) };
          setStatus(row, '\u2717 This ' + goneKind + ' was moved to another branch or day on the website. Delete this row.', 'error');
        } else if (o === 'superseded') {
          out.helper[row.r] = { key: '', base: '' };
          setStatus(row, '\u26a0 ' + msg0, 'warn');
          note(row, msg0);
        } else if (o === 'duplicate' || o === 'needs_patient') {
          nb0 = { v: null, d: scan.listDate, b: scan.branch, s: aajCopyMap(row.texts), w: {}, u: 1, at: nowMs };
          if (o === 'duplicate') nb0.dup = 1;            // sent again at every full read (aajScanTab, RW8-2)
          out.helper[row.r] = { key: row.key, base: JSON.stringify(nb0) };
          var rs = resultStatus(row, res);
          setStatus(row, rs.text, 'error');
          note(row, rs.text.replace(/^. /, ''));
        } else {
          var rs2 = resultStatus(row, res);
          setStatus(row, rs2.text, rs2.level);
          if (o === 'error') note(row, rs2.text.replace(/^. /, ''));
        }
      } else if (row.state === 'linked' && visits) {
        nb0 = { v: null, d: scan.listDate, b: scan.branch, s: (row.base && row.base.s) || {}, w: (row.base && row.base.w) || {}, g: 1 };
        if (row.base && (row.base.k || row.base.gk)) nb0.gk = 1;
        out.helper[row.r] = { key: row.key, base: JSON.stringify(nb0) };
        setStatus(row, goneText, 'error');
      } else if (row.swapped && row.state === 'unlinked' && row.movedStatus) {
        setStatus(row, row.movedStatus, 'error');       // a refused row moved by a sort: its own answer (what to fix) goes with it
      } else if (row.swapped) {
        setStatus(row, '\u2713 On website', 'ok');      // moved by a sort, nothing changed on the website: the old Website cell was about somebody else
      } else if (!visits && staleRefusal(row)) {
        setStatus(row, '\u2713 On website', 'ok');      // (the website's list did not change: the visit is still there) see staleRefusal
      }
      continue;
    }

    // the visit exists
    if (!linkedRow && !pushedOk) {
      if (res) { var rs3 = resultStatus(row, res); setStatus(row, rs3.text, rs3.level); }
      continue;
    }
    var isNewRow = !linkedRow;
    var keptF = {};
    var kw2 = (res && res.kept_website) || [];
    for (var q = 0; q < kw2.length; q++) keptF[kw2[q]] = true;
    var busy = row.busy || extraBusy[row.r] === true;
    var bs = (row.base && row.base.s) || {}, bw = (row.base && row.base.w) || {};
    var nb = { v: visit.id, d: scan.listDate, b: scan.branch, s: {}, w: {} };
    if (visit.kind === 'checkup') nb.k = 1;                // a checkup patient: no patient file behind this row
    var rowWrites = [];
    for (var fi = 0; fi < AAJ_FIELDS.length; fi++) {
      var f = AAJ_FIELDS[fi];
      if (cols[f] === undefined) continue;
      var S = row.texts[f];
      var Wraw = visit[f] === null || visit[f] === undefined ? '' : String(visit[f]);
      var W = aajFieldKey(f, Wraw);
      var Sb = isNewRow ? S : (bs[f] === undefined ? '' : bs[f]);
      var Wb = isNewRow ? '' : (bw[f] === undefined ? '' : bw[f]);
      var write = null, nS = S, nW = W;
      if (pushedF[f] && !keptF[f]) {
        if (f === 'mr' && row.isNewMr) write = Wraw;
        else if (f === 'doctors' && aajDoctorsDiffer(W, S)) write = Wraw;          // the website merged both sides' names
        else if (S === '' && W !== '') write = Wraw;                               // fill-in (Mr#, token, month...)
        // else: keep the cell
      } else if (pushedF[f] && keptF[f]) write = Wraw;
      else if (S !== Sb && !(f === 'status' && S === '')) { nS = Sb; nW = Wb; }    // a sheet change not sent yet
      else if (S === '' && W !== '') write = Wraw;
      else if (W !== Wb) write = Wraw;
      if (write !== null && f === 'token' && S !== '' && aajTokenOf(S) === null) write = null;   // never overwrite kit text
      if (write !== null && f === 'token' && (scan.branch === 'LHR' || scan.branch === 'ISB')) write = null;   // their Token column is kit / material text, never a number
      if (write !== null) {
        if (aajFieldKey(f, write) === S) { nS = S; nW = W; }
        // (an Mr# the website refused and could not write back yet stays unsent, so it is sent, refused and written back again)
        else if (busy) { out.deferred = true; nS = pushedF[f] && !(f === 'mr' && keptF[f]) ? S : Sb; nW = Wb; }
        else { rowWrites.push({ r: row.r, f: f, text: write }); nS = W; nW = W; }
      }
      nb.s[f] = nS; nb.w[f] = nW;
    }
    for (var si = 0; si < AAJ_SHEET_ONLY.length; si++) {
      var sf = AAJ_SHEET_ONLY[si];
      if (cols[sf] === undefined) continue;
      nb.s[sf] = pushedF[sf] || isNewRow ? row.texts[sf] : (bs[sf] === undefined ? '' : bs[sf]);
    }
    for (var wi = 0; wi < rowWrites.length; wi++) out.writes.push(rowWrites[wi]);
    var nbText = JSON.stringify(nb);
    if (nbText !== curBaseText) out.helper[row.r] = { key: row.key, base: nbText };
    if (res) {
      var rs4 = resultStatus(row, res);
      setStatus(row, rs4.text, rs4.level);
      if (res.patient_created) note(row, 'New patient added: Mr# ' + res.patient_created + '.', true);
      else if (rs4.level !== 'ok' || (res.kept_website && res.kept_website.length)) note(row, rs4.text.replace(/^. /, ''));
    } else if (row.swapped || relink) {
      setStatus(row, '\u2713 On website', 'ok');      // moved by a sort (what the Website cell said was about the person who was here before), or linked again
    } else if (!(scan.statusText[row.r] || '')) {
      setStatus(row, '\u2713 On website', 'ok');
    } else if (staleRefusal(row)) {
      setStatus(row, '\u2713 On website', 'ok');
    } else {
      out.final[row.r] = scan.statusText[row.r];
    }
    // "twice" is two VISITS of one patient. A checkup registered as that patient and a visit of theirs the same day are two different
    // things on the list (the website keeps them apart), not a double entry; two rows of one checkup are found by name and phone below.
    // A Cancelled visit is not a second visit: once staff follow the advice and cancel one of the two, the other row goes back to a tick
    if (visit.mr && visit.kind !== 'checkup') { if (visit.status !== 'Cancelled') (mrRows[visit.mr] = mrRows[visit.mr] || []).push(row); }
    else if (visit.kind === 'checkup' && aajPhoneOf(visit.phone)) {       // a checkup has no Mr# to tell it by: the same name and phone
      var ckKey = aajNormName(visit.name) + '|' + aajPhoneOf(visit.phone);
      (ckRows[ckKey] = ckRows[ckKey] || []).push(row);
    }
  }

  for (i = 0; i < notes.length; i++) {
    if (notes[i].always || out.status[notes[i].row.r]) out.log.push({ patient: notes[i].row.read.name, text: notes[i].text });   // once, when the row's status changed
  }

  var DUP_PATIENT = "\u26a0 Same patient twice on today's list. Set one of them to Cancelled.";
  var DUP_CHECKUP = "\u26a0 Same checkup patient twice on today's list (same name and phone). Delete one of the rows.";
  var flagged = {};
  var mk = Object.keys(mrRows);
  for (var mi = 0; mi < mk.length; mi++) {
    var group = mrRows[mk[mi]];
    if (group.length < 2) continue;
    for (var gi = 0; gi < group.length; gi++) { setStatus(group[gi], DUP_PATIENT, 'warn'); flagged[group[gi].r] = true; }
  }
  var ckk = Object.keys(ckRows);
  for (var ci = 0; ci < ckk.length; ci++) {
    var cgroup = ckRows[ckk[ci]];
    if (cgroup.length < 2) continue;
    for (var cj = 0; cj < cgroup.length; cj++) { setStatus(cgroup[cj], DUP_CHECKUP, 'warn'); flagged[cgroup[cj].r] = true; }
  }
  // a row that said "twice" and is alone now (the other one was deleted or cancelled) goes back to a plain tick. Only when the website sent its
  // list: without it nobody can tell, and the warning stays.
  for (i = 0; visits && i < scan.rows.length; i++) {
    var dr = scan.rows[i];
    var shownNow = out.final[dr.r] !== undefined ? out.final[dr.r] : (scan.statusText[dr.r] || '');
    if (!flagged[dr.r] && (shownNow === DUP_PATIENT || shownNow === DUP_CHECKUP) && !dr.bad && dr.state === 'linked') setStatus(dr, '\u2713 On website', 'ok');
  }

  // website-only visits go to the bottom of the tab. A visit or checkup the sheet has had a row for ("claimed") and whose row is not on the
  // sheet now was deleted, cleared, cut or is being moved by staff: only the website decides whether it comes back, so it is added again only
  // when this call's removal pass says so ("restore" / "kept", with the reason), or when it was "released" (its row left the sheet while it
  // was Cancelled / No show, "removed" in the list) and has been set to work again on the website since (RS5-D2, RS5-D4).
  if (visits) {
    var rowKeys = {}, waitMr = {}, waitCk = {};
    for (i = 0; i < scan.rows.length; i++) {
      var kr = scan.rows[i];
      rowKeys[kr.key] = true;
      // a new row that waits for its quiet minute (or was not sent): it adopts the visit of its Mr#, or the checkup of its name and phone, when sent
      if (kr.state === 'new' && !kr.push && !kr.bad) {
        if (kr.texts.mr) waitMr[aajMrOf(kr.texts.mr).mr || kr.texts.mr] = true;
        else waitCk[aajNormName(kr.raw.name) + '|' + (aajFirstPhone(kr.raw.phone) || '')] = true;
      }
    }
    for (i = 0; i < visits.length; i++) {
      var v = visits[i];
      if (typeof v.key !== 'string' || !AAJ_KEY_RE.test(v.key)) continue;      // not a key the sync made: never added as a row (it would become text in the hidden key column)
      if (rowKeys[v.key]) continue;
      var rinfo = removedInfo[v.key];
      var isRestore = !!(rinfo && (rinfo.action === 'restore' || rinfo.action === 'kept'));      // the website kept it (or put it back): the row returns with the reason
      if (!isRestore) {
        if (v.removed === true) { if (v.status === 'Cancelled' || v.status === 'No show') continue; }     // released: back only once it works again
        else if (v.claimed === true) continue;      // its row was deleted, cleared or moved: the website has not said to put it back
        // Not claimed yet (the website added it a minute ago; its key reaches the website with the next call), but its row was on the sheet: its
        // key was on a row released this minute, or a new row that waits shows its person. That row was moved ("Delete cells, shift up", a sort
        // over a blank row) and adopts it when it is sent; added again it would be on the sheet twice (RS12-2). The list is asked for again.
        var waits = v.mr ? !!waitMr[String(v.mr)] : (v.kind === 'checkup' && !!waitCk[aajNormName(v.name) + '|' + (aajPhoneOf(v.phone) || '')]);
        if (scan.releasedKeys[v.key] || waits) { out.deferred = true; continue; }
      }
      var cellsText = {}, s = {}, w = {};
      for (var af = 0; af < AAJ_FIELDS.length; af++) {
        var ff = AAJ_FIELDS[af];
        var val = v[ff] === null || v[ff] === undefined ? '' : String(v[ff]);
        if (ff === 'token' && (scan.branch === 'LHR' || scan.branch === 'ISB')) val = '';      // their Token column is kit / material text, never the website's number
        cellsText[ff] = val;
        s[ff] = aajFieldKey(ff, val); w[ff] = s[ff];
      }
      cellsText.pp = v.pp === null || v.pp === undefined ? '' : String(v.pp);
      s.pp = aajFieldKey('pp', cellsText.pp);
      s.healthwire = ''; s.reminder = '';
      var stText = isRestore ? '\u26a0 ' + (rinfo.message || 'Put back.') : '\u2713 Added from the website';
      var ab = { v: v.id, d: scan.listDate, b: scan.branch, s: s, w: w };
      if (v.kind === 'checkup') ab.k = 1;
      out.appends.push({ key: v.key, cells: cellsText, base: JSON.stringify(ab), status: stText, level: isRestore ? 'warn' : 'ok', patient: v.name });
      if (isRestore) out.log.push({ patient: v.name, text: rinfo.message || 'Put back.' });
      out.final['add:' + v.key] = stText;
    }
  }

  var att = 0, ai;
  for (ai = 0; ai < scan.rows.length; ai++) {
    var shown = out.final[scan.rows[ai].r] !== undefined ? out.final[scan.rows[ai].r] : (scan.statusText[scan.rows[ai].r] || '');
    var c0 = String(shown).charAt(0);
    if (c0 === '\u26a0' || c0 === '\u2717') att++;
  }
  for (ai = 0; ai < out.appends.length; ai++) if (out.appends[ai].level !== 'ok') att++;
  out.attention = att;
  return out;
}

// =====================================================================================================
// PART 3. Talking to Google (sheets, triggers, properties) and to the website
// =====================================================================================================

var aajLastRun = null;          // what the last tick did (for the tests and for support)

function aajFmt_(ms, fmt) {
  return Utilities.formatDate(new Date(ms), AAJ.TZ, fmt);
}

function aajErrText_(e) {
  return String(e && e.message ? e.message : e);
}

function aajNewKey_() {
  return 'S-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

/** Document properties, read once per run. */
function aajLoadState_() {
  var props = PropertiesService.getDocumentProperties();
  var all = props.getProperties();
  return {
    props: props,
    all: all,
    get: function (k) { return all[k] === undefined ? null : all[k]; },
    set: function (k, v) {
      var s = String(v);
      if (all[k] !== s) { all[k] = s; props.setProperty(k, s); }
    },
    del: function (k) {
      if (all[k] !== undefined) { delete all[k]; props.deleteProperty(k); }
    }
  };
}

/**
 * The sync secret: kept in the owner's own (private) User Properties by Set up. It is NOT read from Script Properties: every
 * person who can edit this sheet can read those in Project Settings.
 */
function aajSecret_() {
  return PropertiesService.getUserProperties().getProperty('AAJ_SYNC_SECRET');
}

/** Text written back into a cell the way it was shown: a leading = + - @ would become a formula, so it is written as text. */
function aajSafeText_(t) {
  var s = String(t === null || t === undefined ? '' : t);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function aajNewCtx_(st, manual) {
  var t0 = Date.now();
  return { st: st, t0: t0, today: aajFmt_(t0, 'yyyy-MM-dd'), hhmm: aajFmt_(t0, 'HH:mm'), secret: null, log: [], manual: !!manual,
    calls: 0, rows: 0, writes: 0, problems: [] };
}

function aajLog_(ctx, tab, patient, text) {
  ctx.log.push([aajFmt_(Date.now(), 'yyyy-MM-dd HH:mm'), tab || '', patient || '', text]);
}

function aajFlushLog_(ctx) {
  if (!ctx.log.length) return;
  var lines = ctx.log;
  ctx.log = [];
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(AAJ.LOG_TAB) || ss.insertSheet(AAJ.LOG_TAB);
    if (sh.getLastRow() < 1) sh.getRange(1, 1, 1, 4).setValues([['Time', 'Tab', 'Patient', 'What happened']]);
    var start = sh.getLastRow() + 1;
    var vals = [];
    for (var i = 0; i < lines.length; i++) {
      var row = [];
      for (var c = 0; c < 4; c++) row.push("'" + String(lines[i][c]));
      vals.push(row);
    }
    var last = start + vals.length - 1;
    if (last > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), last - sh.getMaxRows());
    sh.getRange(start, 1, vals.length, 4).setValues(vals);
    if (last - 1 > AAJ.LOG_KEEP + 200) sh.deleteRows(2, last - 1 - AAJ.LOG_KEEP);
  } catch (e) { /* the log must never stop the sync */ }
}

function aajTabSheets_(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var out = [];
  for (var i = 0; i < AAJ.TABS.length; i++) out.push({ cfg: AAJ.TABS[i], sheet: ss.getSheetByName(AAJ.TABS[i].tab) });
  return out;
}

/** Adds the four helper columns (Website | Sync key | Sync base | Sync edited) after the last header cell, hides the last three. */
function aajEnsureHelpers_(sh, header) {
  var last = -1, i;
  for (i = 0; i < header.length; i++) if (aajText(header[i]) !== '') last = i;
  var hc = aajFindHelpers(header);
  var need = [];
  if (hc.status < 0) need.push(AAJ.H_STATUS);
  if (hc.key < 0) need.push(AAJ.H_KEY);
  if (hc.base < 0) need.push(AAJ.H_BASE);
  if (hc.edited < 0) need.push(AAJ.H_EDITED);
  if (!need.length) return;
  var start = last + 2;
  var endCol = start + need.length - 1;
  if (endCol > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), endCol - sh.getMaxColumns());
  sh.getRange(1, start, 1, need.length).setValues([need]);
  for (i = 0; i < need.length; i++) if (need[i] !== AAJ.H_STATUS) sh.hideColumns(start + i);
}

/**
 * The tab's header filter spans every used column, the hidden helper columns too, so its sort buttons move whole rows with their keys (a
 * sort of some columns only is still handled by aajFindMoves; this makes it rarer). No filter: one over all rows. One from the first column
 * over the helper columns: left as it is. A narrower one: widened over the same rows, its criteria kept. Returns 'created', 'widened', 'ok'.
 */
function aajEnsureFilter_(sh, hc) {
  var helperEnd = Math.max(hc.status, hc.key, hc.base, hc.edited) + 1;          // 1-based column of the last helper column
  if (helperEnd < 1) return 'ok';
  var f = sh.getFilter();
  if (f) {
    var rg = f.getRange();
    var c0 = rg.getColumn(), c1 = c0 + rg.getNumColumns() - 1;
    if (c0 <= 1 && c1 >= helperEnd) return 'ok';
    var width = Math.max(c1, helperEnd, sh.getLastColumn());
    var crit = [];
    for (var c = c0; c <= c1; c++) {
      var k = f.getColumnFilterCriteria(c);
      if (k) crit.push({ c: c, k: k });
    }
    var r0 = rg.getRow(), nr = rg.getNumRows();
    f.remove();
    var nf = sh.getRange(r0, 1, nr, width).createFilter();
    for (var i = 0; i < crit.length; i++) nf.setColumnFilterCriteria(crit[i].c, crit[i].k);
    return 'widened';
  }
  sh.getRange(1, 1, sh.getMaxRows(), Math.max(helperEnd, sh.getLastColumn())).createFilter();
  return 'created';
}

/**
 * The Google Sheets tables of this spreadsheet, read once per run with the Advanced Sheets service (appsscript.json enables it as "Sheets"):
 * {id, tables: {sheetId: [table]}}, or {off: why} when the service is not turned on or does not answer. The real branch tabs are tables
 * (Gulshan_KHI A1:M123 and so on, RS12-3).
 */
function aajTables_(ctx) {
  if (ctx.tables) return ctx.tables;
  var out;
  if (typeof Sheets === 'undefined' || !Sheets || !Sheets.Spreadsheets) out = { off: 'the Google Sheets API service is not turned on in the script' };
  else {
    try {
      var id = SpreadsheetApp.getActiveSpreadsheet().getId();
      var got = Sheets.Spreadsheets.get(id, { fields: 'sheets(properties(sheetId,title),tables(tableId,name,range))' });
      var by = {}, list = (got && got.sheets) || [];
      for (var i = 0; i < list.length; i++) by[(list[i].properties && list[i].properties.sheetId) || 0] = list[i].tables || [];     // (a 0 is left out of the answer)
      out = { id: id, tables: by };
    } catch (e) { out = { off: 'the Google Sheets API did not answer: ' + aajErrText_(e) }; }
  }
  ctx.tables = out;
  return out;
}

/** The table of a tab's list (the one holding row 1 and the name column), or null when the tab is not a table. */
function aajListTable_(tb, s) {
  var list = tb.tables[s.sheet.getSheetId()] || [];
  for (var i = 0; i < list.length; i++) {
    var g = list[i].range || {};
    if (!(g.startRowIndex || 0) && (g.startColumnIndex || 0) <= s.cols.name && s.cols.name < (g.endColumnIndex || 0)) return list[i];
  }
  return null;
}

/**
 * A tab that is a table: the table must reach over the hidden helper columns, because a table's sort moves only its own columns and the keys
 * would stay behind. Its range is widened to the last helper column; its rows (header and footer too), its columns and their types stay as
 * they are. Returns 'widened' or 'ok'.
 */
function aajWidenTable_(tb, s, t, helperEnd) {
  var g = t.range || {}, i;
  if ((g.endColumnIndex || 0) >= helperEnd) return 'ok';
  Sheets.Spreadsheets.batchUpdate({ requests: [{ updateTable: { table: { tableId: t.tableId, range: { sheetId: s.sheet.getSheetId(), startRowIndex: g.startRowIndex || 0,
    endRowIndex: g.endRowIndex, startColumnIndex: g.startColumnIndex || 0, endColumnIndex: helperEnd } }, fields: 'range' } }] }, tb.id);
  var hide = [s.hc.key, s.hc.base, s.hc.edited];
  for (i = 0; i < hide.length; i++) if (!s.sheet.isColumnHiddenByUser(hide[i] + 1)) s.sheet.hideColumns(hide[i] + 1);
  return 'widened';
}

var AAJ_TABLE_HOW = ' Dr. Ali: drag the right edge of the table over the hidden columns (Sync key, Sync base, Sync edited), or turn the table into a normal range (table menu, Convert to range), then run Set up again. See the setup guide.';

/**
 * Makes a tab's sort move whole rows, hidden helper columns included: a table is widened over them (aajWidenTable_); a tab that is not a
 * table gets a header filter over them (aajEnsureFilter_; never over a table, Google refuses). When the Advanced Sheets service is off or
 * refuses, nothing is changed and the log says what to do by hand (once a day). Set up, and a full-read tick every FILTER_EVERY_MS.
 */
function aajFilterTab_(ctx, s, fromTick) {
  var st = ctx.st, nowMs = Date.now(), tab = s.cfg.tab;
  if (fromTick) {
    // (helper columns made again this minute, aajReadTab_: right of the table, so it is widened now, not ten minutes later)
    if (!s.helpersMade && nowMs - (Number(st.get('filterAt:' + tab)) || 0) < AAJ.FILTER_EVERY_MS) return;
    st.set('filterAt:' + tab, nowMs);
  }
  var tb = aajTables_(ctx);
  var problem = function (text) {
    ctx.tableNote = text;
    if (fromTick && st.get('filterErr:' + tab) === ctx.today) return;
    st.set('filterErr:' + tab, ctx.today);
    aajLog_(ctx, tab, '', text);
  };
  if (tb.off) {
    problem('Could not check whether this tab is a table (' + tb.off + '). If it is one, sorting it leaves the hidden columns behind. Dr. Ali: add the Google Sheets API in the script editor (Services, +) and run Set up again. See the setup guide.');
    return;
  }
  var t = aajListTable_(tb, s), done;
  try {
    if (t) {
      done = aajWidenTable_(tb, s, t, Math.max(s.hc.status, s.hc.key, s.hc.base, s.hc.edited) + 1);
      if (done === 'widened') aajLog_(ctx, tab, '', 'The table now reaches over the hidden columns, so its sort moves whole rows.');
    } else {
      done = aajEnsureFilter_(s.sheet, s.hc);
      if (done === 'created') aajLog_(ctx, tab, '', 'A filter was added to row 1 (it covers the hidden columns too). Sort with its buttons in row 1.');
      else if (done === 'widened') aajLog_(ctx, tab, '', 'The filter in row 1 now covers the hidden columns too, so its sort buttons move whole rows.');
    }
    st.del('filterErr:' + tab);
  } catch (e) {
    if (t) problem('The table could not be made to reach over the hidden columns (' + aajErrText_(e) + '). Sorting it leaves them behind.' + AAJ_TABLE_HOW);
    else problem('The filter in row 1 could not be set (' + aajErrText_(e) + '). The sync works without it; to sort, select every column first.');
  }
}

/** Reads a tab into s.grid / s.cols / s.hc (creating the helper columns when they are missing). s.problem says why not. */
function aajReadTab_(s) {
  s.problem = null; s.helpersMade = false;
  var sh = s.sheet;
  var lastRow = Math.min(sh.getLastRow(), AAJ.MAX_READ_ROWS), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) { s.problem = 'row 1 does not look like the list header'; return; }
  var grid = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  if (!aajIsHeaderRow(grid[0])) { s.problem = 'row 1 does not look like the list header'; return; }
  var hc = aajFindHelpers(grid[0]);
  if (hc.status < 0 || hc.key < 0 || hc.base < 0 || hc.edited < 0) {
    aajEnsureHelpers_(sh, grid[0]);
    s.helpersMade = true;
    lastRow = Math.min(sh.getLastRow(), AAJ.MAX_READ_ROWS); lastCol = sh.getLastColumn();
    grid = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
    hc = aajFindHelpers(grid[0]);
  }
  s.grid = grid; s.hc = hc; s.cols = aajDetectColumns(grid[0]);
}

/** Writes values into one column for the given rows ({row: value}); neighbouring rows are written together, nothing in between is touched. */
function aajWriteRuns_(sh, col1, byRow) {
  var rows = [], k;
  for (k in byRow) if (Object.prototype.hasOwnProperty.call(byRow, k)) rows.push(Number(k));
  rows.sort(function (a, b) { return a - b; });
  var i = 0;
  while (i < rows.length) {
    var j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
    var vals = [];
    for (var x = i; x <= j; x++) vals.push([byRow[rows[x]]]);
    sh.getRange(rows[i], col1, j - i + 1, 1).setValues(vals);
    i = j + 1;
  }
}

/** One call to the website. Returns {ok, resp} or {ok:false, kind: secret|busy|timeout|date|net|other, message}. */
function aajCallRpc_(secret, payload) {
  var resp;
  try {
    resp = UrlFetchApp.fetch(AAJ.URL + '/rest/v1/rpc/aaj_sync', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: { apikey: AAJ.KEY, Authorization: 'Bearer ' + AAJ.KEY },
      payload: JSON.stringify({ p_secret: secret, p_payload: payload })
    });
  } catch (e) { return { ok: false, kind: 'net', message: aajErrText_(e) }; }
  var code = resp.getResponseCode();
  var text = String(resp.getContentText() || '');
  var body = null;
  try { body = JSON.parse(text); } catch (e2) { body = null; }
  if (code >= 200 && code < 300 && body && body.ok === true) return { ok: true, resp: body };
  var pg = body && body.code ? String(body.code) : '';
  var msg = body && body.message ? String(body.message) : text.slice(0, 200);
  if (pg === '42501' || /^Not allowed/.test(msg)) return { ok: false, kind: 'secret', message: msg };
  if (pg === '55P03' || /^BUSY/.test(msg) || pg === '54000' || /^RATE_LIMIT/.test(msg)) return { ok: false, kind: 'busy', message: msg };      // BUSY, or too many calls in a minute: wait and try again
  if (pg === '57014' || /statement timeout/i.test(msg)) return { ok: false, kind: 'timeout', message: msg };
  if (/DATE_NOT_ALLOWED/.test(msg)) return { ok: false, kind: 'date', message: msg };
  return { ok: false, kind: 'other', message: 'HTTP ' + code + ' ' + msg };
}

/** Writes the tab summary into the Website header cell. Rewritten when it changes, or when it is older than HEADER_REFRESH_MS. */
function aajSetHeader_(ctx, s, text) {
  if (!s.sheet || !s.hc || s.hc.status < 0) return;
  var cur = s.grid ? aajText(s.grid[0][s.hc.status]) : '';
  if (cur === text) return;
  var last = Number(ctx.st.get('hdr:' + s.cfg.tab)) || 0;
  var now = Date.now();
  if (cur !== '' && aajHeaderState(cur) === aajHeaderState(text) && (now - last) < AAJ.HEADER_REFRESH_MS) return;
  s.sheet.getRange(1, s.hc.status + 1).setValue(text);
  ctx.st.set('hdr:' + s.cfg.tab, now);
  if (s.grid) s.grid[0][s.hc.status] = text;
}

/** Header write for a tab that has not been read in full (not set up, paused). Never creates columns. */
function aajSetHeaderLight_(ctx, s, text) {
  if (!s.sheet) return;
  var lastCol = s.sheet.getLastColumn();
  if (lastCol < 1) return;
  var header = s.sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var hc = aajFindHelpers(header);
  if (hc.status < 0) return;
  s.hc = hc;
  s.grid = [header];
  aajSetHeader_(ctx, s, text);
}

/** Before the call: new rows get their key (and first-sight stamp) written into the sheet, so a retry can never double them. */
function aajPrewrite_(ctx, e) {
  var sc = e.scan, sh = e.sheet, hc = e.hc, i;
  if (!sc.newKeys.length && !sc.stamps.length && !sc.releases.length && !sc.swaps.length) return;
  var n = sc.grid.length - 1;
  if (n >= 1) {
    var names = sh.getRange(2, e.cols.name + 1, n, 1).getDisplayValues();
    var moved = false;
    for (i = 1; i < sc.grid.length; i++) {
      if (aajText(names[i - 1][0]) !== aajText(sc.grid[i][e.cols.name])) { moved = true; break; }
    }
    if (moved) {
      for (i = 0; i < sc.rows.length; i++) if (sc.rows[i].state === 'new' || sc.rows[i].swapped) sc.rows[i].push = false;
      aajLog_(ctx, e.cfg.tab, '', 'The sheet changed while it was being read. New rows wait for the next minute.');
      return;
    }
  }
  var keys = {}, bases = {}, stamps = {}, blank = {}, st = {}, ed = {};
  // rows that only changed places (a sort of the visible columns): each gets the key, memory and edit time of the person now in it
  for (i = 0; i < sc.swaps.length; i++) {
    var sw = sc.swaps[i];
    keys[sw.r] = sw.key; bases[sw.r] = sw.base;
    if (sw.edited !== undefined && hc.edited >= 0 && aajText(sc.grid[sw.r - 1][hc.edited]) !== sw.edited) stamps[sw.r] = sw.edited ? "'" + sw.edited : '';
  }
  // a new key goes with what it will be sent with (base.p): if the answer never comes back, the next minute knows whether the row still
  // shows that person (aajScanTab, SB7-1)
  for (i = 0; i < sc.newKeys.length; i++) {
    keys[sc.newKeys[i].r] = sc.newKeys[i].key;
    bases[sc.newKeys[i].r] = sc.newKeys[i].pending || '';
  }
  for (i = 0; i < sc.stamps.length; i++) stamps[sc.stamps[i].r] = "'" + String(sc.stamps[i].ms);
  for (i = 0; i < sc.releases.length; i++) { blank[sc.releases[i]] = ''; }
  aajWriteRuns_(sh, hc.key + 1, keys);
  aajWriteRuns_(sh, hc.base + 1, bases);
  aajWriteRuns_(sh, hc.edited + 1, stamps);
  if (sc.releases.length) {
    aajWriteRuns_(sh, hc.key + 1, blank);
    aajWriteRuns_(sh, hc.base + 1, blank);
    aajWriteRuns_(sh, hc.edited + 1, blank);
    aajWriteRuns_(sh, hc.status + 1, blank);
  }
}

/** Sends the rows in batches. Returns what came back, per tab (index in `live`). */
function aajRunCalls_(ctx, date, live, opts) {
  var st = ctx.st;
  var batch = Number(st.get('batch')) || AAJ.BATCH;
  if (st.get('batchDay') !== ctx.today) { batch = AAJ.BATCH; st.set('batch', batch); st.set('batchDay', ctx.today); }
  var refs = [], si, k;
  for (si = 0; si < live.length; si++) {
    for (k = 0; k < live[si].scan.rows.length; k++) if (live[si].scan.rows[k].push) refs.push({ si: si, row: live[si].scan.rows[k] });
  }
  var info = { okCalls: 0, failed: null, results: [], pushed: [], latest: [] };
  for (si = 0; si < live.length; si++) { info.results.push({}); info.pushed.push({}); info.latest.push(null); }
  var i = 0;
  while (true) {
    if (info.okCalls > 0 && (Date.now() - ctx.t0) > AAJ.SOFT_DEADLINE_MS) { info.failed = { kind: 'deadline', message: 'out of time' }; break; }
    var chunk = refs.slice(i, i + batch);
    var isLast = (i + batch) >= refs.length;
    var payload = aajBuildPayload(date, live, chunk, isLast && opts.checkRemoved !== false);
    ctx.calls++;
    var r = aajCallRpc_(ctx.secret, payload);
    if (!r.ok) {
      if (r.kind === 'timeout' && batch > AAJ.MIN_BATCH && chunk.length > 0) {
        batch = Math.max(AAJ.MIN_BATCH, Math.floor(batch / 2));
        st.set('batch', batch); st.set('batchDay', ctx.today);
        aajLog_(ctx, '', '', 'The website was slow. Sending ' + batch + ' rows at a time.');
        continue;
      }
      info.failed = r;
      break;
    }
    info.okCalls++;
    var tabs = r.resp.tabs || [];
    for (si = 0; si < live.length; si++) {
      var tr = null;
      for (var t = 0; t < tabs.length; t++) if (tabs[t].branch === live[si].cfg.branch) { tr = tabs[t]; break; }
      if (!tr) continue;
      var res = tr.results || [];
      for (var q = 0; q < res.length; q++) if (res[q] && res[q].key) info.results[si][res[q].key] = res[q];
      var prev = info.latest[si];
      info.latest[si] = { hash: tr.hash, visits: tr.visits ? tr.visits : (prev ? prev.visits : null), removed: tr.removed || [], unchanged: !!tr.unchanged };
      live[si].hash = tr.hash;
    }
    for (var c = 0; c < chunk.length; c++) {
      var fl = {};
      for (var fi = 0; fi < chunk[c].row.fields.length; fi++) fl[chunk[c].row.fields[fi]] = true;
      info.pushed[chunk[c].si][chunk[c].row.key] = fl;
    }
    ctx.rows += chunk.length;
    if (isLast) break;
    i += chunk.length;
  }
  // The website said "put back" for some visits but sent no list because its hash did not change: ask once for the full list.
  var need = [];
  for (si = 0; si < live.length; si++) {
    var lt = info.latest[si];
    if (!lt || lt.visits) continue;
    for (k = 0; k < lt.removed.length; k++) if (lt.removed[k].action === 'restore' || lt.removed[k].action === 'kept') { need.push(si); break; }
  }
  if (need.length && info.okCalls > 0) {
    for (k = 0; k < need.length; k++) live[need[k]].hash = null;
    ctx.calls++;
    var again = aajCallRpc_(ctx.secret, aajBuildPayload(date, live, [], false));
    if (again.ok) {
      var at = again.resp.tabs || [];
      for (k = 0; k < need.length; k++) {
        for (var t2 = 0; t2 < at.length; t2++) {
          if (at[t2].branch === live[need[k]].cfg.branch && at[t2].visits) {
            info.latest[need[k]].visits = at[t2].visits;
            info.latest[need[k]].hash = at[t2].hash;
            info.latest[need[k]].unchanged = false;
          }
        }
      }
    }
  }
  return info;
}

/** Re-reads name, key and edit stamp right before writing: has anything moved or been edited since the scan? */
function aajFreshCheck_(e) {
  var sc = e.scan, sh = e.sheet, hc = e.hc;
  var n = sc.grid.length - 1;
  var out = { moved: false, busy: {} };
  if (n < 1) return out;
  var names = sh.getRange(2, e.cols.name + 1, n, 1).getDisplayValues();
  var keys = sh.getRange(2, hc.key + 1, n, 1).getDisplayValues();
  var eds = sh.getRange(2, hc.edited + 1, n, 1).getDisplayValues();
  for (var i = 0; i < sc.rows.length; i++) {
    var row = sc.rows[i], idx = row.r - 2;
    if (idx >= n) { out.moved = true; break; }
    if (aajText(names[idx][0]) !== aajText(sc.grid[row.r - 1][e.cols.name]) || aajText(keys[idx][0]) !== row.key) { out.moved = true; break; }
    if ((Number(aajText(eds[idx][0])) || 0) > sc.nowMs) out.busy[row.r] = true;
  }
  return out;
}

/**
 * The first blank rows after the last patient row (stray cells further down are skipped, never overwritten). A row released this minute
 * (aajPrewrite_ cleared its helper cells before the call) counts as blank when nothing else is in it, so an added row leaves no gap (RS12-2).
 */
function aajFreeRows_(scan, count, maxRows) {
  var rows = [], r = Math.max(scan.lastNamed + 1, 2), hc = scan.hc || {}, rel = {}, i;
  for (i = 0; i < (scan.releases || []).length; i++) rel[scan.releases[i]] = true;
  while (rows.length < count) {
    var blank = true;
    if (r <= scan.grid.length) {
      var cells = scan.grid[r - 1];
      for (var c = 0; c < cells.length; c++) {
        if (rel[r] && (c === hc.status || c === hc.key || c === hc.base || c === hc.edited)) continue;
        if (aajText(cells[c]) !== '') { blank = false; break; }
      }
    }
    if (blank) rows.push(r);
    r++;
  }
  return rows;
}

/** Writes what aajReconcileTab decided. Returns false when something had to be left for the next tick. */
function aajApply_(ctx, e, rec) {
  var sh = e.sheet, hc = e.hc, cols = e.cols, sc = e.scan, ok = true, i, k;
  // 1. cells the website changed: one call per column and run of neighbouring rows (nothing in between is touched,
  //    so a first sync of 100 rows is a handful of calls, not hundreds)
  var byCol = {};
  for (i = 0; i < rec.writes.length; i++) {
    var w = rec.writes[i];
    var cidx = cols[w.f];
    (byCol[cidx] = byCol[cidx] || {})[w.r] = aajCellValue(w.text);
  }
  for (k in byCol) if (Object.prototype.hasOwnProperty.call(byCol, k)) {
    aajWriteRuns_(sh, Number(k) + 1, byCol[k]);
    ctx.writes += Object.keys(byCol[k]).length;
  }
  // 2. key and base of the rows whose memory changed
  var hk = {}, hb = {}, any = false;
  for (k in rec.helper) if (Object.prototype.hasOwnProperty.call(rec.helper, k)) { hk[k] = rec.helper[k].key; hb[k] = rec.helper[k].base; any = true; }
  if (any) {
    aajWriteRuns_(sh, hc.key + 1, hk);
    aajWriteRuns_(sh, hc.base + 1, hb);
  }
  // 3. the Website column (one write for the text, one for the colours)
  var maxR = sc.lastNamed;
  for (k in rec.status) if (Object.prototype.hasOwnProperty.call(rec.status, k)) maxR = Math.max(maxR, Number(k));
  var statusRows = Object.keys(rec.status).length;
  if (statusRows && maxR >= 2) {
    var sv = [], sf = [];
    for (var r = 2; r <= maxR; r++) {
      var text = rec.status[r] ? rec.status[r].text : (sc.statusText[r] || '');
      sv.push([aajSafeText_(text)]);                  // what is already in the column is written back as the sheet showed it: never as a formula
      sf.push([aajStatusColor(text)]);
    }
    sh.getRange(2, hc.status + 1, maxR - 1, 1).setValues(sv);
    sh.getRange(2, hc.status + 1, maxR - 1, 1).setFontColors(sf);
  }
  // 4. website-only visits at the bottom
  if (rec.appends.length) {
    var width = sc.grid[0].length;
    var free = aajFreeRows_(sc, rec.appends.length);
    var needRows = free[free.length - 1];
    if (needRows > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), needRows - sh.getMaxRows());
    var a = 0;
    while (a < rec.appends.length) {
      var b = a;
      while (b + 1 < rec.appends.length && free[b + 1] === free[b] + 1) b++;
      var fresh = sh.getRange(free[a], 1, b - a + 1, width).getDisplayValues();
      var clean = true;
      for (var fr = 0; fr < fresh.length && clean; fr++) for (var fc = 0; fc < fresh[fr].length; fc++) if (aajText(fresh[fr][fc]) !== '') { clean = false; break; }
      if (!clean) { ok = false; a = b + 1; continue; }
      var block = [], colors = [];
      for (var m = a; m <= b; m++) {
        var ap = rec.appends[m];
        var line = [];
        for (var cc = 0; cc < width; cc++) line.push('');
        for (var fi = 0; fi < AAJ_ALL_FIELDS.length; fi++) {
          var f = AAJ_ALL_FIELDS[fi];
          if (cols[f] === undefined || ap.cells[f] === undefined) continue;
          line[cols[f]] = aajCellValue(ap.cells[f]);
        }
        line[hc.status] = aajSafeText_(ap.status);          // text from the website is written as text, never as a formula
        line[hc.key] = aajSafeText_(ap.key);
        line[hc.base] = aajSafeText_(ap.base);
        block.push(line);
        colors.push([aajStatusColor(ap.status)]);
      }
      sh.getRange(free[a], 1, b - a + 1, width).setValues(block);
      sh.getRange(free[a], hc.status + 1, b - a + 1, 1).setFontColors(colors);
      ctx.writes += block.length;
      a = b + 1;
    }
  }
  return ok;
}

/**
 * Reads the given tabs, sends what changed, writes what came back. Used by the one-minute tick (date = today) and by the
 * last flush before the archive (date = yesterday, opts.final).
 */
function aajSyncTabs_(ctx, entries, date, opts) {
  opts = opts || {};
  var st = ctx.st, nowMs = Date.now(), live = [], i, e;
  var pending = false;             // something is waiting for the next minute (a new row settling, a write put off): the next tick must read the tabs again
  for (i = 0; i < entries.length; i++) {
    e = entries[i];
    aajReadTab_(e);
    if (e.problem) { aajLog_(ctx, e.cfg.tab, '', e.cfg.tab + ': ' + e.problem + '. This tab is skipped.'); st.set('prob:' + e.cfg.tab, '1'); continue; }
    st.del('prob:' + e.cfg.tab);
    if (!opts.final) aajFilterTab_(ctx, e, true);     // the header filter (put back if removed)
    e.scan = aajScanTab(e.grid, e.cols, e.hc, nowMs, date, { newKey: aajNewKey_, final: !!opts.final, busyMs: AAJ.BUSY_MS, branch: e.cfg.branch,
      setupStamp: Number(st.get('setupStamp:' + e.cfg.tab)) || 0 });
    var emptyKey = 'empty:' + e.cfg.tab;
    if (e.scan.tooMany || e.scan.tooLong) {
      st.set('prob:' + e.cfg.tab, '1');
      aajSetHeader_(ctx, e, aajHeaderText('error', ctx.hhmm, e.scan.tooMany ? 'more than ' + AAJ.MAX_ROWS + ' rows of today: check the tab (rows of earlier days do not count)'
        : 'the list reaches row ' + e.scan.lastNamed + ': delete rows of earlier days (they are in the archive)'));
      continue;
    }
    if (e.scan.named - e.scan.kept === 0) {           // no row of today (kept rows of earlier days do not count: a tab cleared of today's rows)
      var n = (Number(st.get(emptyKey)) || 0) + 1;
      st.set(emptyKey, n);
      if (!opts.final && n < AAJ.EMPTY_TICKS) { aajSetHeader_(ctx, e, aajHeaderText('ok', ctx.hhmm)); pending = true; continue; }
    } else st.del(emptyKey);
    e.hash = st.get('hash:' + e.cfg.tab);
    live.push(e);
  }
  if (!live.length) return { ok: true, pending: pending, lists: {} };
  for (i = 0; i < live.length; i++) aajPrewrite_(ctx, live[i]);
  // While a row is still settling (typed or moved a moment ago) or a name was just cleared, the website is not asked to remove the rows that
  // "disappeared": the row may only have been moved or retyped, and the visit must be adopted by it, not deleted (and made again 60 s later).
  var settling = false;
  for (i = 0; i < live.length; i++) {
    if (live[i].scan.releaseBusy || live[i].scan.unanswered) settling = true;
    for (var sk = 0; sk < live[i].scan.rows.length; sk++) {
      var srw = live[i].scan.rows[sk];
      if (((srw.rekeyed || srw.state === 'new') && !srw.push && !srw.bad) || srw.held) settling = true;
    }
  }
  var runOpts = {};
  for (var ok in opts) if (Object.prototype.hasOwnProperty.call(opts, ok)) runOpts[ok] = opts[ok];
  if (settling) { runOpts.checkRemoved = false; pending = true; }
  var info = aajRunCalls_(ctx, date, live, runOpts);
  var failMsg = null;
  if (info.okCalls === 0 && info.failed) {
    if (info.failed.kind === 'secret') failMsg = 'sync secret not accepted. Dr. Ali: Aaj Sync > Set up';
    else if (info.failed.kind === 'date') failMsg = 'date not accepted by the website';
    else if (info.failed.kind === 'busy') {
      // a busy website is normal for a minute; several in a row are shown, so a stuck website does not look like "all fine"
      var busyN = (Number(st.get('busyN')) || 0) + 1;
      st.set('busyN', busyN);
      if (busyN >= AAJ.BUSY_SHOW) failMsg = 'the website is busy, trying again';
    } else failMsg = 'not syncing: the website did not answer';
    if (info.failed.kind !== 'busy') aajLog_(ctx, '', '', 'Sync failed: ' + info.failed.message);
    if (failMsg) for (i = 0; i < live.length; i++) aajSetHeader_(ctx, live[i], aajHeaderText('error', ctx.hhmm, failMsg));
    return { ok: false, pending: true, lists: {} };
  }
  st.del('busyN');
  if (info.failed && info.failed.kind !== 'deadline') aajLog_(ctx, '', '', 'Sync stopped part way: ' + info.failed.message);
  var lists = {};                  // the website's list of the day per tab (the last flush before the archive copies the patients taken off the sheet from it)
  for (i = 0; i < live.length; i++) {
    e = live[i];
    var tr = info.latest[i];
    if (!tr) continue;
    lists[e.cfg.tab] = tr.visits || null;
    var rctx = { nowMs: nowMs, results: info.results[i], pushed: info.pushed[i], extraBusy: {}, listDate: date };
    var rec = aajReconcileTab(e.scan, tr, rctx);
    var hasWork = rec.writes.length || rec.appends.length || Object.keys(rec.helper).length || Object.keys(rec.status).length;
    var skip = false;
    if (hasWork) {
      var fresh = aajFreshCheck_(e);
      if (fresh.moved) skip = true;
      else if (Object.keys(fresh.busy).length) { rctx.extraBusy = fresh.busy; rec = aajReconcileTab(e.scan, tr, rctx); }
    }
    var applied = true;
    if (skip) {
      applied = false;
      pending = true;
      aajLog_(ctx, e.cfg.tab, '', 'The sheet changed while the website was answering. Nothing was written this minute.');
    } else if (hasWork) {
      applied = aajApply_(ctx, e, rec);
      for (var li = 0; li < rec.log.length; li++) aajLog_(ctx, e.cfg.tab, rec.log[li].patient, rec.log[li].text);
    }
    var removedList = tr.removed || [];
    for (var ri = 0; ri < removedList.length; ri++) {
      var rm = removedList[ri];
      if (rm.action === 'deleted' || rm.action === 'kept' || rm.action === 'released') aajLog_(ctx, e.cfg.tab, rm.name || '', rm.message || 'A row was deleted in the sheet.');
    }
    if (applied && !rec.deferred && tr.hash) st.set('hash:' + e.cfg.tab, tr.hash);
    if (!applied || rec.deferred || rec.again || rec.appends.length) pending = true;      // appended rows are claimed by the next call (their key is in "present" then)
    for (var pr = 0; pr < e.scan.rows.length; pr++) {
      var prw = e.scan.rows[pr];
      if ((prw.state === 'new' && !prw.push && !prw.bad) || prw.held) pending = true;      // a new row (or a row being typed over) waits for its 60 quiet seconds
    }
    if (!skip) {
      var att = rec.attention;
      aajSetHeader_(ctx, e, att > 0 ? aajHeaderText('attention', ctx.hhmm, att) : aajHeaderText('ok', ctx.hhmm));
    }
  }
  if (info.failed) pending = true;
  return { ok: !(info.failed && info.failed.kind !== 'deadline'), pending: pending, lists: lists };
}

// ---------- the one-minute tick ----------

function aajSyncTick() { aajRunLocked_(false); }

function aajSyncNow() {
  var st = aajLoadState_();
  var any = false;
  for (var i = 0; i < AAJ.TABS.length; i++) if (st.get('listDate:' + AAJ.TABS[i].tab)) any = true;
  var ui = SpreadsheetApp.getUi();
  if (!any) {
    ui.alert('Aaj Sync', 'Run "Set up or repair (Dr. Ali)" first.', ui.ButtonSet.OK);
    return;
  }
  if (!aajSecret_()) {
    // another person who can edit the sheet: the sync secret belongs to Dr. Ali's account only
    ui.alert('Aaj Sync', 'The sync runs by itself every minute. Only Dr. Ali\'s account can start it by hand.', ui.ButtonSet.OK);
    return;
  }
  aajRunLocked_(true);
}

function aajRunLocked_(manual) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(manual ? 20000 : 1000)) return;
  try {
    aajTick_(manual);
  } catch (e) {
    aajLastRun = { error: aajErrText_(e) };
    try {
      var ctx = aajNewCtx_(aajLoadState_(), manual);
      aajLog_(ctx, '', '', 'Sync error: ' + aajErrText_(e));
      aajFlushLog_(ctx);
    } catch (e2) { /* nothing more can be done */ }
  } finally {
    lock.releaseLock();
  }
}

function aajTick_(manual) {
  var st = aajLoadState_();
  var ctx = aajNewCtx_(st, manual);
  var rtKey = 'rt:' + ctx.today;
  var rt = Number(st.get(rtKey)) || 0;
  var worked = false;
  try {
    // run time of the day = the minute ticks + the on-edit runs (aajOnEdit adds its own share under "rte:")
    worked = aajTickWork_(ctx, st, manual, rt + (Number(st.get('rte:' + ctx.today)) || 0));
  } finally {
    // the day's run time is counted even when the run is cut short by an error
    var ms = Date.now() - ctx.t0;
    if (worked || ctx.counted || ctx.calls || ctx.log.length) st.set(rtKey, rt + ms);
    aajFlushLog_(ctx);
    aajLastRun = { calls: ctx.calls, rows: ctx.rows, writes: ctx.writes, ms: ms, hhmm: ctx.hhmm };
  }
}

/**
 * Has nothing been typed or deleted in the sheet since the tabs were last read in full (no on-edit / on-change mark, nothing waiting),
 * and was that less than five minutes ago? Then a minute only needs one question to the website: "anything new?"
 */
function aajQuietNow_(st, active) {
  if (st.get('dirty')) return false;
  if (Date.now() - (Number(st.get('fullAt')) || 0) >= AAJ.FULL_EVERY_MS) return false;
  var any = false;
  for (var i = 0; i < active.length; i++) {
    if (st.get('hash:' + active[i].cfg.tab)) any = true;
    else if (!st.get('prob:' + active[i].cfg.tab)) return false;       // a tab the website has not answered for yet (a tab with a problem is left out)
  }
  return any;
}

/** The one question: every tab with the hash of the list the sheet already shows, no rows, no list of present rows (so nothing is claimed or removed). */
function aajQuickCall_(ctx, active) {
  var tabs = [], i;
  for (i = 0; i < active.length; i++) {
    var h = ctx.st.get('hash:' + active[i].cfg.tab);
    if (h) tabs.push({ branch: active[i].cfg.branch, tab: active[i].cfg.tab, hash: h, rows: [] });
  }
  ctx.calls++;
  var r = aajCallRpc_(ctx.secret, { date: ctx.today, check_removed: false, keep_rows: true, tabs: tabs });
  if (!r.ok) return false;                                 // anything unusual: the full run below deals with it (and shows it in the headings)
  var back = r.resp.tabs || [];
  if (back.length !== tabs.length) return false;
  for (i = 0; i < back.length; i++) if (back[i].unchanged !== true) return false;
  ctx.st.del('busyN');
  return true;
}

/** The work of one tick. Returns true when it synced the tabs (so that the run time is counted). */
function aajTickWork_(ctx, st, manual, rt) {
  var i, s, k;
  var minute = Number(ctx.hhmm.slice(3));
  for (k in st.all) if (Object.prototype.hasOwnProperty.call(st.all, k)) {
    if ((k.indexOf('rt:') === 0 || k.indexOf('rte:') === 0 || k.indexOf('paused:') === 0) && k.slice(k.indexOf(':') + 1) !== ctx.today) st.del(k);
  }
  var sheets = aajTabSheets_();
  if (!manual && rt > AAJ.RUNTIME_STOP_MS) {
    if (!st.get('paused:' + ctx.today)) {
      for (i = 0; i < sheets.length; i++) if (sheets[i].sheet) aajSetHeaderLight_(ctx, sheets[i], aajHeaderText('plain', ctx.hhmm, 'paused for today (Google time limit). Use the website.'));
      st.set('paused:' + ctx.today, '1');
    }
    return false;
  }
  if (!manual && rt > AAJ.RUNTIME_SLOW_MS && minute % 5 !== 0) return false;
  // older rows first (copied to the archive and marked; they stay on the tab): each tab is archived under the day it holds
  for (i = 0; i < sheets.length; i++) {
    s = sheets[i];
    if (!s.sheet) continue;
    var ld = st.get('listDate:' + s.cfg.tab);
    if (ld && ld < ctx.today && ctx.hhmm >= AAJ.ARCHIVE_FROM) {
      try { aajArchiveTab_(ctx, s, {}); } catch (e1) { aajLog_(ctx, s.cfg.tab, '', 'Archive problem: ' + aajErrText_(e1)); }
    }
  }
  var counted = false;
  if (manual || ctx.hhmm >= AAJ.ACTIVE_FROM) {
    var active = [];
    for (i = 0; i < sheets.length; i++) {
      s = sheets[i];
      if (!s.sheet) {
        if (st.get('missing:' + s.cfg.tab) !== ctx.today) { aajLog_(ctx, s.cfg.tab, '', 'The tab "' + s.cfg.tab + '" was not found.'); st.set('missing:' + s.cfg.tab, ctx.today); }
        continue;
      }
      var ld2 = st.get('listDate:' + s.cfg.tab);
      if (!ld2) { aajSetHeaderLight_(ctx, s, aajHeaderText('plain', ctx.hhmm, '\u2717 not set up. Dr. Ali: Aaj Sync > Set up')); continue; }
      if (ld2 !== ctx.today) { aajSetHeaderLight_(ctx, s, aajHeaderText('plain', ctx.hhmm, '\u2717 the rows of ' + ld2 + ' are not archived yet')); continue; }
      active.push(s);
    }
    if (active.length) {
      ctx.secret = aajSecret_();
      if (!ctx.secret) {
        for (i = 0; i < active.length; i++) aajSetHeaderLight_(ctx, active[i], aajHeaderText('plain', ctx.hhmm, '\u2717 not set up. Dr. Ali: Aaj Sync > Set up'));
      } else {
        counted = true; ctx.counted = true;
        var d0 = st.get('dirty');
        if (!manual && aajQuietNow_(st, active) && aajQuickCall_(ctx, active)) {
          // nothing new on either side: one question, no sheet reading
        } else {
          var run = aajSyncTabs_(ctx, active, ctx.today, { checkRemoved: true });
          if (run.ok) { st.set('fullAt', Date.now()); st.set('lastOkAt', Date.now()); }
          // something left waiting (a new row settling, a write put off, a failed call): the next minute reads the tabs again.
          // The "typed or deleted something" mark goes only when nothing is left waiting and nobody edited during this run.
          if (!run.ok || run.pending) { if (!d0) st.set('dirty', String(Date.now())); }
          else if (d0 && PropertiesService.getDocumentProperties().getProperty('dirty') === d0) st.del('dirty');
        }
      }
    }
    if (!manual) aajCheckupRetry_(ctx);
  }
  return counted;
}

// ---------- the nightly archive ----------

/** The chunks are written first and the head last: a run that dies half way leaves no head (no marker) rather than a head with rows missing. */
function aajSaveMarker_(st, tab, marker) {
  var chunkSize = 60, n = 0, i;
  var rows = marker.rows;
  var head = { date: marker.date, phase: marker.phase, at: marker.at, chunks: Math.max(1, Math.ceil(rows.length / chunkSize)) };
  for (i = 0; i < head.chunks; i++) st.set('arch:' + tab + ':' + i, JSON.stringify(rows.slice(i * chunkSize, (i + 1) * chunkSize)));
  st.set('arch:' + tab, JSON.stringify(head));
  for (i = head.chunks; i < head.chunks + 40; i++) { if (st.get('arch:' + tab + ':' + i) === null) break; st.del('arch:' + tab + ':' + i); }
  return n;
}

/** The marker, or null when there is none or it is damaged (a missing chunk): the tab is then copied again, which is safe (see aajArchiveAppend_). */
function aajLoadMarker_(st, tab) {
  var raw = st.get('arch:' + tab);
  if (!raw) return null;
  try {
    var head = JSON.parse(raw);
    var rows = [];
    for (var i = 0; i < head.chunks; i++) {
      var chunk = st.get('arch:' + tab + ':' + i);
      if (chunk === null) return null;
      rows = rows.concat(JSON.parse(chunk));
    }
    return { date: head.date, phase: head.phase, at: head.at, rows: rows };
  } catch (e) { return null; }
}

function aajDeleteMarker_(st, tab) {
  st.del('arch:' + tab);
  for (var i = 0; i < 80; i++) { if (st.get('arch:' + tab + ':' + i) === null && i > 0) break; st.del('arch:' + tab + ':' + i); }
}

/**
 * The archive spreadsheet. A new one is made only when Google says the old one is gone; any other error (a Google hiccup) is
 * thrown, so nothing is cleared and the next minute tries again. Only after five failed minutes in a row is a new one made.
 */
function aajArchiveBook_(ctx) {
  var id = ctx.st.get('archiveId');
  if (id) {
    try {
      var found = SpreadsheetApp.openById(id);
      ctx.st.del('archFail');
      return found;
    } catch (e) {
      var gone = /missing|deleted|trash|not found|does not exist/i.test(aajErrText_(e));
      var fails = (Number(ctx.st.get('archFail')) || 0) + 1;
      if (!gone && fails < 5) {
        ctx.st.set('archFail', fails);
        throw new Error('The archive spreadsheet could not be opened right now (' + aajErrText_(e) + '). Trying again next minute.');
      }
      ctx.st.del('archFail');
      aajLog_(ctx, '', '', 'The archive spreadsheet could not be opened' + (gone ? ' (it was deleted)' : ' five times in a row') + '. A new one is made.');
    }
  }
  var book = SpreadsheetApp.create(AAJ.ARCHIVE_NAME);
  ctx.st.set('archiveId', book.getId());
  return book;
}

/**
 * The columns that hold the list: every column of the tab except our four helper columns, so a column the staff added to the right of
 * them ("Staff notes") is copied to the archive like the others.
 */
function aajDataCols_(s) {
  var skip = {}, out = [], n = (s.grid && s.grid[0]) ? s.grid[0].length : 0;
  skip[s.hc.status] = true; skip[s.hc.key] = true; skip[s.hc.base] = true; skip[s.hc.edited] = true;
  for (var i = 0; i < n; i++) if (!skip[i]) out.push(i);
  return out;
}

/** Is there anything in one of the list's columns of this row? */
function aajRowHasData_(cells, dcs) {
  for (var i = 0; i < dcs.length; i++) if (aajText(cells[dcs[i]]) !== '') return true;
  return false;
}

function aajRowFp_(cells, s) {
  var parts = [aajText(s.hc.key >= 0 ? cells[s.hc.key] : '')];
  var dcs = aajDataCols_(s);
  for (var i = 0; i < dcs.length; i++) parts.push(aajCollapse(cells[dcs[i]]));
  return aajHash32(parts.join('\u0001'));
}

/**
 * The patient rows (a name) of the tab at night, sorted into what the archive does with them. Nothing is cleared any more (owner, 17 Oct
 * 2026), so a stray cell or a row without a name stays where it is and is not copied. Returns { copy: [...], mark: [...], today: n }:
 *  - copy: the rows of the day being archived (day), each copied once and then marked (aajMarkBase_).
 *  - mark: rows an older version of this script left behind after its nightly clear (an earlier day, not edited since that day, still that
 *    day's person: they were archived on their own night): marked under their own day, never copied a second time nor put on the checkup
 *    list again.
 *  - today: rows edited at or after keepFromMs (typed today while the website had lost touch with the tab: they belong to the new day and
 *    are sent as today's rows, not archived under the old date).
 * A row archived on an earlier night (base.a) that still shows that person is a kept row: left alone. A kept row a new patient was typed
 * over is a row of the day again (aajPendingMoved, the rule of aajScanTab).
 */
function aajArchiveRows_(s, keepFromMs, day) {
  var out = { copy: [], mark: [], today: 0 };
  if (s.cols.name === undefined) return out;
  for (var i = 1; i < s.grid.length; i++) {
    var cells = s.grid[i];
    if (aajText(cells[s.cols.name]) === '') continue;
    var edited = Number(aajText(s.hc.edited >= 0 ? cells[s.hc.edited] : '')) || 0;
    var key = aajText(cells[s.hc.key]);
    if (!AAJ_KEY_RE.test(key)) key = '';
    var base = key ? aajParseBase(aajText(cells[s.hc.base])) : null;
    var same = !!base && !aajPendingMoved(cells, s.cols, base.s || {});
    if (same && base.a) continue;
    var fp = aajRowFp_(cells, s), idh = aajHash32(aajIdText(cells, s.cols));
    if (same && base.d && base.d < day && edited < aajDayStartMs_(day)) { out.mark.push({ r: i + 1, key: key, fp: fp, idh: idh, day: base.d }); continue; }
    if (keepFromMs && edited >= keepFromMs) { out.today++; continue; }
    out.copy.push({ r: i + 1, key: key, fp: fp, idh: idh, day: day, cells: cells, visit: base && base.v ? String(base.v) : '', checkup: !!(base && base.k),
      // the website said its visit or checkup was deleted (or moved to another branch or day) there: never "did not reach the website"
      gone: !!(base && (base.g || base.gk)),
      // refused as "already on this list in row N" (a second row of a person whose own row is on the tab): that other row is the one listed
      dup: !!(base && base.dup),
      named: true });
  }
  return out;
}

/**
 * The patients of the day who are done on the website (Completed or Treatment) and whose rows are not on the tab at night: staff took them
 * off the sheet after entering them in Healthwire (the website kept them, 20261017000100_aaj_keep_rows.sql). They are copied to the archive
 * from the website's list (list = the day's list from the last flush), so the archive and the nightly checkup list still have the whole
 * day. Cells are put in the tab's own columns; P.P comes from the website, Healthwire and Reminder stay empty. Pure.
 */
function aajOffSheetRows(s, list) {
  var out = [], onTab = {}, i;
  if (!list || !list.length) return out;
  for (i = 1; i < s.grid.length; i++) { var k = aajText(s.grid[i][s.hc.key]); if (k) onTab[k] = true; }
  var width = s.grid[0].length;
  for (i = 0; i < list.length; i++) {
    var v = list[i];
    if (typeof v.key !== 'string' || !AAJ_KEY_RE.test(v.key) || onTab[v.key]) continue;
    var stt = aajLiveStatus(v.status);
    if (stt !== 'completed' && stt !== 'in_treatment') continue;
    var cells = [];
    for (var c = 0; c < width; c++) cells.push('');
    var fs = AAJ_FIELDS.concat(['pp']);
    for (var f = 0; f < fs.length; f++) {
      if (s.cols[fs[f]] === undefined) continue;
      var val = v[fs[f]] === null || v[fs[f]] === undefined ? '' : String(v[fs[f]]);
      if (fs[f] === 'token' && (s.cfg.branch === 'LHR' || s.cfg.branch === 'ISB')) val = '';      // their Token column is kit / material text
      cells[s.cols[fs[f]]] = val;
    }
    out.push({ r: 0, key: v.key, fp: '', cells: cells, visit: String(v.id), checkup: v.kind === 'checkup', gone: false, dup: false, named: true, off: true });
  }
  return out;
}

/**
 * The memory a row keeps once the archive has copied it (aajArchiveTab_): its own memory with a = the day it was archived under (d is that
 * day too) and s = what it shows now, so aajScanTab and aajFindMoves know it as that day's kept row however long it stays. A row the
 * website never placed or never answered (no visit, checkup or refusal in its memory) gets an "unplaced" memory (u), which takes part in
 * aajFindMoves like the others. Pure.
 */
function aajMarkBase_(cells, s, baseText, day) {
  var b = aajParseBase(baseText);
  if (!b || !b.w || !(b.v || b.g || b.u)) b = { v: null, d: day, b: s.cfg.branch, s: {}, w: {}, u: 1 };
  var texts = {};
  for (var i = 0; i < AAJ_ALL_FIELDS.length; i++) {
    var f = AAJ_ALL_FIELDS[i];
    if (s.cols[f] !== undefined) texts[f] = aajFieldKey(f, cells[s.cols[f]]);
  }
  b.s = texts; b.d = day; b.b = s.cfg.branch; b.a = day;
  delete b.p;
  return JSON.stringify(b);
}

/**
 * What the archive's "Website visit id" cell says about a row: the visit's id; "checkup <id>" for a checkup patient; "deleted on the website"
 * for a row whose visit or checkup front desk deleted (or moved to another branch or day) on the website. Admin > Import skips the last two
 * (web/js/lib/aaj.js readTab): a checkup is never a visit, and importing a deleted one would bring a wrong entry back as a Completed visit
 * (RS8-C1).
 */
var AAJ_ARCH_GONE = 'deleted on the website';
function aajArchVisitCell_(row) {
  if (row.gone) return AAJ_ARCH_GONE;
  if (!row.visit) return '';
  return row.checkup ? 'checkup ' + row.visit : row.visit;
}

/** Midnight of the given Karachi day, as milliseconds (Karachi is UTC+5 all year). */
function aajDayStartMs_(iso) {
  var p = String(iso).split('-');
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) - 5 * 3600000;
}

/** Appends rows to the archive tab of this branch. Columns are matched by header text. */
function aajArchiveAppend_(ctx, s, dateText, rows) {
  var book = aajArchiveBook_(ctx);
  var sheet = book.getSheetByName(s.cfg.tab) || book.insertSheet(s.cfg.tab);
  var heads = [], seen = {}, i;
  var dcs = aajDataCols_(s);              // heads[h] is the header of the tab's column dcs[h]
  for (var di = 0; di < dcs.length; di++) {
    i = dcs[di];
    var t = aajText(s.grid[0][i]) || ('Column ' + (i + 1));
    while (seen[t]) t = t + ' (2)';
    seen[t] = true;
    heads.push(t);
  }
  var header = [];
  if (sheet.getLastRow() >= 1) {
    var hv = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    for (i = 0; i < hv.length; i++) header.push(aajText(hv[i]));
    while (header.length && header[header.length - 1] === '') header.pop();
  }
  var fresh = header.length === 0;
  if (fresh) header = ['Date'].concat(heads, ['Website visit id', 'Archived at']);
  var changed = fresh;
  for (i = 0; i < heads.length; i++) if (header.indexOf(heads[i]) < 0) { header.push(heads[i]); changed = true; }
  if (header.indexOf('Date') < 0) { header.push('Date'); changed = true; }
  if (header.indexOf('Website visit id') < 0) { header.push('Website visit id'); changed = true; }
  if (header.indexOf('Archived at') < 0) { header.push('Archived at'); changed = true; }
  var width = header.length;
  if (width > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  if (changed) sheet.getRange(1, 1, 1, width).setValues([header.map(aajSafeText_)]);       // header texts come from staff-edited cells: never written as a formula
  // A retry after a crash (the rows were copied, the marker was not saved yet) must not copy the day twice: a row that is already in the
  // archive under this date, with the same cells and the same visit id, is skipped. Identical rows count one by one.
  var dateCol = header.indexOf('Date'), visitCol = header.indexOf('Website visit id');
  var sigOf = function (get) {
    var parts = [];
    for (var h = 0; h < heads.length; h++) parts.push(aajCollapse(get(header.indexOf(heads[h]), h)));
    parts.push(aajText(get(visitCol, -1)));
    return parts.join('\u0001');
  };
  var have = {}, lastArchRow = sheet.getLastRow();
  if (lastArchRow >= 2 && !fresh) {
    var dates = sheet.getRange(2, dateCol + 1, lastArchRow - 1, 1).getDisplayValues();
    var firstIdx = -1, lastIdx = -1;
    for (i = 0; i < dates.length; i++) if (aajText(dates[i][0]) === dateText) { if (firstIdx < 0) firstIdx = i; lastIdx = i; }
    if (firstIdx >= 0) {
      var seen = sheet.getRange(2 + firstIdx, 1, lastIdx - firstIdx + 1, width).getDisplayValues();
      for (var q = 0; q < seen.length; q++) {
        if (aajText(seen[q][dateCol]) !== dateText) continue;
        var sg = sigOf(function (col) { return seen[q][col]; });
        have[sg] = (have[sg] || 0) + 1;
      }
    }
  }
  var todo = [];
  for (var t2 = 0; t2 < rows.length; t2++) {
    var rsg = sigOf(function (col, h) { return col === visitCol ? aajArchVisitCell_(rows[t2]) : aajText(rows[t2].cells[dcs[h]]); });
    if (have[rsg] > 0) have[rsg]--; else todo.push(rows[t2]);
  }
  rows = todo;
  if (!rows.length) return;
  var stamp = aajFmt_(Date.now(), 'yyyy-MM-dd HH:mm');
  var block = [];
  for (var r = 0; r < rows.length; r++) {
    var line = [];
    for (var c = 0; c < width; c++) line.push('');
    line[header.indexOf('Date')] = "'" + dateText;
    for (i = 0; i < heads.length; i++) line[header.indexOf(heads[i])] = aajCellValue(aajText(rows[r].cells[dcs[i]]));
    var vcell = aajArchVisitCell_(rows[r]);
    line[header.indexOf('Website visit id')] = vcell ? "'" + vcell : '';
    line[header.indexOf('Archived at')] = "'" + stamp;
    block.push(line);
  }
  var start = Math.max(sheet.getLastRow(), 1) + 1;
  var last = start + block.length - 1;
  if (last > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), last - sheet.getMaxRows());
  sheet.getRange(start, 1, block.length, width).setValues(block);
  try {
    var first = book.getSheetByName('Sheet1');
    if (first && book.getSheets().length > 1 && first.getLastRow() < 1) book.deleteSheet(first);
  } catch (e) { /* the empty default tab may stay */ }
}

// ---------- the nightly list of checkup patients ("Checkup karwaliya") ----------

function aajCut_(t, n) {
  var s = String(t === null || t === undefined ? '' : t);
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * Does a Treatment text say "checkup"? The same pattern as private.aaj_is_checkup_text in the database: the word checkup in its spellings
 * ("Checkup", "check up", "check-up", "Checkups", "chek up", "checup", "xray checkup"), never "Wire check", "RCT check", "Check wire" or
 * "Cheek filler" (treatments of existing patients). Pure.
 */
function aajIsCheckupText(t) {
  return /\bch[ea]{1,2}c?k?[- ]?ups?\b/i.test(String(t === null || t === undefined ? '' : t));
}

/**
 * The checkup patients among the archived rows of a day: one line per person. Pure. skipped (optional): the names of rows filed as checkups
 * that have a Month (a braces patient, never a sales lead for the follow-up team) are pushed into it, for the log.
 */
function aajCheckupLines(s, rows, dateText, skipped) {
  var out = [];
  var info = AAJ.BRANCH_INFO[s.cfg.branch] || { clinic: s.cfg.tab, city: '' };
  var cell = function (cells, f) { return s.cols[f] === undefined ? '' : aajText(cells[s.cols[f]]); };
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].gone) continue;           // its checkup was deleted (or moved) on the website: not a lead any more (RS8-C1)
    if (rows[i].dup) continue;            // a second row of a checkup patient whose own row is listed: never a second line for one person
    var cells = rows[i].cells;
    var raw = cell(cells, 'name');
    if (!raw) continue;
    var mrCell = cell(cells, 'mr');
    // a checkup is a row the website filed as one (its row memory says so: it keeps counting after the person is registered and gets an Mr#),
    // or, for a row it never saw, a row with no Mr# and no Month whose Treatment says checkup. Never a patient's row, never an "add the Mr#" row,
    // and never a row with a Month, even one the website filed as a checkup (the Month was typed in later: a braces patient, owner 13:20).
    var isCk = !!rows[i].checkup || (!rows[i].visit && (mrCell === '' || /^new$/i.test(mrCell)) && aajIsCheckupText(cell(cells, 'treatment')));
    if (!isCk) continue;
    if (cell(cells, 'month') !== '') { if (rows[i].checkup && skipped) skipped.push(aajCleanLegacyName(raw).name); continue; }
    // (An Mr# typed into a checkup row no longer lets the row go by itself: the website lets it go when the Mr# is a patient it has, and the
    // row is then that patient's visit, no checkup memory left. A row that still holds its checkup memory at night is a checkup on the website,
    // whatever its Mr# cell shows: a refused slip, RW8-1. It is listed like any checkup.)
    var st = aajLiveStatus(cell(cells, 'status'));
    if (st === 'cancelled' || st === 'no_show') continue;            // the person did not come
    var phone = aajFirstPhone(cell(cells, 'phone')) || '';
    out.push({
      id: dateText + '|' + (rows[i].key || ('r' + aajHash32(raw + '|' + phone + '|' + cell(cells, 'treatment')))),
      date: dateText, name: aajCut_(aajCleanLegacyName(raw).name, 80), phone: phone, city: info.city, clinic: info.clinic,
      doctor: aajCut_(cell(cells, 'doctors'), 100), treatment: aajCut_(cell(cells, 'treatment'), 100), notes: aajCut_(cell(cells, 'details'), 200),
      source: 'Aj ki List - ' + s.cfg.tab
    });
  }
  return out;
}

/** Lines waiting to be added (the checkup sheet could not be opened last time), kept in document properties in chunks. */
function aajCkLoad_(st) {
  var out = [];
  for (var i = 0; i < 40; i++) {
    var raw = st.get('ckq:' + i);
    if (raw === null) break;
    try { out = out.concat(JSON.parse(raw)); } catch (e) { /* a damaged chunk is skipped */ }
  }
  return out;
}

function aajCkSave_(st, lines) {
  var size = 12, n = Math.ceil(lines.length / size), i;
  for (i = 0; i < n; i++) st.set('ckq:' + i, JSON.stringify(lines.slice(i * size, (i + 1) * size)));
  for (i = n; i < 40; i++) { if (st.get('ckq:' + i) === null) break; st.del('ckq:' + i); }
}

var AAJ_CK_FIELDS = { month: 'month', name: 'patient name', phone: 'phone', city: 'city', clinic: 'clinic', doctor: 'doctor', treatment: 'treatment / checkup for',
  fee: 'est. fee (rs)', status: 'status', notes: 'notes', source: 'source tab' };

/**
 * Adds the lines to the checkup sheet, each person once (a hidden "Sync id" column says which lines are already there). Existing rows are
 * never edited or deleted. Returns { ok, added, tab } or { ok: false, note } (no edit access, tab without a "Patient Name" column ...).
 */
function aajCkWrite_(lines) {
  var props = PropertiesService.getScriptProperties();
  var sid = props.getProperty('CHECKUP_SHEET_ID') || AAJ.CHECKUP_SHEET_ID;
  var tabName = props.getProperty('CHECKUP_TAB') || AAJ.CHECKUP_TAB;
  var book;
  try { book = SpreadsheetApp.openById(sid); }
  catch (e) { return { ok: false, note: 'Checkup list not updated: the "Checkup karwaliya" sheet could not be opened (' + aajErrText_(e) + '). Dr. Ali\'s Google account needs edit access to it.' }; }
  try {
    var sheet = book.getSheetByName(tabName), fresh = false, i, f;
    if (!sheet) { sheet = book.insertSheet(tabName); fresh = true; }
    var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
    var header = [];
    if (lastRow >= 1 && lastCol >= 1) {
      var hv = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
      for (i = 0; i < hv.length; i++) header.push(aajText(hv[i]));
    }
    var any = false;
    for (i = 0; i < header.length; i++) if (header[i] !== '') any = true;
    if (!any) {
      header = AAJ.CHECKUP_HEADERS.concat([AAJ.CHECKUP_ID_HEADER]);
      if (header.length > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), header.length - sheet.getMaxColumns());
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
      sheet.hideColumns(header.length);
    }
    var cols = {}, idCol = -1, lastHeader = -1;
    for (i = 0; i < header.length; i++) {
      var h = header[i].toLowerCase();
      if (h !== '') lastHeader = i;
      for (f in AAJ_CK_FIELDS) if (Object.prototype.hasOwnProperty.call(AAJ_CK_FIELDS, f) && cols[f] === undefined && AAJ_CK_FIELDS[f] === h) cols[f] = i;
      if (header[i] === AAJ.CHECKUP_ID_HEADER) idCol = i;
    }
    if (cols.name === undefined) return { ok: false, note: 'Checkup list not updated: the tab "' + tabName + '" has no "Patient Name" column.' };
    if (idCol < 0) {                                     // the only thing written next to existing data: one new header cell
      idCol = lastHeader + 1;
      if (idCol + 1 > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), idCol + 1 - sheet.getMaxColumns());
      sheet.getRange(1, idCol + 1).setValue(AAJ.CHECKUP_ID_HEADER);
      sheet.hideColumns(idCol + 1);
    }
    var have = {};
    var nRows = sheet.getLastRow();
    if (nRows >= 2) {
      var ids = sheet.getRange(2, idCol + 1, nRows - 1, 1).getDisplayValues();
      for (i = 0; i < ids.length; i++) have[aajText(ids[i][0])] = true;
    }
    var fresh2 = [];
    for (i = 0; i < lines.length; i++) if (!have[lines[i].id]) { have[lines[i].id] = true; fresh2.push(lines[i]); }
    if (!fresh2.length) return { ok: true, added: 0, tab: tabName };
    var width = Math.max(header.length, idCol + 1);
    var block = [];
    for (i = 0; i < fresh2.length; i++) {
      var l = fresh2[i], line = [];
      for (var c = 0; c < width; c++) line.push('');
      if (cols.month !== undefined) line[cols.month] = new Date(aajDayStartMs_(l.date) + 12 * 3600000);
      if (cols.name !== undefined) line[cols.name] = aajCellValue(l.name);
      if (cols.phone !== undefined) line[cols.phone] = aajCellValue(l.phone);
      if (cols.city !== undefined) line[cols.city] = aajCellValue(l.city);
      if (cols.clinic !== undefined) line[cols.clinic] = aajCellValue(l.clinic);
      if (cols.doctor !== undefined) line[cols.doctor] = aajCellValue(l.doctor);
      if (cols.treatment !== undefined) line[cols.treatment] = aajCellValue(l.treatment);
      if (cols.status !== undefined) line[cols.status] = 'Not Contacted';
      if (cols.notes !== undefined) line[cols.notes] = aajCellValue(l.notes);
      if (cols.source !== undefined) line[cols.source] = aajCellValue(l.source);
      line[idCol] = "'" + l.id;
      block.push(line);
    }
    var start = Math.max(sheet.getLastRow(), 1) + 1, last = start + block.length - 1;
    if (last > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), last - sheet.getMaxRows());
    sheet.getRange(start, 1, block.length, width).setValues(block);
    if (fresh && cols.month !== undefined) { try { sheet.getRange(start, cols.month + 1, block.length, 1).setNumberFormat('dd mmm yyyy'); } catch (e2) { /* the dates are still dates */ } }
    return { ok: true, added: fresh2.length, tab: tabName };
  } catch (e3) {
    return { ok: false, note: 'Checkup list not updated: ' + aajErrText_(e3) };
  }
}

/** Adds new lines (and the ones that could not be added before). A failure never stops the sync: it is a note in the log and in Aaj Sync > Status. */
function aajAppendCheckups_(ctx, newLines) {
  var st = ctx.st;
  var lines = aajCkLoad_(st).concat(newLines || []);
  if (!lines.length) return;
  var res = aajCkWrite_(lines);
  if (res.ok) {
    aajCkSave_(st, []);
    st.del('ckNote');
    st.set('ckOkAt', Date.now());
    if (res.added) aajLog_(ctx, '', '', res.added + ' checkup patients added to "' + res.tab + '" in the checkup list.');
    return;
  }
  if (lines.length > AAJ.CHECKUP_QUEUE_MAX) {
    aajLog_(ctx, '', '', 'The checkup list is still closed to this script: ' + (lines.length - AAJ.CHECKUP_QUEUE_MAX) + ' of the oldest checkup patients cannot be kept for later.');
    lines = lines.slice(lines.length - AAJ.CHECKUP_QUEUE_MAX);
  }
  aajCkSave_(st, lines);
  st.set('ckNote', res.note);
  if (st.get('ckLogged') !== ctx.today) { aajLog_(ctx, '', '', res.note + ' ' + lines.length + ' checkup patients are kept here and added as soon as it works.'); st.set('ckLogged', ctx.today); }
}

function aajCheckupsFromArchive_(ctx, s, dateText, rows) {
  try {
    var skipped = [];
    var lines = aajCheckupLines(s, rows, dateText, skipped);
    for (var i = 0; i < skipped.length && i < 20; i++) {
      aajLog_(ctx, s.cfg.tab, skipped[i], 'Not added to the checkup list: the row has a Month, so this is a braces patient, not a checkup. Add the visit on the website (look the Mr# up in Healthwire).');
    }
    aajAppendCheckups_(ctx, lines);
  }
  catch (e) { aajLog_(ctx, s.cfg.tab, '', 'The checkup list could not be updated: ' + aajErrText_(e)); }
}

/** Once in a while, when patients are waiting to be added to the checkup list, try again (throttled to every 30 minutes). */
function aajCheckupRetry_(ctx) {
  var st = ctx.st;
  if (st.get('ckq:0') === null) return;
  var last = Number(st.get('ckTry')) || 0;
  if (Date.now() - last < 1800000) return;
  st.set('ckTry', Date.now());
  try { aajAppendCheckups_(ctx, []); } catch (e) { aajLog_(ctx, '', '', 'The checkup list could not be updated: ' + aajErrText_(e)); }
}

/**
 * Copies a tab's rows of its day into the archive, once, and marks each copied row in its hidden memory (aajMarkBase_). The rows STAY on
 * the tab (owner, 17 Oct 2026: "please dont delete the aaj ki list google sheet entries daily, one of my assistant does it after recording
 * the treatments in healthwire"; she does it the same evening or the next day): from the new day on they are kept rows (aajScanTab).
 * Every row is copied under its own day and never again: a marked row is skipped on every later night, so is a row an older version of
 * this script left behind after its clear. The patients of the day who are done and whose rows staff already took off the sheet are
 * copied from the website's list of the last flush (aajOffSheetRows). Resumable: a marker says what was copied; the next minute only marks.
 * Called by the tick (when the tab still holds an older day) and by Set up (rows of an earlier day).
 * opts: { noWait, noFinal, noCheckups }
 */
function aajArchiveTab_(ctx, s, opts) {
  opts = opts || {};
  var st = ctx.st, tab = s.cfg.tab, nowMs = Date.now(), i;
  var listDate = st.get('listDate:' + tab);
  if (!listDate) return;
  var marker = aajLoadMarker_(st, tab);
  if (!marker) {
    aajReadTab_(s);
    if (s.problem) { aajLog_(ctx, tab, '', 'Archive skipped: ' + s.problem); return; }
    if (!opts.noWait && ctx.hhmm < AAJ.ARCHIVE_WAIT_UNTIL) {
      var maxEdit = 0;
      for (i = 1; i < s.grid.length; i++) maxEdit = Math.max(maxEdit, Number(aajText(s.grid[i][s.hc.edited])) || 0);
      if (nowMs - maxEdit < AAJ.BUSY_MS) return;
    }
    var finalDone = false, tried = false, list = null;
    if (!opts.noFinal && aajDateAdd(listDate, 1) === ctx.today && ctx.hhmm < AAJ.GRACE_UNTIL) {
      tried = true;
      ctx.secret = ctx.secret || aajSecret_();
      if (!ctx.secret) aajLog_(ctx, tab, '', 'The last sync before the archive was skipped: no sync secret.');
      else {
        var syncOk = false;
        // without the hash the website sends the day's whole list: the patients taken off the sheet during the day are archived from it
        st.del('hash:' + tab);
        try {
          var fr = aajSyncTabs_(ctx, [s], listDate, { final: true, checkRemoved: false });
          syncOk = fr.ok;
          list = fr.lists ? fr.lists[tab] || null : null;
        } catch (e) { aajLog_(ctx, tab, '', 'The last sync before the archive failed: ' + aajErrText_(e)); }
        if (!syncOk && ctx.hhmm < AAJ.FINAL_RETRY_UNTIL) {
          // the website did not take the last rows: they are not archived yet. Try again next minute (until 02:30).
          if (st.get('finalwait:' + tab) !== listDate) { aajLog_(ctx, tab, '', 'The last sync before the archive did not go through. Trying again every minute until ' + AAJ.FINAL_RETRY_UNTIL + '.'); st.set('finalwait:' + tab, listDate); }
          return;
        }
        st.del('finalwait:' + tab);
        finalDone = syncOk;
        aajReadTab_(s);
        if (s.problem) return;
      }
    }
    // Without a final sync the website never saw what was typed since midnight: rows edited today are today's patients, not
    // yesterday's. They stay unmarked (they are sent as today's rows) instead of being archived unseen under the old day.
    var keepFrom = (finalDone || opts.noFinal) ? 0 : aajDayStartMs_(ctx.today);
    var found = aajArchiveRows_(s, keepFrom, listDate), rows = found.copy;
    if (!tried && !opts.noFinal && rows.length) aajLog_(ctx, tab, '', 'Rows for ' + listDate + ' archived without a final sync (the sync was off).');
    if (found.mark.length) aajLog_(ctx, tab, '', found.mark.length + ' rows left over from an earlier day are marked as archived (they were copied on their own day).');
    // a row whose visit or checkup the website deleted (or moved) is not one that "never reached the website": importing it again would
    // bring a wrong entry back as a Completed visit (RS8-C1). It is named in the log as deleted on the website instead.
    var unsynced = 0;
    for (i = 0; i < rows.length; i++) if (!rows[i].visit && !rows[i].gone) unsynced++;
    if (!finalDone && !opts.noFinal && unsynced > 0) {
      aajLog_(ctx, tab, '', unsynced + ' of the ' + rows.length + ' rows of ' + listDate + ' never reached the website (the last sync did not go through). They are in the archive: Admin > Import can bring them back.');
    }
    // the last sync went through, but rows that still needed attention (add the Mr#, an Mr# that belongs to somebody else, a typo) never
    // got onto the website: each is named in the log, so that day's patient is not lost without anybody being told
    if (finalDone && unsynced > 0) {
      var lost = 0;
      for (i = 0; i < rows.length; i++) {
        if (rows[i].visit || rows[i].gone) continue;
        lost++;
        if (lost <= 20) aajLog_(ctx, tab, aajText(rows[i].cells[s.cols.name]), 'Archived without reaching the website (the row still needed attention). It is in the archive under ' + listDate + ': correct it there and use Admin > Import.');
      }
      if (lost > 20) aajLog_(ctx, tab, '', (lost - 20) + ' more rows of ' + listDate + ' were archived without reaching the website.');
    }
    var goneN = 0;
    for (i = 0; i < rows.length; i++) {
      if (!rows[i].gone) continue;
      goneN++;
      if (goneN <= 20) aajLog_(ctx, tab, aajText(rows[i].cells[s.cols.name]), 'Deleted on the website (or moved to another branch or day there): archived under ' + listDate + ' marked "' + AAJ_ARCH_GONE + '". Admin > Import skips it.');
    }
    if (goneN > 20) aajLog_(ctx, tab, '', (goneN - 20) + ' more rows of ' + listDate + ' had been deleted on the website.');
    if (found.today) aajLog_(ctx, tab, '', found.today + ' rows typed today stay on the tab as today\'s patients (the sync had been off since ' + listDate + ').');
    // the patients taken off the sheet during the day who are done on the website: copied from its list (only the last flush has it)
    var off = finalDone ? aajOffSheetRows(s, list) : [];
    if (!finalDone && !opts.noFinal) aajLog_(ctx, tab, '', 'Patients taken off the sheet during ' + listDate + ' are not copied to the archive (there was no last sync that night). The website has them.');
    var copied = rows.concat(off);
    if (copied.length) aajArchiveAppend_(ctx, s, listDate, copied);
    if (copied.length && !opts.noCheckups) aajCheckupsFromArchive_(ctx, s, listDate, copied);
    var mrows = [];
    for (i = 0; i < rows.length; i++) mrows.push([rows[i].r, rows[i].key, rows[i].fp, listDate, rows[i].idh]);
    for (i = 0; i < found.mark.length; i++) mrows.push([found.mark[i].r, found.mark[i].key, found.mark[i].fp, found.mark[i].day, found.mark[i].idh]);
    marker = { date: listDate, phase: 'copied', at: nowMs, rows: mrows };
    aajSaveMarker_(st, tab, marker);
    if (rows.length) aajLog_(ctx, tab, '', rows.length + ' rows of ' + listDate + ' copied to "' + AAJ.ARCHIVE_NAME + '". They stay on the tab until you delete them.');
    if (off.length) aajLog_(ctx, tab, '', off.length + ' patients of ' + listDate + ' who were done and already taken off the sheet are copied to "' + AAJ.ARCHIVE_NAME + '" from the website.');
  }
  // the rows are copied: each copied row still on the tab is marked in its hidden memory (never cleared, never copied again)
  aajReadTab_(s);
  if (s.problem) return;
  // A key can be on two rows: a "Duplicate of row N" copy that nobody deleted keeps the key of its original (RV-1). Each copied row is found
  // at its own place while that place still holds its key, otherwise at the first row with the key that no other copied row took (rows
  // moved since the copy, RV9-1).
  var keyRows = {}, grid = s.grid, taken = {};
  for (i = 1; i < grid.length; i++) {
    var k = aajText(grid[i][s.hc.key]);
    if (k) (keyRows[k] = keyRows[k] || []).push(i + 1);
  }
  var keys = {}, bases = {}, used = {}, n = 0;
  for (i = 0; i < marker.rows.length; i++) {
    var m = marker.rows[i];
    var cr = m[0];
    if (m[1]) {
      var withKey = keyRows[m[1]] || [];
      if (withKey.indexOf(cr) < 0 || taken[cr]) {
        cr = 0;
        for (var wk = 0; wk < withKey.length; wk++) if (!taken[withKey[wk]]) { cr = withKey[wk]; break; }
      }
    }
    if (!cr || cr > grid.length) continue;
    taken[cr] = true;
    var cells = grid[cr - 1];
    if (s.cols.name === undefined || aajText(cells[s.cols.name]) === '') continue;
    // edited since the copy: still the same person, it is marked (the archive has it as it was at the copy); another person typed over it in
    // the meantime is a row of the new day and stays unmarked (a marker of an older version, without the person, marks only unchanged rows)
    if (aajRowFp_(cells, s) !== m[2] && (!m[4] || aajHash32(aajIdText(cells, s.cols)) !== m[4])) continue;
    // each kept row gets a key of its own: the second row of a key (a "Duplicate of row N" copy nobody deleted) and a row the website never
    // saw get a new one, so a copy of a kept row made later is told apart from it (aajScanTab)
    var kt = aajText(cells[s.hc.key]);
    if (!AAJ_KEY_RE.test(kt) || used[kt]) { kt = aajNewKey_(); keys[cr] = kt; }
    used[kt] = true;
    bases[cr] = aajMarkBase_(cells, s, aajText(cells[s.hc.base]), m[3] || marker.date);
    n++;
  }
  aajWriteRuns_(s.sheet, s.hc.key + 1, keys);
  aajWriteRuns_(s.sheet, s.hc.base + 1, bases);
  st.set('listDate:' + tab, ctx.today);
  aajDeleteMarker_(st, tab);
  st.del('hash:' + tab);
  st.del('empty:' + tab);
  st.del('setupStamp:' + tab);
  s.grid = null;
  aajSetHeaderLight_(ctx, s, aajHeaderText('plain', ctx.hhmm, 'new list for ' + ctx.today + (n ? ' (rows of earlier days stay)' : '')));
  aajLog_(ctx, tab, '', 'New list for ' + ctx.today + '.' + (n ? ' The ' + n + ' rows of ' + marker.date + ' stay on the tab, marked as kept: delete them when they are entered in Healthwire.' : ''));
}

// ---------- editing, menu ----------

/**
 * Marks the sheet as "something was typed or deleted" (the next minute reads the tabs in full) and counts this run's time into the day's total
 * (Google adds up every trigger run: the on-edit runs count against the free account's 90 minutes a day too).
 */
function aajMarkDirty_(t0) {
  try {
    var props = PropertiesService.getDocumentProperties();
    var now = Date.now();
    props.setProperty('dirty', String(now));
    var k = 'rte:' + aajFmt_(now, 'yyyy-MM-dd');
    props.setProperty(k, String((Number(props.getProperty(k)) || 0) + (now - t0)));
  } catch (err) { /* never fail an edit */ }
}

/**
 * Installable on-change trigger: a deleted, inserted or moved row does not fire "on edit" in Google Sheets, but it must be noticed. Never throws.
 * A typed or pasted edit fires BOTH triggers; aajOnEdit already marks it, so EDIT is ignored here (it would only double the run time counted
 * against the day's 90 minutes).
 */
function aajOnChange(e) {
  var t0 = Date.now();
  try {
    if (e && (e.changeType === 'FORMAT' || e.changeType === 'EDIT')) return;
    aajMarkDirty_(t0);
  } catch (err) { /* nothing to do */ }
}

/** Installable on-edit trigger: stamps "Sync edited" on every row the person just edited. Never throws. */
function aajOnEdit(e) {
  var t0 = Date.now();
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    var name = sh.getName();
    var ours = false;
    for (var t = 0; t < AAJ.TABS.length; t++) if (AAJ.TABS[t].tab === name) ours = true;
    if (!ours) return;
    var r1 = e.range.getRow(), nr = e.range.getNumRows(), c1 = e.range.getColumn(), nc = e.range.getNumColumns();
    var first = Math.max(r1, 2), last = r1 + nr - 1;
    if (last < first) return;
    var lastCol = sh.getLastColumn();
    if (lastCol < 1) return;
    var hc = aajFindHelpers(sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0]);
    if (hc.edited < 0) return;
    var helperCols = {};
    helperCols[hc.status + 1] = true; helperCols[hc.key + 1] = true; helperCols[hc.base + 1] = true; helperCols[hc.edited + 1] = true;
    var dataEdit = false;
    for (var c = c1; c < c1 + nc; c++) if (!helperCols[c]) { dataEdit = true; break; }
    if (!dataEdit) return;
    var stamp = "'" + String(Date.now());
    var vals = [];
    for (var r = first; r <= last; r++) vals.push([stamp]);
    sh.getRange(first, hc.edited + 1, vals.length, 1).setValues(vals);
    aajMarkDirty_(t0);
  } catch (err) { /* an edit must never fail because of the sync */ }
}

function aajOnOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Aaj Sync')
      .addItem('Sync now', 'aajSyncNow')
      .addItem('Set up or repair (Dr. Ali)', 'aajSetup')
      .addItem('Open the archive', 'aajShowArchive')
      .addItem('Status', 'aajStatus')
      .addItem('Help', 'aajHelp')
      .addToUi();
  } catch (err) { /* no screen (a trigger run): no menu */ }
}

function aajShowArchive() {
  var ui = SpreadsheetApp.getUi();
  var id = PropertiesService.getDocumentProperties().getProperty('archiveId');
  if (!id) { ui.alert('Aaj Sync', 'There is no archive yet. It is made when the sync is set up.', ui.ButtonSet.OK); return; }
  var url = '';
  try { url = SpreadsheetApp.openById(id).getUrl(); } catch (e) { url = ''; }
  ui.alert('Aaj Sync', url ? 'The archive is here:\n' + url : 'The archive spreadsheet could not be opened. Run "Set up or repair" to make a new one.', ui.ButtonSet.OK);
}

function aajHelp() {
  var ui = SpreadsheetApp.getUi();
  ui.alert('Aaj Sync - help',
    'Type patients here or on the website: both lists stay the same.\n\n' +
    'The "Website" column says what happened to each row. A tick means the row is on the website. A warning or a cross says what to do.\n' +
    'A row WITH an Mr# is a patient. A row WITHOUT an Mr# whose Treatment says checkup is a checkup patient: it goes to the website\'s checkup list and no patient file is made. With any other Treatment the row says "add the Mr#": look it up in Healthwire.\n' +
    'A Healthwire Mr# that the website does not know yet is added as a patient (check it on the website). A website Mr# is 50000 or more; a number of 50000 or more that the website does not have is a typing mistake. A patient\'s old Mr# (10000-10012 are now 50000-50012) makes the row say which Mr# to use.\n' +
    'Deleting a row of today (a wrong entry, or the patient did not come) removes that patient from the website\'s list too. The website keeps a patient who has an invoice, photos or treatment, and says so (in the row, or for a No show in the Aaj Sync log).\n' +
    'A patient who is done (Completed, Treatment or Cancelled) can be deleted from the sheet once the treatment is entered in Healthwire, one row or many at once: the website keeps the visit as it is and the row does not come back.\n' +
    'Never delete four or more waiting patients at once: the website puts them back and asks you to look.\n' +
    'A row marked Completed completes the visit on the website.\n' +
    'Never delete or unhide the hidden columns next to Website.\n' +
    'To sort, click the small arrow in a heading of the list (the table\'s menu, or the filter button in row 1) and choose Sort A to Z or Z to A: that moves whole rows, the hidden columns too. Never select only some columns and sort them.\n' +
    'The time in the Website heading should be recent. If it is older than 10 minutes during clinic hours, tell Dr. Ali.\n' +
    'At night the day is copied to the archive. The rows stay on the tab, marked "kept on the sheet" (grey): delete them when they are entered in Healthwire, whenever you like. Deleting them never changes the website.',
    ui.ButtonSet.OK);
}

/** Aaj Sync > Status: the last good sync, the run time used today, the checkup list. */
function aajStatus() {
  var ui = SpreadsheetApp.getUi();
  var st = aajLoadState_();
  var today = aajFmt_(Date.now(), 'yyyy-MM-dd');
  var ok = Number(st.get('lastOkAt')) || 0;
  var mins = Math.round(((Number(st.get('rt:' + today)) || 0) + (Number(st.get('rte:' + today)) || 0)) / 60000);
  var lines = [];
  lines.push(ok ? 'Last good sync: ' + aajFmt_(ok, 'dd MMM HH:mm') : 'No good sync yet.');
  lines.push('Google run time used today: ' + mins + ' minutes of about 90 (the free account limit).');
  for (var i = 0; i < AAJ.TABS.length; i++) lines.push(AAJ.TABS[i].tab + ': list of ' + (st.get('listDate:' + AAJ.TABS[i].tab) || 'not set up'));
  var waiting = aajCkLoad_(st).length;
  var ck = st.get('ckNote');
  lines.push(ck ? ck : (st.get('ckOkAt') ? 'Checkup list: last added ' + aajFmt_(Number(st.get('ckOkAt')), 'dd MMM HH:mm') + '.' : 'Checkup list: nothing added yet.'));
  if (waiting) lines.push(waiting + ' checkup patients wait to be added to the checkup list.');
  ui.alert('Aaj Sync - status', lines.join('\n'), ui.ButtonSet.OK);
}

// ---------- set up (Dr. Ali, once; also repair) ----------

function aajParseDmy_(text) {
  var m = String(text || '').trim().match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (!m) return null;
  var d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
}

function aajDmy_(iso) {
  var p = iso.split('-');
  return p[2] + '-' + p[1] + '-' + p[0];
}

function aajSetup() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { ui.alert('Aaj Sync', 'The sync is busy at this moment. Wait a minute and try again.', ui.ButtonSet.OK); return; }
  var finished = false;
  try {
    finished = aajSetupLocked_(ui, ss);
  } finally {
    lock.releaseLock();
  }
  if (!finished) return;
  // one tick now (needs the lock, so it runs after the setup released it)
  aajRunLocked_(true);
  var id = PropertiesService.getDocumentProperties().getProperty('archiveId');
  var url = '';
  try { url = id ? SpreadsheetApp.openById(id).getUrl() : ''; } catch (e) { url = ''; }
  aajOnOpen();
  var stNow = aajLoadState_(), ckNow = stNow.get('ckNote'), tbNow = stNow.get('tableNote');
  ui.alert('Aaj Sync', 'Done. The "Website" column shows a tick when a row is on the website.' + (url ? '\nArchive: ' + url : '') + (ckNow ? '\n\n' + ckNow + '\nThe sync itself works; only the nightly list of checkup patients is off until this is fixed.' : '')
    + (tbNow ? '\n\nSorting: ' + tbNow + ' (The sync works; the Aaj Sync log names the tabs.)' : ''), ui.ButtonSet.OK);
}

/** Can this account open and edit the checkup sheet? '' when it can, otherwise the note to show (nothing is written to it). */
function aajCkProbe_() {
  var props = PropertiesService.getScriptProperties();
  var sid = props.getProperty('CHECKUP_SHEET_ID') || AAJ.CHECKUP_SHEET_ID;
  try {
    var book = SpreadsheetApp.openById(sid);
    return book ? '' : 'Checkup list not updated: the "Checkup karwaliya" sheet could not be opened.';
  } catch (e) {
    return 'Checkup list not updated: the "Checkup karwaliya" sheet could not be opened (' + aajErrText_(e) + '). Dr. Ali\'s Google account needs edit access to it.';
  }
}

function aajSetupLocked_(ui, ss) {
  var st = aajLoadState_();
  var ctx = aajNewCtx_(st, true);
  var userProps = PropertiesService.getUserProperties();
  var i, s;
  // 1. the secret
  var secret = userProps.getProperty('AAJ_SYNC_SECRET');
  if (secret) {
    var keep = ui.alert('Aaj Sync', 'Keep the saved sync secret?', ui.ButtonSet.YES_NO);
    if (keep !== ui.Button.YES) secret = null;
  }
  if (!secret) {
    var pr = ui.prompt('Aaj Sync', 'Paste the sync secret from the file you were given', ui.ButtonSet.OK_CANCEL);
    if (pr.getSelectedButton() !== ui.Button.OK) return false;
    secret = String(pr.getResponseText() || '').trim();
    if (!secret) { ui.alert('Aaj Sync', 'Nothing was entered. Nothing was changed.', ui.ButtonSet.OK); return false; }
  }
  var test = aajCallRpc_(secret, { date: ctx.today, check_removed: false, tabs: [] });
  if (!test.ok && test.kind === 'secret') { ui.alert('Aaj Sync', 'That secret is not right. Nothing was changed.', ui.ButtonSet.OK); return false; }
  if (!test.ok) { ui.alert('Aaj Sync', 'The website did not answer (' + test.message + '). Nothing was changed.', ui.ButtonSet.OK); return false; }
  userProps.setProperty('AAJ_SYNC_SECRET', secret);
  // 2. what day does each tab hold?
  var sheets = aajTabSheets_(ss);
  for (i = 0; i < sheets.length; i++) {
    s = sheets[i];
    var tab = s.cfg.tab;
    if (!s.sheet) { ui.alert(tab, 'The tab "' + tab + '" was not found. It is skipped.', ui.ButtonSet.OK); continue; }
    if (st.get('listDate:' + tab)) continue;
    aajReadTab_(s);
    if (s.problem) { ui.alert(tab, tab + ': row 1 does not look like the list header. This tab is skipped.', ui.ButtonSet.OK); continue; }
    var named = [];
    for (var r = 1; r < s.grid.length; r++) if (aajText(s.grid[r][s.cols.name]) !== '') named.push(r + 1);
    if (!named.length) { st.set('listDate:' + tab, ctx.today); continue; }
    var firstName = aajText(s.grid[named[0] - 1][s.cols.name]), lastName = aajText(s.grid[named[named.length - 1] - 1][s.cols.name]);
    var dayLabel = aajFmt_(Date.now(), 'EEE dd MMM');
    var finished = 0;      // rows marked Completed: a list that already has Completed patients is usually a day that has finished
    if (s.cols.status !== undefined) for (var q0 = 0; q0 < named.length; q0++) if (aajLiveStatus(aajText(s.grid[named[q0] - 1][s.cols.status])) === 'completed') finished++;
    var chosen = null;
    while (!chosen) {
      var dp = ui.prompt(tab, named.length + ' patients are on this tab now (first: ' + firstName + ', last: ' + lastName + ').\n\nWhich day are they from? Type it like 06-10-2026. Leave it empty for TODAY (' + dayLabel + ').', ui.ButtonSet.OK_CANCEL);
      if (dp.getSelectedButton() !== ui.Button.OK) return false;
      var txt = String(dp.getResponseText() || '').trim();
      chosen = txt === '' ? ctx.today : aajParseDmy_(txt);
      if (chosen && chosen > ctx.today) { ui.alert(tab, 'That day has not come yet.', ui.ButtonSet.OK); chosen = null; }
      if (chosen && txt === '' && finished > 0) {
        var sure = ui.alert(tab, finished + ' of these ' + named.length + ' patients are marked Completed. A list with Completed patients is usually a day that has finished, and TODAY would make every one of them a visit of today on the website.\n\nAre these really today\'s patients?', ui.ButtonSet.YES_NO);
        if (sure !== ui.Button.YES) chosen = null;
      }
    }
    if (chosen === ctx.today) {
      // today's patients: linked to the website's visits of the same patients (nothing is doubled). Their stamp lets them go at the first
      // minute, but it is not an edit: the website's list has been used all morning, so a row that nobody touched since Set up is sent
      // without an edit time and never counts as newer than what front desk did on the website (a Cancelled or No show visit is not brought
      // back, a Waiting visit keeps its treatment and details: RSI-1)
      st.set('listDate:' + tab, ctx.today);
      var stamps = {}, setupMs = Date.now() - AAJ.SETTLE_MS;
      for (var q = 0; q < named.length; q++) stamps[named[q]] = "'" + String(setupMs);
      aajWriteRuns_(s.sheet, s.hc.edited + 1, stamps);
      st.set('setupStamp:' + tab, setupMs);
    } else {
      // an earlier day: archived under that day and marked (the rows stay on the tab as kept rows); no visits are made, and these checkups
      // are not added to the checkup list
      st.set('listDate:' + tab, chosen);
      aajArchiveTab_(ctx, s, { noWait: true, noFinal: true, noCheckups: true });
    }
  }
  // 2b. every tab's sort moves whole rows, the hidden helper columns too: a table is widened over them, another tab gets a header filter
  // over them (aajFilterTab_). What could not be done is said in the last box
  for (i = 0; i < sheets.length; i++) {
    s = sheets[i];
    if (!s.sheet) continue;
    if (!s.hc) aajReadTab_(s);
    if (s.problem || !s.hc) continue;
    aajFilterTab_(ctx, s, false);
    st.set('filterAt:' + s.cfg.tab, Date.now());
  }
  if (ctx.tableNote) st.set('tableNote', ctx.tableNote); else st.del('tableNote');
  // 3. the old export timer
  var triggers = ScriptApp.getProjectTriggers();
  var ours = { aajSyncTick: true, aajOnEdit: true, aajOnChange: true, aajOnOpen: true };
  var others = [], handlers = [];
  for (i = 0; i < triggers.length; i++) {
    var h = triggers[i].getHandlerFunction();
    if (!ours[h]) { others.push(triggers[i]); handlers.push(h); }
  }
  if (others.length) {
    var off = ui.alert('Aaj Sync', 'Found ' + others.length + ' other timer(s): ' + handlers.join(', ') + '. They are probably the old copy into the "Website - ..." tabs. Turn them off?', ui.ButtonSet.YES_NO);
    if (off === ui.Button.YES) for (i = 0; i < others.length; i++) ScriptApp.deleteTrigger(others[i]);
  }
  // 4. our triggers, the log tab, the archive
  for (i = 0; i < triggers.length; i++) if (ours[triggers[i].getHandlerFunction()]) ScriptApp.deleteTrigger(triggers[i]);
  ScriptApp.newTrigger('aajSyncTick').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('aajOnEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('aajOnChange').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('aajOnOpen').forSpreadsheet(ss).onOpen().create();
  if (!ss.getSheetByName(AAJ.LOG_TAB)) {
    var logSheet = ss.insertSheet(AAJ.LOG_TAB);
    logSheet.getRange(1, 1, 1, 4).setValues([['Time', 'Tab', 'Patient', 'What happened']]);
  }
  aajArchiveBook_(ctx);
  var ckNote = aajCkProbe_();
  if (ckNote) st.set('ckNote', ckNote); else st.del('ckNote');
  aajLog_(ctx, '', '', 'Set up finished.' + (ckNote ? ' ' + ckNote : ''));
  aajFlushLog_(ctx);
  return true;
}
