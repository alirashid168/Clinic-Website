// The two public forms on the homepage (owner, 11 Oct 2026): "Join our team" (a job application with a CV) and
// "Complaints & suggestions". The lists, the field rules and the plain-English messages the website shares with the
// database (supabase/migrations/20261011000200_public_forms.sql checks every field again: what the visitor's browser
// says is never trusted). Pure functions, no DOM, no network, so every rule can be tested in Node (tests/public-forms.test.ts).
//
// Text from visitors is plain text everywhere: it is stored as typed (control characters removed, spaces trimmed) and
// shown with textContent on the staff pages, never as HTML.

/** The jobs on the clinic's old Google job form. */
export const POSITIONS = [
  { value: 'dentist', label: 'Dentist' },
  { value: 'orthodontist', label: 'Orthodontist' },
  { value: 'dental_hygienist', label: 'Dental hygienist' },
  { value: 'dental_assistant', label: 'Dental assistant' },
  { value: 'clinic_coordinator', label: 'Clinic coordinator' },
  { value: 'receptionist', label: 'Receptionist / front desk' },
  { value: 'social_media', label: 'Social media coordinator' },
  { value: 'other', label: 'Other' },
];
/** The degree list. "Other" opens a box for the degree itself: the word "Other" is never sent or stored. */
export const QUALIFICATIONS = ['BDS', 'BDS + FCPS / MDS', 'Diploma', 'Intermediate', 'Other'];
const OTHER = /^others?$/i;
/**
 * The hidden box only bots fill in (the database drops a form that has it filled). Its name is one no browser or password
 * manager fills in by itself, unlike "website" or "url", so a person's form is never dropped by an autofill.
 */
export const HONEYPOT = 'pf_trap';
export const JOB_STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'interview', label: 'Interview' },
  { value: 'hired', label: 'Hired' },
  { value: 'rejected', label: 'Rejected' },
];
export const FEEDBACK_KINDS = [
  { value: 'complaint', label: 'Complaint' },
  { value: 'suggestion', label: 'Suggestion' },
  { value: 'appreciation', label: 'Appreciation' },
];
export const FEEDBACK_TOPICS = [
  { value: 'treatment', label: 'Treatment' },
  { value: 'doctor', label: 'Doctor' },
  { value: 'front_desk', label: 'Front desk & staff behaviour' },
  { value: 'waiting_time', label: 'Waiting time' },
  { value: 'appointments', label: 'Appointments & timings' },
  { value: 'cleanliness', label: 'Clinic cleanliness' },
  { value: 'fees', label: 'Fees & billing' },
  { value: 'facilities', label: 'Facilities (AC, seating, washroom, parking)' },
  { value: 'website', label: 'Website & online services' },
  { value: 'other', label: 'Other' },
];
const labelOf = (list) => Object.fromEntries(list.map((o) => [o.value, o.label]));
export const POSITION_LABELS = labelOf(POSITIONS);
export const JOB_STATUS_LABELS = labelOf(JOB_STATUSES);
export const FEEDBACK_KIND_LABELS = labelOf(FEEDBACK_KINDS);
export const FEEDBACK_TOPIC_LABELS = labelOf(FEEDBACK_TOPICS);

// The CV: the file types the bucket job-cvs takes, by file name ending. The upload sends a copy of the file that carries the
// type of its ending (data/supabase.js uploadJobCv: Storage takes the type from the file itself, not from an option), so a
// phone that calls a .docx "application/octet-stream", or a JPG "image/jpg", still gets through, and nothing else does.
// A file whose name has no ending of these (a phone's "document", a WhatsApp "IMG-20261012-WA0003") is known by its type
// when the browser gives one of the five, and gets that type's ending.
export const CV_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg',
  png: 'image/png',
};
const CV_ENDING_OF_TYPE = Object.fromEntries(Object.entries(CV_TYPES).map(([ext, type]) => [type, ext]));
export const CV_MAX_BYTES = 5 * 1024 * 1024;
/**
 * The CV upload limits for the whole website (the database's trigger on storage.objects holds them; the demo follows them):
 * files a minute and a day, bytes a day, and the bytes of CVs no application uses (the staff pages remove those once a day old).
 */
export const CV_UPLOAD_LIMITS = { perMinute: 5, perDay: 100, bytesPerDay: 200 * 1024 * 1024, unsentBytes: 100 * 1024 * 1024 };
/** For the file input's accept attribute. */
export const CV_ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png,' + Object.values(CV_TYPES).join(',');

// Lengths, counted after the text is cleaned (the database has the same numbers).
export const LIMITS = {
  name: 100, email: 120, qualification: 100, experience: 300, jobMessage: 1000,
  feedbackMin: 10, feedbackMax: 2000, contactName: 100, note: 2000,
};
export const FIRST_GRADUATION_YEAR = 1960;
/** Students may give the year they expect to finish. */
export const lastGraduationYear = (now = new Date()) => now.getFullYear() + 6;

// ---------------------------------------------------------------- cleaning
// Control characters (except new lines and tabs in longer text) are removed; nothing else is changed or escaped.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Invisible characters that can disguise text, removed first: the zero-width space, joiners and direction marks
// (U+200B-U+200F), the direction embeddings and overrides (U+202A-U+202E, which can make a name or message show in another
// order than it was typed), the direction isolates (U+2066-U+2069) and the byte order mark (U+FEFF).
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
/** One line: invisible characters go, control characters and runs of spaces become one space, trimmed. */
export function cleanLine(v) {
  return String(v ?? '').replace(INVISIBLE, '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Several lines (a message): Windows line ends become one new line, invisible and other control characters go, trimmed. */
export function cleanBlock(v) {
  return String(v ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(CONTROL, '').trim();
}

/**
 * A Pakistani mobile number as 03XXXXXXXXX, or null. Takes it the ways people write it:
 * "0300 1234567", "0300-1234567", "+92 300 1234567", "0092 300 1234567", "300 1234567".
 */
export function normalizePhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.startsWith('0092')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('92')) d = '0' + d.slice(2);
  if (d.length === 10 && d.startsWith('3')) d = '0' + d;
  return /^03\d{9}$/.test(d) ? d : null;
}
/** 03001234567 -> "0300 1234567". */
export const formatPhone = (p) => (/^03\d{9}$/.test(String(p || '')) ? `${p.slice(0, 4)} ${p.slice(4)}` : String(p || ''));

/** A CNIC as 12345-1234567-1 (13 digits, written with or without the dashes), or null. */
export function normalizeCnic(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === 13 ? `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}` : null;
}

/** { ext, type } for a CV file, or { error } in plain words. */
export function cvFileInfo(file) {
  if (!file) return { error: 'Please attach your CV.' };
  const name = String(file.name || '').toLowerCase();
  let ext = name.includes('.') ? name.split('.').pop() : '';
  if (ext === 'jpeg') ext = 'jpg';
  // A type the browser names must agree with the ending (image/jpg is how some phones name a JPG). A name without one of the
  // five endings takes the ending of the type, when that is one of the five.
  const given = String(file.type || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!CV_TYPES[ext] && CV_ENDING_OF_TYPE[given]) ext = CV_ENDING_OF_TYPE[given];
  const type = CV_TYPES[ext];
  if (!type || (given && given !== 'application/octet-stream' && given !== type)) {
    return { error: 'Your CV must be a PDF, Word (.doc or .docx), JPG or PNG file.' };
  }
  if (!(file.size > 0)) return { error: 'This file is empty. Please choose your CV again.' };
  if (file.size > CV_MAX_BYTES) return { error: 'Your CV is larger than 5 MB. Please choose a smaller file, or a PDF.' };
  return { ext, type };
}

// One plain address: none of ? & = % # or a space, so the mailto: link on the staff page opens an email to it and nothing more.
const EMAIL = /^[^\s@?&=%#]+@[^\s@?&=%#]+\.[^\s@?&=%#]+$/;
/**
 * The mailto: link for an applicant's email (the staff Job applications page), or null when it is not one plain address.
 * The two parts of the address are encoded, so nothing in it can add a subject, copies or text to the email.
 */
export function mailtoHref(email) {
  const e = String(email ?? '');
  if (e.length > LIMITS.email || !EMAIL.test(e)) return null;
  const at = e.lastIndexOf('@');
  return `mailto:${encodeURIComponent(e.slice(0, at))}@${encodeURIComponent(e.slice(at + 1))}`;
}
const HAS_LETTER = /\p{L}/u;
export const MR_PATTERN = /^[0-9A-Za-z/-]{1,20}$/;
const PHONE_MESSAGE = 'Please enter a Pakistani mobile number, for example 0300 1234567.';
const OTHER_DEGREE_MESSAGE = 'Please type your degree or qualification, for example BA or BSc.';
const tooLong = (n, what = 'this') => `Please keep ${what} under ${n.toLocaleString('en-PK')} characters.`;

// ---------------------------------------------------------------- the two forms
/**
 * The "Join our team" form. `form` holds what was typed (strings, the consent tick, the CV path once uploaded).
 * Returns { errors: [{ field, message }], data } where data is what is sent to public.submit_job_application.
 * `cv` may be the File (checked here) or omitted when only the path is checked (the database checks the stored file).
 */
export function checkJobApplication(form, { cv, now = new Date() } = {}) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const f = form || {};

  const fullName = cleanLine(f.full_name);
  if (!fullName) add('full_name', 'Please enter your full name.');
  else if (fullName.length > LIMITS.name) add('full_name', tooLong(LIMITS.name, 'your name'));
  else if (fullName.length < 2 || !HAS_LETTER.test(fullName)) add('full_name', 'Please enter your full name.');

  const phoneText = cleanLine(f.phone);
  const phone = normalizePhone(phoneText);
  if (!phoneText) add('phone', 'Please enter your mobile number.');
  else if (!phone) add('phone', PHONE_MESSAGE);

  const email = cleanLine(f.email);
  if (email && (email.length > LIMITS.email || !EMAIL.test(email))) add('email', 'Please check your email address, for example name@gmail.com, or leave it empty.');

  const position = String(f.position || '');
  if (!POSITION_LABELS[position]) add('position', 'Please choose the job you are applying for.');

  // The degree list's choice, or for "Other" the degree typed in the box under it (qualification_other): "Other" itself is no degree.
  const picked = cleanLine(f.qualification);
  const other = OTHER.test(picked);
  const qualification = other ? cleanLine(f.qualification_other) : picked;
  const qualificationField = other ? 'qualification_other' : 'qualification';
  if (picked.length < 2) add('qualification', 'Please choose your degree or qualification.');
  else if (other && (qualification.length < 2 || OTHER.test(qualification))) add('qualification_other', OTHER_DEGREE_MESSAGE);
  else if (qualification.length > LIMITS.qualification) add(qualificationField, tooLong(LIMITS.qualification));

  const yearText = cleanLine(f.graduation_year);
  const year = yearText ? Number(yearText) : null;
  const lastYear = lastGraduationYear(now);
  if (yearText && !(/^\d{4}$/.test(yearText) && year >= FIRST_GRADUATION_YEAR && year <= lastYear)) {
    add('graduation_year', `Please enter a year between ${FIRST_GRADUATION_YEAR} and ${lastYear}, or leave it empty.`);
  }

  const experience = cleanLine(f.experience);
  if (experience.length > LIMITS.experience) add('experience', tooLong(LIMITS.experience));

  const branch = String(f.branch ?? '');
  if (!(branch === 'any' || /^[1-9]\d{0,4}$/.test(branch))) add('branch', 'Please choose a branch, or "Any branch".');

  const cnicText = cleanLine(f.cnic);
  const cnic = normalizeCnic(cnicText);
  if (!cnicText) add('cnic', 'Please enter your CNIC number.');
  else if (!cnic) add('cnic', 'A CNIC has 13 digits, for example 12345-1234567-1.');

  if (cv !== undefined) {
    const info = cvFileInfo(cv);
    if (info.error) add('cv', info.error);
  }

  const message = cleanBlock(f.message);
  if (message.length > LIMITS.jobMessage) add('message', tooLong(LIMITS.jobMessage, 'your message'));

  if (f.consent !== true) add('consent', 'Please tick this box, so the clinic may keep your details and contact you.');

  return {
    errors,
    data: {
      full_name: fullName, phone, email: email || null, position, qualification,
      graduation_year: year, experience: experience || null, branch: branch === 'any' ? 'any' : Number(branch) || null,
      cnic, cv_path: f.cv_path || null, message: message || null, consent: f.consent === true, [HONEYPOT]: String(f[HONEYPOT] || ''),
    },
  };
}

/** The "Complaints & suggestions" form. Same shape of answer; data is what is sent to public.submit_feedback. */
export function checkFeedback(form) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const f = form || {};

  const kind = String(f.kind || '');
  if (!FEEDBACK_KIND_LABELS[kind]) add('kind', 'Please choose complaint, suggestion or appreciation.');
  const topic = String(f.topic || '');
  if (!FEEDBACK_TOPIC_LABELS[topic]) add('topic', 'Please choose what it is about.');
  const branch = String(f.branch ?? '');
  if (!(branch === 'none' || /^[1-9]\d{0,4}$/.test(branch))) add('branch', 'Please choose a branch, or "Not about one branch".');

  const message = cleanBlock(f.message);
  if (!message) add('message', 'Please write your message.');
  else if (message.length < LIMITS.feedbackMin) add('message', `Please write a little more (at least ${LIMITS.feedbackMin} characters).`);
  else if (message.length > LIMITS.feedbackMax) add('message', tooLong(LIMITS.feedbackMax, 'your message'));

  const name = cleanLine(f.name);
  if (name.length > LIMITS.contactName) add('name', tooLong(LIMITS.contactName, 'your name'));

  const phoneText = cleanLine(f.phone);
  const phone = normalizePhone(phoneText);
  const contactMe = f.contact_me === true;
  if (phoneText && !phone) add('phone', PHONE_MESSAGE);
  else if (contactMe && !phone) add('phone', 'Please give your mobile number, so we can contact you about this.');

  const mr = cleanLine(f.mr).replace(/^mr\s*#?\s*/i, '');
  if (mr && !MR_PATTERN.test(mr)) add('mr', 'Please check your Mr# (letters and numbers only), or leave it empty.');

  return {
    errors,
    data: {
      kind, topic, branch: branch === 'none' ? 'none' : Number(branch) || null, message,
      name: name || null, phone, mr: mr || null, contact_me: contactMe, [HONEYPOT]: String(f[HONEYPOT] || ''),
    },
  };
}

/** The subject a website form gets in the complaints inbox: "Suggestion: Clinic cleanliness" (the database writes the same). */
export const feedbackSubject = (kind, topic) => `${FEEDBACK_KIND_LABELS[kind] || 'Feedback'}: ${FEEDBACK_TOPIC_LABELS[topic] || 'Other'}`;

/**
 * What a failed submission says to the visitor. The database answers with a code first ("FORM_BUSY: ...");
 * { field, message } when one field is at fault, otherwise { message }. The whole-website limits add `busy`:
 * 'minute' (FORM_BUSY) or 'day' (FORM_BUSY_DAY, the day is full: try again tomorrow), and the form shows a WhatsApp
 * link with them. `form` ('job' or 'feedback') chooses the words: an applicant can send the CV on WhatsApp instead.
 */
export function submitProblem(err, { form = 'feedback' } = {}) {
  const text = String(err?.message || '');
  const field = err?.field || null;
  const whatsapp = form === 'job' ? 'or send your CV on WhatsApp.' : 'or message the clinic on WhatsApp.';
  if (/FORM_BUSY_DAY/.test(text)) {
    const what = form === 'job' ? 'applications' : 'messages';
    return { busy: 'day', message: `The clinic has received a lot of ${what} today. Please try again tomorrow, ${whatsapp}` };
  }
  if (/FORM_BUSY/.test(text)) return { busy: 'minute', message: `Many forms are being sent right now. Please try again in a few minutes, ${whatsapp}` };
  if (/FORM_CV/.test(text)) return { field: 'cv', message: text.replace(/^.*FORM_CV[A-Z_]*:\s*/, '') || 'Please choose your CV again.' };
  if (/FORM_INVALID/.test(text)) return { field, message: text.replace(/^.*FORM_INVALID:\s*/, '') };
  return null;
}
