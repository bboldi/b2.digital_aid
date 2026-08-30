#!/usr/bin/env node
// Folds one Client's history into another, then deletes the empty one.
//
// This exists for the duplicates created *before* pairing learned to recognise a machine
// (ADR-0008) — a PC that lost its state file, re-paired as a stranger, and left months of Pings and
// Events stranded on a row that will never report again. Adoption means no new ones appear, so this
// is a script rather than a feature: it is meant to be run once or twice and then forgotten.
//
//   node scripts/merge-clients.js --from 4 --into 7 [--commit]
//
// Without --commit it only reports what it would do. Nothing here is reversible once committed, so
// take a copy of the database file first.
//
// Direction matters: --into should be the Client the PC is actually paired to *now* (the one still
// pinging). Its name, settings and token are kept; --from contributes only its history and is then
// deleted.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const from = Number(arg('from'));
const into = Number(arg('into'));
const commit = process.argv.includes('--commit');

if (!Number.isInteger(from) || !Number.isInteger(into) || from === into) {
  console.error('usage: node scripts/merge-clients.js --from <id> --into <id> [--commit]');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(process.env.DB_FILE ?? path.join(here, '..', 'data', 'digital-aid.db'));

const clientOf = (id) => db.prepare('SELECT id, name, last_seen_at FROM clients WHERE id = ?').get(id);
const source = clientOf(from);
const target = clientOf(into);
if (!source) { console.error(`no client ${from}`); process.exit(1); }
if (!target) { console.error(`no client ${into}`); process.exit(1); }

const count = (table, id) =>
  db.prepare(`SELECT count(*) n FROM ${table} WHERE client_id = ?`).get(id).n;

console.log(`from: #${source.id} "${source.name}" (last seen ${source.last_seen_at ?? 'never'})`);
console.log(`into: #${target.id} "${target.name}" (last seen ${target.last_seen_at ?? 'never'})`);
for (const table of ['pings', 'events', 'daily_usage', 'requests']) {
  console.log(`  ${table}: ${count(table, from)} rows to move, ${count(table, into)} already there`);
}

const merge = db.transaction(() => {
  // Pings carry no per-Client uniqueness, so they move as they are.
  db.prepare('UPDATE pings SET client_id = ? WHERE client_id = ?').run(into, from);

  // Events do: (client_id, seq) is unique, and both Clients numbered their events from 1. The moved
  // ones are renumbered above everything the target already holds, which keeps them orderable
  // without pretending they interleave with the target's own sequence.
  const offset = db.prepare('SELECT coalesce(max(seq), 0) AS s FROM events WHERE client_id = ?')
    .get(into).s;
  db.prepare(
    `UPDATE events SET client_id = ?, seq = CASE WHEN seq IS NULL THEN NULL ELSE seq + ? END
      WHERE client_id = ?`
  ).run(into, offset, from);

  // daily_usage is one row per Client per date, so the changeover day exists on both. Minutes are
  // summed and the longest session is the longer of the two; the per-app breakdown is taken from
  // whichever row has one, since merging two JSON blobs by hand is not worth the risk here.
  db.prepare(
    `INSERT INTO daily_usage (client_id, date, used_minutes, blocked_minutes, longest_session_minutes, apps)
     SELECT ?, date, used_minutes, blocked_minutes, longest_session_minutes, apps
       FROM daily_usage WHERE client_id = ?
     ON CONFLICT(client_id, date) DO UPDATE SET
       used_minutes = used_minutes + excluded.used_minutes,
       blocked_minutes = blocked_minutes + excluded.blocked_minutes,
       longest_session_minutes = max(longest_session_minutes, excluded.longest_session_minutes),
       apps = coalesce(apps, excluded.apps)`
  ).run(into, from);
  db.prepare('DELETE FROM daily_usage WHERE client_id = ?').run(from);

  db.prepare('UPDATE requests SET client_id = ? WHERE client_id = ?').run(into, from);

  // Settings and the token belong to the target and are left alone; the source's cascade away.
  db.prepare('DELETE FROM clients WHERE id = ?').run(from);
});

if (!commit) {
  console.log('\nDry run — nothing changed. Re-run with --commit once the numbers above look right.');
  process.exit(0);
}

merge();
console.log(`\nMerged. #${from} is gone; #${into} now holds ${count('events', into)} events and ${count('pings', into)} pings.`);
