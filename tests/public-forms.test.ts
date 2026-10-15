// The homepage forms: the shared rules of web/js/lib/public-forms.js (the database has the same rules in
// supabase/migrations/20261011000200_public_forms.sql, tested in supabase/tests/29_public_forms_test.sql).
// Every name, phone and CNIC here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POSITIONS, QUALIFICATIONS, FEEDBACK_TOPICS, FEEDBACK_KINDS, JOB_STATUSES, CV_TYPES, CV_MAX_BYTES, CV_UPLOAD_LIMITS, LIMITS, HONEYPOT,
  cleanLine, cleanBlock, normalizePhone, formatPhone, normalizeCnic, cvFileInfo, checkJobApplication, checkFeedback, feedbackSubject, submitProblem, mailtoHref,
} from '../web/js/lib/public-forms.js';

const NOW = new Date('2026-10-12T10:00:00+05:00');
const file = (name: string, type: string, size = 2000) => ({ name, type, size });
const job = (over: Record<string, unknown> = {}) => ({
  full_name: 'Sample Applicant', phone: '0300 5550101', email: '', position: 'dentist', qualification: 'BDS', graduation_year: '',
  experience: '', branch: '2', cnic: '12345-0000001-1', message: '', consent: true, pf_trap: '', ...over,
});
const fields = (r: { errors: { field: string }[] }) => r.errors.map((e) => e.field);

test('lists: the jobs of the old Google form, ten topics, three types, five statuses', () => {
  assert.deepEqual(POSITIONS.map((p) => p.label), ['Dentist', 'Orthodontist', 'Dental hygienist', 'Dental assistant', 'Clinic coordinator',
    'Receptionist / front desk', 'Social media coordinator', 'Other']);
  assert.equal(FEEDBACK_TOPICS.length, 10);
  assert.ok(FEEDBACK_TOPICS.some((t) => t.label === 'Clinic cleanliness'));
  assert.deepEqual(FEEDBACK_KINDS.map((k) => k.value), ['complaint', 'suggestion', 'appreciation']);
  assert.deepEqual(JOB_STATUSES.map((s) => s.label), ['New', 'Contacted', 'Interview', 'Hired', 'Rejected']);
  assert.equal(CV_MAX_BYTES, 5 * 1024 * 1024);
  assert.deepEqual(Object.keys(CV_TYPES), ['pdf', 'doc', 'docx', 'jpg', 'png']);
  // the numbers of private.job_cv_upload_problem in the migration (the demo follows these)
  assert.deepEqual(CV_UPLOAD_LIMITS, { perMinute: 5, perDay: 100, bytesPerDay: 200 * 1048576, unsentBytes: 100 * 1048576 });
});

test('phone: Pakistani mobile numbers however they are written, nothing else', () => {
  for (const v of ['03005550101', '0300 5550101', '0300-5550101', '+92 300 5550101', '923005550101', '0092 300 5550101', '300 5550101']) {
    assert.equal(normalizePhone(v), '03005550101', v);
  }
  for (const v of ['', '12345', '021 34567890', '04005550101', '0300555010', '030055501011', 'abc']) assert.equal(normalizePhone(v), null, v);
  assert.equal(formatPhone('03005550101'), '0300 5550101');
});

test('CNIC: 13 digits, shown and stored as 12345-1234567-1', () => {
  assert.equal(normalizeCnic('1234512345671'), '12345-1234567-1');
  assert.equal(normalizeCnic(' 12345 1234567 1 '), '12345-1234567-1');
  assert.equal(normalizeCnic('12345-1234567-1'), '12345-1234567-1');
  for (const v of ['', '123451234567', '12345123456712', 'CNIC']) assert.equal(normalizeCnic(v), null, v);
});

test('text stays plain text: control characters go, tags are kept as typed', () => {
  assert.equal(cleanLine('  Sample \t  Name\u0007 '), 'Sample Name');
  assert.equal(cleanBlock('Line one\r\nLine two <b>bold</b>\u0000\u0008 \n'), 'Line one\nLine two <b>bold</b>');
});

test('invisible characters that can disguise text go (the same as private.form_line / form_block)', () => {
  assert.equal(cleanLine('Sample\u200B Na\u200Dme\u200F '), 'Sample Name', 'zero-width characters and direction marks');
  assert.equal(cleanLine('\u202Etxet\u202C and \u2066more\u2069\uFEFF'), 'txet and more', 'an override, an isolate and the byte order mark');
  assert.equal(cleanLine('\u200B\u200C\u200D\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\uFEFF'), '', 'every one of them');
  assert.equal(cleanBlock('Line one\u202E\r\nLine\u200B two\u2067'), 'Line one\nLine two');
  assert.equal(cleanLine('Ali \u0639\u0644\u06CC \u2014 caf\u00E9'), 'Ali \u0639\u0644\u06CC \u2014 caf\u00E9', 'other text is kept as typed');
  assert.deepEqual(fields(checkJobApplication(job({ full_name: '\u200B\u202E\u200B' }), { now: NOW })), ['full_name'], 'a name of invisible characters only is no name');
  assert.equal(checkFeedback({ kind: 'complaint', topic: 'other', branch: 'none', message: 'Shown \u202Ebackwards\u202C here.' }).data.message, 'Shown backwards here.');
});

test('CV: PDF, Word, JPG or PNG up to 5 MB, the type taken from the file ending', () => {
  assert.deepEqual(cvFileInfo(file('cv.pdf', 'application/pdf')), { ext: 'pdf', type: 'application/pdf' });
  assert.deepEqual(cvFileInfo(file('CV.JPEG', 'image/jpeg')), { ext: 'jpg', type: 'image/jpeg' });
  assert.deepEqual(cvFileInfo(file('photo.jpg', 'image/jpg')), { ext: 'jpg', type: 'image/jpeg' }, 'image/jpg is how some phones name a JPG');
  assert.deepEqual(cvFileInfo(file('cv.docx', '')), { ext: 'docx', type: CV_TYPES.docx }, 'a phone that gives no type');
  assert.deepEqual(cvFileInfo(file('cv.doc', 'application/octet-stream')), { ext: 'doc', type: CV_TYPES.doc });
  assert.match(cvFileInfo(null).error, /attach your CV/);
  assert.match(cvFileInfo(file('cv.html', 'text/html')).error, /PDF, Word/);
  assert.match(cvFileInfo(file('cv.pdf', 'text/html')).error, /PDF, Word/, 'the type a browser names must agree with the ending');
  assert.match(cvFileInfo(file('cv.svg', 'image/svg+xml')).error, /PDF, Word/);
  // A name without an ending (a phone's "document", a WhatsApp file) is known by one of the five types, and gets its ending.
  assert.deepEqual(cvFileInfo(file('document', 'application/pdf')), { ext: 'pdf', type: 'application/pdf' });
  assert.deepEqual(cvFileInfo(file('IMG-20261012-WA0003', 'image/jpeg')), { ext: 'jpg', type: 'image/jpeg' });
  assert.deepEqual(cvFileInfo(file('Scan', 'image/jpg')), { ext: 'jpg', type: 'image/jpeg' });
  assert.deepEqual(cvFileInfo(file('photo', 'image/png')), { ext: 'png', type: 'image/png' });
  assert.deepEqual(cvFileInfo(file('CV', 'application/msword')), { ext: 'doc', type: CV_TYPES.doc });
  assert.deepEqual(cvFileInfo(file('My CV.', CV_TYPES.docx)), { ext: 'docx', type: CV_TYPES.docx });
  assert.match(cvFileInfo(file('document', '')).error, /PDF, Word/, 'no ending and no type: not known');
  assert.match(cvFileInfo(file('document', 'application/octet-stream')).error, /PDF, Word/);
  assert.match(cvFileInfo(file('page', 'text/html')).error, /PDF, Word/, 'no ending and another type');
  assert.match(cvFileInfo(file('cv.pdf', 'application/pdf', 0)).error, /empty/);
  assert.match(cvFileInfo(file('cv.pdf', 'application/pdf', CV_MAX_BYTES + 1)).error, /larger than 5 MB/);
  assert.equal(cvFileInfo(file('cv.pdf', 'application/pdf', CV_MAX_BYTES)).error, undefined, 'exactly 5 MB is allowed');
});

test('"Join our team": a complete form passes and is sent in one shape', () => {
  const r = checkJobApplication(job({ phone: '+92 300 5550101', cnic: '1234500000011', full_name: '  Sample   Applicant ', branch: 'any', graduation_year: '2020' }),
    { cv: file('cv.pdf', 'application/pdf'), now: NOW });
  assert.deepEqual(r.errors, []);
  assert.equal(r.data.phone, '03005550101');
  assert.equal(r.data.cnic, '12345-0000001-1');
  assert.equal(r.data.full_name, 'Sample Applicant');
  assert.equal(r.data.branch, 'any');
  assert.equal(r.data.graduation_year, 2020);
  assert.equal(r.data.email, null);
  assert.equal(r.data.consent, true);
  assert.equal(checkJobApplication(job({ branch: '3' }), { now: NOW }).data.branch, 3);
});

test('"Join our team": every required field and every limit has its own message', () => {
  const empty = checkJobApplication({}, { cv: null, now: NOW });
  assert.deepEqual(fields(empty), ['full_name', 'phone', 'position', 'qualification', 'branch', 'cnic', 'cv', 'consent']);
  assert.ok(empty.errors.every((e) => /^Please|^A CNIC/.test(e.message)), 'plain sentences');
  const one = (over: Record<string, unknown>) => fields(checkJobApplication(job(over), { now: NOW }));
  assert.deepEqual(one({ full_name: 'A' }), ['full_name']);
  assert.deepEqual(one({ full_name: '12345' }), ['full_name']);
  assert.deepEqual(one({ full_name: 'a'.repeat(LIMITS.name + 1) }), ['full_name']);
  assert.deepEqual(one({ phone: '021 34567890' }), ['phone']);
  assert.deepEqual(one({ email: 'not an email' }), ['email']);
  assert.deepEqual(one({ position: 'surgeon' }), ['position']);
  assert.deepEqual(one({ qualification: 'b'.repeat(LIMITS.qualification + 1) }), ['qualification']);
  assert.deepEqual(one({ graduation_year: '1950' }), ['graduation_year']);
  assert.deepEqual(one({ graduation_year: '2033' }), ['graduation_year'], 'more than six years ahead');
  assert.deepEqual(one({ graduation_year: '2032' }), [], 'six years ahead (a student)');
  assert.deepEqual(one({ experience: 'c'.repeat(LIMITS.experience + 1) }), ['experience']);
  assert.deepEqual(one({ branch: '' }), ['branch']);
  assert.deepEqual(one({ cnic: '12345-123456-1' }), ['cnic']);
  assert.deepEqual(one({ message: 'd'.repeat(LIMITS.jobMessage + 1) }), ['message']);
  assert.deepEqual(one({ consent: 'yes' }), ['consent'], 'only the tick itself counts as consent');
});

test('"Join our team": "Other" in the degree list asks for the degree itself, and the word "Other" is never sent', () => {
  assert.equal(QUALIFICATIONS.at(-1), 'Other');
  const typed = checkJobApplication(job({ qualification: 'Other', qualification_other: '  BSc   Nursing ' }), { now: NOW });
  assert.deepEqual(typed.errors, []);
  assert.equal(typed.data.qualification, 'BSc Nursing', 'the degree typed in the box is sent');
  assert.ok(!('qualification_other' in typed.data), 'one degree field is sent');
  const one = (over: Record<string, unknown>) => checkJobApplication(job(over), { now: NOW }).errors;
  assert.deepEqual(one({ qualification: 'Other', qualification_other: '' }), [{ field: 'qualification_other', message: 'Please type your degree or qualification, for example BA or BSc.' }],
    '"Other" with the box empty: the box says what is missing');
  assert.deepEqual(one({ qualification: 'Other', qualification_other: 'other' }).map((e) => e.field), ['qualification_other'], '"Other" typed in the box is no degree either');
  assert.deepEqual(one({ qualification: 'Other', qualification_other: 'x'.repeat(LIMITS.qualification + 1) }).map((e) => e.field), ['qualification_other']);
  assert.deepEqual(one({ qualification: 'Others' }).map((e) => e.field), ['qualification_other'], 'a form that says "Others" as its degree (as the database sees it) is refused');
  assert.deepEqual(one({ qualification: '' }), [{ field: 'qualification', message: 'Please choose your degree or qualification.' }]);
  assert.deepEqual(one({ qualification: 'Diploma', qualification_other: 'ignored' }), []);
  assert.equal(checkJobApplication(job({ qualification: 'Diploma', qualification_other: 'ignored' }), { now: NOW }).data.qualification, 'Diploma', 'a list choice is sent as chosen');
});

test('"Join our team": an email address is one plain address, and its mailto: link adds nothing to the email', () => {
  const one = (email: string) => fields(checkJobApplication(job({ email }), { now: NOW }));
  for (const bad of ['sample?cc=boss@example.com', 'sample@example.com?subject=hi', 'sam&ple@example.com', 'sample=1@example.com', 'sam%40ple@example.com',
    'sample#x@example.com', 'sam ple@example.com', 'not an email']) {
    assert.deepEqual(one(bad), ['email'], bad);
    assert.equal(mailtoHref(bad), null, 'no link for ' + bad);
  }
  for (const good of ['sample.applicant@example.com', 'sample+jobs@example.co.pk', "o'neil@example.com"]) assert.deepEqual(one(good), [], good);
  assert.equal(mailtoHref('sample.applicant@example.com'), 'mailto:sample.applicant@example.com');
  assert.equal(mailtoHref('sample+jobs@example.co.pk'), 'mailto:sample%2Bjobs@example.co.pk', 'each part of the address is encoded');
  assert.equal(mailtoHref("o'neil/x@example.com"), 'mailto:o\'neil%2Fx@example.com');
  assert.equal(mailtoHref(''), null);
  assert.equal(mailtoHref(null), null);
  assert.equal(mailtoHref('a'.repeat(LIMITS.email) + '@example.com'), null, 'too long');
});

test('the hidden box: a name no autofill fills in, sent under that name', () => {
  assert.equal(HONEYPOT, 'pf_trap');
  assert.ok(!/web|site|url|home|name|mail|phone|tel|address|company/i.test(HONEYPOT), 'nothing a browser or password manager fills in by itself');
  assert.equal(checkJobApplication(job({ pf_trap: 'http://spam.example' }), { now: NOW }).data.pf_trap, 'http://spam.example');
  assert.equal(checkFeedback({ pf_trap: 'x' }).data.pf_trap, 'x');
  assert.ok(!('website' in checkFeedback({ website: 'https://example.com' }).data), 'a box called "website" is not sent at all');
});

test('"Complaints & suggestions": anonymous is fine; contact details are checked; "contact me" needs a phone', () => {
  const ok = checkFeedback({ kind: 'suggestion', topic: 'cleanliness', branch: 'none', message: 'Please clean the waiting area more often.' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.data.branch, 'none');
  assert.equal(ok.data.phone, null);
  assert.equal(ok.data.contact_me, false);
  const withContact = checkFeedback({ kind: 'complaint', topic: 'waiting_time', branch: '1', message: 'Waited two hours today.', name: ' Sample  Visitor ',
    phone: '+92 301 5550123', mr: 'Mr# 50012', contact_me: true });
  assert.deepEqual(withContact.errors, []);
  assert.deepEqual([withContact.data.name, withContact.data.phone, withContact.data.mr, withContact.data.branch], ['Sample Visitor', '03015550123', '50012', 1]);
  assert.deepEqual(fields(checkFeedback({})), ['kind', 'topic', 'branch', 'message']);
  const one = (over: Record<string, unknown>) => fields(checkFeedback({ kind: 'complaint', topic: 'other', branch: 'none', message: 'A message long enough.', ...over }));
  assert.deepEqual(one({ message: 'Too short' }), ['message']);
  assert.deepEqual(one({ message: 'm'.repeat(LIMITS.feedbackMax + 1) }), ['message']);
  assert.deepEqual(one({ contact_me: true }), ['phone']);
  assert.deepEqual(one({ phone: '123' }), ['phone']);
  assert.deepEqual(one({ mr: '<b>1</b>' }), ['mr']);
  assert.deepEqual(one({ name: 'n'.repeat(LIMITS.contactName + 1) }), ['name']);
  assert.deepEqual(one({ kind: 'praise' }), ['kind']);
  assert.equal(feedbackSubject('suggestion', 'cleanliness'), 'Suggestion: Clinic cleanliness', 'the same subject the database writes');
});

test('what a refusal from the database says to the visitor', () => {
  const minute = submitProblem(new Error('FORM_BUSY: many forms are arriving right now.'))!;
  assert.equal(minute.busy, 'minute');
  assert.equal(minute.message, 'Many forms are being sent right now. Please try again in a few minutes, or message the clinic on WhatsApp.');
  assert.match(submitProblem(new Error('FORM_BUSY: many CVs are arriving right now.'), { form: 'job' })!.message, /in a few minutes, or send your CV on WhatsApp\.$/);
  // A full day has its own words: "tomorrow", not "in a few minutes" (a hiring post can bring more applications than a day takes).
  assert.deepEqual(submitProblem(new Error('FORM_BUSY_DAY: the clinic has received many job applications today.'), { form: 'job' }),
    { busy: 'day', message: 'The clinic has received a lot of applications today. Please try again tomorrow, or send your CV on WhatsApp.' });
  assert.deepEqual(submitProblem(new Error('FORM_BUSY_DAY: the clinic has received many messages today.')),
    { busy: 'day', message: 'The clinic has received a lot of messages today. Please try again tomorrow, or message the clinic on WhatsApp.' });
  assert.equal(submitProblem(new Error('FORM_BUSY_DAY: many CVs have arrived today.'), { form: 'job' })!.busy, 'day', 'a refused upload on a full day too');
  assert.deepEqual(submitProblem(Object.assign(new Error('FORM_INVALID: Please enter your full name.'), { field: 'full_name' })),
    { field: 'full_name', message: 'Please enter your full name.' });
  assert.deepEqual(submitProblem(new Error('FORM_CV: Please choose your CV again.')), { field: 'cv', message: 'Please choose your CV again.' });
  assert.equal(submitProblem(new Error('Failed to fetch')), null, 'connection trouble is left to the usual public wording');
});
