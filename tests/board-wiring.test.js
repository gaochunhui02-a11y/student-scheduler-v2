// Guards against the exact class of bug found in v1.1: board.js calling a
// boardModel.js export (getBoardTemplate) that was never added to its own
// import list. That's a plain ReferenceError the instant the affected code
// path runs (clicking "Use this template") — but every other automated
// test in this project exercises boardModel.js's pure functions directly,
// never board.js's own wiring, so nothing here would ever have failed even
// though the feature was completely broken at runtime. This is a small,
// source-level "did you forget to import something you use" smoke check —
// not a replacement for manually exercising the UI, but cheap insurance
// against this exact mistake recurring silently.
//
// No DOM, no Supabase, no bundler — just reading the two files as text.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const boardSrc = readFileSync(join(__dirname, '../src/board/board.js'), 'utf8');
const boardModelSrc = readFileSync(join(__dirname, '../src/board/boardModel.js'), 'utf8');
const boardDataSrc = readFileSync(join(__dirname, '../src/board/boardData.js'), 'utf8');

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

// Every named import board.js actually declares from a given module.
function importedNamesFrom(source, moduleSuffix) {
  const re = new RegExp(`import \\{([\\s\\S]*?)\\} from '${moduleSuffix.replace('.', '\\.')}';`);
  const match = source.match(re);
  assert.ok(match, `board.js has no import block from ${moduleSuffix}`);
  return new Set([...match[1].matchAll(/(\w+)/g)].map((m) => m[1]));
}

// Every function/const a module exports.
function exportedNamesFrom(source) {
  const fns = [...source.matchAll(/export function (\w+)/g)].map((m) => m[1]);
  const consts = [...source.matchAll(/export const (\w+)/g)].map((m) => m[1]);
  return [...fns, ...consts];
}

// True if `name` is referenced as a real identifier use (call, property
// access, or bare reference) somewhere in board.js OUTSIDE its own import
// block — i.e. board.js's code actually depends on this name existing.
function isReferencedOutsideImports(source, name, importBlockText) {
  const withoutImports = source.replace(importBlockText, '');
  return new RegExp(`[^.\\w]${name}[^\\w]`).test(withoutImports);
}

// ---------------------------------------------------------------------------
scenario('A. Every boardModel.js export that board.js actually uses is imported', () => {
  const modelImportBlockMatch = boardSrc.match(/import \{[\s\S]*?\} from '\.\/boardModel\.js';/)[0];
  const imported = importedNamesFrom(boardSrc, './boardModel.js');
  const exported = exportedNamesFrom(boardModelSrc);

  exported.forEach((name) => {
    const usesIt = isReferencedOutsideImports(boardSrc, name, modelImportBlockMatch);
    if (!usesIt) return; // board.js doesn't use this export at all — nothing to check
    check(`"${name}" is used in board.js and is in its boardModel.js import list`, () => {
      assert.equal(imported.has(name), true, `${name} is called/referenced in board.js but missing from the import { ... } from './boardModel.js' block`);
    });
  });

  // The exact regression this file exists to catch, named explicitly so a
  // future reader immediately understands why this test file exists.
  check('getBoardTemplate specifically is imported (the v1.1 Board Template bug)', () => {
    assert.equal(imported.has('getBoardTemplate'), true);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Every boardData.js export that board.js actually uses is imported', () => {
  const dataImportBlockMatch = boardSrc.match(/import \{[\s\S]*?\} from '\.\/boardData\.js';/)[0];
  const imported = importedNamesFrom(boardSrc, './boardData.js');
  const exported = [...boardDataSrc.matchAll(/export async function (\w+)/g)].map((m) => m[1]);

  exported.forEach((name) => {
    const usesIt = isReferencedOutsideImports(boardSrc, name, dataImportBlockMatch);
    if (!usesIt) return;
    check(`"${name}" is used in board.js and is in its boardData.js import list`, () => {
      assert.equal(imported.has(name), true, `${name} is called in board.js but missing from the import { ... } from './boardData.js' block`);
    });
  });
});

// ---------------------------------------------------------------------------
scenario('C. The template apply path specifically references only imported names', () => {
  const applyTemplateMatch = boardSrc.match(/async function applyTemplate\([\s\S]*?\n  \}/);
  check('applyTemplate() exists as a single, extractable function', () => {
    assert.ok(applyTemplateMatch, 'could not locate applyTemplate() in board.js — has it been renamed?');
  });

  const body = applyTemplateMatch[0];
  ['getBoardTemplate', 'buildTemplateStructure', 'createBoard', 'createNode', 'createEdge'].forEach((name) => {
    check(`applyTemplate() calls ${name}(...)`, () => {
      assert.match(body, new RegExp(`\\b${name}\\(`));
    });
  });

  const imported = importedNamesFrom(boardSrc, './boardModel.js');
  const importedData = importedNamesFrom(boardSrc, './boardData.js');
  check('every name applyTemplate() calls from boardModel.js/boardData.js is actually imported', () => {
    ['getBoardTemplate', 'buildTemplateStructure'].forEach((name) => assert.equal(imported.has(name), true, name));
    ['createBoard', 'createNode', 'createEdge'].forEach((name) => assert.equal(importedData.has(name), true, name));
  });
});

// ---------------------------------------------------------------------------
// V2-D: Planner -> Board is a read-only reflection. These source checks pin
// the "no sync loop" design: the Planner-status refresh path reads and
// re-renders only, and nothing on the Board can write a Planner-derived
// status into board_nodes or touch schedule_items.
scenario('D. Planner status reflection never writes', () => {
  const refreshMatch = boardSrc.match(/async function refreshPlannerStatuses\([\s\S]*?\n  \}/);
  check('refreshPlannerStatuses() exists as a single, extractable function', () => {
    assert.ok(refreshMatch, 'could not locate refreshPlannerStatuses() in board.js');
  });
  const body = refreshMatch ? refreshMatch[0] : '';
  ['updateNode', 'createNode', 'deleteNode', 'createEdge', 'deleteEdge', 'saveNodeFields', 'createStudyTaskFromBoard'].forEach((name) => {
    check(`refreshPlannerStatuses() never calls ${name}`, () => {
      assert.doesNotMatch(body, new RegExp(`\\b${name}\\(`));
    });
  });
  check('it only reads through hostApi.getLinkedScheduleItems', () => {
    assert.match(body, /hostApi\.getLinkedScheduleItems\(/);
  });

  check('no updateNode/saveNodeFields call ever passes a Planner-derived status', () => {
    const writes = [...boardSrc.matchAll(/\b(?:updateNode|saveNodeFields)\(([^;]*?)\);/g)].map((m) => m[1]);
    assert.ok(writes.length > 0);
    writes.forEach((args) => assert.doesNotMatch(args, /effectiveNodeStatus|plannerStatusMap/, args));
  });

  check('board.js never imports the Planner data layer', () => {
    assert.doesNotMatch(boardSrc, /from '\.\.\/dashboard\/data\.js'/);
  });

  const dashboardSrc = readFileSync(join(__dirname, '../src/dashboard/dashboard.js'), 'utf8');
  check("dashboard.js's getLinkedScheduleItems bridge is a pure read", () => {
    const line = dashboardSrc.match(/getLinkedScheduleItems:.*$/m);
    assert.ok(line, 'getLinkedScheduleItems not found in boardHostApi');
    assert.match(line[0], /listScheduleItemsForSourceSubjectIds\(/);
  });

  const dataSrc = readFileSync(join(__dirname, '../src/dashboard/data.js'), 'utf8');
  check('listScheduleItemsForSourceSubjectIds only selects (no insert/update/delete)', () => {
    const fn = dataSrc.match(/export async function listScheduleItemsForSourceSubjectIds\([\s\S]*?\n\}/);
    assert.ok(fn);
    assert.match(fn[0], /\.select\(/);
    assert.doesNotMatch(fn[0], /\.(insert|update|upsert|delete)\(/);
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
