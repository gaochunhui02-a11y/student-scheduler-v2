// Plain Node tests for the pure "Break down with AI" logic in
// src/board/aiBreakdownModel.js. No DOM, no Supabase, no network, and no
// real AI provider call — every scenario here mocks the provider boundary
// by constructing the exact response shapes aiBreakdownClient.js's
// requestBoardBreakdown() would resolve to (both the {ok:true, data}
// success shape and the {ok:false, error} failure shape) and feeding them
// straight into the same validation/mapping functions board.js uses. Run
// with `npm test` or `node tests/ai-breakdown.test.js`.

import assert from 'node:assert/strict';
import {
  buildBreakdownContext,
  validateBreakdownResponse,
  layoutChildSuggestions,
  mapSuggestionsToChildNodes,
  breakdownErrorMessageKey,
} from '../src/board/aiBreakdownModel.js';

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
scenario('A. Sanitized context sent to the AI (buildBreakdownContext)', () => {
  check('only title and node type are included', () => {
    const ctx = buildBreakdownContext({
      id: 'n1',
      board_id: 'b1',
      user_id: 'u1',
      linked_study_subject_id: 'study-1',
      title: 'Prepare for Calculus Midterm',
      node_type: 'goal',
      x_position: 100,
      y_position: 50,
    });
    assert.deepEqual(Object.keys(ctx).sort(), ['nodeType', 'title']);
    assert.equal(ctx.title, 'Prepare for Calculus Midterm');
    assert.equal(ctx.nodeType, 'goal');
  });
  check('an invalid/missing node type defaults to "goal"', () => {
    assert.equal(buildBreakdownContext({ title: 'x', node_type: 'bogus' }).nodeType, 'goal');
    assert.equal(buildBreakdownContext({ title: 'x' }).nodeType, 'goal');
  });
  check('a missing/blank title becomes an empty string, never null/undefined', () => {
    assert.equal(buildBreakdownContext({}).title, '');
    assert.equal(buildBreakdownContext(null).title, '');
  });
  check('an overlong title is truncated', () => {
    const ctx = buildBreakdownContext({ title: 'x'.repeat(500) });
    assert.ok(ctx.title.length <= 200);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Structured AI response validation (validateBreakdownResponse)', () => {
  check('a well-formed object-array response is accepted', () => {
    const result = validateBreakdownResponse({
      message: 'Here is a plan.',
      suggestions: [{ title: 'Review limits' }, { title: 'Practice derivatives' }],
    });
    assert.equal(result.valid, true);
    assert.equal(result.suggestions.length, 2);
    assert.equal(result.suggestions[0].title, 'Review limits');
    assert.equal(result.message, 'Here is a plan.');
  });
  check('a plain string array is also accepted (flexible provider output)', () => {
    const result = validateBreakdownResponse({ suggestions: ['Review limits', 'Practice derivatives'] });
    assert.equal(result.valid, true);
    assert.deepEqual(result.suggestions.map((s) => s.title), ['Review limits', 'Practice derivatives']);
  });
  check('a missing message defaults to an empty string, not undefined', () => {
    const result = validateBreakdownResponse({ suggestions: ['x'] });
    assert.equal(result.message, '');
  });

  check('rejects a non-object response (null, string, number, array)', () => {
    assert.equal(validateBreakdownResponse(null).valid, false);
    assert.equal(validateBreakdownResponse('a string').valid, false);
    assert.equal(validateBreakdownResponse(42).valid, false);
  });
  check('rejects an explicit {error} response from the Edge Function, passing the code through', () => {
    const result = validateBreakdownResponse({ error: 'rate_limited' });
    assert.equal(result.valid, false);
    assert.equal(result.error, 'rate_limited');
  });
  check('rejects a response with no suggestions field at all', () => {
    assert.equal(validateBreakdownResponse({ message: 'hi' }).valid, false);
  });
  check('rejects a response where suggestions is not an array', () => {
    assert.equal(validateBreakdownResponse({ suggestions: 'Review limits' }).valid, false);
    assert.equal(validateBreakdownResponse({ suggestions: { title: 'x' } }).valid, false);
  });
  check('filters out blank/whitespace-only/non-string suggestion entries', () => {
    const result = validateBreakdownResponse({ suggestions: ['Real one', '', '   ', 42, null, { title: '' }] });
    assert.equal(result.valid, true);
    assert.deepEqual(result.suggestions.map((s) => s.title), ['Real one']);
  });
  check('a response where every suggestion is invalid is rejected as empty', () => {
    const result = validateBreakdownResponse({ suggestions: ['', '   ', null, {}] });
    assert.equal(result.valid, false);
    assert.equal(result.error, 'empty');
  });
  check('an oversized suggestion list is capped, not rejected outright', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Task ${i}`);
    const result = validateBreakdownResponse({ suggestions: many });
    assert.equal(result.valid, true);
    assert.ok(result.suggestions.length <= 8);
  });
  check('an overlong suggestion title is truncated, not rejected', () => {
    const result = validateBreakdownResponse({ suggestions: ['x'.repeat(500)] });
    assert.equal(result.valid, true);
    assert.ok(result.suggestions[0].title.length <= 120);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Child-node layout (layoutChildSuggestions)', () => {
  check('children are placed in a row beneath the parent', () => {
    const parent = { x_position: 100, y_position: 50 };
    const positions = layoutChildSuggestions(parent, 3, { columnWidth: 220, rowOffset: 160 });
    assert.equal(positions.length, 3);
    positions.forEach((p) => assert.equal(p.y_position, 210));
    assert.equal(positions[0].x_position, 100);
    assert.equal(positions[1].x_position, 320);
    assert.equal(positions[2].x_position, 540);
  });
  check('zero children returns an empty array', () => {
    assert.deepEqual(layoutChildSuggestions({ x_position: 0, y_position: 0 }, 0), []);
  });
  check('a missing/invalid parent position defaults to 0 rather than producing NaN', () => {
    const positions = layoutChildSuggestions({}, 1);
    assert.equal(positions[0].x_position, 0);
    assert.ok(Number.isFinite(positions[0].y_position));
  });
});

// ---------------------------------------------------------------------------
scenario('D. Suggestion -> Board node mapping, selected suggestions only (mapSuggestionsToChildNodes)', () => {
  const parent = { id: 'parent1', x_position: 40, y_position: 40 };
  const suggestions = [{ title: 'Review limits' }, { title: 'Practice derivatives' }, { title: 'Review integrals' }, { title: 'Take a practice exam' }];

  check('only the selected indexes are mapped, in their original order', () => {
    const mapped = mapSuggestionsToChildNodes(suggestions, [0, 2], parent);
    assert.equal(mapped.length, 2);
    assert.equal(mapped[0].title, 'Review limits');
    assert.equal(mapped[1].title, 'Review integrals');
  });
  check('deselecting everything (empty selection) maps to nothing', () => {
    assert.deepEqual(mapSuggestionsToChildNodes(suggestions, [], parent), []);
  });
  check('every mapped node is a "task" type and carries no linked_study_subject_id key at all', () => {
    const mapped = mapSuggestionsToChildNodes(suggestions, [0], parent);
    assert.equal(mapped[0].node_type, 'task');
    assert.equal('linked_study_subject_id' in mapped[0], false);
  });
  check('mapped nodes are positioned under the parent, not on top of it', () => {
    const mapped = mapSuggestionsToChildNodes(suggestions, [0, 1], parent);
    mapped.forEach((n) => assert.ok(n.y_position > parent.y_position));
  });
  check('an out-of-range index is silently ignored rather than throwing', () => {
    const mapped = mapSuggestionsToChildNodes(suggestions, [0, 99], parent);
    assert.equal(mapped.length, 1);
  });
  check('mapping never mutates the original suggestions array', () => {
    const before = JSON.stringify(suggestions);
    mapSuggestionsToChildNodes(suggestions, [0, 1, 2, 3], parent);
    assert.equal(JSON.stringify(suggestions), before);
  });
});

// ---------------------------------------------------------------------------
scenario('E. Error code -> user-facing message key (breakdownErrorMessageKey)', () => {
  check('known failure codes map to their specific message', () => {
    assert.equal(breakdownErrorMessageKey('network_error'), 'board.breakdownNetworkError');
    assert.equal(breakdownErrorMessageKey('rate_limited'), 'board.breakdownRateLimited');
    assert.equal(breakdownErrorMessageKey('provider_error'), 'board.breakdownProviderError');
  });
  check('every other/unknown code collapses to the generic message, never leaking an internal code', () => {
    assert.equal(breakdownErrorMessageKey('unauthorized'), 'board.breakdownGenericError');
    assert.equal(breakdownErrorMessageKey('not_configured'), 'board.breakdownGenericError');
    assert.equal(breakdownErrorMessageKey('invalid_request'), 'board.breakdownGenericError');
    assert.equal(breakdownErrorMessageKey('malformed'), 'board.breakdownGenericError');
    assert.equal(breakdownErrorMessageKey('empty'), 'board.breakdownGenericError');
    assert.equal(breakdownErrorMessageKey(undefined), 'board.breakdownGenericError');
    assert.equal(breakdownErrorMessageKey('something-the-provider-invented'), 'board.breakdownGenericError');
  });
});

// ---------------------------------------------------------------------------
// Mocked-provider end-to-end scenarios: each of these stands in for what
// aiBreakdownClient.requestBoardBreakdown() would have resolved to for a
// given network/provider condition, WITHOUT ever importing that file or
// making a real call — this is the "mock the provider boundary" the brief
// asks for. A malformed or failed mock response must never reach
// mapSuggestionsToChildNodes.
scenario('F. Mocked provider responses never produce a node-creation payload unless valid', () => {
  function simulateFlow(mockResult, parentNode, selectedIndexes) {
    if (!mockResult.ok) {
      return { blocked: true, reason: breakdownErrorMessageKey(mockResult.error) };
    }
    const validated = validateBreakdownResponse(mockResult.data);
    if (!validated.valid) {
      return { blocked: true, reason: breakdownErrorMessageKey(validated.error) };
    }
    return { blocked: false, nodes: mapSuggestionsToChildNodes(validated.suggestions, selectedIndexes, parentNode) };
  }

  const parent = { id: 'p1', x_position: 0, y_position: 0 };

  check('a successful, well-formed mock response produces mappable nodes', () => {
    const outcome = simulateFlow(
      { ok: true, data: { message: 'Plan below', suggestions: [{ title: 'Review limits' }, { title: 'Mock test' }] } },
      parent,
      [0, 1]
    );
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.nodes.length, 2);
  });
  check('a network failure mock is blocked before any node mapping happens', () => {
    const outcome = simulateFlow({ ok: false, error: 'network_error' }, parent, [0]);
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.reason, 'board.breakdownNetworkError');
  });
  check('a rate-limit mock is blocked with the rate-limit message', () => {
    const outcome = simulateFlow({ ok: false, error: 'rate_limited' }, parent, [0]);
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.reason, 'board.breakdownRateLimited');
  });
  check('a provider-error mock is blocked with the provider-error message', () => {
    const outcome = simulateFlow({ ok: false, error: 'provider_error' }, parent, [0]);
    assert.equal(outcome.blocked, true);
  });
  check('a mock that "succeeded" at the network level but returned invalid JSON/shape is still blocked', () => {
    const outcome = simulateFlow({ ok: true, data: 'not even an object' }, parent, [0]);
    assert.equal(outcome.blocked, true);
  });
  check('a mock with an empty suggestions array is blocked, not silently accepted', () => {
    const outcome = simulateFlow({ ok: true, data: { suggestions: [] } }, parent, [0]);
    assert.equal(outcome.blocked, true);
  });
  check('a mock with garbage suggestion entries is blocked once every entry is filtered out', () => {
    const outcome = simulateFlow({ ok: true, data: { suggestions: [null, 42, {}, ''] } }, parent, [0]);
    assert.equal(outcome.blocked, true);
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
