import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/app.js';
import { hashPassword, createSession } from '../src/auth.js';
import { assetUrl, swAssets, SHELL } from '../src/assets.js';

// Cache busting. The failure this replaces was quiet and total: a CSS change rendered stale exactly
// once on every device, because the service worker serves /public/ cache-first, and stayed stale for
// good if anyone forgot to bump a hand-written cache name.

function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-assets-'));
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

test('every shell asset gets a version', () => {
  for (const asset of SHELL) assert.match(assetUrl(asset), /\?v=[0-9a-f]{10}$/, asset);
});

test('an edit changes the URL and the cache name', () => {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'style.css');
  const original = fs.readFileSync(file);
  const before = { url: assetUrl('/public/style.css'), version: swAssets().version };

  try {
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n/* edit */\n')]));
    const after = { url: assetUrl('/public/style.css'), version: swAssets().version };
    // The whole mechanism: changed bytes are a different URL, so the worker's cache-first lookup
    // misses and fetches, with nobody having had to remember anything.
    assert.notEqual(after.url, before.url);
    // And the cache name moves with it, which is what makes `activate` sweep the previous one.
    assert.notEqual(after.version, before.version);
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('the hash follows content, not mtime alone', () => {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'style.css');
  const original = fs.readFileSync(file);
  const before = assetUrl('/public/style.css');
  // Rewriting identical bytes moves mtime. The URL must not move with it, or every deploy would
  // invalidate every asset and the offline shell would be refetched for nothing.
  fs.writeFileSync(file, original);
  assert.equal(assetUrl('/public/style.css'), before);
});

test('a missing or escaping path degrades instead of throwing', () => {
  // A missing stylesheet should render a plain page, not 500 every route at once.
  assert.equal(assetUrl('/public/nope.css'), '/public/nope.css');
  assert.equal(assetUrl('/public/../src/db.js'), '/public/../src/db.js');
});

test('the layout emits versioned URLs', async (t) => {
  const { app, cookie } = startServer(t);
  const body = (await app.inject({ method: 'GET', url: '/clients', headers: { cookie } })).body;
  assert.match(body, /\/public\/style\.css\?v=[0-9a-f]{10}/);
  assert.match(body, /\/public\/live\.js\?v=[0-9a-f]{10}/);
});

test('sw.js arrives substituted, not with its placeholder', async (t) => {
  const { app } = startServer(t);
  const res = await app.inject({ method: 'GET', url: '/sw.js' });

  assert.doesNotMatch(res.body, /__ASSETS__/);
  assert.match(res.body, /\/public\/style\.css\?v=[0-9a-f]{10}/);
  // Served no-cache, or a cached worker would keep the old cache name and defeat all of this.
  assert.match(res.headers['cache-control'], /no-cache/);

  // The offline fallback is looked up by the URL it was cached under. A bare path here would miss,
  // and the one screen that must survive a dead server would fall back to nothing.
  const assets = JSON.parse(res.body.match(/const ASSETS = (\{.*?\});/s)[1]);
  assert.ok(assets.shell.includes(assets.offline));
});
