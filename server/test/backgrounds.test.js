import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/app.js';
import { createSession, hashPassword, hashClientToken } from '../src/auth.js';
import { forClient, resolve, sniff, GLOBAL } from '../src/backgrounds.js';

// A Block Screen Background resolves per slot — this PC's, else the household's, else nothing — and
// the whole feature is only as good as that chain being right. The format check earns its own tests
// because the failure it prevents is silent: WPF cannot decode WebP or HEIC, so a wrong file would
// reach every PC and simply draw nothing, with no error anywhere.

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);

function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-bg-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false });
  app.db.prepare(
    `INSERT INTO admin (id, username, password_hash, server_key, totp_secret)
     VALUES (1, 'parent', ?, 'test-server-key', 'AAAAAAAAAAAAAAAA')`
  ).run(hashPassword('irrelevant'));
  app.db.prepare('INSERT INTO clients (id, name, token_hash) VALUES (1, ?, ?), (2, ?, ?)')
    .run('Kid PC', hashClientToken('token-one'), 'Other PC', hashClientToken('token-two'));
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, cookie: `session=${createSession('test-server-key')}`, dir };
}

function upload(app, cookie, scope, slot, bytes, filename = 'pic.jpg') {
  const boundary = '----digitalaidbg';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n'
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST', url: `/background/${scope}/${slot}`, headers: {
      cookie, 'content-type': `multipart/form-data; boundary=${boundary}`,
    }, payload: body,
  });
}

// --- Format ------------------------------------------------------------------------------------

test('the format is decided by the bytes, not the name', () => {
  assert.equal(sniff(JPEG), 'jpg');
  assert.equal(sniff(PNG), 'png');
  assert.equal(sniff(WEBP), null);
  assert.equal(sniff(Buffer.alloc(0)), null);
});

test('a webp named .jpg is refused', async (t) => {
  const { app, cookie } = startServer(t);
  const res = await upload(app, cookie, 'global', 'blocked', WEBP, 'sneaky.jpg');

  assert.equal(res.statusCode, 302);
  assert.match(decodeURIComponent(res.headers.location), /JPEG and PNG/);
  assert.equal(resolve(app.db, 1, 'blocked'), null, 'nothing was stored');
});

test('an oversized image is refused, and refused loudly', async (t) => {
  const { app, cookie } = startServer(t);
  // Just over 8 MB of otherwise-valid JPEG. There is no image library here to shrink it, so whatever
  // is accepted is what every PC downloads and decodes.
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8 * 1024 * 1024, 3)]);
  const res = await upload(app, cookie, 'global', 'blocked', huge);

  assert.equal(res.statusCode, 302);
  assert.match(decodeURIComponent(res.headers.location), /over 8 MB/);
  assert.equal(resolve(app.db, 1, 'blocked'), null);
});

test('an empty upload changes nothing', async (t) => {
  const { app, cookie } = startServer(t);
  await upload(app, cookie, 'global', 'blocked', JPEG);
  const before = resolve(app.db, 1, 'blocked').sha256;

  await upload(app, cookie, 'global', 'blocked', Buffer.alloc(0));
  assert.equal(resolve(app.db, 1, 'blocked').sha256, before);
});

// --- Resolution --------------------------------------------------------------------------------

test('with nothing set, a client is told there is no background', async (t) => {
  const { app } = startServer(t);
  assert.deepEqual(forClient(app.db, 1), { blocked: null, downtime: null });
});

test('the household image reaches every client that has not overridden it', async (t) => {
  const { app, cookie } = startServer(t);
  await upload(app, cookie, 'global', 'blocked', JPEG);

  for (const id of [1, 2]) {
    assert.equal(forClient(app.db, id).blocked.path, '/api/background/blocked');
    assert.equal(resolve(app.db, id, 'blocked').from, 'global');
  }
});

test('slots resolve independently — one overridden, the other still inherited', async (t) => {
  const { app, cookie } = startServer(t);
  await upload(app, cookie, 'global', 'blocked', JPEG);
  await upload(app, cookie, 'global', 'downtime', JPEG);
  await upload(app, cookie, '1', 'downtime', PNG);

  assert.equal(resolve(app.db, 1, 'blocked').from, 'global');
  assert.equal(resolve(app.db, 1, 'downtime').from, 'client');
  // The other PC is untouched by its neighbour's override.
  assert.equal(resolve(app.db, 2, 'downtime').from, 'global');
  // Different pictures, so different hashes — which is what makes the client re-download one.
  assert.notEqual(forClient(app.db, 1).downtime.hash, forClient(app.db, 2).downtime.hash);
});

test('removing an override falls back to the household image, not to nothing', async (t) => {
  const { app, cookie } = startServer(t);
  await upload(app, cookie, 'global', 'blocked', JPEG);
  await upload(app, cookie, '1', 'blocked', PNG);
  assert.equal(resolve(app.db, 1, 'blocked').from, 'client');

  await app.inject({ method: 'POST', url: '/background/1/blocked/remove', headers: { cookie } });
  assert.equal(resolve(app.db, 1, 'blocked').from, 'global');
});

// --- Serving -----------------------------------------------------------------------------------

test('a client downloads what it resolves to, and needs its token to do it', async (t) => {
  const { app, cookie } = startServer(t);
  await upload(app, cookie, 'global', 'blocked', JPEG);
  await upload(app, cookie, '1', 'blocked', PNG);

  const anonymous = await app.inject({ method: 'GET', url: '/api/background/blocked' });
  assert.equal(anonymous.statusCode, 401);

  const own = await app.inject({
    method: 'GET', url: '/api/background/blocked', headers: { 'x-client-token': 'token-one' },
  });
  assert.equal(own.statusCode, 200);
  assert.equal(own.headers['content-type'], 'image/png', 'its own override');

  const inherited = await app.inject({
    method: 'GET', url: '/api/background/blocked', headers: { 'x-client-token': 'token-two' },
  });
  assert.equal(inherited.statusCode, 200);
  assert.equal(inherited.headers['content-type'], 'image/jpeg', 'the household one');
});

test('an unset slot is a 404, not an empty body pretending to be an image', async (t) => {
  const { app } = startServer(t);
  const res = await app.inject({
    method: 'GET', url: '/api/background/downtime', headers: { 'x-client-token': 'token-one' },
  });
  assert.equal(res.statusCode, 404);
});

// --- Cleanup -----------------------------------------------------------------------------------

test('deleting a client takes its background files with it', async (t) => {
  const { app, cookie, dir } = startServer(t);
  await upload(app, cookie, '1', 'blocked', JPEG);
  const file = path.join(dir, 'backgrounds', '1-blocked.jpg');
  assert.ok(fs.existsSync(file));

  await app.inject({ method: 'POST', url: '/clients/1/delete', headers: { cookie } });

  assert.ok(!fs.existsSync(file), 'rows cascade; files have to be told');
  assert.equal(app.db.prepare('SELECT count(*) n FROM backgrounds').get().n, 0);
});

test('replacing an image with a different format leaves no orphan behind', async (t) => {
  const { app, cookie, dir } = startServer(t);
  await upload(app, cookie, 'global', 'blocked', JPEG);
  await upload(app, cookie, 'global', 'blocked', PNG);

  assert.ok(!fs.existsSync(path.join(dir, 'backgrounds', `${GLOBAL}-blocked.jpg`)));
  assert.ok(fs.existsSync(path.join(dir, 'backgrounds', `${GLOBAL}-blocked.png`)));
});
