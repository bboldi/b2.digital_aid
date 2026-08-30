// Block Screen Backgrounds (CONTEXT.md) — storage, resolution, and what a Client is told about them.
//
// Pure of Fastify, like requests.js: this decides *which* picture applies and where its bytes live;
// the routes do the talking. The one rule worth stating out loud is that resolution happens per
// slot, independently — a Client can take the household's out-of-time picture and its own night-time
// one — because tying them together would mean setting one forces you to find a second.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** The household, as a client_id. Not a real Client, and never confusable with one: ids start at 1. */
export const GLOBAL = 0;

/** The two variants. Named for the enforcement reason, not for what the admin UI calls them. */
export const SLOTS = ['blocked', 'downtime'];

/**
 * Anything larger is a phone photo nobody looked at. There is no image library on this server, so
 * whatever is uploaded is exactly what every Client downloads and decodes — the cap is the only
 * thing standing between a 40-megapixel original and a kid's old PC.
 */
export const MAX_BYTES = 8 * 1024 * 1024;

export function backgroundsDir(db) {
  const dir = path.join(path.dirname(db.name), 'backgrounds');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const fileName = (clientId, slot, ext) => `${clientId}-${slot}.${ext}`;

/**
 * The format, decided by the file's first bytes rather than by its name. WPF — which is what draws
 * these — cannot decode WebP or HEIC at all, so a `.webp` from a browser or a `.heic` straight off an
 * iPhone would reach every Client and render as nothing, with no error anywhere to explain it. The
 * refusal has to happen here, at the one moment a person is present to read it.
 */
export function sniff(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length >= 8 && png.every((b, i) => buffer[i] === b)) return 'png';
  return null;
}

export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// --- Reads ---------------------------------------------------------------------------------------

const ONE = 'SELECT * FROM backgrounds WHERE client_id = ? AND slot = ?';

export const stored = (db, clientId, slot) => db.prepare(ONE).get(clientId, slot);

/**
 * What this Client will actually show for this slot: its own override, else the household's, else
 * nothing. `from` says which, because the Client Page has to be able to label it — an override and
 * an inherited picture look identical otherwise, and "which picture is on which machine" becomes
 * unanswerable.
 */
export function resolve(db, clientId, slot) {
  const own = stored(db, clientId, slot);
  if (own) return { ...own, from: 'client' };
  const global = stored(db, GLOBAL, slot);
  if (global) return { ...global, from: 'global' };
  return null;
}

/**
 * The `backgrounds` object a Client is sent, in `hello` and whenever one changes. Hashes and paths
 * only — the bytes come over HTTP, like an update does, because the Block Screen appears at exactly
 * the moments the server is unreachable and an image that arrives down the socket is an image the
 * cover cannot have when it needs one.
 */
export function forClient(db, clientId) {
  const out = {};
  for (const slot of SLOTS) {
    const hit = resolve(db, clientId, slot);
    out[slot] = hit ? { hash: hit.sha256, path: `/api/background/${slot}` } : null;
  }
  return out;
}

// --- Writes --------------------------------------------------------------------------------------

/** Replaces whatever was in this slot, removing the old file if its bytes are no longer referenced. */
export function save(db, clientId, slot, buffer, ext) {
  const dir = backgroundsDir(db);
  const previous = stored(db, clientId, slot);
  const hash = sha256(buffer);

  fs.writeFileSync(path.join(dir, fileName(clientId, slot, ext)), buffer);
  db.prepare(
    `INSERT INTO backgrounds (client_id, slot, sha256, ext, bytes, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(client_id, slot) DO UPDATE SET
       sha256 = excluded.sha256, ext = excluded.ext, bytes = excluded.bytes,
       updated_at = excluded.updated_at`
  ).run(clientId, slot, hash, ext, buffer.length);

  // A different extension means the old file is a different path, and nothing points at it now.
  if (previous && previous.ext !== ext) unlinkQuiet(path.join(dir, fileName(clientId, slot, previous.ext)));
  return hash;
}

export function remove(db, clientId, slot) {
  const row = stored(db, clientId, slot);
  if (!row) return false;
  unlinkQuiet(path.join(backgroundsDir(db), fileName(clientId, slot, row.ext)));
  db.prepare('DELETE FROM backgrounds WHERE client_id = ? AND slot = ?').run(clientId, slot);
  return true;
}

/**
 * Called when a Client is deleted. The database rows would cascade on their own; the files would
 * not, and orphans on disk accumulate forever with nothing left to name them.
 */
export function removeAllFor(db, clientId) {
  for (const slot of SLOTS) remove(db, clientId, slot);
}

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); } catch { /* already gone, which is the state we wanted */ }
}
