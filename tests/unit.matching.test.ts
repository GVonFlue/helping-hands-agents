import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCommonName, parseOwnerName } from '../src/names.ts';
import { pickMatch, profileUrl, scoreHit, type Subject } from '../src/facebook.ts';
import { aiCents } from '../src/spend.ts';

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
    'https://www.facebook.com/jane.doe/posts/999',
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
