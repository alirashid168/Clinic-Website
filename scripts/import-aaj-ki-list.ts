// Converts an Aaj ki List tab (downloaded from Google Sheets as CSV) into
// clean records and SQL for the clinic database, and lists every problem
// found (missing Mr#, missing phone, unknown doctor names, amounts as text).
//
// Usage:
//   node scripts/import-aaj-ki-list.ts <file.csv> --branch NN --date 2026-10-05 [--sql out.sql] [--json out.json]
//
// Branch codes: GUL (Gulshan / RJ Mall), NN (North Nazimabad), DHA, LHR (Gulberg), ISB.
import fs from 'node:fs';
import { parseAmount, cleanLegacyName, parseTreatmentDetails, summariseDetails, splitPeople, normaliseDoctorKey } from '../src/lib/legacy.ts';
import { parseMonthCell } from '../src/lib/protocol.ts';

// ---------------------------------------------------------------- CSV
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Header names differ between tabs ("Waiting" vs "Status", "Month" vs "Monthly").
const HEADER_ALIASES: Record<string, string[]> = {
  mr: ['mr #', 'mr#', 'mr', 'mr no', 'mr number'],
  name: ['patient name', 'name', 'patient'],
  month: ['month', 'monthly'],
  treatment: ['treatment'],
  token: ['token no', 'token #', 'token', 'token number'],
  status: ['waiting', 'status'],
  group: ['group', 'column 13'],
  doctors: ["doctor's name", 'doctor name', 'doctors', 'doctor'],
  details: ['treatment details', 'details'],
  pp: ['p.p', 'pp', 'p p', 'pending payment'],
  healthwire: ['healthwire'],
  phone: ['contact no', 'contact', 'phone', 'mobile'],
  reminder: ['reminder status', 'reminder'],
};

function mapHeaders(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase().replace(/^tt\s+/, '').replace(/\s+/g, ' ');
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] === undefined && aliases.includes(key)) map[field] = i;
    }
  });
  return map;
}

const STATUS_MAP: Record<string, string> = {
  completed: 'completed', complete: 'completed', done: 'completed',
  scheduled: 'scheduled', waiting: 'waiting', treatment: 'in_treatment', 'in treatment': 'in_treatment',
  pending: 'waiting', cancelled: 'cancelled', 'no show': 'no_show',
};

export interface Clinician { displayName: string; aliases: string[] }

export interface ImportedRow {
  line: number;
  mrNumber: string | null;
  name: string;
  phone: string | null;
  month: number | null;
  photoMarked: boolean;
  treatment: string | null;
  token: number | null;
  status: string;
  group: number[];
  people: Array<{ raw: string; matched: string | null; isDoctor: boolean }>;
  detailsText: string;
  detailsSummary: string;
  pendingPayment: number | null;
  problems: string[];
}

export function importSheet(csvText: string, clinicians: Clinician[]): ImportedRow[] {
  const rows = parseCSV(csvText);
  const headerIdx = rows.findIndex((r) => r.some((c) => /patient name/i.test(c)));
  if (headerIdx < 0) throw new Error('Could not find the header row (a column called "Patient Name").');
  const cols = mapHeaders(rows[headerIdx]);
  const get = (r: string[], f: string) => (cols[f] === undefined ? '' : (r[cols[f]] ?? '').trim());
  const keys = clinicians.map((c) => ({ c, keys: [c.displayName, ...c.aliases].map(normaliseDoctorKey) }));
  const match = (raw: string) => {
    const k = normaliseDoctorKey(raw);
    const exact = keys.find((x) => x.keys.includes(k));
    if (exact) return exact.c.displayName;
    const first = keys.filter((x) => x.keys[0].split(' ')[0] === k.split(' ')[0] && k.split(' ').length === 1);
    return first.length === 1 ? first[0].c.displayName : null;
  };

  const out: ImportedRow[] = [];
  rows.slice(headerIdx + 1).forEach((r, i) => {
    const rawName = get(r, 'name');
    if (!rawName) return; // empty template rows
    const problems: string[] = [];
    const { name } = cleanLegacyName(rawName);
    const mr = get(r, 'mr') || null;
    if (!mr) problems.push('No Mr# (a new one will be given)');
    const phoneDigits = get(r, 'phone').replace(/\D/g, '');
    const phone = phoneDigits.length >= 10 ? (phoneDigits.length === 10 ? '0' + phoneDigits : phoneDigits) : null;
    if (!phone) problems.push('No phone number');
    const { month, photoMarked } = parseMonthCell(get(r, 'month'));
    const ppRaw = get(r, 'pp');
    const pp = parseAmount(ppRaw);
    if (ppRaw && pp === null) problems.push(`P.P "${ppRaw}" is not a number`);
    const people = splitPeople(get(r, 'doctors')).map((raw) => {
      const matched = match(raw);
      if (!matched) problems.push(`Unknown name "${raw}"`);
      return { raw, matched, isDoctor: /^dr\.?\s/i.test(raw) };
    });
    const statusRaw = get(r, 'status').toLowerCase();
    const detailsText = get(r, 'details');
    const details = parseTreatmentDetails(detailsText);
    const tokenNum = Number(get(r, 'token'));
    out.push({
      line: headerIdx + 2 + i,
      mrNumber: mr,
      name,
      phone,
      month,
      photoMarked,
      treatment: get(r, 'treatment') || null,
      token: Number.isInteger(tokenNum) && tokenNum > 0 ? tokenNum : null,
      status: STATUS_MAP[statusRaw] ?? 'completed',
      group: (get(r, 'group').match(/\d/g) ?? []).map(Number),
      people,
      detailsText,
      detailsSummary: summariseDetails(details),
      pendingPayment: pp,
      problems,
    });
  });
  // Old sheets sometimes repeat a token number; keep the first, note the rest.
  const seen = new Set<number>();
  for (const r of out) {
    if (r.token === null) continue;
    if (seen.has(r.token)) { r.problems.push(`Token ${r.token} used twice (kept on the first row only)`); r.token = null; }
    else seen.add(r.token);
  }
  return out;
}

// ---------------------------------------------------------------- SQL
const q = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

export function toSQL(rows: ImportedRow[], branchCode: string, date: string): string {
  const lines = [
    `-- Aaj ki List import: branch ${branchCode}, ${date}, ${rows.length} rows`,
    'begin;',
  ];
  for (const r of rows) {
    const patientRef = r.mrNumber
      ? `(select id from public.patients where mr_number = ${q(r.mrNumber)})`
      : `(select id from public.patients where lower(full_name) = lower(${q(r.name)}) and phone = ${q(r.phone)} order by created_at desc limit 1)`;
    lines.push(`-- line ${r.line}: ${r.name}${r.problems.length ? ' | ' + r.problems.join('; ') : ''}`);
    if (r.phone) {
      lines.push(`insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, legacy_name)
  select ${r.mrNumber ? q(r.mrNumber) : 'null'}, ${q(r.name)}, ${q(r.phone)}, (select id from public.branches where code = ${q(branchCode)}), 'aaj_ki_list', ${q(r.name)}
  where not exists (select 1 from public.patients where ${r.mrNumber ? `mr_number = ${q(r.mrNumber)}` : `lower(full_name) = lower(${q(r.name)}) and phone = ${q(r.phone)}`});`);
    } else if (!r.mrNumber) {
      lines.push(`-- SKIPPED: no Mr# and no phone, cannot identify this patient safely`);
      continue;
    }
    lines.push(`insert into public.visits (patient_id, branch_id, visit_date, token_no, status, treatment_label, details_text, notes, legacy_source, protocol_override_by)
  select ${patientRef}, (select id from public.branches where code = ${q(branchCode)}), ${q(date)}, ${r.token ?? 'null'}, ${q(r.status)}, ${q(r.treatment)}, ${q(r.detailsText)},
         ${q(r.month ? `Imported braces month ${r.month}` : null)}, 'aaj_ki_list', (select id from public.staff where role = 'admin' limit 1)
  where ${patientRef} is not null
    and not exists (select 1 from public.visits x where x.patient_id = ${patientRef} and x.visit_date = ${q(date)}
                    and x.legacy_source = 'aaj_ki_list' and coalesce(x.treatment_label, '') = coalesce(${q(r.treatment)}, ''));`);
    for (const p of r.people.filter((x) => x.matched)) {
      lines.push(`insert into public.visit_staff (visit_id, clinician_id, role)
  select v.id, c.id, ${q(p.isDoctor ? 'doctor' : 'assistant')} from public.visits v, public.clinicians c
   where v.patient_id = ${patientRef} and v.visit_date = ${q(date)} and v.legacy_source = 'aaj_ki_list' and c.display_name = ${q(p.matched)}
  on conflict do nothing;`);
    }
  }
  lines.push('commit;');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args[0];
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const branch = flag('--branch');
  const date = flag('--date');
  if (!file || !branch || !date) {
    console.error('Usage: node scripts/import-aaj-ki-list.ts <file.csv> --branch NN --date YYYY-MM-DD [--sql out.sql] [--json out.json]');
    process.exit(1);
  }
  const clinicians: Clinician[] = JSON.parse(fs.readFileSync(new URL('./clinicians.json', import.meta.url), 'utf8'));
  const rows = importSheet(fs.readFileSync(file, 'utf8'), clinicians);
  const withProblems = rows.filter((r) => r.problems.length);
  console.log(`${rows.length} patients read. ${withProblems.length} rows need attention:`);
  for (const r of withProblems) console.log(`  line ${r.line} ${r.name}: ${r.problems.join('; ')}`);
  const unknown = [...new Set(rows.flatMap((r) => r.people.filter((p) => !p.matched).map((p) => p.raw)))];
  if (unknown.length) console.log(`Names not matched to a doctor/assistant: ${unknown.join(', ')}`);
  if (flag('--json')) fs.writeFileSync(flag('--json')!, JSON.stringify(rows, null, 2));
  if (flag('--sql')) { fs.writeFileSync(flag('--sql')!, toSQL(rows, branch, date)); console.log(`SQL written to ${flag('--sql')}`); }
}
