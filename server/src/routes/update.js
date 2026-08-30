import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { hashClientToken } from '../auth.js';
import { readProductVersion, isDevBuild } from '../pe-version.js';
// Shared with the Install Kit: both need to know where builds live, and one definition is what keeps
// an upload and a download pointing at the same directory.
import { updatesDir } from '../install-kit.js';


export default async function updateRoutes(app) {
  const { db } = app;

  const findClient = db.prepare('SELECT id FROM clients WHERE token_hash = ? AND revoked_at IS NULL');
  const latestUpdate = db.prepare('SELECT * FROM updates ORDER BY announced_at DESC, id DESC LIMIT 1');

  const findBySha = db.prepare('SELECT * FROM updates WHERE sha256 = ?');
  const findByVersion = db.prepare('SELECT * FROM updates WHERE version = ?');

  // --- Admin: upload a new build ------------------------------------------------
  //
  // The version is read out of the exe itself, never typed. A label the parent types is a label that
  // can be wrong, and the Client Page's version column is how they check what is actually running on
  // their kid's PC — so it has to come from the artifact. `client/VERSION` -> InformationalVersion ->
  // the PE's ProductVersion -> here, one number the whole way.
  app.post('/update', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');

    const dir = updatesDir(app.db.name);
    let tmp = null;
    let saved = null;

    for await (const part of req.parts()) {
      if (part.type !== 'file' || part.fieldname !== 'exe') continue;
      // Hash while streaming to a temp file; rename to the content hash once known.
      // The temp name is fully generated — part.filename is attacker-controlled and must never
      // reach a filesystem path (it could contain "../"). The final name is the content hash.
      const hash = crypto.createHash('sha256');
      tmp = path.join(dir, `upload-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
      let size = 0;
      part.file.on('data', (chunk) => { hash.update(chunk); size += chunk.length; });
      await pipeline(part.file, fs.createWriteStream(tmp));
      saved = { sha256: hash.digest('hex'), size };
    }

    const fail = (message) => {
      if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
      return reply.redirect(`/settings?error=${encodeURIComponent(message)}`);
    };

    if (!saved) return fail('No exe uploaded.');

    const version = readProductVersion(fs.readFileSync(tmp));
    if (!version) {
      return fail('That file declares no version — it does not look like a DigitalAid.exe built by publish.sh.');
    }
    if (isDevBuild(version)) {
      return fail(`${version} is a development build. Cut a release with publish.sh — a "+dev" build is not reproducible from any tag.`);
    }

    // Re-uploading the exact same bytes: nothing to record, but re-announcing is harmless and is
    // the obvious way to nudge a client that missed the first push.
    const existingBuild = findBySha.get(saved.sha256);

    // Same version, different bytes. This is the case the whole check exists for: two exes both
    // claiming 0.2.0 would both install (clients update on hash), and the version column would
    // then be lying about what is running.
    const clash = findByVersion.get(version);
    if (clash && clash.sha256 !== saved.sha256) {
      return fail(`Version ${version} was already uploaded from different bytes. Bump the version with publish.sh rather than replacing a released build.`);
    }

    let announced = version;
    if (existingBuild) {
      if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
      announced = existingBuild.version;
      // Re-announcing is what makes this build latest again, so a rollback is "upload the old exe".
      db.prepare("UPDATE updates SET announced_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?").run(existingBuild.id);
    } else {
      fs.renameSync(tmp, path.join(dir, `${saved.sha256}.exe`));
      db.prepare(
        `INSERT INTO updates (version, filename, sha256, size, announced_at)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))`
      ).run(version, `${saved.sha256}.exe`, saved.sha256, saved.size);
    }

    // Push to everyone online now; offline clients pick it up from hello on reconnect (PRD §6.7).
    // Deliberately no downgrade check: a Client updates on hash mismatch, not on version order, so
    // announcing an older build is a working rollback and refusing one would remove the only way out
    // of a bad release.
    let pushed = 0;
    for (const clientId of app.hub.sockets.keys()) {
      if (app.hub.send(clientId, { type: 'update', version: announced, sha256: saved.sha256, path: '/api/update/latest' })) pushed++;
    }

    const note = existingBuild
      ? `${announced} was already uploaded — re-announced to ${pushed} online client(s).`
      : `${announced} uploaded and announced to ${pushed} online client(s).`;
    return reply.redirect(`/settings?ok=${encodeURIComponent(note)}`);
  });

  // --- Client: download the latest build (same header auth as the socket) --------
  app.get('/api/update/latest', async (req, reply) => {
    const token = req.headers['x-client-token'];
    const client = typeof token === 'string' && token ? findClient.get(hashClientToken(token)) : undefined;
    if (!client) return reply.code(401).send({ error: 'unauthorized' });

    const update = latestUpdate.get();
    if (!update) return reply.code(404).send({ error: 'no update' });

    const file = path.join(updatesDir(app.db.name), update.filename);
    if (!fs.existsSync(file)) return reply.code(410).send({ error: 'build file missing' });

    return reply
      .header('content-type', 'application/octet-stream')
      .header('x-update-sha256', update.sha256)
      .send(fs.createReadStream(file));
  });
}
