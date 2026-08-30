// Folds Pings older than the retention horizon into one Daily Summary row per Client per date, then
// deletes them (ADR-0003). A Ping per minute per Client is ~66 MB/client/year and grows without
// bound; minute-level detail answers "what happened on Tuesday?", a question with a short half-life.
//
// Days are local dates and minutes are ping counts, exactly as daily.js does it for the Client Page —
// the same day must not mean two different things depending on which screen you are looking at.

import { dailyData } from './daily.js';

export const RETENTION_DAYS = 30;

/**
 * Roll up and prune every Client-day older than the horizon. Idempotent: safe to run on every boot
 * and safe to run twice.
 * @returns {{days: number, pingsDeleted: number}}
 */
export function rollUpOldPings(db, { retentionDays = RETENTION_DAYS } = {}) {
  const cutoff = db.prepare(
    `SELECT date('now', 'localtime', ?) AS d`
  ).get(`-${retentionDays} days`).d;

  const stale = db.prepare(
    `SELECT client_id, date(ts, 'localtime') AS day
       FROM pings
      WHERE date(ts, 'localtime') < ?
      GROUP BY client_id, day
      ORDER BY day`
  ).all(cutoff);

  if (stale.length === 0) return { days: 0, pingsDeleted: 0 };

  // REPLACE, not INSERT: re-running over a day that was already rolled up must not throw, and a day
  // whose raw Pings are already gone contributes nothing and is skipped below.
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO daily_usage
       (client_id, date, used_minutes, blocked_minutes, longest_session_minutes, apps, rolled_up_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  );

  const deletePings = db.prepare(
    `DELETE FROM pings WHERE client_id = ? AND date(ts, 'localtime') = ?`
  );

  let pingsDeleted = 0;

  // One transaction for the lot: a crash halfway must not leave a day with its summary written and
  // its Pings still present (double-counted later) or deleted without a summary (silently lost).
  db.transaction(() => {
    for (const { client_id: clientId, day } of stale) {
      // Deliberately the very function the Client Page used to draw that day, rather than a set of
      // equivalent-looking SQL aggregates. The summary is all that survives the prune (ADR-0003),
      // so it must be what the page would have shown — and an aggregate that counts rows instead of
      // minutes looks right in review and is permanently wrong on disk.
      const data = dailyData(db, clientId, day);

      upsert.run(
        clientId, day,
        data.totalUsableMinutes, data.totalBlockedMinutes, data.longestSessionMinutes,
        data.apps.length ? JSON.stringify(Object.fromEntries(data.apps.map((a) => [a.app, a.minutes]))) : null
      );
      pingsDeleted += deletePings.run(clientId, day).changes;
    }
  })();

  return { days: stale.length, pingsDeleted };
}

/**
 * Run the rollup at boot and every few hours after. Deliberately not a midnight cron: the horizon is
 * 30 days, so nothing depends on running at a particular time, and a server that was switched off
 * overnight would silently skip its one chance.
 */
export function startRollupSchedule(app, { everyMs = 6 * 60 * 60 * 1000, retentionDays = RETENTION_DAYS } = {}) {
  const run = () => {
    try {
      const { days, pingsDeleted } = rollUpOldPings(app.db, { retentionDays });
      if (days) app.log.info({ days, pingsDeleted }, 'rolled up old pings');
    } catch (err) {
      // Never fatal: the server's job is to keep talking to Clients, and a failed prune costs disk,
      // not correctness.
      app.log.error(err, 'ping rollup failed');
    }
  };

  run();
  // unref so the timer never holds the process (or a test) open.
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));
}
