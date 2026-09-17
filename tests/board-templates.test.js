// Plain Node tests for the Checkpoint D additions to
// src/board/boardModel.js: deterministic (non-AI) Board templates and the
// gentle-curve edge geometry. No DOM, no Supabase, no i18n — same
// conventions as board-model.test.js. Run with `npm test` or
// `node tests/board-templates.test.js`.

import assert from 'node:assert/strict';
import {
  NODE_TYPES,
  isValidNodeType,
  BOARD_TEMPLATES,
  getBoardTemplate,
  buildTemplateStructure,
  computeEdgeControlPoint,
  computeEdgeCurvePath,
  computeQuadraticPoint,
} from '../src/board/boardModel.js';

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

// ---------------------------------------------------------------------------
scenario('A. Every template is a valid, self-consistent node/edge tree', () => {
  check('there are at least the 3 required templates (Exam Prep, Essay/Paper, Project)', () => {
    assert.ok(BOARD_TEMPLATES.length >= 3);
    assert.ok(BOARD_TEMPLATES.some((t) => t.key === 'examPrep'));
    assert.ok(BOARD_TEMPLATES.some((t) => t.key === 'essay'));
    assert.ok(BOARD_TEMPLATES.some((t) => t.key === 'project'));
  });

  BOARD_TEMPLATES.forEach((template) => {
    check(`"${template.key}": every node_type (root + children) is a real NODE_TYPES value`, () => {
      assert.equal(isValidNodeType(template.root.nodeType), true);
      template.children.forEach((c) => assert.equal(isValidNodeType(c.nodeType), true));
    });
    check(`"${template.key}": has at least 3 steps under the root (a meaningful breakdown, not a stub)`, () => {
      assert.ok(template.children.length >= 3);
    });
    check(`"${template.key}": every titleKey (root + children) is a distinct, non-empty string`, () => {
      const keys = [template.root.titleKey, ...template.children.map((c) => c.titleKey)];
      assert.ok(keys.every((k) => typeof k === 'string' && k.length > 0));
      assert.equal(new Set(keys).size, keys.length, 'no two nodes in one template share a title key');
    });
    check(`"${template.key}": has its own board titleKey, distinct from every node's titleKey`, () => {
      assert.ok(typeof template.titleKey === 'string' && template.titleKey.length > 0);
      const nodeKeys = new Set([template.root.titleKey, ...template.children.map((c) => c.titleKey)]);
      assert.equal(nodeKeys.has(template.titleKey), false);
    });
  });

  check('getBoardTemplate looks up by key', () => {
    assert.equal(getBoardTemplate('project').key, 'project');
  });
  check('getBoardTemplate returns null for an unknown key rather than throwing', () => {
    assert.equal(getBoardTemplate('does-not-exist'), null);
  });
});

// ---------------------------------------------------------------------------
scenario('B. buildTemplateStructure flattens a template into a generic node/edge spec', () => {
  const examPrep = getBoardTemplate('examPrep');
  const structure = buildTemplateStructure(examPrep);

  check('node 0 is always the root', () => {
    assert.equal(structure.nodes[0], examPrep.root);
  });
  check('the node list is root + every child, in order, nothing dropped or duplicated', () => {
    assert.equal(structure.nodes.length, 1 + examPrep.children.length);
    assert.deepEqual(structure.nodes.slice(1), examPrep.children);
  });
  check('every edge originates at the root (index 0) — a flat one-level tree, no self-edges', () => {
    structure.edges.forEach((e) => {
      assert.equal(e.fromIndex, 0);
      assert.notEqual(e.fromIndex, e.toIndex);
    });
  });
  check('there is exactly one edge per child, each pointing at a distinct child index', () => {
    assert.equal(structure.edges.length, examPrep.children.length);
    const targets = structure.edges.map((e) => e.toIndex).sort();
    assert.deepEqual(targets, examPrep.children.map((_, i) => i + 1).sort());
  });
  check('every edge uses the existing "parent" relationship enum value, not a fabricated one', () => {
    structure.edges.forEach((e) => assert.equal(e.relationship, 'parent'));
  });
  check('the board title key is carried through unchanged', () => {
    assert.equal(structure.boardTitleKey, examPrep.titleKey);
  });

  check('every BOARD_TEMPLATES entry produces a valid structure (no template is malformed)', () => {
    BOARD_TEMPLATES.forEach((template) => {
      const s = buildTemplateStructure(template);
      assert.ok(s);
      assert.equal(s.nodes.length, 1 + template.children.length);
      assert.equal(s.edges.length, template.children.length);
    });
  });

  check('a null/malformed template returns null rather than throwing', () => {
    assert.equal(buildTemplateStructure(null), null);
    assert.equal(buildTemplateStructure({}), null);
    assert.equal(buildTemplateStructure({ root: {}, children: 'not-an-array' }), null);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Edge curve geometry (computeEdgeControlPoint / computeEdgeCurvePath / computeQuadraticPoint)', () => {
  check('the control point sits off the straight line (a visible bow), for a normal horizontal edge', () => {
    const c = computeEdgeControlPoint(0, 0, 200, 0);
    assert.equal(c.x, 100, 'still centered horizontally between the two endpoints');
    assert.notEqual(c.y, 0, 'offset perpendicular to the line, not sitting on it');
  });
  check('a zero-length edge (both endpoints identical) never divides by zero / produces NaN', () => {
    const c = computeEdgeControlPoint(50, 50, 50, 50);
    assert.equal(c.x, 50);
    assert.equal(c.y, 50);
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y));
  });
  check('the bow is capped rather than growing unbounded on a very long edge', () => {
    const short = computeEdgeControlPoint(0, 0, 100, 0);
    const long = computeEdgeControlPoint(0, 0, 5000, 0);
    const shortBow = Math.abs(short.y);
    const longBow = Math.abs(long.y);
    assert.ok(longBow > shortBow, 'a longer edge still bows out somewhat more than a short one');
    assert.ok(longBow <= 40 + 0.001, 'but never past the fixed maximum bow distance');
  });

  check('computeEdgeCurvePath emits a well-formed single-quadratic SVG path string', () => {
    const d = computeEdgeCurvePath(0, 0, 200, 0);
    assert.match(d, /^M 0 0 Q -?\d+(\.\d+)? -?\d+(\.\d+)? 200 0$/);
  });

  check('computeQuadraticPoint at t=0 is the start point, at t=1 is the end point', () => {
    const start = computeQuadraticPoint(10, 20, 300, 400, 0);
    const end = computeQuadraticPoint(10, 20, 300, 400, 1);
    assert.deepEqual(start, { x: 10, y: 20 });
    assert.deepEqual(end, { x: 300, y: 400 });
  });
  check('computeQuadraticPoint at t=0.5 lies on the bowed curve, not the straight-line midpoint', () => {
    const mid = computeQuadraticPoint(0, 0, 200, 0, 0.5);
    assert.equal(mid.x, 100, 'still horizontally centered');
    assert.notEqual(mid.y, 0, 'off the straight line, following the same bow as the control point');
  });
  check('every point produced is finite, even for a zero-length edge', () => {
    const p = computeQuadraticPoint(5, 5, 5, 5, 0.5);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  });
});

// ---------------------------------------------------------------------------
console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
