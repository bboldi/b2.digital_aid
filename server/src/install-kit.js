import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './zip.js';

// The Install Kit (CONTEXT.md): the zip a parent downloads to put the client app on a new PC.
//
// It exists because there was no supported way to get the app onto a machine that had never been
// paired: /api/update/latest authenticates with the Client Token issued at Pairing, so only machines
// already on the fleet could fetch a build. ADR-0015 has the reasoning, including why the page in
// front of this is not behind a login.

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where uploaded builds live: beside the database, so a backup that takes the DB directory takes
 *  the builds with it. */
export function updatesDir(dbFile) {
  const dir = path.join(path.dirname(dbFile), 'updates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The scripts are read off the deployed checkout, not from a copy under server/ (ADR-0015): they are
// server-repo artifacts updated by the same `git pull` as the server, and a second copy would drift.
const SCRIPTS_DIR = path.join(here, '..', '..', 'client', 'install');

export const SCRIPT_NAMES = [
  'Install-DigitalAid.bat',
  'Install-DigitalAid.ps1',
  'Uninstall-DigitalAid.bat',
  'Uninstall-DigitalAid.ps1',
];

/** The four install scripts as zip entries, or null if the checkout is not there — which is what a
 *  server deployed as `server/` alone looks like. Better to say so than to ship a kit whose whole
 *  point, the one-double-click installer, is silently missing from it. */
export function scriptEntries(dir = SCRIPTS_DIR) {
  const entries = [];
  for (const name of SCRIPT_NAMES) {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    entries.push({ name, data: fs.readFileSync(file), mtime: stat.mtime });
  }
  return entries;
}

/**
 * What the download page and the zip route both need to know.
 *
 * Returns `{ ok: false, reason }` rather than throwing, because every failure here is a page state a
 * parent has to be able to read: 'no-build' on a fresh server, 'build-missing' when the row outlived
 * its file (a database restored without the updates directory beside it), 'no-scripts' when the
 * checkout is partial.
 */
export function latestKit(db, dbFile, scriptsDir = SCRIPTS_DIR) {
  const update = db.prepare('SELECT * FROM updates ORDER BY announced_at DESC, id DESC LIMIT 1').get();
  if (!update) return { ok: false, reason: 'no-build' };

  const exe = path.join(updatesDir(dbFile), update.filename);
  if (!fs.existsSync(exe)) return { ok: false, reason: 'build-missing', version: update.version };

  const scripts = scriptEntries(scriptsDir);
  if (!scripts) return { ok: false, reason: 'no-scripts', version: update.version };

  return { ok: true, version: update.version, exe, scripts };
}

/**
 * Build the zip: the exe and the four scripts, flat, at the archive root.
 *
 * Flat because the scripts find the exe beside themselves, so a parent's whole job is unzip and
 * double-click the .bat. Built per request rather than stored: the scripts change with every
 * `git pull` while the exe changes only on upload, and a prebuilt archive would freeze the pair.
 */
export function buildKit(kit) {
  const stat = fs.statSync(kit.exe);
  return zip([
    { name: 'DigitalAid.exe', data: fs.readFileSync(kit.exe), mtime: stat.mtime },
    ...kit.scripts,
  ]);
}

/** `DigitalAid-0.2.0.zip` — the version is in the filename because a parent may well download it
 *  twice, months apart, and end up with both in one Downloads folder. */
export const kitFilename = (version) => `DigitalAid-${version}.zip`;
