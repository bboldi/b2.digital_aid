// The Request lifecycle (CONTEXT.md: Request) — the one channel in this system that runs kid→parent.
//
// Everything here is pure of Fastify and of the websocket: it decides *what* should happen to a
// Request, and ws.js / admin.js do the talking. That keeps the awkward parts — expiry, the cooldown,
// the "approved but the PC never came back" case — testable without a socket.
//
// Times are UTC SQL strings ('YYYY-MM-DD HH:MM:SS'), matching datetime('now') everywhere else in
// this schema. Expiry is computed in JS rather than SQL because "local midnight" is a wall-clock
// concept and JS is where this process knows its own timezone.

/** How long an unanswered Request stays askable. Longer than this and the question has changed. */
export const OPEN_MINUTES = 60;
/** How long an answered Request keeps trying to reach a PC that is offline. */
export const DELIVERY_MINUTES = 30;
/** Quiet period after a decline, so "no" cannot be re-litigated once a minute. */
export const COOLDOWN_MINUTES = 15;
/** The most a kid can ask for in one Request. The Admin picks the real number anyway. */
export const MAX_ASK_MINUTES = 180;

// UTC, to match datetime('now'). Local wall-clock only ever enters through nextLocalMidnight(),
// which produces an instant; this turns any instant into the schema's storage format.
const sqlUtc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

/** Local midnight tonight, as a Date. */
function nextLocalMidnight(now) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight;
}

function soonest(now, minutes) {
  const window = new Date(now.getTime() + minutes * 60000);
  const midnight = nextLocalMidnight(now);
  return sqlUtc(window < midnight ? window : midnight);
}

/** When a Request made now stops being answerable. */
export const openUntil = (now = new Date()) => soonest(now, OPEN_MINUTES);
/** When a verdict decided now gives up on reaching an offline Client. */
export const deliverUntil = (now = new Date()) => soonest(now, DELIVERY_MINUTES);

// --- Reads -------------------------------------------------------------------------------------

const OPEN_REQUEST = `
  SELECT * FROM requests WHERE client_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1`;

const LAST_DECLINE = `
  SELECT decided_at FROM requests
   WHERE client_id = ? AND state = 'declined'
   ORDER BY decided_at DESC LIMIT 1`;

export const openRequestFor = (db, clientId) => db.prepare(OPEN_REQUEST).get(clientId);

/**
 * The kid settled the question themselves — an Extra Time Code was redeemed on the PC while a
 * Request was still open. The ask is closed rather than left waiting, because a parent answering it
 * ten minutes later would be answering a question that no longer exists, and an approval would hand
 * out a second helping of minutes nobody asked for.
 *
 * 'withdrawn' rather than 'lapsed': the row is kept either way, and the two are not the same story
 * to a parent reading the list later.
 */
export function withdrawOpen(db, clientId) {
  return db.prepare(
    `UPDATE requests SET state = 'withdrawn' WHERE client_id = ? AND state = 'open'`
  ).run(clientId).changes;
}

/**
 * A verdict that has been decided but never reached the Client, and still has time to. This is what
 * a Client picks up when it reconnects — the ask survives the socket, so the answer must too.
 */
export function undeliveredVerdict(db, clientId, now = new Date()) {
  return db.prepare(
    `SELECT * FROM requests
      WHERE client_id = ? AND state IN ('approved', 'declined')
        AND delivered_at IS NULL AND expires_at > ?
      ORDER BY id LIMIT 1`
  ).get(clientId, sqlUtc(now));
}

/** Seconds left on a decline cooldown, or 0 if the Client may ask. */
export function cooldownSeconds(db, clientId, now = new Date()) {
  const last = db.prepare(LAST_DECLINE).get(clientId);
  if (!last?.decided_at) return 0;
  const until = new Date(`${last.decided_at.replace(' ', 'T')}Z`).getTime() + COOLDOWN_MINUTES * 60000;
  return Math.max(0, Math.ceil((until - now.getTime()) / 1000));
}

// --- Writes ------------------------------------------------------------------------------------

/**
 * A Client asks for more time.
 * @returns {{state: 'pending'|'duplicate'|'cooldown', minutes?: number, retryAfter?: number}}
 *   the answer to send straight back down the socket — never an error, because a kid asking twice
 *   is not a fault condition.
 */
export function askForTime(db, clientId, askedMinutes, now = new Date()) {
  const minutes = Math.min(MAX_ASK_MINUTES, Math.max(1, Math.round(Number(askedMinutes) || 0)));

  // Sweep first: an ask is the one moment we are certain someone is watching, and answering
  // "you already have one open" about a Request that expired an hour ago would be a lie.
  lapseExpired(db, now);

  const open = openRequestFor(db, clientId);
  if (open) return { state: 'duplicate', minutes: open.asked_minutes };

  const retryAfter = cooldownSeconds(db, clientId, now);
  if (retryAfter > 0) return { state: 'cooldown', retryAfter };

  db.prepare(
    `INSERT INTO requests (client_id, asked_minutes, expires_at) VALUES (?, ?, ?)`
  ).run(clientId, minutes, openUntil(now));
  return { state: 'pending', minutes };
}

/**
 * The Admin answers. Returns the updated row, or undefined if the Request was already answered or
 * has lapsed — two phones open on the same Request must not produce two Grants.
 */
export function decide(db, id, { approve, minutes = 0, now = new Date() } = {}) {
  lapseExpired(db, now);
  const changed = db.prepare(
    `UPDATE requests
        SET state = ?, granted_minutes = ?, decided_at = ?, expires_at = ?
      WHERE id = ? AND state = 'open'`
  ).run(
    approve ? 'approved' : 'declined',
    approve ? Math.max(1, Math.round(minutes)) : null,
    sqlUtc(now), deliverUntil(now), id
  ).changes;

  return changed ? db.prepare('SELECT * FROM requests WHERE id = ?').get(id) : undefined;
}

/** The verdict reached the PC. Until this is stamped the verdict is still owed. */
export function markDelivered(db, id, now = new Date()) {
  db.prepare('UPDATE requests SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL')
    .run(sqlUtc(now), id);
}

/**
 * Expire what has run out of time: unanswered Requests, and verdicts that never reached a PC that
 * stayed offline. Both become 'lapsed' rather than disappearing — a parent who approved 30 minutes
 * is owed the knowledge that they were never given.
 */
export function lapseExpired(db, now = new Date()) {
  return db.prepare(
    `UPDATE requests SET state = 'lapsed'
      WHERE state IN ('open', 'approved', 'declined')
        AND delivered_at IS NULL
        AND expires_at <= ?`
  ).run(sqlUtc(now)).changes;
}

/**
 * Sweep on a timer so the Requests page and the nav badge stop counting a Request nobody can answer
 * any more. Every minute: the numbers on that page are the ones a parent acts on in the moment.
 */
export function startRequestSweep(app, { everyMs = 60000 } = {}) {
  const run = () => {
    try {
      const lapsed = lapseExpired(app.db);
      if (lapsed) app.log.info({ lapsed }, 'requests lapsed');
    } catch (err) {
      app.log.error(err, 'request sweep failed');
    }
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));
}
