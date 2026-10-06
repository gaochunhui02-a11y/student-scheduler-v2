// V2-G translation audit, kept as a regression test:
//   - every key exists in en, zh and ja (English-only *One singulars aside)
//   - every key the code/markup references exists
//   - no zh/ja string is an untranslated copy of the English
//   - model messages (scheduler notes/errors, recurring & partial-completion
//     validation) carry keys that exist, and tMessage/tCount render them
//   - no hard-coded English attributes left in JS templates
// Run with `npm test` or `node tests/i18n-audit.test.js`.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { t, tCount, tMessage } from '../src/shared/i18n.js';
import { generateSchedule, validateManualStudyEdit, resolveDayBounds } from '../src/dashboard/scheduler.js';
import { validateCompletedMinutesInput } from '../src/dashboard/carryOverModel.js';
import { validateSeriesFields } from '../src/dashboard/recurringClasses.js';
import { displayBlockName, mealLabel } from '../src/shared/blockLabels.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const i18nSrc = readFileSync(join(root, 'src/shared/i18n.js'), 'utf8');
let totalFailures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    totalFailures++;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

function block(lang) {
  const start = i18nSrc.indexOf(`\nconst ${lang} = {`);
  const end = i18nSrc.indexOf('\n};', start);
  const body = i18nSrc.slice(start, end);
  return Object.fromEntries([...body.matchAll(/^ {2}'([^']+)': (['"])((?:\\.|(?!\2).)*)\2,/gm)].map((m) => [m[1], m[3]]));
}
const dicts = { en: block('en'), zh: block('zh'), ja: block('ja') };

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const codeFiles = [...walk(join(root, 'src')).filter((f) => f.endsWith('.js') && !f.endsWith('i18n.js')), join(root, 'dashboard.html')];

console.log('\n=== Key parity and coverage ===');
check('every key exists in en, zh and ja (except English-only tCount singulars)', () => {
  const all = new Set([...Object.keys(dicts.en), ...Object.keys(dicts.zh), ...Object.keys(dicts.ja)]);
  const problems = [...all].filter((k) => {
    const inAll = ['en', 'zh', 'ja'].every((l) => k in dicts[l]);
    const englishSingular = k.endsWith('One') && k in dicts.en && !(k in dicts.zh) && (k.slice(0, -3) in dicts.en);
    return !inAll && !englishSingular;
  });
  assert.deepEqual(problems, []);
});
check('every key referenced by code or markup exists in English', () => {
  const used = new Set();
  codeFiles.forEach((f) => {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/(?:\bt\(|tCount\(|data-i18n(?:-[a-z-]+)?=)['"]([a-zA-Z]+\.[\w.]+)['"]/g)) used.add(m[1]);
  });
  assert.deepEqual([...used].filter((k) => !(k in dicts.en)), []);
});
check('no zh/ja string is an untranslated copy of the English', () => {
  const copies = ['zh', 'ja'].flatMap((l) =>
    Object.keys(dicts[l]).filter((k) => dicts[l][k] === dicts.en[k] && /[A-Za-z]{3,}/.test(dicts.en[k].replace(/\{\w+\}/g, '')))
  );
  assert.deepEqual(copies, []);
});
check('placeholders match across languages', () => {
  const tokens = (s) => [...(s || '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const mismatched = Object.keys(dicts.en).filter((k) => ['zh', 'ja'].some((l) => k in dicts[l] && tokens(dicts[l][k]) !== tokens(dicts.en[k])));
  assert.deepEqual(mismatched, []);
});

console.log('\n=== Model messages are translatable ===');
check('scheduler notes carry existing keys and render without leftover placeholders', () => {
  const r = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '09:30',
    classes: [{ name: 'A', start: '07:30', end: '08:30' }, { name: 'B', start: '08:00', end: '09:00' }],
    meals: [{ name: 'Breakfast', duration: 30, on: true, time: '08:00' }],
    subjects: [{ id: 's', name: 'Calc', minutes: 240 }],
    prefs: { sessionCap: 60, staminaBreak: 15, switchBreak: 10, minNewBlock: 30 },
  });
  assert.equal(r.noteDetails.length, r.notes.length);
  assert.ok(r.noteDetails.length >= 2);
  r.noteDetails.forEach((d) => {
    assert.ok(d.key in dicts.en, d.key);
    assert.doesNotMatch(tMessage(d), /\{\w+\}/);
  });
});
check('validation results carry existing keys', () => {
  const results = [
    resolveDayBounds(null, '22:00'),
    resolveDayBounds('07:00', '07:30'),
    validateManualStudyEdit({ newStart: NaN, duration: 30 }),
    validateCompletedMinutesInput('-5', 60),
    validateCompletedMinutesInput('90', 60),
    validateSeriesFields({}),
    validateSeriesFields({ name: 'x', days_of_week: [] }),
  ];
  results.forEach((r) => {
    assert.ok(r.errorKey && r.errorKey in dicts.en, JSON.stringify(r));
    assert.doesNotMatch(tMessage(r), /\{\w+\}/);
  });
});
check('tMessage falls back to the English text when there is no key', () => {
  assert.equal(tMessage({ error: 'Plain' }), 'Plain');
  assert.equal(tMessage(null), '');
});
check('tCount picks the English singular only for exactly 1', () => {
  assert.equal(tCount('history.classCount', 1), '1 class');
  assert.equal(tCount('history.classCount', 0), '0 classes');
  assert.equal(tCount('history.classCount', 2), '2 classes');
});
check('generated block names are translated at display time only', () => {
  assert.equal(displayBlockName({ type: 'break', name: 'Break' }, t), t('legend.break'));
  assert.equal(displayBlockName({ item_type: 'free', name: 'Free time' }, t), t('legend.free'));
  assert.equal(displayBlockName({ type: 'meal', name: 'Lunch' }, t), t('meals.lunch'));
  assert.equal(displayBlockName({ type: 'study', name: 'Lunch' }, t), 'Lunch'); // user content untouched
  assert.equal(mealLabel('Brunch', t), 'Brunch');
});

console.log('\n=== No hard-coded English in templates ===');
check('JS templates use translated aria-label/title/placeholder text', () => {
  const offenders = [];
  codeFiles.filter((f) => f.endsWith('.js')).forEach((f) => {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\b(aria-label|title|placeholder)="([A-Za-z][^"$]*)"/g)) {
      const before = s.slice(Math.max(0, m.index - 1), m.index);
      if (before === '-') continue; // a data-i18n-* hook carrying a key
      offenders.push(`${f.split(/[\\/]src[\\/]/)[1]}: ${m[0]}`);
    }
  });
  assert.deepEqual(offenders, []);
});
check('no date is formatted with the browser locale instead of the app language', () => {
  const offenders = codeFiles.filter((f) => /toLocale(Date|Time)?String\(undefined/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
