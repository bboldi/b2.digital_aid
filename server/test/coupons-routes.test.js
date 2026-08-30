import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/app.js';
import { createSession, hashPassword } from '../src/auth.js';
import { listCoupons } from '../src/coupons.js';

// The coupons page is inventory management: mint a batch, see its state, delete what should stop
// working. The redemption semantics live in coupons.test.js; these tests pin the HTTP surface.

function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-coupon-routes-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false });
  app.db.prepare(
    `INSERT INTO admin (id, username, password_hash, server_key, totp_secret)
     VALUES (1, 'parent', ?, 'test-server-key', 'AAAAAAAAAAAAAAAA')`
  ).run(hashPassword('irrelevant'));
  app.db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (1, 'Kid PC', 'hash-1')").run();
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, cookie: `session=${createSession('test-server-key')}` };
}

test('the coupons page is behind the login', async (t) => {
  const { app } = startServer(t);
  const res = await app.inject({ method: 'GET', url: '/coupons' });
  assert.equal(res.statusCode, 302);
});

test('minting creates the batch and the page lists it', async (t) => {
  const { app, cookie } = startServer(t);
  const mint = await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: { scope: 'global', minutes: 30, expires: '', count: 3 },
  });
  assert.equal(mint.statusCode, 302);
  const rows = listCoupons(app.db);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.client_id === null && r.minutes === 30 && r.expires_on === null));

  const page = await app.inject({ method: 'GET', url: '/coupons', headers: { cookie } });
  assert.equal(page.statusCode, 200);
  // Codes are shown grouped; the list carries every minted code.
  for (const r of rows) {
    const grouped = `${r.code.slice(0, 3)}-${r.code.slice(3, 6)}-${r.code.slice(6)}`;
    assert.ok(page.body.includes(grouped), `expected ${grouped} on the page`);
  }
});

test('a client-tied coupon with an expiry stores both', async (t) => {
  const { app, cookie } = startServer(t);
  await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: { scope: 1, minutes: 45, expires: '2026-12-31', count: 1 },
  });
  const [row] = listCoupons(app.db);
  assert.equal(row.client_id, 1);
  assert.equal(row.expires_on, '2026-12-31');
});

test('a malformed expiry date refuses the mint rather than storing garbage', async (t) => {
  const { app, cookie } = startServer(t);
  const res = await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: { scope: 'global', minutes: 30, expires: 'soon', count: 1 },
  });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /error=/);
  assert.equal(listCoupons(app.db).length, 0);
});

test('delete removes exactly the selected rows', async (t) => {
  const { app, cookie } = startServer(t);
  await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: { scope: 'global', minutes: 30, expires: '', count: 3 },
  });
  const [a, b] = listCoupons(app.db);
  const res = await app.inject({
    method: 'POST', url: '/coupons/delete', headers: { cookie },
    payload: { id: [a.id, b.id] },
  });
  assert.equal(res.statusCode, 302);
  assert.equal(listCoupons(app.db).length, 1);
});

test('the print sheet renders exactly the selected coupons, ticket by ticket', async (t) => {
  const { app, cookie } = startServer(t);
  await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: { scope: 'global', minutes: 30, expires: '2026-12-31', count: 2 },
  });
  const [a, b] = listCoupons(app.db);
  const res = await app.inject({
    method: 'GET', url: `/coupons/print?id=${a.id}`, headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const groupedA = `${a.code.slice(0, 3)}-${a.code.slice(3, 6)}-${a.code.slice(6)}`;
  assert.ok(res.body.includes(groupedA));
  assert.ok(!res.body.includes(b.code.slice(0, 6)), 'unselected coupon must not print');
  assert.match(res.body, /Worth 30 minutes/);
  assert.match(res.body, /Valid through 2026-12-31/);
  // A standalone document: the app shell (nav tabbar) must not be part of a printed sheet.
  assert.ok(!res.body.includes('tabbar'));
});

test('a no-expiry coupon prints an explicit line, not a blank', async (t) => {
  const { app, cookie } = startServer(t);
  await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: { scope: 'global', minutes: 15, expires: '', count: 1 },
  });
  const [c] = listCoupons(app.db);
  const res = await app.inject({
    method: 'GET', url: `/coupons/print?id=${c.id}`, headers: { cookie },
  });
  // On a physical coupon a missing line reads as "forgot to fill it in", not "forever" (grill Q10).
  assert.match(res.body, /No expiration/);
});

test('a filter with no matches keeps the filters on screen so there is a way back', async (t) => {
  const { app, cookie } = startServer(t);
  await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: { scope: 'global', minutes: 30, expires: '', count: 1 },
  });
  // Kid PC has no coupons of its own; filtering by it used to render just "No coupons yet."
  // with the whole toolbar gone — a dead end with no in-page way back to "All".
  const res = await app.inject({ method: 'GET', url: '/coupons?client_id=1', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /name="client_id"/);
  assert.match(res.body, /name="status"/);
  // The empty message must say the filters matched nothing, not that no coupons exist.
  assert.match(res.body, /No coupons match/);
});

test('a truly empty inventory shows the plain empty message without filters', async (t) => {
  const { app, cookie } = startServer(t);
  const res = await app.inject({ method: 'GET', url: '/coupons', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /No coupons yet/);
  assert.doesNotMatch(res.body, /name="client_id"/);
});

test('select-all lives in the toolbar, not the table header phones clip away', async (t) => {
  const { app, cookie } = startServer(t);
  await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: { scope: 'global', minutes: 30, expires: '', count: 2 },
  });
  const res = await app.inject({ method: 'GET', url: '/coupons', headers: { cookie } });
  // The phone stylesheet clips <thead> to a 1px box, so a control that only exists there
  // does not exist on the primary control surface (ADR-0016).
  const selectAllAt = res.body.indexOf('id="select-all"');
  const tableAt = res.body.indexOf('<table');
  assert.ok(selectAllAt !== -1, 'select-all must be rendered');
  assert.ok(tableAt !== -1, 'table must be rendered');
  assert.ok(selectAllAt < tableAt, 'select-all must be outside (before) the table');
  const thead = res.body.slice(res.body.indexOf('<thead'), res.body.indexOf('</thead>'));
  assert.ok(!thead.includes('<input'), 'the clipped thead must not hold any control');
});

test('bulk actions start disabled until a coupon is selected', async (t) => {
  const { app, cookie } = startServer(t);
  await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: { scope: 'global', minutes: 30, expires: '', count: 1 },
  });
  const res = await app.inject({ method: 'GET', url: '/coupons', headers: { cookie } });
  // With nothing checked, delete deletes 0 rows and print bounces back — silently. The buttons
  // say so up front instead; the page script enables them when a selection exists.
  assert.match(res.body, /formaction="\/coupons\/print"[^>]*disabled/);
  assert.match(res.body, /formaction="\/coupons\/delete"[^>]*disabled/);
});

test('the Codes page is headed Codes and offers the way to Time Coupons', async (t) => {
  const { app, cookie } = startServer(t);
  const res = await app.inject({ method: 'GET', url: '/family-code', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<h1>Codes<\/h1>/);
  // The Admin Code card keeps its own name — only the page heading was wrong.
  assert.match(res.body, /Admin Code/);
  assert.match(res.body, /href="\/coupons"/);
});
