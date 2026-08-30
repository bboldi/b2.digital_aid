import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, enabled, suppressSimultaneous, GAP_MINUTES, LOCKED_HOLD_MINUTES } from '../src/alerts.js';

// Every rule in ADR-0013 that is easy to get wrong, and every one that would be silently annoying
// rather than visibly broken — a notification feature fails by being too noisy, and nothing about
// that shows up in a stack trace.

const T0 = new Date('2026-08-20T09:00:00Z');
const at = (minutes) => new Date(T0.getTime() + minutes * 60000);
const sql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const watch = (status, reason, sinceMin, { alerted = 0, lastPingMin = sinceMin } = {}) => ({
  status, reason, since: sql(at(sinceMin)), alerted, last_ping_at: sql(at(lastPingMin)),
});

const SERVER_UP = new Date('2026-08-20T06:00:00Z');

// --- "The PC came on" -----------------------------------------------------------------------

test('a Client seen for the very first time counts as coming on', () => {
  const { kind } = classify(undefined, { status: 'active', reason: 'allowance' }, T0, SERVER_UP);
  assert.equal(kind, 'started');
});

test('a gap shorter than the threshold is not coming on', () => {
  const prev = watch('active', 'allowance', 0);
  const { kind } = classify(prev, { status: 'active', reason: 'allowance' }, at(GAP_MINUTES - 1), SERVER_UP);
  assert.equal(kind, null);
});

test('a gap at the threshold is coming on', () => {
  const prev = watch('active', 'allowance', 0);
  const { kind } = classify(prev, { status: 'active', reason: 'allowance' }, at(GAP_MINUTES), SERVER_UP);
  assert.equal(kind, 'started');
});

test('a gap that contains this server starting is the server, not the PC', () => {
  // The case that would otherwise fire a false "he is on the PC" every time the box is redeployed.
  const prev = watch('active', 'allowance', 0);
  const restarted = at(5);
  const { kind } = classify(prev, { status: 'active', reason: 'allowance' }, at(GAP_MINUTES + 5), restarted);
  assert.equal(kind, null);
});

test('a PC that comes back already blocked did not start being used', () => {
  const prev = watch('active', 'allowance', 0);
  const { kind } = classify(prev, { status: 'blocked', reason: 'downtime' }, at(60), SERVER_UP);
  assert.equal(kind, null);
});

test('a PC that comes back on a Grant did start being used', () => {
  const prev = watch('active', 'allowance', 0);
  const { kind } = classify(prev, { status: 'grant-active', reason: 'grant' }, at(60), SERVER_UP);
  assert.equal(kind, 'started');
});

test('several Clients returning together is the network, not the household', () => {
  const both = suppressSimultaneous([{ kind: 'started' }, { kind: 'started' }]);
  assert.deepEqual(both.map((c) => c.kind), [null, null]);
  const one = suppressSimultaneous([{ kind: 'started' }, { kind: 'exhausted' }]);
  assert.deepEqual(one.map((c) => c.kind), ['started', 'exhausted']);
});

// --- "Time is up" ---------------------------------------------------------------------------

test('running out of time fires', () => {
  const prev = watch('active', 'allowance', 0);
  const { kind } = classify(prev, { status: 'blocked', reason: 'exhausted' }, at(1), SERVER_UP);
  assert.equal(kind, 'exhausted');
});

test('Downtime does not fire, however blocked the PC is', () => {
  // It arrives at the same minute every night by the Admin's own rule. An Alert for it is a daily
  // buzz confirming the configuration works, which is how a channel teaches people to ignore it.
  const prev = watch('active', 'allowance', 0);
  const { kind } = classify(prev, { status: 'blocked', reason: 'downtime' }, at(1), SERVER_UP);
  assert.equal(kind, null);
});

test('an Admin Lock does not fire — a human just pressed it', () => {
  const prev = watch('active', 'allowance', 0);
  const { kind } = classify(prev, { status: 'blocked', reason: 'locked' }, at(1), SERVER_UP);
  assert.equal(kind, null);
});

test('staying exhausted fires once, not once a minute', () => {
  let state = watch('active', 'allowance', 0);
  const first = classify(state, { status: 'blocked', reason: 'exhausted' }, at(1), SERVER_UP);
  assert.equal(first.kind, 'exhausted');
  state = first.watch;
  for (let m = 2; m < 8; m++) {
    const next = classify(state, { status: 'blocked', reason: 'exhausted' }, at(m), SERVER_UP);
    assert.equal(next.kind, null, `minute ${m}`);
    state = next.watch;
  }
});

// --- "Left alone" ---------------------------------------------------------------------------

test('locking does not fire immediately — that is lunch, not leaving', () => {
  const prev = watch('active', 'allowance', 0);
  const { kind } = classify(prev, { status: 'locked', reason: null }, at(1), SERVER_UP);
  assert.equal(kind, null);
});

test('locking fires once it has held, and then not again', () => {
  let state = classify(watch('active', 'allowance', 0), { status: 'locked', reason: null }, at(1), SERVER_UP).watch;

  for (let m = 2; m < 1 + LOCKED_HOLD_MINUTES; m++) {
    const step = classify(state, { status: 'locked', reason: null }, at(m), SERVER_UP);
    assert.equal(step.kind, null, `minute ${m}`);
    state = step.watch;
  }

  const fired = classify(state, { status: 'locked', reason: null }, at(1 + LOCKED_HOLD_MINUTES), SERVER_UP);
  assert.equal(fired.kind, 'locked');

  const after = classify(fired.watch, { status: 'locked', reason: null }, at(30), SERVER_UP);
  assert.equal(after.kind, null);
});

test('a lock and unlock inside the hold window says nothing at all', () => {
  // A bathroom trip. The Flyout offers the lock button precisely so this happens often.
  let state = classify(watch('active', 'allowance', 0), { status: 'locked', reason: null }, at(1), SERVER_UP).watch;
  state = classify(state, { status: 'locked', reason: null }, at(4), SERVER_UP).watch;
  const back = classify(state, { status: 'active', reason: 'allowance' }, at(5), SERVER_UP);
  assert.equal(back.kind, null);
});

test('the hold is measured from when the lock started, not from the last ping', () => {
  // The bug this guards: copying `since` forward on every unchanged ping would restart the clock
  // each minute and the Alert would never fire at all.
  let state = classify(watch('active', 'allowance', 0), { status: 'locked', reason: null }, at(0), SERVER_UP).watch;
  for (let m = 1; m < LOCKED_HOLD_MINUTES; m++) {
    state = classify(state, { status: 'locked', reason: null }, at(m), SERVER_UP).watch;
  }
  assert.equal(state.since, sql(at(0)));
  const fired = classify(state, { status: 'locked', reason: null }, at(LOCKED_HOLD_MINUTES), SERVER_UP);
  assert.equal(fired.kind, 'locked');
});

// --- The household switches ------------------------------------------------------------------

test('a kind that is switched off is not sent', () => {
  const admin = { alert_request: 1, alert_started: 0, alert_exhausted: 0, alert_locked: 0 };
  assert.equal(enabled(admin, 'request'), true);
  assert.equal(enabled(admin, 'started'), false);
});

test('an unknown kind is off rather than a crash', () => {
  assert.equal(enabled({ alert_request: 1 }, 'nonsense'), false);
  assert.equal(enabled(null, 'request'), false);
});
