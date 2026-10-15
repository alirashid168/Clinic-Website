// Shared logins: the name typed at the desk (web/js/lib/desk-name.js). What it pins down: a name is 2 to 60 characters of any language
// (counted like the database counts them), tidied the same way every time; it travels in the x-desk-name header percent-encoded, and
// reading it back follows the same rules as the database's private.request_desk_name() (20261015000300_desk_names.sql): anything that
// is not a clean name is null, never an error. The name is kept per tab and per login, never handed to another login, and the
// storage helpers keep working (in memory) when the browser blocks storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESK_NAME_MIN, DESK_NAME_MAX, DESK_NAME_HEADER, SUGGESTIONS_KEPT, cleanDeskName, encodeDeskName, decodeDeskName, withDeskName, deskLabel,
  withSuggestion, deskNameFor, keepDeskName, forgetDeskName, deskNameSuggestions, rememberDeskName,
} from '../web/js/lib/desk-name.js';

const URDU = 'عائشہ نمونہ'; // "Ayesha Namuna" (a made-up name), 11 characters

test('a name: trimmed, spaces made one, 2 to 60 characters, any language', () => {
  assert.equal(DESK_NAME_MIN, 2);
  assert.equal(DESK_NAME_MAX, 60);
  assert.deepEqual(cleanDeskName('  Sadia   Khan '), { name: 'Sadia Khan' });
  assert.deepEqual(cleanDeskName('Sadia\tKhan\n'), { name: 'Sadia Khan' });
  assert.deepEqual(cleanDeskName('Al'), { name: 'Al' });
  assert.deepEqual(cleanDeskName(URDU), { name: URDU });
  assert.deepEqual(cleanDeskName('a'.repeat(60)), { name: 'a'.repeat(60) });
  assert.match(cleanDeskName('S').error, /at least 2 letters/);
  assert.match(cleanDeskName('   ').error, /at least 2 letters/);
  assert.match(cleanDeskName('').error, /at least 2 letters/);
  assert.match(cleanDeskName(null).error, /at least 2 letters/);
  assert.match(cleanDeskName('a'.repeat(61)).error, /at most 60 letters/);
});

test('a name is counted in characters like the database (an emoji is one), and control characters are dropped', () => {
  assert.deepEqual(cleanDeskName('😀'.repeat(60)), { name: '😀'.repeat(60) }, '60 emoji are 120 UTF-16 units but 60 characters');
  assert.match(cleanDeskName('😀'.repeat(61)).error, /at most 60/);
  assert.deepEqual(cleanDeskName('Sa\u0007dia'), { name: 'Sadia' });
  assert.deepEqual(cleanDeskName('Sadia \u0000 Khan'), { name: 'Sadia Khan' });
  assert.deepEqual(cleanDeskName('‮Sadia‬'), { name: 'Sadia' }, 'text-direction overrides cannot make a name read as another');
  assert.match(cleanDeskName('\u0007\u0008').error, /at least 2/);
});

test('the header: percent-encoded UTF-8, read back exactly as the database reads it', () => {
  assert.equal(DESK_NAME_HEADER, 'x-desk-name');
  assert.equal(encodeDeskName('Sadia Khan'), 'Sadia%20Khan');
  assert.equal(encodeDeskName(URDU), '%D8%B9%D8%A7%D8%A6%D8%B4%DB%81%20%D9%86%D9%85%D9%88%D9%86%DB%81');
  assert.match(encodeDeskName(URDU), /^[\x21-\x7e]+$/, 'only plain ASCII goes in a header');
  for (const name of ['Sadia Khan', URDU, "Al(i)_A.!~*'-", '😀😀', 'b'.repeat(60)]) assert.equal(decodeDeskName(encodeDeskName(name)), name, name);
  // The longest possible name still fits the database's limit on the header.
  assert.ok(encodeDeskName('😀'.repeat(60)).length <= 800);
});

test('reading the header back: anything that is not a clean name is null, never an error', () => {
  for (const bad of [undefined, null, 42, '', 'S', '%20%20', 'Sample%ZZSadia', 'Sample%2', 'Sample%C3%28', 'Sample%00Sadia', 'Sample%07Sadia',
    'Sample Sadia', URDU, 'a'.repeat(61), '%41'.repeat(300), '["Sample"]']) {
    assert.equal(decodeDeskName(bad as any), null, String(bad));
  }
  assert.equal(decodeDeskName('%20%20Sample%20%20%20Hina%09'), 'Sample Hina', 'spaces tidied like the database');
});

test('"Front desk Islamabad (Sadia)" where a change is put down to a login, "Front desk Islamabad · Sadia" in the name menu', () => {
  assert.equal(withDeskName('Front desk Islamabad', 'Sadia'), 'Front desk Islamabad (Sadia)');
  assert.equal(withDeskName('Front desk Islamabad', null), 'Front desk Islamabad');
  assert.equal(withDeskName('Dr. Ali Rashid', ''), 'Dr. Ali Rashid');
  assert.equal(deskLabel('Front desk Islamabad', 'Sadia'), 'Front desk Islamabad · Sadia');
  assert.equal(deskLabel('Front desk Islamabad', null), 'Front desk Islamabad');
});

test('suggestions: the latest name first, once only whatever its capitals, at most 12', () => {
  assert.deepEqual(withSuggestion(['Mehak', 'Sadia'], 'Hina'), ['Hina', 'Mehak', 'Sadia']);
  assert.deepEqual(withSuggestion(['Mehak', 'Sadia'], 'SADIA'), ['SADIA', 'Mehak']);
  assert.deepEqual(withSuggestion(null as any, 'Hina'), ['Hina']);
  assert.deepEqual(withSuggestion(['Hina', 7, null] as any, 'Sadia'), ['Sadia', 'Hina']);
  const many = Array.from({ length: 20 }, (_, i) => `Name ${i}`);
  assert.equal(withSuggestion(many, 'Hina').length, SUGGESTIONS_KEPT);
  assert.equal(SUGGESTIONS_KEPT, 12);
});

// A browser's storage, or one that refuses (private mode, blocked site data).
function storage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => (map.has(k) ? map.get(k)! : null), setItem: (k: string, v: string) => { map.set(k, String(v)); }, removeItem: (k: string) => { map.delete(k); }, map };
}
const refusing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
const g = globalThis as any;

test('the name is kept for this tab and this login only, until it is forgotten', () => {
  g.sessionStorage = storage();
  forgetDeskName();
  assert.equal(deskNameFor('s-fd-isb'), null);
  keepDeskName('s-fd-isb', 'Sadia');
  assert.equal(deskNameFor('s-fd-isb'), 'Sadia');
  assert.equal(deskNameFor('s-other'), null, 'never handed to another login');
  assert.equal(deskNameFor(null as any), null);
  assert.deepEqual(JSON.parse(g.sessionStorage.getItem('desk-name')), { staffId: 's-fd-isb', name: 'Sadia' }, 'in sessionStorage: a reload of the tab keeps it');
  forgetDeskName();
  assert.equal(deskNameFor('s-fd-isb'), null, 'gone after logout or a new sign-in');
  assert.equal(g.sessionStorage.getItem('desk-name'), null);
});

test('a name kept by an earlier page of the tab is read back (a reload), and a damaged copy is not', () => {
  g.sessionStorage = storage();
  forgetDeskName();
  g.sessionStorage.setItem('desk-name', JSON.stringify({ staffId: 's-fd-isb', name: '  Mehak  ' }));
  assert.equal(deskNameFor('s-fd-isb'), 'Mehak');
  forgetDeskName();
  g.sessionStorage.setItem('desk-name', '{damaged');
  assert.equal(deskNameFor('s-fd-isb'), null);
  g.sessionStorage.setItem('desk-name', JSON.stringify({ staffId: 's-fd-isb', name: 'M' }));
  assert.equal(deskNameFor('s-fd-isb'), null, 'a copy that is not a clean name');
});

test('storage blocked: the name lasts in memory, nothing throws', () => {
  g.sessionStorage = refusing;
  g.localStorage = refusing;
  forgetDeskName();
  keepDeskName('s-fd-isb', 'Hina');
  assert.equal(deskNameFor('s-fd-isb'), 'Hina');
  assert.deepEqual(deskNameSuggestions('s-fd-isb'), []);
  rememberDeskName('s-fd-isb', 'Hina');
  forgetDeskName();
  assert.equal(deskNameFor('s-fd-isb'), null);
  delete g.sessionStorage;
  delete g.localStorage;
  assert.equal(deskNameFor('s-fd-isb'), null, 'no storage at all (Node, a strange browser)');
});

test('names typed before on this computer are offered again, per login', () => {
  g.localStorage = storage();
  rememberDeskName('s-fd-isb', 'Sadia');
  rememberDeskName('s-fd-isb', 'Mehak');
  rememberDeskName('s-fd-isb', 'sadia');
  assert.deepEqual(deskNameSuggestions('s-fd-isb'), ['sadia', 'Mehak']);
  assert.deepEqual(deskNameSuggestions('s-asst-isb'), [], 'another login has its own list');
  g.localStorage.setItem('desk-names:s-x', JSON.stringify(['Ok name', 'x', 5, '  Hina ']));
  assert.deepEqual(deskNameSuggestions('s-x'), ['Ok name', 'Hina'], 'what is not a clean name is not offered');
  g.localStorage.setItem('desk-names:s-y', 'not json');
  assert.deepEqual(deskNameSuggestions('s-y'), []);
  delete g.localStorage;
});
