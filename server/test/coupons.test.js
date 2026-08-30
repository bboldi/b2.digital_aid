import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import {
  ALPHABET, MAX_MINT_COUNT, normalizeCoupon, isCouponShaped,
  mintCoupons, redeemCoupon, listCoupons, deleteCoupons,
} from '../src/coupons.js';

// A Time Coupon is the one code the server checks itself (ADR-0017). These tests pin the three
// promises the printed slip makes: it is worth its minutes exactly once, it says who may spend it,
// and it stops working on the date it names — through that date, not on it.

function newDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-coupons-'));
  const db = openDb(path.join(dir, 'test.db'));
  db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (1, 'Kid PC', 'hash-1')").run();
  db.prepare("INSERT INTO clients (id, name, token_hash) VALUES (2, 'Other PC', 'hash-2')").run();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

const mintOne = (db, opts = {}) =>
  mintCoupons(db, { clientId: null, minutes: 30, expires: null, count: 1, ...opts })[0];

test('the alphabet is the 19 unambiguous consonants and nothing else', () => {
  assert.equal(ALPHABET, 'BCDFGHJKMNPQRSTVWXZ');
});

test('a minted code is six alphabet letters plus the zero-padded minutes', (t) => {
  const db = newDb(t);
  for (const c of mintCoupons(db, { clientId: null, minutes: 5, expires: null, count: 20 })) {
    assert.match(c.code, new RegExp(`^[${ALPHABET}]{6}005$`));
  }
});

test('minting checks uniqueness against every coupon, used ones included', (t) => {
  const db = newDb(t);
  const minted = mintCoupons(db, { clientId: null, minutes: 30, expires: null, count: 50 });
  assert.equal(new Set(minted.map((c) => c.code)).size, 50);
});

test('minutes and count are clamped to their bounds', (t) => {
  const db = newDb(t);
  assert.match(mintOne(db, { minutes: 9999 }).code, /999$/);
  assert.match(mintOne(db, { minutes: 0 }).code, /001$/);
  assert.equal(mintCoupons(db, { clientId: null, minutes: 10, expires: null, count: 500 }).length,
    MAX_MINT_COUNT);
});

test('normalization strips separators and uppercases, and only that', () => {
  assert.equal(normalizeCoupon('krt-vxm 030'), 'KRTVXM030');
  assert.equal(normalizeCoupon('KRT–VXM.030'), 'KRTVXM030');   // en dash, dot
  assert.equal(normalizeCoupon('KRT VXM 030'), 'KRTVXM030');   // NBSP and narrow NBSP
  assert.ok(isCouponShaped('KRTVXM030'));
  assert.ok(!isCouponShaped('KRTVXM03'));      // too short
  assert.ok(!isCouponShaped('KRTVXA030'));     // A is not in the alphabet
  assert.ok(!isCouponShaped('482102015'));     // an Extra Time Code is not a coupon
  assert.ok(!isCouponShaped('KRTVXM000'));     // zero minutes is not a coupon
});

test('a global coupon grants its minutes and is spent by whoever redeems it first', (t) => {
  const db = newDb(t);
  const c = mintOne(db);
  assert.deepEqual(redeemCoupon(db, 1, c.code), { state: 'granted', minutes: 30 });
  const row = listCoupons(db).find((r) => r.id === c.id);
  assert.equal(row.used_by, 1);
  assert.ok(row.used_at);
  // First come, first served: the other Client is told it is spent, not invalid.
  assert.deepEqual(redeemCoupon(db, 2, c.code), { state: 'used' });
});

test('redemption is case-insensitive and separator-tolerant', (t) => {
  const db = newDb(t);
  const c = mintOne(db);
  const typed = `${c.code.slice(0, 3).toLowerCase()}-${c.code.slice(3, 6)} ${c.code.slice(6)}`;
  assert.equal(redeemCoupon(db, 1, typed).state, 'granted');
});

test('a coupon tied to one Client is refused elsewhere as wrong-client, and stays unspent', (t) => {
  const db = newDb(t);
  const c = mintOne(db, { clientId: 1 });
  assert.deepEqual(redeemCoupon(db, 2, c.code), { state: 'wrong-client' });
  assert.equal(listCoupons(db).find((r) => r.id === c.id).used_at, null);
  assert.equal(redeemCoupon(db, 1, c.code).state, 'granted');
});

test('expiry runs through the named date inclusive, at server-local midnight', (t) => {
  const db = newDb(t);
  const c = mintOne(db, { expires: '2026-09-30' });
  // 23:59 local on the named date: still good.
  assert.equal(redeemCoupon(db, 1, c.code, new Date('2026-09-30T23:59:00')).state, 'granted');
  const d = mintOne(db, { expires: '2026-09-30' });
  // The next local morning: expired, and still unspent.
  assert.equal(redeemCoupon(db, 1, d.code, new Date('2026-10-01T00:01:00')).state, 'expired');
  assert.equal(listCoupons(db).find((r) => r.id === d.id).used_at, null);
});

test('an unknown code is invalid — and so is a deleted one, indistinguishably (revoke is delete)', (t) => {
  const db = newDb(t);
  const c = mintOne(db);
  assert.equal(deleteCoupons(db, [c.id]), 1);
  assert.deepEqual(redeemCoupon(db, 1, c.code), { state: 'invalid' });
  assert.deepEqual(redeemCoupon(db, 1, 'not a code'), { state: 'invalid' });
});

test('a spent coupon that has also expired reads as used — spent is the truer story', (t) => {
  const db = newDb(t);
  const c = mintOne(db, { expires: '2099-01-01' });
  redeemCoupon(db, 1, c.code);
  db.prepare("UPDATE coupons SET expires_on = '2000-01-01' WHERE id = ?").run(c.id);
  assert.deepEqual(redeemCoupon(db, 2, c.code), { state: 'used' });
});
