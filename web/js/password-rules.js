// The rules and the words for a person changing their OWN password. One place, so the dialog (ui/password-dialog.js) and both
// data layers (data/supabase.js, data/demo.js) check the same things and say the same sentences. No imports: plain data and functions.

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72; // GoTrue stores a bcrypt hash, and bcrypt only reads the first 72 bytes

const byteLength = (text) => new TextEncoder().encode(text).length;

/**
 * Codes of the errors changeOwnPassword() fails with, and the sentence for each. The data layers throw
 * Object.assign(new Error(message), { code }); the dialog puts WRONG_PASSWORD, SAME_PASSWORD and WEAK_PASSWORD next to their field
 * and shows the others as a message. None of the sentences ever contain a password.
 */
export const PASSWORD_MESSAGES = {
  WRONG_PASSWORD: 'Your current password is not right.',
  SAME_PASSWORD: 'The new password must be different from the old one.',
  RATE_LIMITED: 'Too many tries. Wait a few minutes and try again.',
  // No "Admin -> Staff accounts" in this sentence: most staff have no Admin menu to look for it in.
  REAUTH_NEEDED: 'For safety, ask Dr. Ali to set a new password for you.',
  NOT_LOGGED_IN: 'You are not logged in any more. Log in again, then change the password.',
};

/** An error with one of the codes above (or any other code and message). */
export function passwordError(code, message = PASSWORD_MESSAGES[code]) {
  return Object.assign(new Error(message), { code });
}

/**
 * What is wrong with the three things typed into the dialog: an array of { field: 'current' | 'next' | 'again', message }, at most
 * one per field, empty when all is fine. `again` is left out by the data layers, which only get the two passwords.
 * Passwords are used exactly as typed (no trimming): the login page sends them untouched too, so a space would otherwise make the
 * new password impossible to type at the next login.
 */
export function passwordProblems({ current, next, again }) {
  const problems = [];
  const cur = String(current ?? '');
  const nxt = String(next ?? '');
  if (!cur) problems.push({ field: 'current', message: 'Type your current password.' });
  if (!nxt) problems.push({ field: 'next', message: 'Type a new password.' });
  else if (nxt.length < PASSWORD_MIN_LENGTH) problems.push({ field: 'next', message: `The new password needs at least ${PASSWORD_MIN_LENGTH} characters.` });
  else if (byteLength(nxt) > PASSWORD_MAX_BYTES) problems.push({ field: 'next', message: `The new password is too long. Use ${PASSWORD_MAX_BYTES} characters or fewer (accented letters count more).` });
  else if (cur && nxt === cur) problems.push({ field: 'next', message: PASSWORD_MESSAGES.SAME_PASSWORD });
  if (again !== undefined) {
    if (!String(again)) problems.push({ field: 'again', message: 'Type the new password again.' });
    else if (String(again) !== nxt) problems.push({ field: 'again', message: 'The two new passwords are not the same. Type them again.' });
  }
  return problems;
}
