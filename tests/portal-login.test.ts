// The username and password rules for patient portal logins made at the clinic (src/lib/portal-login.ts), the
// login page's reading of what a patient types, and the checks that keep staff and patient logins apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  portalNamePart, portalMrPart, portalUsername, portalLoginEmail, isPatientLoginName, normalizeLoginInput,
  checkPortalPassword, generatePortalPassword, secureRandomInt, PASSWORD_WORDS, PASSWORD_DIGITS, NAME_PART_MAX, MR_PART_MAX,
} from '../src/lib/portal-login.ts';

const DOMAIN = 'dralirashid.com';

// ---------------------------------------------------------------- the username
test('username: the name lowercased with spaces and symbols removed, a dash, then the Mr#', () => {
  assert.equal(portalLoginEmail('Ali Rashid', '1705', DOMAIN), 'alirashid-1705@dralirashid.com');
  assert.equal(portalUsername('Sana  Farooq', '9811'), 'sanafarooq-9811');
  assert.equal(portalNamePart('  Hira-Javed (Kid) '), 'hirajavedkid');
});

test('username: accents and diacritics are dropped, not turned into gaps', () => {
  assert.equal(portalNamePart('José Müller'), 'josemuller');
  assert.equal(portalNamePart('Zoë Núñez-Ōkami'), 'zoenunezokami');
  assert.equal(portalNamePart('Ayşe Çelik'), 'aysecelik');
  assert.equal(portalNamePart('ﬁza'), 'fiza', 'a ligature is spelled out');
});

test('username: apostrophes, dots and other symbols vanish', () => {
  assert.equal(portalNamePart("O'Brien"), 'obrien');
  assert.equal(portalNamePart('D’Souza'), 'dsouza', 'a curly apostrophe too');
  assert.equal(portalNamePart('M. Ali (Jr.)'), 'malijr');
  assert.equal(portalNamePart('Dr. Ali/Rashid_2'), 'dralirashid2');
});

test('username: a name with no Latin letters (Urdu script, emoji, blank) becomes "patient"; the Mr# still tells patients apart', () => {
  assert.equal(portalNamePart('علی رشید'), 'patient');
  assert.equal(portalNamePart('😀 ***'), 'patient');
  assert.equal(portalNamePart('   '), 'patient');
  assert.equal(portalNamePart(undefined as unknown as string), 'patient');
  assert.equal(portalLoginEmail('علی رشید', '1705', DOMAIN), 'patient-1705@dralirashid.com');
  assert.notEqual(portalUsername('علی رشید', '1705'), portalUsername('علی رشید', '1706'));
});

test('username: a mixed Urdu and Latin name keeps the Latin letters', () => {
  assert.equal(portalNamePart('Ali علی Rashid'), 'alirashid');
});

test('username: a very long name is cut to a sensible length (the Mr# is never cut off by it)', () => {
  const long = 'Muhammad Abdul Rehman Siddiqui Al Hashmi Qureshi Farooqui';
  const name = portalNamePart(long);
  assert.equal(name.length, NAME_PART_MAX);
  assert.equal(name, 'muhammadabdulrehmansiddi');
  const email = portalLoginEmail(long, '1705', DOMAIN);
  assert.equal(email, 'muhammadabdulrehmansiddi-1705@dralirashid.com');
  assert.ok(email.split('@')[0].length <= 64, 'within the 64 characters an address may have before the @');
});

test('username: legacy Mr# keep their dash, anything else that is not a-z0-9 becomes a dash', () => {
  assert.equal(portalMrPart('347-1'), '347-1');
  assert.equal(portalLoginEmail('Ali Rashid', '347-1', DOMAIN), 'alirashid-347-1@dralirashid.com');
  assert.equal(portalMrPart('347/1'), '347-1');
  assert.equal(portalMrPart('347 1'), '347-1');
  assert.equal(portalMrPart('347 / 1'), '347-1', 'a run of symbols is one dash');
  assert.equal(portalMrPart(' A-12 '), 'a-12');
  assert.equal(portalMrPart('-347-'), '347', 'dashes at the ends go');
  assert.equal(portalMrPart('٣٤٧'), '', 'nothing usable');
  assert.equal(portalMrPart('9'.repeat(80)).length, MR_PART_MAX);
});

test('username: no usable Mr# gives no username at all (never "name-")', () => {
  assert.equal(portalUsername('Ali Rashid', ''), '');
  assert.equal(portalUsername('Ali Rashid', '///'), '');
  assert.equal(portalLoginEmail('Ali Rashid', '', DOMAIN), '');
});

test('username: only a-z, 0-9 and dashes ever come out, for any input', () => {
  const nasty = ['<script>', "x'; drop table--", 'a@b.com', 'name with\ttab\nand newline', '١٢٣', 'İstanbul', 'Łukasz', 'ǅ'];
  for (const name of nasty) for (const mr of ['1', 'A/B', '3.4', 'ß9']) {
    const u = portalUsername(name, mr);
    assert.match(u, /^[a-z0-9]+-[a-z0-9-]*[a-z0-9]$/, `${name} / ${mr} -> ${u}`);
  }
});

test('username: two patients with the same name get different usernames (the Mr# is unique)', () => {
  assert.notEqual(portalUsername('Ali Rashid', '1705'), portalUsername('Ali Rashid', '1706'));
});

test('username: the domain is lowercased and trimmed', () => {
  assert.equal(portalLoginEmail('Ali', '1', ' DrAliRashid.com '), 'ali-1@dralirashid.com');
});

// ---------------------------------------------------------------- staff and patient logins stay apart
test('patient-shaped addresses: name, dash, number at the clinic domain', () => {
  assert.equal(isPatientLoginName('alirashid-1705@dralirashid.com', DOMAIN), true);
  assert.equal(isPatientLoginName('patient-347-1@dralirashid.com', DOMAIN), true);
  assert.equal(isPatientLoginName('ALIRASHID-1705@DRALIRASHID.COM', DOMAIN), true, 'case does not matter');
  // Staff logins look like name@domain.
  assert.equal(isPatientLoginName('reception@dralirashid.com', DOMAIN), false);
  assert.equal(isPatientLoginName('dha.reception@dralirashid.com', DOMAIN), false);
  assert.equal(isPatientLoginName('ali.khan@dralirashid.com', DOMAIN), false);
  assert.equal(isPatientLoginName('front-desk@dralirashid.com', DOMAIN), false, 'a dash alone is not a number');
  // Other domains are never "patient logins" of the clinic.
  assert.equal(isPatientLoginName('alirashid-1705@gmail.com', DOMAIN), false);
  assert.equal(isPatientLoginName('alirashid-1705@mail.dralirashid.com', DOMAIN), false);
  assert.equal(isPatientLoginName('alirashid-1705', DOMAIN), false);
  assert.equal(isPatientLoginName('', DOMAIN), false);
  assert.equal(isPatientLoginName('alirashid-1705@dralirashid.com', ''), false);
});

test('every username the builder can make is recognised as patient-shaped, and a staff-style name never is', () => {
  for (const [name, mr] of [['Ali Rashid', '1705'], ['علی', '9811'], ['O\'Brien', '347-1'], ['x'.repeat(60), '10000'], ['Sana', '2']]) {
    assert.equal(isPatientLoginName(portalLoginEmail(name, mr, DOMAIN), DOMAIN), true, `${name} ${mr}`);
  }
  for (const staff of ['reception', 'dr.ali', 'dha.reception', 'accounts', 'front.desk.gulshan']) {
    assert.equal(isPatientLoginName(`${staff}@${DOMAIN}`, DOMAIN), false, staff);
  }
});

test('nothing in the database grants access by the address of a login: staff are the staff table, patients are portal_user_id', () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(new URL(file, dir), 'utf8').replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /auth\.email\s*\(/i, `${file} reads the login's email`);
    assert.doesNotMatch(sql, /auth\.jwt\s*\(/i, `${file} reads the login token`);
    assert.doesNotMatch(sql, /request\.jwt/i, `${file} reads the login token`);
    assert.doesNotMatch(sql, /dralirashid\.com/i, `${file} names the clinic domain`);
    assert.doesNotMatch(sql, /like\s+'%@/i, `${file} tests the end of an address`);
  }
});

// ---------------------------------------------------------------- what the patient types
test('login input: the whole address, or just the part before the @', () => {
  assert.equal(normalizeLoginInput('alirashid-1705@dralirashid.com', DOMAIN), 'alirashid-1705@dralirashid.com');
  assert.equal(normalizeLoginInput('alirashid-1705', DOMAIN), 'alirashid-1705@dralirashid.com');
  assert.equal(normalizeLoginInput('  AliRashid-1705  ', DOMAIN), 'alirashid-1705@dralirashid.com', 'spaces and capitals do not matter');
  assert.equal(normalizeLoginInput('alirashid- 1705', DOMAIN), 'alirashid-1705@dralirashid.com', 'a space in a copied username');
  assert.equal(normalizeLoginInput('347-1', DOMAIN), '347-1@dralirashid.com');
});

test('login input: a real email address is kept as typed (lowercased), never given the clinic domain', () => {
  assert.equal(normalizeLoginInput('Sara.K@Gmail.com', DOMAIN), 'sara.k@gmail.com');
  assert.equal(normalizeLoginInput(' sara@example.com ', DOMAIN), 'sara@example.com');
});

test('login input: nothing typed stays nothing; a half-typed address is left for the page to complain about', () => {
  assert.equal(normalizeLoginInput('', DOMAIN), '');
  assert.equal(normalizeLoginInput('   ', DOMAIN), '');
  assert.equal(normalizeLoginInput(undefined as unknown as string, DOMAIN), '');
  assert.equal(normalizeLoginInput('alirashid-1705@', DOMAIN), 'alirashid-1705@');
});

test('login input: a typed username is read as the same login the builder made', () => {
  const made = portalLoginEmail('Ali Rashid', '1705', DOMAIN);
  assert.equal(normalizeLoginInput(portalUsername('Ali Rashid', '1705'), DOMAIN), made);
});

// ---------------------------------------------------------------- passwords
test('password rules: 8 to 72 characters', () => {
  assert.equal(checkPortalPassword('1234567'), 'The password needs at least 8 characters.');
  assert.equal(checkPortalPassword('12345678'), null);
  assert.equal(checkPortalPassword('x'.repeat(72)), null);
  assert.match(checkPortalPassword('x'.repeat(73)) as string, /at most 72/);
  assert.equal(checkPortalPassword(undefined as unknown as string), 'The password needs at least 8 characters.');
});

test('generated passwords: two short words and four digits, and nothing that can be misread', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 400; i += 1) {
    const pw = generatePortalPassword();
    assert.match(pw, /^[a-hj-km-np-z]{3,5}-[a-hj-km-np-z]{3,5}-[2-9]{4}$/, pw);
    assert.equal(checkPortalPassword(pw), null);
    seen.add(pw);
  }
  assert.ok(seen.size > 390, 'passwords differ from one another');
  for (const w of PASSWORD_WORDS) assert.match(w, /^[a-hj-km-np-z]{3,5}$/, `"${w}" has a look-alike letter (i, l or o)`);
  assert.equal(new Set(PASSWORD_WORDS).size, PASSWORD_WORDS.length, 'no word twice');
  assert.doesNotMatch(PASSWORD_DIGITS, /[01]/);
});

test('generated passwords: the random source decides every pick (and an out-of-range source cannot break it)', () => {
  assert.equal(generatePortalPassword(() => 0), `${PASSWORD_WORDS[0]}-${PASSWORD_WORDS[0]}-2222`);
  const last = (n: number) => n - 1;
  assert.equal(generatePortalPassword(last), `${PASSWORD_WORDS.at(-1)}-${PASSWORD_WORDS.at(-1)}-9999`);
  for (let i = 0; i < 2000; i += 1) {
    const n = secureRandomInt(PASSWORD_WORDS.length);
    assert.ok(Number.isInteger(n) && n >= 0 && n < PASSWORD_WORDS.length);
  }
});

// ---------------------------------------------------------------- the copies of the source
test('the copies of portal-login.ts (browser and Edge Function) are the current source: run scripts/build-lib.sh', () => {
  const source = readFileSync(new URL('../src/lib/portal-login.ts', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../supabase/functions/admin-users/portal-login.ts', import.meta.url), 'utf8');
  assert.equal(copy.split('\n').slice(1).join('\n'), source, 'supabase/functions/admin-users/portal-login.ts is out of date');
  assert.match(copy.split('\n')[0], /^\/\/ COPY of src\/lib\/portal-login\.ts/);
  const browser = readFileSync(new URL('../web/js/lib/portal-login.js', import.meta.url), 'utf8');
  assert.match(browser.split('\n')[0], /^\/\/ GENERATED from src\/lib/);
  for (const name of ['portalUsername', 'portalLoginEmail', 'normalizeLoginInput', 'generatePortalPassword', 'isPatientLoginName', 'checkPortalPassword']) {
    assert.match(browser, new RegExp(`export function ${name}\\b`), `web/js/lib/portal-login.js lacks ${name}: run scripts/build-lib.sh`);
  }
});
