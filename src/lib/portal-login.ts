// Patient portal logins made at the clinic. Staff press one button; the patient logs in with their Mr# and their own mobile
// number (the owner, 17 Oct 2026: "the patient user creation should be simple, and we keep the password, the patient can change
// it themselves later"; his choices: the password is the phone number on file, the login name is the Mr#, no forced change).
//
// Behind the scenes a login is an email address at the clinic's domain: since 17 Oct 2026 "mr-50013@dralirashid.com" (the Mr#
// alone, so the login page turns a typed Mr# into the address by itself: no lookup, nothing to leak); before that it was the
// name and Mr#, "alirashid-1705@dralirashid.com", and those logins still work when typed in full or as the part before the @.
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
    .replace(/[\u0300-\u036f]/g, '') // combining accent marks
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

/** What staff are told when a patient's Mr# cannot make a username (no Mr#, or a Mr# with no number in it). */
export const NO_USERNAME_MESSAGE = 'This patient has no usable Mr# (it needs a number in it), so a username cannot be made.';

/** "alirashid-1705@dralirashid.com", or '' when there is no usable Mr#. */
export function portalLoginEmail(fullName: string, mr: string, domain: string): string {
  const username = portalUsername(fullName, mr);
  return username ? `${username}@${String(domain).trim().toLowerCase()}` : '';
}

/** What a Mr# login's address starts with: "mr-50013@...". It has the reserved patient shape below (letters, a dash, a number). */
export const MR_LOGIN_PREFIX = 'mr-';

/** "mr-50013@dralirashid.com" (a legacy Mr# keeps its dash: "mr-347-1@..."), or '' when there is no usable Mr#. The login made since 17 Oct 2026. */
export function mrLoginEmail(mr: string, domain: string): string {
  const mrPart = portalMrPart(mr);
  return mrPart ? `${MR_LOGIN_PREFIX}${mrPart}@${String(domain).trim().toLowerCase()}` : '';
}

/** True when this login address is the Mr# login of this patient (so the profile can say "Login: Mr# 50013" instead of showing the address). */
export function isMrLoginEmail(email: string, mr: string, domain: string): boolean {
  const made = mrLoginEmail(mr, domain);
  return !!made && String(email ?? '').trim().toLowerCase() === made;
}

/**
 * The password of a login made at the clinic: the patient's mobile number as on file, digits only ("0300-555 1234" -> "03005551234").
 * '' when there is no phone. Families share a phone, so the phone is never the login name, only the password behind a unique Mr#.
 */
export function phonePassword(phone: string | null | undefined): string {
  return String(phone ?? '').replace(/[^0-9]/g, '');
}

/** What staff are told when the phone on file cannot be the password (none, or too short for the login server). */
export const PHONE_PASSWORD_MESSAGE = `This patient has no mobile number on file with at least ${PASSWORD_MIN} digits. Add the phone number first (Edit), or type a password below.`;

/** The problem with using the phone on file as the password, or null when it will do. */
export function checkPhonePassword(phone: string | null | undefined): string | null {
  const digits = phonePassword(phone);
  if (digits.length < PASSWORD_MIN || digits.length > PASSWORD_MAX) return PHONE_PASSWORD_MESSAGE;
  return null;
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
 * What the patient types on the login page, turned into the address to sign in with:
 *   - a Mr# ("50013", "Mr# 50013", "mr-50013", a legacy "347-1"): the Mr# login, mr-50013@<domain>;
 *   - a username from an older slip ("alirashid-1705"): that username at the clinic's domain;
 *   - a whole email address: as typed.
 * Spaces are removed (a copied username can carry them) and letters are lowercased. Anything that starts with a digit (after an
 * optional "mr", "mr#" or "mr-") is a Mr#: an older username always starts with a letter.
 */
export function normalizeLoginInput(input: string, domain: string): string {
  const text = String(input ?? '').replace(/\s+/g, '').toLowerCase();
  if (!text) return '';
  if (text.includes('@')) return text;
  const host = String(domain).trim().toLowerCase();
  const mr = text.match(/^(?:mr)?[#.:-]*([0-9][a-z0-9-]*)$/);
  if (mr) return mrLoginEmail(mr[1], host) || `${text}@${host}`;
  return `${text}@${host}`;
}

/** The problem with a password staff or a patient chose, in plain words, or null when it is fine. */
export function checkPortalPassword(password: string): string | null {
  const text = String(password ?? '');
  if (text.length < PASSWORD_MIN) return `The password needs at least ${PASSWORD_MIN} characters.`;
  if (text.length > PASSWORD_MAX) return `The password can be at most ${PASSWORD_MAX} characters.`;
  return null;
}
