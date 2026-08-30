import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grantCodeAt, stepAt } from '../src/grant-code.js';

// The browser is the third implementation of the Grant Code derivation, and the one that is easiest
// to forget: it ships as a static file, nothing imports it, and a drift shows up only as a parent
// reading out a code that the Client refuses. So this test reads the *shipped* source, lifts the
// derivation out of it, and holds it against the server's — copying the function into a fixture
// would only prove the fixture right.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'public', 'family-code.js'), 'utf8');

function browserGrantCode() {
  const start = SOURCE.indexOf('const GRANT_STEP');
  const end = SOURCE.indexOf('// --- State');
  assert.ok(start > 0 && end > start, 'could not find the Grant Code block in public/family-code.js');
  // WebCrypto, TextEncoder and Uint8Array are all globals in Node, so the browser source runs here
  // unmodified — which is the only reason this comparison means anything.
  return new Function(`${SOURCE.slice(start, end)}; return grantCode;`)();
}

test('the browser derivation matches the server, digit for digit', async () => {
  const grantCode = browserGrantCode();
  const seeds = ['00'.repeat(32), 'aa'.repeat(32), '0f1e2d3c4b5a69788796a5b4c3d2e1f0'.repeat(2)];

  for (const seed of seeds) {
    for (const minutes of [1, 5, 15, 120, 999]) {
      for (const epoch of [0, 60, 1_740_000_000, 1_740_000_059]) {
        assert.equal(
          await grantCode(seed, minutes, epoch),
          grantCodeAt(seed, minutes, stepAt(epoch)),
          `seed ${seed.slice(0, 4)}… ${minutes} min at ${epoch}`,
        );
      }
    }
  }
});

test('the browser uses the same step length as the server', () => {
  assert.match(SOURCE, /const GRANT_STEP = 60;/);
});
