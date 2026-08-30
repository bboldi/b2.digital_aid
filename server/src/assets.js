import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Cache busting for everything under /public/.
//
// The service worker caches /public/ first and refreshes in the background, which is the right shape
// for an app whose one offline-critical screen is /family-code — but with a bare URL it means every
// stylesheet change renders stale exactly once on every device, and the only thing standing between
// "once" and "forever" was remembering to bump a constant in sw.js by hand. A version in the URL
// removes the human step: changed bytes are a different URL, so cache-first *is* fresh-first.
//
// Hashes are content-derived, not a release number: the server has no build step and is often running
// a working tree, so a version that only moved on release would go stale in exactly the situation
// (editing CSS) this exists for. They are memoised on mtime, so `npm run dev` picks up an edit that
// node --watch never sees, at the cost of one stat per asset per render.

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const PREFIX = '/public/';

const cache = new Map(); // pathname -> { mtimeMs, size, hash }

function fingerprint(pathname) {
  if (!pathname.startsWith(PREFIX)) return null;
  // The pathname comes from our own templates, never from a request, but resolving and re-checking
  // costs nothing and means a future caller cannot walk out of public/ with a '..'.
  const file = path.join(PUBLIC_DIR, pathname.slice(PREFIX.length));
  if (path.relative(PUBLIC_DIR, file).startsWith('..')) return null;

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const hit = cache.get(pathname);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.hash;

  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
  cache.set(pathname, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
  return hash;
}

/**
 * `/public/style.css` -> `/public/style.css?v=<hash>`.
 *
 * An asset that is not on disk comes back unversioned rather than throwing: a missing stylesheet
 * should render a plain page, not a 500 on every route at once.
 */
export function assetUrl(pathname) {
  const hash = fingerprint(pathname);
  return hash ? `${pathname}?v=${hash}` : pathname;
}

/** The files the service worker precaches. Kept here, not in sw.js, because the server is what
 *  knows their hashes — sw.js receives this list already versioned. */
export const SHELL = [
  '/public/vendor/beer.min.css',
  '/public/style.css',
  '/public/family-code.js',
  '/public/live.js',
  '/public/quick-actions.js',
  // Named for the domain term (Alert Device), and deliberately NOT "alerts.js": filenames like
  // that match common adblock-list rules, and a blocked script here means push alerts silently
  // never get set up on that browser.
  '/public/alert-device.js',
  '/public/theme.js',
  '/public/offline.html',
  '/public/icons/icon-192.png',
  '/public/icons/icon-512.png',
];

/**
 * What gets substituted into sw.js. The cache name is derived from the shell's own hashes, so a
 * changed asset renames the cache, which is what makes `activate` sweep the old one — the bump that
 * used to be a hand-edited `-v6` and was therefore one distracted afternoon from being forgotten.
 */
export function swAssets() {
  const shell = SHELL.map(assetUrl);
  const version = crypto.createHash('sha256').update(shell.join('\n')).digest('hex').slice(0, 10);
  return { version, shell, offline: assetUrl('/public/offline.html') };
}
