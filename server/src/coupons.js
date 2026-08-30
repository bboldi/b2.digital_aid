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
const SEPARATORS = /[ \-\u2010\u2011\u2012\u2013\u2014\u00A0\u202F._]/g;

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

/** Every coupon, filterable, sortable, and paginated, with the redeemer's name resolved. */
export function listCoupons(db, { status = 'all', sort = 'newer', clientId = 'all', page = null, limit = 50, ids = null } = {}) {
  let where = [];
  let params = [];

  if (ids) {
    if (ids.length === 0) return [];
    where.push(`c.id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  } else {
    if (clientId !== 'all') {
      if (clientId === 'global') {
        where.push('c.client_id IS NULL');
      } else {
        where.push('c.client_id = ?');
        params.push(Number(clientId));
      }
    }

    if (status !== 'all') {
      const today = localDate(new Date());
      if (status === 'used') {
        where.push('c.used_at IS NOT NULL');
      } else if (status === 'expired') {
        where.push('c.used_at IS NULL AND c.expires_on IS NOT NULL AND c.expires_on < ?');
        params.push(today);
      } else if (status === 'unused') {
        where.push('c.used_at IS NULL AND (c.expires_on IS NULL OR c.expires_on >= ?)');
        params.push(today);
      }
    }
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = sort === 'older' ? 'ASC' : 'DESC';

  let total = 0;
  if (!ids && page !== null) {
    total = db.prepare(`SELECT COUNT(*) as count FROM coupons c ${whereClause}`).get(...params).count;
  }

  let query = `
    SELECT c.*, k.name AS client_name, u.name AS used_by_name
    FROM coupons c
    LEFT JOIN clients k ON k.id = c.client_id
    LEFT JOIN clients u ON u.id = c.used_by
    ${whereClause}
    ORDER BY c.created_at ${order}, c.id ${order}
  `;

  if (page !== null) {
    const offset = (page - 1) * limit;
    query += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);
  }

  const items = db.prepare(query).all(...params);
  
  if (ids || page === null) {
    return items;
  }

  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

/** Hard delete (ADR-0017): the row goes away; a redemption already lives on as a Client Event. */
export function deleteCoupons(db, ids) {
  const wanted = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (wanted.length === 0) return 0;
  const del = db.prepare(`DELETE FROM coupons WHERE id IN (${wanted.map(() => '?').join(',')})`);
  return del.run(...wanted).changes;
}
