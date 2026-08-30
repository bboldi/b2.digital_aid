import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

test('reporting clients are listed before offline clients', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-client-order-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false, rollup: false });
  await app.ready();
  app.db.prepare(`INSERT INTO admin (id, username, password_hash, server_key, totp_secret, grant_seed)
                  VALUES (1, 'parent', ?, 'server-key', 'JBSWY3DPEHPK3PXP', ?)`)
    .run(hashPassword('pw'), 'ab'.repeat(32));
  const add = app.db.prepare('INSERT INTO clients (name, token_hash) VALUES (?, ?)');
  for (const [name, token] of [['Alpha Offline', 'a'], ['Zulu Online', 'z'], ['Beta Offline', 'b']]) {
    const id = Number(add.run(name, token).lastInsertRowid);
    app.db.prepare('INSERT INTO settings (client_id) VALUES (?)').run(id);
  }
  app.hub.isOnline = (id) => id === 2;
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const login = await app.inject({ method: 'POST', url: '/login', payload: { username: 'parent', password: 'pw' } });
  const session = login.cookies.find((cookie) => cookie.name === 'session');
  const res = await app.inject({ method: 'GET', url: '/clients', headers: { cookie: `session=${session.value}` } });

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.indexOf('Zulu Online') < res.body.indexOf('Alpha Offline'));
  assert.ok(res.body.indexOf('Alpha Offline') < res.body.indexOf('Beta Offline'));
  assert.match(res.body, /id="theme-toggle"/);
  assert.match(res.body, /\/public\/theme\.js\?v=/);
});
