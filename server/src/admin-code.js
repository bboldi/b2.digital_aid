// Proving the Admin Code left the building (ADR-0010).
//
// The Admin Code is the one secret that has to exist somewhere *other* than this server. Clients
// verify it offline, so they are fine; the parent is the half that cannot, and the moment they need
// it — a blocked PC that will not let go — is the same moment this server is most likely to be
// unreachable. A secret that only ever lived in this database is therefore not a secret anyone has.
//
// So a newly generated secret is provisional. It waits in pending_* until someone types back a code
// derived from it, which is only possible from something outside this app: the page shows the QR and
// the secret but never a current code, so there is nothing on screen to copy.
//
// Skipping is allowed, deliberately — for a test box, or for someone who has weighed it up. It
// activates the secret and leaves admin_code_confirmed at 0, which is what the standing warning on
// the Codes page reads.

import { generateSecret, verifyCode } from './totp.js';
import { generateGrantSeed } from './grant-code.js';

/**
 * Whether an Admin Code is actually in force. Empty rather than NULL because totp_secret is NOT NULL
 * in a schema that predates this; both read as "nothing here".
 */
export const hasLiveSecret = (admin) => !!admin?.totp_secret;

/** A first-run server whose Admin Code was never confirmed can do almost nothing — see routes. */
export const isPending = (admin) => !!admin?.pending_totp_secret;

/** Generate a fresh pair and park it. Whatever is live stays live. */
export function stagePending(db) {
  const secret = generateSecret();
  const seed = generateGrantSeed();
  db.prepare('UPDATE admin SET pending_totp_secret = ?, pending_grant_seed = ? WHERE id = 1')
    .run(secret, seed);
  return secret;
}

export function discardPending(db) {
  db.prepare('UPDATE admin SET pending_totp_secret = NULL, pending_grant_seed = NULL WHERE id = 1').run();
}

/**
 * Promote the pending pair. `confirmed` records whether anyone proved they can produce a code from
 * it — false when the Admin took the skip.
 *
 * Returns the promoted pair so the caller can tell the Clients, which must happen *after* this and
 * never before: announcing a secret that is still provisional would strand every PC on a code
 * nobody holds, which is the whole failure this exists to prevent.
 */
export function promotePending(db, confirmed) {
  const admin = db.prepare('SELECT * FROM admin WHERE id = 1').get();
  if (!admin?.pending_totp_secret) return null;

  const secret = admin.pending_totp_secret;
  const seed = admin.pending_grant_seed;
  db.prepare(
    `UPDATE admin SET totp_secret = ?, grant_seed = ?, admin_code_confirmed = ?,
                      pending_totp_secret = NULL, pending_grant_seed = NULL
      WHERE id = 1`
  ).run(secret, seed, confirmed ? 1 : 0, );
  return { secret, seed };
}

/**
 * Check a typed code against the pending secret. Skew is otplib's ±1 step, the same tolerance
 * pairing and exit use — a phone a minute out still works, a phone ten minutes out does not, which
 * is the failure that looks like a bug and is not.
 */
export function checkPending(db, code) {
  const admin = db.prepare('SELECT pending_totp_secret AS s FROM admin WHERE id = 1').get();
  if (!admin?.s || typeof code !== 'string') return false;
  try {
    return verifyCode(code.trim(), admin.s);
  } catch {
    // Malformed input reaching otplib. Not a code either way.
    return false;
  }
}

/**
 * Proving an *already live* secret, from the Codes page — the way back from a skip, and from an
 * Admin who confirmed on a phone they no longer have.
 */
export function checkLive(db, code) {
  const admin = db.prepare('SELECT totp_secret AS s FROM admin WHERE id = 1').get();
  if (!admin?.s || typeof code !== 'string') return false;
  try {
    return verifyCode(code.trim(), admin.s);
  } catch {
    return false;
  }
}

export function markConfirmed(db) {
  db.prepare('UPDATE admin SET admin_code_confirmed = 1 WHERE id = 1').run();
}
