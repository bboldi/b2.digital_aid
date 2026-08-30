import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { translate } from '../src/i18n.js';

// The Quick actions panel, and the confirmations behind it. Both exist for the same reason: a live
// command travels down a WebSocket and leaves nothing on the page to prove it happened, so a parent
// who hits Lock and puts the phone away has only the redirect to go on.

async function newApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-quick-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false, rollup: false });
  await app.ready();
  app.db.prepare(`INSERT INTO admin (id, username, password_hash, server_key, totp_secret, grant_seed)
                  VALUES (1, 'parent', ?, 'server-key', 'JBSWY3DPEHPK3PXP', ?)`)
    .run(hashPassword('pw'), 'ab'.repeat(32));
  app.db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (1, 'Kid PC', 'hash-1')").run();
  app.db.prepare("INSERT INTO settings (client_id) VALUES (1)").run();
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const login = await app.inject({ method: 'POST', url: '/login', payload: { username: 'parent', password: 'pw' } });
  const cookie = login.cookies.find((c) => c.name === 'session');

  // What the Client was told, in order. The real hub needs a socket; these tests only care that the
  // command was sent and that the parent was told so.
  const sent = [];
  app.hub.send = (id, message) => { sent.push({ id, ...message }); return true; };

  return { app, sent, headers: { cookie: `session=${cookie.value}` } };
}

const post = (app, headers, url, payload) => app.inject({ method: 'POST', url, headers, payload });

// The confirmation travels as text in the query string, so the assertion reads the catalogue rather
// than repeating the wording — a reworded string should not fail this.
const okOf = (res) => new URL(res.headers.location, 'http://x').searchParams.get('ok');

test('the panel offers the household presets, above the day card', async (t) => {
  const { app, headers } = await newApp(t);
  const res = await app.inject({ method: 'GET', url: '/clients/1', headers });

  assert.equal(res.statusCode, 200);
  // The presets live in the Give time dialog the panel's button opens.
  const panel = res.body.slice(res.body.indexOf('id="dlg-give"'), res.body.indexOf('</dialog>', res.body.indexOf('id="dlg-give"')));
  for (const m of [10, 15, 30, 45, 60]) assert.match(panel, new RegExp(`value="${m}"`));
  assert.ok(!/value="20"/.test(panel) && !/value="40"/.test(panel), 'presets are the same five the code page offers');

  // Placement is the feature: a panel below the timeline is not a quick action.
  assert.ok(res.body.indexOf('class="quick"') < res.body.indexOf('class="timeline"'));
  assert.match(res.body, /class="columns client-tools"/);
  assert.equal((res.body.match(/class="client-summary-icon"/g) ?? []).length, 4);
});

test('giving time says how much was given', async (t) => {
  const { app, sent, headers } = await newApp(t);
  const res = await post(app, headers, '/clients/1/adjust', { minutes: '30' });

  assert.deepEqual(sent, [{ id: 1, type: 'adjust', minutes: 30 }]);
  assert.equal(okOf(res), translate('en', 'ok.timeGiven', [30]));
});

test('taking time away does not claim to have given it', async (t) => {
  const { app, headers } = await newApp(t);
  // Same handler as the panel, driven from the +/- box in Actions. It reports the same number the
  // Admin typed, without its sign — the wording carries the direction.
  const res = await post(app, headers, '/clients/1/adjust', { minutes: '-20' });

  assert.equal(okOf(res), translate('en', 'ok.timeTaken', [20]));
});

test('a message and a lock confirm too, and lock names the command it sent', async (t) => {
  const { app, sent, headers } = await newApp(t);

  const msg = await post(app, headers, '/clients/1/message', { text: 'Dinner in 10 minutes!' });
  assert.equal(okOf(msg), translate('en', 'ok.messageSent'));

  const lock = await post(app, headers, '/clients/1/lock');
  assert.equal(okOf(lock), translate('en', 'ok.lockSent'));

  // The Client reporting itself locked is what turns the button into Unlock — and what makes the
  // next press send the opposite command.
  app.db.prepare("UPDATE clients SET last_reason = 'locked' WHERE id = 1").run();
  const unlock = await post(app, headers, '/clients/1/lock');
  assert.equal(okOf(unlock), translate('en', 'ok.unlockSent'));

  assert.deepEqual(sent.map((m) => m.type), ['message', 'lock', 'unlock']);
});

test('nothing to send is not something to confirm', async (t) => {
  const { app, sent, headers } = await newApp(t);
  // A blank message and a zero adjustment reach no Client, so claiming they did would be the one
  // failure a confirmation must not have.
  const blank = await post(app, headers, '/clients/1/message', { text: '   ' });
  const zero = await post(app, headers, '/clients/1/adjust', { minutes: '0' });

  assert.deepEqual(sent, []);
  assert.equal(okOf(blank), null);
  assert.equal(okOf(zero), null);
});

test('the page shows the confirmation it was handed', async (t) => {
  const { app, headers } = await newApp(t);
  const ok = translate('en', 'ok.timeGiven', [30]);
  const res = await app.inject({ method: 'GET', url: `/clients/1?ok=${encodeURIComponent(ok)}`, headers });

  assert.match(res.body, new RegExp(`<p class="ok">${ok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p>`));
  // Above the panel, not below the fold.
  assert.ok(res.body.indexOf('class="ok"') < res.body.indexOf('class="quick"'));
});
