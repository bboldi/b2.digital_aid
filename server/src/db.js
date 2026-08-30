import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  server_key TEXT NOT NULL,
  totp_secret TEXT NOT NULL,
  grant_seed TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  version TEXT,
  protocol INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  downtime_start TEXT NOT NULL DEFAULT '21:00',
  downtime_end TEXT NOT NULL DEFAULT '07:00',
  weekday_minutes INTEGER NOT NULL DEFAULT 120,
  weekend_minutes INTEGER NOT NULL DEFAULT 180
);

CREATE TABLE IF NOT EXISTS pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL,
  remaining_minutes INTEGER,
  foreground_app TEXT
);
CREATE INDEX IF NOT EXISTS idx_pings_client_ts ON pings(client_id, ts);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  seq INTEGER,
  client_ts TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_client_ts ON events(client_id, client_ts);

-- What survives a day once its Pings pass the 30-day horizon (ADR-0003). One row per Client per
-- local date, kept forever. Minute-level detail has a shelf life; this does not.
CREATE TABLE IF NOT EXISTS daily_usage (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  used_minutes INTEGER NOT NULL DEFAULT 0,
  blocked_minutes INTEGER NOT NULL DEFAULT 0,
  longest_session_minutes INTEGER NOT NULL DEFAULT 0,
  apps TEXT,
  rolled_up_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, date)
);

-- The kid→parent channel (CONTEXT.md: Request). Deliberately a table rather than a live-only
-- message like the admin actions: a Request outlives the socket that carried it, because the whole
-- point is that a parent who was not holding their phone at 20:47 can still answer at 20:52.
--
-- Rows are kept after they are answered — a declined Request is the evidence behind the 15-minute
-- cooldown, and the history is how a parent notices "she asks every night at nine".
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  asked_minutes INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',       -- open | approved | declined | lapsed | withdrawn
  granted_minutes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- When this Request stops mattering. While open: 60 min or local midnight. Once answered: the
  -- window the verdict has left to reach the PC. Always UTC, like every other stamp here.
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_client_state ON requests(client_id, state);

CREATE TABLE IF NOT EXISTS updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so columns added
// after a DB was first created need an explicit ALTER. Additive only.
function addColumn(db, table, column, decl) {
  const exists = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

// For undoing an addColumn that turned out to be a mistake. Only reaches a DB that actually got the
// column, so a fresh install is unaffected.
function dropColumn(db, table, column) {
  const exists = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column);
  if (exists) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  addColumn(db, 'clients', 'protocol', 'INTEGER');
  // The Grant Seed (ADR-0006). Nullable and backfilled below rather than declared NOT NULL: an
  // existing install has an admin row already, and the value has to be generated, not defaulted.
  addColumn(db, 'admin', 'grant_seed', 'TEXT');
  db.prepare("UPDATE admin SET grant_seed = ? WHERE id = 1 AND (grant_seed IS NULL OR grant_seed = '')")
    .run(crypto.randomBytes(32).toString('hex'));
  addColumn(db, 'events', 'seq', 'INTEGER');
  // The admin UI's language. Nullable on purpose: null means "nobody has chosen", which is what
  // lets the setup wizard fall back to the browser's Accept-Language for its one and only render.
  // This is not a Client's language — that one is chosen on the PC and never travels (ADR-0012).
  addColumn(db, 'admin', 'lang', 'TEXT');

  // Denormalised latest-ping fields, so the Clients list and Client Page can show current status and
  // Time Left without a correlated subquery on every render. Updated on each ping.
  addColumn(db, 'clients', 'last_status', 'TEXT');
  addColumn(db, 'clients', 'last_remaining', 'INTEGER');
  addColumn(db, 'clients', 'last_reason', 'TEXT');
  addColumn(db, 'clients', 'last_app', 'TEXT');
  addColumn(db, 'admin', 'message_templates', 'TEXT');
  addColumn(db, 'updates', 'size', 'INTEGER NOT NULL DEFAULT 0');
  // "Latest" is the most recently *announced* build, not the most recently inserted one. Uploading
  // an older exe again is how a rollback is performed, and that inserts no row — it re-announces an
  // existing one, which has to be enough to make it latest again.
  addColumn(db, 'updates', 'announced_at', 'TEXT');
  db.exec("UPDATE updates SET announced_at = uploaded_at WHERE announced_at IS NULL");
  // Admin "disabled" (paused) flag — the server is the source of truth; clients reconcile via hello.
  addColumn(db, 'clients', 'disabled', 'INTEGER NOT NULL DEFAULT 0');

  // A stable per-machine id (Windows MachineGuid), so a PC that lost its state file can be offered
  // its own Client back instead of pairing as a stranger and stranding its history (ADR-0008). Not
  // a credential: it proposes which Client an Admin Code applies to, and proves nothing on its own.
  // Not unique — a reimaged or cloned PC can repeat one, and the pairing prompt is what stops that
  // from silently fusing two machines into one Allowance.
  addColumn(db, 'clients', 'machine_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_clients_machine ON clients(machine_id)');

  // Block Screen Backgrounds (CONTEXT.md). One row per picture actually stored; what a Client ends
  // up showing is *resolved* per slot — its own override, else the household one, else nothing.
  //
  // client_id 0 is the household. A nullable column would read better, but SQLite lets NULLs repeat
  // inside a UNIQUE index, so "one global picture per slot" would not actually be enforced.
  // A new Admin Code secret is *provisional* until the Admin proves they can produce a code from it
  // (ADR-0010). It waits here; totp_secret keeps whatever is actually in force, so backing out of a
  // regeneration costs nothing and an abandoned first-run leaves a server that is loudly unusable
  // rather than one holding a secret nobody has.
  addColumn(db, 'admin', 'pending_totp_secret', 'TEXT');
  addColumn(db, 'admin', 'pending_grant_seed', 'TEXT');
  // Whether anyone ever proved the *live* secret is in an authenticator app. Skipping is allowed and
  // leaves this 0, which is what keeps the standing warning on the Codes page honest.
  addColumn(db, 'admin', 'admin_code_confirmed', 'INTEGER NOT NULL DEFAULT 0');

  db.exec(`
    CREATE TABLE IF NOT EXISTS backgrounds (
      client_id INTEGER NOT NULL,
      slot TEXT NOT NULL,            -- blocked | downtime
      sha256 TEXT NOT NULL,
      ext TEXT NOT NULL,             -- jpg | png, decided by the file's own magic bytes
      bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (client_id, slot)
    )`);

  // Briefly held a denormalised "used today" counter here. It was wrong by construction: a Client
  // that had been pinging before the column existed read 0 on its card while the Client Page read
  // the truth from the Pings, and nothing backfilled it. Today's usage is now derived from the Pings
  // by a range scan (see USED_TODAY_MINUTES in daily.js), so there is one source of truth again.
  dropColumn(db, 'clients', 'used_today_date');
  dropColumn(db, 'clients', 'used_today_minutes');
  dropColumn(db, 'clients', 'used_today_last_minute');

  // --- Alerts (CONTEXT.md: Alert, Alert Device; ADR-0013) -------------------------------------

  // VAPID is how this server authenticates itself directly to the push services — no Firebase
  // project, no third-party account. Generated once and kept beside the Server Key, because they
  // are the same kind of thing: a secret this server owns and nobody else needs to see.
  //
  // Regenerating them silently makes every existing subscription inert. Nothing errors and nobody
  // is told; each Alert Device simply goes quiet until someone opens the app again. That is the
  // same failure shape as regenerating the household secrets making Trusted Device copies inert,
  // so it is a hazard this system already has rather than a new one — but it is the reason these
  // are generated once here and never rotated on a whim.
  addColumn(db, 'admin', 'vapid_public', 'TEXT');
  addColumn(db, 'admin', 'vapid_private', 'TEXT');

  // Which of the four Alerts are sent. One setting for the household, not per Client and not per
  // device: every Alert Device gets everything that is enabled. Requests default on because that
  // is the one a kid is actively waiting on an answer to; the three ambient ones default off, so
  // installing the app cannot start buzzing a phone nobody asked to be buzzed.
  addColumn(db, 'admin', 'alert_request', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'admin', 'alert_started', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'admin', 'alert_exhausted', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'admin', 'alert_locked', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'admin', 'alert_coupon', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'admin', 'alert_grant', 'INTEGER NOT NULL DEFAULT 1');

  db.exec(`
    -- One row per Alert Device: a browser holding a push subscription. Keyed on the endpoint the
    -- push service issued, which is the only stable identity a subscription has — the same browser
    -- resubscribing gets a new endpoint and is legitimately a new row, and two browsers on one
    -- phone are two rows because they genuinely are two.
    --
    -- Not tied to a person. There is exactly one Admin, so every row here is that Admin on some
    -- device, and everything enabled goes to all of them.
    CREATE TABLE IF NOT EXISTS alert_devices (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_ok_at TEXT,
      -- Consecutive send failures that were not outright rejections. A 404 or 410 deletes the row
      -- immediately; anything else is allowed to be transient, because a phone that is merely off
      -- is not a phone that has unsubscribed.
      failures INTEGER NOT NULL DEFAULT 0
    )`);

  db.exec(`
    -- What each Client's status was the last time the Alert watcher looked, so a *transition* can be
    -- spotted. Deliberately its own table rather than more columns on clients: this is the watcher's
    -- private bookkeeping, it means nothing to any other reader, and a stale row here must never be
    -- mistaken for the Client's actual state, which lives on clients.last_status.
    CREATE TABLE IF NOT EXISTS alert_watch (
      client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
      status TEXT,
      reason TEXT,
      -- When the current status was first seen. "Stepped away" is only an Alert once it has held
      -- for a while, and this is what makes that measurable without keeping a timer per Client.
      since TEXT,
      -- Whether the Alert for the current status has already been sent, so a status that holds for
      -- an hour produces one Alert rather than sixty.
      alerted INTEGER NOT NULL DEFAULT 0,
      last_ping_at TEXT
    )`);

  db.exec(`
    -- Time Coupons (CONTEXT.md; ADR-0017): pre-minted codes the server checks at redemption.
    -- This table is inventory, not audit — revoke is hard DELETE, and a redemption outlives any
    -- deletion as a coupon-redeemed Event on the Client's timeline.
    --
    -- client_id NULL means Global: good on any Client, spent by whichever redeems it first.
    -- ON DELETE CASCADE on client_id: a coupon for a machine that no longer exists is nothing.
    -- used_by is SET NULL instead, so deleting one Client cannot erase the fact that a Global
    -- coupon was spent.
    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,          -- canonical: 6 alphabet letters + 3-digit minutes
      minutes INTEGER NOT NULL,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      expires_on TEXT,                    -- 'YYYY-MM-DD' server-local, inclusive; NULL = never
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      used_at TEXT,
      used_by INTEGER REFERENCES clients(id) ON DELETE SET NULL
    )`);

  // After the migrations, never inside SCHEMA: on an older DB the column does not
  // exist yet when SCHEMA runs, and indexing a missing column throws.
  // Makes re-delivery free (ADR-0001) — a re-sent Event collides here and is ignored.
  // NULLs are distinct in SQLite unique indexes, so pre-seq rows never collide.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_client_seq ON events(client_id, seq)');

  return db;
}
