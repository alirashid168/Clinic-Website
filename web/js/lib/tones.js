// The colours of the Aaj ki List's Doctor Name chips (app.css .gs-*): one colour per person, as on the clinic's Google
// Sheet, so two doctors on a row, and the doctors down the list, do not look the same (owner, 11 Oct 2026). Pure
// functions, no DOM, so the rules can be tested in Node (tests/tones.test.ts). A chip always carries its name too, so
// colour is never the only cue.
import { BRACES_PROTOCOL } from './protocol.js';

// The chip colours of Google Sheets, light then dark: light grey is left for an empty chip, and dark yellow (nearly the
// dark grey at chip size) is left out, so every two of these fourteen are clearly different. The light ones are given
// first, as most of the sheet's doctors have one; a dark one once the light ones are taken.
const LIGHT = ['green', 'red', 'orange', 'blue', 'purple', 'teal', 'yellow'];
const DARK = ['brown', 'darkred', 'darkgreen', 'darkblue', 'darkpurple', 'darkteal', 'darkgrey'];
export const PERSON_TONES = [...LIGHT, ...DARK];
// The people the sheet itself has a colour for (matched on the name without "Dr."): they keep that colour.
const SHEET_TONES = [['hameeda', 'green'], ['komal rubab', 'red'], ['mirha', 'orange'], ['haniya', 'brown'], ['ali ahmed', 'darkred'],
  ['mehwish saleem', 'blue'], ['aimon aslam', 'purple'], ['anousha khan', 'teal']];

/** A name as the colour rules compare it: lower case, without "Dr.", letters only, single spaces. */
export const personKey = (name) => String(name || '').toLowerCase().replace(/^dr\b\.?/, '').replace(/[^a-z]+/g, ' ').trim();
const sheetTone = (key) => SHEET_TONES.find(([k]) => key === k || key.startsWith(`${k} `))?.[1] || null;
const hashOf = (text) => { let hash = 0; for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0; return hash; };
const byText = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
// Two people who are usually on the same branch's lists: the same region (KHI, LHR, ISB), or one of them has none (works
// anywhere). Someone can still help out in another city for a day, so the colours are only shared when they must be.
const canMeet = (a, b) => !a.region || !b.region || a.region === b.region;
// The groups the braces protocol puts in one Doctor Name cell: the group that treats a month and the group that checks it
// (as "1-1", "1-2", "2-3").
const pairKey = (x, y) => (x < y ? `${x}-${y}` : `${y}-${x}`);
const ROW_PAIRS = new Set(BRACES_PROTOCOL.flatMap((r) => (r.checkerGroup ? r.treatingGroups.map((g) => pairKey(g, r.checkerGroup)) : [])));
// How much it matters that two people share a colour: 0 when they are never on one list (canMeet); 1 for two assistants,
// or two doctors of one group that never treats and checks together (group 2, group 3); 2 for two doctors of groups the
// protocol never puts on one row (group 1 and group 3); 3 for a doctor and an assistant (often on one row, but the
// assistant's chip is dashed and says "asst."); 4 for two doctors who can be in one cell: a treater and a checker by the
// protocol, or a doctor in no group (Dr. Ali, who treats and checks any month, and anyone not in a group yet).
function clash(a, b) {
  if (!canMeet(a, b)) return 0;
  if (!a.is_doctor || !b.is_doctor) return !a.is_doctor && !b.is_doctor ? 1 : 3;
  const [x, y] = [a.doctor_group_id, b.doctor_group_id];
  if (!x || !y || ROW_PAIRS.has(pairKey(x, y))) return 4;
  return x === y ? 1 : 2;
}

/**
 * Every clinician's colour (id -> tone), from the clinic's list of clinicians (Clinic setup). The sheet's own people first;
 * then the others (those who work anywhere first, as they meet everyone; then by name) each take the colour that clashes
 * least with the people who have it already (clash, above: added up over them), and of those the one the fewest people
 * have at all (a light one before a dark one), starting from a colour picked from their name (so a person added later
 * moves few others). Then, while moving one of them to another colour, or swapping two of them, makes the clashes smaller,
 * that is done: the order above can leave the last assistant only doctors' colours to share, say, when two doctors who
 * are never on one row could share one instead. Up to fourteen people all differ; past that, a colour is shared by people
 * who are never on one row (two assistants, two doctors the protocol never puts together, someone in another city), and
 * by two doctors who can be in one Doctor Name cell only when nothing else is left. The same list gives the same colours
 * every time; a person's colour can change only when someone is added to or taken off the list.
 */
export function personTones(clinicians) {
  const tones = new Map();
  const given = []; // the people with a colour, in the order they got it
  const give = (c, tone) => { tones.set(c.id, tone); given.push(c); };
  // How much c clashes with the people who have this colour (leaving out `but`, someone c may swap with).
  const clashes = (c, tone, but = null) => given.reduce((sum, x) => sum + (x !== c && x !== but && tones.get(x.id) === tone ? clash(x, c) : 0), 0);
  const people = (clinicians || []).map((c) => ({ c, key: personKey(c.display_name) }));
  for (const { c, key } of people) { const tone = sheetTone(key); if (tone) give(c, tone); }
  const fromSheet = given.length; // (they keep the sheet's colour)
  const rest = people.filter(({ c }) => !tones.has(c.id))
    .sort((a, b) => Number(!!a.c.region) - Number(!!b.c.region) || byText(a.key, b.key) || byText(String(a.c.id), String(b.c.id)));
  for (const { c, key } of rest) {
    const start = hashOf(key);
    let best = null;
    let fewest = [Infinity, Infinity];
    for (let i = 0; i < PERSON_TONES.length; i += 1) {
      const tone = i < LIGHT.length ? LIGHT[(start + i) % LIGHT.length] : DARK[(start + i) % DARK.length];
      const score = [clashes(c, tone), given.filter((x) => tones.get(x.id) === tone).length];
      if (score[0] < fewest[0] || (score[0] === fewest[0] && score[1] < fewest[1])) { best = tone; fewest = score; }
    }
    give(c, best);
  }
  // (Each change makes the clashes of the whole list smaller, so this ends; the cap is only a guard.)
  const movable = given.slice(fromSheet);
  for (let round = 0, better = true; better && round < 50; round += 1) {
    better = false;
    for (const a of movable) {
      const mine = tones.get(a.id);
      const now = clashes(a, mine);
      if (!now) continue;
      const tone = PERSON_TONES.find((t) => clashes(a, t) < now);
      const b = tone ? null : movable.find((x) => {
        const theirs = tones.get(x.id);
        return theirs !== mine && clashes(a, theirs, x) + clashes(x, mine, a) < now + clashes(x, theirs);
      });
      if (tone) tones.set(a.id, tone);
      else if (b) { tones.set(a.id, tones.get(b.id)); tones.set(b.id, mine); }
      better ||= !!(tone || b);
    }
  }
  return tones;
}

/** One person's colour: from personTones, else (not on the clinic's list, say no longer active) the sheet's or one picked from the id. */
export function personTone(tones, id, name) {
  return tones?.get(id) || sheetTone(personKey(name)) || LIGHT[hashOf(id || personKey(name)) % LIGHT.length];
}
