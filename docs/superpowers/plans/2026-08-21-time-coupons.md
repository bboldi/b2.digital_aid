# Time Coupons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-minted, printable **Time Coupons** — six letters + three-digit minutes, stored on the server, redeemed online by a Client, topping up that day's Allowance — with an admin page to mint, delete, copy and print them.

**Architecture:** A new `coupons` table and pure `coupons.js` module on the server (mirroring `requests.js`); one new client→server WS message (`coupon`) answered inline by `coupon-status` (protocol v4); on the client, a `CouponCode` parser beside `GrantCode`, a `BonusSeconds` allowance top-up in `EnforcementEngine`, an async redemption path in `ClientAgent`/`AppHost`, and letters accepted in the shared entry box. Admin UI gets a `/coupons` page (list / mint / delete / print) reached from the Codes page.

**Tech Stack:** Node 20+ / Fastify / better-sqlite3 / EJS / node:test (server) · .NET 10 / WPF / xunit (client) · Beer CSS M3 skin (admin UI, ADR-0016).

**Spec:** `docs/adr/0017-time-coupons-are-lettered-server-checked-and-top-up-the-allowance.md` + the **Time Coupon** entry in `CONTEXT.md`. Read both before starting any task.

## Global Constraints

- **Alphabet:** exactly 19 uppercase consonants: `BCDFGHJKMNPQRSTVWXZ` (no vowels A E I O U Y, no lookalikes I L O). Defined once per codebase, never inline-duplicated.
- **Canonical code form:** 9 chars, uppercase, no separators (e.g. `KRTVXM030`). Display/print grouped in threes (`KRT-VXM-030`). Clipboard always carries the bare form (ADR-0014 rule).
- **Entry is case-insensitive**; Client uppercases before sending, server uppercases before lookup. Separators stripped with the exact same separator set `GrantCode` uses — and only separators (a stray letter/digit must stay an error).
- **Semantics (ADR-0017):** redemption adds minutes to *today's* Allowance (`BonusSeconds`), never creates a Grant; Downtime still beats it; refused client-side during Downtime *before* any server call; single-use, first-come-first-served for Global; expiry optional, valid through the date inclusive at **server-local** midnight.
- **i18n:** every user-facing string exists in `en` and `hu`; any string containing a number is a whole sentence with `{0}` (Hungarian does not pluralise after a numeral). Admin UI strings in `server/locales/*.json`; kid-facing strings in `client/Client.Core/Strings.resx` + `Strings.hu.resx`. Hungarian term is **időkupon** (CONTEXT.md table).
- **Protocol changes are additive** (PROTOCOL §1): version 3→4 on both sides; an old Client ignoring the new types must keep working.
- **Server error codes on the wire stay English protocol words** (`granted`, `used`, `expired`, `wrong-client`, `invalid`) — they are protocol, not UI.
- Run server tests from `server/` with `npm test`; client tests from `client/` with `dotnet test`.
- Commit after every task; commit messages in the repo's sentence style (see `git log`), ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_011G8tfCXazmo8L84R8BkkAv`

---

### Task 1: Server coupon module — schema, mint, redeem

**Files:**
- Modify: `docs/adr/0017-time-coupons-are-lettered-server-checked-and-top-up-the-allowance.md` (one-word fix)
- Modify: `server/src/db.js` (new table)
- Create: `server/src/coupons.js`
- Test: `server/test/coupons.test.js`

**Interfaces:**
- Produces: `ALPHABET` (string), `MAX_MINT_COUNT = 100`, `normalizeCoupon(raw) → string`, `isCouponShaped(normalized) → boolean`, `mintCoupons(db, {clientId, minutes, expires, count, now}) → rows[]`, `redeemCoupon(db, clientId, raw, now) → {state, minutes?}`, `listCoupons(db) → rows[]`, `deleteCoupons(db, ids) → number`. States on the wire: `'granted' | 'used' | 'expired' | 'wrong-client' | 'invalid'`.

- [ ] **Step 1: Fix the ADR's alphabet count** — the consonant set excluding L has 19 letters, not 20. In `docs/adr/0017-...md` change `a fixed 20-letter alphabet` to `a fixed 19-letter alphabet`.

- [ ] **Step 2: Add the `coupons` table** in `server/src/db.js`, inside `openDb`, after the `alert_watch` block and before the final `idx_events_client_seq` index (new tables go in `db.exec` blocks after the migrations, per the pattern there):

```js
  db.exec(`
    -- Time Coupons (CONTEXT.md; ADR-0017): pre-minted codes the server checks at redemption.
    -- This table is inventory, not audit — revoke is hard DELETE, and a redemption outlives any
    -- deletion as a coupon-redeemed Event on the Client's timeline.
    --
    -- client_id NULL means Global: good on any Client, spent by whichever redeems it first.
    -- ON DELETE CASCADE on client_id: a coupon for a machine that no longer exists is nothing.
    -- used_by is SET NULL instead, so deleting one Client cannot erase the fact that a Global
    -- coupon was spent.
    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,          -- canonical: 6 alphabet letters + 3-digit minutes
      minutes INTEGER NOT NULL,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      expires_on TEXT,                    -- 'YYYY-MM-DD' server-local, inclusive; NULL = never
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      used_at TEXT,
      used_by INTEGER REFERENCES clients(id) ON DELETE SET NULL
    )`);
```

- [ ] **Step 3: Write the failing tests** — `server/test/coupons.test.js`. Follow the harness idiom of `requests.test.js` (mkdtemp + `openDb` + `t.after` cleanup):

```js
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd server && npm test -- --test-name-pattern=. test/coupons.test.js` (or `node --test test/coupons.test.js`)
Expected: FAIL — `Cannot find module '../src/coupons.js'`

- [ ] **Step 5: Write `server/src/coupons.js`:**

```js
import crypto from 'node:crypto';

// Time Coupons (CONTEXT.md; ADR-0017): codes minted ahead of time, stored here, checked here.
// Pure of Fastify and of the websocket, like requests.js: this module decides what happens to a
// coupon, and ws.js / routes/coupons.js do the talking.

/// 19 consonants: no vowels (a random six-letter string must never spell a word on a slip handed
/// to a child) and no I, L, O (every printed glyph gets exactly one reading — the same failure
/// ADR-0014's grouping exists to catch). Defined identically in client/Client.Core/CouponCode.cs.
export const ALPHABET = 'BCDFGHJKMNPQRSTVWXZ';

export const MAX_MINT_COUNT = 100;
export const MAX_MINUTES = 999;   // the tail is three digits, same ceiling as a Grant

// The same set GrantCode strips, for the same reason: a code displayed in threes comes back with
// whatever separator the sender's keyboard produced. Deliberately not "strip anything unexpected" —
// a stray character is a typo and must stay one.
const SEPARATORS = /[ \-‐‑‒–—  ._]/g;

/** Canonical form: separators out, uppercase. Shape is not checked here. */
export const normalizeCoupon = (raw) => String(raw ?? '').replace(SEPARATORS, '').toUpperCase();

const SHAPE = new RegExp(`^[${ALPHABET}]{6}\\d{3}$`);

/** Six alphabet letters + three digits, minutes >= 1. Takes the *normalized* form. */
export const isCouponShaped = (code) => SHAPE.test(code) && Number(code.slice(6)) >= 1;

// 'YYYY-MM-DD' in this process's local timezone — expiry turns at *server-local* midnight
// (ADR-0017): the coupon is a server-side object, and a Global one has no single Client whose
// midnight could apply. en-CA is the one locale whose short date is ISO-shaped.
const localDate = (now) => now.toLocaleDateString('en-CA');

const sqlUtc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

function randomCode(minutes) {
  let letters = '';
  for (let i = 0; i < 6; i++) letters += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return letters + String(minutes).padStart(3, '0');
}

/**
 * Mint a batch. One scope, one amount, one expiry per batch — mixed values are two batches.
 * Uniqueness is checked against every existing coupon, used ones included: a fresh code that
 * matches a spent-but-still-listed one would confuse the list and the kid alike.
 */
export function mintCoupons(db, { clientId = null, minutes, expires = null, count = 1 }) {
  const m = Math.min(Math.max(Math.trunc(minutes) || 1, 1), MAX_MINUTES);
  const n = Math.min(Math.max(Math.trunc(count) || 1, 1), MAX_MINT_COUNT);

  const exists = db.prepare('SELECT 1 FROM coupons WHERE code = ?');
  const insert = db.prepare(
    'INSERT INTO coupons (code, minutes, client_id, expires_on) VALUES (?, ?, ?, ?)');

  const minted = [];
  const mintAll = db.transaction(() => {
    while (minted.length < n) {
      const code = randomCode(m);
      if (exists.get(code)) continue;   // ~19^6 combinations; a collision is hygiene, not an event
      const { lastInsertRowid } = insert.run(code, m, clientId, expires);
      minted.push({ id: Number(lastInsertRowid), code, minutes: m, client_id: clientId, expires_on: expires });
    }
  });
  mintAll();
  return minted;
}

/**
 * The server-side half of redemption. Refusals are specific and honest (ADR-0017), in this order:
 * unknown → invalid (a deleted coupon lands here too, indistinguishably — revoke is delete);
 * tied to another machine → wrong-client (before 'used': the kid holding the wrong slip should
 * hear that, not a half-truth); spent → used; past its date → expired. Only 'granted' spends it.
 */
export function redeemCoupon(db, clientId, raw, now = new Date()) {
  const code = normalizeCoupon(raw);
  if (!isCouponShaped(code)) return { state: 'invalid' };

  const redeem = db.transaction(() => {
    const row = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
    if (!row) return { state: 'invalid' };
    if (row.client_id !== null && row.client_id !== clientId) return { state: 'wrong-client' };
    if (row.used_at !== null) return { state: 'used' };
    if (row.expires_on !== null && row.expires_on < localDate(now)) return { state: 'expired' };

    db.prepare('UPDATE coupons SET used_at = ?, used_by = ? WHERE id = ?')
      .run(sqlUtc(now), clientId, row.id);
    return { state: 'granted', minutes: row.minutes };
  });
  return redeem();
}

/** Every coupon, newest batch first, with the redeemer's name resolved for the list and the print. */
export function listCoupons(db) {
  return db.prepare(
    `SELECT c.*, k.name AS client_name, u.name AS used_by_name
       FROM coupons c
       LEFT JOIN clients k ON k.id = c.client_id
       LEFT JOIN clients u ON u.id = c.used_by
      ORDER BY c.id DESC`).all();
}

/** Hard delete (ADR-0017): the row goes away; a redemption already lives on as a Client Event. */
export function deleteCoupons(db, ids) {
  const wanted = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (wanted.length === 0) return 0;
  const del = db.prepare(`DELETE FROM coupons WHERE id IN (${wanted.map(() => '?').join(',')})`);
  return del.run(...wanted).changes;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && node --test test/coupons.test.js`
Expected: PASS, all tests. Also run the full suite (`npm test`) — the schema change must not break anything.

- [ ] **Step 7: Commit**

```bash
git add docs/adr/0017-*.md server/src/db.js server/src/coupons.js server/test/coupons.test.js
git commit -m "Mint, spend and revoke Time Coupons in the server database"
```

---

### Task 2: Protocol v4 — the `coupon` message and PROTOCOL.md

**Files:**
- Modify: `PROTOCOL.md`
- Modify: `server/src/protocol.js:3` (version bump)
- Modify: `server/src/ws.js` (new message case)

**Interfaces:**
- Consumes: `redeemCoupon(db, clientId, raw)` from Task 1.
- Produces: wire shapes the client side (Task 7) is written against — client→server `{"type":"coupon","code":"KRTVXM030"}`; server→client `{"type":"coupon-status","state":"granted","minutes":30}` (minutes only on `granted`; states `granted|used|expired|wrong-client|invalid`); Event type `coupon-redeemed` with payload `{"code":"KRTVXM030","minutes":30}`.

- [ ] **Step 1: Update `PROTOCOL.md`.** All edits, concretely:
  - Add to the version history at the top (above the Version 3 paragraph, matching its voice):
    > Version 4 added Time Coupons (`coupon` §5.4, `coupon-status` §6.10, the `coupon-redeemed` Event). Additive both ways: a version 3 Client never sends `coupon` and cannot redeem one until it updates — its parser rejects letters — and a version 3 server answers `coupon` with nothing, which the Client reports as unreachable-for-coupons. Nothing else changes shape.
  - New section **`### 5.4 \`coupon\` · implemented`** after §5.3, documenting: sent when a code containing letters is typed into the code entry; `code` is the canonical uppercase separator-free 9-char form; the Client refuses locally during Downtime *before* sending (ADR-0017), so the server never sees that case; answered inline with `coupon-status` (§6.10); live-only — there is no queueing, a coupon typed while offline is refused with "try again later" and stays unspent.
  - New section **`### 6.10 \`coupon-status\` · implemented`** after §6.9: fields `state` (vocabulary above) and `minutes` (present only with `granted`). On `granted` the Client adds the minutes to today's Allowance (**not** a Grant — Downtime still beats them, they pause on lock, they die at local midnight) and logs `coupon-redeemed`. Unknown `state` values are ignored (§1).
  - In **§7.2 Event types**, add the row: `coupon-redeemed` · `{ "code": "KRTVXM030", "minutes": 30 }` · Logged when a `coupon-status: granted` lands. The code appears in the payload because the parent's list may no longer hold the coupon (revoke is delete, ADR-0017) — the timeline is the audit.
  - In **§10 Decisions recorded**, add a link line for ADR-0017.

- [ ] **Step 2: Bump the server protocol version** — `server/src/protocol.js`: `export const PROTOCOL_VERSION = 4;`

- [ ] **Step 3: Handle the message in `server/src/ws.js`.** Add the import and the case (mirroring `request`):

```js
import { redeemCoupon } from './coupons.js';
```

In the `switch (msg.type)`, after the `'request'` case:

```js
        case 'coupon': {
          // Answered inline like a request: "spent", "expired" and "wrong machine" are states the
          // kid should see now, not silence that reads as a broken button (PROTOCOL §6.10).
          const outcome = redeemCoupon(db, client.id, msg.code);
          socket.send(JSON.stringify({ type: 'coupon-status', ...outcome }));
          if (outcome.state === 'granted') {
            app.log.info({ client: client.id, minutes: outcome.minutes }, 'time coupon redeemed');
          }
          break;
        }
```

- [ ] **Step 4: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS (the wiring is a thin dispatch over the module Task 1 tested; no ws-level test harness exists in this repo).

- [ ] **Step 5: Commit**

```bash
git add PROTOCOL.md server/src/protocol.js server/src/ws.js
git commit -m "Answer coupon redemptions over the socket, protocol v4"
```

---

### Task 3: Admin `/coupons` page — list, mint, delete

**Files:**
- Create: `server/src/routes/coupons.js`
- Create: `server/views/coupons.ejs`
- Modify: `server/src/app.js` (register the route file, beside `backgroundRoutes`)
- Modify: `server/locales/en.json`, `server/locales/hu.json`
- Test: `server/test/coupons-routes.test.js`

**Interfaces:**
- Consumes: `mintCoupons`, `listCoupons`, `deleteCoupons`, `MAX_MINT_COUNT` from Task 1; `app.isLoggedIn`, the `translate`-based `T` helper pattern (`routes/admin.js:27`), the global `preHandler` that injects `t`/`lang` into every view.
- Produces: `GET /coupons` (page), `POST /coupons` (mint; form fields `scope` = `'global'` or a client id, `minutes`, `expires` optional `YYYY-MM-DD`, `count`), `POST /coupons/delete` (form field `id`, repeated). Task 4 adds `GET /coupons/print` to this same file.

- [ ] **Step 1: Write the failing route tests** — `server/test/coupons-routes.test.js`, using the `startServer` idiom from `about.test.js` verbatim (mkdtemp, `build`, admin row, session cookie), plus two clients inserted as in `coupons.test.js`:

```js
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
    payload: 'scope=global&minutes=30&expires=&count=3',
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
    payload: 'scope=1&minutes=45&expires=2026-12-31&count=1',
  });
  const [row] = listCoupons(app.db);
  assert.equal(row.client_id, 1);
  assert.equal(row.expires_on, '2026-12-31');
});

test('a malformed expiry date refuses the mint rather than storing garbage', async (t) => {
  const { app, cookie } = startServer(t);
  const res = await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: 'scope=global&minutes=30&expires=soon&count=1',
  });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /error=/);
  assert.equal(listCoupons(app.db).length, 0);
});

test('delete removes exactly the selected rows', async (t) => {
  const { app, cookie } = startServer(t);
  await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: 'scope=global&minutes=30&expires=&count=3',
  });
  const [a, b] = listCoupons(app.db);
  const res = await app.inject({
    method: 'POST', url: '/coupons/delete', headers: { cookie },
    payload: `id=${a.id}&id=${b.id}`,
  });
  assert.equal(res.statusCode, 302);
  assert.equal(listCoupons(app.db).length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/coupons-routes.test.js`
Expected: FAIL — `/coupons` 404s (route not registered).

- [ ] **Step 3: Add the locale keys.** In `server/locales/en.json` (and the same keys in `hu.json` with the values below). Keys, en → hu:

```
"title.coupons": "Time Coupons"                            → "Időkuponok"
"coupons.title": "Time Coupons"                            → "Időkuponok"
"coupons.lead": "Pre-made time codes you can print or send. The kid spends one whenever they choose — it adds its minutes to that day, and downtime still wins."
                                                           → "Előre elkészített idő-kódok, amelyeket kinyomtathatsz vagy elküldhetsz. A gyerek akkor váltja be, amikor szeretné — a percek az adott naphoz adódnak, és a pihenőidő továbbra is erősebb."
"coupons.add": "Add coupons"                               → "Kuponok hozzáadása"
"coupons.scope": "Machine"                                 → "Gép"
"coupons.scopeGlobal": "Any computer"                      → "Bármelyik gép"
"coupons.minutes": "Minutes"                               → "Perc"
"coupons.expiry": "Expires"                                → "Lejárat"
"coupons.expiryNone": "No expiration"                      → "Nincs lejárat"
"coupons.count": "How many"                                → "Darabszám"
"coupons.mint": "Create"                                   → "Létrehozás"
"coupons.code": "Code"                                     → "Kód"
"coupons.state": "State"                                   → "Állapot"
"coupons.stateUnused": "Unused"                            → "Felhasználatlan"
"coupons.stateUsed": "Used by {0} on {1}"                  → "Felhasználva: {0}, {1}"
"coupons.stateExpired": "Expired"                          → "Lejárt"
"coupons.created": "Created"                               → "Létrehozva"
"coupons.delete": "Delete selected"                        → "Kijelöltek törlése"
"coupons.deleteConfirm": "Delete the selected coupons? A printed copy stops working immediately."
                                                           → "Törlöd a kijelölt kuponokat? A kinyomtatott példány azonnal érvénytelenné válik."
"coupons.print": "Print selected"                          → "Kijelöltek nyomtatása"
"coupons.empty": "No coupons yet."                         → "Még nincs kupon."
"coupons.copy": "Copy"                                     → "Másolás"
"coupons.copied": "Copied"                                 → "Másolva"
"ok.couponsMinted": "Created {0} coupons."                 → "{0} kupon létrehozva."
"ok.couponsDeleted": "Deleted {0} coupons."                → "{0} kupon törölve."
"err.couponBadInput": "Those coupon details were not accepted. Check the amount, the count and the date."
                                                           → "A kupon adatai nem megfelelőek. Ellenőrizd az időt, a darabszámot és a dátumot."
"event.coupon-redeemed": "time coupon used"                → "időkupon felhasználva"
```

(The `event.*` entry is the timeline vocabulary for the new `coupon-redeemed` Event — the Client Page renders Event types through the `v('event', ...)` helper, and a missing entry falls back to the raw wire word. Both locale files hold these at the `event.grant-redeemed` block, `en.json:311` — add the new key there, matching the lowercase style of its neighbours.)

(If `server/test/i18n.test.js` enforces en/hu key parity, adding to both files keeps it green — run it.)

- [ ] **Step 4: Write `server/src/routes/coupons.js`:**

```js
import { translate } from '../i18n.js';
import { mintCoupons, listCoupons, deleteCoupons, MAX_MINT_COUNT } from '../coupons.js';

const T = (req, key, vars) => translate(req.lang, key, vars);

// The Time Coupons page (ADR-0017): mint a batch, see the inventory, delete what must stop
// working, print what goes in a drawer. Lives under the Codes tab but on its own page: Codes is
// cached for offline Trusted Devices, and coupons are server-only by design.

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Presentation only, never stored or copied (ADR-0014): `KRTVXM030` shown as `KRT-VXM-030`. */
const grouped = (code) => `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;

export default async function couponRoutes(app) {
  const { db } = app;

  const back = (message, ok = true) =>
    `/coupons?${ok ? 'ok' : 'error'}=${encodeURIComponent(message)}`;

  app.get('/coupons', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');
    return reply.view('coupons.ejs', {
      title: T(req, 'title.coupons'), navActive: 'family-code',
      coupons: listCoupons(db), grouped,
      clients: db.prepare('SELECT id, name FROM clients WHERE revoked_at IS NULL ORDER BY name').all(),
      today: new Date().toLocaleDateString('en-CA'),
      maxCount: MAX_MINT_COUNT,
      ok: req.query.ok ?? null, error: req.query.error ?? null,
    });
  });

  app.post('/coupons', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');

    const scope = req.body.scope === 'global' ? null : Number(req.body.scope);
    const minutes = Number(req.body.minutes);
    const count = Number(req.body.count);
    const expires = String(req.body.expires ?? '').trim() || null;

    const scopeOk = scope === null ||
      (Number.isInteger(scope) && db.prepare('SELECT 1 FROM clients WHERE id = ?').get(scope));
    // Refused rather than clamped, unlike a kid's Request: this is the Admin filling in a form,
    // and silently minting something other than what was typed is worse than asking again.
    const ok = scopeOk &&
      Number.isInteger(minutes) && minutes >= 1 && minutes <= 999 &&
      Number.isInteger(count) && count >= 1 && count <= MAX_MINT_COUNT &&
      (expires === null || DATE_SHAPE.test(expires));
    if (!ok) return reply.redirect(back(T(req, 'err.couponBadInput'), false));

    const minted = mintCoupons(db, { clientId: scope, minutes, expires, count });
    return reply.redirect(back(T(req, 'ok.couponsMinted', [minted.length])));
  });

  app.post('/coupons/delete', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');
    const ids = [req.body.id ?? []].flat();
    const gone = deleteCoupons(db, ids);
    return reply.redirect(back(T(req, 'ok.couponsDeleted', [gone])));
  });
}
```

- [ ] **Step 5: Register it in `server/src/app.js`** — add `import couponRoutes from './routes/coupons.js';` beside the other route imports, and `app.register(couponRoutes);` beside `app.register(backgroundRoutes);`.

- [ ] **Step 6: Write `server/views/coupons.ejs`.** Follow the markup idiom of the reskinned pages (`family-code-manage.ejs`: `<h1>`, `<article>`, plain classed elements — ADR-0016). Structure:

```html
<h1><%= t('coupons.title') %></h1>

<% if (error) { %><p class="error"><%= error %></p><% } %>
<% if (ok) { %><p class="ok"><%= ok %></p><% } %>

<p class="muted"><%= t('coupons.lead') %></p>

<article>
  <h2><%= t('coupons.add') %></h2>
  <form method="post" action="/coupons" class="inline-row">
    <label><%= t('coupons.scope') %>
      <select name="scope">
        <option value="global"><%= t('coupons.scopeGlobal') %></option>
        <% for (const c of clients) { %><option value="<%= c.id %>"><%= c.name %></option><% } %>
      </select>
    </label>
    <label><%= t('coupons.minutes') %>
      <input type="number" name="minutes" min="1" max="999" value="30" required>
    </label>
    <label><%= t('coupons.expiry') %>
      <input type="date" name="expires" min="<%= today %>" placeholder="<%= t('coupons.expiryNone') %>">
    </label>
    <label><%= t('coupons.count') %>
      <input type="number" name="count" min="1" max="<%= maxCount %>" value="1" required>
    </label>
    <button><%= t('coupons.mint') %></button>
  </form>
</article>

<article>
  <% if (coupons.length === 0) { %>
    <p class="muted"><%= t('coupons.empty') %></p>
  <% } else { %>
    <%# One form, two verbs: the print button is a GET override, delete a POST override, so the
        same checkboxes drive both without a line of JavaScript. %>
    <form method="post" action="/coupons/delete" id="coupon-form">
      <div class="inline-row">
        <button formaction="/coupons/print" formmethod="get" formtarget="_blank" class="quiet">
          <%= t('coupons.print') %></button>
        <button class="danger"
                onclick="return confirm(<%= JSON.stringify(t('coupons.deleteConfirm')) %>)">
          <%= t('coupons.delete') %></button>
      </div>
      <table>
        <thead><tr>
          <th></th><th><%= t('coupons.code') %></th><th><%= t('coupons.minutes') %></th>
          <th><%= t('coupons.scope') %></th><th><%= t('coupons.expiry') %></th>
          <th><%= t('coupons.state') %></th><th></th>
        </tr></thead>
        <tbody>
        <% for (const c of coupons) { %>
          <tr>
            <td><input type="checkbox" name="id" value="<%= c.id %>"></td>
            <td class="code-cell"><%= grouped(c.code) %></td>
            <td><%= c.minutes %></td>
            <td><%= c.client_id === null ? t('coupons.scopeGlobal') : (c.client_name ?? '—') %></td>
            <td><%= c.expires_on ?? t('coupons.expiryNone') %></td>
            <td><%
              if (c.used_at) { %><%= t('coupons.stateUsed', [c.used_by_name ?? '—', c.used_at.slice(0, 10)]) %><% }
              else if (c.expires_on && c.expires_on < today) { %><%= t('coupons.stateExpired') %><% }
              else { %><%= t('coupons.stateUnused') %><% } %></td>
            <td><button type="button" class="quiet copy-code" data-code="<%= c.code %>"
                        data-copied="<%= t('coupons.copied') %>"><%= t('coupons.copy') %></button></td>
          </tr>
        <% } %>
        </tbody>
      </table>
    </form>
  <% } %>
</article>

<%# The clipboard carries the bare code, never the dashes (ADR-0014): a coupon pasted from a
    messaging app must parse on a Client that has not been updated to tolerate separators. %>
<script>
  for (const btn of document.querySelectorAll('.copy-code')) {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.code);
        const was = btn.textContent;
        btn.textContent = btn.dataset.copied;
        setTimeout(() => { btn.textContent = was; }, 1500);
      } catch { /* an http origin without clipboard access: the code is on screen to select */ }
    });
  }
</script>
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server && node --test test/coupons-routes.test.js && npm test`
Expected: PASS, including `i18n.test.js`.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/coupons.js server/views/coupons.ejs server/src/app.js server/locales/en.json server/locales/hu.json server/test/coupons-routes.test.js
git commit -m "Give the admin a Time Coupons page: mint, list, copy, delete"
```

---

### Task 4: The printable A4 sheet

**Files:**
- Modify: `server/src/routes/coupons.js` (add `GET /coupons/print`)
- Create: `server/views/coupons-print.ejs`
- Create: `server/views/print-layout.ejs`
- Modify: `server/locales/en.json`, `server/locales/hu.json`
- Test: extend `server/test/coupons-routes.test.js`

**Interfaces:**
- Consumes: the `id` checkboxes from Task 3's form (arrive as `?id=1&id=2` on GET), `listCoupons`.
- Produces: a standalone print page (no app nav) that the browser's print dialog renders as A4, two columns of cut-out tickets, in the admin UI language.

- [ ] **Step 1: Add locale keys** (both files):

```
"print.coupon": "Time Coupon"                → "Időkupon"
"print.worth": "Worth {0} minutes"           → "{0} perc értékben"
"print.validThrough": "Valid through {0}"    → "Beváltható eddig: {0}"
"print.noExpiry": "No expiration"            → "Nincs lejárat"
"print.anyComputer": "Good on any computer"  → "Bármelyik gépen beváltható"
"print.onlyFor": "Only for: {0}"             → "Csak ehhez a géphez: {0}"
```

- [ ] **Step 2: Write the failing test** (append to `coupons-routes.test.js`):

```js
test('the print sheet renders exactly the selected coupons, ticket by ticket', async (t) => {
  const { app, cookie } = startServer(t);
  await app.inject({
    method: 'POST', url: '/coupons', headers: { cookie },
    payload: 'scope=global&minutes=30&expires=2026-12-31&count=2',
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
    payload: 'scope=global&minutes=15&expires=&count=1',
  });
  const [c] = listCoupons(app.db);
  const res = await app.inject({
    method: 'GET', url: `/coupons/print?id=${c.id}`, headers: { cookie },
  });
  // On a physical coupon a missing line reads as "forgot to fill it in", not "forever" (grill Q10).
  assert.match(res.body, /No expiration/);
});
```

Run: `cd server && node --test test/coupons-routes.test.js` — Expected: FAIL (404 on /coupons/print).

- [ ] **Step 3: Create `server/views/print-layout.ejs`** — a minimal document so the tickets render without the app shell (`@fastify/view` accepts a per-render `layout` option):

```html
<!DOCTYPE html>
<html lang="<%= lang %>">
<head>
  <meta charset="utf-8">
  <title><%= title %></title>
</head>
<body><%- body %></body>
</html>
```

- [ ] **Step 4: Add the route** to `server/src/routes/coupons.js`:

```js
  app.get('/coupons/print', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');
    const wanted = new Set([req.query.id ?? []].flat().map(Number));
    const coupons = listCoupons(db).filter((c) => wanted.has(c.id)).reverse();
    if (coupons.length === 0) return reply.redirect('/coupons');
    // What is selected prints — used and expired included: second-guessing a selection is worse
    // than trusting it, and the normal flow (mint, select batch, print) never hits the odd cases.
    return reply.view('coupons-print.ejs',
      { title: T(req, 'title.coupons'), coupons, grouped },
      { layout: 'print-layout.ejs' });
  });
```

- [ ] **Step 5: Create `server/views/coupons-print.ejs`:**

```html
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: system-ui, sans-serif; margin: 0; color: #000; background: #fff; }
  .sheet { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
  .ticket {
    border: 1.5px dashed #888; border-radius: 4mm; padding: 6mm 5mm;
    break-inside: avoid; text-align: center;
  }
  .ticket .brand { font-size: 10pt; letter-spacing: .08em; text-transform: uppercase; color: #555; }
  .ticket .code { font-size: 20pt; font-weight: 700; letter-spacing: .06em; margin: 4mm 0; font-variant-numeric: tabular-nums; }
  .ticket .worth { font-size: 13pt; margin: 0 0 2mm; }
  .ticket .meta { font-size: 9.5pt; color: #444; margin: 1mm 0 0; }
  .toolbar { padding: 8px; text-align: center; }
  @media print { .toolbar { display: none; } }
</style>

<div class="toolbar"><button onclick="window.print()">🖨</button></div>

<div class="sheet">
<% for (const c of coupons) { %>
  <div class="ticket">
    <div class="brand">Digital Aid — <%= t('print.coupon') %></div>
    <div class="code"><%= grouped(c.code) %></div>
    <p class="worth"><%= t('print.worth', [c.minutes]) %></p>
    <p class="meta"><%= c.client_id === null ? t('print.anyComputer') : t('print.onlyFor', [c.client_name ?? '—']) %></p>
    <p class="meta"><%= c.expires_on ? t('print.validThrough', [c.expires_on]) : t('print.noExpiry') %></p>
  </div>
<% } %>
</div>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && node --test test/coupons-routes.test.js && npm test`
Expected: PASS. If the `{ layout: 'print-layout.ejs' }` per-render override is not honoured by the installed `@fastify/view` version (the `tabbar` assertion will catch it), fall back to `reply.type('text/html').send(await ejs.renderFile(...))` with an explicit `import ejs from 'ejs'` — do not ship the print page inside the app layout.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/coupons.js server/views/coupons-print.ejs server/views/print-layout.ejs server/locales/en.json server/locales/hu.json server/test/coupons-routes.test.js
git commit -m "Print selected Time Coupons as cut-out A4 tickets"
```

---

### Task 5: Codes page — heading fix and the coupons panel

**Files:**
- Modify: `server/views/family-code-manage.ejs:7` (heading) and append one article
- Modify: `server/locales/en.json`, `server/locales/hu.json`
- Test: extend `server/test/coupons-routes.test.js`

- [ ] **Step 1: Write the failing test:**

```js
test('the Codes page is headed Codes and offers the way to Time Coupons', async (t) => {
  const { app, cookie } = startServer(t);
  const res = await app.inject({ method: 'GET', url: '/family-code', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<h1>Codes<\/h1>/);
  // The Admin Code card keeps its own name — only the page heading was wrong.
  assert.match(res.body, /Admin Code/);
  assert.match(res.body, /href="\/coupons"/);
});
```

Run: `cd server && node --test test/coupons-routes.test.js` — Expected: FAIL on the `<h1>` match.

- [ ] **Step 2: Fix the heading.** In `family-code-manage.ejs` line 7, the `<h1>` currently reuses `codes.title` ("Admin Code") — which is also, correctly, the Admin Code card's `<h2>` at line 68. Change **only the h1** to the existing page-title key:

```html
<h1><%= t('title.codes') %></h1>
```

Do **not** change the `codes.title` locale value — the card at line 68 still needs "Admin Code"/"Adminkód".

- [ ] **Step 3: Add the panel.** After the Extra Time Code `</article>` (line 65) insert:

```html
<article>
  <h2><%= t('codes.couponsTitle') %></h2>
  <p class="muted"><small><%= t('codes.couponsLead') %></small></p>
  <a href="/coupons" role="button"><%= t('codes.couponsOpen') %></a>
</article>
```

With locale keys (both files):

```
"codes.couponsTitle": "Time Coupons"   → "Időkuponok"
"codes.couponsLead": "Pre-made time codes you can print and hand out — spent whenever the kid chooses, checked by the server."
                                       → "Előre elkészített idő-kódok, amelyeket kinyomtathatsz és odaadhatsz — a gyerek akkor váltja be, amikor szeretné, a szerver ellenőrzi."
"codes.couponsOpen": "Time Coupons"    → "Időkuponok"
```

If the Beer CSS skin styles buttons via a class rather than `role="button"`, match whatever the reskinned pages use for a link-button (check `settings.ejs` for the idiom and copy it).

- [ ] **Step 4: Run tests, then commit**

Run: `cd server && npm test` — Expected: PASS.

```bash
git add server/views/family-code-manage.ejs server/locales/en.json server/locales/hu.json server/test/coupons-routes.test.js
git commit -m "Head the Codes page Codes, and open the door to Time Coupons"
```

---

### Task 6: `CouponCode` in Client.Core

**Files:**
- Create: `client/Client.Core/CouponCode.cs`
- Modify: `client/Client.Core/GrantCode.cs` (make `Strip` internal)
- Test: `client/Client.Core.Tests/CouponCodeTests.cs`

**Interfaces:**
- Produces: `CouponCode.Alphabet` (const string), `CouponCode.TryParse(string? input, out string code, out int minutes)` (code = canonical uppercase 9-char), `CouponCode.LooksLikeCoupon(string? input)` (any ASCII letter after stripping → route to the coupon path), `CouponCode.Format(string? code)` (`KRT-VXM-030`).

- [ ] **Step 1: Write the failing tests** — `client/Client.Core.Tests/CouponCodeTests.cs`:

```csharp
using DigitalAid.Client.Core;

namespace Client.Core.Tests;

// A Time Coupon is told apart from an Extra Time Code by its letters (ADR-0017): the parser is the
// dispatcher, so its edges are the feature's edges.
public class CouponCodeTests
{
    [Fact]
    public void Alphabet_is_the_19_unambiguous_consonants()
    {
        Assert.Equal("BCDFGHJKMNPQRSTVWXZ", CouponCode.Alphabet);
    }

    [Theory]
    [InlineData("KRTVXM030", "KRTVXM030", 30)]
    [InlineData("krtvxm030", "KRTVXM030", 30)]     // case-insensitive entry
    [InlineData("KRT-VXM-030", "KRTVXM030", 30)]   // shown in threes, typed back with dashes
    [InlineData("krt vxm 005", "KRTVXM005", 5)]
    public void Parses_to_the_canonical_uppercase_form(string input, string code, int minutes)
    {
        Assert.True(CouponCode.TryParse(input, out var c, out var m));
        Assert.Equal(code, c);
        Assert.Equal(minutes, m);
    }

    [Theory]
    [InlineData("482102015")]    // all digits: an Extra Time Code, not a coupon
    [InlineData("KRTVXM03")]     // short
    [InlineData("KRTVXM0300")]   // long
    [InlineData("KRTVXA030")]    // A is a vowel, not in the alphabet
    [InlineData("KRTVXM000")]    // zero minutes
    [InlineData("KRTVX7030")]    // digit where a letter belongs
    [InlineData("")]
    [InlineData(null)]
    public void Rejects_everything_that_is_not_coupon_shaped(string? input)
    {
        Assert.False(CouponCode.TryParse(input, out _, out _));
    }

    [Theory]
    [InlineData("KRTVXM030", true)]
    [InlineData("krt-vxm-030", true)]
    [InlineData("482102015", false)]   // digits go down the offline seed path, untouched
    [InlineData("482-102-015", false)]
    public void Letters_route_to_the_coupon_path(string input, bool expected)
    {
        Assert.Equal(expected, CouponCode.LooksLikeCoupon(input));
    }

    [Fact]
    public void Formats_in_threes_for_display_only()
    {
        Assert.Equal("KRT-VXM-030", CouponCode.Format("krtvxm030"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && dotnet test --filter CouponCodeTests`
Expected: FAIL — `CouponCode` does not exist.

- [ ] **Step 3: In `GrantCode.cs`, change `private static string Strip` to `internal static string Strip`** (the separator list and its rationale stay where they are; `CouponCode` reuses it so there is exactly one definition of "what a code sheds on entry").

- [ ] **Step 4: Write `client/Client.Core/CouponCode.cs`:**

```csharp
namespace DigitalAid.Client.Core;

/// <summary>
/// Time Coupons: <c>[6 letters][3-digit minutes]</c> — <c>KRTVXM030</c>, shown as
/// <c>KRT-VXM-030</c>. The letters are the dispatcher (ADR-0017): an all-digit code goes down the
/// offline Grant Seed path exactly as before, and anything with a letter in it is a coupon, which
/// only the server can judge. Nothing here verifies — there is no seed to verify against, and that
/// is the point: the coupon inventory lives on the server and nowhere else.
/// </summary>
public static class CouponCode
{
    /// <summary>19 consonants: no vowels, so six random letters can never spell a word on a slip
    /// handed to a child, and no I, L or O, so every printed glyph has one reading. Defined
    /// identically in <c>server/src/coupons.js</c>.</summary>
    public const string Alphabet = "BCDFGHJKMNPQRSTVWXZ";

    /// <summary>Whether this input belongs to the coupon path at all: any ASCII letter after the
    /// separators are gone. A malformed coupon still routes here — "KRTVXA030" must fail as a bad
    /// coupon, not fall through and fail as a bad Extra Time Code.</summary>
    public static bool LooksLikeCoupon(string? input) =>
        GrantCode.Strip(input).Any(char.IsAsciiLetter);

    /// <summary>Canonical form out: uppercase, separator-free, exactly six alphabet letters and the
    /// minutes. Format only — validity is the server's answer, not this method's.</summary>
    public static bool TryParse(string? input, out string code, out int minutes)
    {
        code = string.Empty;
        minutes = 0;

        var s = GrantCode.Strip(input).ToUpperInvariant();
        if (s.Length != 9) return false;
        if (!s[..6].All(c => Alphabet.Contains(c))) return false;
        if (!s[6..].All(char.IsAsciiDigit)) return false;

        var m = int.Parse(s[6..]);
        if (m < 1) return false;

        code = s;
        minutes = m;
        return true;
    }

    /// <summary>How a coupon is shown: <c>KRT-VXM-030</c>. Presentation only — never stored, never
    /// sent, never put on a clipboard (ADR-0014).</summary>
    public static string Format(string? code)
    {
        var s = GrantCode.Strip(code).ToUpperInvariant();
        return s.Length == 9 ? $"{s[..3]}-{s[3..6]}-{s[6..]}" : s;
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client && dotnet test --filter CouponCodeTests` then the full `dotnet test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/Client.Core/CouponCode.cs client/Client.Core/GrantCode.cs client/Client.Core.Tests/CouponCodeTests.cs
git commit -m "Teach the client to recognise a Time Coupon by its letters"
```

---

### Task 7: Client protocol v4 — `coupon` out, `coupon-status` in

**Files:**
- Modify: `client/Client.Core/Protocol.cs`
- Test: extend `client/Client.Core.Tests/ProtocolTests.cs`

**Interfaces:**
- Consumes: wire shapes frozen in Task 2.
- Produces: `Protocol.Version = 4`; `ClientMessages.Coupon(string code) → string` (JSON `{"type":"coupon","code":...}`); `public enum CouponState { Unknown, Granted, Used, Expired, WrongClient, Invalid }`; `ServerMessage.CouponStatus(CouponState State, int Minutes)`; parser case `"coupon-status"`.

- [ ] **Step 1: Write the failing tests** (append to `ProtocolTests.cs`, matching its idiom):

```csharp
    [Fact]
    public void Coupon_message_carries_the_canonical_code()
    {
        var json = ClientMessages.Coupon("KRTVXM030");
        Assert.Contains("\"type\":\"coupon\"", json);
        Assert.Contains("\"code\":\"KRTVXM030\"", json);
    }

    [Theory]
    [InlineData("granted", CouponState.Granted)]
    [InlineData("used", CouponState.Used)]
    [InlineData("expired", CouponState.Expired)]
    [InlineData("wrong-client", CouponState.WrongClient)]
    [InlineData("invalid", CouponState.Invalid)]
    [InlineData("something-newer", CouponState.Unknown)]   // a newer server may add one (PROTOCOL §1)
    public void Coupon_status_parses_each_state(string wire, CouponState expected)
    {
        var msg = ServerMessageParser.Parse($$"""{"type":"coupon-status","state":"{{wire}}","minutes":30}""");
        var status = Assert.IsType<ServerMessage.CouponStatus>(msg);
        Assert.Equal(expected, status.State);
        Assert.Equal(30, status.Minutes);
    }

    [Fact]
    public void Coupon_status_without_minutes_parses_as_zero()
    {
        var msg = ServerMessageParser.Parse("""{"type":"coupon-status","state":"used"}""");
        Assert.Equal(0, Assert.IsType<ServerMessage.CouponStatus>(msg).Minutes);
    }
```

Run: `cd client && dotnet test --filter ProtocolTests` — Expected: FAIL (types missing).

- [ ] **Step 2: Implement in `Protocol.cs`:**
  - `Protocol.Version` → `4`.
  - In `ClientMessages`, beside `TimeRequest`:

```csharp
    /// <summary>Redeem a Time Coupon (PROTOCOL §5.4). Canonical form only: uppercase, no
    /// separators. Live-only like a request — a coupon typed while offline is refused on the spot
    /// and stays good, never queued (ADR-0017).</summary>
    public static string Coupon(string code) =>
        JsonSerializer.Serialize(new CouponDto(code), Options);

    private sealed record CouponDto([property: JsonPropertyName("code")] string Code)
    {
        [JsonPropertyName("type")] public string Type => "coupon";
    }
```

  - The enum + record, beside `RequestState` / `RequestStatus`:

```csharp
/// <summary>The server's verdict on a Time Coupon (PROTOCOL §6.10). Unknown states parse as
/// <see cref="Unknown"/> and are shown as "not valid", so a newer server may add one.</summary>
public enum CouponState { Unknown, Granted, Used, Expired, WrongClient, Invalid }
```

```csharp
    /// <summary>The answer to a <c>coupon</c> message (PROTOCOL §6.10). <c>Minutes</c> is only
    /// meaningful with <see cref="CouponState.Granted"/>.</summary>
    public sealed record CouponStatus(CouponState State, int Minutes) : ServerMessage;
```

  - Parser case, beside `"request-status"`:

```csharp
                "coupon-status" => new ServerMessage.CouponStatus(
                    obj["state"]?.GetValue<string>() switch
                    {
                        "granted" => CouponState.Granted,
                        "used" => CouponState.Used,
                        "expired" => CouponState.Expired,
                        "wrong-client" => CouponState.WrongClient,
                        "invalid" => CouponState.Invalid,
                        _ => CouponState.Unknown,
                    },
                    obj["minutes"]?.GetValue<int>() ?? 0),
```

- [ ] **Step 3: Run tests** — `cd client && dotnet test` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/Client.Core/Protocol.cs client/Client.Core.Tests/ProtocolTests.cs
git commit -m "Speak protocol v4: coupon out, coupon-status back"
```

---

### Task 8: `BonusSeconds` — the Allowance top-up in the engine

**Files:**
- Modify: `client/Client.Core/EnforcementEngine.cs`
- Modify: `client/Client.Core/ClientState.cs` (`PersistedSnapshot`)
- Test: extend `client/Client.Core.Tests/EnforcementEngineTests.cs`, `client/Client.Core.Tests/StateStoreTests.cs` if it round-trips snapshots

**Interfaces:**
- Produces: `EnforcementEngine.BonusSeconds` (int, get), `EnforcementEngine.AddAllowanceBonus(int minutes)`; `EngineSnapshot` gains trailing `int BonusSeconds = 0`; `PersistedSnapshot` gains trailing `int BonusSeconds = 0` (a JSON default, so an existing state file on disk loads unchanged).

- [ ] **Step 1: Write the failing tests** (append to `EnforcementEngineTests.cs`, using its existing helpers for constructing engines/settings — read the file's top first and reuse its factory idiom):

```csharp
    // --- Time Coupons: an Allowance top-up, never a Grant (ADR-0017) --------------------

    [Fact]
    public void Coupon_bonus_extends_todays_allowance()
    {
        var engine = EngineAt(hour: 10);                // helper idiom from this file
        var before = engine.AllowanceRemainingSeconds;
        engine.AddAllowanceBonus(30);
        Assert.Equal(before + 30 * 60, engine.AllowanceRemainingSeconds);
        Assert.Equal(TimeLeftKind.Allowance, engine.TimeLeft.Kind);
    }

    [Fact]
    public void Coupon_bonus_unblocks_an_exhausted_allowance_but_not_downtime()
    {
        var engine = EngineAt(hour: 10);
        engine.EndToday();
        Tick(engine, hour: 10);
        Assert.Equal(EnforcementState.Blocked, engine.State);

        engine.AddAllowanceBonus(30);
        Tick(engine, hour: 10);
        Assert.Equal(EnforcementState.Active, engine.State);   // beats an empty Allowance…

        Tick(engine, hour: 22);                                // …but Downtime still wins
        Assert.Equal(EnforcementState.Blocked, engine.State);
    }

    [Fact]
    public void Coupon_bonus_dies_at_local_midnight()
    {
        var engine = EngineAt(hour: 10);
        engine.AddAllowanceBonus(30);
        Tick(engine, hour: 10, nextDay: true);                 // date rolls
        Assert.Equal(0, engine.BonusSeconds);
    }

    [Fact]
    public void EndToday_drains_the_bonus_too()
    {
        // "Drain the rest of today's Time Left" (CONTEXT.md: End Today) — all of it, coupons included.
        var engine = EngineAt(hour: 10);
        engine.AddAllowanceBonus(30);
        engine.EndToday();
        Assert.Equal(0, engine.AllowanceRemainingSeconds);
    }

    [Fact]
    public void Bonus_survives_a_snapshot_round_trip()
    {
        var engine = EngineAt(hour: 10);
        engine.AddAllowanceBonus(30);
        var restored = new EnforcementEngine(DefaultSettings, "secret", engine.Snapshot());
        Assert.Equal(engine.BonusSeconds, restored.BonusSeconds);
    }
```

Adapt `EngineAt` / `Tick` / `DefaultSettings` to the file's actual helper names — the assertions above are the contract; the construction idiom must match what is already there. If no such helpers exist, write the ticks out longhand as neighbouring tests in that file do.

Run: `cd client && dotnet test --filter EnforcementEngineTests` — Expected: FAIL.

- [ ] **Step 2: Implement in `EnforcementEngine.cs`:**
  - Property + snapshot plumbing:

```csharp
    /// <summary>Today's Time Coupon top-up, in seconds (ADR-0017). Part of the Allowance rather
    /// than a Grant on purpose: it pauses on lock, Downtime beats it, and it dies at local
    /// midnight — a standing promise carries no live parental intent, and only live intent beats
    /// Downtime. Redeemed coupons land here via <see cref="AddAllowanceBonus"/>.</summary>
    public int BonusSeconds { get; private set; }
```

  - Constructor: `BonusSeconds = snapshot?.BonusSeconds ?? 0;`
  - `Snapshot()`: append `BonusSeconds`.
  - `AllowanceRemainingSeconds` becomes:

```csharp
    public int AllowanceRemainingSeconds =>
        Math.Max(0, Settings.AllowanceMinutesFor(Date) * 60 + BonusSeconds - UsedSeconds);
```

  - In `Tick`, inside the `today != Date` block, add `BonusSeconds = 0;` beside `UsedSeconds = 0;`.
  - `EndToday()` must drain the bonus too:

```csharp
    public void EndToday()
    {
        UsedSeconds = Settings.AllowanceMinutesFor(Date) * 60 + BonusSeconds;
        GrantRemainingSeconds = 0;
    }
```

  - New method beside `ApplyAdjustment`:

```csharp
    /// <summary>A Time Coupon the server accepted. Top-up only — the server has already spent the
    /// coupon, so this must not fail; clamping happened at minting.</summary>
    public void AddAllowanceBonus(int minutes)
    {
        BonusSeconds += minutes * 60;
        ResetWarnings();
    }
```

  - `EngineSnapshot`: append `int BonusSeconds = 0` as the last positional parameter.

- [ ] **Step 3: Extend `PersistedSnapshot` in `ClientState.cs`** — append `int BonusSeconds = 0` to the record, thread it through `From(...)` and `ToSnapshot()`. Trailing-with-default keeps every existing state file on disk loading as before.

- [ ] **Step 4: Run the full client suite** — `cd client && dotnet test` — Expected: PASS (including StateStore round-trip tests).

- [ ] **Step 5: Commit**

```bash
git add client/Client.Core/EnforcementEngine.cs client/Client.Core/ClientState.cs client/Client.Core.Tests/EnforcementEngineTests.cs
git commit -m "Let a redeemed coupon top up today's Allowance, and only today's"
```

---

### Task 9: `ClientAgent` — the gate, the verdict, the Event

**Files:**
- Modify: `client/Client.Core/ClientAgent.cs`
- Modify: `client/Client.Core/ClientEvent.cs` (`EventTypes.CouponRedeemed`)
- Test: extend `client/Client.Core.Tests/ClientAgentTests.cs`

**Interfaces:**
- Consumes: `CouponCode.TryParse` (Task 6), `ClientMessages.Coupon` / `ServerMessage.CouponStatus` / `CouponState` (Task 7), `AddAllowanceBonus` (Task 8).
- Produces: `public enum CouponGate { Send, InvalidFormat, Downtime }`; `ClientAgent.PrepareCouponRedeem(string? input, DateTimeOffset localNow, out string? json) → CouponGate`; `Handle(CouponStatus)` returning `ShowNotice` instructions with new `NoticeKind` values `CouponGranted, CouponAlreadyUsed, CouponExpired, CouponWrongClient, CouponInvalid`; Event `coupon-redeemed` `{code, minutes}`.

- [ ] **Step 1: Write the failing tests** (append to `ClientAgentTests.cs`, reusing its agent-construction helpers — read its top first):

```csharp
    // --- Time Coupons (ADR-0017) --------------------------------------------------------

    [Fact]
    public void A_coupon_is_prepared_for_the_server_in_canonical_form()
    {
        var agent = PairedAgent();                       // this file's helper idiom
        var gate = agent.PrepareCouponRedeem("krt-vxm 030", Daytime, out var json);
        Assert.Equal(CouponGate.Send, gate);
        Assert.Contains("\"code\":\"KRTVXM030\"", json);
    }

    [Fact]
    public void A_code_that_is_not_coupon_shaped_is_refused_before_any_send()
    {
        var agent = PairedAgent();
        Assert.Equal(CouponGate.InvalidFormat, agent.PrepareCouponRedeem("KRTVXA030", Daytime, out var json));
        Assert.Null(json);
    }

    [Fact]
    public void During_downtime_the_coupon_is_refused_locally_and_stays_unspent()
    {
        // Client-side, before the server is asked: an accepted coupon during Downtime would buy
        // minutes the kid cannot reach before midnight kills them (ADR-0017).
        var agent = PairedAgent();
        Assert.Equal(CouponGate.Downtime, agent.PrepareCouponRedeem("KRTVXM030", DuringDowntime, out var json));
        Assert.Null(json);
    }

    [Fact]
    public void Granted_adds_the_bonus_logs_the_event_and_says_so()
    {
        var agent = PairedAgent();
        agent.PrepareCouponRedeem("KRTVXM030", Daytime, out _);
        var instructions = agent.Handle(new ServerMessage.CouponStatus(CouponState.Granted, 30), Daytime);

        var notice = Assert.Single(instructions);
        Assert.Equal(HostAction.ShowNotice, notice.Action);
        Assert.Equal(NoticeKind.CouponGranted, notice.Notice);
        Assert.Equal(30, notice.Minutes);

        var batch = agent.TakeEventBatch();
        Assert.NotNull(batch);
        Assert.Contains("coupon-redeemed", batch!.Json);
        Assert.Contains("KRTVXM030", batch.Json);
    }

    [Theory]
    [InlineData(CouponState.Used, NoticeKind.CouponAlreadyUsed)]
    [InlineData(CouponState.Expired, NoticeKind.CouponExpired)]
    [InlineData(CouponState.WrongClient, NoticeKind.CouponWrongClient)]
    [InlineData(CouponState.Invalid, NoticeKind.CouponInvalid)]
    [InlineData(CouponState.Unknown, NoticeKind.CouponInvalid)]
    public void Refusals_are_honest_and_change_nothing(CouponState state, NoticeKind expected)
    {
        var agent = PairedAgent();
        agent.PrepareCouponRedeem("KRTVXM030", Daytime, out _);
        var instructions = agent.Handle(new ServerMessage.CouponStatus(state, 0), Daytime);

        Assert.Equal(expected, Assert.Single(instructions).Notice);
        Assert.Null(agent.TakeEventBatch());   // no event for a refusal; a typo is not news
    }
```

Adapt helper names (`PairedAgent`, `Daytime`, `DuringDowntime`) to what `ClientAgentTests.cs` actually provides; construct times inside/outside the default `21:00–07:00` downtime window if no helpers exist.

Run: `cd client && dotnet test --filter ClientAgentTests` — Expected: FAIL.

- [ ] **Step 2: Implement.**
  - `ClientEvent.cs`, in `EventTypes`: `public const string CouponRedeemed = "coupon-redeemed";`
  - `ClientAgent.cs`, in `NoticeKind` (it lives in this file): add

```csharp
    /// <summary>The server accepted a Time Coupon. Carries the minutes added to today.</summary>
    CouponGranted,
    /// <summary>The coupon was already spent — single-use, first come first served.</summary>
    CouponAlreadyUsed,
    /// <summary>The coupon's date has passed.</summary>
    CouponExpired,
    /// <summary>The coupon is tied to a different Client.</summary>
    CouponWrongClient,
    /// <summary>Unknown or revoked — indistinguishable by design (revoke is delete, ADR-0017).</summary>
    CouponInvalid,
```

  - New enum beside `LaunchKind`:

```csharp
/// <summary>Whether a typed coupon may be sent to the server, and if not, why not. Offline is not
/// here on purpose — the agent does not hold the socket; the shell answers that one.</summary>
public enum CouponGate { Send, InvalidFormat, Downtime }
```

  - In `ClientAgent`, a field and two members:

```csharp
    /// <summary>The coupon most recently sent, canonical form — kept so the granted verdict can log
    /// which coupon it was. One in flight at a time is the shell's contract.</summary>
    private string? _pendingCouponCode;

    /// <summary>Gate a typed Time Coupon and build the message for the shell to send. Downtime is
    /// refused here, before any send, so a coupon typed at the night cover stays unspent
    /// (ADR-0017). Format is checked here too: a malformed coupon must not reach the wire.</summary>
    public CouponGate PrepareCouponRedeem(string? input, DateTimeOffset localNow, out string? json)
    {
        json = null;
        if (!CouponCode.TryParse(input, out var code, out _)) return CouponGate.InvalidFormat;
        if (_state.Settings.ToSettings().IsDowntime(TimeOnly.FromDateTime(localNow.DateTime)))
            return CouponGate.Downtime;

        _pendingCouponCode = code;
        json = ClientMessages.Coupon(code);
        return CouponGate.Send;
    }
```

  - In `Handle`, a new case beside `RequestStatus`:

```csharp
            case ServerMessage.CouponStatus coupon:
                instructions.AddRange(HandleCouponStatus(coupon, localNow));
                break;
```

  - And the handler beside `HandleRequestStatus`:

```csharp
    private IReadOnlyList<HostInstruction> HandleCouponStatus(
        ServerMessage.CouponStatus status, DateTimeOffset localNow)
    {
        if (status.State == CouponState.Granted)
        {
            // The server has already spent the coupon; all that is left is to honour it. The code
            // goes in the payload because the parent's list may no longer hold this coupon —
            // revoke is delete, and the timeline is the audit (ADR-0017).
            _engine.AddAllowanceBonus(status.Minutes);
            Enqueue(localNow, EventTypes.CouponRedeemed, new JsonObject
            {
                ["code"] = _pendingCouponCode ?? "",
                ["minutes"] = status.Minutes,
            });
            _pendingCouponCode = null;
            PersistCounters();
            return [new HostInstruction(HostAction.ShowNotice,
                Notice: NoticeKind.CouponGranted, Minutes: status.Minutes)];
        }

        // A refusal changes nothing and logs nothing — a typo is not news. But it is answered
        // honestly (ADR-0017): spent, expired and wrong-machine are different sentences.
        _pendingCouponCode = null;
        var notice = status.State switch
        {
            CouponState.Used => NoticeKind.CouponAlreadyUsed,
            CouponState.Expired => NoticeKind.CouponExpired,
            CouponState.WrongClient => NoticeKind.CouponWrongClient,
            _ => NoticeKind.CouponInvalid,
        };
        return [new HostInstruction(HostAction.ShowNotice, Notice: notice)];
    }
```

- [ ] **Step 3: Run the full client suite** — `cd client && dotnet test` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/Client.Core/ClientAgent.cs client/Client.Core/ClientEvent.cs client/Client.Core.Tests/ClientAgentTests.cs
git commit -m "Gate, redeem and log Time Coupons in the client agent"
```

---

### Task 10: The shell — letters in the box, an answer from the wire

**Files:**
- Modify: `client/Client.Core/Strings.resx`, `client/Client.Core/Strings.hu.resx`
- Modify: `client/Client.App/Ui/ExtraTimeCodeEntry.cs`
- Modify: `client/Client.App/Ui/BlockWindow.cs`
- Modify: `client/Client.App/AppHost.cs`

**Interfaces:**
- Consumes: `CouponGate`, `PrepareCouponRedeem`, `CouponStatus` handling (Task 9); `_link.IsConnected` / `TrySendAsync` (existing `ServerLink`).
- Produces: both entry surfaces accept a coupon delegate `Func<string, Task<string?>>` — returns **null on success**, or the localized refusal sentence to show; `AppHost.RedeemCouponAsync(string input) → Task<string?>` implementing it.

- [ ] **Step 1: Add the strings** (both resx files; `StringsTests` enforces en/hu parity, so add in the same commit):

```
CouponChecking     en: "Checking the coupon…"                                    hu: "Kupon ellenőrzése…"
CouponGranted      en: "Coupon accepted — {0} minutes added to today."           hu: "Kupon elfogadva — {0} perc hozzáadva a mai naphoz."
CouponAlreadyUsed  en: "This coupon has already been used."                      hu: "Ezt a kupont már felhasználták."
CouponExpired      en: "This coupon has expired."                                hu: "Ez a kupon lejárt."
CouponWrongClient  en: "This coupon is for another computer."                    hu: "Ez a kupon egy másik géphez tartozik."
CouponInvalid      en: "This coupon isn't valid."                                hu: "Ez a kupon nem érvényes."
CouponOffline      en: "Coupons need the server — try again later."              hu: "A kuponhoz a szerver elérése szükséges — próbáld újra később."
CouponDowntime     en: "Coupons can't be used during downtime."                  hu: "Pihenőidő alatt nem váltható be kupon."
```

Run `cd client && dotnet test --filter StringsTests` — Expected: PASS.

- [ ] **Step 2: Extend `ExtraTimeCodeEntry`:**
  - Ctor gains `Func<string, Task<string?>>? redeemCoupon = null` (after `redeem`); store in `private readonly Func<string, Task<string?>>? _redeemCoupon;`.
  - `Regroup()` currently bails on any non-digit (`if (!bare.All(char.IsAsciiDigit)) return;`). Change to accept coupon characters and uppercase them as typed:

```csharp
        var bare = new string(raw.Where(c => c is not ('-' or ' ')).ToArray()).ToUpperInvariant();
        if (!bare.All(c => char.IsAsciiDigit(c) || char.IsAsciiLetter(c))) return;
```

    (Grouping logic is length-based and works unchanged for letters.) The two caret helpers count only digits today — `raw.Take(_input.CaretIndex).Count(char.IsAsciiDigit)` and the `char.IsAsciiDigit(text[i])` inside `CaretAfter` — which would misplace the cursor in a lettered code; change both to `char.IsAsciiLetterOrDigit`.
  - `Try()` dispatches by shape — letters go down the async path:

```csharp
    private async void Try()
    {
        if (_redeemCoupon is not null && CouponCode.LooksLikeCoupon(_input.Text))
        {
            // A coupon is the server's to judge (ADR-0017): disable the button, say "checking",
            // and show whichever honest sentence comes back. Null means it was granted.
            _input.IsEnabled = false;
            _feedback.Foreground = new SolidColorBrush(Color.FromRgb(0x66, 0x66, 0x66));
            _feedback.Text = Strings.CouponChecking;
            var refusal = await _redeemCoupon(_input.Text);
            _input.IsEnabled = true;
            if (refusal is null)
            {
                _feedback.Text = string.Empty;
                _input.Clear();
                Redeemed?.Invoke();
                return;
            }
            _feedback.Foreground = new SolidColorBrush(Color.FromRgb(0xB0, 0x3A, 0x2B));
            _feedback.Text = refusal;
            return;
        }

        var result = _redeem(_input.Text);
        // ... existing digit path unchanged ...
    }
```

- [ ] **Step 3: Extend `BlockWindow`** the same way: ctor gains `Func<string, Task<string?>>? redeemCoupon`, stored, and its own `Try` (around line 321) gets the identical letters-first dispatch in front of the existing `_redeem(_input.Text)` call, with the same checking/refusal feedback treatment its own feedback element uses. Its input filtering, if it restricts to digits, must also admit ASCII letters (mirror Step 2's `Regroup` change if `BlockWindow` has its own copy).

- [ ] **Step 4: Wire `AppHost`:**
  - Field: `private TaskCompletionSource<Core.ServerMessage.CouponStatus>? _couponWait;`
  - In `OnServerMessage(...)`, after the existing `foreach (var instruction in _agent.Handle(message, now)) ...` dispatch, add:

```csharp
        if (message is Core.ServerMessage.CouponStatus couponStatus)
            _couponWait?.TrySetResult(couponStatus);
```

    (Order matters: `Handle` has already applied the bonus and produced the toast by the time the waiter wakes, so the entry box and the enforcement state agree.)
  - The redeem method, beside `TryRedeem`:

```csharp
    /// <summary>Redeeming a Time Coupon, from wherever it was typed. Async because only the server
    /// can judge one (ADR-0017): gate locally (format, downtime), refuse honestly when the server
    /// is not there, then send and wait briefly for the coupon-status the agent will have already
    /// applied by the time it lands. Returns null on success, else the sentence to show.</summary>
    private async Task<string?> RedeemCouponAsync(string input)
    {
        var gate = _agent.PrepareCouponRedeem(input, DateTimeOffset.Now, out var json);
        if (gate == Core.CouponGate.InvalidFormat) return Strings.CouponInvalid;
        if (gate == Core.CouponGate.Downtime) return Strings.CouponDowntime;
        if (_link is null || !_link.IsConnected) return Strings.CouponOffline;

        _couponWait = new TaskCompletionSource<Core.ServerMessage.CouponStatus>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        if (!await _link.TrySendAsync(json!)) { _couponWait = null; return Strings.CouponOffline; }

        var answered = await Task.WhenAny(_couponWait.Task, Task.Delay(TimeSpan.FromSeconds(6)));
        var wait = _couponWait;
        _couponWait = null;
        // No answer is indistinguishable from no server — and the coupon is still good, which is
        // the one refusal that invites trying again (ADR-0017).
        if (answered != wait.Task) return Strings.CouponOffline;

        var status = wait.Task.Result;
        if (status.State != Core.CouponState.Granted)
            return status.State switch
            {
                Core.CouponState.Used => Strings.CouponAlreadyUsed,
                Core.CouponState.Expired => Strings.CouponExpired,
                Core.CouponState.WrongClient => Strings.CouponWrongClient,
                _ => Strings.CouponInvalid,
            };

        // Same aftermath as a redeemed Extra Time Code: the question answered itself, so close any
        // open Request, reflect the new state now rather than on the next tick, and tell the server.
        _ = WithdrawRequestAsync();
        Log("time coupon redeemed");
        var tick = _agent.Tick(DateTimeOffset.Now, TimeSpan.Zero, _sessionUnlocked, null);
        foreach (var instruction in tick.Instructions) Perform(instruction, tick);
        if (tick.State != Core.EnforcementState.Blocked) HideBlockScreen();
        _ = SendPingAsync(tick.PingJson);
        return null;
    }
```

  - Pass `RedeemCouponAsync` into every construction site: the `BlockWindow` creation (`AppHost.cs:262`), and each `ExtraTimeCodeEntry` construction (the tray's Extra Time Code window and the ask-for-more-time dialog — find them with `grep -n "ExtraTimeCodeEntry(" client/Client.App`).
  - `NoticeText(...)` gains the granted toast: `NoticeKind.CouponGranted => string.Format(Strings.CouponGranted, instruction.Minutes),` — the four refusal NoticeKinds need no `NoticeText` mapping (the entry box already showed the sentence; the agent's refusal instructions are only reached via `Handle` on a reconnect race, so map them too for safety: each to its `Strings.Coupon*` sentence).

- [ ] **Step 5: Build everything and run the full client suite**

Run: `cd client && dotnet build && dotnet test`
Expected: builds clean (WPF shell compiles on Windows target — `build.sh` cross-compiles; run whatever `client/build.sh` runs in this environment), all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add client/Client.Core/Strings.resx client/Client.Core/Strings.hu.resx client/Client.App/Ui/ExtraTimeCodeEntry.cs client/Client.App/Ui/BlockWindow.cs client/Client.App/AppHost.cs
git commit -m "Accept a lettered coupon in the one code box and answer it honestly"
```

---

### Task 11: Documentation and final verification

**Files:**
- Modify: `TODO.md` (mark the feature landed, per the repo's handoff convention)
- Modify: `server/src/CLAUDE.md` *only if* a coupons note fits its existing scope — do not force one

- [ ] **Step 1: Full server suite** — `cd server && npm test` — Expected: PASS, zero failures.
- [ ] **Step 2: Full client suite** — `cd client && dotnet test` — Expected: PASS, zero failures.
- [ ] **Step 3: Visual smoke test** (if the environment allows): `cd server && npm run dev`, log in, open Codes → confirm the `<h1>` reads "Codes" and the Time Coupons panel appears; mint 4 global coupons; select 2; Print → confirm two-column tickets and that used/expired/none-expiry lines read correctly; switch the admin language to Hungarian and re-check the page and a print sheet.
- [ ] **Step 4: Update `TODO.md`** — add a completed entry for Time Coupons referencing ADR-0017 (follow the file's existing format).
- [ ] **Step 5: Commit**

```bash
git add TODO.md
git commit -m "Record the Time Coupons feature as landed"
```
