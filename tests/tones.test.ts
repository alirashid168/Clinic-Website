// The Doctor Name colours of the Aaj ki List (web/js/lib/tones.js). Every person here is made up ("Dr. Sample ..." with
// made-up ids and regions); no real staff name is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSON_TONES, personTones, personTone, personKey } from '../web/js/lib/tones.js';
import { BRACES_PROTOCOL } from '../web/js/lib/protocol.js';

const ABC = 'abcdefghijklmnopqrstuvwxyz';
// (names are told apart by letters: the colour rules leave digits out of a name)
const person = (n: number, region: string | null) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, display_name: `Dr. Sample ${ABC[n % 26]}${ABC[Math.floor(n / 26) % 26]}`, region,
});
const canMeet = (a: any, b: any) => !a.region || !b.region || a.region === b.region;
const sharing = (people: any[], tones: Map<string, string>) => people.flatMap((a, i) => people.slice(i + 1)
  .filter((b) => canMeet(a, b) && tones.get(a.id) === tones.get(b.id)).map((b) => [a, b]));

test('fourteen clearly different chip colours, none of them the empty chip\'s grey', () => {
  assert.equal(PERSON_TONES.length, 14);
  assert.equal(new Set(PERSON_TONES).size, 14);
  assert.ok(!PERSON_TONES.includes('grey'));
});

test('up to fourteen people who can be on one list all get different colours', () => {
  const people = [...Array(9)].map((_, i) => person(i, 'AAA')).concat([...Array(5)].map((_, i) => person(20 + i, null)));
  const tones = personTones(people);
  assert.equal(new Set(people.map((p) => tones.get(p.id))).size, 14);
  for (const p of people) assert.ok(PERSON_TONES.includes(tones.get(p.id)!), p.display_name);
});

test('with fourteen people or fewer, everyone differs, in other cities too (someone can help out there for a day)', () => {
  const people = [person(1, 'AAA'), person(2, 'AAA'), person(3, 'BBB'), person(4, 'BBB'), person(5, 'CCC'), person(6, null), person(7, null),
    person(8, 'AAA'), person(9, 'BBB'), person(10, 'CCC'), person(11, null)];
  const tones = personTones(people);
  assert.equal(new Set(people.map((p) => tones.get(p.id))).size, people.length);
});

test('people of different regions may share a colour, people who can meet share as few as can be', () => {
  // the clinic's shape: 10 people in one city, 4 in another, 2 in a third, 8 who work anywhere
  const people = [
    ...[...Array(10)].map((_, i) => person(i, 'AAA')), ...[...Array(4)].map((_, i) => person(30 + i, 'BBB')),
    ...[...Array(2)].map((_, i) => person(40 + i, 'CCC')), ...[...Array(8)].map((_, i) => person(50 + i, null)),
  ];
  const tones = personTones(people);
  const colours = (region: string) => new Set(people.filter((p) => !p.region || p.region === region).map((p) => tones.get(p.id))).size;
  assert.equal(colours('BBB'), 12, 'the 12 people who can be on a BBB list all differ');
  assert.equal(colours('CCC'), 10);
  assert.equal(colours('AAA'), 14, 'AAA: 18 people, every colour in use');
  const shared = sharing(people, tones);
  assert.equal(shared.length, 18 - 14, 'only as many pairs share a colour as there are people over fourteen');
  assert.ok(shared.every(([a, b]) => a.region || b.region), 'never two people who work anywhere (they would share it on every list)');
});

test('past fourteen, a colour is shared only by people the braces protocol never puts on one row', () => {
  // the clinic's shape in one city: 5 doctors in no group (one of them treats and checks any month, the others are not in a
  // group yet), 3 in group 1, 4 in group 2, 4 in group 3, and 2 assistants; 18 people, so 4 pairs must share a colour
  const doctor = (n: number, group: number | null, region: string | null) => ({ ...person(n, region), is_doctor: true, doctor_group_id: group });
  const people = [
    ...[0, 1, 2, 3, 4].map((n) => doctor(n, null, null)),
    doctor(10, 1, 'AAA'), doctor(11, 1, 'AAA'), doctor(12, 1, null),
    doctor(20, 2, 'AAA'), doctor(21, 2, 'AAA'), doctor(22, 2, null), doctor(23, 2, null),
    doctor(30, 3, 'AAA'), doctor(31, 3, 'AAA'), doctor(32, 3, 'AAA'), doctor(33, 3, 'AAA'),
    { ...person(40, 'AAA'), is_doctor: false, doctor_group_id: null }, { ...person(41, 'AAA'), is_doctor: false, doctor_group_id: null },
  ];
  // a treater and a checker of one month, by the protocol (lib/protocol.js)
  const inOneCell = new Set(BRACES_PROTOCOL.flatMap((r) => (r.checkerGroup ? r.treatingGroups.map((g) => [g, r.checkerGroup].sort().join('-')) : [])));
  const tones = personTones(people);
  const shared = sharing(people, tones);
  assert.equal(shared.length, 18 - 14, 'only as many pairs share a colour as there are people over fourteen');
  for (const [a, b] of shared) {
    const pair = `${a.display_name} + ${b.display_name}`;
    assert.ok(a.is_doctor === b.is_doctor, `never a doctor and an assistant: ${pair}`);
    if (!a.is_doctor) continue;
    assert.ok(a.doctor_group_id && b.doctor_group_id, `never a doctor in no group (treats and checks any month): ${pair}`);
    assert.ok(!inOneCell.has([a.doctor_group_id, b.doctor_group_id].sort().join('-')), `never a treater and a checker of one month: ${pair}`);
  }
});

test('the same colours whatever the order of the list', () => {
  const people = [...Array(20)].map((_, i) => person(i * 7, i % 3 ? 'AAA' : null));
  const tones = personTones(people);
  const again = personTones([...people].reverse());
  for (const p of people) assert.equal(again.get(p.id), tones.get(p.id), p.display_name);
});

test('someone not on the list (no longer active) still gets the same colour every time', () => {
  const on = person(1, null);
  const tones = personTones([on]);
  const a = personTone(tones, 'made-up-id-1', 'Dr. Sample Gone');
  assert.ok(PERSON_TONES.includes(a));
  assert.equal(personTone(tones, 'made-up-id-1', 'Dr. Sample Gone'), a);
  assert.equal(personTone(tones, on.id, on.display_name), tones.get(on.id));
  assert.ok(PERSON_TONES.includes(personTone(null, '', '')));
});

test('a name is compared without "Dr.", case, digits or punctuation', () => {
  assert.equal(personKey('Dr. Sample Aa'), 'sample aa');
  assert.equal(personKey('dr sample-aa'), 'sample aa');
  assert.equal(personKey('DR.Sample  Aa 2'), 'sample aa');
  assert.equal(personKey(null), '');
});
