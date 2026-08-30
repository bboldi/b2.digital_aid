import crypto from 'node:crypto';

// Extra Time Codes: [6 digits][1-3 digit minutes], e.g. '48210215' is 15 minutes (ADR-0006).
//
// The six digits come off the Grant Seed, the minutes and the current minute — never the Family
// Code. Handing out Extra Time Codes therefore leaks nothing about the key that exits a Client, and
// editing the trailing minutes invalidates the code instead of minting time, because the minutes
// are part of what is signed.
//
// Defined identically in client/Client.Core/GrantCode.cs and public/family-code.js. All three are
// pinned to the same numbers by the vectors in test/grant-code.test.js — three implementations of
// one derivation is exactly the shape that drifts silently, and a drift means grants stop working
// with no error to read.

/// 60 seconds rather than TOTP's 30: long enough to read eight digits down a phone to someone who
/// will mistype them once, short enough that a fresh distinct code is a minute away. The code is a
/// pure function of (seed, minutes, step), so the same minutes granted twice inside one step
/// produce the same digits — and the Client refuses a code it has already redeemed.
export const STEP_SECONDS = 60;

/// A distinct key from the Admin Code secret, and never displayed or typed — so it is ours to
/// choose, and 32 bytes of hex beats base32 for something no human reads.
export function generateGrantSeed() {
  return crypto.randomBytes(32).toString('hex');
}

export function stepAt(epochSeconds) {
  return Math.floor(epochSeconds / STEP_SECONDS);
}

/// Six digits of HMAC-SHA256 over `${minutes}:${step}`, folded with RFC 4226 dynamic truncation.
function digits(seed, minutes, step) {
  const mac = crypto.createHmac('sha256', Buffer.from(seed, 'hex')).update(`${minutes}:${step}`).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/// The minutes are zero-padded to three so that every Extra Time Code is exactly nine digits and
/// therefore has exactly one shape — which is what makes the `xxx-xxx-xxx` grouping worth having and
/// a mistyped code *look* wrong (ADR-0014). The padding is in the written form only: `digits()`
/// above signs the bare integer, so `15` and not `015`. Padding the signed string instead would
/// invalidate every code in existence and would have to land on the server, the browser and every
/// Client at the same instant.
export function grantCodeAt(seed, minutes, step) {
  return digits(seed, minutes, step) + String(minutes).padStart(3, '0');
}


/// The code the Admin reads out, plus how long it stays quotable. `secondsLeft` counts to the end of
/// the current step, not to the end of validity: the Client accepts +/-1 step, so a code quoted at
/// the last second still lands. Understating it is the safe direction.
export function currentGrantCode(seed, minutes, now = Date.now()) {
  const epoch = Math.floor(now / 1000);
  return {
    code: grantCodeAt(seed, minutes, stepAt(epoch)),
    secondsLeft: STEP_SECONDS - (epoch % STEP_SECONDS),
  };
}
