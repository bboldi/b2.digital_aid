// Aggregates a Client's pings for one local calendar date into the shapes the Client Page draws:
// a minute-by-minute timeline, hourly bars, and a per-app breakdown (PRD §5.2). Pings are one-a-minute
// with a server timestamp, so "minutes" are just ping counts — no interval bookkeeping to get wrong.

import { USABLE_STATUSES as USABLE } from './protocol.js';

const USABLE_LIST = [...USABLE].map((s) => `'${s}'`).join(', ');

/**
 * Usage Time so far today, as a correlated subquery for the Clients grid. Expects the outer query to
 * expose the clients row as `c`.
 *
 * Counted from the Pings themselves rather than from a running total kept on the clients row: two
 * places computing the same number is two numbers, and the one on the card was reading 0 while the
 * Client Page read 1h32 for the same machine.
 *
 * The window is a *range* on `ts`, not `date(ts,'localtime') = ...`, which is the whole reason this
 * is affordable — `date()` on the column cannot use an index and would scan every Ping the Client
 * has, whereas the range is a covering-index seek over at most one day. `datetime(x,'utc')` reads
 * the local-midnight bounds and converts them to the UTC the column stores.
 *
 * DISTINCT minute-of-day, not count(*): Pings are also sent off-cadence (a redeemed Grant, a
 * settings change, a Lock), and two in one minute are not two minutes of use. This matches how
 * dailyData collapses a minute, so the card and the Client Page cannot disagree.
 */
export const USED_TODAY_MINUTES = `(
  SELECT count(DISTINCT CAST(strftime('%H', p.ts, 'localtime') AS INTEGER) * 60
                      + CAST(strftime('%M', p.ts, 'localtime') AS INTEGER))
    FROM pings p
   WHERE p.client_id = c.id
     AND p.ts >= datetime(date('now', 'localtime') || ' 00:00:00', 'utc')
     AND p.ts <  datetime(date('now', 'localtime', '+1 day') || ' 00:00:00', 'utc')
     AND p.status IN (${USABLE_LIST})
)`;

export function dailyData(db, clientId, dateStr) {
  // Group by local time — the parent reads the timeline in their own timezone.
  // ORDER BY id so "the later ping in a minute wins" is deterministic rather than whatever order
  // the scan happens to return.
  const rows = db.prepare(
    `SELECT status, foreground_app AS app,
            CAST(strftime('%H', ts, 'localtime') AS INTEGER) * 60
              + CAST(strftime('%M', ts, 'localtime') AS INTEGER) AS minute
     FROM pings
     WHERE client_id = ? AND date(ts, 'localtime') = ?
     ORDER BY id`
  ).all(clientId, dateStr);

  // Collapse to minute-of-day first, then count minutes — never count rows. Pings are also sent
  // off-cadence (a redeemed Grant, a settings change, a Lock), so two can land inside one minute,
  // and counting rows reported more usage than the machine actually had.
  const minutes = new Array(1440).fill(null);
  const minuteApps = new Array(1440).fill(null);

  for (const r of rows) {
    if (r.minute < 0 || r.minute > 1439) continue;
    minutes[r.minute] = r.status;
    minuteApps[r.minute] = r.app ?? null;
  }

  const hours = Array.from({ length: 24 }, () => ({ active: 0, blocked: 0, other: 0 }));
  const apps = new Map();
  let totalUsable = 0;
  let totalBlocked = 0;
  let longestSession = 0;
  let run = 0;
  let bridgedGap = 0;

  for (let m = 0; m < 1440; m++) {
    const status = minutes[m];
    const h = hours[Math.floor(m / 60)];

    if (status !== null && USABLE.has(status)) {
      h.active++;
      totalUsable++;
      if (minuteApps[m]) apps.set(minuteApps[m], (apps.get(minuteApps[m]) ?? 0) + 1);

      // A single missing report is a lost minute of evidence, not evidence the kid stopped, so it
      // is bridged into the session. Two in a row is a real break.
      run += 1 + bridgedGap;
      bridgedGap = 0;
      if (run > longestSession) longestSession = run;
      continue;
    }

    if (status === null) {
      if (run > 0 && bridgedGap === 0) { bridgedGap = 1; continue; }
    } else if (status === 'blocked') {
      h.blocked++;
      totalBlocked++;
    } else {
      h.other++;
    }

    run = 0;
    bridgedGap = 0;
  }

  // Run-length encode the minute strip so the SVG is a handful of rects, not 1440.
  const segments = [];
  let start = 0;
  for (let m = 1; m <= 1440; m++) {
    if (m === 1440 || minutes[m] !== minutes[start]) {
      if (minutes[start] !== null) segments.push({ start, len: m - start, status: minutes[start] });
      start = m;
    }
  }

  return {
    date: dateStr,
    segments,
    hours: hours.map((h, hour) => ({ hour, ...h })),
    apps: [...apps.entries()].map(([app, m]) => ({ app, minutes: m })).sort((a, b) => b.minutes - a.minutes),
    totalUsableMinutes: totalUsable,
    totalBlockedMinutes: totalBlocked,
    longestSessionMinutes: longestSession,
    peakHourMinutes: Math.max(1, ...hours.map((h) => h.active + h.blocked + h.other)),
  };
}
