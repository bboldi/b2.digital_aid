import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

// The Foreground App, read live rather than in aggregate. The rule is small and the whole feature is
// in it: show the last Ping's app while the Client is online, and show nothing otherwise — never the
// last one seen. A stale app name is a claim about *now* that nothing supports (CONTEXT.md).

async function newApp(t, { lastApp = null, online = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-nowapp-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false, rollup: false });
  await app.ready();
  app.db.prepare(`INSERT INTO admin (id, username, password_hash, server_key, totp_secret, grant_seed)
                  VALUES (1, 'parent', ?, 'server-key', 'JBSWY3DPEHPK3PXP', ?)`)
    .run(hashPassword('pw'), 'ab'.repeat(32));
  app.db.prepare(
    `INSERT INTO clients (id, name, token_hash, last_seen_at, last_status, last_app)
     VALUES (1, 'Kid PC', 'hash-1', datetime('now'), 'active', ?)`
  ).run(lastApp);
  app.db.prepare('INSERT INTO settings (client_id) VALUES (1)').run();
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  app.hub.isOnline = () => online;

  const login = await app.inject({ method: 'POST', url: '/login', payload: { username: 'parent', password: 'pw' } });
  const cookie = login.cookies.find((c) => c.name === 'session');
  return { app, headers: { cookie: `session=${cookie.value}` } };
}

// The line itself, wherever it is rendered.
const nowApp = (body) => {
  const i = body.indexOf('class="now-app"');
  assert.notEqual(i, -1, 'the page has a now-app line at all');
  return body.slice(body.indexOf('>', i) + 1, body.indexOf('</p>', i)).trim();
};

const surfaces = [
  ['the Clients grid', '/clients/grid'],
  ['the Client Page hero', '/clients/1/header'],
];

for (const [where, url] of surfaces) {
  test(`${where} shows what the PC is in right now`, async (t) => {
    const { app, headers } = await newApp(t, { lastApp: 'Minecraft' });
    const res = await app.inject({ method: 'GET', url, headers });
    assert.equal(res.statusCode, 200);
    assert.equal(nowApp(res.body), 'Minecraft');
  });

  test(`${where} shows no app for a PC that has gone offline`, async (t) => {
    // The column still holds what it last reported — being offline is exactly when it must not be
    // believed, because nothing has confirmed it since.
    const { app, headers } = await newApp(t, { lastApp: 'Minecraft', online: false });
    const res = await app.inject({ method: 'GET', url, headers });
    assert.equal(nowApp(res.body), '–');
    assert.ok(!res.body.includes('Minecraft'), 'the last app seen is not shown as the current one');
  });

  test(`${where} shows no app when the Client reported none`, async (t) => {
    // Locked, blocked, or sitting on the bare desktop: the Client sends null, and null is a fact.
    const { app, headers } = await newApp(t, { lastApp: null });
    const res = await app.inject({ method: 'GET', url, headers });
    assert.equal(nowApp(res.body), '–');
  });

  test(`${where} keeps the line even with nothing to say`, async (t) => {
    // A row that came and went would shift the layout on every poll, which is every few seconds.
    const withApp = await newApp(t, { lastApp: 'Minecraft' });
    const without = await newApp(t, { lastApp: null });
    const a = await withApp.app.inject({ method: 'GET', url, headers: withApp.headers });
    const b = await without.app.inject({ method: 'GET', url, headers: without.headers });
    assert.equal((a.body.match(/class="now-app"/g) ?? []).length, 1);
    assert.equal((b.body.match(/class="now-app"/g) ?? []).length, 1);
  });
}

test('a long app name is truncated in the page, not in the title', async (t) => {
  const long = 'Microsoft Windows Operating System Companion Utility';
  const { app, headers } = await newApp(t, { lastApp: long });
  const res = await app.inject({ method: 'GET', url: '/clients/grid', headers });
  assert.match(res.body, new RegExp(`title="${long}"`));
});
