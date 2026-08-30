// Alerts (CONTEXT.md: Alert, Alert Device) — the transport that reaches a phone in a pocket.
//
// Everything about *what* is worth sending is decided here, and it is decided by watching Ping
// transitions rather than by listening for Events (ADR-0013). The short version: an Event is built
// to survive being offline, so an Event-driven Alert would faithfully deliver "the PC came on"
// about a morning that ended two hours ago. A Ping is never queued, so a transition between two
// Pings is inherently about the minute it was seen in. The worst an Alert here can be is absent.
//
// This module is pure of Fastify and of web-push: it decides what should be said, and push.js does
// the talking. That keeps the awkward parts — the gap rule, the suppressions, the damping — testable
// without a network or a browser.

/** How long a Client must be silent before its return counts as "the PC came on". */
export const GAP_MINUTES = 10;
/** How long "stepped away" must hold before it is worth an Alert. */
export const LOCKED_HOLD_MINUTES = 10;

const sqlUtc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const parseUtc = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}Z`) : null);
const minutesBetween = (a, b) => (a - b) / 60000;

/**
 * The four kinds. `tag` is what lets a later Alert *replace* an earlier one on the lock screen
 * rather than stack beneath it — which is the whole mechanism behind a resolved Request not leaving
 * a stale question on the other parent's phone.
 */
export const KINDS = {
  request: { setting: 'alert_request', url: '/requests' },
  started: { setting: 'alert_started' },
  exhausted: { setting: 'alert_exhausted' },
  locked: { setting: 'alert_locked' },
  coupon: { setting: 'alert_coupon' },
  grant: { setting: 'alert_grant' },
};

/** Whether the Admin has this kind switched on. Unknown kinds are off — never a crash. */
export function enabled(admin, kind) {
  const setting = KINDS[kind]?.setting;
  return !!setting && !!admin?.[setting];
}

/**
 * Decide what a single Client's latest Ping means, given what the watcher saw last time.
 *
 * Returns `{ kind, watch }` — `kind` is the Alert to send (or null), `watch` is the bookkeeping to
 * store back. Pure: no clock of its own, no database, no sending. Everything awkward about this
 * feature is in here precisely so it can be tested by calling a function.
 *
 * @param prev  the stored alert_watch row, or undefined the first time a Client is seen
 * @param now   the moment this ping was processed
 * @param serverStartedAt when this server process came up — a gap containing it is the server's
 *                        fault, not a PC's (ADR-0013)
 */
export function classify(prev, { status, reason }, now, serverStartedAt) {
  const watch = { status, reason, since: sqlUtc(now), alerted: 0, last_ping_at: sqlUtc(now) };
  const lastPing = parseUtc(prev?.last_ping_at);

  // --- Did this PC just come back after being away? -------------------------------------------
  // A gap means "no Pings arrived", which is *not* the same as "the PC was off": the client keeps
  // enforcing while offline, so a dropped network or a restarted proxy looks identical to a
  // powered-down machine. Hence a generous gap and the suppressions the caller applies.
  const gap = lastPing ? minutesBetween(now, lastPing) : Infinity;
  const returned = gap >= GAP_MINUTES;

  if (returned) {
    // The server being down explains every Client's silence at once, and explains it better than
    // "every PC in the house was switched off and back on together".
    const serverGap = serverStartedAt && lastPing && serverStartedAt > lastPing;
    // A machine that comes back already blocked or already locked did not "start being used".
    const usable = status === 'active' || status === 'grant-active';
    if (!serverGap && usable) return { kind: 'started', watch: { ...watch, alerted: 1 } };
    return { kind: null, watch };
  }

  // --- Otherwise, only a change of state is worth anything -------------------------------------
  const changed = prev?.status !== status || prev?.reason !== reason;
  if (!changed) {
    // Same state as before. Keep the original `since` — that is what makes a hold measurable — and
    // keep whether it has already been alerted, so an hour of being locked is one Alert, not sixty.
    const held = { ...watch, since: prev.since, alerted: prev.alerted };

    // "Stepped away" is the one Alert that fires on a *hold* rather than on the change itself.
    // Locking is behaviour this system actively encourages — the Flyout offers a button for it —
    // so alerting on every lock would buzz through lunch and punish the habit the app is teaching.
    if (status === 'locked' && !prev.alerted
        && minutesBetween(now, parseUtc(prev.since)) >= LOCKED_HOLD_MINUTES) {
      return { kind: 'locked', watch: { ...held, alerted: 1 } };
    }
    return { kind: null, watch: held };
  }

  // Ran out of time. Only `exhausted` — never Downtime, which arrives at the same minute every
  // night by a rule the Admin wrote, and never an Admin Lock or End Today, which a human just
  // pressed and already knows about (ADR-0013).
  if (status === 'blocked' && reason === 'exhausted') {
    return { kind: 'exhausted', watch: { ...watch, alerted: 1 } };
  }

  // A fresh lock starts the clock; it does not fire yet.
  return { kind: null, watch };
}

/**
 * Two or more Clients resuming inside the same minute is a network event, not two kids
 * independently sitting down at the same second. No help in a one-machine household, and free.
 */
export function suppressSimultaneous(candidates) {
  const started = candidates.filter((c) => c.kind === 'started');
  if (started.length < 2) return candidates;
  return candidates.map((c) => (c.kind === 'started' ? { ...c, kind: null, suppressed: 'simultaneous' } : c));
}
