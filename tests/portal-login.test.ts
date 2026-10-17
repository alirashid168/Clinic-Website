// The username and password rules for patient portal logins made at the clinic (src/lib/portal-login.ts): the Mr# login
// ("mr-50013@...", the owner's 17 Oct 2026 choice: the patient types only the Mr#) and the older name-Mr# usernames that still work,
// the phone number as the password, the login page's reading of what a patient types, and the checks that keep staff and patient
// logins apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  portalNamePart, portalMrPart, portalUsername, portalLoginEmail, isPatientLoginName, normalizeLoginInput,
  checkPortalPassword, checkPhonePassword, phonePassword, mrLoginEmail, isMrLoginEmail, MR_LOGIN_PREFIX, PHONE_PASSWORD_MESSAGE,
  NAME_PART_MAX, MR_PART_MAX, PASSWORD_MIN, NO_USERNAME_MESSAGE,
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

test('a Mr# with no digit gives an address outside the patient shape, which is why create_patient_login (and the dialog) refuse it', () => {
  assert.equal(portalLoginEmail('Ali Rashid', 'abc', DOMAIN), 'alirashid-abc@dralirashid.com');
  assert.equal(isPatientLoginName(portalLoginEmail('Ali Rashid', 'abc', DOMAIN), DOMAIN), false);
  assert.equal(isPatientLoginName(portalLoginEmail('Ali Rashid', 'a1', DOMAIN), DOMAIN), true);
  assert.match(NO_USERNAME_MESSAGE, /Mr#/);
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
  assert.equal(normalizeLoginInput('347-1', DOMAIN), 'mr-347-1@dralirashid.com', 'a legacy Mr# is a Mr#');
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

// ---------------------------------------------------------------- the Mr# login (since 17 Oct 2026)
test('Mr# login: "mr-" and the Mr# at the clinic domain; a legacy Mr# keeps its dash; no usable Mr# gives nothing', () => {
  assert.equal(MR_LOGIN_PREFIX, 'mr-');
  assert.equal(mrLoginEmail('50013', DOMAIN), 'mr-50013@dralirashid.com');
  assert.equal(mrLoginEmail(' 347-1 ', ' DrAliRashid.com '), 'mr-347-1@dralirashid.com');
  assert.equal(mrLoginEmail('347/1', DOMAIN), 'mr-347-1@dralirashid.com');
  assert.equal(mrLoginEmail('', DOMAIN), '');
  assert.equal(mrLoginEmail('///', DOMAIN), '');
  for (const mr of ['50013', '347-1', '9', '9'.repeat(30), 'a1']) assert.equal(isPatientLoginName(mrLoginEmail(mr, DOMAIN), DOMAIN), true, `${mr} has the reserved patient shape`);
  assert.equal(isPatientLoginName(mrLoginEmail('abc', DOMAIN), DOMAIN), false, 'a Mr# with no digit is outside the shape (refused by the function)');
});

test('isMrLoginEmail: this patient\'s Mr# login, whatever the case; not another Mr#, not an older name-Mr# login', () => {
  assert.equal(isMrLoginEmail('mr-50013@dralirashid.com', '50013', DOMAIN), true);
  assert.equal(isMrLoginEmail('MR-50013@DrAliRashid.com ', '50013', DOMAIN), true);
  assert.equal(isMrLoginEmail('mr-50014@dralirashid.com', '50013', DOMAIN), false);
  assert.equal(isMrLoginEmail('alirashid-50013@dralirashid.com', '50013', DOMAIN), false);
  assert.equal(isMrLoginEmail('', '50013', DOMAIN), false);
  assert.equal(isMrLoginEmail('mr-@dralirashid.com', '', DOMAIN), false);
});

test('login input: a Mr# typed in any of the usual ways becomes the Mr# login; an older username and a real email are left as they were', () => {
  for (const typed of ['50013', ' 50013 ', 'Mr# 50013', 'MR 50013', 'mr-50013', '#50013', 'mr50013', 'Mr#50013'])
    assert.equal(normalizeLoginInput(typed, DOMAIN), 'mr-50013@dralirashid.com', JSON.stringify(typed));
  assert.equal(normalizeLoginInput('347-1', DOMAIN), 'mr-347-1@dralirashid.com', 'a legacy Mr#');
  assert.equal(normalizeLoginInput('mr-347-1@dralirashid.com', DOMAIN), 'mr-347-1@dralirashid.com', 'the whole address');
  assert.equal(normalizeLoginInput('alirashid-1705', DOMAIN), 'alirashid-1705@dralirashid.com', 'an older slip username starts with a letter');
  assert.equal(normalizeLoginInput('mrkhan-1705', DOMAIN), 'mrkhan-1705@dralirashid.com', 'a name that starts with "mr" is still a name');
  assert.equal(normalizeLoginInput('sara@example.com', DOMAIN), 'sara@example.com');
});

// ---------------------------------------------------------------- passwords
test('the phone number as the password: digits only, at least 8 of them, at most 72', () => {
  assert.equal(phonePassword('0300-555 1234'), '03005551234');
  assert.equal(phonePassword('+92 300 5551234'), '923005551234', 'as on file, digits only (the login server compares the whole string)');
  assert.equal(phonePassword(null), '');
  assert.equal(phonePassword(undefined), '');
  assert.equal(checkPhonePassword('0300 5551234'), null);
  assert.equal(checkPhonePassword('02134567'), null, 'eight digits will do');
  assert.equal(checkPhonePassword('0300'), PHONE_PASSWORD_MESSAGE);
  assert.equal(checkPhonePassword(''), PHONE_PASSWORD_MESSAGE);
  assert.equal(checkPhonePassword(null), PHONE_PASSWORD_MESSAGE);
  assert.equal(checkPhonePassword('9'.repeat(73)), PHONE_PASSWORD_MESSAGE);
  assert.match(PHONE_PASSWORD_MESSAGE, new RegExp(`at least ${PASSWORD_MIN} digits`));
  assert.match(PHONE_PASSWORD_MESSAGE, /Add the phone number first/);
});

test('password rules (a patient\'s own password): 8 to 72 characters', () => {
  assert.equal(checkPortalPassword('1234567'), 'The password needs at least 8 characters.');
  assert.equal(checkPortalPassword('12345678'), null);
  assert.equal(checkPortalPassword('x'.repeat(72)), null);
  assert.match(checkPortalPassword('x'.repeat(73)) as string, /at most 72/);
  assert.equal(checkPortalPassword(undefined as unknown as string), 'The password needs at least 8 characters.');
});

// ---------------------------------------------------------------- the copies of the source
test('the copies of portal-login.ts (browser and Edge Function) are the current source: run scripts/build-lib.sh', () => {
  const source = readFileSync(new URL('../src/lib/portal-login.ts', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../supabase/functions/admin-users/portal-login.ts', import.meta.url), 'utf8');
  assert.equal(copy.split('\n').slice(1).join('\n'), source, 'supabase/functions/admin-users/portal-login.ts is out of date');
  assert.match(copy.split('\n')[0], /^\/\/ COPY of src\/lib\/portal-login\.ts/);
  const browser = readFileSync(new URL('../web/js/lib/portal-login.js', import.meta.url), 'utf8');
  assert.match(browser.split('\n')[0], /^\/\/ GENERATED from src\/lib/);
  for (const name of ['portalUsername', 'portalLoginEmail', 'normalizeLoginInput', 'mrLoginEmail', 'isMrLoginEmail', 'phonePassword', 'checkPhonePassword', 'isPatientLoginName', 'checkPortalPassword']) {
    assert.match(browser, new RegExp(`export function ${name}\\b`), `web/js/lib/portal-login.js lacks ${name}: run scripts/build-lib.sh`);
  }
});
