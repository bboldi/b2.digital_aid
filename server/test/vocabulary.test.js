import test from 'node:test';
import assert from 'node:assert/strict';
import { vocabulary, keysOf } from '../src/i18n.js';
import { timeLeftText } from '../src/format.js';
import { PING_STATUSES } from '../src/protocol.js';
import { translatorFor } from '../src/i18n.js';

// The bug this file exists to stop coming back: English leaking onto a Hungarian page through a
// value that was never routed through the catalogue. `timeLeftText` composed its sentences in
// English for months and nothing failed, because nothing was checking.

test('every Ping status the protocol knows has a word in both languages', () => {
  // Presence in the catalogue, not "differs from the raw value": `status.active` is legitimately
  // "active" in English, and a fallback and a real translation are indistinguishable from outside.
  for (const status of PING_STATUSES) {
    for (const lang of ['en', 'hu']) {
      assert.ok(keysOf(lang).includes(`status.${status}`), `status.${status} missing from ${lang}`);
      assert.ok(vocabulary(lang, 'status', status).length, `status.${status} empty in ${lang}`);
    }
  }
});

test('an unknown status keeps its own word rather than becoming a bracketed apology', () => {
  // A Client newer than this server is entitled to its vocabulary (PROTOCOL.md §7.1). The audit
  // trail must not editorialise about a word it has not learned.
  assert.equal(vocabulary('hu', 'status', 'hibernating'), 'hibernating');
  assert.equal(vocabulary('en', 'event', 'something-new'), 'something-new');
  assert.equal(vocabulary('hu', 'status', null), '');
});

test('every Time Left reason renders translated in both languages', () => {
  const reasons = ['grant', 'allowance', 'downtime', 'exhausted', 'locked'];
  for (const lang of ['en', 'hu']) {
    const t = translatorFor(lang);
    for (const reason of reasons) {
      const text = timeLeftText(
        { last_status: 'active', last_reason: reason, last_remaining: 25, downtime_end: '21:00' }, t);
      assert.doesNotMatch(text, /^\[/, `time.${reason} missing from ${lang}`);
    }
    assert.doesNotMatch(timeLeftText({ disabled: 1 }, t), /^\[/);
    assert.doesNotMatch(timeLeftText({ last_status: 'locked' }, t), /^\[/);
  }
});

test('the two Time Left languages actually differ', () => {
  // Parity alone would pass if hu.json simply copied the English. These are the strings a parent
  // reads at a glance, so at least confirm somebody translated them.
  const client = { last_status: 'blocked', last_reason: 'exhausted' };
  assert.notEqual(timeLeftText(client, translatorFor('en')), timeLeftText(client, translatorFor('hu')));
});

test('every status and event key exists in both catalogues', () => {
  const en = keysOf('en').filter((k) => k.startsWith('status.') || k.startsWith('event.'));
  const hu = new Set(keysOf('hu'));
  assert.ok(en.length > 10);
  for (const key of en) assert.ok(hu.has(key), `${key} missing from hu`);
});
