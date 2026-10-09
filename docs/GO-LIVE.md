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
5. **Patient portal logins made at the clinic.** Staff open the patient, choose **Create portal login**, and hand over the printed slip (username such as alirashid-1705@dralirashid.com and a first password). No email is sent, so this works for patients without an email address. The patient is asked to choose their own password at the first login; if they forget it, staff choose **Reset portal password**. The permission is "Invite patients to the patient portal" (`portal.invite`): by default only the coordinator and admin have it, so tick it in the access list for the front desk if they will hand out logins. Addresses of this shape (a name, a dash and a number at @dralirashid.com) are reserved for patients: the staff screens refuse them for staff accounts. Redeploy the function after pulling this change: `supabase functions deploy admin-users` (it now has three files next to index.ts; deploy sends them all).
   - **How a clinic login is told apart:** only a login the function made itself counts as a clinic login (the username has the patient shape, `app_metadata` says `kind: patient, clinic_login: true` and the login is not in the staff table). Users can edit their own `user_metadata` but not `app_metadata`, so nobody can make their own login look like one. Invitations by email to an address at the clinic domain are refused ("Use Create portal login for clinic usernames."), and creating a staff account by invitation refuses an address that already has a login.
   - **The first password:** the slip password is three easy words and four digits (about 37 bits). A password staff type themselves must have at least 10 characters and not be only digits. There is no Copy button for it, so it does not stay in the clipboard history of the front desk computer.
   - **Known limit: a reset does not end sessions that are already open.** *Reset portal password* changes the password for new logins; a phone or computer where the patient is already logged in stays logged in until it is logged out or its session expires (ending other sessions needs a database function, which is a migration this change does not include). The reset dialog says so. If a phone was lost, also ask the patient to log out there.
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
4. After importing: `select public.sync_mr_sequence();` so new Mr# continue after the highest old one.
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
