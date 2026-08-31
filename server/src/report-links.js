import crypto from 'node:crypto';

export const REPORT_DAYS = new Set([7, 30, 90, 120]);
export const REPORT_LINK_TTL_MS = 30 * 60 * 1000;
const MAX_PER_CLIENT = 16;

const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Process-local, deliberately: restarting the single server invalidates every Report Link. */
export class ReportLinks {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
    this.links = new Map(); // token digest -> { clientId, days, clientTokenHash, issuedAt, expiresAt }
    this.findClient = db.prepare('SELECT token_hash, revoked_at FROM clients WHERE id = ?');
  }

  issue(clientId, days, expectedClientTokenHash = null) {
    if (!REPORT_DAYS.has(days)) return null;
    const client = this.findClient.get(clientId);
    if (!client || client.revoked_at !== null
        || (expectedClientTokenHash !== null && client.token_hash !== expectedClientTokenHash)) return null;

    const issuedAt = this.now();
    this.#purge(issuedAt);
    const existing = [...this.links.entries()]
      .filter(([, link]) => link.clientId === clientId)
      .sort((a, b) => a[1].issuedAt - b[1].issuedAt);
    if (existing.length >= MAX_PER_CLIENT) this.links.delete(existing[0][0]);

    const token = crypto.randomBytes(32).toString('hex');
    this.links.set(digest(token), {
      clientId, days, clientTokenHash: client.token_hash,
      issuedAt, expiresAt: issuedAt + REPORT_LINK_TTL_MS,
    });
    return {
      token,
      path: `/clients/${clientId}/report?days=${days}#token=${token}`,
      expiresAt: issuedAt + REPORT_LINK_TTL_MS,
    };
  }

  validate(token, clientId, days) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !REPORT_DAYS.has(days)) return null;
    const key = digest(token);
    const link = this.links.get(key);
    if (!link || link.clientId !== Number(clientId) || link.days !== days) return null;

    const now = this.now();
    if (link.expiresAt <= now) {
      this.links.delete(key);
      return null;
    }
    const client = this.findClient.get(clientId);
    if (!client || client.revoked_at !== null || client.token_hash !== link.clientTokenHash) {
      this.links.delete(key);
      return null;
    }
    return { ...link, remainingMs: link.expiresAt - now };
  }

  #purge(now) {
    for (const [key, link] of this.links) {
      if (link.expiresAt <= now) this.links.delete(key);
    }
  }
}

export const reportCookieName = (clientId, days) => `report_${clientId}_${days}`;
export const reportCookiePath = (clientId) => `/clients/${clientId}/report`;
