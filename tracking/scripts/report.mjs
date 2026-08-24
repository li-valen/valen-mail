#!/usr/bin/env node
/**
 * Reads every token/open pair back out of Postgres and renders a calibration
 * report. This intentionally does NOT collapse to a single headline number
 * (e.g. "open rate" or "false-positive share"): roughly half of real-world
 * opens cannot be confirmed one way or the other, so mpp / prefetch /
 * scanner are shown as distinct, named outcomes rather than folded into a
 * single "not an open" bucket, and a target with zero hits at all is shown
 * as its own honest state — it means the image was blocked or never
 * fetched, not that data is missing. See Task 7 Amendment 4.
 *
 * Usage: node --env-file=.env scripts/report.mjs
 */
import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  console.error('missing required env var: DATABASE_URL');
  console.error('run with: node --env-file=.env scripts/report.mjs');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

const CLASSIFICATIONS = ['open', 'mpp', 'prefetch', 'scanner', 'self'];

let rows;
try {
  rows = await sql`
    select t.token, t.recipient_email, t.subject, t.sent_at,
           o.occurred_at, o.classification, o.device_class, o.os, o.user_agent
    from tokens t left join opens o on o.token = t.token
    order by t.sent_at desc, o.occurred_at asc
  `;
} catch (error) {
  console.error('failed to query tokens/opens:', error);
  process.exit(1);
}

// Group hits by token. One token = one sent calibration message = one
// "target". A target may have zero, one, or many hits; each hit keeps its
// own classification so mpp/prefetch/scanner/self/open stay distinguishable
// per target instead of being averaged away.
const byToken = new Map();
for (const row of rows) {
  if (!byToken.has(row.token)) {
    byToken.set(row.token, {
      recipientEmail: row.recipient_email,
      subject: row.subject,
      sentAt: row.sent_at,
      hits: [],
    });
  }
  if (row.classification) {
    byToken.get(row.token).hits.push({
      occurredAt: row.occurred_at,
      classification: row.classification,
      deviceClass: row.device_class,
      os: row.os,
    });
  }
}

if (byToken.size === 0) {
  console.log('\nNo token rows found. Nothing has been sent yet, or DATABASE_URL points');
  console.log('at the wrong database.\n');
  process.exit(0);
}

console.log('\n=== Per-target results ===');
console.log('A target with zero hits means no hit arrived at all — the image was');
console.log('likely blocked or never fetched. That is a meaningful result, not an');
console.log('absence of data.\n');

const targetRows = [...byToken.entries()].map(([token, target]) => {
  const classCounts = CLASSIFICATIONS
    .map((c) => `${c}:${target.hits.filter((h) => h.classification === c).length}`)
    .filter((entry) => !entry.endsWith(':0'))
    .join(' ');
  const devices = [...new Set(target.hits.map((h) => h.deviceClass).filter(Boolean))];
  const oses = [...new Set(target.hits.map((h) => h.os).filter(Boolean))];
  return {
    to: target.recipientEmail,
    subject: target.subject,
    sent: target.sentAt,
    'any hit?': target.hits.length > 0 ? 'yes' : 'NO HITS',
    'hit count': target.hits.length,
    classifications: classCounts || '—',
    device: devices.join(', ') || '—',
    os: oses.join(', ') || '—',
    token: `${token.slice(0, 8)}…`,
  };
});
console.table(targetRows);

console.log('\n=== Classification breakdown (all hits, all targets) ===');
console.log('Every category below is shown even at zero, so a class that never');
console.log('fired is visibly absent rather than silently omitted.\n');
const byClass = {};
for (const classification of CLASSIFICATIONS) byClass[classification] = 0;
for (const row of rows) {
  if (row.classification) byClass[row.classification] += 1;
}
console.table(byClass);

const targetsWithZeroHits = targetRows.filter((row) => row['hit count'] === 0).length;
console.log(`\n${byToken.size} target(s) total, ${targetsWithZeroHits} with zero hits.`);

console.log('\n=== Raw hits (for classifier tuning) ===');
console.log('Full user-agent per hit — needed to check whether a known-human open was');
console.log('misclassified as mpp/prefetch/scanner (see src/classify.ts constants).\n');
const rawHitRows = rows
  .filter((row) => row.classification)
  .map((row) => ({
    to: row.recipient_email,
    occurred: row.occurred_at,
    class: row.classification,
    device: row.device_class ?? '—',
    os: row.os ?? '—',
    userAgent: row.user_agent ?? '—',
  }));
if (rawHitRows.length > 0) {
  console.table(rawHitRows);
} else {
  console.log('(no hits recorded yet)\n');
}

console.log('Record findings in tracking/docs/measurement-results.md.\n');
