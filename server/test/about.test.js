import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/app.js';
import { createSession, hashPassword } from '../src/auth.js';
import { BRANDING } from '../src/branding.js';
import { VERSION, PACKAGE_VERSION, IS_DEV_BUILD } from '../src/version.js';

// The About section is the only place the server says what it is, which matters more here than it
// would elsewhere: nothing updates itself (ADR-0011), so "which version am I running" is a question
// a human has to be able to answer before deciding to go and update.

function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-about-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false });

  app.db.prepare(
    `INSERT INTO admin (id, username, password_hash, server_key, totp_secret)
     VALUES (1, 'parent', ?, 'test-server-key', 'AAAAAAAAAAAAAAAA')`
  ).run(hashPassword('irrelevant'));

  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { app, cookie: `session=${createSession('test-server-key')}` };
}

const settings = (app, cookie) =>
  app.inject({ method: 'GET', url: '/settings', headers: { cookie } });

test('the About section names the version, the author and where to find the source', async (t) => {
  const { app, cookie } = startServer(t);

  const res = await settings(app, cookie);

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /About/);
  assert.ok(res.body.includes(VERSION), `expected the running version ${VERSION}`);
  assert.ok(res.body.includes(BRANDING.author));
  assert.ok(res.body.includes(BRANDING.repository));
  assert.ok(res.body.includes(BRANDING.email));
  assert.ok(res.body.includes(BRANDING.website));
});

test('an off-tag tree says so rather than claiming the release', async (t) => {
  const { app, cookie } = startServer(t);

  const res = await settings(app, cookie);

  if (IS_DEV_BUILD) {
    // Which is the normal case while developing: the version carries +dev and the page explains it.
    assert.match(VERSION, /\+dev\./);
    assert.match(res.body, /not the release it claims to be/);
  } else {
    // Cut from a tag: the bare number, and no warning.
    assert.equal(VERSION, PACKAGE_VERSION);
    assert.doesNotMatch(res.body, /not the release it claims to be/);
  }
});

test('About is behind the login, like every other page', async (t) => {
  const { app } = startServer(t);

  const res = await app.inject({ method: 'GET', url: '/settings' });

  // The author's name and a live email address are not for whoever finds the port open.
  assert.equal(res.statusCode, 302);
  assert.ok(!res.body.includes(BRANDING.email));
});
