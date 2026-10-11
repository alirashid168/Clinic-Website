// Rules for reading Healthwire's export files (made-up rows in the same shape as the real files).
// Usage: node tests/healthwire.test.mjs
import assert from 'node:assert/strict';
import { parseCSV, readTransactions, buildFromTransactions, readPatients, readExpensesPdf, buildExpenses, cleanName, phoneOf, isoMinute, branchOfLogin, splitProcedures, treatmentFor, branchInText } from '../web/js/lib/healthwire.js';

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('ok -', name); } catch (e) { console.log('FAIL -', name, '\n   ', e.message); process.exitCode = 1; } };

test('names lose their branch tag, phones get their leading zero back', () => {
  assert.deepEqual(cleanName('Sana lhr'), { name: 'Sana', tag: 'lhr' });
  assert.deepEqual(cleanName('AHMED KHAN N.N'), { name: 'Ahmed Khan', tag: 'nn' });
  assert.deepEqual(cleanName('Zara Isb.'), { name: 'Zara', tag: 'isb' });
  assert.equal(branchInText('Snacks for N. N staff'), 'NN'); // pdf.js leaves a space after the dot
  assert.equal(branchInText('Snacks for N.N staff'), 'NN');
  assert.equal(branchInText('Nazimabad electrician'), 'NN');
  assert.equal(branchInText('New assistant for Rj'), 'GUL');
  assert.equal(phoneOf(3001234567), '03001234567');
  assert.equal(phoneOf('92 300 1234567'), '03001234567');
  assert.equal(phoneOf(''), null);
  assert.equal(isoMinute('01/08/2026 - 12:36AM'), '2026-08-01 00:36');
  assert.equal(isoMinute('31/08/2026 - 10:12PM'), '2026-08-31 22:12');
  assert.deepEqual(branchOfLogin('North Nazimabad Clinic', '2026-08-03'), { branch: 'NN', swapped: false }); // Monday
  assert.deepEqual(branchOfLogin('North Nazimabad Clinic', '2026-08-04'), { branch: 'GUL', swapped: true }); // Tuesday: NN closed
  assert.deepEqual(splitProcedures('Braces Monthly Payment,brackets'), ['Braces Monthly Payment', 'brackets']);
  assert.deepEqual(splitProcedures('Root Canal 15 , Smile Makeover Zirconia , Extraction 16, 14, 36'), ['Root Canal 15', 'Smile Makeover Zirconia', 'Extraction 16, 14, 36']);
  assert.deepEqual(treatmentFor('Braces First Payment'), [4, 'Bonding']);
  assert.equal(treatmentFor('Frenectomy')[0], null);
});

const TX_CSV = `Dr. Ali Rashid's Dental Clinic,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,
Financial Transaction Report,,,,,,,,,,,,,,,
Invoice#,MR#,Patient Name,Patient Phone#,Location,Description,Total,Cash,Discount,Dues,Advance,Mode Of Payment,Created By,Updated By,Discounted By,Payment Date
900006,7991,Test Patient One,3009990001,-,Braces First Payment,150000,40000,110000,0,0,Cash ,RJ Mall Clinic,RJ Mall Clinic,,01/08/2026 - 12:36AM
900006,7991,Test Patient One,3009990001,-,Braces First Payment,150000,0,110000,0,0,Cash ,RJ Mall Clinic,Test Accounts,,02/08/2026 - 03:10PM
134007,9557,Test Patient Two lhr,3001112223,-,"Braces Monthly Payment,brackets",8000,4000,0,4000,0,Debit/Credit Card ,Lahore Gulberg Clinic,Lahore Gulberg Clinic,,05/08/2026 - 06:00PM
134008,9558,TEST PATIENT THREE,3009998887,-,Scaling & Polishing,5000,5000,0,0,0,Online Payment ,Test Accounts,Test Accounts,,06/08/2026 - 01:00PM
134009,9557,Test Patient Two lhr,3001112223,-,Braces Monthly Payment,4000,4000,0,0,0,Cash ,Lahore Gulberg Clinic,Lahore Gulberg Clinic,,05/08/2026 - 06:05PM
134010,9559,Test Patient Four,3005556667,-,Braces First Payment,70000,20000,0,30000,0,Cash ,North Nazimabad Clinic,North Nazimabad Clinic,,04/08/2026 - 05:00PM
134011,9558,TEST PATIENT THREE,3009998887,-,ORTHO RETAINER,10000,2000,0,3000,0,Cash ,DHA Clinic,DHA Clinic,,20/08/2026 - 07:30PM
Totals:,,,,,,397000,75000,220000,37000,0,,,,,
`;

test('transactions report: header row found, totals row ignored, modes trimmed', () => {
  const { tx, columns } = readTransactions(parseCSV(TX_CSV));
  assert.equal(tx.length, 7);
  assert.ok(columns.includes('paid') && columns.includes('createdBy'));
  assert.equal(tx[0].mode, 'Cash');
  assert.equal(tx[0].phone, '03009990001');
  assert.equal(tx[0].at, '2026-08-01 00:36');
});

test('transactions -> invoices, payments, visits and patients with branches from the logins', () => {
  const { tx } = readTransactions(parseCSV(TX_CSV));
  const out = buildFromTransactions(tx);
  assert.equal(out.summary.invoices, 6);
  assert.equal(out.summary.payments, 6); // the 0-rupee row is no payment
  assert.equal(out.summary.paid, 75000);
  assert.deepEqual(out.summary.perBranch, { 1: 60000, 4: 8000, 3: 7000 }); // 134010: NN login on a Tuesday = Gulshan; 134008 follows the patient's other invoice (DHA)
  const inv = Object.fromEntries(out.invoices.map((r) => [r[0], r]));
  assert.equal(inv['900006'][2], 1); // RJ Mall login -> Gulshan
  assert.equal(inv['134007'][2], 4); // Lahore
  assert.equal(inv['134008'][2], 3); // entered by accounts: the patient's other invoice says DHA, note 3
  assert.equal(inv['134008'][6], 3);
  assert.equal(out.summary.unknownBranch.length, 0);
  assert.equal(inv['134007'][7][0][1], 'Braces Monthly Payment, brackets');
  assert.equal(inv['134007'][7][0][3], 8000);
  assert.deepEqual(inv['900006'][7], [[4, 'Braces First Payment', 1, 150000]]);
  assert.equal(inv['900006'][5], 110000); // discount
  assert.equal(inv['134011'][6], 5); // 10000 - 0 - 3000 dues - 2000 paid here = 5000 paid outside the file
  assert.equal(inv['134011'][2], 3); // DHA
  assert.equal(out.summary.otherPeriods.length, 2); // 134010 too (its note stays 1: the NN-login swap matters more)
  assert.deepEqual(out.payments.find((p) => p[0] === '900006'), ['900006', '7991', 1, 40000, 'Cash', '2026-08-01 00:36']);
  assert.equal(out.visits.length, 6); // patient two paid two invoices on the same day: one visit
  const v2 = out.visits.find((v) => v[0] === '9557');
  assert.deepEqual(v2.slice(0, 3), ['9557', '2026-08-05', 4]);
  assert.deepEqual(v2[6], [134007, 134009]);
  const p = Object.fromEntries(out.patients.map((r) => [r[0], r]));
  assert.deepEqual(p['9557'].slice(1, 4), ['Test Patient Two', 'Test Patient Two lhr', '03001112223']);
  assert.equal(p['9557'][9], 4);
  assert.equal(p['9558'][1], 'Test Patient Three');
});

test('invoice 134010: North Nazimabad login on a Tuesday counts as Gulshan', () => {
  const { tx } = readTransactions(parseCSV(TX_CSV));
  const out = buildFromTransactions(tx);
  const row = out.invoices.find((r) => r[0] === '134010');
  // 2026-08-04 is a Tuesday: NN is closed, so the entry was made at Gulshan under the NN login.
  assert.equal(row[2], 1);
  assert.equal(row[6], 1);
});

test('patients list: columns matched by name, gender and dates normalised', () => {
  const csv = `MR#,Patient Name,Phone,Gender,Date of Birth,Address,Email,Registration Date\n7991,Test Patient One,3009990001,Female,12-05-1998,"House 1, Karachi",,01-02-2024\n9560,Someone Isb,3331234567,M,,,x@y.z,03/08/2026\n`;
  const { patients } = readPatients(parseCSV(csv));
  assert.equal(patients.length, 2);
  assert.deepEqual(patients[0], ['7991', 'Test Patient One', null, '03009990001', null, null, 'female', '1998-05-12', 'House 1, Karachi', null, '2024-02-01']);
  assert.deepEqual(patients[1].slice(0, 2), ['9560', 'Someone']);
  assert.equal(patients[1][6], 'male');
  assert.equal(patients[1][9], 5);
});

// Text items as pdf.js returns them for the expenses PDF (x, y in points; y grows upwards).
const page = (rows, withTotal) => {
  const items = [{ s: 'Sr#', x: 33, y: 670 }, { s: 'Voucher#', x: 88, y: 670 }];
  let y = 647;
  rows.forEach((r, i) => {
    items.push({ s: String(i + 1), x: 33, y }, { s: r.voucher, x: 88, y });
    r.desc.split(' ').forEach((w, k) => items.push({ s: w, x: 144 + (k % 2) * 20, y: y - Math.floor(k / 2) * 12 }));
    items.push({ s: r.date.slice(0, 2), x: 202, y }, { s: '/', x: 210, y }, { s: r.date.slice(3, 5), x: 212, y }, { s: '/', x: 219, y }, { s: r.date.slice(6), x: 222, y });
    items.push({ s: r.cat, x: 257, y }, { s: r.amount, x: 348, y }, { s: r.mode, x: 404, y }, { s: '08', x: 459, y }, { s: '/', x: 467, y }, { s: r.date.slice(0, 2), x: 469, y }, { s: '/', x: 477, y }, { s: '2026', x: 479, y }, { s: '-', x: 496, y }, { s: '10:52', x: 459, y: y - 12 }, { s: 'PM', x: 476, y: y - 12 }, { s: 'Test', x: 515, y }, { s: 'Accounts', x: 535, y });
    y -= 60;
  });
  if (withTotal) items.push({ s: 'Total', x: 33, y: y + 10 }, { s: 'Expense', x: 60, y: y + 10 }, { s: ':', x: 90, y: y + 10 }, { s: '7,600.0', x: 120, y: y + 10 });
  items.push({ s: 'Office', x: 76, y: 32 }, { s: '# 53, 54', x: 107, y: 32 });
  return { items };
};

test('expenses PDF: rows per Sr#, wrapped descriptions joined, footer and total line ignored', () => {
  const pages = [
    page([{ voucher: '108602', desc: 'Carpenter supplies and wages in Rj branch', date: '31/08/2026', cat: 'Renovation/Maintenance', amount: '2,600.0', mode: 'Cash' },
      { voucher: '108601', desc: 'Sugar pot & Spoon', date: '31/08/2026', cat: 'Office Supplies', amount: '1,050.0', mode: 'Cash' }]),
    page([{ voucher: '108590', desc: 'Electrician wages in lhr', date: '29/08/2026', cat: 'Renovation/Maintenance', amount: '3,000.0', mode: 'Online Payment' },
      { voucher: '108589', desc: 'Flat rent Lahore', date: '29/08/2026', cat: 'Home Rent', amount: '950.0', mode: 'Cash' }], true),
  ];
  // pdf.js splits "Dr. Ali" into "Dr", ".", "Ali" — the category must still match the Healthwire name.
  const extra = page([{ voucher: '108588', desc: 'Watch for', date: '28/08/2026', cat: 'Personal', amount: '500.0', mode: 'Cash' }]);
  extra.items.push({ s: 'Dr', x: 144, y: 635 }, { s: '.', x: 153, y: 635 }, { s: 'Ali', x: 157, y: 635 },
    { s: 'Dr', x: 290, y: 647 }, { s: '.', x: 299, y: 647 }, { s: 'Ali', x: 302, y: 647 }, { s: 'Rashid', x: 315, y: 647 });
  pages.push(extra);
  const read = readExpensesPdf(pages);
  assert.equal(read.rows.length, 5);
  assert.equal(read.total, 8100);
  assert.equal(read.printedTotal, 7600);
  assert.equal(read.rows[4].category, 'Personal Dr. Ali Rashid');
  assert.equal(read.rows[4].desc, 'Watch for Dr. Ali');
  assert.equal(read.rows[0].desc, 'Carpenter supplies and wages in Rj branch');
  assert.equal(read.rows[0].date, '2026-08-31');
  assert.equal(read.rows[0].createdAt, '2026-08-31 22:52');
  assert.equal(read.rows[1].desc, 'Sugar pot & Spoon');
  assert.equal(read.rows[3].createdBy, 'Test Accounts');
  const built = buildExpenses(read.rows);
  assert.deepEqual(built.categories, ['Home rent (Dr. Ali)', 'Maintenance and repairs', 'Office supplies', 'Personal (Dr. Ali)']);
  assert.equal(built.expenses.find((e) => e[7] === 108588)[1], null); // personal spending: no branch
  const byV = Object.fromEntries(built.expenses.map((e) => [e[7], e]));
  assert.equal(byV[108602][1], 1); // Rj -> Gulshan
  assert.equal(byV[108590][1], 4); // lhr -> Lahore
  assert.equal(byV[108590][2], 2); // Lahore city
  assert.equal(byV[108589][1], null); // Home Rent never gets a branch
  assert.equal(byV[108589][2], 2); // but the city is Lahore
  assert.equal(byV[108601][1], null);
  assert.equal(byV[108601][2], 1);
  assert.equal(built.summary.total, 8100);
});

test('expenses PDF: columns are read from the header row, so a file with wider columns still parses', () => {
  // Same table, every column pushed to the right (as in the yearly files), header labels split like pdf.js does.
  const y = 652, hy = 674;
  const H = (s, x) => ({ s, x, y: hy });
  const items = [H('Sr#', 33), H('Voucher#', 86), H('Description', 140), H('Date', 214), H('Category', 268), H('Amount', 356), { s: 'Payment', x: 409, y: hy + 12 }, H('Mode', 409), H('Created', 463), H('At', 493), H('Created', 517), H('By', 547),
    { s: '1', x: 33, y }, { s: '900130', x: 86, y }, { s: 'DHA', x: 139.9, y }, { s: 'travelling', x: 156, y }, { s: 'expense', x: 140, y: y - 11 },
    { s: '06', x: 214, y }, { s: '/', x: 221, y }, { s: '10', x: 223, y }, { s: '/', x: 231, y }, { s: '2026', x: 233, y },
    { s: 'Traveling', x: 268, y }, { s: 'Staff', x: 298, y }, { s: '9,930.0', x: 356, y }, { s: 'Cash', x: 409, y },
    { s: '10', x: 463, y }, { s: '/', x: 470, y }, { s: '06', x: 472, y }, { s: '/', x: 480, y }, { s: '2026', x: 482, y }, { s: '-', x: 498, y }, { s: '10:28', x: 463, y: y - 11 }, { s: 'PM', x: 479, y: y - 11 },
    { s: 'Test', x: 517, y }, { s: 'Accounts', x: 536, y }];
  const read = readExpensesPdf([{ items }]);
  assert.equal(read.rows.length, 1);
  assert.deepEqual(read.rows[0], { voucher: '900130', desc: 'DHA travelling expense', date: '2026-10-06', category: 'Traveling Staff', amount: 9930, mode: 'Cash', createdAt: '2026-10-06 22:28', createdBy: 'Test Accounts' });
  assert.equal(buildExpenses(read.rows).expenses[0][1], 3); // DHA
});

console.log(`${passed} passed`);
