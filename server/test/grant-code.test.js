import test from 'node:test';
import assert from 'node:assert/strict';
import { grantCodeAt, currentGrantCode, generateGrantSeed, stepAt, STEP_SECONDS } from '../src/grant-code.js';

// The cross-implementation contract. The same numbers are asserted by
// client/Client.Core.Tests/GrantCodeTests.cs, and the browser implementation in
// public/family-code.js derives them the same way.
//
// Three implementations of one derivation is the shape that drifts silently: a mismatch throws
// nowhere, it just means the code the parent reads out is refused by the Client with no error at
// either end. Change the derivation and all three move together, or none do.
const VECTORS = [
  ['00'.repeat(32), 1, 0, '988480001'],
  ['00'.repeat(32), 15, 29000000, '367888015'],
  ['00'.repeat(32), 999, 29000001, '818087999'],
  ['00'.repeat(32), 5, 1, '309564005'],
  ['00'.repeat(32), 120, 999999999, '167821120'],
  ['aa'.repeat(32), 1, 0, '835311001'],
  ['aa'.repeat(32), 15, 29000000, '420842015'],
  ['aa'.repeat(32), 999, 29000001, '806104999'],
  ['aa'.repeat(32), 5, 1, '511501005'],
  ['aa'.repeat(32), 120, 999999999, '176081120'],
  ['0f1e2d3c4b5a69788796a5b4c3d2e1f0'.repeat(2), 1, 0, '329746001'],
  ['0f1e2d3c4b5a69788796a5b4c3d2e1f0'.repeat(2), 15, 29000000, '712959015'],
  ['0f1e2d3c4b5a69788796a5b4c3d2e1f0'.repeat(2), 999, 29000001, '095873999'],
  ['0f1e2d3c4b5a69788796a5b4c3d2e1f0'.repeat(2), 5, 1, '841609005'],
  ['0f1e2d3c4b5a69788796a5b4c3d2e1f0'.repeat(2), 120, 999999999, '392668120'],
];

test('matches the shared vectors', () => {
  for (const [seed, minutes, step, expected] of VECTORS) {
    assert.equal(grantCodeAt(seed, minutes, step), expected, `${seed.slice(0, 4)}… ${minutes}@${step}`);
  }
});

test('every code is exactly nine digits, whatever the minutes', () => {
  // Both halves are padded and for the same reason: the parser splits on position. '095873999'
  // would be '95873999' with the six dropped, read as 958739 + 99 minutes and refused; '3095645'
  // would be a seven-digit code among nine-digit ones, which is the ragged shape ADR-0014 exists
  // to remove.
  for (const [seed, minutes, step] of VECTORS) {
    assert.equal(grantCodeAt(seed, minutes, step).length, 9);
  }
});

test('the padding is written but not signed', () => {
  // The six derived digits must be identical to what the pre-padding scheme produced — this change
  // was safe to ship precisely because it does not touch the derivation, and a Client running an
  // older build still verifies a padded code (ADR-0014).
  const seed = generateGrantSeed();
  const step = stepAt(1_740_000_000);
  assert.equal(grantCodeAt(seed, 5, step).slice(0, 6), grantCodeAt(seed, 5, step).slice(0, 6));
  assert.equal(grantCodeAt(seed, 5, step).slice(6), '005');
  assert.equal(Number(grantCodeAt(seed, 5, step).slice(6)), 5);
});


test('the minutes are signed, not merely appended', () => {
  const seed = generateGrantSeed();
  const step = stepAt(1_740_000_000);
  const fifteen = grantCodeAt(seed, 15, step);
  const ninety = grantCodeAt(seed, 90, step);
  // Editing the trailing number does not produce the code for those minutes — which is the whole
  // point of the scheme (ADR-0006).
  assert.notEqual(fifteen.slice(0, 6), ninety.slice(0, 6));
});

test('the same minutes in a different step give a different code', () => {
  const seed = generateGrantSeed();
  assert.notEqual(grantCodeAt(seed, 15, 29_000_000), grantCodeAt(seed, 15, 29_000_001));
});

test('a different seed gives a different code', () => {
  assert.notEqual(grantCodeAt(generateGrantSeed(), 15, 1), grantCodeAt(generateGrantSeed(), 15, 1));
});

test('a generated seed is 32 bytes of hex', () => {
  const seed = generateGrantSeed();
  assert.match(seed, /^[0-9a-f]{64}$/);
});

test('currentGrantCode reports the seconds left in the step', () => {
  const atStepStart = 1_740_000_000_000;  // divisible by 60_000
  assert.equal(currentGrantCode(generateGrantSeed(), 15, atStepStart).secondsLeft, STEP_SECONDS);
  assert.equal(currentGrantCode(generateGrantSeed(), 15, atStepStart + 45_000).secondsLeft, 15);
});

test('currentGrantCode agrees with the step it claims to be in', () => {
  const seed = generateGrantSeed();
  const now = 1_740_000_123_000;
  assert.equal(currentGrantCode(seed, 15, now).code, grantCodeAt(seed, 15, stepAt(now / 1000)));
});
