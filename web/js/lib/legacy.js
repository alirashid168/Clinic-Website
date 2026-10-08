// GENERATED from src/lib by scripts/build-lib.sh. Edit the .ts file, not this one.
// Helpers for reading the clinic's existing data (Aaj ki List sheets and
// Healthwire exports) and turning it into clean, structured records.
// ---------------------------------------------------------------------------
// Amounts: "35k", "70k", "200k", "24000", "Rs 5,000", "4k", "0"
// ---------------------------------------------------------------------------
export function parseAmount(input) {
    if (input === null || input === undefined)
        return null;
    if (typeof input === 'number')
        return Number.isFinite(input) ? input : null;
    const text = input.trim().toLowerCase().replace(/^rs\.?\s*/, '').replace(/pkr\s*/, '').replace(/,/g, '');
    if (text === '' || text === '-')
        return null;
    const match = text.match(/^(\d+(?:\.\d+)?)\s*(k|lac|lakh|lacs|lakhs)?$/);
    if (!match)
        return null;
    const value = Number(match[1]);
    const unit = match[2];
    if (unit === 'k')
        return Math.round(value * 1000);
    if (unit)
        return Math.round(value * 100000);
    return value;
}
export function formatPKR(amount) {
    const sign = amount < 0 ? '-' : '';
    return `${sign}Rs ${Math.abs(Math.round(amount)).toLocaleString('en-PK')}`;
}
// ---------------------------------------------------------------------------
// Patient names: Healthwire names carry branch suffixes ("Sana lhr", "Ali N.N").
// ---------------------------------------------------------------------------
const SUFFIXES = [
    [/\s*[-(]?\s*\b(lhr|lahore|gulberg)\b\.?\s*\)?$/i, 'LHR'],
    [/\s*[-(]?\s*\b(n\.\s*n\.?|nn|n\.?\s*nazimabad|north\s+nazimabad)\s*\)?$/i, 'NN'],
    [/\s*[-(]?\s*\b(isb|isl|islamabad)\b\.?\s*\)?$/i, 'ISB'],
    [/\s*[-(]?\s*\b(dha)\b\.?\s*\)?$/i, 'DHA'],
    [/\s*[-(]?\s*\b(gul|gulshan|rj\s*mall)\b\.?\s*\)?$/i, 'GUL'],
];
export function cleanLegacyName(raw) {
    let name = raw.replace(/\s+/g, ' ').trim();
    let branch = null;
    for (const [pattern, code] of SUFFIXES) {
        if (pattern.test(name)) {
            const stripped = name.replace(pattern, '').trim();
            if (stripped.length >= 2) {
                name = stripped;
                branch = code;
            }
            break;
        }
    }
    // Title-case words written in all lower or all upper case, keep "(Kid)" etc.
    name = name
        .split(' ')
        .map((w) => (w === w.toLowerCase() || w === w.toUpperCase()) && /^[a-z]/i.test(w)
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        : w)
        .join(' ');
    return { name, branch };
}
// ---------------------------------------------------------------------------
// Doctor names: many spellings in the sheets ("Dr A", "Dr. A Surname")
// ---------------------------------------------------------------------------
export function normaliseDoctorKey(raw) {
    return raw.toLowerCase().replace(/\bdr\.?\s*/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}
export function matchClinician(raw, clinicians) {
    const key = normaliseDoctorKey(raw);
    if (!key)
        return null;
    for (const c of clinicians) {
        const keys = [c.displayName, ...c.aliases].map(normaliseDoctorKey);
        if (keys.includes(key))
            return c;
    }
    // First-name match only if it is unambiguous ("Dr A" -> Dr. A Surname)
    const first = clinicians.filter((c) => normaliseDoctorKey(c.displayName).split(' ')[0] === key.split(' ')[0]
        && key.split(' ').length === 1);
    return first.length === 1 ? first[0] : null;
}
/** Sheet cells list several people: "Dr. Ali Rashid, Assistant A, Dr. B" */
export function splitPeople(cell) {
    return cell.split(/,|\/|&|\band\b/i).map((s) => s.trim()).filter(Boolean);
}
const TOOTH = /\b([1-4][1-8]|[5-8][1-5])\b/g; // FDI permanent + deciduous
function teethIn(text) {
    return [...text.matchAll(TOOTH)].map((x) => Number(x[1]));
}
export function parseTreatmentDetails(raw) {
    const d = {
        upperWire: null, lowerWire: null, brackets: [], extractions: [], temporaries: [],
        powerChain: false, refresh: false, crossArch: false, fullArch: false, ligature: false,
        lingualButtons: false, openCoilSpring: false, biteTurbo: false, oRings: false,
        elastics: false, figureOf8: false, bonding: null, kitPrice: null, unparsed: '',
    };
    if (!raw)
        return d;
    let t = ' ' + raw.toLowerCase().replace(/[\\]/g, '/').replace(/\s+/g, ' ') + ' ';
    const take = (re, fn) => {
        t = t.replace(re, (...args) => {
            fn(args);
            return ' ';
        });
    };
    // Typos: "Uo18" / "Ulo16" / "O18" -> 018
    t = t.replace(/\b(u|l|ul|u\/l)\s*o(1\d)\b/g, '$1 0$2').replace(/\bo(1\d)\b/g, '0$1');
    // Kits: "Bonding 70kit", "55k kit", "80k/120k kits"
    take(/\b(\d{2,3})\s*k?\s*kits?\b/g, (m) => { d.kitPrice = d.kitPrice ?? Number(m[1]) * 1000; });
    take(/\b(\d{2,3})k\b(?=[^a-z]*kits?\b)/g, (m) => { d.kitPrice = d.kitPrice ?? Number(m[1]) * 1000; });
    // Wires
    take(/\b(?:u\s*\/?\s*l|ul|u\s+l)\s*0?(1\d)\b/g, (m) => { d.upperWire = d.lowerWire = '0' + m[1]; });
    take(/\bu\s*0?(1\d)\b/g, (m) => { d.upperWire = '0' + m[1]; });
    take(/\bl\s*0?(1\d)\b/g, (m) => { d.lowerWire = '0' + m[1]; });
    // Bonding
    take(/\bupper\s+(?:\d+\s+)?bonding\b/g, () => { d.bonding = d.bonding === 'lower' ? 'both' : 'upper'; });
    take(/\blower\s+(?:\d+\s+)?bonding\b/g, () => { d.bonding = d.bonding === 'upper' ? 'both' : 'lower'; });
    take(/\bbonding\b/g, () => { d.bonding = d.bonding ?? 'both'; });
    // Teeth lists
    take(/\b(?:brac|bracket|brack|braket)s?\b(?:\s*fix)?((?:[\s,]*\d{2}\b)+)/g, (m) => { d.brackets.push(...teethIn(m[1])); });
    take(/\b(?:ext|extraction)s?\b((?:[\s,]*\d{2}\b)+)/g, (m) => { d.extractions.push(...teethIn(m[1])); });
    take(/((?:\b\d{2}\b[\s,]*)+)\bextractions?\b/g, (m) => { d.extractions.push(...teethIn(m[1])); });
    take(/\btemps?\b((?:[\s,]*\d{2}\b)+)/g, (m) => { d.temporaries.push(...teethIn(m[1])); });
    // Flags
    take(/\b(pc|power\s*chain)\b/g, () => { d.powerChain = true; });
    take(/\brefresh(ed)?\b/g, () => { d.refresh = true; });
    take(/\bcross\s*arch\b/g, () => { d.crossArch = true; });
    take(/\bfull\s*arch\b/g, () => { d.fullArch = true; });
    take(/\b(lig(ature)?\s*(wire|tie)s?|lig\s*wire)\b/g, () => { d.ligature = true; });
    take(/\b(\d\s+)?lingual\s*b[iu]tt?ons?\b/g, () => { d.lingualButtons = true; });
    take(/\bopen\s*coil(\s*spring)?\b/g, () => { d.openCoilSpring = true; });
    take(/\bbite\s*turbos?\b/g, () => { d.biteTurbo = true; });
    take(/\bo\s*-?\s*rings?\b/g, () => { d.oRings = true; });
    take(/\belastics?\b/g, () => { d.elastics = true; });
    take(/\bfig(ure)?\s*(of\s*)?8\b/g, () => { d.figureOf8 = true; });
    take(/\b(and|,|\+)\b/g, () => { });
    d.unparsed = t.replace(/[,+/]/g, ' ').replace(/\s+/g, ' ').trim();
    return d;
}
/** Short human summary for the sheet cell, e.g. "U/L 018 · PC refresh · Ext 24, 34" */
export function summariseDetails(d) {
    const parts = [];
    if (d.upperWire && d.upperWire === d.lowerWire)
        parts.push(`U/L ${d.upperWire}`);
    else {
        if (d.upperWire)
            parts.push(`U ${d.upperWire}`);
        if (d.lowerWire)
            parts.push(`L ${d.lowerWire}`);
    }
    if (d.bonding)
        parts.push(`${d.bonding === 'both' ? '' : d.bonding + ' '}bonding`.trim());
    if (d.brackets.length)
        parts.push(`Brackets ${d.brackets.join(', ')}`);
    if (d.extractions.length)
        parts.push(`Ext ${d.extractions.join(', ')}`);
    if (d.powerChain)
        parts.push(d.refresh ? 'PC refresh' : 'PC');
    else if (d.refresh)
        parts.push('Refresh');
    if (d.crossArch)
        parts.push('Cross arch');
    if (d.fullArch)
        parts.push('Full arch');
    if (d.ligature)
        parts.push('Ligature');
    if (d.oRings)
        parts.push('O-rings');
    if (d.openCoilSpring)
        parts.push('Open coil');
    if (d.lingualButtons)
        parts.push('Lingual buttons');
    if (d.biteTurbo)
        parts.push('Bite turbo');
    if (d.elastics)
        parts.push('Elastics');
    if (d.figureOf8)
        parts.push('Figure of 8');
    if (d.temporaries.length)
        parts.push(`Temps ${d.temporaries.join(', ')}`);
    if (d.kitPrice)
        parts.push(`Kit ${formatPKR(d.kitPrice)}`);
    if (d.unparsed)
        parts.push(d.unparsed);
    return parts.join(' · ');
}
