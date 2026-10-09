# Going live: step by step

Steps marked **(Dr. Ali)** need you: a sign-in, a payment or an approval. Everything else Claude can do once the accounts are connected.

## 1. Supabase project (database, logins, file storage)
1. **(Dr. Ali)** Approve creating the project in the "Dr. Ali Rashid's Dental Clinic" organization (already exists, no projects yet). Free plan to start; Pro is about $25/month when live.
2. Choose the region. Closest to Pakistan: **Mumbai (ap-south-1)**, fastest. Alternatives: Singapore or Frankfurt. This cannot be changed later without moving the database.
3. Claude applies the five migrations in `supabase/migrations/` in order and runs Supabase's security advisor.
4. Auth settings: turn off public sign-ups (staff and patients are invited only), set the Site URL to the website address, and add `https://<site>/reset-password.html` as an allowed redirect.

## 2. Logins
1. **(Dr. Ali)** Claude sends you an invitation from Supabase. You set your password.
2. Claude makes that login the admin:
   ```sql
   insert into public.staff (id, full_name, email, role)
   select id, 'Dr. Ali Rashid', email, 'admin' from auth.users where email = 'ali@dralirashid.com';
   update public.clinicians set staff_id = (select id from public.staff where role = 'admin') where display_name = 'Dr. Ali Rashid';
   ```
3. Deploy the Edge Function: `supabase functions deploy admin-users`, with secrets `SITE_URL=https://<site>` and `STAFF_EMAIL_DOMAIN=dralirashid.com`.
4. Turn on two-factor login for staff (Supabase Auth → MFA) once everyone has a phone authenticator.
5. **Patient portal logins made at the clinic.** Staff open the patient, choose **Create portal login**, and hand over the printed slip (username such as alirashid-1705@dralirashid.com and a first password). No email is sent, so this works for patients without an email address. The patient is asked to choose their own password at the first login; if they forget it, staff choose **Reset portal password**. The permission is "Invite patients to the patient portal" (`portal.invite`): by default the front desk, the coordinator and the admin have it (Dr. Ali's decision, 9 Oct 2026); untick it in the access list for anyone who should not hand out logins. Whoever makes or resets a login can then sign in as that patient and see what the patient sees (their invoices, payments, x-rays and complaints: including complaints the front desk is not otherwise allowed to read, and a complaint may be about the front desk itself), so every create and reset is written to Admin → Audit log with the staff member's name (`PORTAL_LOGIN_CREATED`, `PORTAL_PASSWORD_RESET`, and `PORTAL_INVITE` with the address the invitation went to). A database set up before that decision gets it for the front desk from `supabase/migrations/20261009000400_mr_50000_front_desk_portal.sql` (run it once, see section 5). Addresses of this shape (a name, a dash and a number at @dralirashid.com) are reserved for patients: the staff screens refuse them for staff accounts. Redeploy the function after pulling this change: `supabase functions deploy admin-users` (it now has three files next to index.ts; deploy sends them all).
   - **How a clinic login is told apart:** only a login the function made itself counts as a clinic login (the username has the patient shape, `app_metadata` says `kind: patient, clinic_login: true` and the login is not in the staff table). Users can edit their own `user_metadata` but not `app_metadata`, so nobody can make their own login look like one. Invitations by email to an address at the clinic domain are refused ("Use Create portal login for clinic usernames."), and creating a staff account by invitation refuses an address that already has a login.
   - **The first password:** the slip password is three easy words and four digits (about 37 bits). A password staff type themselves must have at least 10 characters and not be only digits. There is no Copy button for it, so it does not stay in the clipboard history of the front desk computer.
   - **A reset signs the patient out everywhere.** The login server's admin password change deletes every session of that login, so the old password and every saved login stop working at once. A page that is already open keeps its current access key until it expires (at most an hour; the website itself notices sooner, at its next check). The reset dialog says so.
   - **`must_change_password` is a prompt, not a lock.** It lives in the patient's own `user_metadata`, so a patient can clear it without changing the password; that only weakens their own account. Nothing else relies on it.

## 3. Website
1. Put the project URL and anon key in `web/js/config.js` (safe to publish; the database enforces access).
2. **(Dr. Ali)** Sign up on Vercel with "Continue with GitHub" (use **Sign Up**, not Log In), import this repository. Output directory is `web`; no build command.
3. **(Dr. Ali)** Point dralirashid.com (or a subdomain such as app.dralirashid.com) at Vercel.

## 4. Staff email addresses (name@dralirashid.com)
**(Dr. Ali)** Needs Google Workspace (or another mail provider) on dralirashid.com, billed per user. Logins work with any email in the meantime; the system only checks that staff emails end with @dralirashid.com.

## 5. Old data
1. **Aaj ki List:** download each branch tab as CSV, then
   `node scripts/import-aaj-ki-list.ts NN.csv --branch NN --date 2026-10-05 --sql nn.sql`.
   It lists every row with a problem (no Mr#, no phone, unknown doctor name, amount typed as text) before anything is imported. Imports are safe to run twice.
2. **Healthwire:** **(Dr. Ali)** you sign in to Healthwire in the browser; Claude reads or exports patients, invoices, payments and expense categories. If Healthwire has an Excel/CSV export, that is used first.
3. **Google Drive:** Claude reads the patient folders and photos and files them to the right patient.
4. After importing: `select public.sync_mr_sequence();` so new Mr# continue after the highest website number. **New Mr# from the website start at 50000** (Dr. Ali's decision, 9 Oct 2026): Healthwire keeps registering patients with its own numbers (in the 9800s now, reaching 10000 soon), and the website's numbers stay well clear of them. `sync_mr_sequence()` only looks at numbers from 50000 up, its minimum is 50000 and it never moves the counter backwards, so running it can never put the counter back into Healthwire's range or hand out a number again after that patient was merged away or deleted. (Any later migration that redefines it must keep that: the photo-intake branch has its own copy that does not, and has to be rebased onto this one before it is applied.)
   - The patients the website had numbered 10000-10012 (the Aaj ki List import of 6 Oct 2026) became 50000-50012. That, the new counter and the front desk's portal permission are done by `supabase/migrations/20261009000400_mr_50000_front_desk_portal.sql`: redeploy the admin-users function first (step 3), then paste the file into the Supabase SQL Editor and run it once, **before 10 Oct 2026 if possible** (a patient the website numbers 10013 or more from that day on cannot be told from a Healthwire patient). Patient registrations wait a few seconds while it runs. Patients that are Healthwire's own (made by its import, or carrying Healthwire invoices, payments or visits) are never moved. It refuses, changing nothing, if a new number is already taken or if one of the patients has a portal login (its username holds the old Mr#). Running it again changes nothing: once the website's counter is at 50000 or more it renumbers nobody, so a Healthwire patient numbered 10004 or 10020 is never touched, whatever date they were registered. The old Mr# of every patient it moved stays in the audit log (Admin → Audit log, Dr. Ali only) and in a note on the patient ("Mr# was 10003 until ..."); the website's search does not find a patient by the old number, so keep the list the last result row prints. That row shows `patients_renumbered_now` (11), `old_to_new` ("10000 -> 50000, 10001 -> 50001, ...": copy it for the front desk), `left_alone_10000_10999` (should be 0), `next_mr_number` (50013) and `front_desk_can_make_portal_logins` (true).
5. Check counts match Healthwire: patients, invoices, total dues per branch.

## 6. Parallel run
Keep Healthwire and the Google Sheets running until the numbers match for a few weeks. Then switch Healthwire off.

## Costs (approximate, confirm before buying)
| Item | Cost |
|---|---|
| Supabase | Free to start; about $25/month on Pro |
| Vercel | Free (Hobby) to start; about $20/month on Pro for a business |
| Domain | Yearly fee (already owned?) |
| Google Workspace | Per staff email, per month |
| GitHub | Free |
