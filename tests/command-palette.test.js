// Tests for the V2-F command palette's pure logic (src/shared/commandPalette.js):
// matching/ranking, the Ctrl/Cmd+K shortcut guard, and keyboard selection.
// Plus a source-level check that every palette command reuses an existing
// handler rather than introducing a second create path.
// Run with `npm test` or `node tests/command-palette.test.js`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  normalizeForSearch,
  scoreMatch,
  filterCommands,
  isTypingTarget,
  isPaletteShortcut,
  moveSelection,
} from '../src/shared/commandPalette.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let totalFailures = 0;

function scenario(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    fn();
  } catch (e) {
    totalFailures++;
    console.log(`  FAIL  (scenario threw) ${e.message}`);
  }
}

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

const commands = [
  { id: 'add-task', title: 'Add study task', keywords: ['subject'] },
  { id: 'add-class', title: 'Add class', keywords: ['lecture'] },
  { id: 'new-board', title: 'New board', keywords: ['project'] },
  { id: 'open-planner', title: 'Open Planner', keywords: ['today', 'schedule'] },
  { id: 'open-board', title: 'Open Board' },
  { id: 'settings', title: 'Settings', keywords: ['theme'] },
  { id: 'task-1', title: 'Résumé draft' },
  { id: 'task-2', title: '微积分作业' },
];
const ids = (list) => list.map((c) => c.id);

// ---------------------------------------------------------------------------
scenario('A. Matching and ranking', () => {
  check('normalization: case, whitespace, diacritics', () => {
    assert.equal(normalizeForSearch('  Résumé  '), 'resume');
    assert.equal(normalizeForSearch(null), '');
  });
  check('tiers: exact > prefix > word start > substring > subsequence', () => {
    const exact = scoreMatch('settings', 'Settings');
    const prefix = scoreMatch('sett', 'Settings');
    const word = scoreMatch('plan', 'Open Planner');
    const sub = scoreMatch('lann', 'Open Planner');
    const subseq = scoreMatch('opln', 'Open Planner');
    assert.ok(exact > prefix && prefix > word && word > sub && sub > subseq && subseq > 0);
  });
  check('no match -> null', () => {
    assert.equal(scoreMatch('xyz', 'Open Planner'), null);
    assert.equal(scoreMatch('rennalp', 'Open Planner'), null); // wrong order
  });
  check('empty query returns everything in the given order', () => {
    assert.deepEqual(ids(filterCommands(commands, '')), ids(commands));
    assert.deepEqual(ids(filterCommands(commands, '   ')), ids(commands));
  });
  check('"board": both board commands, title hits first', () => {
    const r = ids(filterCommands(commands, 'board'));
    assert.deepEqual(r.slice(0, 2).sort(), ['new-board', 'open-board']);
  });
  check('keywords match but rank below a title match', () => {
    assert.deepEqual(ids(filterCommands(commands, 'lecture')), ['add-class']);
    const r = ids(filterCommands(commands, 'project'));
    assert.deepEqual(r, ['new-board']);
  });
  check('task names: accent-insensitive and CJK substring', () => {
    assert.deepEqual(ids(filterCommands(commands, 'resume')), ['task-1']);
    assert.deepEqual(ids(filterCommands(commands, '积分')), ['task-2']);
  });
  check('limit and junk input are safe', () => {
    assert.equal(filterCommands(commands, '', 3).length, 3);
    assert.deepEqual(filterCommands(null, 'x'), []);
    assert.deepEqual(ids(filterCommands([{ id: 'n' }, ...commands], 'settings')), ['settings']);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Ctrl/Cmd+K shortcut', () => {
  const body = { tagName: 'BODY' };
  check('Ctrl+K and Cmd+K open it outside text fields', () => {
    assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, target: body }), true);
    assert.equal(isPaletteShortcut({ key: 'K', metaKey: true, target: body }), true);
    assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, target: { tagName: 'BUTTON' } }), true);
    assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, target: { tagName: 'INPUT', type: 'checkbox' } }), true);
  });
  check('never steals the shortcut while typing', () => {
    assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, target: { tagName: 'INPUT', type: 'text' } }), false);
    assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, target: { tagName: 'INPUT' } }), false);
    assert.equal(isPaletteShortcut({ key: 'k', metaKey: true, target: { tagName: 'TEXTAREA' } }), false);
    assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, target: { tagName: 'DIV', isContentEditable: true } }), false);
    assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  });
  check('other keys / modifiers do nothing', () => {
    assert.equal(isPaletteShortcut({ key: 'k', target: body }), false);
    assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, shiftKey: true, target: body }), false);
    assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, altKey: true, target: body }), false);
    assert.equal(isPaletteShortcut({ key: 'j', ctrlKey: true, target: body }), false);
    assert.equal(isPaletteShortcut(null), false);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Keyboard selection', () => {
  check('wraps both ways, starts sensibly, empty -> -1', () => {
    assert.equal(moveSelection(-1, 1, 3), 0);
    assert.equal(moveSelection(-1, -1, 3), 2);
    assert.equal(moveSelection(2, 1, 3), 0);
    assert.equal(moveSelection(0, -1, 3), 2);
    assert.equal(moveSelection(1, 1, 0), -1);
  });
});

// ---------------------------------------------------------------------------
scenario('D. Palette/Quick Add reuse existing handlers (no second create path)', () => {
  const src = readFileSync(join(__dirname, '../src/dashboard/dashboard.js'), 'utf8');
  const start = src.indexOf('// ---------------- Command palette (Ctrl/Cmd+K) + Quick Add (V2-F)');
  const end = src.indexOf('const commandPalette = initCommandPalette', start);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';
  check('palette block found', () => assert.ok(block.length > 0));
  ['insertStudySubject', 'insertClass', 'createClassSeries', 'createBoard', 'createNode', 'supabase'].forEach((name) => {
    check(`palette commands never call ${name} directly`, () => {
      assert.doesNotMatch(block, new RegExp(`\\b${name}\\b`));
    });
  });
  check('create commands click the existing buttons', () => {
    ['addStudyBtn', 'addClassBtn', 'addRecurringSeriesBtn', 'boardAddNodeBtn'].forEach((id) => assert.match(block, new RegExp(id)));
  });
});

console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
