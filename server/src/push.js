// The Web Push transport for Alerts. Everything that touches the network or web-push lives here;
// what is worth saying is decided in alerts.js.
//
// VAPID is what lets this server authenticate itself directly to Apple's, Google's and Mozilla's
// push services with no account anywhere — the keys are generated once and kept beside the Server
// Key. Note what this does and does not buy: an Alert reaches a phone that is asleep in a pocket,
// but it needs *this* server to be up and to have working outbound internet. It is an upgrade to
// reachability, not to resilience — the first thing in this system that depends on a third party.
import webpush from 'web-push';

/** Read the household's VAPID pair, generating it on first use. */
export function vapidKeys(db) {
  const admin = db.prepare('SELECT vapid_public, vapid_private FROM admin WHERE id = 1').get();
  if (!admin) return null;
  if (admin.vapid_public && admin.vapid_private) return admin;

  const keys = webpush.generateVAPIDKeys();
  db.prepare('UPDATE admin SET vapid_public = ?, vapid_private = ? WHERE id = 1')
    .run(keys.publicKey, keys.privateKey);
  return { vapid_public: keys.publicKey, vapid_private: keys.privateKey };
}

// A mailto: subject is required by the spec so a push service has someone to contact about a
// misbehaving sender. Nothing is ever sent to it, and a self-hosted household has no address worth
// publishing, so this is a placeholder rather than a real inbox.
const SUBJECT = 'mailto:digital-aid@localhost';

export function registerDevice(db, subscription, label) {
  const { endpoint, keys } = subscription ?? {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return false;
  // Re-subscribing with the same endpoint is the same device saying so again, not a second one.
  db.prepare(`
    INSERT INTO alert_devices (endpoint, p256dh, auth, label) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
                                        label = COALESCE(excluded.label, label), failures = 0
  `).run(endpoint, keys.p256dh, keys.auth, label ?? null);
  return true;
}

export const forgetDevice = (db, endpoint) =>
  db.prepare('DELETE FROM alert_devices WHERE endpoint = ?').run(endpoint).changes;

export const devices = (db) => db.prepare('SELECT * FROM alert_devices ORDER BY created_at').all();

/** How many consecutive soft failures before a device is assumed gone. */
const MAX_FAILURES = 10;

/**
 * Send one Alert to every Alert Device. Never throws: a phone that is off is not an error condition,
 * and a failure to notify must not be able to break the thing being notified about.
 *
 * @param payload {{title, body, url, tag}} — `tag` is what makes a later Alert replace an earlier
 *   one on the lock screen instead of stacking under it.
 */
export async function broadcast(app, payload) {
  const db = app.db;
  const keys = vapidKeys(db);
  if (!keys) return { sent: 0, pruned: 0 };

  const targets = devices(db);
  if (!targets.length) return { sent: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;

  await Promise.all(targets.map(async (device) => {
    const subscription = { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } };
    try {
      await webpush.sendNotification(subscription, body, {
        vapidDetails: { subject: SUBJECT, publicKey: keys.vapid_public, privateKey: keys.vapid_private },
        // The three ambient Alerts and the Request one are all things someone is waiting on in the
        // moment, so none of them should sit in Android's batched queue until the phone is picked
        // up. High urgency is what wakes a dozing device.
        urgency: 'high',
        TTL: 600,
      });
      db.prepare("UPDATE alert_devices SET last_ok_at = datetime('now'), failures = 0 WHERE endpoint = ?")
        .run(device.endpoint);
      sent++;
    } catch (err) {
      // 404/410 is the push service saying this subscription no longer exists — the app was
      // uninstalled or the browser storage cleared. There is no way for a device to tell us that
      // directly, so this is the only signal, and ignoring it means paying to send to nobody
      // forever. Anything else is allowed to be transient: a phone that is merely off is not gone.
      const gone = err?.statusCode === 404 || err?.statusCode === 410;
      if (gone) {
        forgetDevice(db, device.endpoint);
        pruned++;
      } else {
        const { failures } = db.prepare(
          'UPDATE alert_devices SET failures = failures + 1 WHERE endpoint = ? RETURNING failures'
        ).get(device.endpoint) ?? {};
        if (failures >= MAX_FAILURES) {
          forgetDevice(db, device.endpoint);
          pruned++;
        }
        app.log.warn({ err: err?.message, statusCode: err?.statusCode }, 'alert send failed');
      }
    }
  }));

  return { sent, pruned };
}
