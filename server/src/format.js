// Renders a Client's "Time Left" the way the kid sees it — usable-right-now, never the raw budget
// (PRD §3.1). Driven by the reason the client reports in each ping.
//
// Takes a translator rather than composing English: every one of these reaches a screen, and a
// number next to a noun cannot be assembled at runtime because Hungarian does not pluralise after a
// numeral (CONTEXT.md: Hungarian terms). So each is a whole sentence with a placeholder.
export function timeLeftText(client, t) {
  const { last_status: status, last_reason: reason, last_remaining: remaining } = client;
  if (client.disabled || status === 'disabled') return t('time.disabled');
  if (status === 'locked') return t('time.screenLocked');
  switch (reason) {
    case 'grant': return t('time.grant', [remaining ?? 0]);
    case 'allowance': return t('time.allowance', [remaining ?? 0]);
    case 'downtime': return t('time.downtime', [client.downtime_end ?? '?']);
    case 'exhausted': return t('time.exhausted');
    case 'locked': return t('time.lockedByYou');
    // An unrecognised status is shown as it arrived rather than translated away: the audit trail
    // must not fabricate, and a Client newer than this server is entitled to its own word.
    default: return status ? status : '—';
  }
}

// Which colour the Time Left text carries. The dot on a client card means connectivity and nothing
// else (a Disabled Client is online), so *state* rides this instead — in the same colour vocabulary
// the Client Page timeline uses, so a colour means one thing everywhere.
export function timeLeftKind(client) {
  if (client.disabled || client.last_status === 'disabled') return 'unknown';
  if (client.last_status === 'locked') return 'locked';
  switch (client.last_reason) {
    case 'grant': return 'grant';
    case 'allowance': return 'active';
    case 'downtime': return 'downtime';
    case 'exhausted': return 'blocked';
    case 'locked': return 'locked';
    default: return 'unknown';
  }
}

// Whether the client is currently blocked, for a quick badge.
export function isBlocked(client) {
  return client.last_status === 'blocked';
}

export function isLocked(client) {
  return client.last_reason === 'locked';
}

// Simulates a fresh day's state for an offline client if the calendar day has rolled over
// since its last ping, so the UI doesn't show yesterday's frozen Time Left.
export function simulateOfflineDayRollover(client, online) {
  if (online) return client;
  if (!client.last_seen_local) return client;
  if (client.disabled || client.last_status === 'disabled') return client;
  if (client.revoked_at) return client;

  // Compare local dates (YYYY-MM-DD)
  const today = new Date();
  const todayStr = today.toLocaleDateString('en-CA');
  const lastSeenStr = client.last_seen_local.substring(0, 10);
  if (lastSeenStr >= todayStr) return client; // Already seen today (or future)

  const dow = today.getDay();
  const isWeekend = (dow === 0 || dow === 6);
  // Default to 0 if settings are somehow missing
  const allowance = isWeekend ? (client.weekend_minutes ?? 0) : (client.weekday_minutes ?? 0);

  let isDowntime = false;
  const start = client.downtime_start;
  const end = client.downtime_end;
  if (start && end && start !== end) {
    const nowHHMM = today.toTimeString().substring(0, 5); // "HH:MM"
    if (start <= end) {
      isDowntime = nowHHMM >= start && nowHHMM < end;
    } else {
      isDowntime = nowHHMM >= start || nowHHMM < end;
    }
  }

  const sim = { ...client };
  if (isDowntime) {
    sim.last_status = 'blocked';
    sim.last_reason = 'downtime';
  } else {
    sim.last_status = allowance > 0 ? 'active' : 'blocked';
    sim.last_reason = allowance > 0 ? 'allowance' : 'exhausted';
    sim.last_remaining = allowance;
  }
  
  sim.last_seen_local = todayStr + ' 00:00:00';
  return sim;
}
