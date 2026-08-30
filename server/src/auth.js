import crypto from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

// Without Remember Me a session lasts a working day and dies with the browser. With it, the cookie
// persists and slides: every visit pushes the expiry out, so a phone in daily use never logs out
// while a device left in a drawer expires a month later.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Reissuing on every request would set a cookie on every response for no benefit; once a day is
// enough to keep a daily-use device alive indefinitely.
const SLIDE_AFTER_MS = 24 * 60 * 60 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT_PARAMS);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt') return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function hmac(payload, key) {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

export function createSession(serverKey, remember = false) {
  const ttl = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
  const body = JSON.stringify({ exp: Date.now() + ttl, rem: remember ? 1 : 0 });
  const payload = Buffer.from(body).toString('base64url');
  return `${payload}.${hmac(payload, serverKey)}`;
}

// Returns the decoded payload for a valid session, or null. Sessions are stateless — there is no
// server-side list to revoke from, which is why "log out all devices" rotates the Server Key.
export function readSession(cookie, serverKey) {
  if (!cookie) return null;
  const [payload, sig] = cookie.split('.');
  if (!payload || !sig) return null;
  const expected = hmac(payload, serverKey);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return claims.exp > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

export function verifySession(cookie, serverKey) {
  return readSession(cookie, serverKey) !== null;
}

// True when a remembered session is old enough that its cookie is worth reissuing (see SLIDE_AFTER_MS).
export function shouldSlide(claims) {
  return !!claims?.rem && claims.exp - Date.now() < REMEMBER_TTL_MS - SLIDE_AFTER_MS;
}

export function newClientToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashClientToken(token) };
}

export function hashClientToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
