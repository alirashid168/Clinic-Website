// Patient portal logins made at the clinic. Staff create the login and hand the patient a username and a
// password; the patient chooses their own password the first time they log in.
//
// The username is the patient's name and Mr# at the clinic's domain, for example "alirashid-1705@dralirashid.com".
// This file is the one source of the rules. scripts/build-lib.sh writes the browser copy (web/js/lib/portal-login.js)
// and a copy for the admin-users Edge Function (supabase/functions/admin-users/portal-login.ts); a test fails when the
// copies are out of date. Keep it free of imports and of Deno / browser / Node specifics.

export const PASSWORD_MIN = 8;
/** GoTrue (the Supabase login server) refuses passwords longer than this. */
export const PASSWORD_MAX = 72;
/** The name part of a username is cut to this many letters and digits. */
export const NAME_PART_MAX = 24;
/** The Mr# part of a username is cut to this many characters. */
export const MR_PART_MAX = 30;

/**
 * The name part: lowercase a-z and 0-9 only. Accents are dropped ("José" -> "jose"), spaces, apostrophes and every other
 * symbol are removed. A name with no Latin letters at all (Urdu script) becomes "patient"; the Mr# still tells patients apart.
 */
export function portalNamePart(fullName: string): string {
  const letters = String(fullName ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, NAME_PART_MAX);
  return letters || 'patient';
}

/** The Mr# part: anything that is not a-z or 0-9 becomes "-" (a legacy Mr# like "347-1" stays as it is). Empty when there is nothing usable. */
export function portalMrPart(mr: string): string {
  return String(mr ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MR_PART_MAX)
    .replace(/-+$/, '');
}

/** "alirashid-1705": the name, a dash, the Mr#. Empty when the Mr# is unusable (a patient always has one). */
export function portalUsername(fullName: string, mr: string): string {
  const mrPart = portalMrPart(mr);
  return mrPart ? `${portalNamePart(fullName)}-${mrPart}` : '';
}

/** "alirashid-1705@dralirashid.com", or '' when there is no usable Mr#. */
export function portalLoginEmail(fullName: string, mr: string, domain: string): string {
  const username = portalUsername(fullName, mr);
  return username ? `${username}@${String(domain).trim().toLowerCase()}` : '';
}

const PATIENT_LOGIN_LOCAL = /^[a-z0-9]+-[a-z0-9-]*[0-9][a-z0-9-]*$/;

/**
 * True for an address that has the shape of a patient username at the clinic's domain: letters and digits, a dash, then
 * something with a number in it. Staff logins are written like "reception@dralirashid.com" (no dash and number), and
 * the staff functions refuse a staff address of this shape, so the two can never be mixed up by looking at the address.
 * (Who is staff is decided by the staff table, never by the address.)
 */
export function isPatientLoginName(email: string, domain: string): boolean {
  const text = String(email ?? '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at < 1) return false;
  const host = String(domain).trim().toLowerCase();
  return !!host && text.slice(at + 1) === host && text.length - host.length - 1 <= 64 && PATIENT_LOGIN_LOCAL.test(text.slice(0, at));
}

/**
 * What the patient types on the login page, turned into the address to sign in with: the whole address, or just the part
 * before the @ (the clinic's domain is added). Spaces are removed (a copied username can carry them) and letters are lowercased.
 */
export function normalizeLoginInput(input: string, domain: string): string {
  const text = String(input ?? '').replace(/\s+/g, '').toLowerCase();
  if (!text) return '';
  return text.includes('@') ? text : `${text}@${String(domain).trim().toLowerCase()}`;
}

/** The problem with a password staff or a patient chose, in plain words, or null when it is fine. */
export function checkPortalPassword(password: string): string | null {
  const text = String(password ?? '');
  if (text.length < PASSWORD_MIN) return `The password needs at least ${PASSWORD_MIN} characters.`;
  if (text.length > PASSWORD_MAX) return `The password can be at most ${PASSWORD_MAX} characters.`;
  return null;
}

// Short, easy words. None has the letters i, l or o, and the digits below skip 0 and 1, so nothing in a password
// can be mistaken for something else when it is read off a slip (l / 1 / I, o / 0).
export const PASSWORD_WORDS: readonly string[] = [
  'sunny', 'happy', 'bread', 'peach', 'grape', 'zebra', 'sheep', 'berry', 'brave', 'bunny', 'candy', 'dusty', 'fresh', 'jumpy',
  'navy', 'peace', 'queen', 'range', 'sweet', 'tasty', 'water', 'zesty', 'stars', 'smart', 'green', 'grass', 'dream', 'cream',
  'crane', 'chase', 'dance', 'fence', 'bench', 'beach', 'chess', 'chart', 'charm', 'cheer', 'dawn', 'dune', 'farm', 'fern',
  'gate', 'hare', 'hunt', 'jade', 'keep', 'nest', 'pear', 'pump', 'rush', 'sand', 'seed', 'tent', 'tree', 'tuna', 'vase',
  'wave', 'yarn', 'yard', 'zest', 'cage', 'cake', 'camp', 'cave', 'dare',
];
export const PASSWORD_DIGITS = '23456789';

/** A random whole number from 0 to n-1 from the system's secure random numbers (no modulo bias). */
export function secureRandomInt(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  const one = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(one); } while (one[0] >= limit);
  return one[0] % n;
}

/** Two short words and four digits, like "sunny-grape-4827": easy to read out, type and remember for the few minutes it is needed. */
export function generatePortalPassword(randomInt: (n: number) => number = secureRandomInt): string {
  const word = () => PASSWORD_WORDS[randomInt(PASSWORD_WORDS.length)];
  let digits = '';
  for (let i = 0; i < 4; i += 1) digits += PASSWORD_DIGITS[randomInt(PASSWORD_DIGITS.length)];
  return `${word()}-${word()}-${digits}`;
}
