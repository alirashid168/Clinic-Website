# Open questions for Dr. Ali

The system works without these answers (sensible placeholders are in place), but each one changes how a rule behaves.

## Braces protocol
1. Month 10 and Month 12 both say "END non-extraction cases". A window (end between 10 and 12), or is one a typo? *Now: both months show the end target; overrun flag after Month 12.*
2. Standard wires for Months 8 to 18 (sheets show lots of 018). *Now: blank, doctors write the wire in details.*
3. Rule for Month 19 and later: photos, groups, checker. *Now: reuses Month 18 rules and warns "rule to confirm".*

## People
4. Spelling: Warda or Verda Javed? Urooj Jawed or Javed? *Now: list spelling, old spellings matched as aliases.*
5. Which group are Dr Aimon Aslam, Dr Shizah, Dr Rania, Dr Ali Ahmed, Dr Maham Waheed, Dr Aqsa Nadeem in? *Now: no group, so they cannot be assigned to braces months (Dr. Ali can override).*
6. Hira Anis and Anousha Khan: set as hygienists/assistants (not group-restricted). Correct?

## Money
7. Dues hold: warn only, block, or block only at Months 8 and 15? *Now: warn only. Changeable in Admin → Settings.*
8. Front desk discount limit. *Now: placeholder 10% or Rs 5,000, whichever is lower. Changeable in Admin → Settings.*
9. Doctor percentage rules (you said you'll explain). *Table is ready; Accounts → Reports → Doctors shows treated / checked counts and billed amounts per doctor; the percentage itself is not calculated until the rule is known.*
10. Expense categories from Healthwire. *Now: a starter list of 16 categories.*
11. Invoice template: Classic, Minimal, Premium or Thermal 80mm receipt. *Now: Classic.*

## Website
12. Braces options and prices for the visitor page. *Now: 55k / 70k / 80k / 120k kits, wording to approve in `web/js/content.js`.*
13. WhatsApp number for "Book free consultation". *Admin → Settings.*
14. Dr. Ali's weekly days and times per branch. *Admin → Dr. Ali's calendar.*
15. Is dralirashid.com already owned? Main site at dralirashid.com, or the system at app.dralirashid.com?

## Branches
16. Confirm the five branches: Gulshan (RJ Mall), North Nazimabad, DHA Karachi, Gulberg Lahore, Islamabad. Is the "G…" tab in Aaj ki List Gulberg?

## Imported history (Healthwire)
17. Healthwire never recorded a branch on expenses or on most invoices. Invoices were placed by login/name clues (noted on each). Expenses with a branch name in the text are tagged; the rest sit at city level in the P&L. To split salaries and rent per branch, which categories belong to which branch, and from when? *Each branch's opening date can be set in Admin → Clinic setup (Islamabad = Dec 2025 is filled in).*
18. Healthwire's patient details export (date of birth, gender, address, email) is never delivered by their email. Names, phones and branches are already on the website from the transaction exports; do you want the rest fetched another way?
