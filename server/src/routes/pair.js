import { newClientToken } from '../auth.js';
import { verifyCode } from '../totp.js';
import { PROTOCOL_VERSION } from '../protocol.js';

export default async function pairRoutes(app) {
  const { db } = app;

  // Pairing: Admin Code + PC name -> Client + permanent Client Token (PRD §5.3).
  //
  // Two-step when the machine is already known (ADR-0008). The first call answers with the Client we
  // think this is; the caller comes back with `adopt` once a person has said yes or no. The exchange
  // is stateless — the second call carries a code of its own — so nothing is remembered between them
  // and an abandoned prompt leaves no trace.
  app.post('/api/pair', async (req, reply) => {
    const admin = app.getAdmin();
    // No Admin Code in force means first-run setup was never finished (ADR-0010): the secret is
    // still provisional, so there is nothing to verify a pairing code against and nothing this PC
    // could usefully be attached to.
    if (!admin?.totp_secret) return reply.code(503).send({ error: 'server not set up' });

    const { code, name, protocol, machineId, adopt } = req.body ?? {};
    if (typeof code !== 'string' || !verifyCode(code, admin.totp_secret)) {
      return reply.code(401).send({ error: 'invalid code' });
    }

    const clientName = (typeof name === 'string' && name.trim()) || 'Unnamed PC';
    // Recorded, never enforced — a mismatch is badged in the UI, not rejected here.
    const clientProtocol = Number.isInteger(protocol) ? protocol : null;
    const machine = typeof machineId === 'string' && machineId.trim() ? machineId.trim() : null;

    // Revoked Clients are not offered: revoking is a deliberate "this machine is done with", and
    // handing it straight back would undo it. Newest first, since a repeated machine id means a
    // clone or a reimage and the recent one is the better guess.
    const existing = machine && adopt === undefined
      ? db.prepare(
          `SELECT id, name, datetime(last_seen_at, 'localtime') AS last_seen
             FROM clients WHERE machine_id = ? AND revoked_at IS NULL
            ORDER BY id DESC LIMIT 1`
        ).get(machine)
      : undefined;

    if (existing) {
      return { match: { clientId: existing.id, name: existing.name, lastSeen: existing.last_seen } };
    }

    const { token, hash } = newClientToken();

    if (Number.isInteger(adopt)) {
      // Re-checked rather than trusted: the id came back from a caller, and between the two calls
      // the Client could have been deleted or revoked. Matching on machine_id too means a caller
      // cannot name an arbitrary Client to take over — it can only claim the one it was offered.
      const target = db.prepare(
        'SELECT id FROM clients WHERE id = ? AND machine_id = ? AND revoked_at IS NULL'
      ).get(adopt, machine);
      if (!target) return reply.code(409).send({ error: 'no longer available' });

      // The new token replaces the old one, which invalidates it as a side effect. Name and settings
      // are left alone: they are what this whole exchange exists to preserve, and the admin's name
      // for the PC beats the one the machine reports.
      db.prepare('UPDATE clients SET token_hash = ?, protocol = ? WHERE id = ?')
        .run(hash, clientProtocol, target.id);
      app.log.info({ client: target.id }, 'client re-paired onto its existing record');
      return { clientId: target.id, token, protocol: PROTOCOL_VERSION, adopted: true };
    }

    const info = db.prepare(
      'INSERT INTO clients (name, token_hash, protocol, machine_id) VALUES (?, ?, ?, ?)'
    ).run(clientName, hash, clientProtocol, machine);
    db.prepare('INSERT INTO settings (client_id) VALUES (?)').run(info.lastInsertRowid);

    return { clientId: info.lastInsertRowid, token, protocol: PROTOCOL_VERSION };
  });
}
