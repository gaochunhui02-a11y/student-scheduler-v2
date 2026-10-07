// V4-A workspace modes, module visibility and spaces. Run: node tests/workspace.test.js

import assert from 'node:assert/strict';
import {
  MODES, MODULES, MODE_DEFAULTS, normalizeWorkspace, isLegacyWorkspace, isModuleEnabled,
  visibleModules, withMode, withModule, visibleSections, moduleForView,
} from '../src/workspace/modules.js';
import {
  validateSpaceFields, effectiveSpaceId, matchesSpace, NO_SPACE, sortSpaces, resolveSpaceFilter, coursesToAssign, SPACE_ICONS,
} from '../src/workspace/spacesModel.js';

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

const builtV3 = MODULES.filter((m) => m.built && m.v3).map((m) => m.id);
const builtAll = MODULES.filter((m) => m.built).map((m) => m.id);

console.log('\n=== legacy (V3) accounts keep everything ===');
check('no saved workspace = legacy = every built V3 page visible', () => {
  assert.equal(isLegacyWorkspace(normalizeWorkspace(null)), true);
  assert.deepEqual(visibleModules(normalizeWorkspace(undefined)), builtV3);
  assert.deepEqual(builtV3, ['home', 'planner', 'week', 'calendar', 'semester', 'tasks', 'courses', 'exams', 'grades', 'board', 'history', 'insights']);
});
check('unbuilt V4 modules are never shown, even if enabled', () => {
  const ws = normalizeWorkspace({ mode: 'work', modules: { goals: true } });
  assert.equal(isModuleEnabled(ws, 'goals'), true);
  assert.equal(visibleModules(ws).includes('goals'), false);
});
check('legacy (V3) accounts do not get new V4 pages until they opt in', () => {
  assert.equal(visibleModules(normalizeWorkspace(null)).includes('projects'), false);
  const on = withModule(normalizeWorkspace(null), 'projects', true);
  assert.deepEqual(visibleModules(on), [...builtV3.slice(0, 6), 'projects', ...builtV3.slice(6)]);
});
check('Projects: on for Work and Multiple areas, off for School unless enabled', () => {
  assert.ok(visibleModules(normalizeWorkspace({ mode: 'work' })).includes('projects'));
  assert.ok(visibleModules(normalizeWorkspace({ mode: 'multiple' })).includes('projects'));
  assert.ok(!visibleModules(normalizeWorkspace({ mode: 'school' })).includes('projects'));
  assert.ok(visibleModules(withModule(normalizeWorkspace({ mode: 'school' }), 'projects', true)).includes('projects'));
});

console.log('\n=== modes ===');
check('each mode has defaults; core modules always on', () => {
  MODES.forEach((m) => assert.ok(MODE_DEFAULTS[m].length > 3, m));
  MODES.forEach((m) => {
    const ws = normalizeWorkspace({ mode: m });
    assert.ok(visibleModules(ws).includes('home') && visibleModules(ws).includes('planner'), m);
  });
});
check('school shows academics; work and personal do not', () => {
  const school = visibleModules(normalizeWorkspace({ mode: 'school' }));
  const work = visibleModules(normalizeWorkspace({ mode: 'work' }));
  const personal = visibleModules(normalizeWorkspace({ mode: 'personal' }));
  assert.ok(['courses', 'exams', 'grades', 'semester'].every((x) => school.includes(x)));
  assert.ok(['courses', 'grades', 'semester'].every((x) => !work.includes(x) && !personal.includes(x)));
  assert.ok(work.includes('board') && !personal.includes('board'));
});
check('multiple areas shows every built module', () => {
  assert.deepEqual(visibleModules(normalizeWorkspace({ mode: 'multiple' })), builtAll);
});
check('sections with nothing visible are hidden', () => {
  assert.equal(visibleSections(normalizeWorkspace({ mode: 'personal' })).includes('academics'), false);
  assert.equal(visibleSections(normalizeWorkspace({ mode: 'school' })).includes('academics'), true);
});

console.log('\n=== customising ===');
check('turning a module on/off overrides the mode default', () => {
  let ws = normalizeWorkspace({ mode: 'work' });
  ws = withModule(ws, 'courses', true);
  assert.equal(visibleModules(ws).includes('courses'), true);
  ws = withModule(ws, 'board', false);
  assert.equal(visibleModules(ws).includes('board'), false);
  ws = withModule(ws, 'courses', false); // back to default -> override removed
  assert.equal('courses' in ws.modules, false);
});
check('core modules cannot be switched off', () => {
  const ws = withModule(normalizeWorkspace({ mode: 'school' }), 'planner', false);
  assert.equal(visibleModules(ws).includes('planner'), true);
  assert.equal(normalizeWorkspace({ mode: 'school', modules: { home: false } }).modules.home, undefined);
});
check('a legacy account that customises keeps the full set (becomes "multiple")', () => {
  const ws = withModule(normalizeWorkspace(null), 'history', false);
  assert.equal(ws.mode, 'multiple');
  assert.deepEqual(visibleModules(ws), builtV3.filter((x) => x !== 'history'));
});
check('switching mode keeps deliberate differences only', () => {
  let ws = withModule(normalizeWorkspace({ mode: 'work' }), 'courses', true);
  ws = withMode(ws, 'school'); // courses is a school default -> override dropped
  assert.equal('courses' in ws.modules, false);
  ws = withModule(ws, 'grades', false);
  ws = withMode(ws, 'selfstudy'); // grades isn't a self-study default -> override is redundant
  assert.equal('grades' in ws.modules, false);
});
check('junk preferences are cleaned', () => {
  const ws = normalizeWorkspace({ mode: 'party', modules: { nope: true, board: 'yes', grades: false }, defaultSpaceId: 'x' });
  assert.deepEqual(ws, { mode: null, modules: { grades: false }, defaultSpaceId: null });
  assert.deepEqual(normalizeWorkspace([1, 2]), { mode: null, modules: {}, defaultSpaceId: null });
});
check('views map back to modules (for the router/palette)', () => {
  assert.equal(moduleForView('gradesView').id, 'grades');
  assert.equal(moduleForView('settingsView'), null);
});

console.log('\n=== spaces ===');
check('space fields are validated; unknown icons/colours fall back', () => {
  assert.equal(validateSpaceFields({ name: '  ' }).errors.name, 'spaces.errName');
  assert.equal(validateSpaceFields({ name: 'x'.repeat(61) }).errors.name, 'spaces.errNameLong');
  const v = validateSpaceFields({ name: ' Japanese ', icon: '<svg>', color: 'red' });
  assert.deepEqual(v.fields, { name: 'Japanese', icon: 'circle', color: null });
  assert.ok(SPACE_ICONS.includes('school'));
});
const courseById = new Map([['c1', { id: 'c1', space_id: 'S' }], ['c2', { id: 'c2', space_id: null }]]);
check('a task inherits its course\'s space unless it has its own', () => {
  assert.equal(effectiveSpaceId({ courseId: 'c1' }, courseById), 'S');
  assert.equal(effectiveSpaceId({ courseId: 'c1', spaceId: 'W' }, courseById), 'W');
  assert.equal(effectiveSpaceId({ course_id: 'c2' }, courseById), null);
  assert.equal(effectiveSpaceId({}, courseById), null);
});
check('space filters: all / a space / no space', () => {
  assert.equal(matchesSpace('S', null), true);
  assert.equal(matchesSpace(null, null), true);
  assert.equal(matchesSpace('S', 'S'), true);
  assert.equal(matchesSpace('W', 'S'), false);
  assert.equal(matchesSpace(null, NO_SPACE), true);
  assert.equal(matchesSpace('S', NO_SPACE), false);
});
check('a stale filter (archived/deleted space) falls back to all spaces', () => {
  const spaces = [{ id: 'S', archived: false }, { id: 'A', archived: true }];
  assert.equal(resolveSpaceFilter('S', spaces), 'S');
  assert.equal(resolveSpaceFilter('A', spaces), null);
  assert.equal(resolveSpaceFilter('gone', spaces), null);
  assert.equal(resolveSpaceFilter(NO_SPACE, spaces), NO_SPACE);
});
check('archived spaces sort last', () => {
  const s = sortSpaces([{ id: 1, name: 'B', archived: true }, { id: 2, name: 'A', archived: false, sort_order: 1 }, { id: 3, name: 'C', archived: false, sort_order: 0 }]);
  assert.deepEqual(s.map((x) => x.id), [3, 2, 1]);
});
check('"put my courses in a space" only moves courses without a space', () => {
  const list = coursesToAssign([{ id: 'a', space_id: null }, { id: 'b', space_id: 'X' }, { id: 'c' }], 'S');
  assert.deepEqual(list.map((c) => c.id), ['a', 'c']);
  assert.deepEqual(coursesToAssign([{ id: 'a' }], null), []);
});

console.log('\n------------------------');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
