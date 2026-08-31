import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { build } from '../src/app.js';
import { hashClientToken, hashPassword } from '../src/auth.js';

async function newApp(t, now = () => Date.now()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-report-'));
  const app = build({
    dbFile: path.join(dir, 'test.db'), logger: false, rollup: false, reportLinkNow: now,
  });
  await app.ready();
  app.db.prepare(`INSERT INTO admin (id, username, password_hash, server_key, totp_secret, grant_seed)
                  VALUES (1, 'parent', ?, 'server-key', 'JBSWY3DPEHPK3PXP', ?)`)
    .run(hashPassword('pw'), 'ab'.repeat(32));
  app.db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (1, 'Kid PC', 'client-token-hash')").run();
  app.db.prepare('INSERT INTO settings (client_id, weekday_minutes, weekend_minutes) VALUES (1, 120, 180)').run();
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return app;
}

async function adminCookie(app) {
  const login = await app.inject({
    method: 'POST', url: '/login', payload: { username: 'parent', password: 'pw' },
  });
  return login.cookies.find((cookie) => cookie.name === 'session');
}

test('a report is no longer public, while an Admin session still opens it', async (t) => {
  const app = await newApp(t);

  const anonymous = await app.inject({ method: 'GET', url: '/clients/1/report?days=7' });
  assert.equal(anonymous.statusCode, 200, 'the fragment bootstrap must load before the server sees its token');
  assert.doesNotMatch(anonymous.body, /Usage Report for Kid PC/);

  const denied = await app.inject({
    method: 'POST', url: '/clients/1/report/access?days=7', payload: { token: '' },
  });
  assert.equal(denied.statusCode, 403);
  assert.match(denied.body, /no longer valid/i);

  const session = await adminCookie(app);
  const admin = await app.inject({
    method: 'GET', url: '/clients/1/report?days=7',
    headers: { cookie: `session=${session.value}` },
  });
  assert.equal(admin.statusCode, 200);
  assert.match(admin.body, /Usage Report for Kid PC/);
  assert.equal(admin.headers['cache-control'], 'no-store');
  assert.equal(admin.headers['referrer-policy'], 'no-referrer');
});

test('a fragment token exchanges for a clean, fixed-expiry report cookie', async (t) => {
  let now = Date.UTC(2026, 7, 31, 12);
  const app = await newApp(t, () => now);
  const link = app.reportLinks.issue(1, 30);

  assert.match(link.path, /^\/clients\/1\/report\?days=30#token=[a-f0-9]{64}$/);
  const parsed = new URL(link.path, 'http://server');
  assert.ok(!parsed.search.includes(link.token), 'the token is absent from the HTTP query string');

  const altered = await app.inject({
    method: 'POST', url: '/clients/1/report/access?days=7', payload: { token: link.token },
  });
  assert.equal(altered.statusCode, 403);

  const exchange = await app.inject({
    method: 'POST', url: '/clients/1/report/access?days=30', payload: { token: link.token },
  });
  assert.equal(exchange.statusCode, 303);
  assert.equal(exchange.headers.location, '/clients/1/report?days=30');
  assert.ok(!exchange.headers.location.includes(link.token));
  const access = exchange.cookies.find((cookie) => cookie.name === 'report_1_30');
  assert.ok(access);
  assert.equal(access.httpOnly, true);
  assert.equal(access.sameSite, 'Strict');
  assert.equal(access.path, '/clients/1/report');

  const report = await app.inject({
    method: 'GET', url: exchange.headers.location,
    headers: { cookie: `${access.name}=${access.value}` },
  });
  assert.equal(report.statusCode, 200);
  assert.match(report.body, /Usage Report for Kid PC/);

  const reopened = await app.inject({
    method: 'POST', url: '/clients/1/report/access?days=30', payload: { token: link.token },
  });
  assert.equal(reopened.statusCode, 303, 'the link is reusable during its lifetime');

  now += 30 * 60 * 1000;
  const expiredExchange = await app.inject({
    method: 'POST', url: '/clients/1/report/access?days=30', payload: { token: link.token },
  });
  assert.equal(expiredExchange.statusCode, 403);
  const expired = await app.inject({
    method: 'GET', url: exchange.headers.location,
    headers: { cookie: `${access.name}=${access.value}` },
  });
  assert.equal(expired.statusCode, 200);
  assert.doesNotMatch(expired.body, /Usage Report for Kid PC/);
});

test('Report Links are scoped, independently live, capped, and tied to the current Client credential', async (t) => {
  let now = Date.UTC(2026, 7, 31, 12);
  const app = await newApp(t, () => now);
  const first = app.reportLinks.issue(1, 7);
  const second = app.reportLinks.issue(1, 30);

  assert.ok(app.reportLinks.validate(first.token, 1, 7));
  assert.ok(app.reportLinks.validate(second.token, 1, 30));
  assert.equal(app.reportLinks.validate(first.token, 1, 30), null);
  assert.equal(app.reportLinks.validate(first.token, 2, 7), null);

  const links = [first];
  for (let i = 0; i < 14; i++) {
    now += 1;
    links.push(app.reportLinks.issue(1, 7));
  }
  assert.ok(app.reportLinks.validate(first.token, 1, 7), 'sixteen links may coexist');
  now += 1;
  const seventeenth = app.reportLinks.issue(1, 7);
  assert.equal(app.reportLinks.validate(first.token, 1, 7), null, 'the oldest link is removed at the cap');
  assert.ok(app.reportLinks.validate(seventeenth.token, 1, 7));

  app.db.prepare("UPDATE clients SET token_hash = 'replacement-token-hash' WHERE id = 1").run();
  assert.equal(app.reportLinks.validate(seventeenth.token, 1, 7), null, 're-pairing invalidates links');

  const afterRepair = app.reportLinks.issue(1, 7);
  app.db.prepare('UPDATE clients SET disabled = 1 WHERE id = 1').run();
  assert.ok(app.reportLinks.validate(afterRepair.token, 1, 7), 'pausing enforcement does not invalidate links');
  app.db.prepare("UPDATE clients SET revoked_at = datetime('now') WHERE id = 1").run();
  assert.equal(app.reportLinks.validate(afterRepair.token, 1, 7), null, 'revoking invalidates links');

  app.db.prepare("UPDATE clients SET revoked_at = NULL WHERE id = 1").run();
  const beforeDelete = app.reportLinks.issue(1, 7);
  app.db.prepare('DELETE FROM clients WHERE id = 1').run();
  assert.equal(app.reportLinks.validate(beforeDelete.token, 1, 7), null, 'deleting invalidates links');
});

test('the report average covers every selected calendar day', async (t) => {
  const app = await newApp(t);
  const session = await adminCookie(app);
  app.db.prepare(`INSERT INTO daily_usage
    (client_id, date, used_minutes, blocked_minutes, longest_session_minutes, apps)
    VALUES (1, date('now', 'localtime'), 70, 0, 70, '{}')`).run();

  const report = await app.inject({
    method: 'GET', url: '/clients/1/report?days=7',
    headers: { cookie: `session=${session.value}` },
  });
  assert.match(report.body, /Average usage: 10m \/ day/);
});

test('an authenticated Client requests a scoped link over its WebSocket', async (t) => {
  const app = await newApp(t);
  const clientToken = 'cd'.repeat(32);
  app.db.prepare('UPDATE clients SET token_hash = ? WHERE id = 1').run(hashClientToken(clientToken));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(address.replace(/^http/, 'ws') + '/ws', {
    headers: { 'x-client-token': clientToken },
  });
  t.after(() => socket.close());

  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('report-link response timed out')), 2000);
    socket.on('error', reject);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'hello') {
        clearTimeout(timeout);
        resolve(message);
        return;
      }
      socket.send(JSON.stringify({ type: 'report-link-request', requestId: 'request-42', days: 90 }));
    });
  });

  assert.equal(response.type, 'report-link');
  assert.equal(response.requestId, 'request-42');
  assert.match(response.path, /^\/clients\/1\/report\?days=90#token=[a-f0-9]{64}$/);
});
