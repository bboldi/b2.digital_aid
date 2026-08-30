import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

// The Requests page holds two different things: an open queue, which is live work, and a history,
// which is kept forever and read by paging back through it. The tests here are mostly about keeping
// them apart — the failure that matters is a Request expiring in ten minutes hidden behind a pager.

async function newApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-reqpage-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false, rollup: false });
  await app.ready();
  app.db.prepare(`INSERT INTO admin (id, username, password_hash, server_key, totp_secret, grant_seed)
                  VALUES (1, 'parent', ?, 'server-key', 'JBSWY3DPEHPK3PXP', ?)`)
    .run(hashPassword('pw'), 'ab'.repeat(32));
  app.db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (1, 'Kid PC', 'hash-1')").run();
  app.db.prepare('INSERT INTO settings (client_id) VALUES (1)').run();
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const login = await app.inject({ method: 'POST', url: '/login', payload: { username: 'parent', password: 'pw' } });
  const cookie = login.cookies.find((c) => c.name === 'session');
  return { app, headers: { cookie: `session=${cookie.value}` } };
}

// `n` answered Requests, one a day going back from today, so the date headings have something to do.
// Each asks for a different number of minutes, which makes a row identifiable in the rendered page —
// the tests below care *which* rows a page shows, not just how many.
function seedHistory(app, n, from = 1) {
  const insert = app.db.prepare(
    `INSERT INTO requests (client_id, asked_minutes, state, granted_minutes, created_at, expires_at, decided_at)
     VALUES (1, ?, 'approved', ?, datetime('now', ?), datetime('now'), datetime('now'))`
  );
  for (let i = n - 1; i >= 0; i--) insert.run(from + i, from + i, `-${i} days`);
}

const openAsk = (app) => app.db.prepare(
  `INSERT INTO requests (client_id, asked_minutes, state, expires_at)
   VALUES (1, 45, 'open', datetime('now', '+60 minutes'))`
).run().lastInsertRowid;

const get = (app, headers, url) => app.inject({ method: 'GET', url, headers });
const cursorOf = (body, rel) => {
  const m = body.match(new RegExp(`href="/requests\\?(before|after)=(\\d+)" rel="${rel}"`));
  return m ? Number(m[2]) : null;
};
// Which rows a page is showing, in page order — identified by the minutes asked, which seedHistory
// makes unique.
const historyRows = (body) => [...body.matchAll(/<td>asked (\d+) min<\/td>/g)].map((m) => Number(m[1]));

test('the newest page shows fifty answered Requests and offers only Older', async (t) => {
  const { app, headers } = await newApp(t);
  seedHistory(app, 120);
  const res = await get(app, headers, '/requests');

  assert.equal(res.statusCode, 200);
  assert.equal(historyRows(res.body).length, 50);
  assert.ok(cursorOf(res.body, 'next'), 'there is an Older link');
  assert.equal(cursorOf(res.body, 'prev'), null, 'nothing is newer than the newest page');
});

test('paging older and back again lands on the same rows', async (t) => {
  const { app, headers } = await newApp(t);
  seedHistory(app, 120);

  const first = await get(app, headers, '/requests');
  const older = await get(app, headers, `/requests?before=${cursorOf(first.body, 'next')}`);
  assert.equal(historyRows(older.body).length, 50);
  assert.ok(cursorOf(older.body, 'prev'), 'a paged-back view offers Newer');

  const back = await get(app, headers, `/requests?after=${cursorOf(older.body, 'prev')}`);
  assert.deepEqual(historyRows(back.body), historyRows(first.body));
});

test('a Request arriving mid-read does not shift the page under the reader', async (t) => {
  // The whole reason the cursor is an id and not an offset: a new row at the top of a newest-first
  // list moves every offset down one, so an offset page two would repeat a row page one had already
  // shown and skip the one at the bottom. A keyset page two cannot, because it is anchored to a row.
  const { app, headers } = await newApp(t);
  seedHistory(app, 120);

  const first = await get(app, headers, '/requests');
  const seen = historyRows(first.body);
  const cursor = cursorOf(first.body, 'next');

  seedHistory(app, 1, 500);   // answered while the parent was reading

  const older = await get(app, headers, `/requests?before=${cursor}`);
  const rows = historyRows(older.body);

  assert.equal(rows.length, 50);
  assert.equal(rows.filter((r) => seen.includes(r)).length, 0, 'page two repeats nothing from page one');
  assert.equal(Math.min(...rows), Math.max(...seen) + 1, 'and skips nothing between them');
  assert.ok(!rows.includes(500), 'the row that arrived mid-read belongs at the top, not here');
});

test('the last page offers Newer and no Older', async (t) => {
  const { app, headers } = await newApp(t);
  seedHistory(app, 60);
  const first = await get(app, headers, '/requests');
  const last = await get(app, headers, `/requests?before=${cursorOf(first.body, 'next')}`);

  assert.equal(historyRows(last.body).length, 10);
  assert.equal(cursorOf(last.body, 'next'), null, 'nothing is older than the last page');
  assert.ok(cursorOf(last.body, 'prev'));
});

test('an open Request is answerable from any page of the history', async (t) => {
  // The failure this exists to catch: a live ask with ten minutes left, hidden behind a pager.
  const { app, headers } = await newApp(t);
  seedHistory(app, 120);
  const id = openAsk(app);

  const first = await get(app, headers, '/requests');
  const older = await get(app, headers, `/requests?before=${cursorOf(first.body, 'next')}`);
  for (const res of [first, older]) {
    assert.match(res.body, new RegExp(`action="/requests/${id}/decide"`));
  }
});

test('the live fragment carries the open queue and none of the history', async (t) => {
  // It is polled every fifteen seconds; sending fifty rows of history with each poll would be work
  // done to redraw something that has not changed since it was answered.
  const { app, headers } = await newApp(t);
  seedHistory(app, 120);
  openAsk(app);

  const res = await get(app, headers, '/requests/list');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /class="decide"/);
  assert.ok(!res.body.includes('past-requests'), 'no history table');
  assert.ok(!res.body.includes('class="pager"'), 'no pager');
});

test('history rows sit under the date they were asked on', async (t) => {
  const { app, headers } = await newApp(t);
  seedHistory(app, 3);
  const res = await get(app, headers, '/requests');

  const headings = [...res.body.matchAll(/class="day-head">([^<]+)</g)].map((m) => m[1]);
  assert.equal(headings.length, 3, 'one heading per day, in page order');
  assert.deepEqual([...headings].sort().reverse(), headings, 'newest day first');
  for (const h of headings) assert.match(h, /^\d{4}-\d{2}-\d{2}$/);
});

test('with nothing answered yet the history says so instead of showing a pager', async (t) => {
  const { app, headers } = await newApp(t);
  openAsk(app);
  const res = await get(app, headers, '/requests');

  assert.ok(!res.body.includes('past-requests'));
  assert.ok(!res.body.includes('class="pager"'));
  assert.match(res.body, /No answered Requests yet/);
});

test('a lapsed Request is kept on the same footing as a refused one', async (t) => {
  const { app, headers } = await newApp(t);
  app.db.prepare(
    `INSERT INTO requests (client_id, asked_minutes, state, created_at, expires_at)
     VALUES (1, 30, 'lapsed', datetime('now'), datetime('now', '-1 hour'))`
  ).run();
  const res = await get(app, headers, '/requests');
  assert.equal(historyRows(res.body).length, 1);
  assert.match(res.body, /nobody answered in time/);
});

test('a nonsense cursor reads as no cursor rather than an error', async (t) => {
  const { app, headers } = await newApp(t);
  seedHistory(app, 5);
  for (const q of ['?before=abc', '?after=-1', '?before=', '?before=9999999']) {
    const res = await get(app, headers, `/requests${q}`);
    assert.equal(res.statusCode, 200, q);
  }
});
