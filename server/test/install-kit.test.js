import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from '../src/app.js';
import { hashPassword, createSession } from '../src/auth.js';
import { fakeExe } from '../test-support/fake-exe.js';
import { SCRIPT_NAMES, scriptEntries, latestKit, buildKit } from '../src/install-kit.js';
import { zip, crc32 } from '../src/zip.js';

// The Install Kit is the only artifact this server hands to a human rather than to a machine, and the
// only page it serves without a session (ADR-0015). Both halves of that are tested here: that the
// archive is a real archive, and that the page says something true in every state it can be in.

function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-kit-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false });
  app.db.prepare(
    `INSERT INTO admin (id, username, password_hash, server_key, totp_secret)
     VALUES (1, 'parent', ?, 'test-server-key', 'AAAAAAAAAAAAAAAA')`
  ).run(hashPassword('irrelevant'));

  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { app, dir, cookie: `session=${createSession('test-server-key')}` };
}

/** Put a build on the server the way an upload would: bytes on disk under the content hash, one row. */
function announce(app, dir, version, bytes = fakeExe('0.9.9')) {
  const updates = path.join(dir, 'updates');
  fs.mkdirSync(updates, { recursive: true });
  const filename = `${version}-test.exe`;
  fs.writeFileSync(path.join(updates, filename), bytes);
  app.db.prepare(
    `INSERT INTO updates (version, filename, sha256, size, announced_at)
     VALUES (?, ?, 'deadbeef', ?, strftime('%Y-%m-%d %H:%M:%f','now'))`
  ).run(version, filename, bytes.length);
  return path.join(updates, filename);
}

/** A stand-in for client/install/, so the tests do not depend on a sibling checkout being present. */
function fakeScripts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-scripts-'));
  for (const name of SCRIPT_NAMES) fs.writeFileSync(path.join(dir, name), `REM ${name}\n`.repeat(20));
  return dir;
}

// --- The zip writer ------------------------------------------------------------------------------

test('zip round-trips through the system unzip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-zip-'));
  const mtime = new Date('2026-08-20T10:00:00Z');
  // One member that deflates well and one that cannot, so both the deflate and the store branch are
  // exercised by a real decompressor rather than only by our own reader.
  const archive = zip([
    { name: 'big.txt', data: Buffer.from('compress me '.repeat(500)), mtime },
    { name: 'tiny.bin', data: Buffer.from([0x00, 0x01, 0x02]), mtime },
  ]);
  fs.writeFileSync(path.join(dir, 'a.zip'), archive);

  execFileSync('unzip', ['-t', path.join(dir, 'a.zip')]);   // throws on a bad CRC or a bad directory
  execFileSync('unzip', ['-o', '-q', path.join(dir, 'a.zip'), '-d', path.join(dir, 'out')]);

  assert.equal(fs.readFileSync(path.join(dir, 'out', 'big.txt'), 'utf8'), 'compress me '.repeat(500));
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'out', 'tiny.bin'))], [0, 1, 2]);
  // Deflate has to have actually happened, or 'store when it does not help' is silently 'always store'.
  assert.ok(archive.length < 500 * 12, 'the compressible member was not deflated');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('crc32 matches the known check value', () => {
  // The standard CRC-32 check vector: '123456789' is 0xCBF43926 everywhere this format is implemented.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zip refuses what it cannot honestly encode', () => {
  const mtime = new Date('2026-08-20T10:00:00Z');
  // The UTF-8 name flag is not set, so a non-ASCII name would reach Explorer as mojibake. Stopping is
  // better than handing a parent an archive with a garbled filename in it.
  assert.throws(() => zip([{ name: 'telepítő.bat', data: Buffer.alloc(1), mtime }]), /non-ASCII/);
});

test('a pre-1980 mtime clamps rather than wrapping into the future', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-zip-'));
  const archive = zip([{ name: 'old.txt', data: Buffer.from('x'), mtime: new Date('1970-01-01T00:00:00Z') }]);
  fs.writeFileSync(path.join(dir, 'old.zip'), archive);
  const listing = execFileSync('unzip', ['-l', path.join(dir, 'old.zip')]).toString();
  assert.match(listing, /1980/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- What goes in the kit ------------------------------------------------------------------------

test('the kit is flat: the exe and the four scripts at the root', (t) => {
  const { app, dir } = startServer(t);
  const scripts = fakeScripts();
  t.after(() => fs.rmSync(scripts, { recursive: true, force: true }));
  announce(app, dir, '0.4.0');

  const kit = latestKit(app.db, app.db.name, scripts);
  assert.equal(kit.ok, true);
  assert.equal(kit.version, '0.4.0');

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-kit-out-'));
  fs.writeFileSync(path.join(out, 'kit.zip'), buildKit(kit));
  execFileSync('unzip', ['-o', '-q', path.join(out, 'kit.zip'), '-d', path.join(out, 'x')]);

  // Flat is the point: the .bat finds the exe beside itself, so the parent's whole job is unzip and
  // double-click. A nested layout would be the repo's, and would break that.
  assert.deepEqual(
    fs.readdirSync(path.join(out, 'x')).sort(),
    ['DigitalAid.exe', ...SCRIPT_NAMES].sort()
  );
  fs.rmSync(out, { recursive: true, force: true });
});

test('a missing checkout is reported, not shipped as a kit without an installer', (t) => {
  const { app, dir } = startServer(t);
  announce(app, dir, '0.4.0');
  assert.equal(scriptEntries(path.join(dir, 'nope')), null);
  assert.deepEqual(latestKit(app.db, app.db.name, path.join(dir, 'nope')),
    { ok: false, reason: 'no-scripts', version: '0.4.0' });
});

test('a partial checkout counts as no checkout', (t) => {
  const { app, dir } = startServer(t);
  const scripts = fakeScripts();
  t.after(() => fs.rmSync(scripts, { recursive: true, force: true }));
  fs.unlinkSync(path.join(scripts, 'Uninstall-DigitalAid.ps1'));
  announce(app, dir, '0.4.0');
  // Three of four is not a kit. Half an installer is worse than a page that says it has none.
  assert.equal(latestKit(app.db, app.db.name, scripts).reason, 'no-scripts');
});

test('a row whose file is gone reads as build-missing, not as a build', (t) => {
  const { app, dir } = startServer(t);
  const exe = announce(app, dir, '0.4.0');
  // What a database restored without the updates directory beside it looks like.
  fs.unlinkSync(exe);
  assert.deepEqual(latestKit(app.db, app.db.name, fakeScripts()),
    { ok: false, reason: 'build-missing', version: '0.4.0' });
});

test('the kit follows the latest *announced* build, so a rollback moves it', (t) => {
  const { app, dir } = startServer(t);
  const scripts = fakeScripts();
  t.after(() => fs.rmSync(scripts, { recursive: true, force: true }));
  announce(app, dir, '0.4.0');
  announce(app, dir, '0.5.0');
  assert.equal(latestKit(app.db, app.db.name, scripts).version, '0.5.0');

  // Re-announcing the older build is how a rollback is performed (routes/update.js). The kit has to
  // follow that, or a parent installing on a new PC would hand it the build they just backed out of.
  // An explicit later stamp, because both inserts above land in the same millisecond and the tie
  // breaks on id — which is the newer row. Real announcements are seconds apart at the very least.
  app.db.prepare("UPDATE updates SET announced_at = '2099-01-01 00:00:00.000' WHERE version = '0.4.0'").run();
  assert.equal(latestKit(app.db, app.db.name, scripts).version, '0.4.0');
});

// --- The page ------------------------------------------------------------------------------------

test('the download page needs no session', async (t) => {
  const { app, dir } = startServer(t);
  announce(app, dir, '0.4.0');

  const res = await app.inject({ method: 'GET', url: '/download' });
  assert.equal(res.statusCode, 200);
  // The whole point: a parent standing at the kid's PC must not have to type the household password
  // on the one machine it defends against (ADR-0015).
  assert.doesNotMatch(res.headers.location ?? '', /login/);
  assert.match(res.headers['x-robots-tag'], /noindex/);
});

test('the page says nothing about the household', async (t) => {
  const { app, dir } = startServer(t);
  app.db.prepare("INSERT INTO clients (name, token_hash) VALUES ('Marci gépe', 'hash')").run();
  announce(app, dir, '0.4.0');

  const body = (await app.inject({ method: 'GET', url: '/download' })).body;
  // Unauthenticated means the page is a download and nothing else: no Client names, no hashes.
  assert.doesNotMatch(body, /Marci/);
  assert.doesNotMatch(body, /deadbeef/);
});

test('with no build the page explains itself instead of 404ing', async (t) => {
  const { app } = startServer(t);
  const res = await app.inject({ method: 'GET', url: '/download' });
  // A bookmark that keeps working and says why there is nothing there beats a 404, which is
  // indistinguishable from a typo or a broken server.
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /install-kit\.zip/);
});

test('the login page offers the kit only when there is one', async (t) => {
  const { app, dir } = startServer(t);
  assert.doesNotMatch((await app.inject({ method: 'GET', url: '/login' })).body, /\/download/);
  announce(app, dir, '0.4.0');
  assert.match((await app.inject({ method: 'GET', url: '/login' })).body, /\/download/);
});

test('the zip URL sends a stale bookmark back to the page, not to an error', async (t) => {
  const { app } = startServer(t);
  const res = await app.inject({ method: 'GET', url: '/download/install-kit.zip' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/download');
});

test('robots.txt disallows everything', async (t) => {
  const { app } = startServer(t);
  const res = await app.inject({ method: 'GET', url: '/robots.txt' });
  // An unsigned executable on a private domain has no business in a search index.
  assert.match(res.body, /Disallow: \//);
});

test('the clients page offers the kit, and only when there is one', async (t) => {
  const { app, dir, cookie } = startServer(t);

  // Empty state: this is the moment someone needs the kit most, so it is a button there rather than
  // a footer link — but still nothing at all until a build exists.
  assert.doesNotMatch((await app.inject({ method: 'GET', url: '/clients', headers: { cookie } })).body, /\/download/);
  announce(app, dir, '0.4.0');
  assert.match((await app.inject({ method: 'GET', url: '/clients', headers: { cookie } })).body, /href="\/download"/);

  app.db.prepare("INSERT INTO clients (name, token_hash) VALUES ('Marci gépe', 'hash')").run();
  assert.match((await app.inject({ method: 'GET', url: '/clients', headers: { cookie } })).body, /href="\/download"/);
});

test('the live grid fragment carries no download link', async (t) => {
  const { app, dir, cookie } = startServer(t);
  announce(app, dir, '0.4.0');
  app.db.prepare("INSERT INTO clients (name, token_hash) VALUES ('Marci gépe', 'hash')").run();

  // The grid re-renders every five seconds. A link is not a reading and has no business in it.
  const res = await app.inject({ method: 'GET', url: '/clients/grid', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /\/download/);
});
