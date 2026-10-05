// GENERATED from src/lib by scripts/build-lib.sh. Edit the .ts file, not this one.
// Braces Treatment Module: month-by-month rules.
// Mirrors public.braces_protocol in the database (the database is the source of
// truth at runtime; this copy powers instant on-screen guidance and tests).
const m = (month, treatingGroups, checkerGroup, plannedWire, flags = {}) => ({
    month,
    treatingGroups,
    checkerGroup,
    plannedWire,
    photoRequired: false,
    requiresDrAliPlan: false,
    extractionDecision: false,
    extractionDeadline: false,
    duesCheckpoint: false,
    retainerPaymentReminder: false,
    endsNonExtraction: false,
    endsExtraction: false,
    instructions: [],
    confirmed: month <= 7,
    ...flags,
});
export const BRACES_PROTOCOL = [
    m(1, [1], null, 'O12', { photoRequired: true, requiresDrAliPlan: true, instructions: ['Click photo', 'Ask treatment plan from Dr. Ali'] }),
    m(2, [3], 2, 'O12'),
    m(3, [3], 2, 'O14'),
    m(4, [1, 2], 1, 'O16', { photoRequired: true, extractionDecision: true, instructions: ['Click photo', 'Decide and do extractions'] }),
    m(5, [3], 2, 'O16'),
    m(6, [3], 2, 'O16'),
    m(7, [1, 2], 1, 'O16', { photoRequired: true, extractionDeadline: true, instructions: ['Click photo', 'No extractions beyond this month', 'Make sure all extractions are done'] }),
    m(8, [3], 2, null, { duesCheckpoint: true, retainerPaymentReminder: true, instructions: ['Dues should be cleared', 'Remind retainer payment to patient'] }),
    m(9, [3], 2, null),
    m(10, [1, 2], 1, null, { photoRequired: true, endsNonExtraction: true, instructions: ['Click photo', 'END non-extraction cases'] }),
    m(11, [3], 2, null),
    m(12, [1], 1, null, { photoRequired: true, endsNonExtraction: true, instructions: ['Click photo', 'END non-extraction cases'] }),
    m(13, [1, 2], 1, null, { photoRequired: true, instructions: ['Click photo'] }),
    m(14, [3], 2, null),
    m(15, [1], 1, null, { photoRequired: true, duesCheckpoint: true, retainerPaymentReminder: true, instructions: ['Click photo', 'Dues should be cleared', 'Remind retainer payment to patient'] }),
    m(16, [3], 2, null),
    m(17, [3], 2, null),
    m(18, [1, 2], 1, null, { photoRequired: true, endsExtraction: true, instructions: ['Click photo', 'END extraction cases'] }),
];
export const LAST_DEFINED_MONTH = BRACES_PROTOCOL.length;
export function protocolFor(month) {
    if (!Number.isInteger(month) || month < 1)
        throw new Error(`Invalid braces month: ${month}`);
    return BRACES_PROTOCOL[Math.min(month, LAST_DEFINED_MONTH) - 1];
}
const rs = (n) => 'Rs ' + Math.round(n).toLocaleString('en-PK');
export function guidance(state) {
    const rule = protocolFor(state.month);
    const beyond = state.month > LAST_DEFINED_MONTH;
    const alerts = [];
    if (beyond) {
        alerts.push({ level: 'warning', text: `Month ${state.month} is beyond the defined protocol (${LAST_DEFINED_MONTH} months). Rule to confirm with Dr. Ali.` });
    }
    if (rule.photoRequired && !beyond)
        alerts.push({ level: 'stop', text: 'PHOTO MONTH: click photos before closing this visit.' });
    if (rule.requiresDrAliPlan && !state.hasDrAliPlan)
        alerts.push({ level: 'warning', text: 'Ask treatment plan from Dr. Ali.' });
    if (rule.extractionDecision && state.extractionPlan === 'undecided') {
        alerts.push({ level: 'warning', text: 'Decide and do extractions (record extraction / non-extraction).' });
    }
    if (rule.extractionDeadline)
        alerts.push({ level: 'warning', text: 'No extractions beyond this month. Make sure all extractions are done.' });
    if (state.month > 7 && state.extractionPlan === 'extraction' && !state.extractionsDone) {
        alerts.push({ level: 'stop', text: 'Extraction case past Month 7 with extractions not marked done. Send to Dr. Ali.' });
    }
    if (rule.duesCheckpoint && state.dues > 0)
        alerts.push({ level: 'stop', text: `Dues checkpoint: ${rs(state.dues)} must be cleared this month.` });
    if (rule.retainerPaymentReminder)
        alerts.push({ level: 'info', text: 'Remind patient about retainer payment.' });
    if (state.extractionPlan === 'non_extraction' && state.month > 12) {
        alerts.push({ level: 'stop', text: 'Overrun: non-extraction case past Month 12. On Dr. Ali review list.' });
    }
    else if (state.extractionPlan === 'extraction' && state.month > 18) {
        alerts.push({ level: 'stop', text: 'Overrun: extraction case past Month 18. On Dr. Ali review list.' });
    }
    else if (rule.endsNonExtraction && state.extractionPlan === 'non_extraction') {
        alerts.push({ level: 'info', text: 'Target end month for non-extraction case.' });
    }
    else if (rule.endsExtraction && state.extractionPlan === 'extraction') {
        alerts.push({ level: 'info', text: 'Target end month for extraction case.' });
    }
    return { month: state.month, rule, beyondProtocol: beyond, alerts };
}
/** Can a doctor in `group` treat (or check) this month? Dr. Ali (null group, admin) always can. */
export function canTreat(month, group, isDrAli = false) {
    if (isDrAli)
        return true;
    return group !== null && protocolFor(month).treatingGroups.includes(group);
}
export function canCheck(month, group, isDrAli = false) {
    if (isDrAli)
        return true;
    const checker = protocolFor(month).checkerGroup;
    return checker === null || group === checker;
}
/** Old sheets write the month as "4", "04 Photo", "13 Photo", "Monthly". */
export function parseMonthCell(cell) {
    if (cell === null || cell === undefined)
        return { month: null, photoMarked: false };
    const text = String(cell).trim();
    const match = text.match(/^(\d{1,2})\b/);
    return {
        month: match ? Number(match[1]) : null,
        photoMarked: /photo/i.test(text),
    };
}
