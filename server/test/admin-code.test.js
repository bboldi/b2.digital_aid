import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticator } from 'otplib';
import { build } from '../src/app.js';
import { createSession, hashPassword, hashClientToken } from '../src/auth.js';

// A newly generated Admin Code is provisional until someone proves they can produce a code from it
// (ADR-0010). The point is not diligence theatre: clients verify the Admin Code offline, so the
// parent is the only half that cannot, and the night they need it is the night this server is most
// likely to be unreachable. A secret that only ever lived in this database is one nobody has.

function startServer(t, { setUp = true, secret = 'AAAAAAAAAAAAAAAA' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-code-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false });
  if (setUp) {
    app.db.prepare(
      `INSERT INTO admin (id, username, password_hash, server_key, totp_secret, grant_seed,
                          admin_code_confirmed)
       VALUES (1, 'parent', ?, 'test-server-key', ?, 'seed-old', 1)`
    ).run(hashPassword('pw'), secret);
  }
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, cookie: `session=${createSession('test-server-key')}`, dir };
}

const admin = (app) => app.db.prepare('SELECT * FROM admin WHERE id = 1').get();
const post = (app, cookie, url, payload) =>
  app.inject({ method: 'POST', url, headers: { cookie }, payload });

// --- Regeneration ------------------------------------------------------------------------------

test('regenerating stages a new code without disturbing the one in force', async (t) => {
  const { app, cookie } = startServer(t);
  const before = admin(app);

  const res = await post(app, cookie, '/family-code/regenerate', {});

  assert.equal(res.headers.location, '/admin-code/confirm');
  const after = admin(app);
  assert.equal(after.totp_secret, before.totp_secret, 'the live code is untouched');
  assert.equal(after.grant_seed, before.grant_seed);
  assert.ok(after.pending_totp_secret, 'the new one is waiting');
  assert.notEqual(after.pending_totp_secret, before.totp_secret);
});

test('a closed tab leaves the household exactly as it was', async (t) => {
  const { app, cookie } = startServer(t);
  const before = admin(app);
  await post(app, cookie, '/family-code/regenerate', {});

  // Nobody confirms. Nothing has changed, and — the part that matters — no Client was ever told
  // about a secret that might never be proven.
  assert.equal(admin(app).totp_secret, before.totp_secret);
});

test('confirming with a valid code promotes the pending pair', async (t) => {
  const { app, cookie } = startServer(t);
  await post(app, cookie, '/family-code/regenerate', {});
  const pending = admin(app).pending_totp_secret;

  const res = await post(app, cookie, '/admin-code/confirm',
    { code: authenticator.generate(pending) });

  assert.match(res.headers.location, /^\/family-code\?ok=/);
  const after = admin(app);
  assert.equal(after.totp_secret, pending);
  assert.equal(after.admin_code_confirmed, 1);
  assert.equal(after.pending_totp_secret, null, 'nothing left staged');
});

test('a wrong code changes nothing and says why', async (t) => {
  const { app, cookie } = startServer(t);
  const before = admin(app);
  await post(app, cookie, '/family-code/regenerate', {});

  const res = await post(app, cookie, '/admin-code/confirm', { code: '000000' });

  assert.equal(res.statusCode, 200, 're-rendered, not redirected');
  assert.match(res.body, /clock is set automatically/, 'names the failure that looks like a bug');
  assert.equal(admin(app).totp_secret, before.totp_secret);
  assert.ok(admin(app).pending_totp_secret, 'still staged, so they can try again');
});

test('cancelling keeps the current code', async (t) => {
  const { app, cookie } = startServer(t);
  const before = admin(app);
  await post(app, cookie, '/family-code/regenerate', {});

  await post(app, cookie, '/admin-code/cancel', {});

  const after = admin(app);
  assert.equal(after.totp_secret, before.totp_secret);
  assert.equal(after.pending_totp_secret, null);
});

// --- Skipping ----------------------------------------------------------------------------------

test('skipping needs the acknowledgement, not just the button', async (t) => {
  const { app, cookie } = startServer(t);
  await post(app, cookie, '/family-code/regenerate', {});
  const pending = admin(app).pending_totp_secret;

  const res = await post(app, cookie, '/admin-code/confirm', { skip: '1' });

  assert.equal(res.statusCode, 200);
  assert.equal(admin(app).pending_totp_secret, pending, 'still staged');
});

test('an acknowledged skip activates the code and records that nobody proved it', async (t) => {
  const { app, cookie } = startServer(t);
  await post(app, cookie, '/family-code/regenerate', {});
  const pending = admin(app).pending_totp_secret;

  await post(app, cookie, '/admin-code/confirm', { skip: '1', acknowledged: '1' });

  const after = admin(app);
  assert.equal(after.totp_secret, pending, 'it really is in force');
  assert.equal(after.admin_code_confirmed, 0, 'and it really is unproven');
});

test('the codes page keeps saying so, and offers the way back', async (t) => {
  const { app, cookie } = startServer(t);
  await post(app, cookie, '/family-code/regenerate', {});
  await post(app, cookie, '/admin-code/confirm', { skip: '1', acknowledged: '1' });

  const page = await app.inject({ method: 'GET', url: '/family-code', headers: { cookie } });
  assert.match(page.body, /Nobody has proved this Admin Code/);

  await post(app, cookie, '/admin-code/prove',
    { code: authenticator.generate(admin(app).totp_secret) });

  assert.equal(admin(app).admin_code_confirmed, 1);
  const cleared = await app.inject({ method: 'GET', url: '/family-code', headers: { cookie } });
  assert.doesNotMatch(cleared.body, /Nobody has proved this Admin Code/);
});

// --- First run ---------------------------------------------------------------------------------

test('setting up leaves no admin code in force until it is confirmed', async (t) => {
  const { app } = startServer(t, { setUp: false });

  const res = await app.inject({
    method: 'POST', url: '/setup',
    payload: { username: 'parent', password: 'pw', password2: 'pw' },
  });

  assert.equal(res.headers.location, '/admin-code/confirm');
  const row = admin(app);
  assert.equal(row.totp_secret, '', 'nothing in force');
  assert.ok(row.pending_totp_secret, 'but something waiting');
});

test('an unfinished setup cannot be paired to, and cannot be walked away from', async (t) => {
  const { app } = startServer(t, { setUp: false });
  const res = await app.inject({
    method: 'POST', url: '/setup',
    payload: { username: 'parent', password: 'pw', password2: 'pw' },
  });
  const cookie = res.headers['set-cookie'].split(';')[0];
  const pending = admin(app).pending_totp_secret;

  // A PC cannot attach to a server whose Admin Code is still provisional — including one holding a
  // code derived from the pending secret, which is not in force and verifies nothing.
  const pairing = await app.inject({
    method: 'POST', url: '/api/pair',
    payload: { code: authenticator.generate(pending), name: 'Kid PC' },
  });
  assert.equal(pairing.statusCode, 503);

  // And every admin page sends them back to finish, which is how a closed tab recovers.
  const clients = await app.inject({ method: 'GET', url: '/clients', headers: { cookie } });
  assert.equal(clients.headers.location, '/admin-code/confirm');

  await post(app, cookie, '/admin-code/confirm', { code: authenticator.generate(pending) });

  const now = await app.inject({ method: 'GET', url: '/clients', headers: { cookie } });
  assert.equal(now.statusCode, 200, 'and the server works once it is settled');
});

test('starting over on first run replaces the provisional code', async (t) => {
  const { app } = startServer(t, { setUp: false });
  const res = await app.inject({
    method: 'POST', url: '/setup',
    payload: { username: 'parent', password: 'pw', password2: 'pw' },
  });
  const cookie = res.headers['set-cookie'].split(';')[0];
  const first = admin(app).pending_totp_secret;

  await post(app, cookie, '/admin-code/restart', {});

  assert.notEqual(admin(app).pending_totp_secret, first);
  assert.equal(admin(app).totp_secret, '', 'still nothing in force');
});

// --- Clients -----------------------------------------------------------------------------------

test('clients are told about a new secret only once it is settled', async (t) => {
  const { app, cookie } = startServer(t);
  app.db.prepare('INSERT INTO clients (id, name, token_hash) VALUES (1, ?, ?)')
    .run('Kid PC', hashClientToken('token-one'));

  const sent = [];
  app.hub.send = (id, msg) => { sent.push(msg.type); return true; };
  app.hub.sockets = new Map([[1, {}]]);

  await post(app, cookie, '/family-code/regenerate', {});
  assert.deepEqual(sent, [], 'a provisional secret is nobody else’s business');

  await post(app, cookie, '/admin-code/confirm',
    { code: authenticator.generate(admin(app).pending_totp_secret) });
  assert.deepEqual(sent, ['family-code-secret', 'grant-seed']);
});

test('the codes poll refuses rather than throwing while setup is unfinished', async (t) => {
  const { app } = startServer(t, { setUp: false });
  const res = await app.inject({
    method: 'POST', url: '/setup',
    payload: { username: 'parent', password: 'pw', password2: 'pw' },
  });
  const cookie = res.headers['set-cookie'].split(';')[0];

  // A cached Codes page in a service worker keeps polling this, and it is not behind the redirect
  // that covers the ordinary pages.
  const poll = await app.inject({
    method: 'GET', url: '/family-code/current?minutes=15', headers: { cookie },
  });
  assert.equal(poll.statusCode, 503, 'not a 500 from generating a code with no secret');
});
