// V3-Q keyboard shortcut decisions. Run: node tests/shortcuts.test.js
import assert from 'node:assert/strict';
import { resolveShortcut, SHORTCUTS } from '../src/shared/keyboard.js';

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  PASS  ${label}`); } catch (e) { failures += 1; console.log(`  FAIL  ${label}\n        ${e.message}`); }
}
check('single keys', () => {
  assert.equal(resolveShortcut({ key: 'n' }).action, 'quickAdd');
  assert.equal(resolveShortcut({ key: '/' }).action, 'search');
  assert.equal(resolveShortcut({ key: '?' }).action, 'help');
  assert.equal(resolveShortcut({ key: 'x' }).action, null);
});
check('G prefix navigation', () => {
  assert.equal(resolveShortcut({ key: 'g' }).action, 'prefix');
  assert.deepEqual(resolveShortcut({ key: 't', pendingG: true }), { action: 'go', view: 'tasksView' });
  assert.deepEqual(resolveShortcut({ key: 'p', pendingG: true }), { action: 'go', view: 'plannerForm' });
  assert.equal(resolveShortcut({ key: 'z', pendingG: true }).action, null);
});
check('never while typing, with modifiers, or with an overlay open', () => {
  assert.equal(resolveShortcut({ key: 'n', typing: true }).action, null);
  assert.equal(resolveShortcut({ key: 'n', ctrl: true }).action, null);
  assert.equal(resolveShortcut({ key: 'n', overlayOpen: true }).action, null);
});
check('reference list stays short', () => assert.ok(SHORTCUTS.length <= 12));
if (failures) { console.log(`${failures} check(s) FAILED`); process.exit(1); } else console.log('All checks passed');
