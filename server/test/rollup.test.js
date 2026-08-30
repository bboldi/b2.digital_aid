import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { rollUpOldPings } from '../src/rollup.js';
import { dailyData } from '../src/daily.js';

// Rolling up is a one-way door: once a day's raw Pings are deleted, a different summary shape cannot
// be recomputed from them (ADR-0003). These tests pin what the summary keeps.

function newDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-rollup-'));
  const db = openDb(path.join(dir, 'test.db'));
  db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (1, 'Kid PC', 'hash-1')").run();
  db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (2, 'Other PC', 'hash-2')").run();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

// Pings carry a server timestamp and are bucketed by local date, so tests insert local times and
// let SQLite convert to the UTC the column actually stores.
function addPing(db, { client = 1, daysAgo, minute, status = 'active', app = null }) {
  db.prepare(
    `INSERT INTO pings (client_id, ts, status, foreground_app)
     VALUES (?, datetime(date('now','localtime',?) || ' ' || ?, 'utc'), ?, ?)`
  ).run(client, `-${daysAgo} days`, hhmm(minute), status, app);
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;

const summary = (db, client = 1) =>
  db.prepare('SELECT * FROM daily_usage WHERE client_id = ? ORDER BY date').all(client);

const pingCount = (db) => db.prepare('SELECT count(*) n FROM pings').get().n;

test('leaves pings inside the retention window alone', (t) => {
  const db = newDb(t);
  for (const daysAgo of [0, 1, 29]) addPing(db, { daysAgo, minute: 600 });

  const result = rollUpOldPings(db);

  assert.deepEqual(result, { days: 0, pingsDeleted: 0 });
  assert.equal(pingCount(db), 3);
  assert.equal(summary(db).length, 0);
});

test('folds an old day into a summary and deletes its pings', (t) => {
  const db = newDb(t);
  for (let m = 600; m < 660; m++) addPing(db, { daysAgo: 40, minute: m, app: 'Minecraft' });
  for (let m = 700; m < 710; m++) addPing(db, { daysAgo: 40, minute: m, status: 'blocked' });

  const result = rollUpOldPings(db);

  assert.equal(result.days, 1);
  assert.equal(result.pingsDeleted, 70);
  assert.equal(pingCount(db), 0);

  const [day] = summary(db);
  assert.equal(day.used_minutes, 60);
  assert.equal(day.blocked_minutes, 10);
  assert.deepEqual(JSON.parse(day.apps), { Minecraft: 60 });
});

test('grant-active counts as usage, exactly as the Client Page counts it', (t) => {
  const db = newDb(t);
  for (let m = 600; m < 610; m++) addPing(db, { daysAgo: 40, minute: m });
  for (let m = 610; m < 615; m++) addPing(db, { daysAgo: 40, minute: m, status: 'grant-active' });
  for (let m = 615; m < 620; m++) addPing(db, { daysAgo: 40, minute: m, status: 'locked' });

  // What the Client Page would have shown for that day, before it was rolled up.
  const onScreen = dailyData(db, 1, db.prepare("SELECT date('now','localtime','-40 days') d").get().d);
  rollUpOldPings(db);

  assert.equal(summary(db)[0].used_minutes, onScreen.totalUsableMinutes);
  assert.equal(summary(db)[0].used_minutes, 15);   // locked is not Usage Time
});

test('off-cadence pings do not inflate a rolled-up day', (t) => {
  const db = newDb(t);
  for (let m = 600; m < 660; m++) addPing(db, { daysAgo: 40, minute: m, app: 'Minecraft' });
  // A redeemed Grant, a settings change and a Lock each send a ping outside the once-a-minute
  // cadence. Counting rows would bank those as extra minutes of use — permanently, since the raw
  // pings are gone after this.
  for (const m of [610, 610, 620, 633]) addPing(db, { daysAgo: 40, minute: m, app: 'Minecraft' });

  rollUpOldPings(db);

  const [day] = summary(db);
  assert.equal(day.used_minutes, 60);
  assert.deepEqual(JSON.parse(day.apps), { Minecraft: 60 });
});

test('longest session survives one dropped ping but not a real gap', (t) => {
  const db = newDb(t);
  for (let m = 600; m < 630; m++) if (m !== 615) addPing(db, { daysAgo: 40, minute: m });  // 10:00–10:29
  for (let m = 700; m < 710; m++) addPing(db, { daysAgo: 40, minute: m });                 // separate 10 min

  rollUpOldPings(db);

  // 30, not 29: the session spanned 10:00 to 10:29 and the one missing report is counted inside it.
  // A lost Ping is a lost minute of evidence, not evidence the kid stopped for a minute.
  assert.equal(summary(db)[0].longest_session_minutes, 30);
});

test('each client and each day gets its own row', (t) => {
  const db = newDb(t);
  addPing(db, { client: 1, daysAgo: 40, minute: 600 });
  addPing(db, { client: 1, daysAgo: 41, minute: 600 });
  addPing(db, { client: 2, daysAgo: 40, minute: 600 });

  const result = rollUpOldPings(db);

  assert.equal(result.days, 3);
  assert.equal(summary(db, 1).length, 2);
  assert.equal(summary(db, 2).length, 1);
});

test('running twice is a no-op the second time', (t) => {
  const db = newDb(t);
  for (let m = 600; m < 620; m++) addPing(db, { daysAgo: 40, minute: m });

  const first = rollUpOldPings(db);
  const second = rollUpOldPings(db);

  assert.equal(first.days, 1);
  assert.deepEqual(second, { days: 0, pingsDeleted: 0 });
  assert.equal(summary(db).length, 1);
  assert.equal(summary(db)[0].used_minutes, 20);
});

test('a day with no usable pings still gets a row rather than vanishing', (t) => {
  const db = newDb(t);
  for (let m = 600; m < 610; m++) addPing(db, { daysAgo: 40, minute: m, status: 'blocked' });

  rollUpOldPings(db);

  const [day] = summary(db);
  assert.equal(day.used_minutes, 0);
  assert.equal(day.blocked_minutes, 10);
  assert.equal(day.apps, null);
  assert.equal(pingCount(db), 0);
});

test('deleting a client takes its summaries with it', (t) => {
  const db = newDb(t);
  addPing(db, { client: 1, daysAgo: 40, minute: 600 });
  rollUpOldPings(db);

  db.prepare('DELETE FROM clients WHERE id = 1').run();

  assert.equal(summary(db, 1).length, 0);
});
