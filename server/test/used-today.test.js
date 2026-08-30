import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { dailyData, USED_TODAY_MINUTES } from '../src/daily.js';

// The Clients grid and the Client Page must never disagree about how much a machine was used today.
// They did once: the card counted forward from arriving pings while the page counted the pings
// themselves, so a Client that had been running before the counter existed showed 0 against 1h32.
// Both now read the same Pings; these tests hold them together.

function newDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-used-'));
  const db = openDb(path.join(dir, 'test.db'));
  db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (1, 'Kid PC', 'hash-1')").run();
  db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (2, 'Other PC', 'hash-2')").run();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

// Pings store a UTC server timestamp; tests speak local wall-clock time and let SQLite convert.
function addPing(db, { client = 1, daysAgo = 0, minute, status = 'active', app = null }) {
  db.prepare(
    `INSERT INTO pings (client_id, ts, status, foreground_app)
     VALUES (?, datetime(date('now','localtime',?) || ' ' || ?, 'utc'), ?, ?)`
  ).run(client, `-${daysAgo} days`, hhmm(minute), status, app);
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;

const usedToday = (db, clientId = 1) =>
  db.prepare(`SELECT ${USED_TODAY_MINUTES} AS used_today FROM clients c WHERE c.id = ?`).get(clientId).used_today;

const onClientPage = (db, clientId = 1) =>
  dailyData(db, clientId, db.prepare("SELECT date('now','localtime') d").get().d).totalUsableMinutes;

test('one usable ping per minute is one minute of use', (t) => {
  const db = newDb(t);
  for (let m = 600; m < 620; m++) addPing(db, { minute: m });

  assert.equal(usedToday(db), 20);
});

test('the card and the Client Page report the same number', (t) => {
  const db = newDb(t);
  for (let m = 540; m < 600; m++) addPing(db, { minute: m, app: 'Minecraft' });
  for (let m = 600; m < 632; m++) addPing(db, { minute: m, status: 'grant-active' });
  for (let m = 632; m < 700; m++) addPing(db, { minute: m, status: 'blocked' });

  assert.equal(usedToday(db), 92);            // the 1h32 from the bug report
  assert.equal(usedToday(db), onClientPage(db));
});

test('a second ping in the same minute does not count twice', (t) => {
  const db = newDb(t);
  // Pings are also sent off-cadence — on a redeemed Grant, a settings change, a Lock — so two
  // arriving inside one minute is normal traffic, not a fault.
  addPing(db, { minute: 600 });
  addPing(db, { minute: 600 });
  addPing(db, { minute: 600 });
  addPing(db, { minute: 601 });

  assert.equal(usedToday(db), 2);
  assert.equal(usedToday(db), onClientPage(db));
});

test('blocked and locked minutes are not Usage Time, grant-active is', (t) => {
  const db = newDb(t);
  addPing(db, { minute: 600, status: 'active' });
  addPing(db, { minute: 601, status: 'blocked' });
  addPing(db, { minute: 602, status: 'locked' });
  addPing(db, { minute: 603, status: 'grant-active' });

  assert.equal(usedToday(db), 2);
});

test('yesterday does not leak into today', (t) => {
  const db = newDb(t);
  for (let m = 1380; m < 1440; m++) addPing(db, { daysAgo: 1, minute: m });   // up to local midnight
  addPing(db, { daysAgo: 0, minute: 5 });

  assert.equal(usedToday(db), 1);
});

test('each client is counted separately', (t) => {
  const db = newDb(t);
  for (let m = 600; m < 630; m++) addPing(db, { client: 1, minute: m });
  for (let m = 600; m < 610; m++) addPing(db, { client: 2, minute: m });

  assert.equal(usedToday(db, 1), 30);
  assert.equal(usedToday(db, 2), 10);
});

test('a client that has never pinged reads zero, not null', (t) => {
  const db = newDb(t);

  assert.equal(usedToday(db), 0);
});

test('the window is a range scan, not a scan of every ping the client has', (t) => {
  const db = newDb(t);
  addPing(db, { minute: 600 });

  // This is the reason the number can be derived per render at all — losing it would quietly turn
  // the Clients grid into a full table scan every 5 seconds.
  const plan = db.prepare(
    `EXPLAIN QUERY PLAN SELECT ${USED_TODAY_MINUTES} FROM clients c WHERE c.id = 1`
  ).all().map((r) => r.detail).join(' | ');

  assert.match(plan, /USING (COVERING )?INDEX idx_pings_client_ts/);
});
