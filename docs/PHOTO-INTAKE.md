# The Photo inbox and the Photo library

For Dr. Ali and the staff. How the day's patient photos get into the right patient's file with a proper name, edited, without anyone
typing a name or an Mr#.

## 1. What it does

Take the patients' photos all day as usual. After the last patient, open **Photos → Photo inbox**, choose the city folder (Karachi,
Lahore or Islamabad) and choose **all** of the day's photos at once. The website reads the time each photo was taken, compares it with the
patients' times on that city's Aaj ki List (checked in, in treatment, completed) and puts each patient's photos into their file by itself
when it is clear. When it is not clear, the photos wait on **"Which patient?"** with the two or three likely patients: one tap on the
right one files them. Nothing is ever filed by guessing. Claude (Anthropic's AI) then turns each photo upright, flips mirror shots, levels
and crops it and evens out the light, and every photo gets a proper name such as
**"Ayesha Khan - Mr# 50013 - Month 6 - Front - 17-10-2026.jpg"**. All edited photos are also in **Photos → Photo library**, where they
can be searched and downloaded. The originals are always kept exactly as they were taken (staff only).

Who may: **assistants, the clinic coordinator and Dr. Ali** use the Photo inbox ("Use the Photo inbox" in the access list; it also
needs "View raw clinic photos folder"). Moving a filed set to another patient and "Undo filing" need "Delete clinic photos and X-rays"
(assistants, the coordinator, Dr. Ali). Everyone who opens patient profiles sees the Photo library (edited photos); originals only with
"View raw clinic photos folder". The front desk keeps Upload picture / Upload X-ray on the patient profile as before.

## 2. Taking the photos

- **The phone's date and time must be automatic** (Settings → Date and time → Automatic). The time on the photo is what finds the patient.
- Take each patient's photos together, one patient after the other. A short pause (a few minutes) between two patients helps.
- **Mark patients "In treatment" and "Completed" on time on the Aaj ki List.** The time the patient went into treatment (or was checked
  in) is what the photo time is compared with. Statuses marked late in one go at the end of the day cannot be used: those photos then
  wait on "Which patient?".
- **iPhone:** Settings → Camera → Formats → **Most Compatible** (JPEG). HEIC photos ("High Efficiency") are uploaded and kept, but only
  Safari (iPhone or Mac) can edit them.
- Photographing a patient twice in one visit (before and after) is fine: you are asked which set is which.

## 3. Uploading (once, at the end of the day)

1. **Photos → Photo inbox.**
2. Choose the **city folder** where the patients were (Karachi, Lahore, Islamabad).
3. Karachi has three branches: if all the photos are from one branch, choose it under "Which branch were these taken at?"; otherwise
   leave **"All Karachi branches"**. (An assistant who works at one branch has it chosen already.)
4. Press **Choose photos** and select all of the day's photos **from the phone's gallery (Photos / Gallery app), not from WhatsApp**.
   WhatsApp removes the time the photo was taken. On a laptop you can also drag the photos onto the page.
5. Wait for "uploaded" and keep the page open while it works. It says how many sets were filed by themselves and how many wait on
   "Which patient?".
- If the wifi drops, simply choose the same photos again: nothing is uploaded twice ("Already uploaded").
- Uploading the next morning is fine: photos go to the day they were taken.
- A second upload the same day (another phone) is fine too: everything of that day is matched again together.

## 4. The screens

**Which patient?** One card per set of photos that is not clear. The card shows the photos (tap one to see it large), the day, the
time, how many photos, the camera, **why it waits** (see section 5) and the likely patients as big buttons: name, Mr#, branch, month
("Month 10 (photo month)") and when they were in the chair. **One tap on the right patient files the photos.**
- **Someone else…**: search the day's list of that city by name, Mr# or token; **Search all patients** for a patient who is not on that
  day's list.
- **Not a patient photo**: puts the set aside (it is kept).
- **Split this set**: when one set has two patients, tap "Next patient starts here" on the first photo of the second patient.
- **Move to another city folder**: when the photos were put in the wrong city.
- **Check these** (at the top): filed sets where Claude thinks the photos show more than one patient, or that one photo is not a patient
  photo. Their edited photos are held back from the patient until someone presses **It's fine**, moves them or undoes the filing.
- **Check again**: matches again now (for example after a missing patient was added to the Aaj ki List). This also happens by itself
  every 3 minutes while the Photo inbox is open.

**Filed**: the sets filed on a day, with the patient (a link to their file), how they were filed ("Automatic: the only photo-month patient
in the chair at 6:35 PM (DHA)" or "Confirmed by ..."), the editing state and what the patient sees. Buttons: **Hide from patient** / **Show
to patient**; **Move to another patient…**; **Undo filing** (the photos go back to "Which patient?"; they are kept); **Take one photo out**.

**Set aside**: photos marked "Not a patient photo" or taken out of a filed set. **Put back** sends them to "Which patient?". Nothing is
ever deleted.

The number on **Photos** in the menu (and on Today) is how many sets wait on "Which patient?" plus the ones to check.

## 5. When it files by itself, and why it sometimes asks

It files a set by itself only when **all** of this holds: every photo has its camera time; the set is one sitting (not more than 20 photos
within 15 minutes); the patient is a **photo-month** patient of that city and day who was **in treatment or completed**, with a real
start or check-in time that the photos fit; **no other photo-month (or bonding / braces-off) patient was in the
chair then**; the patient has no photos yet; and no other set of the day points to the same patient. Everything else asks:

| The card says | What to do |
|---|---|
| No camera time (WhatsApp, edited in an app, or a screenshot). | Choose the patient. Next time upload from the gallery. |
| The camera's date is wrong. | Choose the patient; set the phone to automatic date and time. |
| Nobody is on the city's Aaj ki List for that day. | Add the patient there and press Check again, or use "Search all patients". |
| More than one photo-month (or bonding / braces-off) patient was in the chair then. | Tap the right one. |
| Another set of photos points to the same patient. | Tap the right one for each set. |
| The list has no real check-in or treatment times at that time. | Statuses were marked late or in one go: tap the patient. |
| Taken before the patient was checked in / after they were marked Completed. | Check, then tap the patient. |
| This patient already has photos for this visit. | Tap the patient if it is right (a second set is fine). |
| No photo-month patient was in the chair then. | Tap the patient. |
| Split or put back / The filing was undone. | A person changed this set: choose the patient. |
| Claude thinks these photos show more than one patient / a photo is not a patient photo. | Split the set if needed, then choose. |

## 6. Editing with Claude

While any Photo inbox page is open, Claude looks at a small copy of each photo (1024 pixels, with no name, no Mr#, no date: only the
picture) and says what it shows (front, right side, left side, upper arch, lower arch, overjet, close-up, face front, face smile,
profiles, X-ray, document) and how to turn, flip (mirror shots), straighten and crop it, and whether it is too dark or tinted. The
website then makes the edited copy from the original: upright, mirror shots flipped, levelled, cropped, gentle brightness and colour
(never more than 8 % on any colour, so **teeth are never whitened** and before/after photos stay comparable), at most 2048 pixels. If
Claude cannot answer, a basic edit is made (brightness only). The original is never changed.

**The patient sees the edited photos in their portal 24 hours after they were filed**, so staff have a day to check, hide, move or undo.

Until the AI key is added the page says **"Editing waits for the AI key"**: the photos are uploaded and filed all the same, and Claude
edits them as soon as the key is there (nothing needs uploading again).

## 7. The Photo library

**Photos → Photo library**: every patient's edited photos. Search by name or Mr#; filter by city, branch, month, view and dates. Tap a
photo to see it large, **Download** it (it saves under its proper name) or open the patient's file. Tick photos (or "Select all shown", or
the box next to a patient's day) and press **Download selected (zip)** for one zip file with all the proper names (at most 300 photos).
Staff with "View raw clinic photos folder" can switch to the originals.

## 8. The AI key (Dr. Ali, yourself; never send it in a chat)

1. Go to **console.anthropic.com** and sign in (or create the clinic's account; add a payment method under Billing).
2. **API keys → Create key**, name it "clinic photos", and copy it.
3. Go to the **Supabase dashboard → your project → Edge Functions → Secrets** (Manage secrets) → **Add new secret**:
   name **ANTHROPIC_API_KEY**, value = the key → **Save**.
4. Open the Photo inbox: editing starts on the photos already uploaded.

To stop AI editing, delete that secret. If the page says **"The AI key was refused"**, the key is wrong or was removed: make a new one.

## 9. Cost and storage

- **Claude editing**: about **1 US cent per photo** (about $0.075 for a sitting of 8 photos). 25 photos a day ≈ **$6 a month**; 100 a day
  ≈ **$25 a month** (say $5-35 with retries). Dr. Ali and accounts see "AI editing this month" at the bottom of the Photo inbox, with the
  cost by month; the bill itself is at console.anthropic.com → Usage.
- **Storage** (Supabase): the original as taken (~4 MB), the edited copy (~0.5 MB, at most 2048 px, JPEG 85 %) and two small copies
  (320 px, ~25 kB each): about **4.6 MB per photo**. 25 photos a day ≈ **3 GB a month**; 100 a day ≈ **12 GB a month**. Supabase Pro
  includes **100 GB** (about 8 months at 100 photos a day, 2.5 years at 25), then about $0.021 per GB a month (150 GB ≈ $1 a month extra).
- **Spend cap**: with Supabase's spend cap on, uploads stop once the 100 GB are used. The inbox then says "The clinic's photo storage is
  full" and keeps everything already uploaded. Before about 90 GB: Supabase dashboard → Organization → Billing / Usage → turn the spend
  cap off (or check the usage).

## 10. Problems and what to do

| Problem | What to do |
|---|---|
| "No camera time" on many photos | They came through WhatsApp or were edited. Choose the patient; next time upload from the gallery. |
| "The camera's date is wrong" | Set the phone to automatic date and time. Choose the patient for these. |
| iPhone HEIC photo: no preview / "edit from Safari" | Open the Photo inbox once on an iPhone or a Mac (Safari) to edit them; set Camera → Formats → Most Compatible. |
| "The clinic's photo storage is full" | Dr. Ali: Supabase dashboard → Billing, turn off the spend cap or add space, then choose the photos again. |
| "Editing waits for the AI key" | Section 8. |
| "The AI key was refused" | Make a new key (section 8). |
| A set went to the wrong patient | Filed → Move to another patient, or Undo filing. Within 24 hours the patient has not seen it. |
| "The Photo inbox needs the database update of 17 Oct" | The database update has not been run yet (docs/GO-LIVE.md). |

## For the developer (where things are)

- Database: `supabase/migrations/20261017000200_photo_intake.sql` (tables photo_inbox_items, photo_inbox_sets, photo_ai_calls; the
  photo_inbox_* functions; storage rules; the 24-hour window). Tests: `supabase/tests/40_photo_intake_test.sql`.
- Matching, EXIF, names, edit maths: `web/js/lib/photo-intake.js` (tests/photo-intake.test.ts). Zip: `web/js/lib/zip.js`.
- Pages: `web/js/views/staff/photo-inbox.js`, `photo-library.js`; pixels: `web/js/ui/photo-edit.js`; data:
  `web/js/data/supabase-inbox.js` and the demo `web/js/data/demo-inbox.js`.
- Claude: `supabase/functions/photo-ai/` (core.ts holds the request, the schema and the prompt; model claude-opus-5-5, effort low,
  server-side refusal fallback; tests/photo-ai.test.ts).
- The thresholds (3 minutes between sets, 15 minutes per set, the scores, effort "low") are first guesses: tune them after the first real
  days. The full design is `.omc/handoffs/photo-intake-time-spec.md` (not in the repository).
