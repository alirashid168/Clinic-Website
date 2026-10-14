// The colours of the Aaj ki List's Doctor Name chips (app.css .gs-*): one colour per person, as on the clinic's Google
// Sheet, so two doctors on a row, and the doctors down the list, do not look the same (owner, 11 Oct 2026). Pure
// functions, no DOM, so the rules can be tested in Node (tests/tones.test.ts). A chip always carries its name too, so
// colour is never the only cue.

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

/**
 * Every clinician's colour (id -> tone), from the clinic's list of clinicians (Clinic setup). The sheet's own people first;
 * then the others (those who work anywhere first, as they meet everyone; then by name) each take the colour that the
 * fewest people they usually meet on a list have already, and of those the one the fewest people have at all (a light
 * one before a dark one), starting from a colour picked from their name (so a person added later moves few others).
 * Up to fourteen people all differ; past that, a colour is shared with as few of the people one meets as can be (in
 * another city first). A person keeps their colour on every row and every day; it can change only when someone is added
 * to or taken off the list.
 */
export function personTones(clinicians) {
  const tones = new Map();
  const given = [];
  const give = (c, tone) => { tones.set(c.id, tone); given.push([c, tone]); };
  const people = (clinicians || []).map((c) => ({ c, key: personKey(c.display_name) }));
  for (const { c, key } of people) { const tone = sheetTone(key); if (tone) give(c, tone); }
  const rest = people.filter(({ c }) => !tones.has(c.id))
    .sort((a, b) => Number(!!a.c.region) - Number(!!b.c.region) || byText(a.key, b.key) || byText(String(a.c.id), String(b.c.id)));
  for (const { c, key } of rest) {
    const start = hashOf(key);
    let best = null;
    let fewest = [Infinity, Infinity];
    for (let i = 0; i < PERSON_TONES.length; i += 1) {
      const tone = i < LIGHT.length ? LIGHT[(start + i) % LIGHT.length] : DARK[(start + i) % DARK.length];
      const have = given.filter(([, t]) => t === tone);
      const score = [have.filter(([x]) => canMeet(x, c)).length, have.length];
      if (score[0] < fewest[0] || (score[0] === fewest[0] && score[1] < fewest[1])) { best = tone; fewest = score; }
    }
    give(c, best);
  }
  return tones;
}

/** One person's colour: from personTones, else (not on the clinic's list, say no longer active) the sheet's or one picked from the id. */
export function personTone(tones, id, name) {
  return tones?.get(id) || sheetTone(personKey(name)) || LIGHT[hashOf(id || personKey(name)) % LIGHT.length];
}
