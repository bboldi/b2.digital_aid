import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { devices } from '../src/push.js';
import { revealNext } from '../public/settings-history.js';

// The routes an Alert Device uses, driven through the real app so the settings page is actually
// rendered — a template that throws is a 500 on the one page these switches live on.

async function newApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-alert-routes-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false, rollup: false });
  await app.ready();
  app.db.prepare(`INSERT INTO admin (id, username, password_hash, server_key, totp_secret, grant_seed)
                  VALUES (1, 'parent', ?, 'server-key', 'JBSWY3DPEHPK3PXP', ?)`)
    .run(hashPassword('pw'), 'ab'.repeat(32));
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const login = await app.inject({
    method: 'POST', url: '/login',
    payload: { username: 'parent', password: 'pw' },
  });
  const cookie = login.cookies.find((c) => c.name === 'session');
  return { app, headers: { cookie: `session=${cookie.value}` } };
}

const subscription = { endpoint: 'https://push.example/abc', keys: { p256dh: 'key', auth: 'auth' } };

test('the settings page renders the switches and the VAPID key', async (t) => {
  const { app, headers } = await newApp(t);
  const res = await app.inject({ method: 'GET', url: '/settings', headers });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /alerts-device/);
  // The public key has to reach the browser or it cannot subscribe at all.
  const key = app.db.prepare('SELECT vapid_public FROM admin WHERE id = 1').get().vapid_public;
  assert.ok(key);
  assert.match(res.body, new RegExp(key.slice(0, 20)));
});

test('update history opens ten rows at a time', async (t) => {
  const { app, headers } = await newApp(t);
  const insert = app.db.prepare(
    `INSERT INTO updates (version, filename, sha256, size, announced_at)
     VALUES (?, ?, ?, 1000, ?)`
  );
  for (let i = 1; i <= 25; i++) {
    const n = String(i).padStart(2, '0');
    insert.run(`1.0.${n}`, `${n}.exe`, n.repeat(32), `2026-08-${n} 12:00:00`);
  }

  const res = await app.inject({ method: 'GET', url: '/settings', headers });
  assert.equal(res.statusCode, 200);
  assert.equal((res.body.match(/data-update-row/g) ?? []).length, 25);
  assert.equal((res.body.match(/data-update-row hidden/g) ?? []).length, 15);
  assert.match(res.body, /id="updates-more" data-batch="10"/);
  assert.equal((res.body.match(/class="settings-summary-icon"/g) ?? []).length, 7);
  assert.equal((res.body.match(/<article class="span-all">/g) ?? []).length, 7);
  assert.match(res.body, /<article class="always-open span-all">/);

  const rows = Array.from({ length: 25 }, (_, i) => ({ hidden: i >= 10 }));
  assert.equal(revealNext(rows), true);
  assert.equal(rows.filter((row) => row.hidden).length, 5);
  assert.equal(revealNext(rows), false);
  assert.equal(rows.filter((row) => row.hidden).length, 0);
});

test('subscribing and unsubscribing needs a session', async (t) => {
  const { app } = await newApp(t);
  const res = await app.inject({ method: 'POST', url: '/alerts/subscribe', payload: { subscription } });
  assert.equal(res.statusCode, 401);
  assert.equal(devices(app.db).length, 0);
});

test('a browser subscribes, then drops itself', async (t) => {
  const { app, headers } = await newApp(t);

  const on = await app.inject({ method: 'POST', url: '/alerts/subscribe', headers, payload: { subscription, label: 'phone' } });
  assert.equal(on.statusCode, 200);
  assert.equal(devices(app.db).length, 1);

  const off = await app.inject({ method: 'POST', url: '/alerts/unsubscribe', headers, payload: { endpoint: subscription.endpoint } });
  assert.equal(off.statusCode, 200);
  assert.equal(devices(app.db).length, 0);
});

test('a malformed subscription is refused rather than stored', async (t) => {
  const { app, headers } = await newApp(t);
  const res = await app.inject({ method: 'POST', url: '/alerts/subscribe', headers, payload: { subscription: { endpoint: 'x' } } });
  assert.equal(res.statusCode, 400);
  assert.equal(devices(app.db).length, 0);
});

test('the switches are household-wide and an unchecked box means off', async (t) => {
  const { app, headers } = await newApp(t);
  const admin = () => app.db.prepare('SELECT * FROM admin WHERE id = 1').get();

  // Requests start on — it is the one a kid is waiting on. The ambient three start off, so
  // installing the app cannot begin buzzing a phone nobody asked to be buzzed.
  assert.equal(admin().alert_request, 1);
  assert.equal(admin().alert_started, 0);

  await app.inject({ method: 'POST', url: '/alerts/settings', headers, payload: { started: 'on', locked: 'on' } });
  const after = admin();
  // 'request' was not in the payload, and an HTML checkbox that is off sends nothing at all — so
  // absent has to mean off, or the switches would only ever turn on.
  assert.equal(after.alert_request, 0);
  assert.equal(after.alert_started, 1);
  assert.equal(after.alert_locked, 1);
  assert.equal(after.alert_exhausted, 0);
});

test('a Ping with no Alert Devices is still a Ping', async (t) => {
  // The rule the whole feature hangs on: an Alert must never be able to break the thing it reports.
  const { app } = await newApp(t);
  app.db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (1, 'Kid PC', 'h')").run();
  assert.doesNotThrow(() => app.alerts.onPing(1, { status: 'active', reason: 'allowance' }));
  const watch = app.db.prepare('SELECT * FROM alert_watch WHERE client_id = 1').get();
  assert.equal(watch.status, 'active');
});

test('two PCs coming back together suppress each other, one alone does not', async (t) => {
  // The batch is held for a moment precisely so this question can be asked at all — "did more than
  // one machine return at the same moment" cannot be answered one Ping at a time.
  const { app } = await newApp(t);
  app.db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (1, 'Kid PC', 'h1'), (2, 'Other PC', 'h2')").run();

  // Both are first sightings, so both are held as "came on". Flushing is what the timer would do.
  app.alerts.onPing(1, { status: 'active', reason: 'allowance' });
  app.alerts.onPing(2, { status: 'active', reason: 'allowance' });
  assert.deepEqual(app.alerts.flushStarted(), [], 'two together is the network, not the household');

  // One alone travels the same path and is alerted about.
  app.db.prepare('DELETE FROM alert_watch').run();
  app.alerts.onPing(1, { status: 'active', reason: 'allowance' });
  assert.deepEqual(app.alerts.flushStarted(), [1]);
});
