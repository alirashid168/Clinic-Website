import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importSheet, toSQL, parseCSV } from '../scripts/import-aaj-ki-list.ts';

const clinicians = JSON.parse(fs.readFileSync(new URL('../scripts/clinicians.json', import.meta.url), 'utf8'));
const csv = fs.readFileSync(new URL('./fixtures/aaj-ki-list-sample.csv', import.meta.url), 'utf8');

test('CSV parser handles quoted cells with commas', () => {
  assert.deepEqual(parseCSV('a,"b, c",d\n1,"say ""hi""",3\n'), [['a', 'b, c', 'd'], ['1', 'say "hi"', '3']]);
});

test('Aaj ki List rows become clean records with problems listed', () => {
  const rows = importSheet(csv, clinicians);
  assert.equal(rows.length, 7);
  const three = rows.find((r) => r.mrNumber === '8715')!;
  assert.equal(three.name, 'Sample Person Three', 'branch suffix removed');
  assert.equal(three.month, 6);
  assert.equal(three.pendingPayment, 35000);
  assert.deepEqual(three.people.map((p) => p.matched), ['Dr. Haniya Siddiqui', 'Dr. Samrah Khan']);
  assert.ok(three.detailsSummary.includes('Brackets 16, 13, 45, 46'));
  const five = rows.find((r) => r.mrNumber === '9197')!;
  assert.equal(five.people[1].matched, 'Dr. Urooj Jawed', 'spelling "Javed" matched');
  const seven = rows.find((r) => r.name === 'Sample Person Seven')!;
  assert.ok(seven.problems.some((p) => p.includes('Unknown name')));
  const six = rows.find((r) => r.mrNumber === '6989')!;
  assert.ok(six.problems.some((p) => p.includes('not a number')));
});

test('SQL output skips rows that cannot be identified', () => {
  const sql = toSQL(importSheet(csv, clinicians), 'NN', '2026-10-05');
  assert.ok(sql.includes('SKIPPED: no Mr# and no phone'));
  assert.ok(sql.startsWith('-- Aaj ki List import'));
  assert.ok(sql.trim().endsWith('commit;'));
});
