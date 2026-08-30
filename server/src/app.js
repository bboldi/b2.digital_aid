import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import { resolveLanguage, translatorFor, vocabularyFor } from './i18n.js';
import { assetUrl, swAssets } from './assets.js';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import ejs from 'ejs';
import { openDb } from './db.js';
import { readSession, createSession, shouldSlide, REMEMBER_TTL_MS } from './auth.js';
import adminRoutes from './routes/admin.js';
import pairRoutes from './routes/pair.js';
import updateRoutes from './routes/update.js';
import backgroundRoutes from './routes/backgrounds.js';
import couponRoutes from './routes/coupons.js';
import downloadRoutes from './routes/download.js';
import wsRoutes, { ClientHub } from './ws.js';
import { startRollupSchedule } from './rollup.js';
import { startRequestSweep } from './requests.js';
import { registerAlerts } from './alert-service.js';

const root = path.dirname(fileURLToPath(import.meta.url));

export function build(opts = {}) {
  // trustProxy so `secure: 'auto'` on the session cookie sees the real scheme: PRD §7 deploys this
  // behind a TLS front end, which terminates HTTPS and forwards plain HTTP.
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: true });
  const db = openDb(opts.dbFile ?? path.join(root, '..', 'data', 'digital-aid.db'));

  app.decorate('db', db);
  app.decorate('hub', new ClientHub(db));
  app.decorate('getAdmin', () => db.prepare('SELECT * FROM admin WHERE id = 1').get());
  app.decorate('isLoggedIn', (req) => {
    const admin = app.getAdmin();
    return !!admin && readSession(req.cookies.session, admin.server_key) !== null;
  });
  // Session cookies are Secure whenever the request arrived over HTTPS. Deliberately 'auto' rather
  // than always: a hard true would silently break the http://localhost dev loop.
  app.decorate('cookieOpts', (remember) => ({
    path: '/', httpOnly: true, sameSite: 'lax', secure: 'auto',
    ...(remember ? { maxAge: Math.floor(REMEMBER_TTL_MS / 1000) } : {}),
  }));
  // Redirects to /setup or /login as needed; returns false if a redirect was sent. This is also
  // where Remember Me slides — a remembered session that has been alive a while is reissued, so a
  // device in daily use never logs out while an abandoned one still expires. It lives here rather
  // than in an onRequest hook because @fastify/cookie parses in a hook of its own that boots later.
  app.decorate('requireAdmin', (req, reply) => {
    const admin = app.getAdmin();
    if (!admin) {
      reply.redirect('/setup');
      return false;
    }
    const claims = readSession(req.cookies.session, admin.server_key);
    if (!claims) {
      reply.redirect('/login');
      return false;
    }
    if (shouldSlide(claims)) {
      reply.setCookie('session', createSession(admin.server_key, true), app.cookieOpts(true));
    }
    // A first run that never finished: a provisional Admin Code and none in force (ADR-0010). There
    // is nothing useful to do here until it is settled — pairing refuses, so every page would be a
    // page about a server nobody can attach a PC to. Sending them back is the recovery path for a
    // tab closed halfway.
    if (!admin.totp_secret && admin.pending_totp_secret && !req.url.startsWith('/admin-code/')) {
      reply.redirect('/admin-code/confirm');
      return false;
    }
    return true;
  });

  app.register(fastifyCookie);
  app.register(fastifyFormbody);
  app.register(fastifyWebsocket);
  app.register(fastifyMultipart, { limits: { fileSize: 512 * 1024 * 1024 } });
  app.register(fastifyStatic, { root: path.join(root, '..', 'public'), prefix: '/public/' });
  app.register(fastifyView, {
    engine: { ejs },
    root: path.join(root, '..', 'views'),
    layout: 'layout.ejs',
  });

  // Every render gets `t` and `lang` without each route remembering to pass them. Threading them
  // through by hand would mean the one page somebody forgot renders in English for a Hungarian
  // parent, and route models here are already built in several places (settingsModel, the client
  // page, the live fragments).
  app.addHook('preHandler', (req, reply, done) => {
    const lang = resolveLanguage(req, app.getAdmin());
    req.lang = lang;
    const view = reply.view.bind(reply);
    reply.view = (template, model, opts) =>
      view(template, { t: translatorFor(lang), v: vocabularyFor(lang), lang, asset: assetUrl, ...model }, opts);
    done();
  });

  // Served from the root, not /public/: a service worker may only control paths at or below its own
  // URL, and this one has to cover the whole admin app.
  // Read and substituted per request rather than streamed: __ASSETS__ carries the content hashes the
  // worker precaches under, and they change whenever a file does. 'no-cache' is what lets that land —
  // a cached service worker would keep serving the old cache name and defeat the whole mechanism.
  app.get('/sw.js', (req, reply) => {
    const source = fs.readFileSync(path.join(root, '..', 'public', 'sw.js'), 'utf8');
    return reply.type('text/javascript').header('Cache-Control', 'no-cache')
      .send(source.replace('__ASSETS__', JSON.stringify(swAssets())));
  });

  app.register(adminRoutes);
  // Before the routes and the socket: both reach for app.alerts, and this is what decorates it.
  // Registering it cannot fail the server — every path inside swallows its own errors, because a
  // notification that cannot be delivered must never be able to break the thing it was about.
  registerAlerts(app);

  app.register(pairRoutes);
  app.register(updateRoutes);
  app.register(backgroundRoutes);
  app.register(couponRoutes);
  app.register(downloadRoutes);
  app.register(wsRoutes);

  // Pings older than the horizon become Daily Summaries (ADR-0003). Opt-out so tests can drive the
  // rollup themselves instead of racing a timer.
  if (opts.rollup !== false) startRollupSchedule(app);

  // Requests go stale on a clock, not on a click: the badge must stop counting an ask nobody can
  // answer any more, even on a tab left open all evening. Same opt-out so tests drive it directly.
  if (opts.rollup !== false) startRequestSweep(app);

  app.addHook('onClose', async () => db.close());
  return app;
}
