import { translate } from '../i18n.js';
import { mintCoupons, listCoupons, deleteCoupons, MAX_MINT_COUNT } from '../coupons.js';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const T = (req, key, vars) => translate(req.lang, key, vars);

// The Time Coupons page (ADR-0017): mint a batch, see the inventory, delete what must stop
// working, print what goes in a drawer. Lives under the Codes tab but on its own page: Codes is
// cached for offline Trusted Devices, and coupons are server-only by design.

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Presentation only, never stored or copied (ADR-0014): `KRTVXM030` shown as `KRT-VXM-030`. */
const grouped = (code) => `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export default async function couponRoutes(app) {
  const { db } = app;

  const back = (message, ok = true) =>
    `/coupons?${ok ? 'ok' : 'error'}=${encodeURIComponent(message)}`;

  app.get('/coupons', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');
    
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const status = req.query.status || 'all';
    const sort = req.query.sort || 'newer';
    const clientId = req.query.client_id || 'all';
    const limit = 50;
    
    const data = listCoupons(db, { status, sort, clientId, page, limit });
    
    return reply.view('coupons.ejs', {
      title: T(req, 'title.coupons'), navActive: 'family-code',
      coupons: data.items,
      pagination: { page: data.page, pages: data.pages, total: data.total, status, sort, clientId },
      grouped,
      clients: db.prepare('SELECT id, name FROM clients WHERE revoked_at IS NULL ORDER BY name').all(),
      today: new Date().toLocaleDateString('en-CA'),
      maxCount: MAX_MINT_COUNT,
      ok: req.query.ok ?? null, error: req.query.error ?? null,
    });
  });

  app.post('/coupons', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');

    const scope = req.body.scope === 'global' ? null : Number(req.body.scope);
    const minutes = Number(req.body.minutes);
    const count = Number(req.body.count);
    const expires = String(req.body.expires ?? '').trim() || null;

    const scopeOk = scope === null ||
      (Number.isInteger(scope) && db.prepare('SELECT 1 FROM clients WHERE id = ?').get(scope));
    // Refused rather than clamped, unlike a kid's Request: this is the Admin filling in a form,
    // and silently minting something other than what was typed is worse than asking again.
    const ok = scopeOk &&
      Number.isInteger(minutes) && minutes >= 1 && minutes <= 999 &&
      Number.isInteger(count) && count >= 1 && count <= MAX_MINT_COUNT &&
      (expires === null || DATE_SHAPE.test(expires));
    if (!ok) return reply.redirect(back(T(req, 'err.couponBadInput'), false));

    const minted = mintCoupons(db, { clientId: scope, minutes, expires, count });
    return reply.redirect(back(T(req, 'ok.couponsMinted', [minted.length])));
  });

  app.post('/coupons/delete', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');
    const ids = [req.body.id ?? []].flat();
    const gone = deleteCoupons(db, ids);
    return reply.redirect(back(T(req, 'ok.couponsDeleted', [gone])));
  });

  app.get('/coupons/print', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');
    const wanted = new Set([req.query.id ?? []].flat().map(Number));
    const coupons = listCoupons(db, { ids: Array.from(wanted) }).reverse();
    if (coupons.length === 0) return reply.redirect('/coupons');
    // What is selected prints — used and expired included: second-guessing a selection is worse
    // than trusting it, and the normal flow (mint, select batch, print) never hits the odd cases.

    // Fallback: render with ejs.renderFile directly since per-render layout override
    // conflicts with the global layout.
    const layoutPath = path.join(root, 'views', 'print-layout.ejs');
    const contentPath = path.join(root, 'views', 'coupons-print.ejs');
    const lang = req.lang;
    const t = (key, vars) => translate(lang, key, vars);

    const body = await ejs.renderFile(contentPath, {
      coupons, grouped, t, lang, title: t('title.coupons'),
    });

    const html = await ejs.renderFile(layoutPath, {
      title: t('title.coupons'),
      lang,
      body,
    });

    return reply.type('text/html').send(html);
  });
}
