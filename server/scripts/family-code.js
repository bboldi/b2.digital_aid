#!/usr/bin/env node
// Prints the current Admin Code from the server's own database.
//
// The admin UI shows the secret exactly once (PRD §5.1), so this is the escape hatch when it was not
// captured into an authenticator app — during development, or on a machine without a phone to hand.
// It requires filesystem access to the server, which only the parent has; it is not a bypass.
//
//   node scripts/family-code.js [--watch]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticator } from 'otplib';
import { openDb } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbFile = process.env.DB_FILE ?? path.join(root, 'data', 'digital-aid.db');

const db = openDb(dbFile);
const admin = db.prepare('SELECT totp_secret FROM admin WHERE id = 1').get();
if (!admin) {
  console.error(`No admin in ${dbFile} yet — open the server in a browser and complete setup first.`);
  process.exit(1);
}

const show = () => {
  const code = authenticator.generate(admin.totp_secret);
  const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
  console.log(`${code}   (valid ~${secondsLeft}s)   grant example: ${code}30`);
};

show();
if (process.argv.includes('--watch')) setInterval(show, 5000);
else db.close();
