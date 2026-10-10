# Connecting the "Aj ki List" Google Sheet to the website (Aaj Sync)

This guide is for Dr. Ali. It takes about 10 minutes, once. Staff do not need to do anything.

## 1. What it does

- Staff can enter patients in the **website's Aaj ki List** or in the **Google Sheet "Aj ki List"**. Both lists stay the same. You do not choose a main one.
- A new patient typed in the sheet appears on the website within about 2 minutes, and the other way round.
- A row **with an Mr#** is a patient. The website adds the day's **token** (when the Token cell is empty) and fills in the rest.
- A row **without an Mr#** whose **Treatment says checkup** ("Checkup", "checkup / pain", "xray checkup") is a **checkup patient**. It goes to the website's **checkup list**. No patient file and no Mr# is made. When the checkup is registered as a patient on the website, the new Mr# appears in the row by itself.
- A row **without an Mr# and with any other Treatment** ("Filling & Crown prep", "RCT followup", "Monthly") is an **existing patient whose Mr# was forgotten**. It is **not** made a checkup and **not** made a new patient: the row says **Needs attention: add the Mr#**. Look the Mr# up in Healthwire and type it; the row then goes across.
- A row marked **Completed** in the sheet **completes the visit** on the website. This is the owner's rule (9 Oct 2026): the website's photo, checker, doctor-group and dues checks are skipped. The visit says so ("Completed in the Google Sheet (owner rule, 9 Oct 2026)") and the website's history names "Google Sheet sync".
- **Deleting a row** in the sheet removes that visit (or checkup) from the website too. The website keeps it when something real hangs on it (an invoice, a photo, an x-ray, a lab case, recorded treatment): the visit is then marked Cancelled and the row comes back with the reason. Section 5 has the safety rules and how to undo.
- Every night, a little after midnight, the day's list is **copied into a second spreadsheet called "Aj ki List - Archive"** (one tab per branch, with the date on every line). Then the five branch tabs are cleared, so a **new empty list** is ready for the new day. The header row stays.
- The same night the day's **checkup patients** (rows without an Mr#) are added to your sheet **"Checkup karwaliya"**, one line each, once.
- The website keeps every day too.

How it runs: a small program (a Google "Apps Script") lives inside the sheet. Every minute from 08:00 to midnight it looks at the five branch tabs, sends what changed to the website, and writes what the website changed back into the sheet. Between 00:05 and 08:00 it only does the nightly copy and clean-up.

It only touches these five tabs: **Gulshan KHI, North Nazimabad, DHA KHI, Gulberg Lhr, Islamabad**. Every other tab ("Website - ...", "Copy of DHA KHI", "Patient Response", "Daily Work", "Staff Duties" and so on) is never read or changed.

## 2. Before you start

- Use a **computer**, not a phone. Use Chrome and sign in with the Google account that **owns** the sheet.
- Best time: before staff start the day's list, or at a quiet moment.
- Have the **sync secret** ready: a long line of letters and numbers in the file named in the morning report. You paste it once. Do not send it to anyone.
- You need the program text: the file `apps-script/AajSync.js` in the project. Open it in Notepad (right-click, Open with, Notepad), press **Ctrl+A**, then **Ctrl+C**.
- For the checkup list: the Google account you sign in with needs **edit access** to the sheet **"Checkup karwaliya"**. If it does not have it, the sync still works; only the nightly checkup list is switched off, and Set up tells you so (section 7).

## 3. Steps

1. Open the Google Sheet **Aj ki List**.
2. Click **Extensions** (top menu), then **Apps Script**. A new browser tab opens. This is the "script editor" **inside this sheet**. (Do not make a separate script in Google Drive: it has to live in the sheet.)
3. On the left, under **Files**, click the **+** and choose **Script**. Type the name `AajSync` and press Enter. (If you see an older script such as `Code.gs`, leave it alone for now.)
4. A blank file opens with a few lines like `function myFunction() {}`. Click inside it, press **Ctrl+A** to select those lines, then **Ctrl+V** to paste the program text. The old lines are replaced.
5. Press **Ctrl+S** (or click the disk icon) to save.
6. At the top, next to **Run**, there is a drop-down with a function name. Choose **aajSetup**. Then click **Run**.
7. Google says **Authorization required**. Click **Review permissions** and choose your account.
8. Google says **"Google hasn't verified this app"**. This is normal, because it is your own private script. Click **Advanced**, then **Go to ... (unsafe)**, then **Allow**.
   - It asks to: see and change your spreadsheets (to read the five tabs, make the archive and add to the checkup list), connect to an external service (to talk to the website), and run when you are not there (the one-minute timer).
9. **Go back to the Google Sheet browser tab.** The questions appear there, not in the script editor.
10. A box says **Paste the sync secret from the file you were given**. Paste it and click **OK**. (The secret is typed into this box only. It is not written into the script text, and you never put it into "Script Properties" or "Project Settings".) If you run Set up again later and a secret is already saved, a box asks **Keep the saved sync secret?**: say Yes, or say No to paste a new one.
11. For each branch tab that already has patients on it, a box says how many patients are on the tab (with the first and the last name) and asks **"Which day are they from?"**
    - **Leave it empty and click OK**: the patients are **today's**. They are matched to the website's patients of today. Nobody is doubled. If some of the rows are already marked **Completed**, the box asks once more ("Are these really today's patients?"), because a list with Completed patients is usually a day that has finished and today's answer would make every one of them a visit of today. Click **No** to be asked for the day again, and type it.
    - **Type a day**, like **06-10-2026** (day-month-year): the patients are from that earlier day. Those rows are copied to the archive under that date and the tab is cleared. Nothing is added to the website, and that day can be brought in later (section 9).
    - **Cancel**: stops the setup. Nothing more is changed. You can run it again.
    - A tab with no patients on it is simply marked as today's.
    - Each tab keeps the **last day the branch was open**. A branch that was closed yesterday still shows its last open day; at night only a tab with rows is archived, under its own day.
12. A box says **Found 1 other timer(s) ... They are probably the old copy into the "Website - ..." tabs. Turn them off?** Click **Yes**. (If you are not asked, there was no old timer in this script. See section 10.)
13. A box says **Done.** with a link to the archive. If the checkup list cannot be reached, the box says so below that line.

If something stops half way, just run **aajSetup** again. It is safe to run any number of times.

## 4. How you know it worked

- Every branch tab has a new column at the right called **Website**. The heading reads **Website · 09:15 ✓** (the time of the last check). Three more columns next to it (**Sync key**, **Sync base**, **Sync edited**) are hidden. They are how the sheet remembers each patient. Never delete or unhide them.
- Within 2 minutes the rows show **✓ On website** in the Website column.
- The website's Aaj ki List shows the same patients as the sheet. Checkup patients show on the website's checkup list.
- A new menu **Aaj Sync** appears next to Help. A new tab **Aaj Sync log** lists what the sync did (new patients added, removals, problems).
- In Google Drive there is a new spreadsheet **Aj ki List - Archive**.

## 5. For staff: one page

- Type patients in the sheet or on the website, as before.
- **With an Mr#** the row is a patient. **Without an Mr#** the row is a checkup patient (no patient file) **only when the Treatment says checkup**; with any other Treatment the row asks you to add the Mr#. A stray dot after the Mr# ("8602.") is ignored. Website Mr# numbers are **50000 and above**; a number below 50000 is a Healthwire number.
- The **Website** column says what happened to each row:

| You see | What it means | What to do |
|---|---|---|
| ✓ On website | The patient is on the website. | Nothing. |
| ✓ Added from the website | This row was added by the sheet because someone entered the patient on the website. | Nothing. |
| ✓ Checkup patient: no Mr#, no patient file. | The row is a checkup patient. | Nothing. |
| ⚠ New patient added with Healthwire Mr# 9851. Check the name and phone on the website. | The Mr# was not on the website and is below 50000, so a new patient was made with that number. | Check the name and phone on the website. |
| ⚠ Mr# 25001 is "Sana Ahmed" on the website. Check the Mr#. | The name in the row is a little different from the name of that Mr#. | Correct the Mr# or the name. |
| ✗ Mr# 25004 is "Sana Ahmed" on the website, not "Ayesha". Check the Mr#. | The name in the row is another person. The row was **not** saved. | Correct the Mr# or the name. |
| ✗ Mr# 60001 is not on the website. Check the number. | A number of 50000 or more that the website never gave: a typing mistake. Nothing was made. | Correct it. |
| ✗ Needs attention: add the Mr#. A row with no Mr# is a checkup only when its Treatment says checkup. Look the Mr# up in Healthwire. | The row has no Mr# and its Treatment is not a checkup, so it is an existing patient whose Mr# was forgotten. Nothing was made. | Look the Mr# up in Healthwire and type it (or type Checkup in the Treatment if it really is a checkup). |
| ✗ Mr# 25003: the name in this row cannot be read. Type the patient's name in English letters, or the phone number that is theirs. | The name is empty, punctuation or not in English letters, so the website cannot check it against the Mr#. Nothing was saved. | Type the name in English letters, or the patient's own phone number. |
| ⚠ The phone in this row is not the patient's phone on the website. Change it in the patient file. | You changed the phone in the sheet. The sheet never changes a patient's phone. | Change it in the patient file on the website. |
| ⚠ Dr X is outside this month's doctor group. The name stays in the row; the website adds it when the visit is marked Completed (owner rule). | The website's doctor-group rule does not take this doctor for this braces month yet. Your typed name stays in the cell. | Nothing. Mark the row Completed when the visit is done and the website adds the doctor. |
| ⚠ Website change kept for: ... | Someone changed the same cell on the website a little later. The website's text is kept and shown. | Nothing, or retype it if you meant yours. |
| ⚠ Token 41 is already used by ... | The website has one token per patient per day. | Nothing. Your typed token stays in the sheet. |
| ⚠ Not on the website's doctor list: Dr X | A doctor's name is not known. | Tell Dr. Ali to add the name in Clinic setup, or fix the spelling. |
| ⚠ Completed from the sheet. The website's photo step was skipped (owner rule). | The sheet's Completed completed the visit although the website normally asks for a photo, a check or the doctor group, or the patient has dues. | Add the photo or check on the website when you can. |
| ⚠ A checkup cannot be Scheduled. Saved as Waiting. | A checkup is a walk-in. | Nothing. |
| ⚠ Kept on the website and marked Cancelled: it has an attached record (...). | You deleted the row, but the visit has an invoice, a photo or treatment on it, so the website kept it and marked it Cancelled. The row came back. | Nothing. To take a patient off the list, set Status to **Cancelled**. |
| ⚠ Not removed: this visit is Completed on the website. | A row was deleted, but the patient is already seen or treated. The row came back. | To take a patient off the list, set Status to **Cancelled**. |
| ⚠ Needs attention: 4 rows disappeared at once, so nothing was removed from the website. | Too many rows were deleted together (see below). All the rows came back. | Delete fewer rows at a time, or delete wrong entries on the website. |
| ⚠ Same patient twice on today's list. | The same patient is in two rows. | Set one of them to Cancelled. |
| ⚠ Same checkup patient twice on today's list (same name and phone). Delete one of the rows. | Two checkup rows have the same name and phone (a checkup has no Mr# to tell it by). Both are on the website's checkup list. | Delete one of the rows. The website removes that checkup too, and the warning on the other row goes away. |
| ✗ Already on this list in another row (Mr# ...). | The patient is already in another row today. | Put both treatments in one row and delete this one. |
| ✗ "98 51" is not a Mr#. | The Mr# cell has a space or a letter. | Type the number only, or leave it empty for a checkup patient. |
| ✗ This visit was deleted on the website. | Someone deleted the visit on the website. | Delete this row. |
| ✗ Too many new patients from the sheet today. Add this one on the website. | The sheet may add at most 60 new patients per branch and day (a safety limit). | Add it on the website. |
| ✗ Too many patients added from the sheet today. Add this one on the website. | The sheet may make at most 120 visits per branch and day (a safety limit; the busiest tab has about 50 rows). | Add it on the website. |
| ✗ Too long: ... | A cell has too many letters. | Make it shorter. |

- **Status** words the sheet understands: Waiting, Treatment, Scheduled, Completed, Cancelled, No show. An empty Status is filled in by the website. A word it does not know stays as typed and the row asks you to use one of the words above.
- **Completed** in the sheet completes the visit (owner rule). Anyone who can edit the sheet can do this, so mark Completed only when the patient is really done.
- **Token, Group and Month** can hold your own words ("Kit 80k", "Group 1, Group 2", "04 Photo"). They stay exactly as you typed. The website only reads a Token that is a plain number. In the **Lahore and Islamabad** tabs the Token column holds kit and material text: the website **never fills a blank Token cell there** and never writes a token number into it. In the other three tabs a blank Token cell is filled with the website's token for that patient. A patient added to the Lahore or Islamabad tab from the website comes without a token number in that cell.
- **P.P, Healthwire and Reminder** belong to the sheet. The website never writes over them.
- **Wait a minute after typing a new row.** A row you are still typing in is never touched. A new patient is sent to the website a minute after the last key.
- **Take a patient off the list** by setting Status to Cancelled, or by deleting the row.
- **Deleting a row** removes the visit from the website only when it is Waiting or Scheduled and nothing is attached to it. These safety rules always hold:
  - Deleting **4 or more rows at once**, or **a quarter or more of a tab** (2 or more rows), is treated as a mistake: nothing is removed from the website, and all the rows come back with "Needs attention".
  - At most **15 removals per branch per day**. After that, rows come back.
  - A tab that suddenly reads empty never removes anything.
  - Every removal is written to the website's history (name "Google Sheet sync", with the whole row).
  - **To undo a deletion**: press Ctrl+Z in the sheet right away. The row comes back with its hidden key and the website puts the visit back. (A row typed again from scratch is a new row, not an undo.) Dr. Ali can also undo it later from the SQL editor: `select public.aaj_undo_removal(<the number of the SHEET_REMOVED line in the website's history>);`
- **The heading time** (for example "Website · 09:15 ✓") should be recent. If it is older than **10 minutes** during clinic hours, tell Dr. Ali.
- The heading can also say: **✗ not syncing: the website did not answer** (the internet or the website is down; it starts again by itself), **the website is busy, trying again** (it starts again by itself), **✗ sync secret not accepted** (Dr. Ali must run Set up again), **paused for today (Google time limit)** (use the website; see section 11).

## 6. At night

- At **00:05** the script waits until nobody has typed for a minute (at most until 00:30), sends the last changes to the website for the old day, copies every row of a tab that has rows into **Aj ki List - Archive** (one tab per branch, the date of **that tab's own day** in the first column), and clears the tab. The header row stays. The heading then reads **new list for 2026-10-10**. A tab with no rows is left alone.
- Then the day's **checkup patients** are added to the sheet **Checkup karwaliya**. A checkup patient is a row the website filed as a checkup (it stays one after the person is registered and gets an Mr#), or a row with no Mr# whose Treatment says checkup. Rows marked **Cancelled** or **No show** are left out, and so are rows that "need the Mr#" (tab "Aj ki List checkups", made if it is not there). Each line has: Month, Patient Name, Phone, City, Clinic, Doctor, Treatment / Checkup For, Est. Fee (Rs) empty, Status **Not Contacted**, Notes, Source Tab ("Aj ki List - Gulshan KHI" and so on). A hidden last column ("Sync id") makes sure a patient is added only once. **Lines already in that sheet are never edited or deleted.**
- If the website cannot be reached at midnight, nothing is cleared: the script keeps trying every minute until 02:30 so that the last rows reach the website first. After 02:30 it copies and clears anyway (everything is in the archive).
- If a crash happens in the middle, the next minute finishes the job. Rows typed after the copy are kept for the new day. If the sync was off overnight, rows typed this morning are **not** archived under yesterday: they stay on the tab as today's patients.
- If the sync was off for a day, the old rows are still archived the next morning under their old date. They are not added to today.
- Open the archive from the menu: **Aaj Sync, Open the archive**.

## 7. The checkup list ("Checkup karwaliya")

- The sheet id is built into the script. The tab name is "Aj ki List checkups". To use another tab or another sheet, open the script editor, **Project Settings**, **Script Properties**, and add `CHECKUP_TAB` (the tab name) and/or `CHECKUP_SHEET_ID` (the sheet id from its address). These two are not secret.
- If the tab already has a header row, the script finds the columns by name ("Patient Name", "Phone", "Month", "City", "Clinic", "Doctor", "Treatment / Checkup For", "Est. Fee (Rs)", "Status", "Notes", "Source Tab"). A tab without a "Patient Name" column is not used.
- If the sheet cannot be opened (no access), nothing is lost: the lines wait in the script (up to 300), the sync itself keeps working, the menu **Aaj Sync, Status** says "Checkup list not updated ...", and the lines are added as soon as access works. Share the sheet with edit access to the Google account that ran Set up, then run **Set up** again (or just wait).

## 8. Menu

- **Sync now**: runs one round immediately (only from Dr. Ali's own account).
- **Set up or repair (Dr. Ali)**: the setup above. Use it after a problem, or if a column was deleted.
- **Open the archive**: shows the link.
- **Status**: the time of the last good sync, the Google run time used today, the day each tab holds, and the state of the checkup list.
- **Help**: a short reminder for staff.

## 9. Bringing an old day back into the website

1. Open **Aj ki List - Archive**.
2. Click **File**, **Download**, **Microsoft Excel (.xlsx)**.
3. On the website go to **Admin, Import**, choose the file, and import the day you want. The Date column tells the website which day every row belongs to.

## 10. Turning the old export script off

The old script that copies the website into the "Website - ..." tabs is no longer needed.

- If it lives in **this same script project**, Set up offers to turn its timer off (step 12). Say Yes.
- If it is a **separate script**, open it (Extensions, Apps Script, or the project list at script.google.com), click the **clock icon (Triggers)** on the left, find its timer, click the three dots, and choose **Delete trigger**.
- Leaving it on is harmless. It only writes into the "Website - ..." tabs, which Aaj Sync never touches.

## 11. Problems, Google's time limit

| Problem | What to do |
|---|---|
| Heading says **sync secret not accepted** | Run **aajSetup** again, say No to "Keep the saved sync secret?" and paste the secret. If it still fails, ask for a new secret. |
| Heading says **not syncing: the website did not answer** | The website or the internet is down. It starts again by itself. Staff can keep typing in the sheet; the rows go across afterwards. |
| Heading says **the website is busy, trying again** | The website was busy for a few minutes in a row. It starts again by itself. |
| Heading says **paused for today (Google time limit)** | A free Google account allows about 90 minutes of script running per day. Aaj Sync works only when something was typed or every 5 minutes; at 70 minutes it slows down and at 85 minutes it stops until midnight. Use the website. It starts again after midnight. **Aaj Sync, Status** shows the minutes used today. This has not been measured on the real Google account yet: watch the first days. |
| Heading says **not set up** | Run **aajSetup**. |
| Heading says **the rows of ... are not archived yet** | The nightly clean-up did not finish. It tries again every minute. If it stays, run **aajSetup**. |
| Heading says **more than 400 rows** | Old rows are still on the tab. Clear them (or let the nightly clean-up do it). |
| A column was deleted | Run **aajSetup**. The script makes its columns again and the patients are matched to their own visits again. Nothing is doubled, and the website keeps its state (a Completed visit stays Completed). |
| A tab was renamed | The script only knows the five names above. Rename it back. |
| Something looks wrong | Open the **Aaj Sync log** tab. It lists new patients, removals, problems and the nightly copy. The log shows short messages only; the website keeps the details. |

There is **no e-mail alert** when the sync fails: the clock in the heading is the signal. Look at it now and then.

## 12. Undo: turn Aaj Sync off

1. Open Extensions, Apps Script, then the **clock icon (Triggers)**.
2. Delete the four triggers: **aajSyncTick**, **aajOnEdit**, **aajOnChange**, **aajOnOpen** (three dots, Delete trigger).
3. That is all. The sheet and the website go back to being separate. Nothing is deleted from either one. The Website column and the hidden columns can stay or be deleted.
4. To turn it on again, run **aajSetup**.

## 13. Safety: who can do what (please read)

- **The script is inside the sheet.** Anyone who can **edit** the sheet can open Extensions, Apps Script, and can change the script. The timer runs as **you** (Dr. Ali). A person with edit access who changes the script could therefore make it use your sync secret. The secret is **not** stored in the script text or in Script Properties (where every editor can read it in plain sight); it is kept in your own private storage. That makes it harder to find, but it does **not** make it safe against an editor who wants to misuse it. Give **edit access to the sheet only to staff you trust.**
- The secret is small on purpose. It lets the sheet read and change **today's** lists of the five branches on the website (and yesterday's until 03:00, for the last sync before the archive). It cannot search the patient list, it cannot read other days, and what the website sends back is only what the sheet already shows: names of other patients are given only when that patient was seen at that branch in the last 180 days. A typed Mr# is linked to a patient only when the name in the row fits that patient (or the typed phone is the patient's own): a guessed Mr# with an unreadable or empty name links nobody and gives nothing back. The sheet can make at most 120 visits per branch and day, and at most 20 calls a minute are accepted. Every refused lookup is written to the website's history and stopped after 200 a day. Calls are limited in number and size. Everything the sync does is written to the website's history under "Google Sheet sync".
- **Who "approved" a Completed row.** The visit's reason text says "Completed in the Google Sheet (owner rule, 9 Oct 2026)" and the history names "Google Sheet sync". The website's own "approved by" columns (`protocol_override_by`, `dues_override_by`) must hold a real staff account, so they hold Dr. Ali's account; no screen shows them. Nobody has really approved those rows by hand.
- The sheet's **Completed** completes a visit on the website without the photo, check and dues rules (owner rule). Anyone with edit access can therefore complete a visit. The history shows it every time.
- A person with edit access can **delete rows**. Deletions are limited and audited (section 5) and can be undone, and nothing with an invoice, photo or treatment is ever removed.
- **If a staff member with edit access leaves**, ask for a **new secret** (the website then stops accepting the old one) and run **aajSetup** again with it.
- The script never deletes a patient (a patient file). It removes only a visit or a checkup that was deleted from the sheet, as described above.

## For the developer

- The program is one file, `apps-script/AajSync.js` (plain Google Apps Script, no build step). The rules it follows are in `.omc/handoffs/aaj-sync-design.md` (sections 2 and 6, and "Changes during build" in sections 14 to 17; where they disagree, the later section wins).
- Tests: `node tests/aaj-sync-script.test.mjs` (also run by `npm test`). They load the file into a fake Google (`tests/apps-script-mock.mjs`) and talk to a fake website (`tests/aaj-sync-fake-server.mjs`) written from the same contract. `tests/fixtures/aaj-sync-tab.json` has made-up rows in the formats of the real tabs. `tests/aaj.test.mjs` pins that `web/js/lib/aaj.js` and the script read every row the same way.
- The database side is `public.aaj_sync(p_secret, p_payload)` in `supabase/migrations/20261009000300_aaj_two_way_sync.sql`, tested by `supabase/tests/25_aaj_sync_test.sql`. It needs `20261009000250_checkups.sql` first. The secret is stored as a SHA-256 hash only, in `private.sync_secrets` with the name `aaj_sheet_sync` (the migration never inserts it). Keep the plain secret in a local file, never in the repository.
- Rotate the secret when staff with edit access leave: `update private.sync_secrets set secret_hash = encode(digest('<the new secret>', 'sha256'), 'hex') where name = 'aaj_sheet_sync';` (the name is the primary key, so an insert would fail), then give Dr. Ali the new plain secret to paste into Set up.
- **After the old export script is switched off**, take its secret away too: `delete from private.sync_secrets where name = 'aaj_sheet_export';`. Until then `public.aaj_export` still answers any day for that secret, which sits in the old script inside the same sheet.
- `private.aaj_sync_config`: `rules` = `override` (default, the owner's Completed rule) or `hold`; `calls_per_minute` = 20; `visits_per_branch_day` = 120.
- The website renumbers its own patients to 50000 and above in `20261009000400`; until that is applied, a typed number from 10013 up to 49999 is read as a Healthwire number.
