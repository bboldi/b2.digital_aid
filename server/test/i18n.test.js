import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/app.js';
import { createSession, hashPassword } from '../src/auth.js';
import { translate, resolveLanguage, keysOf, LANGUAGES } from '../src/i18n.js';

// The catalogues checked as data, and the resolution order checked as behaviour. A half-translated
// page is the normal failure here and it is silent by nature: nothing throws, nothing 500s, a
// Hungarian parent just reads some English.

const en = () => keysOf('en');
const hu = () => keysOf('hu');
const placeholders = (s) => new Set([...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]));

function startServer(t, lang = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-aid-i18n-'));
  const app = build({ dbFile: path.join(dir, 'test.db'), logger: false, rollup: false });

  app.db.prepare(
    `INSERT INTO admin (id, username, password_hash, server_key, totp_secret, lang)
     VALUES (1, 'parent', ?, 'test-server-key', 'AAAAAAAAAAAAAAAA', ?)`
  ).run(hashPassword('irrelevant'), lang);

  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { app, cookie: `session=${createSession('test-server-key')}` };
}

test('every English string has a Hungarian one', () => {
  const missing = en().filter((k) => !hu().includes(k)).sort();
  assert.deepEqual(missing, [], `no Hungarian for: ${missing.join(', ')}`);
});

test('no Hungarian string is left over', () => {
  // A key renamed on one side only would otherwise sit there looking translated.
  const orphans = hu().filter((k) => !en().includes(k)).sort();
  assert.deepEqual(orphans, [], `Hungarian with no English: ${orphans.join(', ')}`);
});

test('placeholders match between the two languages', () => {
  const problems = [];
  for (const key of en()) {
    const a = placeholders(translate('en', key));
    const b = placeholders(translate('hu', key));
    if (a.size !== b.size || [...a].some((p) => !b.has(p))) problems.push(key);
  }
  // Hungarian word order moves {0} and {1} around freely — reordering is fine, losing one is a
  // sentence with a hole in it.
  assert.deepEqual(problems, [], `placeholder mismatch: ${problems.join(', ')}`);
});

test('a missing key is loud, not quietly English', () => {
  // The whole quality-control mechanism on this side: a visibly untranslated string gets reported,
  // one that silently reads correctly in English never does.
  assert.equal(translate('hu', 'no.such.key'), '[no.such.key]');
});

test('placeholders are filled, and an absent one is left alone rather than printing undefined', () => {
  assert.equal(translate('en', 'logs.back', ['Kid PC']), '← back to Kid PC');
  assert.equal(translate('en', 'logs.back', []), '← back to {0}');
});

test('the stored admin choice wins over the browser', () => {
  const req = { headers: { 'accept-language': 'hu-HU,hu;q=0.9' } };
  assert.equal(resolveLanguage(req, { lang: 'en' }), 'en');
});

test('with nothing stored, the browser decides — which is all the setup wizard has', () => {
  assert.equal(resolveLanguage({ headers: { 'accept-language': 'hu-HU,hu;q=0.9,en;q=0.5' } }, null), 'hu');
  assert.equal(resolveLanguage({ headers: { 'accept-language': 'de,fr;q=0.8' } }, null), 'en');
  assert.equal(resolveLanguage({ headers: {} }, null), 'en');
  assert.equal(resolveLanguage({ headers: { 'accept-language': 'en;q=0.2,hu;q=0.9' } }, null), 'hu');
});

test('an unsupported stored value falls back rather than rendering nothing', () => {
  assert.equal(resolveLanguage({ headers: {} }, { lang: 'kl' }), 'en');
});

test('the login page honours Accept-Language, since nobody has chosen yet', async (t) => {
  const { app } = startServer(t);

  const res = await app.inject({
    method: 'GET', url: '/login', headers: { 'accept-language': 'hu-HU,hu;q=0.9' },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes(translate('hu', 'login.lead')), 'expected the Hungarian lead');
  assert.ok(res.body.includes('lang="hu"'), 'the html element must declare the language it is in');
});

test('the stored language reaches every page, and no page has a hole in it', async (t) => {
  const { app, cookie } = startServer(t, 'hu');
  app.db.prepare(
    `INSERT INTO clients (id, name, token_hash, created_at, protocol, version, last_status)
     VALUES (1, 'Kid PC', 'h', '2026-08-01T10:00:00Z', 3, '0.2.3', 'active')`
  ).run();
  app.db.prepare(
    `INSERT INTO settings (client_id, downtime_start, downtime_end, weekday_minutes, weekend_minutes)
     VALUES (1, '21:00', '07:00', 120, 180)`
  ).run();

  for (const url of ['/clients', '/clients/1', '/clients/1/logs', '/requests', '/family-code', '/settings']) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie } });
    assert.equal(res.statusCode, 200, `${url} did not render`);
    // translate() renders an unknown key as [key]; finding one in the HTML means a template asked
    // for something no catalogue has.
    const holes = [...res.body.matchAll(/\[([a-z]+\.[A-Za-z.]+)\]/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(holes)], [], `${url} is missing: ${holes.join(', ')}`);
    assert.ok(res.body.includes('lang="hu"'), `${url} did not declare Hungarian`);
  }
});

test('choosing a language stores it and confirms in the new one', async (t) => {
  const { app, cookie } = startServer(t, 'en');

  const post = await app.inject({
    method: 'POST', url: '/settings/language', headers: { cookie }, payload: { lang: 'hu' },
  });
  assert.equal(post.statusCode, 302);
  assert.equal(app.db.prepare('SELECT lang FROM admin WHERE id = 1').get().lang, 'hu');

  // Redirected rather than rendered, precisely so the confirmation arrives in the language just
  // chosen instead of the one this request was resolved with.
  const page = await app.inject({ method: 'GET', url: post.headers.location, headers: { cookie } });
  assert.ok(page.body.includes(translate('hu', 'settings.languageSaved')));
});

test('an unknown language is refused rather than stored', async (t) => {
  const { app, cookie } = startServer(t, 'en');

  const res = await app.inject({
    method: 'POST', url: '/settings/language', headers: { cookie }, payload: { lang: 'kl' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(app.db.prepare('SELECT lang FROM admin WHERE id = 1').get().lang, 'en');
});

test('the language selector is not open to the internet', async (t) => {
  const { app } = startServer(t, 'en');

  const res = await app.inject({ method: 'POST', url: '/settings/language', payload: { lang: 'hu' } });

  assert.equal(res.statusCode, 302);
  assert.equal(app.db.prepare('SELECT lang FROM admin WHERE id = 1').get().lang, 'en');
});

test('both catalogues are non-empty and cover the same ground', () => {
  for (const lang of LANGUAGES) {
    assert.ok(keysOf(lang).length > 50, `${lang} looks empty`);
    const blank = keysOf(lang).filter((k) => !translate(lang, k).trim());
    assert.deepEqual(blank, [], `${lang} has empty values: ${blank.join(', ')}`);
  }
});
