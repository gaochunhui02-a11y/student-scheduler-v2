// V5-D/E: analytics consent and allow-lists, feedback page names, landing
// and legal pages, plans/pricing copy honesty.
// Run: node tests/v5-growth.test.js

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EVENT_NAMES, sanitizeProps, canRecord, shouldAskConsent, onceKey } from '../src/analytics/productEventsModel.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

console.log('\n=== analytics: consent and data minimisation ===');
check('event names in the app match the database allow-list exactly', () => {
  const sql = readFileSync(join(root, 'supabase/migrations/0027_product_events.sql'), 'utf8');
  const block = sql.slice(sql.indexOf('product_events_name_allowed'), sql.indexOf('product_events_props_object'));
  const inDb = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(inDb, EVENT_NAMES.slice().sort());
});
check('props: only allowed keys with safe values survive — no free text, no names', () => {
  assert.deepEqual(sanitizeProps({ tasks: 3, source: 'paste', title: 'My essay', email: 'a@b.c', mode: 'Catch Up!', count: -1, days: 2.5, extra: { a: 1 } }), { tasks: 3, source: 'paste' });
  assert.deepEqual(sanitizeProps(null), {});
  const many = Object.fromEntries(['source', 'mode', 'tour', 'plan', 'interval', 'kind', 'step', 'count', 'tasks', 'exams'].map((k) => [k, k === 'count' || k === 'tasks' || k === 'exams' ? 1 : 'x']));
  assert.ok(Object.keys(sanitizeProps(many)).length <= 8);
});
check('nothing is recorded without explicit consent, in the demo, or signed out', () => {
  const base = { consent: 'granted', isDemo: false, signedIn: true, available: true };
  assert.equal(canRecord(base), true);
  assert.equal(canRecord({ ...base, consent: null }), false);
  assert.equal(canRecord({ ...base, consent: 'denied' }), false);
  assert.equal(canRecord({ ...base, isDemo: true }), false);
  assert.equal(canRecord({ ...base, signedIn: false }), false);
  assert.equal(canRecord({ ...base, available: false }), false);
});
check('asked once; never with Do Not Track / GPC, never in the demo', () => {
  const base = { consent: null, optOutSignal: false, isDemo: false, available: true };
  assert.equal(shouldAskConsent(base), true);
  assert.equal(shouldAskConsent({ ...base, consent: 'denied' }), false);
  assert.equal(shouldAskConsent({ ...base, consent: 'granted' }), false);
  assert.equal(shouldAskConsent({ ...base, optOutSignal: true }), false);
  assert.equal(shouldAskConsent({ ...base, isDemo: true }), false);
});
check('once-only events and one session_start per day', () => {
  assert.equal(onceKey('onboarding_completed', '2026-11-09'), 'onboarding_completed');
  assert.equal(onceKey('session_start', '2026-11-09'), 'session_start:2026-11-09');
  assert.equal(onceKey('plan_applied', '2026-11-09'), null);
});

console.log('\n=== public pages: honest claims ===');
const landing = readFileSync(join(root, 'index.html'), 'utf8');
check('landing has the brief\'s headline, sign-up, demo, privacy and terms links', () => {
  assert.match(landing, /Stop organizing your workload\. Start getting it done\./);
  assert.match(landing, /href="\/signup\.html"/);
  assert.match(landing, /href="\/dashboard\.html\?demo=1&tour=1"/);
  assert.match(landing, /href="\/privacy\.html"/);
  assert.match(landing, /href="\/terms\.html"/);
});
check('no purchase button and no exaggerated claims while billing is off', () => {
  assert.doesNotMatch(landing, /\b(buy now|subscribe now|checkout|upgrade now)\b/i);
  // The only mention of "guarantee" is the FAQ question that says no.
  assert.doesNotMatch(landing.replace('Will it guarantee better grades?', ''), /guarantee/i);
  assert.match(landing, /Coming soon/);
  assert.match(landing, /Calendar sync — planned, not available yet/);
  assert.doesNotMatch(landing, /\bAI-powered\b/i);
});
check('legal pages exist, are marked as drafts, and are part of the build', () => {
  ['privacy.html', 'terms.html'].forEach((f) => {
    assert.ok(existsSync(join(root, f)), f);
    assert.match(readFileSync(join(root, f), 'utf8'), /Draft for review/);
  });
  const vite = readFileSync(join(root, 'vite.config.js'), 'utf8');
  assert.match(vite, /privacy\.html/);
  assert.match(vite, /terms\.html/);
});
check('landing screenshots are real files', () => {
  ['today.webp', 'smart.webp', 'import.webp'].forEach((f) => assert.ok(existsSync(join(root, 'public/landing', f)), f));
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
