// Where an Alert becomes a sentence and gets sent. alerts.js decides *whether*; push.js does the
// talking; this is the thin layer between them that knows about Clients, the catalogue and the clock.
//
// One rule runs through all of it: an Alert must never be able to break the thing it is reporting.
// Every path here swallows its own errors. A phone that is off, a push service having a bad day, a
// VAPID key that was regenerated — none of those are allowed to fail a Ping, refuse a Request, or
// take the socket down.
import { classify, enabled, suppressSimultaneous, KINDS, LOCKED_HOLD_MINUTES } from './alerts.js';
import { broadcast } from './push.js';
import { translate, DEFAULT_LANGUAGE } from './i18n.js';

// How long a "came on" is held before it is sent, so that several PCs returning together can be
// recognised as one network event rather than a household getting up at once (ADR-0013). Short
// enough not to matter for an ambient Alert; long enough to catch the reconnect ladder's jitter.
const STARTED_HOLD_MS = 30_000;

export function registerAlerts(app) {
  const db = app.db;
  const startedAt = new Date();

  const readWatch = db.prepare('SELECT * FROM alert_watch WHERE client_id = ?');
  const writeWatch = db.prepare(`
    INSERT INTO alert_watch (client_id, status, reason, since, alerted, last_ping_at)
    VALUES (@client_id, @status, @reason, @since, @alerted, @last_ping_at)
    ON CONFLICT(client_id) DO UPDATE SET status = excluded.status, reason = excluded.reason,
      since = excluded.since, alerted = excluded.alerted, last_ping_at = excluded.last_ping_at`);

  // The Admin's chosen language. Alerts are composed by the server and read by the Admin, so they
  // follow the admin UI's language — not the Client's, which belongs to the PC (ADR-0012).
  const lang = () => app.getAdmin()?.lang || DEFAULT_LANGUAGE;
  const T = (key, ...vars) => translate(lang(), key, vars);

  const nameOf = (clientId) =>
    db.prepare('SELECT name FROM clients WHERE id = ?').get(clientId)?.name ?? '?';

  async function send(kind, payload) {
    try {
      if (!enabled(app.getAdmin(), kind)) return;
      const { sent, pruned } = await broadcast(app, { ...payload, url: payload.url ?? KINDS[kind]?.url ?? '/' });
      app.log.info({ kind, sent, pruned }, 'alert sent');
    } catch (err) {
      app.log.error({ err: err?.message, kind }, 'alert failed');
    }
  }

  // --- Held "came on" Alerts -------------------------------------------------------------------
  // Collected for STARTED_HOLD_MS and then flushed as a batch, because "did more than one PC come
  // back at the same moment" is a question that cannot be answered one Ping at a time.
  let pending = [];
  let flushTimer = null;

  /** Flushes the held batch. Returns the Clients it actually alerted about — the suppression is the
   *  interesting half of this function and a return value is the only way to see it happen. */
  function flushStarted() {
    const batch = pending;
    pending = [];
    flushTimer = null;
    if (!batch.length) return [];

    const decided = suppressSimultaneous(batch);
    const dropped = decided.filter((c) => c.suppressed);
    if (dropped.length) {
      app.log.info({ clients: dropped.map((c) => c.clientId) },
        'came-on alerts suppressed — several clients returned together, which is the network');
    }

    const alerted = [];
    for (const { kind, clientId } of decided) {
      if (kind !== 'started') continue;
      const name = nameOf(clientId);
      send('started', {
        title: T('alert.started.title', name),
        body: T('alert.started.body'),
        tag: `client-${clientId}`,
        url: `/clients/${clientId}`,
      });
      alerted.push(clientId);
    }
    return alerted;
  }

  function holdStarted(clientId) {
    pending.push({ kind: 'started', clientId });
    if (flushTimer) return;
    flushTimer = setTimeout(flushStarted, STARTED_HOLD_MS);
    flushTimer.unref?.();
  }

  // --- The Ping hook ---------------------------------------------------------------------------

  /** Called for every Ping, after it has been stored. Never throws. */
  function onPing(clientId, { status, reason }) {
    try {
      const now = new Date();
      const prev = readWatch.get(clientId);
      const { kind, watch } = classify(prev, { status, reason: reason ?? null }, now, startedAt);
      writeWatch.run({ client_id: clientId, ...watch });
      if (!kind) return;

      if (kind === 'started') { holdStarted(clientId); return; }

      const name = nameOf(clientId);
      const tag = `client-${clientId}`;
      const url = `/clients/${clientId}`;
      if (kind === 'exhausted') {
        send('exhausted', { title: T('alert.exhausted.title', name), body: T('alert.exhausted.body'), tag, url });
      } else if (kind === 'locked') {
        send('locked', { title: T('alert.locked.title', name), body: T('alert.locked.body', name, LOCKED_HOLD_MINUTES), tag, url });
      }
    } catch (err) {
      app.log.error({ err: err?.message, client: clientId }, 'alert watch failed');
    }
  }

  // --- Requests ---------------------------------------------------------------------------------
  // The one Alert not derived from a Ping: it is driven by the write, at both ends. The tag is the
  // whole trick — a second Alert carrying the same tag *replaces* the first on every Alert Device,
  // so a Request one parent has already answered stops sitting on the other one's lock screen.

  const requestTag = (id) => `request-${id}`;

  function onRequest(clientId, minutes) {
    const open = db.prepare("SELECT id FROM requests WHERE client_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1").get(clientId);
    if (!open) return;
    const name = nameOf(clientId);
    send('request', {
      title: T('alert.request.title', name),
      body: T('alert.request.body', name, minutes),
      tag: requestTag(open.id),
      url: '/requests',
    });
  }

  function onRequestDecided(request) {
    if (!request) return;
    const name = nameOf(request.client_id);
    const body = request.state === 'approved'
      ? T('alert.request.approved', request.granted_minutes)
      : request.state === 'declined' ? T('alert.request.declined') : T('alert.request.answered');
    // Deliberately says nothing about *who* answered: there is exactly one Admin, so the server
    // genuinely does not know whether it was one parent or the other.
    send('request', { title: T('alert.request.title', name), body, tag: requestTag(request.id), url: '/requests' });
  }

  function onCouponRedeemed(clientId, minutes) {
    const name = nameOf(clientId);
    send('coupon', {
      title: T('alert.coupon.title', name),
      body: T('alert.coupon.body', name, minutes),
      tag: `client-${clientId}`,
      url: `/clients/${clientId}`
    });
  }

  function onGrantRedeemed(clientId, minutes) {
    const name = nameOf(clientId);
    send('grant', {
      title: T('alert.grant.title', name),
      body: T('alert.grant.body', name, minutes),
      tag: `client-${clientId}`,
      url: `/clients/${clientId}`
    });
  }

  app.decorate('alerts', { onPing, onRequest, onRequestDecided, onCouponRedeemed, onGrantRedeemed, send, flushStarted });
  app.addHook('onClose', async () => clearTimeout(flushTimer));
}
