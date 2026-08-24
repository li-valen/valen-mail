#!/usr/bin/env node
/**
 * Sends one tracked calibration email and inserts its token row directly
 * (there is no compose UI yet — that's Plan 4). Plain JavaScript: this
 * script cannot import src/token.ts, so it reproduces the token format
 * independently. That duplication is a deliberate, recorded decision (Task 7
 * Amendment 1) — do not add a build step or shared module to unify them.
 *
 * Usage: node --env-file=.env scripts/send-test.mjs <recipient> [label]
 */
import nodemailer from 'nodemailer';
import { neon } from '@neondatabase/serverless';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [recipient, label] = process.argv.slice(2);
if (!recipient) {
  console.error('usage: node scripts/send-test.mjs <recipient> [label]');
  process.exit(1);
}

const REQUIRED_ENV_VARS = ['DATABASE_URL', 'PIXEL_BASE', 'GMAIL_USER', 'GMAIL_APP_PASSWORD'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missingEnvVars.length > 0) {
  console.error(`missing required env var(s): ${missingEnvVars.join(', ')}`);
  console.error('run with: node --env-file=.env scripts/send-test.mjs <recipient> [label]');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

/**
 * The endpoint validates tokens with TOKEN_PATTERN from src/token.ts. This
 * script cannot import that TypeScript module, so it reads the pattern from
 * source instead of hardcoding a copy that could silently drift. If the two
 * ever diverged, the endpoint would reject every token, still serve a valid
 * 200 pixel, and record nothing — a silent zero. Failing closed here (throw
 * if extraction fails) matters as much as the check itself: a guard that
 * quietly stops guarding is worse than no guard.
 */
function tokenPatternFromSource() {
  const src = readFileSync(new URL('../src/token.ts', import.meta.url), 'utf8');
  const match = src.match(/TOKEN_PATTERN\s*=\s*\/(.+?)\/[gimsuy]*\s*;/);
  if (!match) {
    throw new Error('could not extract TOKEN_PATTERN from src/token.ts — guard cannot run');
  }
  return new RegExp(match[1]);
}

const token = randomBytes(16).toString('hex');
const tokenPattern = tokenPatternFromSource();
if (!tokenPattern.test(token)) {
  throw new Error(
    `generated token does not match TOKEN_PATTERN in src/token.ts (${tokenPattern}) — token format drift`,
  );
}

const messageId = `test-${Date.now()}@postbox.local`;
const subject = `Postbox tracking test — ${label ?? recipient}`;

/**
 * SENDER_IP must stay UNSET for calibration. tokens.sender_ip exists solely
 * to hold the account owner's OWN sending IP so classifyHit() can suppress
 * self-opens via a raw string comparison (see src/schema.sql, Task 7
 * Amendment 2 and Amendment 3). If it were populated here, every calibration
 * hit arriving from the sender's own network would classify as 'self' and be
 * dropped before it reached the report — the calibration would show zero
 * opens and look exactly as if tracking does not work, when in fact the
 * suppression logic worked perfectly. Do not add SENDER_IP to .env or
 * .env.example; process.env.SENDER_IP is expected to be undefined here.
 */
const senderIp = process.env.SENDER_IP ?? null;

// Constructed before the token insert so a synchronous throw here can't
// leave an orphan token row behind with no rollback (that orphan would
// later be misread by report.mjs as "sent but never opened").
const transport = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

try {
  await sql`
    insert into tokens (token, account_id, message_id, recipient_email, subject, sender_ip)
    values (${token}, ${process.env.GMAIL_USER}, ${messageId}, ${recipient},
            ${subject}, ${senderIp})
  `;
} catch (error) {
  console.error('failed to insert token row:', error);
  process.exit(1);
}

// Pixel markup is exactly per spec 5.1: no width, height, style, class, or
// descriptive alt, and no query-string parameters. Those attributes are what
// pixel blockers match on; invisibility comes from the PNG bytes
// (src/pixel.ts), not the markup.
const html = `<p>Tracking calibration test. Please open this once, normally, `
  + `then reply "done".</p><img alt="" src="${process.env.PIXEL_BASE}/o/${token}.png">`;

try {
  await transport.sendMail({
    from: process.env.GMAIL_USER,
    to: recipient,
    subject,
    html,
    messageId: `<${messageId}>`,
  });
} catch (sendError) {
  // A late send failure must not leave an orphan token row behind: a row
  // with zero hits is indistinguishable from "sent, delivered, but blocked
  // or never opened" once report.mjs runs 24h later. With only a handful of
  // calibration targets, one misread row is a real risk to the conclusion —
  // so roll the insert back before propagating the error.
  console.error('failed to send mail:', sendError);
  try {
    await sql`delete from tokens where token = ${token}`;
    console.error(`token row ${token} rolled back — no orphan row remains.`);
  } catch (rollbackError) {
    console.error('CRITICAL: failed to roll back token row after send failure.');
    console.error(`orphan token row remains and must be disregarded when reading the report: ${token}`);
    console.error('rollback error:', rollbackError);
  }
  process.exit(1);
}

console.log(`sent to ${recipient}\n  token ${token}\n  pixel ${process.env.PIXEL_BASE}/o/${token}.png`);
