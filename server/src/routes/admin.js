import crypto from 'node:crypto';
import { hashPassword, verifyPassword, createSession } from '../auth.js';
import { secretQrDataUrl, currentCode } from '../totp.js';
import { currentGrantCode } from '../grant-code.js';
import { vapidKeys, registerDevice, forgetDevice, devices as alertDevices } from '../push.js';

/** The four Alerts, in the order they are offered. Request first: it is the only one a kid is
 *  actively waiting on an answer to, and the only one on by default. */
const ALERT_SETTINGS = ['request', 'started', 'exhausted', 'locked', 'coupon', 'grant'];
import { GLOBAL, SLOTS, stored as storedBackground, resolve as resolveBackground, removeAllFor as removeBackgroundsFor } from '../backgrounds.js';
import {
  hasLiveSecret, isPending, stagePending, discardPending, promotePending,
  checkPending, checkLive, markConfirmed,
} from '../admin-code.js';
import { PROTOCOL_VERSION } from '../protocol.js';
import { VERSION, IS_DEV_BUILD } from '../version.js';
import { LANGUAGES, isSupported as isSupportedLanguage, translate } from '../i18n.js';
import { BRANDING } from '../branding.js';
import { timeLeftText, timeLeftKind, isLocked, simulateOfflineDayRollover } from '../format.js';
import { dailyData, USED_TODAY_MINUTES } from '../daily.js';
import { decide, lapseExpired, markDelivered, MAX_ASK_MINUTES } from '../requests.js';
import { verdictMessage } from '../ws.js';
import { latestKit } from '../install-kit.js';
import {
  REPORT_DAYS, reportCookieName, reportCookiePath,
} from '../report-links.js';

// Shorthand for the language this request resolved to. The preHandler already worked it out and
// hung it on the request, so routes never repeat that decision.
const T = (req, key, vars) => translate(req.lang, key, vars);

export default async function adminRoutes(app) {
  const { db } = app;

  app.get('/', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    return reply.redirect('/clients');
  });

  // --- First-run setup -----------------------------------------------------

  app.get('/setup', async (req, reply) => {
    if (app.getAdmin()) return reply.redirect('/');
    return reply.view('setup.ejs', { title: T(req, 'title.setup'), error: null, showNav: false });
  });

  app.post('/setup', async (req, reply) => {
    if (app.getAdmin()) return reply.redirect('/');
    const { username, password, password2 } = req.body ?? {};
    if (!username?.trim() || !password) {
      return reply.view('setup.ejs', { title: T(req, 'title.setup'), error: T(req, 'err.credentialsRequired'), showNav: false });
    }
    if (password !== password2) {
      return reply.view('setup.ejs', { title: T(req, 'title.setup'), error: T(req, 'err.passwordsDiffer'), showNav: false });
    }
    const serverKey = crypto.randomBytes(32).toString('hex');
    // No Admin Code yet — it is generated below and stays provisional until proven (ADR-0010). An
    // empty secret is the honest representation of that: pairing refuses, and every admin page sends
    // the Admin back to finish. A half-set-up server that is loudly unusable beats one holding a
    // secret nobody has.
    db.prepare(
      'INSERT INTO admin (id, username, password_hash, server_key, totp_secret, grant_seed) VALUES (1, ?, ?, ?, ?, ?)')
      .run(username.trim(), hashPassword(password), serverKey, '', null);

    reply.setCookie('session', createSession(serverKey), app.cookieOpts(false));
    stagePending(db);
    return reply.redirect('/admin-code/confirm');
  });

  // --- Login / logout / password -------------------------------------------

  app.get('/login', async (req, reply) => {
    if (!app.getAdmin()) return reply.redirect('/setup');
    if (app.isLoggedIn(req)) return reply.redirect('/');
    return reply.view('login.ejs', { title: T(req, 'title.login'), error: null, showNav: false, hasKit: latestKit(db, db.name).ok });
  });

  app.post('/login', async (req, reply) => {
    const admin = app.getAdmin();
    if (!admin) return reply.redirect('/setup');
    const { username, password, remember } = req.body ?? {};
    if (username !== admin.username || !verifyPassword(password ?? '', admin.password_hash)) {
      return reply.view('login.ejs', { title: T(req, 'title.login'), error: T(req, 'err.invalidCredentials'), showNav: false, hasKit: latestKit(db, db.name).ok });
    }
    const rem = remember === 'on' || remember === 'true';
    reply.setCookie('session', createSession(admin.server_key, rem), app.cookieOpts(rem));
    return reply.redirect('/');
  });

  app.post('/logout', async (req, reply) => {
    reply.clearCookie('session', app.cookieOpts(false));
    return reply.redirect('/login');
  });

  // --- Settings (update + password + sessions) ------------------------------
  // One page rather than a tab each: these are opened a handful of times a year (PRD §5.2).

  function settingsModel(req, extra = {}) {
    return {
      title: T(req, 'title.settings'),
      navActive: 'settings',
      updates: db.prepare('SELECT * FROM updates ORDER BY announced_at DESC, id DESC').all(),
      versions: db.prepare(
        `SELECT version, count(*) n FROM clients WHERE revoked_at IS NULL AND version IS NOT NULL
         GROUP BY version ORDER BY n DESC`
      ).all(),
      // The household pictures. Named by what a kid sees rather than by the enforcement state they
      // key off, because that is the choice being made when someone picks one.
      backgrounds: SLOTS.map((slot) => ({ slot, row: storedBackground(db, GLOBAL, slot) })),
      // About: what this server is and who to shout at. The version is derived rather than typed,
      // and says +dev when the tree is not the release it claims to be (ADR-0011).
      version: VERSION,
      isDevBuild: IS_DEV_BUILD,
      protocolVersion: PROTOCOL_VERSION,
      branding: BRANDING,
      // Each language named in its own language, so a parent who has landed in the wrong one can
      // still find their way back out of the dropdown.
      languages: LANGUAGES,
      languageNames: { en: 'English', hu: 'Magyar' },
      // Alerts. One setting for the household — not per Client and not per device — so every Alert
      // Device gets everything switched on here (CONTEXT.md: Alert).
      alerts: ALERT_SETTINGS.map((key) => ({ key, on: !!app.getAdmin()?.[`alert_${key}`] })),
      alertDevices: alertDevices(db),
      messageTemplates: app.getAdmin()?.message_templates || '',
      vapidPublicKey: vapidKeys(db)?.vapid_public ?? null,
      error: null, ok: null,
      ...extra,
    };
  }

  app.get('/settings', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    // The update upload lives in its own route file and reports back through the query string,
    // since settingsModel() is scoped here.
    // 'language' is a token, not a message: the confirmation has to be rendered in the language
    // just chosen, which only this request knows. Everything else arrives as finished text from the
    // upload route.
    const ok = req.query.ok === 'language'
      ? translate(req.lang, 'settings.languageSaved')
      : req.query.ok || null;
    return reply.view('settings.ejs', settingsModel(req, {
      error: req.query.error || null,
      ok,
    }));
  });

  // The old one-purpose pages are gone; keep the URLs pointing somewhere sensible.
  app.get('/password', async (req, reply) => reply.redirect('/settings'));

  app.post('/password', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const admin = app.getAdmin();
    const { current, password, password2 } = req.body ?? {};
    if (!verifyPassword(current ?? '', admin.password_hash)) {
      return reply.view('settings.ejs', settingsModel(req, { error: T(req, 'err.currentPasswordWrong') }));
    }
    if (!password || password !== password2) {
      return reply.view('settings.ejs', settingsModel(req, { error: T(req, 'err.newPasswordsDiffer') }));
    }
    db.prepare('UPDATE admin SET password_hash = ? WHERE id = 1').run(hashPassword(password));
    // Deliberately does *not* rotate the Server Key: silently ejecting yourself from every device
    // is a surprise, and rotation should be something the Admin chose (CONTEXT.md: Server Key).
    return reply.view('settings.ejs', settingsModel(req, { ok: T(req, 'ok.passwordChanged') }));
  });

  // The only revocation a stateless HMAC session has: change what signs them.
  app.post('/settings/logout-all', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const serverKey = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE admin SET server_key = ? WHERE id = 1').run(serverKey);
    reply.clearCookie('session', app.cookieOpts(false));
    return reply.redirect('/login');
  });

  // The language of these pages, and of nothing else. A Client's language is chosen on the Client
  // and never travels in either direction (ADR-0012), so there is nothing to push here.
  app.post('/settings/language', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;

    const lang = req.body?.lang;
    if (!isSupportedLanguage(lang)) {
      return reply.view('settings.ejs', settingsModel(req, { error: T(req, 'err.unknownLanguage') }));
    }

    db.prepare('UPDATE admin SET lang = ? WHERE id = 1').run(lang);
    // Redirect rather than render: the preHandler resolved `t` for this request before the update,
    // so rendering now would confirm the change in the language being left behind.
    return reply.redirect('/settings?ok=language');
  });

  app.post('/settings/templates', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const text = req.body?.message_templates ?? '';
    db.prepare('UPDATE admin SET message_templates = ? WHERE id = 1').run(text);
    return reply.redirect('/settings');
  });

  // --- Clients --------------------------------------------------------------

  // Reporting Clients first, then offline ones; alphabetical inside each group. The live fragment
  // applies the same ordering every five seconds, so a PC that comes online moves into the group
  // where the Admin expects to find something they can act on immediately.
  function clientCards() {
    const clients = db.prepare(
      `SELECT c.*, datetime(c.last_seen_at, 'localtime') AS last_seen_local,
              ${USED_TODAY_MINUTES} AS used_today,
              s.downtime_start, s.downtime_end, s.weekday_minutes, s.weekend_minutes
       FROM clients c LEFT JOIN settings s ON s.client_id = c.id
       ORDER BY c.revoked_at IS NOT NULL, c.name`
    ).all();
    // Each card carries a slim ribbon of the day so far — the same minute strip the Client Page
    // draws, run-length encoded by dailyData, so the shape of the day is on the card and not a tap
    // away. One per-day indexed query per Client per render; family scale, not fleet scale.
    const today = new Date().toLocaleDateString('en-CA');
    return {
      serverProtocol: PROTOCOL_VERSION,
      timeLeftText,
      timeLeftKind,
      clients: clients.map((c) => {
        const online = app.hub.isOnline(c.id);
        const sim = simulateOfflineDayRollover(c, online);
        return {
          ...sim,
          online,
          segments: dailyData(db, sim.id, today).segments,
        };
      }).sort((a, b) => Number(b.online) - Number(a.online)
        || Number(!!a.revoked_at) - Number(!!b.revoked_at)
        || a.name.localeCompare(b.name)),
    };
  }

  app.get('/clients', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    return reply.view('clients.ejs', {
      title: T(req, 'title.clients'), navActive: 'clients',
      // The Install Kit is offered here because this is where "I need another PC on this" occurs to
      // someone. Same conditional as the login page: no link to an empty download page.
      hasKit: latestKit(db, db.name).ok,
      ...clientCards(),
    });
  });

  // The same partial the page rendered, so the grid has exactly one definition (PRD §5).
  app.get('/clients/grid', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    return reply.view('partials/client-cards.ejs', { fragment: true, ...clientCards() });
  });

  // Status line, fast tick. Everything it needs is denormalised onto the clients row.
  app.get('/clients/:id/header', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const client = db.prepare(
      `SELECT c.*, datetime(c.last_seen_at, 'localtime') AS last_seen_local,
              ${USED_TODAY_MINUTES} AS used_today,
              datetime(created_at, 'localtime') AS created_local
       FROM clients c WHERE c.id = ?`
    ).get(req.params.id);
    if (!client) return reply.code(404).send('No such client');
    const settings = db.prepare('SELECT * FROM settings WHERE client_id = ?').get(client.id);
    const withSettings = { ...client, ...settings };
    const online = app.hub.isOnline(client.id);
    const sim = simulateOfflineDayRollover(withSettings, online);
    return reply.view('partials/client-header.ejs', {
      fragment: true,
      client: sim, timeLeftKind,
      serverProtocol: PROTOCOL_VERSION,
      online,
      timeLeft: timeLeftText(sim, (k, vars) => T(req, k, vars)),
      locked: isLocked(sim),
    });
  });

  // Day card + recent events, slow tick. Only ever requested for today (client.ejs decides).
  app.get('/clients/:id/day', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const client = db.prepare('SELECT id, name FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return reply.code(404).send('No such client');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '')
      ? req.query.date
      : new Date().toLocaleDateString('en-CA');
    return reply.view('partials/client-day.ejs', {
      fragment: true,
      client,
      day: dailyData(db, client.id, date),
      events: dayEvents(client.id, date),
    });
  });

  // Events worth a mark on the timeline. Not every Event: a message shown and an update installed
  // happen routinely, and a timeline speckled with routine is one nobody reads. These are the ones a
  // parent would want to be *told* about — the rest are a click away on the logs page.
  const MARKED_EVENTS = ['exit-via-code', 'unclean-exit', 'clock-jump', 'grant-redeemed', 'disabled'];

  // client_ts is 'YYYY-MM-DDTHH:MM:SS±HH:MM' (ClientEvent.Stamp), so the date and the minute of the
  // day both come straight out of the string — no timezone maths, because the Client already did it.
  const dayEvents = (clientId, date) => db.prepare(
    `SELECT type, client_ts,
            CAST(substr(client_ts, 12, 2) AS INTEGER) * 60
          + CAST(substr(client_ts, 15, 2) AS INTEGER) AS minute
       FROM events
      WHERE client_id = ? AND substr(client_ts, 1, 10) = ?
        AND type IN (${MARKED_EVENTS.map(() => '?').join(', ')})
      ORDER BY client_ts`
  ).all(clientId, date, ...MARKED_EVENTS);

  app.get('/clients/:id', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const client = db.prepare(
      `SELECT c.*, datetime(c.last_seen_at, 'localtime') AS last_seen_local,
              ${USED_TODAY_MINUTES} AS used_today,
              datetime(c.created_at, 'localtime') AS created_local
       FROM clients c WHERE c.id = ?`
    ).get(req.params.id);
    if (!client) return reply.code(404).send('No such client');
    const settings = db.prepare('SELECT * FROM settings WHERE client_id = ?').get(client.id);

    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '')
      ? req.query.date
      : new Date().toLocaleDateString('en-CA');   // local YYYY-MM-DD
    const day = dailyData(db, client.id, date);
    const events = dayEvents(client.id, date);

    // Both what is set *here* and what this PC will actually show: with no override those differ,
    // and a blank box on this page next to a photograph on the kid's screen is how an inherited
    // picture becomes impossible to trace.
    const backgrounds = SLOTS.map((slot) => ({
      slot,
      own: storedBackground(db, client.id, slot),
      resolved: resolveBackground(db, client.id, slot),
    }));

    const withSettings = { ...client, ...settings };
    const online = app.hub.isOnline(client.id);
    const sim = simulateOfflineDayRollover(withSettings, online);
    return reply.view('client.ejs', {
      title: sim.name,
      navActive: 'clients',
      client: sim, settings, day, events, timeLeftKind, backgrounds,
      messageTemplates: app.getAdmin()?.message_templates || '',
      error: req.query.error || null,
      ok: req.query.ok || null,
      serverProtocol: PROTOCOL_VERSION,
      online,
      timeLeft: timeLeftText(sim, (k, vars) => T(req, k, vars)),
      locked: isLocked(sim),
    });
  });

  // Raw ping/event tables live here, paginated, off the graphical Client Page (PRD §5.2).
  app.get('/clients/:id/logs', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const client = db.prepare('SELECT id, name FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return reply.code(404).send('No such client');

    const tab = req.query.tab === 'events' ? 'events' : 'pings';
    const perPage = 100;
    const page = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * perPage;

    const total = db.prepare(`SELECT count(*) n FROM ${tab} WHERE client_id = ?`).get(client.id).n;
    const rows = tab === 'events'
      ? db.prepare(`SELECT *, datetime(received_at, 'localtime') AS received_local
                    FROM events WHERE client_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`).all(client.id, perPage, offset)
      : db.prepare(`SELECT *, datetime(ts, 'localtime') AS ts_local
                    FROM pings WHERE client_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`).all(client.id, perPage, offset);

    return reply.view('logs.ejs', {
      title: T(req, 'title.clientLogs', [client.name]),
      navActive: 'clients',
      client, tab, rows, page, perPage, total,
      pages: Math.max(1, Math.ceil(total / perPage)),
    });
  });

  app.post('/clients/:id/settings', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const { downtime_start, downtime_end, weekday_minutes, weekend_minutes } = req.body ?? {};
    db.prepare(
      `UPDATE settings SET downtime_start = ?, downtime_end = ?, weekday_minutes = ?, weekend_minutes = ?
       WHERE client_id = ?`
    ).run(downtime_start, downtime_end, Number(weekday_minutes), Number(weekend_minutes), id);
    app.hub.send(id, { type: 'settings', settings: db.prepare('SELECT * FROM settings WHERE client_id = ?').get(id) });
    return reply.redirect(`/clients/${id}`);
  });

  const reportHeaders = (reply) => reply
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer');

  const deniedReport = (req, reply) => reportHeaders(reply).code(403).view('report-denied.ejs', {
    fragment: true,
    title: T(req, 'report.invalidTitle'),
    message: T(req, 'report.invalidLink'),
  });

  app.post('/clients/:id/report/access', (req, reply) => {
    const clientId = Number(req.params.id);
    const days = Number(req.query.days);
    const link = app.reportLinks.validate(req.body?.token, clientId, days);
    if (!link) return deniedReport(req, reply);

    const maxAge = Math.max(1, Math.floor(link.remainingMs / 1000));
    reply.setCookie(reportCookieName(clientId, days), req.body.token, {
      path: reportCookiePath(clientId), httpOnly: true, sameSite: 'strict', secure: 'auto', maxAge,
    });
    return reportHeaders(reply).code(303).redirect(`/clients/${clientId}/report?days=${days}`);
  });

  app.get('/clients/:id/report', (req, reply) => {
    const days = Number(req.query.days);
    const clientId = Number(req.params.id);
    const admin = app.isLoggedIn(req);
    const link = REPORT_DAYS.has(days)
      ? app.reportLinks.validate(req.cookies[reportCookieName(clientId, days)], clientId, days)
      : null;

    if (!admin && !link) {
      return reportHeaders(reply).view('report-open.ejs', {
        fragment: true,
        title: T(req, 'report.opening'),
        opening: T(req, 'report.opening'),
        action: `/clients/${clientId}/report/access?days=${encodeURIComponent(req.query.days ?? '')}`,
      });
    }
    if (!REPORT_DAYS.has(days)) return reportHeaders(reply).code(400).send('Invalid days');

    const client = db.prepare(
       `SELECT c.*, s.weekday_minutes, s.weekend_minutes 
        FROM clients c 
        LEFT JOIN settings s ON s.client_id = c.id 
        WHERE c.id = ?`
    ).get(clientId);
    if (!client) return reportHeaders(reply).code(404).send('No such client');

    const dates = [];
    for (let i = 0; i < days; i++) {
       dates.push(db.prepare(`SELECT date('now', 'localtime', ?)`).pluck().get(`-${i} days`));
    }
    dates.reverse();

    const usageMap = new Map();
    const rolledUp = db.prepare(
       `SELECT date, used_minutes, blocked_minutes, apps
        FROM daily_usage
        WHERE client_id = ? AND date >= ? AND date <= ?`
    ).all(client.id, dates[0], dates[dates.length - 1]);
    
    for (const r of rolledUp) {
       usageMap.set(r.date, {
           used: r.used_minutes,
           blocked: r.blocked_minutes,
           apps: r.apps ? JSON.parse(r.apps) : {}
       });
    }

    for (const date of dates) {
       if (!usageMap.has(date)) {
           const d = dailyData(db, client.id, date);
           usageMap.set(date, {
               used: d.totalUsableMinutes,
               blocked: d.totalBlockedMinutes,
               apps: Object.fromEntries(d.apps.map(a => [a.app, a.minutes]))
           });
       }
    }

    let totalUsed = 0;
    const allApps = new Map();

    const dailyStats = dates.map(date => {
       const u = usageMap.get(date);
       if (u.used > 0 || u.blocked > 0) {
           totalUsed += u.used;
           for (const [app, mins] of Object.entries(u.apps)) {
               allApps.set(app, (allApps.get(app) || 0) + mins);
           }
       }
       return { date, ...u };
    });

    const averageUsed = Math.round(totalUsed / days);
    const topApps = [...allApps.entries()]
       .sort((a, b) => b[1] - a[1])
       .slice(0, 5)
       .map(([app, mins]) => ({ app, percent: Math.round((mins / totalUsed) * 100) }));

    return reportHeaders(reply).view('report.ejs', {
       fragment: true,
       client, days, dates, dailyStats, averageUsed, topApps,
       T: (k, vars) => translate(req.lang, k, vars),
       req
    });
  });

  app.post('/clients/:id/rename', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const name = req.body?.name?.trim();
    if (name) db.prepare('UPDATE clients SET name = ? WHERE id = ?').run(name, req.params.id);
    return reply.redirect(`/clients/${req.params.id}`);
  });

  app.post('/clients/:id/revoke', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    db.prepare('UPDATE clients SET revoked_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
    return reply.redirect(`/clients/${req.params.id}`);
  });

  app.post('/clients/:id/delete', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    // Database rows cascade; files on disk do not, and an orphaned background has nothing left to
    // name it once its Client is gone.
    removeBackgroundsFor(db, Number(req.params.id));
    db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
    return reply.redirect('/clients');
  });

  // --- Live actions (no-op if the client is offline — live-only by design) --

  // These three answer back. A command that vanishes into a WebSocket has nothing on screen to show
  // it happened — Time Left moves eventually, but a message and a lock leave the page looking
  // untouched, and the Quick actions panel exists precisely to be used without reading the page
  // afterwards. `done` is how they say so.
  const done = (reply, id, text) => reply.redirect(`/clients/${id}?ok=${encodeURIComponent(text)}`);

  app.post('/clients/:id/message', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const text = req.body?.text?.trim();
    if (!text) return reply.redirect(`/clients/${id}`);
    app.hub.send(id, { type: 'message', text });
    return done(reply, id, T(req, 'ok.messageSent'));
  });

  app.post('/clients/:id/adjust', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const minutes = Number(req.body?.minutes);
    if (!Number.isInteger(minutes) || minutes === 0) return reply.redirect(`/clients/${id}`);
    app.hub.send(id, { type: 'adjust', minutes });
    // One handler, two things a parent did: the Quick actions panel only ever gives, the +/- box in
    // Actions can take away, and "30 minutes given" for a subtraction would be a lie.
    return done(reply, id, minutes > 0
      ? T(req, 'ok.timeGiven', [minutes])
      : T(req, 'ok.timeTaken', [-minutes]));
  });

  // Disable/Enable toggle — a resident pause, remotely reversible (PRD §5.3). The server owns the
  // flag; the toggle sends the live command and clients also reconcile via hello.
  app.post('/clients/:id/disable', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const disabled = db.prepare('SELECT disabled FROM clients WHERE id = ?').get(id)?.disabled === 1;
    const next = disabled ? 0 : 1;
    db.prepare('UPDATE clients SET disabled = ? WHERE id = ?').run(next, id);
    app.hub.send(id, { type: next ? 'disable' : 'enable' });
    return reply.redirect(`/clients/${id}`);
  });

  app.post('/clients/:id/lock', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    // The lock/unlock intent is inferred from the client's own reported state (last_reason),
    // so the button reflects reality even after the client auto-releases at midnight.
    const locked = db.prepare('SELECT last_reason FROM clients WHERE id = ?').get(id)?.last_reason === 'locked';
    app.hub.send(id, { type: locked ? 'unlock' : 'lock' });
    // What the Client reports is what the button reads next time, and that report is a ping away —
    // so the confirmation names the command that was sent, not a state anyone has confirmed yet.
    return done(reply, id, T(req, locked ? 'ok.unlockSent' : 'ok.lockSent'));
  });

  app.post('/clients/:id/end-today', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    app.hub.send(id, { type: 'end-today' });
    return reply.redirect(`/clients/${id}`);
  });

  // --- Requests -------------------------------------------------------------
  // The kid→parent channel (CONTEXT.md: Request). Its own page rather than a panel on the Client
  // Page, because the parent arrives here from a notification knowing only that *someone* asked.

  // The Requests page holds two different things and they are modelled apart, because they want
  // opposite treatment: the open queue is live work that must never be paged or date-scoped (a
  // Request expiring in ten minutes hidden behind a pager is a bug), while the history is kept
  // forever and is read by paging back through it.

  // Every read of the queue sweeps first: a Request whose hour ran out is not something a parent
  // should still be offered an Approve button for, and the once-a-minute timer may be up to 60
  // seconds behind.
  //
  // No LIMIT: there is at most one open Request per Client, so the old cap of 50 was never
  // protecting anything, and a cap shared with the history could only ever have hidden live work.
  function openModel() {
    lapseExpired(db);
    const open = db.prepare(
      `SELECT r.*, c.name AS client_name,
              datetime(r.created_at, 'localtime') AS created_local,
              datetime(r.expires_at, 'localtime') AS expires_local
         FROM requests r JOIN clients c ON c.id = r.client_id
        WHERE r.state = 'open'
        ORDER BY r.id DESC`
    ).all();
    return {
      maxAsk: MAX_ASK_MINUTES,
      open,
      online: Object.fromEntries(open.map((r) => [r.client_id, app.hub.isOnline(r.client_id)])),
    };
  }

  const HISTORY_PAGE = 50;

  const HISTORY_SELECT = `SELECT r.*, c.name AS client_name,
              datetime(r.created_at, 'localtime') AS created_local,
              datetime(r.decided_at, 'localtime') AS decided_local
         FROM requests r JOIN clients c ON c.id = r.client_id
        WHERE r.state != 'open'`;

  const historyNewest = db.prepare(`${HISTORY_SELECT} ORDER BY r.id DESC LIMIT ?`);
  const historyBefore = db.prepare(`${HISTORY_SELECT} AND r.id < ? ORDER BY r.id DESC LIMIT ?`);
  // Ascending, then reversed: the page immediately *newer* than a cursor is the run of rows closest
  // above it, which only an ascending scan can take.
  const historyAfter = db.prepare(`${HISTORY_SELECT} AND r.id > ? ORDER BY r.id LIMIT ?`);
  const historyEdges = db.prepare(
    `SELECT EXISTS(SELECT 1 FROM requests WHERE state != 'open' AND id > ?) AS has_newer,
            EXISTS(SELECT 1 FROM requests WHERE state != 'open' AND id < ?) AS has_older`
  );

  /**
   * A page of answered Requests, newest first, grouped under local dates.
   *
   * Keyset rather than OFFSET: new Requests arrive at the top of a newest-first list, so an offset
   * page two would slide under the reader and show a row twice or not at all. `id` is the cursor —
   * monotonic, unique, and already the PK.
   */
  function historyModel({ before, after }) {
    let rows;
    if (after) {
      rows = historyAfter.all(after, HISTORY_PAGE);
      // Fewer than a page above the cursor means the newest page is what "Newer" was reaching for.
      if (rows.length < HISTORY_PAGE) rows = historyNewest.all(HISTORY_PAGE);
      else rows.reverse();
    } else if (before) {
      rows = historyBefore.all(before, HISTORY_PAGE);
    } else {
      rows = historyNewest.all(HISTORY_PAGE);
    }

    // Days are built by walking the page rather than grouping it, so the headings come out in the
    // same order as the rows and a day split across two pages stays split rather than silently
    // pretending to be whole.
    const days = [];
    for (const r of rows) {
      const date = String(r.created_local).slice(0, 10);
      if (!days.length || days[days.length - 1].date !== date) days.push({ date, rows: [] });
      days[days.length - 1].rows.push(r);
    }

    const newest = rows[0]?.id ?? 0;
    const oldest = rows[rows.length - 1]?.id ?? 0;
    const edges = rows.length ? historyEdges.get(newest, oldest) : { has_newer: 0, has_older: 0 };
    return {
      history: {
        days,
        newerAfter: edges.has_newer ? newest : null,
        olderBefore: edges.has_older ? oldest : null,
      },
    };
  }

  const cursor = (v) => (/^\d+$/.test(v ?? '') ? Number(v) : null);

  // Deliberately no sweep: this is polled from every open tab every few seconds, and a write
  // transaction that often to change nothing is a poor trade. Excluding expired rows in the WHERE
  // gives the same number without one, and stays right between sweeps.
  const openRequestCount = () =>
    db.prepare("SELECT count(*) n FROM requests WHERE state = 'open' AND expires_at > datetime('now')").get().n;

  app.get('/requests', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    return reply.view('requests.ejs', {
      title: T(req, 'title.requests'), navActive: 'requests',
      ...openModel(),
      ...historyModel({ before: cursor(req.query.before), after: cursor(req.query.after) }),
    });
  });

  // The same partial the page rendered, refreshed in place — an open Request is exactly the kind of
  // thing that arrives while you are already looking at the list.
  app.get('/requests/list', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    return reply.view('partials/request-list.ejs', { fragment: true, ...openModel() });
  });

  // The nav badge. A fragment of its own so every page can carry it without threading a count
  // through each view model — live.js refreshes any element with data-live-src.
  app.get('/requests/badge', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const n = openRequestCount();
    return reply.type('text/html').send(n ? `<span class="tag ask">${n}</span>` : '');
  });

  app.post('/requests/:id/decide', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    const approve = req.body?.decision === 'approve';
    const minutes = Number(req.body?.minutes);
    // A zero-minute approval is a decline wearing a friendly face; refuse it rather than send the
    // kid a message saying they were given nothing.
    if (approve && !(Number.isInteger(minutes) && minutes > 0)) return reply.redirect('/requests');

    const row = decide(db, Number(req.params.id), { approve, minutes });
    // Undefined means it lapsed or another phone answered first — the page will show which.
    if (row && app.hub.send(row.client_id, verdictMessage(row))) markDelivered(db, row.id);
    // Replaces the asking Alert on every phone with the answer, under the same tag. Only fires when
    // `row` exists, which is exactly when *this* click was the one that decided it — so a second
    // parent tapping Approve a moment later cannot overwrite the real verdict with a second one.
    if (row) app.alerts?.onRequestDecided(row);
    return reply.redirect('/requests');
  });

  // --- Alerts ---------------------------------------------------------------
  // A subscription is an address, not a person or a permission: there is exactly one Admin, so
  // every row is that Admin on some device and everything enabled goes to all of them.

  app.post('/alerts/subscribe', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.code(401).send({ error: 'unauthorized' });
    if (!registerDevice(db, req.body?.subscription, req.body?.label)) {
      return reply.code(400).send({ error: 'bad subscription' });
    }
    return { ok: true };
  });

  app.post('/alerts/unsubscribe', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.code(401).send({ error: 'unauthorized' });
    forgetDevice(db, String(req.body?.endpoint ?? ''));
    return { ok: true };
  });

  // Removing a device from the settings page cannot actually revoke anything in that browser — the
  // subscription lives there and only it can drop it. What this does is stop sending, which is the
  // part the household controls. The browser finds out the next time it looks.
  app.post('/alerts/forget', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    forgetDevice(db, String(req.body?.endpoint ?? ''));
    return reply.redirect('/settings');
  });

  app.post('/alerts/settings', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    // Absent means unchecked: an HTML checkbox that is off sends nothing at all.
    for (const key of ALERT_SETTINGS) {
      db.prepare(`UPDATE admin SET alert_${key} = ? WHERE id = 1`).run(req.body?.[key] ? 1 : 0);
    }
    return reply.redirect('/settings');
  });

  // Proves the whole chain end to end — keys, subscription, push service, phone — which is worth a
  // button of its own, because every other Alert only fires when something real happens and waiting
  // for a kid to run out of time is a poor way to find out the setup is broken.
  app.post('/alerts/test', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.code(401).send({ error: 'unauthorized' });
    const result = await broadcastTest(req);
    return { ok: true, ...result };
  });

  const broadcastTest = async (req) => {
    const { broadcast } = await import('../push.js');
    return broadcast(app, {
      title: T(req, 'alerts.test.title'),
      body: T(req, 'alerts.test.body'),
      tag: 'alert-test',
      url: '/settings',
    });
  };

  // --- Client updates -------------------------------------------------------

  app.get('/update', async (req, reply) => reply.redirect('/settings'));

  // --- Admin Code ----------------------------------------------------------

  app.get('/family-code', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    // The secret itself is never re-shown (PRD §5.1); the current *code* is, so the Admin can hand
    // out extra time without reaching for a phone. Regeneration is the only way to recover a secret.
    // No code is baked into the HTML: family-code.js fills it in, from a local secret on a Trusted
    // Device or from the server otherwise. That is what makes the page cacheable (PRD §5.4).
    return reply.view('family-code-manage.ejs', {
      title: T(req, 'title.codes'), navActive: 'family-code',
      // Whether anyone ever proved this secret is reachable without the server (ADR-0010).
      adminCodeConfirmed: app.getAdmin().admin_code_confirmed === 1,
      error: req.query.error || null,
      ok: req.query.ok || null,
    });
  });

  // Hands the Admin Code secret to one browser, so it can compute codes with the server down.
  // Password-gated on purpose: an unlocked phone with a live session is not proof of anything, and
  // this is the one action that copies the household's root credential (ADR-0002).
  app.post('/family-code/trust', async (req, reply) => {
    const admin = app.getAdmin();
    if (!admin || !app.isLoggedIn(req)) return reply.code(401).send({ error: 'unauthorized' });
    if (!verifyPassword(req.body?.password ?? '', admin.password_hash)) {
      return reply.code(401).send({ error: 'bad password' });
    }
    // Both household secrets, because a Trusted Device has to make both kinds of code with the
    // server down — and the outage that matters is the one where a Client is blocked at bedtime and
    // the server is what went missing (ADR-0002, ADR-0006).
    return { secret: admin.totp_secret, grantSeed: admin.grant_seed };
  });

  // Polled by the Admin Code page so the displayed codes stay current. Untrusted browsers get the
  // codes rather than the keys: the Grant Seed never leaves the server for a device the Admin has
  // not deliberately trusted, or every browser that ever logged in would be able to mint time.
  app.get('/family-code/current', async (req, reply) => {
    const admin = app.getAdmin();
    if (!admin || !app.isLoggedIn(req)) return reply.code(401).send({ error: 'unauthorized' });
    // This route is guarded by isLoggedIn rather than requireAdmin, so the unfinished-setup redirect
    // does not cover it — and the service worker will happily keep polling a cached Codes page.
    // There is no code to compute from a secret that is still provisional (ADR-0010); the page reads
    // this the same way it reads an unreachable server, and shows dashes.
    if (!hasLiveSecret(admin) || !admin.grant_seed) {
      return reply.code(503).send({ error: 'admin code not confirmed yet' });
    }

    const minutes = Math.max(1, Math.min(999, Number.parseInt(req.query?.minutes, 10) || 15));
    const grant = currentGrantCode(admin.grant_seed, minutes);
    return { ...currentCode(admin.totp_secret), grant: grant.code, grantSecondsLeft: grant.secondsLeft };
  });

  app.post('/family-code/regenerate', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    // Staged, not applied (ADR-0010). The old pair stays in force and the Clients are told nothing
    // until someone proves they can produce a code from the new one — so backing out costs nothing,
    // and a closed tab leaves the household exactly as it was.
    stagePending(db);
    return reply.redirect('/admin-code/confirm');
  });

  // --- Proving the Admin Code left the building ------------------------------

  /** Both household secrets rotate together (ADR-0006), as two messages so an older Client can
   *  ignore the one it does not understand and still pick up the other. */
  function announceSecrets({ secret, seed }) {
    for (const clientId of app.hub.sockets.keys()) {
      app.hub.send(clientId, { type: 'family-code-secret', secret });
      app.hub.send(clientId, { type: 'grant-seed', seed });
    }
  }

  async function confirmView(req, extra = {}) {
    const admin = app.getAdmin();
    const secret = admin.pending_totp_secret;
    return {
      title: T(req, 'title.adminCode'),
      showNav: false,          // the nav is an escape route, and this screen is not optional
      firstRun: !hasLiveSecret(admin),
      secret,
      qr: await secretQrDataUrl(secret),
      error: null,
      ...extra,
    };
  }

  app.get('/admin-code/confirm', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    if (!isPending(app.getAdmin())) return reply.redirect('/family-code');
    return reply.view('admin-code-confirm.ejs', await confirmView(req));
  });

  app.post('/admin-code/confirm', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    if (!isPending(app.getAdmin())) return reply.redirect('/family-code');

    const { code, skip, acknowledged } = req.body ?? {};

    if (skip) {
      // Allowed on purpose — a test box, or someone who has weighed it up. The acknowledgement is
      // the whole gate, and admin_code_confirmed stays 0 so the Codes page keeps saying so.
      if (!acknowledged) {
        return reply.view('admin-code-confirm.ejs',
          await confirmView(req, { error: T(req, 'err.tickToSkip') }));
      }
      announceSecrets(promotePending(db, false));
      return reply.redirect('/family-code?ok=' + encodeURIComponent(T(req, 'ok.adminCodeUnproven')));
    }

    if (!checkPending(db, code)) {
      return reply.view('admin-code-confirm.ejs',
        await confirmView(req, { error: T(req, 'err.codeNotAccepted') }));
    }

    announceSecrets(promotePending(db, true));
    return reply.redirect('/family-code?ok=' + encodeURIComponent(T(req, 'ok.adminCodeConfirmed')));
  });

  /** First run only: a bad scan or the wrong entry in the authenticator app. Throws the provisional
   *  pair away and starts again — nothing was ever in force, so there is nothing to lose. */
  app.post('/admin-code/restart', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    stagePending(db);
    return reply.redirect('/admin-code/confirm');
  });

  /** Regeneration only: keep whatever is already in force. */
  app.post('/admin-code/cancel', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    if (!hasLiveSecret(app.getAdmin())) return reply.redirect('/admin-code/confirm');
    discardPending(db);
    return reply.redirect('/family-code?ok=' + encodeURIComponent('Kept your current Admin Code.'));
  });

  /** The way back from a skip: prove the *live* secret, from the Codes page. */
  app.post('/admin-code/prove', async (req, reply) => {
    if (!app.requireAdmin(req, reply)) return;
    if (!checkLive(db, req.body?.code)) {
      return reply.redirect('/family-code?error=' + encodeURIComponent(
        'That code was not accepted. Check your phone\'s clock is set automatically.'));
    }
    markConfirmed(db);
    return reply.redirect('/family-code?ok=' + encodeURIComponent(T(req, 'ok.adminCodeConfirmed')));
  });
}
