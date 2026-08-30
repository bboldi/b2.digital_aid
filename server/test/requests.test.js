import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import {
  askForTime, decide, markDelivered, lapseExpired, undeliveredVerdict, cooldownSeconds,
  withdrawOpen, openUntil, deliverUntil, COOLDOWN_MINUTES, MAX_ASK_MINUTES,
} from '../src/requests.js';

// A Request is the only thing in this system a kid can start, and the only one whose value is
// entirely in *when* it is answered. These tests pin the two ways it can go quiet — nobody answered,
// and the PC never came back — because both must end up visible to the parent rather than vanishing.

function newDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-requests-'));
  const db = openDb(path.join(dir, 'test.db'));
  db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (1, 'Kid PC', 'hash-1')").run();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

const rows = (db) => db.prepare('SELECT * FROM requests ORDER BY id').all();
const only = (db) => rows(db).at(-1);

// A fixed evening, well clear of midnight, so the hour-long window is the binding constraint.
const evening = (hhmm = '20:47') => new Date(`2026-08-19T${hhmm}:00`);

test('an ask is recorded and answered pending', (t) => {
  const db = newDb(t);
  assert.deepEqual(askForTime(db, 1, 30, evening()), { state: 'pending', minutes: 30 });
  assert.equal(only(db).asked_minutes, 30);
  assert.equal(only(db).state, 'open');
});

test('asking twice re-shows the open ask instead of stacking', (t) => {
  const db = newDb(t);
  askForTime(db, 1, 30, evening());
  assert.deepEqual(askForTime(db, 1, 60, evening('20:49')), { state: 'duplicate', minutes: 30 });
  assert.equal(rows(db).length, 1);
});

test('minutes are clamped rather than rejected', (t) => {
  const db = newDb(t);
  // The number is advisory (CONTEXT.md: Request) — a kid who types 9999 should still reach a parent,
  // who then picks the real minutes. Refusing the ask would just hide it.
  askForTime(db, 1, 9999, evening());
  assert.equal(only(db).asked_minutes, MAX_ASK_MINUTES);
});

test('a decline starts a cooldown, and the cooldown expires', (t) => {
  const db = newDb(t);
  askForTime(db, 1, 30, evening());
  decide(db, only(db).id, { approve: false, now: evening('20:48') });

  const soon = askForTime(db, 1, 30, evening('20:50'));
  assert.equal(soon.state, 'cooldown');
  assert.ok(soon.retryAfter > 0 && soon.retryAfter <= COOLDOWN_MINUTES * 60);

  const later = new Date(evening('20:48').getTime() + (COOLDOWN_MINUTES + 1) * 60000);
  assert.equal(cooldownSeconds(db, 1, later), 0);
  assert.equal(askForTime(db, 1, 30, later).state, 'pending');
});

test('an unanswered ask lapses after its hour', (t) => {
  const db = newDb(t);
  askForTime(db, 1, 30, evening());

  lapseExpired(db, evening('21:46'));
  assert.equal(only(db).state, 'open');           // still inside the hour

  lapseExpired(db, evening('21:48'));
  assert.equal(only(db).state, 'lapsed');
});

test('the window never runs past local midnight', (t) => {
  const db = newDb(t);
  const lateNight = new Date('2026-08-19T23:40:00');
  askForTime(db, 1, 30, lateNight);
  // "Can I finish this match?" does not carry over into tomorrow's allowance.
  assert.equal(only(db).expires_at, openUntil(lateNight));
  assert.equal(new Date(`${only(db).expires_at.replace(' ', 'T')}Z`).getHours(), 0);
});

test('an approval waits for an offline PC, then lapses visibly', (t) => {
  const db = newDb(t);
  askForTime(db, 1, 30, evening());
  const decided = decide(db, only(db).id, { approve: true, minutes: 45, now: evening('20:50') });

  assert.equal(decided.state, 'approved');
  assert.equal(decided.granted_minutes, 45);
  // The delivery window is its own thing: approving at 20:50 buys the PC until 21:20 to come back,
  // not the leftovers of the original hour.
  assert.equal(decided.expires_at, deliverUntil(evening('20:50')));

  assert.equal(undeliveredVerdict(db, 1, evening('21:10'))?.id, decided.id);
  assert.equal(undeliveredVerdict(db, 1, evening('21:30')), undefined);

  lapseExpired(db, evening('21:30'));
  // Lapsed, not deleted: a parent who gave 45 minutes is owed the fact that they never landed.
  assert.equal(only(db).state, 'lapsed');
  assert.equal(only(db).granted_minutes, 45);
});

test('a delivered verdict is not owed again', (t) => {
  const db = newDb(t);
  askForTime(db, 1, 30, evening());
  const decided = decide(db, only(db).id, { approve: true, minutes: 30, now: evening('20:50') });
  markDelivered(db, decided.id, evening('20:50'));

  assert.equal(undeliveredVerdict(db, 1, evening('20:51')), undefined);
  // And it survives the sweep — delivered is a finished state, not an expired one.
  lapseExpired(db, evening('23:00'));
  assert.equal(only(db).state, 'approved');
});

test('a second phone cannot answer an answered request', (t) => {
  const db = newDb(t);
  askForTime(db, 1, 30, evening());
  const id = only(db).id;
  assert.ok(decide(db, id, { approve: true, minutes: 30, now: evening('20:50') }));
  // Two parents on two phones must not produce two Grants.
  assert.equal(decide(db, id, { approve: true, minutes: 30, now: evening('20:51') }), undefined);
  assert.equal(only(db).granted_minutes, 30);
});

test('a lapsed request cannot be approved after the fact', (t) => {
  const db = newDb(t);
  askForTime(db, 1, 30, evening());
  // decide() sweeps first, so the stale Approve button on a page left open all evening does nothing.
  assert.equal(decide(db, only(db).id, { approve: true, minutes: 30, now: evening('22:30') }), undefined);
  assert.equal(only(db).state, 'lapsed');
});

test('a lapsed ask does not block the next one', (t) => {
  const db = newDb(t);
  askForTime(db, 1, 30, evening());
  assert.equal(askForTime(db, 1, 30, evening('22:00')).state, 'pending');
  assert.equal(rows(db).length, 2);
  assert.equal(rows(db)[0].state, 'lapsed');
});


// --- Withdrawal --------------------------------------------------------------------------------
// A kid who redeems an Extra Time Code while still waiting on an answer has settled the question
// themselves. Leaving the Request open would let a parent approve it later and hand out the minutes
// a second time.

test('redeeming a code withdraws the open request', (t) => {
  const db = newDb(t);
  askForTime(db, 1, 30, evening());

  assert.equal(withdrawOpen(db, 1), 1);
  assert.equal(only(db).state, 'withdrawn');
});

test('a withdrawn request is no longer answerable, and is not a decline', (t) => {
  const db = newDb(t);
  askForTime(db, 1, 30, evening());
  withdrawOpen(db, 1);

  // Nothing open to decide on, so an Approve arriving late finds nothing to approve.
  assert.equal(decide(db, 1, 45, evening('20:55')), undefined);
  // And it starts no cooldown: nobody said no.
  assert.equal(cooldownSeconds(db, 1, evening('20:55')), 0);
  // The kid may ask again straight away — the earlier ask was answered by a code, not refused.
  assert.equal(askForTime(db, 1, 20, evening('20:56')).state, 'pending');
});

test('withdrawing with nothing open changes nothing', (t) => {
  const db = newDb(t);
  assert.equal(withdrawOpen(db, 1), 0);
  assert.equal(rows(db).length, 0);
});
