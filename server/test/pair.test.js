import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticator } from 'otplib';
import { build } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

// Pairing used to create a Client every time, unconditionally, which turned an ordinary accident —
// a lost state file — into permanent data loss (ADR-0008). These pin the replacement: a known
// machine is offered its own Client back, the offer is never taken without being asked for, and
// being recognised is never on its own enough to take one over.

const SECRET = 'AAAAAAAAAAAAAAAA';
const code = () => authenticator.generate(SECRET);

function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-pair-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false });
  app.db.prepare(
    `INSERT INTO admin (id, username, password_hash, server_key, totp_secret)
     VALUES (1, 'parent', ?, 'test-server-key', ?)`
  ).run(hashPassword('irrelevant'), SECRET);
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return app;
}

const pair = (app, payload) =>
  app.inject({ method: 'POST', url: '/api/pair', payload: { code: code(), ...payload } });

test('a machine the server has never seen pairs as a new client', async (t) => {
  const app = startServer(t);
  const res = await pair(app, { name: 'Kid PC', machineId: 'machine-a' });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.token);
  assert.equal(body.adopted, undefined);
  assert.equal(app.db.prepare('SELECT count(*) n FROM clients').get().n, 1);
});

test('a machine the server knows is offered its own client back, not given it', async (t) => {
  const app = startServer(t);
  const first = (await pair(app, { name: 'Kid PC', machineId: 'machine-a' })).json();

  // Same machine, state file gone: the second pairing answers with a question, not a token.
  const res = await pair(app, { name: 'Kid PC', machineId: 'machine-a' });
  const body = res.json();

  assert.equal(body.token, undefined, 'nothing is handed over until someone says yes');
  assert.equal(body.match.clientId, first.clientId);
  assert.equal(body.match.name, 'Kid PC');
  assert.equal(app.db.prepare('SELECT count(*) n FROM clients').get().n, 1);
});

test('accepting the offer reissues the token onto the existing client', async (t) => {
  const app = startServer(t);
  const first = (await pair(app, { name: 'Kid PC', machineId: 'machine-a' })).json();
  app.db.prepare("UPDATE clients SET name = 'Renamed by parent' WHERE id = ?").run(first.clientId);

  const adopted = (await pair(app, { name: 'Kid PC', machineId: 'machine-a', adopt: first.clientId })).json();

  assert.equal(adopted.clientId, first.clientId);
  assert.equal(adopted.adopted, true);
  assert.equal(app.db.prepare('SELECT count(*) n FROM clients').get().n, 1);
  // The admin's name for the PC survives — keeping it is half the point of adopting at all.
  assert.equal(app.db.prepare('SELECT name FROM clients WHERE id = ?').get(first.clientId).name,
    'Renamed by parent');
  // The old token is gone, not merely joined by a second one.
  assert.notEqual(adopted.token, first.token);
  assert.equal(app.db.prepare('SELECT count(*) n FROM clients WHERE token_hash IS NOT NULL').get().n, 1);
});

test('declining the offer sets up a genuinely separate client', async (t) => {
  const app = startServer(t);
  await pair(app, { name: 'Kid PC', machineId: 'machine-a' });
  const fresh = (await pair(app, { name: 'Second PC', machineId: 'machine-a', adopt: false })).json();

  assert.ok(fresh.token);
  assert.equal(app.db.prepare('SELECT count(*) n FROM clients').get().n, 2);
});

test('a machine id is not a credential — it takes a valid code either way', async (t) => {
  const app = startServer(t);
  const first = (await pair(app, { name: 'Kid PC', machineId: 'machine-a' })).json();

  const res = await app.inject({
    method: 'POST', url: '/api/pair',
    payload: { code: '000000', name: 'Kid PC', machineId: 'machine-a', adopt: first.clientId },
  });
  assert.equal(res.statusCode, 401);
});

test('a client can only claim the client its own machine id names', async (t) => {
  const app = startServer(t);
  const victim = (await pair(app, { name: 'Sibling PC', machineId: 'machine-a' })).json();

  // A different machine, holding a valid code, naming someone else's Client.
  const res = await pair(app, { name: 'Other PC', machineId: 'machine-b', adopt: victim.clientId });
  assert.equal(res.statusCode, 409);
});

test('a revoked client is never offered back', async (t) => {
  const app = startServer(t);
  const first = (await pair(app, { name: 'Kid PC', machineId: 'machine-a' })).json();
  app.db.prepare("UPDATE clients SET revoked_at = datetime('now') WHERE id = ?").run(first.clientId);

  const body = (await pair(app, { name: 'Kid PC', machineId: 'machine-a' })).json();
  assert.equal(body.match, undefined);
  assert.ok(body.token);
  assert.equal(app.db.prepare('SELECT count(*) n FROM clients').get().n, 2);
});

test('a client that sends no machine id pairs exactly as it always did', async (t) => {
  const app = startServer(t);
  await pair(app, { name: 'Old Client' });
  const second = (await pair(app, { name: 'Old Client' })).json();

  assert.ok(second.token);
  assert.equal(app.db.prepare('SELECT count(*) n FROM clients').get().n, 2);
});
