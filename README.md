# Dr. Ali Rashid's Dental Clinic: website and clinic system

One browser-based system for all branches (Gulshan / RJ Mall, North Nazimabad, DHA, Gulberg Lahore, Islamabad). It replaces Healthwire and the daily Aaj ki List Google Sheet once it has been proven in a parallel run.

- **Public website:** home page with a turning 3D smile, three doors (Patient, Visitor, Employee) and Dr. Ali's weekly calendar per branch; visitor page with benefits, braces options, consented results and a WhatsApp consultation button.
- **Patient portal:** invoices and dues, visit history, photos and X-rays, "see Dr. Ali" message, visit ratings, "Report / complain to Dr. Ali Rashid" button.
- **Staff system:** Aaj ki List sheet view (per branch or all branches) with auto-save, an offline buffer and a day download, live queue, patients and profiles with automatic Mr#, medical history and consent, braces month-by-month protocol (doctor groups, checker, wires, photo months, extraction and dues rules), braces-off → retainer flow with check dates, invoices with templates, payments matched to invoices, installment plans with an overdue list, $$ dues flag and treatment hold, discount caps with approval, accountant (branch income vs expenses, expenses by city/branch/category, cash closing, reports: monthly trends, dues per branch, visits and new patients, braces, referral sources, photo months, lab costs, doctors, treatments), coordinator (reminders, installments due, drop-offs, lab work, retainers, low ratings), stock per branch, complaints inbox, Dr. Ali review list (flags, treatment plans needed, overruns), doctor daily log, payment receipts, WhatsApp links next to phone numbers, "View as patient" preview of the portal, checkbox access list, staff accounts, settings, clinic setup (branches, doctors, groups, doctor percentage rules, treatments, categories), duplicate-patient review and merge, Healthwire import, data export, audit log.

The full plan is in `docs/Clinic_Website_Master_Blueprint.pdf`, with open questions and go-live steps alongside it in `docs/`.

## How it is built

| Part | What | Where |
|---|---|---|
| Database | Supabase (Postgres). All rules and permissions are enforced inside the database with row-level security, so the website cannot show or change anything a person is not allowed to. | `supabase/migrations/` |
| Logins | Supabase Auth. Staff get name@dralirashid.com logins by invitation; patients are invited from their profile. | `supabase/functions/admin-users/` |
| Website | Plain HTML, CSS and JavaScript modules. No build step, so it is simple to host and maintain. | `web/` |
| Shared rules | Braces protocol, permission grid, old-data parsing, auto-save queue. Written in TypeScript, copied to `web/js/lib/` by `scripts/build-lib.sh`. | `src/lib/` |
| Hosting | Vercel serves the `web/` folder with security headers. | `vercel.json` |

Until `web/js/config.js` has the Supabase URL and key, the site runs in **demo mode** with made-up patients so every screen can be tried.

## Run and test locally

```bash
npm run serve            # opens the site at http://localhost:8765 (demo mode)
npm test                 # logic and importer tests
npm run test:db          # applies every migration to a local Postgres and runs 80+ rule checks
npm run test:ui          # clicks through the site as each role in a headless browser (32 checks)
```

`test:db` needs a local Postgres 16 (`PGHOST`/`PGPORT` pointing at it). `test:ui` needs Playwright.

## Going live (summary; details in `docs/GO-LIVE.md`)

1. Create the Supabase project (region close to Pakistan) and apply `supabase/migrations/` in order.
2. Deploy the `admin-users` Edge Function and set `SITE_URL` and `STAFF_EMAIL_DOMAIN`.
3. Put the project URL and anon key in `web/js/config.js`.
4. Connect this repository to Vercel; output directory `web`.
5. Create Dr. Ali's admin login, then staff accounts from **Admin → Staff accounts**.
6. Import old data from **Admin → Import from Healthwire** (yearly transactions Excel and expenses PDF exports; every year 2021–2025 is reconciled to the rupee) and run `select public.sync_mr_sequence();` so new Mr# continue after the highest existing number.
