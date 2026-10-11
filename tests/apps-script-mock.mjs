// A fake Google for apps-script/AajSync.js: SpreadsheetApp (tabs, ranges, hidden columns, a tab's basic filter, creating a second
// spreadsheet), Google Sheets tables (env.addTable, env.sortTable, env.deleteTableRow; no basic filter over a table) and the Advanced Sheets
// service that reads and widens them (Sheets.Spreadsheets.get / batchUpdate updateTable; createEnv({ sheetsService: false }) = not turned
// on), PropertiesService, LockService, ScriptApp triggers, Utilities, UrlFetchApp, SpreadsheetApp.getUi() with scripted answers, and a clock. The script file is loaded into a separate JavaScript context with
// node:vm, exactly as Google would run it (plain script, its top-level names become globals).
//
// Time is simulated. Every Google call advances the clock by a plausible cost (COST below), so "how long does a
// tick take" can be measured without waiting: env.clock.ms is the time, env.stats.spent the total simulated work.
//
//   const env = createEnv();                        // 2026-10-09 08:00 in Karachi
//   env.addTab('Gulshan KHI', [header, row, row]);  // rows as they are in the sheet (numbers stay numbers)
//   env.fetchHandler = server.handler;              // the fake website (tests/aaj-sync-fake-server.mjs) or anything else
//   env.tick();                                     // one run of aajSyncTick
//   env.type('Gulshan KHI', 3, 5, '12');            // staff type in a cell (Sheets rules; the on-edit trigger runs)
//
// To run the script against a real Postgres (tests outside the repo): set env.fetchHandler to a function
// ({url, method, headers, body}) => ({code, body}) that runs `select public.aaj_sync(p_secret, p_payload)`.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT_PATH = path.join(HERE, '..', 'apps-script', 'AajSync.js');

// Simulated cost of one call, in milliseconds (a free Gmail account is slower than a Workspace one; these are on the slow side).
export const COST = { read: 60, readCell: 0.012, write: 90, writeCell: 0.04, small: 25, prop: 15, propsAll: 30, fetch: 350, fetchPerKB: 2, lock: 20, trigger: 120, createSheet: 700, structure: 150 };

const A1 = (r, c) => { let s = ''; let n = c; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s + r; };

function display(cell) {
  if (!cell) return '';
  if (cell.kind === 'n') {
    const n = cell.v;
    if (Number.isInteger(n) && Math.abs(n) < 1e11) return String(n);
    if (Number.isInteger(n)) return n.toExponential(2).toUpperCase();       // what a narrow Sheets column does to a 13-digit number
    return String(n);
  }
  if (cell.kind === 'd') return '#DATE ' + cell.v;                           // Sheets turned "11-12" into a date
  if (cell.kind === 'f') return '#FORMULA';
  return cell.v;
}

// What Sheets does with a value written by a script (setValues) or typed by a person: numbers, dates and formulas are recognised
// unless the text starts with an apostrophe.
function coerce(input, env) {
  if (input === '' || input === null || input === undefined) return null;
  if (typeof input === 'number') return { kind: 'n', v: input };
  if (typeof input === 'boolean') return { kind: 's', v: String(input) };
  if (input instanceof Date) return { kind: 's', v: input.toISOString() };
  const s = String(input);
  if (s.startsWith("'")) return s.length > 1 ? { kind: 's', v: s.slice(1) } : null;
  if (/^\s*[-+]?\d+(\.\d+)?\s*$/.test(s)) return { kind: 'n', v: Number(s) };
  if (/^\d{1,2}[-/]\d{1,2}([-/]\d{2,4})?$/.test(s)) { env.stats.dateCoerced++; return { kind: 'd', v: s }; }
  if (/^[=+@-]/.test(s)) { env.stats.formulaWrites++; return { kind: 'f', v: s }; }
  return { kind: 's', v: s };
}

// a Map that counts its changes, so the "last row / last column" answer can be cached and still be right when a test edits cells directly
class TrackedMap extends Map {
  constructor() { super(); this.version = 0; }
  set(k, v) { this.version++; return super.set(k, v); }
  delete(k) { this.version++; return super.delete(k); }
  clear() { this.version++; return super.clear(); }
}

function makeEnv(options = {}) {
  const env = {
    clock: { ms: Date.UTC(2026, 9, 9, 3, 0, 0), advance(d) { const r = Math.ceil(d); this.ms += r; env.stats.spent += r; } },   // 08:00 Karachi
    stats: { spent: 0, calls: {}, dateCoerced: 0, formulaWrites: 0, fetches: 0, propReads: 0, propWrites: 0 },
    fetchHandler: null, fetchLog: [], dialogs: [], responder: null, menus: [], triggers: [], books: [], lockHeld: false, lockWaits: 0,
    props: { document: new Map(), user: new Map(), script: new Map() },
    uuidState: options.seed ?? 12345,
    cost: { ...COST },
  };
  const charge = (kind, ms) => { env.stats.calls[kind] = (env.stats.calls[kind] || 0) + 1; env.clock.advance(ms); };
  env.charge = charge;

  // ---------- spreadsheets ----------
  class Range {
    constructor(sheet, r, c, nr, nc) { this.sheet = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
    getSheet() { return this.sheet; }
    getRow() { return this.r; }
    getColumn() { return this.c; }
    getNumRows() { return this.nr; }
    getNumColumns() { return this.nc; }
    getA1Notation() { return A1(this.r, this.c) + (this.nr * this.nc > 1 ? ':' + A1(this.r + this.nr - 1, this.c + this.nc - 1) : ''); }
    _each(fn) { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(fn(this.sheet._get(this.r + i, this.c + j), this.r + i, this.c + j)); out.push(row); } return out; }
    getValues() { charge('read', env.cost.read + this.nr * this.nc * env.cost.readCell); return this._each((cell) => (cell ? (cell.kind === 'n' ? cell.v : display(cell)) : '')); }
    getDisplayValues() { charge('read', env.cost.read + this.nr * this.nc * env.cost.readCell); return this._each((cell) => display(cell)); }
    getValue() { charge('read', env.cost.read); const cell = this.sheet._get(this.r, this.c); return cell ? (cell.kind === 'n' ? cell.v : display(cell)) : ''; }
    getDisplayValue() { charge('read', env.cost.read); return display(this.sheet._get(this.r, this.c)); }
    setValues(values) {
      if (!Array.isArray(values) || values.length !== this.nr || values.some((row) => !Array.isArray(row) || row.length !== this.nc)) throw new Error(`The number of rows or columns in the data does not match the number in the range. The data has ${values && values.length} but the range has ${this.nr} (${this.getA1Notation()}).`);
      charge('write', env.cost.write + this.nr * this.nc * env.cost.writeCell);
      for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._set(this.r + i, this.c + j, coerce(values[i][j], env));
      if (this.r >= 2) env.stats.cellsWritten = (env.stats.cellsWritten || 0) + this.nr * this.nc;
      return this;
    }
    setValue(value) {
      charge('write', env.cost.write);
      for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._set(this.r + i, this.c + j, coerce(value, env));
      if (this.r >= 2) env.stats.cellsWritten = (env.stats.cellsWritten || 0) + this.nr * this.nc;
      return this;
    }
    clearContent() {
      charge('write', env.cost.write);
      for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._set(this.r + i, this.c + j, null);
      return this;
    }
    setFontColors(colors) {
      if (!Array.isArray(colors) || colors.length !== this.nr) throw new Error('setFontColors: wrong number of rows');
      charge('write', env.cost.write);
      for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._font(this.r + i, this.c + j, colors[i][j]);
      return this;
    }
    setFontColor(color) {
      charge('write', env.cost.write);
      for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._font(this.r + i, this.c + j, color);
      return this;
    }
    setNumberFormat(fmt) { charge('write', env.cost.write); this.sheet.formats = this.sheet.formats || new Map(); this.sheet.formats.set(this.c, fmt); return this; }
    getFontColors() { charge('read', env.cost.read); return this._each((cell, r, c) => this.sheet.fonts.get(r + ',' + c) || '#000000'); }
    // Data > Create a filter: one basic filter per sheet (Google throws when the sheet has one already), never over a table (a table has its own)
    createFilter() {
      charge('structure', env.cost.structure);
      if (this.sheet.filter) throw new Error('You can\'t create a filter in a sheet that already has a filter.');
      if (this.sheet.tables.some((t) => t.range.r <= this.r + this.nr - 1 && this.r <= t.range.r + t.range.nr - 1 && t.range.c <= this.c + this.nc - 1 && this.c <= t.range.c + t.range.nc - 1)) {
        env.stats.filterOverTable = (env.stats.filterOverTable || 0) + 1;
        throw new Error('You can\'t create a filter over a table. Tables have their own filters.');
      }
      this.sheet.filter = new Filter(this.sheet, this);
      env.stats.filtersCreated = (env.stats.filtersCreated || 0) + 1;
      return this.sheet.filter;
    }
  }

  // a basic filter: its range (header row first) and the criteria of its columns (column numbers of the sheet)
  class Filter {
    constructor(sheet, range) { this.sheet = sheet; this.range = range; this.criteria = new Map(); }
    getRange() { charge('small', env.cost.small); return new Range(this.sheet, this.range.r, this.range.c, this.range.nr, this.range.nc); }
    getColumnFilterCriteria(c) { charge('small', env.cost.small); this._inside(c); return this.criteria.get(c) || null; }
    setColumnFilterCriteria(c, crit) { charge('small', env.cost.small); this._inside(c); if (crit) this.criteria.set(c, crit); else this.criteria.delete(c); return this; }
    remove() { charge('structure', env.cost.structure); if (this.sheet.filter === this) this.sheet.filter = null; env.stats.filtersRemoved = (env.stats.filtersRemoved || 0) + 1; }
    _inside(c) { if (c < this.range.c || c > this.range.c + this.range.nc - 1) throw new Error('The column position is outside the filter range.'); }
  }

  class Sheet {
    constructor(book, name, { maxRows = 1000, maxCols = 26 } = {}) {
      this.book = book; this.name = name; this.cells = new TrackedMap(); this.fonts = new Map(); this.hidden = new Set(); this.maxRows = maxRows; this.maxCols = maxCols; this.id = ++env.sheetSeq;
      this.tables = [];      // Google Sheets tables on this tab: {tableId, name, range: {r, c, nr, nc}, columns: [{columnIndex, columnName, columnType}], footer}
    }
    _get(r, c) { return this.cells.get(r + ',' + c) || null; }
    _set(r, c, cell) { if (cell) this.cells.set(r + ',' + c, cell); else this.cells.delete(r + ',' + c); }
    _font(r, c, color) { if (color === null || color === undefined || color === '') this.fonts.delete(r + ',' + c); else this.fonts.set(r + ',' + c, color); }
    getName() { return this.name; }
    getSheetId() { return this.id; }
    getParent() { return this.book; }
    _extent() {
      if (!this._ext || this._extVersion !== this.cells.version) {
        let mr = 0, mc = 0;
        for (const k of this.cells.keys()) { const i = k.indexOf(','); const r = +k.slice(0, i), c = +k.slice(i + 1); if (r > mr) mr = r; if (c > mc) mc = c; }
        this._ext = { rows: mr, cols: mc }; this._extVersion = this.cells.version;
      }
      return this._ext;
    }
    getLastRow() { charge('small', env.cost.small); return this._extent().rows; }
    getLastColumn() { charge('small', env.cost.small); return this._extent().cols; }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxCols; }
    getRange(r, c, nr = 1, nc = 1) {
      if (!(r >= 1 && c >= 1 && nr >= 1 && nc >= 1) || r + nr - 1 > this.maxRows || c + nc - 1 > this.maxCols) throw new Error(`The coordinates of the range are outside the dimensions of the sheet. (${A1(r, c)}, ${nr}x${nc}, sheet ${this.maxRows}x${this.maxCols})`);
      return new Range(this, r, c, nr, nc);
    }
    getFilter() { charge('small', env.cost.small); return this.filter || null; }
    insertColumnsAfter(c, n) { charge('structure', env.cost.structure); this.maxCols += n; }
    insertRowsAfter(r, n) { charge('structure', env.cost.structure); this.maxRows += n; }
    hideColumns(c, n = 1) { charge('structure', env.cost.structure); for (let i = 0; i < n; i++) this.hidden.add(c + i); }
    isColumnHiddenByUser(c) { return this.hidden.has(c); }
    deleteRows(r, n) {
      charge('structure', env.cost.structure);
      const moved = new TrackedMap();
      for (const [k, v] of this.cells) { const [rr, cc] = k.split(',').map(Number); if (rr >= r + n) moved.set((rr - n) + ',' + cc, v); else if (rr < r) moved.set(k, v); }
      this.cells = moved; this.maxRows -= n;
    }
    // ----- test helpers (not part of Google) -----
    text(r, c) { return display(this._get(r, c)); }
    raw(r, c) { const x = this._get(r, c); return x ? x.v : ''; }
    kind(r, c) { const x = this._get(r, c); return x ? x.kind : ''; }
    used() { return this._extent(); }
    row(r) { const { cols } = this.used(); const out = []; for (let c = 1; c <= cols; c++) out.push(this.text(r, c)); return out; }
    values() { const { rows, cols } = this.used(); const out = []; for (let r = 1; r <= rows; r++) { const row = []; for (let c = 1; c <= cols; c++) row.push(this.text(r, c)); out.push(row); } return out; }
    font(r, c) { return this.fonts.get(r + ',' + c) || null; }
  }
  env.sheetSeq = 0; env.bookSeq = 0;

  class Book {
    constructor(name) { this.name = name; this.id = 'book-' + (++env.bookSeq); this.sheets = []; env.books.push(this); }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
    getSheetByName(n) { charge('small', env.cost.small); return this.sheets.find((s) => s.name === n) || null; }
    getSheets() { return this.sheets.slice(); }
    insertSheet(n) {
      charge('structure', env.cost.createSheet);
      if (this.sheets.some((s) => s.name === n)) throw new Error(`A sheet with the name "${n}" already exists. Please enter another name.`);
      const s = new Sheet(this, n); this.sheets.push(s); return s;
    }
    deleteSheet(s) { charge('structure', env.cost.structure); this.sheets = this.sheets.filter((x) => x !== s); }
  }

  const active = new Book('Aj ki List');
  env.book = active;
  env.archiveBooks = () => env.books.filter((b) => b !== active && !b.external);

  const ui = {
    Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' },
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO', YES_NO_CANCEL: 'YES_NO_CANCEL' },
    alert(...a) {
      const d = a.length === 3 ? { title: a[0], text: a[1], buttons: a[2] } : a.length === 2 ? { title: '', text: a[0], buttons: a[1] } : { title: '', text: a[0], buttons: 'OK' };
      d.kind = 'alert'; env.dialogs.push(d);
      const ans = env.responder ? env.responder(d) : undefined;
      if (ans !== undefined) return ans;
      if (d.buttons === 'OK') return 'OK';
      throw new Error('Unscripted dialog: ' + d.title + ' / ' + d.text);
    },
    prompt(...a) {
      const d = a.length === 3 ? { title: a[0], text: a[1], buttons: a[2] } : a.length === 2 ? { title: '', text: a[0], buttons: a[1] } : { title: '', text: a[0], buttons: 'OK' };
      d.kind = 'prompt'; env.dialogs.push(d);
      const ans = env.responder ? env.responder(d) : undefined;
      if (ans === undefined) throw new Error('Unscripted prompt: ' + d.title + ' / ' + d.text);
      const res = typeof ans === 'string' ? { button: 'OK', text: ans } : ans;
      return { getSelectedButton: () => res.button, getResponseText: () => res.text ?? '' };
    },
    createMenu(name) {
      const menu = { name, items: [] };
      const b = { addItem(label, fn) { menu.items.push({ label, fn }); return b; }, addSeparator() { return b; }, addToUi() { env.menus.push(menu); return b; } };
      return b;
    },
  };

  const SpreadsheetApp = {
    getActiveSpreadsheet() { return active; },
    getActive() { return active; },
    create(name) { charge('structure', env.cost.createSheet); const b = new Book(name); b.sheets.push(new Sheet(b, 'Sheet1')); return b; },
    openById(id) {
      charge('small', env.cost.small * 4);
      if (env.openErrors && env.openErrors[id]) throw new Error(env.openErrors[id]);          // a test makes this id fail (no permission, Google hiccup, deleted)
      const b = env.books.find((x) => x.id === id);
      if (!b) throw new Error('Exception: Document ' + id + ' is missing (perhaps it was deleted, or you don\'t have read access?)');
      return b;
    },
    getUi() { return ui; },
  };

  // ---------- properties, locks, triggers, utilities, fetch ----------
  const makeProps = (store) => ({
    getProperty(k) { env.stats.propReads++; charge('prop', env.cost.prop); return store.has(k) ? store.get(k) : null; },
    getProperties() { env.stats.propReads++; charge('prop', env.cost.propsAll); const o = {}; for (const [k, v] of store) o[k] = v; return o; },
    setProperty(k, v) {
      env.stats.propWrites++; charge('prop', env.cost.prop);
      const s = String(v);
      if (s.length > 9 * 1024) throw new Error('Argument too large: value');
      if (String(k).length > 500) throw new Error('Argument too large: key');
      store.set(String(k), s); return this;
    },
    setProperties(o) { for (const k of Object.keys(o)) this.setProperty(k, o[k]); return this; },
    deleteProperty(k) { env.stats.propWrites++; charge('prop', env.cost.prop); store.delete(k); return this; },
    deleteAllProperties() { store.clear(); return this; },
  });
  const PropertiesService = {
    getDocumentProperties: () => makeProps(env.props.document),
    getUserProperties: () => makeProps(env.props.user),
    getScriptProperties: () => makeProps(env.props.script),
  };
  const LockService = {
    getScriptLock() {
      let mine = false;
      return {
        tryLock(ms) { charge('lock', env.cost.lock); if (env.lockHeld) { env.lockWaits++; env.clock.advance(ms || 0); return false; } mine = true; env.lockHeld = true; return true; },
        releaseLock() { if (mine) { env.lockHeld = false; mine = false; } },
        hasLock() { return mine; },
      };
    },
  };
  let trigSeq = 0;
  const ScriptApp = {
    getProjectTriggers() { charge('trigger', env.cost.trigger); return env.triggers.map((t) => ({ getHandlerFunction: () => t.handler, getEventType: () => t.event, getUniqueId: () => t.id, getTriggerSource: () => t.source })); },
    deleteTrigger(t) { charge('trigger', env.cost.trigger); env.triggers = env.triggers.filter((x) => x.id !== t.getUniqueId()); },
    newTrigger(handler) {
      const t = { handler, id: 'trg-' + (++trigSeq) };
      const create = () => ({ create() { charge('trigger', env.cost.trigger); env.triggers.push(t); return { getHandlerFunction: () => t.handler, getUniqueId: () => t.id }; } });
      return {
        timeBased() { t.source = 'CLOCK'; return { everyMinutes(n) { t.event = 'CLOCK'; t.every = n; return create(); } }; },
        forSpreadsheet(ss) { t.source = 'SPREADSHEETS'; t.book = ss.getId(); return { onEdit() { t.event = 'ON_EDIT'; return create(); }, onChange() { t.event = 'ON_CHANGE'; return create(); }, onOpen() { t.event = 'ON_OPEN'; return create(); } }; },
      };
    },
  };
  const rand = () => { let t = (env.uuidState += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
  const fmtCache = new Map();
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const PARTS = (ms, tz) => {
    if (tz === 'Asia/Karachi') {                         // fixed UTC+5 (no daylight saving): the fast path for the only zone the script uses
      const d = new Date(ms + 5 * 3600000);
      return { yyyy: String(d.getUTCFullYear()), MM: pad2(d.getUTCMonth() + 1), dd: pad2(d.getUTCDate()), HH: pad2(d.getUTCHours()), mm: pad2(d.getUTCMinutes()), ss: pad2(d.getUTCSeconds()), EEE: DAYS[d.getUTCDay()], MMM: MONTHS[d.getUTCMonth()] };
    }
    let f = fmtCache.get(tz);
    if (!f) {
      f = { main: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }),
        mon: new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'short' }) };
      fmtCache.set(tz, f);
    }
    const o = {}; for (const p of f.main.formatToParts(new Date(ms))) o[p.type] = p.value;
    return { yyyy: o.year, MM: o.month, dd: o.day, HH: o.hour, mm: o.minute, ss: o.second, EEE: o.weekday, MMM: f.mon.format(new Date(ms)) };
  };
  const Utilities = {
    formatDate(date, tz, fmt) { const p = PARTS(date.getTime(), tz); return fmt.replace(/yyyy|MMM|MM|dd|HH|mm|ss|EEE|'[^']*'/g, (t) => (t[0] === "'" ? t.slice(1, -1) : p[t])); },
    getUuid() { return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`; },
    sleep(ms) { env.clock.advance(ms); },
  };
  const UrlFetchApp = {
    fetch(url, params = {}) {
      const body = params.payload ?? '';
      charge('fetch', env.cost.fetch + (body.length / 1024) * env.cost.fetchPerKB);
      env.stats.fetches++;
      env.fetchLog.push({ url, params, at: env.clock.ms });
      if (!env.fetchHandler) throw new Error('Exception: no fetchHandler in the test');
      const r = env.fetchHandler({ url, method: params.method || 'get', headers: params.headers || {}, body });
      if ((!params.muteHttpExceptions) && r.code >= 400) throw new Error(`Request failed for ${url} returned code ${r.code}. Truncated server response: ${String(r.body).slice(0, 100)}`);
      return { getResponseCode: () => r.code, getContentText: () => r.body, getHeaders: () => ({}) };
    },
  };

  class MockDate extends Date {
    constructor(...a) { if (a.length === 0) super(env.clock.ms); else super(...a); }
    static now() { return env.clock.ms; }
  }

  // ---------- the Advanced Sheets service (Sheets API v4): only what the script uses, the tables of a spreadsheet ----------
  // A GridRange is 0-based and end-exclusive; like the real JSON, a field that is 0 is left out (sheetId 0, startRowIndex 0).
  const grid = (sheet, g) => {
    const o = { sheetId: sheet.id, startRowIndex: g.r - 1, endRowIndex: g.r - 1 + g.nr, startColumnIndex: g.c - 1, endColumnIndex: g.c - 1 + g.nc };
    for (const k of Object.keys(o)) if (o[k] === 0) delete o[k];
    return o;
  };
  env.sheetsErrors = {};          // {get: 'message'} or {update: 'message'}: that call throws (the API refuses or is down)
  env.sheetsCalls = [];
  const Sheets = {
    Spreadsheets: {
      get(id, opts = {}) {
        charge('fetch', env.cost.fetch);
        env.sheetsCalls.push({ kind: 'get', id, opts });
        if (env.sheetsErrors.get) throw new Error(env.sheetsErrors.get);
        const b = env.books.find((x) => x.id === id);
        if (!b) throw new Error('Requested entity was not found.');
        if (!/tables/.test(opts.fields || '')) throw new Error('the mock only answers fields with sheets.tables');
        return {
          sheets: b.sheets.map((s) => {
            const out = { properties: { sheetId: s.id, title: s.name } };
            if (!s.id) delete out.properties.sheetId;
            if (s.tables.length) out.tables = s.tables.map((t) => ({ tableId: t.tableId, name: t.name, range: grid(s, t.range) }));
            return out;
          }),
        };
      },
      batchUpdate(resource, id) {
        charge('fetch', env.cost.fetch);
        env.sheetsCalls.push({ kind: 'batchUpdate', id, resource: JSON.parse(JSON.stringify(resource)) });
        if (env.sheetsErrors.update) throw new Error(env.sheetsErrors.update);
        const b = env.books.find((x) => x.id === id);
        if (!b) throw new Error('Requested entity was not found.');
        for (const rq of resource.requests || []) {
          const u = rq.updateTable;
          if (!u || Object.keys(rq).length !== 1) throw new Error('the mock only knows updateTable');
          if (!u.fields || !u.table || !u.table.tableId) throw new Error('Invalid requests[0].updateTable: fields and table.tableId are required');
          let sheet = null, t = null;
          for (const s of b.sheets) for (const x of s.tables) if (x.tableId === u.table.tableId) { sheet = s; t = x; }
          if (!t) throw new Error('Invalid requests[0].updateTable: No table with id: ' + u.table.tableId);
          if (u.fields !== 'range') throw new Error('the mock only updates the range');
          const g = u.table.range || {};
          if ((g.sheetId || 0) !== sheet.id) throw new Error('Invalid requests[0].updateTable: the range is on another sheet');
          const nr = { r: (g.startRowIndex || 0) + 1, c: (g.startColumnIndex || 0) + 1 };
          nr.nr = (g.endRowIndex || 0) - (nr.r - 1); nr.nc = (g.endColumnIndex || 0) - (nr.c - 1);
          if (!(nr.nr >= 1 && nr.nc >= 1)) throw new Error('Invalid requests[0].updateTable: empty range');
          for (const o of sheet.tables) if (o !== t && o.range.r <= nr.r + nr.nr - 1 && nr.r <= o.range.r + o.range.nr - 1 && o.range.c <= nr.c + nr.nc - 1 && nr.c <= o.range.c + o.range.nc - 1) throw new Error('Invalid requests[0].updateTable: tables cannot overlap');
          // the columns the table keeps keep their name and type; a new column is named by its header cell
          const cols = [];
          for (let c = nr.c; c < nr.c + nr.nc; c++) {
            const old = t.columns.find((x) => x.columnIndex === c - t.range.c);
            cols.push(old && c < t.range.c + t.range.nc ? { ...old, columnIndex: c - nr.c } : { columnIndex: c - nr.c, columnName: display(sheet._get(nr.r, c)) || 'Column ' + (c - nr.c + 1), columnType: 'TEXT' });
          }
          t.range = nr; t.columns = cols;
          env.stats.tablesUpdated = (env.stats.tablesUpdated || 0) + 1;
        }
        return { spreadsheetId: id, replies: (resource.requests || []).map(() => ({})) };
      },
    },
  };

  env.sandbox = { SpreadsheetApp, PropertiesService, LockService, ScriptApp, Utilities, UrlFetchApp, Date: MockDate, console, Logger: { log() {} }, Sheets: options.sheetsService === false ? undefined : Sheets };
  env.Sheet = Sheet; env.Book = Book; env.Range = Range; env.Filter = Filter;
  return env;
}

export function createEnv(options = {}) {
  const env = makeEnv(options);
  const src = fs.readFileSync(options.file || SCRIPT_PATH, 'utf8');
  // The file is a plain Google script: its top-level `function`s and `var`s are its API. It is run inside a function scope
  // (a vm context's global object makes every variable lookup 3x slower) and those names are handed back as `env.ctx`.
  const fnNames = [...src.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const varNames = [...src.matchAll(/^var\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const sb = env.sandbox;
  const NL = String.fromCharCode(10);
  // Sheets (the Advanced Sheets service) is a parameter only when it is turned on: otherwise the name does not exist, as in Google
  const params = 'SpreadsheetApp, PropertiesService, LockService, ScriptApp, Utilities, UrlFetchApp, Date, console, Logger' + (sb.Sheets ? ', Sheets' : '');
  const wrapper = '(function (' + params + ') {' + NL + src + NL + ';var __api = {};' + NL
    + fnNames.map((n) => '__api.' + n + ' = ' + n + ';').join(NL)
    + varNames.map((n) => NL + 'Object.defineProperty(__api, ' + JSON.stringify(n) + ', { get: function () { return ' + n + '; }, set: function (v) { ' + n + ' = v; }, enumerable: true });').join('')
    + NL + 'return __api;' + NL + '})';
  const ctx = vm.runInNewContext(wrapper, {}, { filename: 'AajSync.js' })(sb.SpreadsheetApp, sb.PropertiesService, sb.LockService, sb.ScriptApp, sb.Utilities, sb.UrlFetchApp, sb.Date, sb.console, sb.Logger, sb.Sheets);
  env.ctx = ctx;
  env.source = src;

  // call any function of the script; results are cloned so assert.deepEqual works across the two JavaScript realms
  env.call = (name, ...args) => {
    const r = ctx[name](...args);
    return r === undefined ? undefined : JSON.parse(JSON.stringify(r));
  };
  env.global = (name) => JSON.parse(JSON.stringify(ctx[name]));

  env.tz = (ms = env.clock.ms) => ({ date: new Date(ms + 5 * 3600000).toISOString().slice(0, 10), time: new Date(ms + 5 * 3600000).toISOString().slice(11, 16) });
  // jump to a Karachi wall-clock time, e.g. env.at('2026-10-09', '23:58')
  env.at = (date, hhmm) => { const [h, m] = hhmm.split(':').map(Number); env.clock.ms = Date.parse(date + 'T00:00:00Z') + (h * 60 + m) * 60000 - 5 * 3600000; env.tickStart = env.clock.ms - 60000; };
  env.advance = (ms) => { env.clock.ms += ms; };
  env.tab = (name) => env.book.getSheetByName(name);

  // a tab as it is in the real sheet: values exactly as given (numbers stay numbers, text stays text)
  env.addTab = (name, rows, { maxRows = 1000, maxCols = 26 } = {}) => {
    const sh = new env.Sheet(env.book, name, { maxRows: Math.max(maxRows, rows.length + 20), maxCols: Math.max(maxCols, Math.max(...rows.map((r) => r.length)) + 6) });
    rows.forEach((row, i) => row.forEach((v, j) => { if (v === '' || v === null || v === undefined) return; sh.cells.set((i + 1) + ',' + (j + 1), typeof v === 'number' ? { kind: 'n', v } : { kind: 's', v: String(v) }); }));
    env.book.sheets.push(sh);
    return sh;
  };

  const installed = (handler) => env.triggers.some((t) => t.handler === handler);
  // staff type text in a cell (or paste a block of cells): Sheets rules apply, and the on-edit trigger runs when it is installed
  env.type = (tabName, r, c, value, { trigger = true } = {}) => {
    const sh = env.tab(tabName);
    const vals = Array.isArray(value) ? value : [[value]];
    const nr = vals.length, nc = vals[0].length;
    env.stats.calls.type = (env.stats.calls.type || 0) + 1;
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh._set(r + i, c + j, coerce(vals[i][j], env));
    if (trigger && installed('aajOnEdit')) ctx.aajOnEdit({ range: new env.Range(sh, r, c, nr, nc), source: env.book });
    return sh;
  };
  env.typeRow = (tabName, r, values, startCol = 1, opts) => env.type(tabName, r, startCol, [values], opts);
  // a person deletes whole rows (right-click, Delete row): Google runs the on-change trigger (not on-edit)
  env.deleteRows = (tabName, r, n = 1, { trigger = true } = {}) => {
    const sh = env.tab(tabName);
    sh.deleteRows(r, n);
    if (trigger && installed('aajOnChange')) ctx.aajOnChange({ changeType: 'REMOVE_ROW', source: env.book });
  };
  // someone else's spreadsheet with a known id (the owner's "Checkup karwaliya"); env.openErrors[id] = 'message' makes openById fail
  env.addBook = (id, name, tabs = {}) => {
    const b = new env.Book(name);
    b.id = id; b.external = true;
    for (const [tabName, rows] of Object.entries(tabs)) {
      const sh = new env.Sheet(b, tabName, { maxRows: Math.max(1000, rows.length + 20), maxCols: Math.max(26, ...rows.map((r) => r.length)) + 2 });
      rows.forEach((row, i) => row.forEach((v, j) => { if (v === '' || v === null || v === undefined) return; sh.cells.set((i + 1) + ',' + (j + 1), typeof v === 'number' ? { kind: 'n', v } : { kind: 's', v: String(v) }); }));
      b.sheets.push(sh);
    }
    return b;
  };
  env.openErrors = {};
  // tests that move cells around directly (a sort, a paste of hidden columns) call this, as Google's on-change trigger would
  env.touch = () => { if (installed('aajOnChange')) ctx.aajOnChange({ changeType: 'OTHER', source: env.book }); };
  // ----- Google Sheets tables (Insert > Table; all five real branch tabs are tables, without a basic filter) -----
  let tableSeq = 0;
  // a table over rows r..r+nr-1 and columns c..c+nc-1 (header in its first row); footer = the coloured last row the real Gulshan table has
  env.addTable = (tabName, { r = 1, c = 1, nr, nc, name = tabName.replace(/\s+/g, '_'), footer = false, types = {} } = {}) => {
    const sh = env.tab(tabName);
    const t = { tableId: String(1000000 + (++tableSeq)), name, range: { r, c, nr: nr || Math.max(2, sh.used().rows), nc: nc || sh.used().cols }, footer, columns: [] };
    for (let j = 0; j < t.range.nc; j++) t.columns.push({ columnIndex: j, columnName: display(sh._get(r, c + j)) || 'Column ' + (j + 1), columnType: types[j] || 'TEXT' });
    sh.tables.push(t);
    return t;
  };
  const tableOf = (sh) => { if (sh.tables.length !== 1) throw new Error('the test tab has ' + sh.tables.length + ' tables'); return sh.tables[0]; };
  const cellText = (cell) => (cell ? String(cell.v) : '');
  // the sort in a table column's menu: the table's data rows are sorted by one of its columns, only the table's columns move (hidden ones in it
  // too), empty cells last in both directions; a stable sort, as in Sheets. Google runs the on-change trigger
  env.sortTable = (tabName, col, dir = 1) => {
    const sh = env.tab(tabName), t = tableOf(sh), { r, c, nr, nc } = t.range;
    if (col < c || col >= c + nc) throw new Error('column ' + col + ' is not in the table');
    const data = [];
    for (let rr = r + 1; rr < r + nr; rr++) { const row = []; for (let j = 0; j < nc; j++) row.push(sh._get(rr, c + j)); data.push(row); }
    data.sort((a, b) => { const ea = !cellText(a[col - c]), eb = !cellText(b[col - c]); if (ea !== eb) return ea ? 1 : -1; return dir * cellText(a[col - c]).localeCompare(cellText(b[col - c]), 'en', { numeric: true }); });
    data.forEach((row, i) => row.forEach((cell, j) => sh._set(r + 1 + i, c + j, cell)));
    env.touch();
  };
  // a table row deleted from the table's own menu: the cells of the table's columns below move up one row (other columns stay), the table
  // gets one row shorter. Google runs the on-change trigger
  env.deleteTableRow = (tabName, row) => {
    const sh = env.tab(tabName), t = tableOf(sh), { r, c, nr, nc } = t.range;
    if (row <= r || row >= r + nr) throw new Error('row ' + row + ' is not a data row of the table');
    const last = Math.max(sh.used().rows, r + nr - 1);
    for (let rr = row; rr <= last; rr++) for (let j = 0; j < nc; j++) sh._set(rr, c + j, sh._get(rr + 1, c + j));
    t.range.nr -= 1;
    env.touch();
  };
  env.clearRow = (tabName, r, fromCol = 1, toCol = null, { trigger = true } = {}) => {
    const sh = env.tab(tabName); const to = toCol || sh.used().cols;
    for (let c = fromCol; c <= to; c++) sh._set(r, c, null);
    if (trigger && installed('aajOnEdit')) ctx.aajOnEdit({ range: sh.getRange(r, fromCol, 1, to - fromCol + 1), source: env.book });
  };

  env.tick = () => {
    const before = env.stats.spent;
    ctx.aajSyncTick();
    const last = ctx.aajLastRun ? JSON.parse(JSON.stringify(ctx.aajLastRun)) : null;
    return Object.assign({ spent: env.stats.spent - before }, last || {});
  };
  // ticks one minute apart, like the Google trigger: the first runs now, the next one 60 s after the previous one STARTED
  // (a tick that runs long delays the next one)
  env.tickStart = env.clock.ms - 60000;
  env.tickNext = () => { env.clock.ms = Math.max(env.clock.ms, env.tickStart + 60000); env.tickStart = env.clock.ms; return env.tick(); };
  env.ticks = (n) => Array.from({ length: n }, () => env.tickNext());
  // a tick `ms` after now (for "the row was edited 25 s ago"): the trigger runs every minute, but a person can press Sync now at any time
  env.tickAfter = (ms) => { env.advance(ms); env.tickStart = env.clock.ms; return env.tick(); };
  return env;
}

export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}
