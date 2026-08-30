import fs from 'node:fs';
import path from 'node:path';
import { hashClientToken } from '../auth.js';
import {
  GLOBAL, SLOTS, MAX_BYTES, backgroundsDir, fileName, sniff, stored, resolve, forClient, save, remove,
} from '../backgrounds.js';

// Uploading, removing and serving Block Screen Backgrounds. Three audiences: the admin setting them,
// the admin *previewing* them, and the Clients that draw them.

export default async function backgroundRoutes(app) {
  const { db } = app;

  const findClient = db.prepare('SELECT id FROM clients WHERE token_hash = ? AND revoked_at IS NULL');
  const clientExists = db.prepare('SELECT id FROM clients WHERE id = ?');

  /** 'global' or a Client id, as it appears in the URL. Anything else is not a scope. */
  function scopeOf(raw) {
    if (raw === 'global') return GLOBAL;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 && clientExists.get(id) ? id : null;
  }

  const back = (scope, message, ok = true) => {
    const target = scope === GLOBAL ? '/settings' : `/clients/${scope}`;
    return `${target}?${ok ? 'ok' : 'error'}=${encodeURIComponent(message)}`;
  };

  /** Tell the Clients a change affects. A global change reaches everyone it is not overridden for. */
  function announce(scope) {
    const ids = scope === GLOBAL
      ? db.prepare('SELECT id FROM clients WHERE revoked_at IS NULL').all().map((r) => r.id)
      : [scope];
    for (const id of ids) {
      app.hub.send(id, { type: 'background', backgrounds: forClient(db, id) });
    }
  }

  // --- Admin: upload ------------------------------------------------------------
  app.post('/background/:scope/:slot', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');

    const scope = scopeOf(req.params.scope);
    const slot = SLOTS.includes(req.params.slot) ? req.params.slot : null;
    if (scope === null || !slot) return reply.code(404).send('No such background');

    // Read into memory rather than streaming to disk: the cap is 8 MB and the format has to be known
    // from the first bytes before anything is kept, so there is nothing to stream to yet.
    //
    // Both calls are guarded. Over-size trips inside toBuffer(), not file(), and left unguarded it
    // escapes as a bare 413 — an error page in place of the Settings page, which is a poor way to
    // tell someone their holiday photo is too big.
    let buffer;
    try {
      const file = await req.file({ limits: { fileSize: MAX_BYTES } });
      if (!file) return reply.redirect(back(scope, 'No image was chosen.', false));
      buffer = await file.toBuffer();
      if (file.file.truncated) throw Object.assign(new Error('too large'), { code: 'FST_REQ_FILE_TOO_LARGE' });
    } catch (err) {
      return reply.redirect(err?.code === 'FST_REQ_FILE_TOO_LARGE'
        ? back(scope, 'That image is over 8 MB. Pick a smaller one.', false)
        : back(scope, 'That upload did not arrive as a file.', false));
    }

    if (buffer.length === 0) return reply.redirect(back(scope, 'No image was chosen.', false));

    const ext = sniff(buffer);
    if (!ext) {
      return reply.redirect(back(scope,
        'Only JPEG and PNG work. A WebP or an iPhone HEIC will not show up on the PCs.', false));
    }

    save(db, scope, slot, buffer, ext);
    announce(scope);
    return reply.redirect(back(scope, 'Background updated.'));
  });

  // --- Admin: remove ------------------------------------------------------------
  app.post('/background/:scope/:slot/remove', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');

    const scope = scopeOf(req.params.scope);
    const slot = SLOTS.includes(req.params.slot) ? req.params.slot : null;
    if (scope === null || !slot) return reply.code(404).send('No such background');

    remove(db, scope, slot);
    announce(scope);
    // Removing a Client's override is not the same act as removing the household's picture, and the
    // difference is what the PC does next: go back to inheriting, or go plain.
    return reply.redirect(back(scope,
      scope === GLOBAL ? 'Background removed.' : 'Override removed — this PC uses the household image again.'));
  });

  // --- Admin: preview -----------------------------------------------------------
  //
  // `?resolved=1` asks for what the PC will actually show rather than what is set here, which is
  // what the Client Page needs: an empty box next to a kid staring at a photograph is how an
  // inherited picture becomes untraceable.
  app.get('/background/:scope/:slot/image', async (req, reply) => {
    if (!app.isLoggedIn(req)) return reply.redirect('/login');

    const scope = scopeOf(req.params.scope);
    const slot = SLOTS.includes(req.params.slot) ? req.params.slot : null;
    if (scope === null || !slot) return reply.code(404).send('No such background');

    const row = req.query.resolved ? resolve(db, scope, slot) : stored(db, scope, slot);
    return sendImage(reply, row);
  });

  // --- Client: download (same header auth as the socket and the update route) ----
  app.get('/api/background/:slot', async (req, reply) => {
    const token = req.headers['x-client-token'];
    const client = typeof token === 'string' && token ? findClient.get(hashClientToken(token)) : undefined;
    if (!client) return reply.code(401).send({ error: 'unauthorized' });

    const slot = SLOTS.includes(req.params.slot) ? req.params.slot : null;
    if (!slot) return reply.code(404).send({ error: 'no such slot' });

    return sendImage(reply, resolve(db, client.id, slot));
  });

  function sendImage(reply, row) {
    if (!row) return reply.code(404).send({ error: 'no background' });
    const file = path.join(backgroundsDir(db), fileName(row.client_id, row.slot, row.ext));
    if (!fs.existsSync(file)) return reply.code(410).send({ error: 'image file missing' });
    return reply
      .header('content-type', row.ext === 'png' ? 'image/png' : 'image/jpeg')
      .header('x-background-sha256', row.sha256)
      // Keyed by content hash on the caller's side, so a long cache is safe and a change is a
      // different hash rather than a stale hit.
      .header('cache-control', 'private, max-age=60')
      .send(fs.createReadStream(file));
  }
}
