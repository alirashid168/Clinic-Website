# Patient logins: for the front desk, assistants, the coordinator and Dr. Ali

Dr. Ali's decision (17 Oct 2026): every patient can have a website login, made at the clinic in one press. The login name is the
patient's **Mr#**, the password is the patient's **mobile number as we have it on file**, and the patient is not made to change it
(they can, from the menu in their account). Patients can also register themselves on the website; you approve them.

## Make a login (one press)

1. Open the patient (Patients, or the search box at the top), or use **Create ▾ → Patient login** and find the patient.
2. Press **Create login**. The dialog shows the login name (Mr#) and says which mobile number is on file (its last four digits).
   Press **Create login** again.
3. A card appears. Tell the patient, **Print card** (one small page) or **Copy** it into a WhatsApp message:

   > Go to **www.dralirashid.com** and choose **Patient login**.
   > Login name: **Mr# 50013** (type only the number)
   > Password: **your mobile number** (ends with 4567)
   > You can change the password from the menu after you log in.

   The card never shows the number itself, so it can be handed over or sent without worry.

If the patient has **no mobile number on file** (or a very short one), the dialog says so: add the number first (Edit on the
profile), or type a password in "Use another password" and tell the patient yourself (it is not written on the card).

Families often share one number: that is fine, because the login name is the Mr#, which is unique. The phone is only the password.

## What the patient sees

Patient login → Mr# and the mobile number → their account: pending dues, next appointment, visits (with "Rate this visit"), invoices
and payments (and the installment plan), photos and X-rays (edited photos only; Photo inbox photos 24 hours after filing), **Your
documents** (signed consent forms, ID copies, reports), their messages to Dr. Ali, **Report / complain to Dr. Ali Rashid**, and
**Please upload my photos**. **Change password** and **Log out** are in the top bar.

## Reset a password

The patient forgot a password they chose, or a phone was lost: open the patient and press **Reset password**. The password goes back
to the mobile number on file (or type another). The patient is signed out everywhere; a phone that was logged in is signed out within
the hour. A new card appears.

Only logins made at the clinic (or by self-registration) can be reset here. A patient who was invited by email resets with "Forgot
password" on the login page.

## Patients who register themselves

On the patient login page: **No login yet? Register with your Mr# and mobile number**. The patient types their name, Mr#, mobile
number and a password of their choice. The website makes the login only when the **Mr# and the mobile number match the patient's
file and the name fits**, and it tells every visitor the same thing ("Your request has been sent to the clinic"), so nobody can find
out which numbers we have. The patient can log in at once, but sees only **"Your account is waiting for the clinic's approval"**
until you approve.

**Approve or reject:** the **Patients** menu shows a count; Patients → **New registrations** lists each request with what the patient
typed beside the file it matched (name, Mr#, phone, branch). Check it is really that person (a brother using the family number, say),
then **Approve**; the patient's account opens on their next login. **Reject** (with a reason for the audit log) removes the login
again; the patient can register again or ask you for a login.

Caps, so the form cannot be used to guess numbers: 3 tries per mobile number a day, 10 per internet address an hour, 200 a day in
all; every try is in Dr. Ali's audit log (SELF_REGISTER, with the outcome).

## "Please upload my photos"

A patient who has no photos (or wants new ones) presses **Please upload my photos** in their account. The request shows on the
**Photo inbox** page under **Photo requests** (patient, Mr#, branch, last visit, when asked), with **Open patient** and **Done**. As
soon as photos are saved for that patient (a profile upload or a Photo inbox filing) the request closes by itself. The patient sees
"Requested on …" with Cancel until then. One open request per patient at a time.

## Who may

"Create patient logins" in the access list (Admin → Access list): the front desk, assistants, the clinic coordinator and Dr. Ali.
It covers Create login, Reset password, the Create ▾ → Patient login item and New registrations. Photo requests are seen by whoever
uses the Photo inbox or uploads photos.

## For Dr. Ali: switching it on

1. Supabase → SQL Editor: paste `supabase/migrations/20261017000300_patient_login_simple.sql` and run it once (it can run again safely).
2. Redeploy the function: `supabase functions deploy admin-users` (index.ts and the files next to it: `patient-login-actions.ts`,
   `portal-login.ts`, `staff-delete-actions.ts`).
3. Supabase → Authentication → Sign In / Providers → Email: keep **Minimum password length** at 8 or less and **Password requirements**
   at "No required characters" (a mobile number is digits only); leave "Prevent use of leaked passwords" off, or a few numbers could be
   refused.
4. Put the website live and reload the staff tabs (Ctrl+F5).

Every login made, reset, registration and decision is in Admin → Audit log (`PORTAL_LOGIN_CREATED`, `PORTAL_PASSWORD_RESET` with
whether the password was the phone or typed, never the password itself; `SELF_REGISTER`, `REGISTRATION_APPROVED`, `REGISTRATION_REJECTED`).
Logins made before 17 Oct 2026 (username = name-Mr#) keep working: the patient types that username, or Reset password gives them the
new way.
