import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/app.js';
import { createSession, hashPassword } from '../src/auth.js';
import { fakeExe } from '../test-support/fake-exe.js';

// The upload route is the one place a build can reach a kid's PC, so its refusals are as much the
// feature as its accepts.

function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-test-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false });

  app.db.prepare(
    `INSERT INTO admin (id, username, password_hash, server_key, totp_secret)
     VALUES (1, 'parent', ?, 'test-server-key', 'AAAAAAAAAAAAAAAA')`
  ).run(hashPassword('irrelevant'));

  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { app, cookie: `session=${createSession('test-server-key')}`, dir };
}

function upload(app, cookie, exe) {
  const boundary = '----digitalaidtest';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="exe"; filename="DigitalAid.exe"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n'
    ),
    exe,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return app.inject({
    method: 'POST',
    url: '/update',
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

const feedback = (res) => decodeURIComponent(res.headers.location.split('?')[1] ?? '');

test('accepts a release build and records the version read from the exe', async (t) => {
  const { app, cookie } = startServer(t);

  const res = await upload(app, cookie, fakeExe('0.2.0'));
  assert.equal(res.statusCode, 302);
  assert.match(feedback(res), /^ok=0\.2\.0 uploaded/);

  const rows = app.db.prepare('SELECT * FROM updates').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, '0.2.0');
  assert.equal(rows[0].filename, `${rows[0].sha256}.exe`);
  assert.ok(rows[0].size > 0);
});

test('refuses a dev build — build.sh output must never reach a Client', async (t) => {
  const { app, cookie, dir } = startServer(t);

  const res = await upload(app, cookie, fakeExe('0.2.0+dev.abc1234'));
  assert.match(feedback(res), /development build/);
  assert.equal(app.db.prepare('SELECT count(*) n FROM updates').get().n, 0);
  // The rejected upload leaves nothing behind on disk.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'updates')), []);
});

test('refuses a file that declares no version', async (t) => {
  const { app, cookie } = startServer(t);

  const res = await upload(app, cookie, Buffer.from('definitely not an exe'));
  assert.match(feedback(res), /declares no version/);
  assert.equal(app.db.prepare('SELECT count(*) n FROM updates').get().n, 0);
});

test('refuses a second build claiming a version that is already released', async (t) => {
  const { app, cookie } = startServer(t);

  await upload(app, cookie, fakeExe('0.2.0'));
  const res = await upload(app, cookie, fakeExe('0.2.0', { filler: 0xab }));   // same version, other bytes

  assert.match(feedback(res), /already uploaded from different bytes/);
  assert.equal(app.db.prepare('SELECT count(*) n FROM updates').get().n, 1);
});

test('re-uploading identical bytes re-announces without duplicating the row', async (t) => {
  const { app, cookie } = startServer(t);

  await upload(app, cookie, fakeExe('0.2.0'));
  const res = await upload(app, cookie, fakeExe('0.2.0'));

  assert.match(feedback(res), /already uploaded — re-announced/);
  assert.equal(app.db.prepare('SELECT count(*) n FROM updates').get().n, 1);
});

test('re-uploading an older release rolls back: it becomes latest again', async (t) => {
  const { app, cookie } = startServer(t);
  const latest = () =>
    app.db.prepare('SELECT version FROM updates ORDER BY announced_at DESC, id DESC LIMIT 1').get().version;

  await upload(app, cookie, fakeExe('0.2.0'));
  await upload(app, cookie, fakeExe('0.3.0'));
  assert.equal(latest(), '0.3.0');

  // 0.3.0 turned out to be bad. Re-uploading the old exe inserts no row — it re-announces the one
  // already stored — so announced_at, not insertion order, is what has to decide "latest". A
  // reconnecting Client is offered 0.2.0 and takes it, because it updates on hash mismatch rather
  // than on version order.
  await upload(app, cookie, fakeExe('0.2.0'));
  assert.equal(latest(), '0.2.0');
  assert.equal(app.db.prepare('SELECT count(*) n FROM updates').get().n, 2);
});

test('an anonymous upload is bounced to the login page', async (t) => {
  const { app } = startServer(t);

  const res = await upload(app, '', fakeExe('0.2.0'));
  assert.equal(res.headers.location, '/login');
  assert.equal(app.db.prepare('SELECT count(*) n FROM updates').get().n, 0);
});
