import { hashClientToken } from './auth.js';
import { PROTOCOL_VERSION, PING_STATUSES } from './protocol.js';
import { askForTime, undeliveredVerdict, markDelivered, withdrawOpen } from './requests.js';
import { forClient as backgroundsFor } from './backgrounds.js';
import { redeemCoupon } from './coupons.js';

/**
 * The wire form of an answered Request. One message type for the whole lifecycle (PROTOCOL §6.8):
 * a Client that meets an unfamiliar state ignores it, which is what lets a newer server add one.
 */
export function verdictMessage(row) {
  return row.state === 'approved'
    ? { type: 'request-status', state: 'approved', minutes: row.granted_minutes }
    : { type: 'request-status', state: 'declined' };
}

// Tracks live client sockets so admin actions (message, adjust, kill, ...) can be pushed.
export class ClientHub {
  constructor(db) {
    this.db = db;
    this.sockets = new Map(); // client_id -> WebSocket
  }

  isOnline(clientId) {
    return this.sockets.has(clientId);
  }

  // Live-only by design (PRD §6.4): returns false if the client is offline.
  send(clientId, message) {
    const socket = this.sockets.get(clientId);
    if (!socket) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
}

export default async function wsRoutes(app) {
  const { db, hub } = app;

  const findClient = db.prepare('SELECT * FROM clients WHERE token_hash = ? AND revoked_at IS NULL');
  const touchClient = db.prepare(
    `UPDATE clients SET last_seen_at = datetime('now'),
       version = coalesce(?, version), protocol = coalesce(?, protocol),
       last_status = ?, last_remaining = ?, last_reason = ?, last_app = ?
     WHERE id = ?`
  );
  const insertPing = db.prepare(
    'INSERT INTO pings (client_id, status, remaining_minutes, foreground_app) VALUES (?, ?, ?, ?)'
  );
  // OR IGNORE: a re-sent Event collides on (client_id, seq) and is dropped (ADR-0001).
  const insertEvent = db.prepare(
    'INSERT OR IGNORE INTO events (client_id, seq, client_ts, type, payload) VALUES (?, ?, ?, ?, ?)'
  );
  const getSettings = db.prepare('SELECT * FROM settings WHERE client_id = ?');
  const getLastSeq = db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM events WHERE client_id = ?');
  // Most recently *announced*, not most recently inserted — see the announced_at note in db.js.
  const getLatestUpdate = db.prepare(
    'SELECT version, sha256 FROM updates ORDER BY announced_at DESC, id DESC LIMIT 1'
  );

  app.get('/ws', { websocket: true }, (socket, req) => {
    // Token travels in a header, never the URL — query strings end up in request/proxy logs.
    const token = req.headers['x-client-token'];
    const client = typeof token === 'string' && token ? findClient.get(hashClientToken(token)) : undefined;
    if (!client) {
      socket.close(4001, 'unauthorized');
      return;
    }

    hub.sockets.set(client.id, socket);
    app.log.info({ client: client.id, name: client.name }, 'client connected');

    // Fresh settings + current Admin Code secret on every connect (PRD §7).
    // lastSeq lets a Client resync its Event counter after partial state loss (ADR-0001).
    const admin = app.getAdmin();
    const latest = getLatestUpdate.get();
    socket.send(JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      lastSeq: getLastSeq.get(client.id).seq,
      settings: getSettings.get(client.id),
      familyCodeSecret: admin.totp_secret,
      grantSeed: admin.grant_seed,
      // Self-update is keyed on the exe's SHA-256; the client compares it to its own (PRD §6.7).
      update: latest ? { version: latest.version, sha256: latest.sha256, path: '/api/update/latest' } : undefined,
      // Hashes and paths, not bytes: the Client fetches over HTTP and keeps the file, because the
      // Block Screen appears at exactly the moments this socket is not there (CONTEXT.md).
      backgrounds: backgroundsFor(db, client.id),
      // The server owns the disabled (paused) flag; the client reconciles to it (PRD §5.3).
      disabled: client.disabled === 1,
    }));

    // A verdict the Admin gave while this PC was offline (CONTEXT.md: Request). Sent after hello so
    // the Client has its settings before it is told it just gained minutes. Perishable: if it is
    // past its delivery window, undeliveredVerdict() returns nothing and the sweep lapses it, which
    // is what the parent sees on the Requests page.
    const owed = undeliveredVerdict(db, client.id);
    if (owed) {
      socket.send(JSON.stringify(verdictMessage(owed)));
      markDelivered(db, owed.id);
    }

    if (client.protocol != null && client.protocol !== PROTOCOL_VERSION) {
      app.log.warn(
        { client: client.id, clientProtocol: client.protocol, serverProtocol: PROTOCOL_VERSION },
        'protocol version mismatch — advisory, continuing'
      );
    }

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ping': {
          // Stored verbatim, never coerced: this log is the parent's evidence, and
          // substituting a plausible status for an unrecognised one fabricates it.
          const status = String(msg.status ?? 'unknown');
          if (!PING_STATUSES.has(status)) {
            app.log.warn({ client: client.id, status }, 'unknown ping status — stored as-is');
          }
          insertPing.run(client.id, status, msg.remaining ?? null, msg.app ?? null);
          touchClient.run(
            msg.version ?? null, msg.protocol ?? null,
            status, msg.remaining ?? null, msg.reason ?? null, msg.app ?? null,
            client.id
          );
          // After the ping is stored, never before: the audit trail is the thing that must not be
          // lost, and an Alert is a courtesy on top of it (ADR-0013).
          app.alerts?.onPing(client.id, { status, reason: msg.reason ?? null });
          break;
        }
        case 'events': {
          if (!Array.isArray(msg.events)) return;
          const insertAll = db.transaction((events) => {
            for (const e of events) {
              const res = insertEvent.run(client.id, Number.isInteger(e.seq) ? e.seq : null,
                String(e.ts ?? ''), String(e.type ?? 'unknown'),
                e.payload == null ? null : JSON.stringify(e.payload));
              if (res.changes === 1 && e.type === 'grant-redeemed') {
                app.alerts?.onGrantRedeemed(client.id, e.payload?.minutes);
              }
            }
          });
          insertAll(msg.events);
          break;
        }
        case 'request-withdraw': {
          // No answer: the Client is telling us, not asking. It has already given itself the time.
          if (withdrawOpen(db, client.id)) {
            app.log.info({ client: client.id }, 'open request withdrawn — code redeemed on the PC');
          }
          break;
        }
        case 'request': {
          // The one message a Client sends that expects an answer. Answered inline — "you already
          // have one open" and "you were declined a minute ago" are states the kid should see now,
          // not silence that reads as a broken button.
          const outcome = askForTime(db, client.id, msg.minutes);
          socket.send(JSON.stringify({ type: 'request-status', ...outcome }));
          if (outcome.state === 'pending') {
            app.log.info({ client: client.id, minutes: outcome.minutes }, 'time requested');
            // Only on a genuinely new ask. A 'duplicate' is the kid pressing the button again while
            // the same question is already on both your phones, and a 'cooldown' is a question that
            // was not recorded at all — neither is news.
            app.alerts?.onRequest(client.id, outcome.minutes);
          }
          break;
        }
        case 'coupon': {
          // Answered inline like a request: "spent", "expired" and "wrong machine" are states the
          // kid should see now, not silence that reads as a broken button (PROTOCOL §6.10).
          const outcome = redeemCoupon(db, client.id, msg.code);
          socket.send(JSON.stringify({ type: 'coupon-status', ...outcome }));
          if (outcome.state === 'granted') {
            app.log.info({ client: client.id, minutes: outcome.minutes }, 'time coupon redeemed');
            app.alerts?.onCouponRedeemed(client.id, outcome.minutes);
          }
          break;
        }
        default:
          app.log.warn({ client: client.id, type: msg.type }, 'unknown ws message');
      }
    });

    socket.on('close', () => {
      if (hub.sockets.get(client.id) === socket) hub.sockets.delete(client.id);
      app.log.info({ client: client.id }, 'client disconnected');
    });
  });
}
