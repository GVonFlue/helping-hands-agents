import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstNameFromRaw, isCommonName, parseOwnerName } from '../src/names.ts';
import { isProbate } from '../src/listSignals.ts';
import { pickMatch, profileUrl, scoreHit, type Subject } from '../src/facebook.ts';
import { aiCents } from '../src/spend.ts';
import { mapSerper } from '../src/search.ts';

test('owner names: county order, first-last, commas, couples, suffixes', () => {
  assert.deepEqual(parseOwnerName('STOLTENBERG KARL J & DIANE M'), [
    { first: 'KARL', middle: 'J', last: 'STOLTENBERG' },
    { first: 'DIANE', middle: 'M', last: 'STOLTENBERG' },
  ]);
  assert.deepEqual(parseOwnerName('John A Smith Jr'), [{ first: 'JOHN', middle: 'A', last: 'SMITH' }]);
  assert.deepEqual(parseOwnerName('SMITH, JOHN'), [{ first: 'JOHN', middle: null, last: 'SMITH' }]);
  assert.deepEqual(parseOwnerName('JONES ROBERT AND MARY'), [
    { first: 'ROBERT', middle: null, last: 'JONES' },
    { first: 'MARY', middle: null, last: 'JONES' },
  ]);
});

test('trusts, estates and companies are not people', () => {
  for (const n of ['SMITH FAMILY TRUST', 'ESTATE OF MARY JONES', 'ACME HOLDINGS LLC', 'JONES JOHN TRUSTEE', 'CITY OF WICHITA']) {
    assert.deepEqual(parseOwnerName(n), [], n);
  }
});

test('common names', () => {
  assert.equal(isCommonName({ first: 'JOHN', middle: null, last: 'SMITH' }), true);
  assert.equal(isCommonName({ first: 'KARL', middle: null, last: 'STOLTENBERG' }), false);
});

test('only personal profile URLs pass, normalised', () => {
  assert.equal(profileUrl('https://m.facebook.com/jane.doe.5?ref=x'), 'https://www.facebook.com/jane.doe.5');
  assert.equal(profileUrl('https://www.facebook.com/profile.php?id=100012345678'), 'https://www.facebook.com/profile.php?id=100012345678');
  assert.equal(profileUrl('https://www.facebook.com/people/Jane-Doe/100012345678/'), 'https://www.facebook.com/people/Jane-Doe/100012345678');
  for (const bad of [
    'https://www.facebook.com/groups/123456',
    'https://www.facebook.com/pages/Some-Biz/123',
    'https://www.facebook.com/jane.doe/events/999',
    'https://www.facebook.com/100090816563619/posts/123',
    'https://l.facebook.com/l.php?u=x',
    'https://www.facebook.com/marketplace',
    'https://evil-facebook.com/jane.doe',
    'https://www.linkedin.com/in/jane',
  ]) assert.equal(profileUrl(bad), null, bad);
});

const karl: Subject = {
  person: { first: 'KARL', middle: 'J', last: 'STOLTENBERG' },
  coOwnerFirst: 'DIANE',
  cities: ['Wichita'],
  states: ['KS'],
};

test('scoring: name + city + co-owner + rare name is strong; another state sinks it', () => {
  const strong = scoreHit({ url: 'https://www.facebook.com/k.s.7', title: 'Karl Stoltenberg | Facebook', snippet: 'Lives in Wichita, Kansas. Diane' }, karl)!;
  assert.ok(strong.score >= 0.9, String(strong.score));
  const away = scoreHit({ url: 'https://www.facebook.com/k.s.8', title: 'Karl Stoltenberg | Facebook', snippet: 'Lives in Austin, Texas' }, karl)!;
  assert.ok(away.score < 0.6, String(away.score));
  const nickname = scoreHit(
    { url: 'https://www.facebook.com/bob.q', title: 'Bob Quackenbush', snippet: 'Lives in Wichita, Kansas' },
    { person: { first: 'ROBERT', middle: null, last: 'QUACKENBUSH' }, coOwnerFirst: null, cities: ['Wichita'], states: ['KS'] },
  )!;
  assert.ok(nickname.score >= 0.6, 'Bob matches Robert');
  assert.equal(scoreHit({ url: 'https://www.facebook.com/x.y.z', title: 'Karla Stolt', snippet: 'Wichita' }, karl), null, 'wrong name');
});

test('no place signal is never enough, however rare the name', () => {
  const r = pickMatch([{ url: 'https://www.facebook.com/k.s.7', title: 'Karl J Stoltenberg', snippet: '' }], karl, 0.6);
  assert.equal(r.match, null);
});

test('AI cost math', () => {
  assert.equal(aiCents('claude-sonnet-5-5', 1_000_000, 0), 200);
  assert.equal(aiCents('claude-sonnet-5-5', 1500, 300), 0.6);
});

test("the list's own FIRST NAME column settles name order", () => {
  // Without the hint, a given name that's also a common first name in second place flips the order.
  assert.equal(parseOwnerName('DEVONTE THOMAS')[0]!.first, 'THOMAS');
  assert.deepEqual(parseOwnerName('DEVONTE THOMAS', 'DEVONTE'), [{ first: 'DEVONTE', middle: null, last: 'THOMAS' }]);
  assert.deepEqual(parseOwnerName('MARY ANN JONES-LEE', 'MARY')[0], { first: 'MARY', middle: 'ANN', last: 'JONES-LEE' });
  assert.equal(firstNameFromRaw({ 'FULL NAME': 'X Y', 'FIRST NAME': 'X ' }), 'X');
  assert.equal(firstNameFromRaw({ owner_first_name: 'Ann' }), 'Ann');
});

test('probate detection from the raw vendor row', () => {
  assert.equal(isProbate({ 'PROBATE ADDRESS ID': '2972173940.0' }), true);
  assert.equal(isProbate({ MOTIVATIONS: 'AbsenteeProbate Owner' }), true);
  assert.equal(isProbate({ MOTIVATIONS: 'OwnerAge:40-49', 'PROBATE ADDRESS ID': '' }), false);
});

test('Serper responses map to url, title, snippet', () => {
  const hits = mapSerper({ organic: [
    { title: 'Karl Stoltenberg | Facebook', link: 'https://www.facebook.com/karl.s.7', snippet: 'Lives in Wichita, Kansas.', position: 1 },
    { title: 'no link' },
  ] });
  assert.deepEqual(hits, [{ url: 'https://www.facebook.com/karl.s.7', title: 'Karl Stoltenberg | Facebook', snippet: 'Lives in Wichita, Kansas.' }]);
  assert.deepEqual(mapSerper({}), []);
});

test("a person's own post points to their profile; page posts and mentions don't", () => {
  const stacie: Subject = { person: { first: 'STACIE', middle: null, last: 'MOOMEY' }, coOwnerFirst: null, cities: ['Wichita'], states: ['KS'] };
  const own = scoreHit({ url: 'https://www.facebook.com/stacie.moomey.5/posts/123456', title: 'Stacie Moomey', snippet: 'Wichita, Kansas' }, stacie)!;
  assert.equal(own.url, 'https://www.facebook.com/stacie.moomey.5');
  assert.ok(own.signals.includes('from their own post'));
  assert.ok(own.score >= 0.6);
  // A page's post that mentions her in the snippet: title isn't her name.
  assert.equal(scoreHit({ url: 'https://www.facebook.com/wichitanews/posts/1', title: 'Big game Friday night', snippet: 'Stacie Moomey and 69 others. Wichita' }, stacie), null);
  // Someone else's post titled with her name but the username isn't hers.
  assert.equal(scoreHit({ url: 'https://www.facebook.com/lexi.mcintosh2001/posts/9', title: 'Stacie Moomey', snippet: 'Wichita' }, stacie), null);
  // A post with a long title (not just the author's name).
  assert.equal(scoreHit({ url: 'https://www.facebook.com/stacie.moomey.5/posts/2', title: 'Stacie Moomey is at the Wichita State game', snippet: '' }, stacie), null);
});
