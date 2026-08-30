import test from 'node:test';
import assert from 'node:assert/strict';
import { readProductVersion, isDevBuild } from '../src/pe-version.js';
import { fakeExe } from '../test-support/fake-exe.js';

test('reads a release version', () => {
  assert.equal(readProductVersion(fakeExe('0.2.0')), '0.2.0');
});

test('reads a version carrying build metadata', () => {
  assert.equal(readProductVersion(fakeExe('0.1.0+dev.abc1234')), '0.1.0+dev.abc1234');
});

test('tolerates any 32-bit alignment padding between key and value', () => {
  for (const pad of [0, 1, 2, 3]) {
    assert.equal(readProductVersion(fakeExe('1.2.3', { pad })), '1.2.3');
  }
});

test('a build-metadata version is a dev build; a plain one is not', () => {
  assert.equal(isDevBuild('0.1.0+dev.abc1234'), true);
  assert.equal(isDevBuild('0.1.0'), false);
  assert.equal(isDevBuild(null), false);
});

// Everything below must return null rather than throw: a malformed upload is a rejection with a
// message for the parent, never a 500.
test('returns null when the resource section declares no version', () => {
  assert.equal(readProductVersion(fakeExe(null)), null);
});

test('returns null when there is no .rsrc section', () => {
  assert.equal(readProductVersion(fakeExe('0.2.0', { sectionName: '.text' })), null);
});

test('returns null for files that are not PEs', () => {
  assert.equal(readProductVersion(Buffer.from('this is not an exe')), null);
  assert.equal(readProductVersion(Buffer.alloc(0)), null);
  assert.equal(readProductVersion(Buffer.alloc(4096)), null);
});

test('returns null for a PE truncated mid-header', () => {
  assert.equal(readProductVersion(fakeExe('0.2.0').subarray(0, 0x90)), null);
});

test('refuses a value long enough to be something other than a version', () => {
  assert.equal(readProductVersion(fakeExe('9'.repeat(200))), null);
});
