// What the SQL test (supabase/tests/26_mr_50000_test.sql) cannot show, because it runs in one database session: the migration
// 20261009000400_mr_50000_front_desk_portal.sql must hold the patients table against writing before it does anything else.
// Without that, a patient registered at the very second the file runs can take the number 10013 (the old counter) after the
// renumbering has looked at the table and before the new counter is set, and keep a number inside Healthwire's range.
// Run: node tests/mr-50000-migration.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('ok -', name); } catch (e) { console.log('FAIL -', name, '\n   ', e.message.split('\n')[0]); process.exitCode = 1; } };

const sql = fs.readFileSync(new URL('../supabase/migrations/20261009000400_mr_50000_front_desk_portal.sql', import.meta.url), 'utf8');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');   // without the comment lines
const head = code.split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);   // the first statements hold no semicolon inside

test('the file is one transaction: it begins first and commits', () => {
  assert.equal(head[0], 'begin');
  assert.ok(head.includes('commit'));
});

test('the first thing after begin is a lock on patients that stops writers (a registration in flight is waited for, new ones wait their turn)', () => {
  assert.match(head[1], /^set local lock_timeout = '\d+s'$/, 'the lock gives up after a while instead of waiting for ever, changing nothing');
  assert.match(head[2], /^lock table public\.patients in (share|share row exclusive|exclusive|access exclusive) mode$/i);
  // no other statement touches the data before the lock
  const at = code.indexOf('lock table public.patients');
  for (const later of ['create or replace function pg_temp.mr_50000_renumber', 'update public.patients', 'sync_mr_sequence()', 'setval(']) {
    assert.ok(code.indexOf(later) > at, later + ' comes after the lock');
  }
});

// The SQL Editor shows only the last result and no notices, so the owner can only learn what the file did from the last statement.
// (The SQL test checks the two session settings that statement reads: 11 and the list of old -> new numbers on a first run, 0 and nothing on a second.)
test('the last statement after the commit is the result row: how many this run moved, which, what is left alone, the next number, the front desk right', () => {
  const at = head.indexOf('commit');
  assert.ok(at >= 0 && at < head.length - 1, 'the result row comes after the commit');
  const last = head[head.length - 1];
  assert.match(last, /^select coalesce\(nullif\(current_setting\('mr_50000\.moved_count', true\), ''\), '0'\)::integer as patients_renumbered_now, coalesce\(nullif\(current_setting\('mr_50000\.moved', true\), ''\), '[^']+'\) as old_to_new, /);
  for (const column of ['left_alone_10000_10999', 'next_mr_number', 'front_desk_can_make_portal_logins']) assert.ok(last.includes(' as ' + column), column + ' is in the result row');
  // and the renumbering is what writes both settings (also for a run that moves nobody)
  const fn = code.slice(code.indexOf('create or replace function pg_temp.mr_50000_renumber'), code.indexOf('select pg_temp.mr_50000_renumber()'));
  assert.equal(fn.split("set_config('mr_50000.moved_count'").length - 1, 2, 'the count is reset at the start and set after the move');
  assert.equal(fn.split("set_config('mr_50000.moved'").length - 1, 2, 'the list is reset at the start and set after the move');
});

console.log(`${passed} passed`);
