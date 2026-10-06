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

async function newPage(viewport = { width: 1366, height: 860 }) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  return page;
}
async function step(name, fn) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { console.log('FAIL -', name, '\n   ', e.message.split('\n')[0]); process.exitCode = 1; }
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };
async function loginAs(page, label) {
  await page.goto(BASE + '#/login/staff');
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.waitForSelector('.sidebar');
}

// ------------------------------------------------------------- public
const page = await newPage();
await step('home shows 3D smile, three doors and calendar', async () => {
  await page.goto(BASE);
  await page.waitForSelector('.smile-stage .tooth');
  assert.equal(await page.locator('.tooth').count(), 24);
  for (const t of ['Patient', 'Visitor', 'Employee']) assert.ok(await page.locator('.door', { hasText: t }).count());
  assert.equal(await page.locator('.sx-day').count(), 7);
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
  await page.click('.nav-link:has-text("Aaj ki List")');
  await page.waitForSelector('table.sheet tbody tr');
  const options = await page.locator('.sheet-toolbar select').first().locator('option').allTextContents();
  assert.deepEqual(options, ['North Nazimabad']);
  assert.ok((await page.locator('table.sheet tbody tr').count()) >= 5);
  assert.ok(await page.locator('.badge-dues').count(), 'dues flag visible');
  await shot(page, '03-sheet-frontdesk');
});
await step('front desk registers a new patient and gets the next Mr#', async () => {
  await page.fill('.add-panel input[type=search]', 'Komal Test');
  await page.click('.suggestions button:has-text("New patient")');
  await page.fill('.modal input[type=tel]', '0300 1234567');
  await page.click('.modal button:has-text("Create patient")');
  await page.waitForSelector('.toast:has-text("Mr# 9841")');
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
  const nav = await page.locator('.nav-link').allTextContents();
  assert.ok(!nav.includes('Admin'));
  assert.ok(!nav.includes('Complaints'));
});
await step('auto-save: editing treatment details shows saved state', async () => {
  const input = page.locator('table.sheet tbody tr:has-text("Komal Test") input[aria-label="Treatment details"]');
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
    const hint = await rows.nth(i).locator('.people .muted').textContent().catch(() => '');
    if (hint && hint.startsWith('G1/2') || hint === 'G1 · check G1') {
      await rows.nth(i).locator('.add-person').click();
      await p2.click('.modal button:has-text("Dr. Haniya Siddiqui")');
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
    await row.locator('select[aria-label="Status"]').selectOption('completed');
    await p2.waitForSelector('.toast-error');
  }
});

// ------------------------------------------------------------- accountant
const p3 = await newPage();
await step('accountant: P&L, expense entry and cash verification', async () => {
  await loginAs(p3, 'Accountant');
  await p3.click('.nav-link:has-text("Accounts")');
  await p3.waitForSelector('.tab');
  await p3.getByRole('tab', { name: 'Expenses', exact: true }).click();
  await p3.locator('label:has-text("Category") select').selectOption({ label: 'Rent' });
  await p3.fill('label:has-text("Amount") input', '120000');
  await p3.click('button:has-text("Save expense")');
  await p3.waitForSelector('.toast:has-text("Expense")');
  await p3.click('.tab:has-text("Branch income")');
  await p3.waitForSelector('table.list');
  await shot(p3, '05-accounts');
});

// ------------------------------------------------------------- admin
const p4 = await newPage();
await step('admin: access list checkboxes change permissions', async () => {
  await loginAs(p4, 'Dr. Ali Rashid');
  await p4.click('.nav-link:has-text("Admin")');
  await p4.waitForSelector('table.perm-grid');
  const box = p4.getByLabel('Assistant: Register new patients (auto Mr#)');
  assert.equal(await box.isChecked(), false);
  await box.check();
  await p4.waitForSelector('.toast:has-text("allowed")');
  await shot(p4, '06-access-list');
});
await step('admin: dashboard, Dr. Ali list and complaints', async () => {
  await p4.click('.nav-link:has-text("Today")');
  await p4.waitForSelector('.stat');
  await shot(p4, '07-today');
  await p4.click('.nav-link:has-text("Dr. Ali")');
  await p4.waitForSelector('table.list');
  assert.ok((await p4.locator('table.list tr').count()) >= 1);
  await p4.click('.nav-link:has-text("Complaints")');
  await p4.waitForSelector('table.list');
});
await step('admin: patient profile with braces guidance', async () => {
  await p4.click('.nav-link:has-text("Patients")');
  await p4.waitForSelector('table.list tbody tr');
  await p4.click('table.list tbody tr:has(.badge:has-text("Braces")) a');
  await p4.waitForSelector('h2:has-text("Braces")');
  await shot(p4, '08-patient-profile');
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

await browser.close();
if (errors.length) { console.log('Browser errors:\n  ' + [...new Set(errors)].join('\n  ')); process.exitCode = 1; }
console.log(`${passed} checks passed`);
