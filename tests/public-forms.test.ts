// The homepage forms: the shared rules of web/js/lib/public-forms.js (the database has the same rules in
// supabase/migrations/20261011000200_public_forms.sql, tested in supabase/tests/29_public_forms_test.sql).
// Every name, phone and CNIC here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POSITIONS, FEEDBACK_TOPICS, FEEDBACK_KINDS, JOB_STATUSES, CV_TYPES, CV_MAX_BYTES, LIMITS,
  cleanLine, cleanBlock, normalizePhone, formatPhone, normalizeCnic, cvFileInfo, checkJobApplication, checkFeedback, feedbackSubject, submitProblem,
} from '../web/js/lib/public-forms.js';

const NOW = new Date('2026-10-12T10:00:00+05:00');
const file = (name: string, type: string, size = 2000) => ({ name, type, size });
const job = (over: Record<string, unknown> = {}) => ({
  full_name: 'Sample Applicant', phone: '0300 5550101', email: '', position: 'dentist', qualification: 'BDS', graduation_year: '',
  experience: '', branch: '2', cnic: '12345-0000001-1', message: '', consent: true, website: '', ...over,
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
  assert.match(submitProblem(new Error('FORM_BUSY: many forms are arriving right now.'))!.message, /try again in a few minutes/);
  assert.deepEqual(submitProblem(Object.assign(new Error('FORM_INVALID: Please enter your full name.'), { field: 'full_name' })),
    { field: 'full_name', message: 'Please enter your full name.' });
  assert.deepEqual(submitProblem(new Error('FORM_CV: Please choose your CV again.')), { field: 'cv', message: 'Please choose your CV again.' });
  assert.equal(submitProblem(new Error('Failed to fetch')), null, 'connection trouble is left to the usual public wording');
});
