// The Admin Code tab. Everything shown here is computed in the browser when this device is trusted
// (PRD §5.4, ADR-0002), and fetched from the server when it is not. The trusted path runs online as
// well as offline on purpose: an offline path that only executes during an outage is only tested
// during one.

const $ = (id) => document.getElementById(id);

// This file is a static asset, so EJS cannot reach it; the page hands it a catalogue in a script tag
// instead. Same rule as everywhere else — a whole sentence per entry with {0} in it, never a number
// glued to a noun, because Hungarian does not pluralise after a numeral (CONTEXT.md: Hungarian
// terms). The line below used to read `${n} ${n === 1 ? 'minute' : 'minutes'}`, which is precisely
// the construction that cannot be translated.
const STRINGS = JSON.parse(document.getElementById('js-strings')?.textContent ?? '{}');
const T = (key, ...vars) =>
  (STRINGS[key] ?? `[${key}]`).replace(/\{(\d+)\}/g, (whole, i) => (vars[i] === undefined ? whole : vars[i]));

// --- Secret storage -------------------------------------------------------
// IndexedDB rather than localStorage: same exposure, but it is not sitting in a panel that any
// passer-by with devtools open reads at a glance.

const DB_NAME = 'digital-aid';
const STORE = 'secret';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const loadSecret = () => withStore('readonly', (s) => s.get('family')).catch(() => null);
const saveSecret = (v) => withStore('readwrite', (s) => s.put(v, 'family'));
const clearSecret = () => withStore('readwrite', (s) => s.delete('family'));

// The Grant Seed lives beside the Admin Code secret and is trusted, held and cleared with it — one
// act of trust, not two (ADR-0006).
const loadSeed = () => withStore('readonly', (s) => s.get('grant')).catch(() => null);
const saveSeed = (v) => withStore('readwrite', (s) => s.put(v, 'grant'));
const clearSeed = () => withStore('readwrite', (s) => s.delete('grant'));

// --- TOTP -----------------------------------------------------------------
// RFC 6238 against the Admin Code profile: SHA-1, 30-second step, 6 digits — the same profile
// server/src/totp.js and Client.Core/Totp.cs implement, so all three agree by construction.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function totp(secret, epochSeconds) {
  const counter = new DataView(new ArrayBuffer(8));
  counter.setUint32(0, Math.floor(epochSeconds / 30 / 2 ** 32));
  counter.setUint32(4, Math.floor(epochSeconds / 30) >>> 0);
  const key = await crypto.subtle.importKey(
    'raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter.buffer));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

// --- Extra Time Codes -----------------------------------------------------------
// [6 digits][3-digit minutes] — always nine, the six derived from the Grant Seed rather than the Admin Code
// (ADR-0006), so handing out Extra Time Codes never leaks the key that exits a Client. Defined
// identically in server/src/grant-code.js and client/Client.Core/GrantCode.cs, and pinned to shared
// vectors by server/test/grant-code.test.js — if these three drift, grants stop working with no
// error anywhere to read.

const GRANT_STEP = 60;

function hexDecode(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function grantCode(seed, minutes, epochSeconds) {
  const step = Math.floor(epochSeconds / GRANT_STEP);
  const key = await crypto.subtle.importKey(
    'raw', hexDecode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${minutes}:${step}`)));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  // Both halves padded: the six because the parser splits on position, the minutes so that every
  // code is nine digits and has one shape (ADR-0014). The padding is written, never signed — the
  // HMAC above is over the bare integer.
  return String(bin % 1_000_000).padStart(6, '0') + String(minutes).padStart(3, '0');
}

/// `482-102-015`. Presentation only: what goes on the clipboard and into a Client is the bare form,
/// because an older Client's parser rejects anything that is not a digit (ADR-0014).
function formatGrant(code) {
  const d = String(code).replace(/\D/g, '');
  return d.length === 9 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
}

// --- State ----------------------------------------------------------------

const state = {
  secret: null, code: null, secondsLeft: 0,
  seed: null, grant: null, grantSecondsLeft: 0,
  minutes: 15, offline: false,
};

// A trusted device needs no network to show a code, but it still needs to *say* whether the server
// is reachable — the strip and the Regenerate button depend on it. navigator.onLine is no help: it
// reports whether there is a link, not whether the home server is answering, and a phone on café
// wifi is "online" while the server behind Tailscale is nowhere to be found. So ask the server.
const REACH_EVERY = 15;
let reachTicks = 0;

async function probeServer() {
  try {
    const res = await fetch('/family-code/current', { cache: 'no-store' });
    state.offline = !res.ok && res.status !== 401;
  } catch {
    state.offline = true;
  }
}

// Verification allows ±1 step on both the server and the Client, so a code shown now is still
// accepted for up to 30 seconds after it rolls over. Reporting the naive 0–30 would make handing a
// code over feel like defusing a bomb when it is not.
// The two codes no longer share a rhythm: the Admin Code is TOTP on a 30-second step, an Extra Time Code
// runs on our own 60-second one (ADR-0006). Both are verified +/-1 step, so both stay good for a
// step longer than they are displayed — reporting the naive countdown would make handing a code
// over feel like defusing a bomb when it is not.
const CODE_WINDOW = 60;
const GRANT_WINDOW = 120;
const acceptanceLeft = () => state.secondsLeft + 30;
const grantAcceptanceLeft = () => state.grantSecondsLeft + 60;

function ring(id, textId, left, window) {
  const c = 2 * Math.PI * 9;
  $(id).style.strokeDasharray = `${c}`;
  $(id).style.strokeDashoffset = `${c * (1 - left / window)}`;
  $(textId).textContent = left ? T('js.validFor', left) : '';
}

function paint() {
  const usable = state.code !== null;
  const grantUsable = state.grant !== null;
  $('code').textContent = usable ? state.code : '––––––';
  $('grant').textContent = grantUsable ? formatGrant(state.grant) : '–––-–––-–––';
  $('grant-says').textContent = grantUsable ? T('js.grantSays', state.minutes) : '–';

  ring('ring-grant', 'valid-grant', grantUsable ? grantAcceptanceLeft() : 0, GRANT_WINDOW);
  ring('ring-code', 'valid-code', usable ? acceptanceLeft() : 0, CODE_WINDOW);

  $('offline-strip').hidden = !state.offline;
  $('offline-strip').firstElementChild.textContent =
    T(state.secret ? 'js.offlineTrusted' : 'js.offlineUntrusted');
  $('trust-off').hidden = !!state.secret;
  $('trust-on').hidden = !state.secret;
  // Regenerating needs the server; offer it only when there is one.
  $('regen-form').querySelector('button').disabled = state.offline;
}

// --- Ticking ---------------------------------------------------------------

async function tick() {
  if (state.secret) {
    // Trusted: no network involved at all, which is the entire point.
    const now = Math.floor(Date.now() / 1000);
    state.code = await totp(state.secret, now);
    state.secondsLeft = 30 - (now % 30);
    state.grant = state.seed ? await grantCode(state.seed, state.minutes, now) : null;
    state.grantSecondsLeft = GRANT_STEP - (now % GRANT_STEP);
    if (reachTicks-- <= 0) { reachTicks = REACH_EVERY; await probeServer(); }
  } else {
    try {
      // Untrusted browsers are sent the codes, never the Grant Seed — so the minutes have to go up
      // with the request, since the server is the only thing that can derive that code.
      const res = await fetch(`/family-code/current?minutes=${state.minutes}`);
      if (res.redirected) { location.reload(); return; }
      if (!res.ok) throw new Error('unauthorised');
      const body = await res.json();
      state.code = body.code;
      state.secondsLeft = body.secondsLeft;
      state.grant = body.grant ?? null;
      state.grantSecondsLeft = body.grantSecondsLeft ?? 0;
      state.offline = false;
    } catch {
      // Untrusted and unreachable: there is nothing honest to show, so show nothing rather than a
      // stale code that will be rejected.
      state.code = null;
      state.grant = null;
      state.offline = true;
    }
  }
  paint();
}

// --- Presets ---------------------------------------------------------------

function selectMinutes(minutes, { fromCustom = false } = {}) {
  state.minutes = Math.max(1, Math.min(999, minutes | 0));
  localStorage.setItem('da.minutes', state.minutes);
  for (const b of $('presets').querySelectorAll('button')) {
    b.classList.toggle('on', Number(b.dataset.min) === state.minutes);
  }
  if (!fromCustom) $('custom').value = '';
  // The Extra Time Code depends on the minutes, so changing them invalidates the one on screen. Recompute
  // rather than repaint — untrusted, that means another round trip; the alternative is showing a
  // code for a number the parent is no longer asking for.
  tick();
}

// --- Copying ---------------------------------------------------------------
// Copy exists for sending a code to someone who is not in the room — a clipboard does not reach the
// kid's PC. So the confirmation carries how long the thing they just copied stays good for.

async function copy(text, feedbackId, left = acceptanceLeft()) {
  const el = $(feedbackId);
  try {
    await navigator.clipboard.writeText(text);
    el.textContent = T('js.copied', left);
    el.className = 'copied';
  } catch {
    el.textContent = T('js.copyFailed');
    el.className = 'error';
  }
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

// --- Trust flow ------------------------------------------------------------

async function trust(event) {
  event.preventDefault();
  const err = $('trust-error');
  err.hidden = true;
  try {
    const res = await fetch('/family-code/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('trust-password').value }),
    });
    if (!res.ok) {
      err.textContent = T(res.status === 401 ? 'js.wrongPassword' : 'js.serverUnreachable');
      err.hidden = false;
      return;
    }
    const { secret, grantSeed } = await res.json();
    await saveSecret(secret);
    state.secret = secret;
    if (grantSeed) { await saveSeed(grantSeed); state.seed = grantSeed; }
    $('trust-password').value = '';
    await tick();
  } catch {
    err.textContent = T('js.serverUnreachable');
    err.hidden = false;
  }
}

// --- Boot ------------------------------------------------------------------

async function boot() {
  // WebCrypto and the clipboard are both unavailable on insecure origins. Say so, rather than
  // presenting a page whose buttons quietly do nothing (PRD §5.4).
  if (!globalThis.isSecureContext || !crypto.subtle) {
    $('no-crypto').hidden = false;
    $('trust-card').hidden = true;
  } else {
    state.secret = (await loadSecret()) ?? null;
    state.seed = (await loadSeed()) ?? null;
  }

  selectMinutes(Number(localStorage.getItem('da.minutes')) || 15);

  $('presets').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-min]');
    if (btn) selectMinutes(Number(btn.dataset.min));
  });
  $('custom').addEventListener('input', (e) => {
    if (e.target.value) selectMinutes(Number(e.target.value), { fromCustom: true });
  });

  // Deliberately state.grant and not what is on screen: the screen carries the dashes, and a dashed
  // code pasted into a Client that has not been updated is rejected outright (ADR-0014).
  $('copy-grant').addEventListener('click', () => state.grant && copy(state.grant, 'copied-grant', grantAcceptanceLeft()));
  $('copy-code').addEventListener('click', () => state.code && copy($('code').textContent, 'copied-code'));

  $('trust-form').addEventListener('submit', trust);
  $('untrust').addEventListener('click', async () => {
    if (!confirm(T('js.untrustConfirm'))) return;
    await clearSecret();
    await clearSeed();
    state.secret = null;
    state.seed = null;
    await tick();
  });

  // The browser's own connectivity events are not authoritative here, but they are a free hint that
  // it is worth re-probing right now instead of waiting out the interval.
  for (const ev of ['online', 'offline']) {
    window.addEventListener(ev, () => { reachTicks = 0; tick(); });
  }

  await tick();
  setInterval(tick, 1000);
}

boot();
