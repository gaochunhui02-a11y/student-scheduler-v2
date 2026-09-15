// Plain Node tests for the pure AI Student Advisor logic in
// src/advisor/advisorModel.js. No DOM, no Supabase, no network, and no
// real AI provider call — every scenario here mocks the provider boundary
// by constructing the exact response shapes advisorClient.js's
// requestAdvisorReply() would resolve to (both the {ok:true, data}
// success shape and the {ok:false, error} failure shape) and feeding them
// straight into the same validation/mapping functions advisor.js uses.
// Run with `npm test` or `node tests/advisor.test.js`.

import assert from 'node:assert/strict';
import {
  buildAdvisorContext,
  validateAdvisorResponse,
  mapSuggestionToStudyTaskFields,
  isStudyTaskFieldsValid,
  mapSuggestionToBoardNodeTitle,
  selectSuggestions,
  advisorErrorMessageKey,
} from '../src/advisor/advisorModel.js';

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
scenario('A. Sanitized Advisor context creation (buildAdvisorContext)', () => {
  check('only planning-relevant fields are included, no ids/user data', () => {
    const ctx = buildAdvisorContext({
      currentDate: '2026-09-18',
      schedule: {
        id: 'schedule-1',
        user_id: 'user-1',
        wake_time: '07:00',
        sleep_time: '23:00',
        preferred_study_period: 'evening',
        earliest_study_time: '18:00',
        latest_study_time: '22:00',
      },
      studySubjects: [
        { id: 's1', schedule_id: 'schedule-1', user_id: 'user-1', name: 'Calculus', minutes_requested: 90, priority: 'high', due_date: '2026-09-19', notes: 'exam Friday' },
      ],
      classes: [{ id: 'c1', name: 'CS 101', start_time: '09:00', end_time: '10:00' }],
      scheduleItems: [],
      boardGoals: [{ id: 'n1', board_id: 'b1', title: 'Prepare for Midterm', node_type: 'goal' }],
    });

    assert.equal(ctx.currentDate, '2026-09-18');
    assert.equal(ctx.availableWindow.wakeTime, '07:00');
    assert.equal(ctx.availableWindow.sleepTime, '23:00');
    assert.equal(ctx.preferredStudyPeriod, 'evening');
    assert.equal(ctx.earliestStudyTime, '18:00');
    assert.equal(ctx.latestStudyTime, '22:00');

    assert.equal(ctx.classes.length, 1);
    assert.deepEqual(Object.keys(ctx.classes[0]).sort(), ['end', 'name', 'start']);

    assert.equal(ctx.tasks.length, 1);
    assert.deepEqual(Object.keys(ctx.tasks[0]).sort(), ['completed', 'dueDate', 'minutes', 'notes', 'priority', 'title']);
    assert.equal(ctx.tasks[0].title, 'Calculus');
    assert.equal(ctx.tasks[0].minutes, 90);
    assert.equal(ctx.tasks[0].priority, 'high');
    assert.equal(ctx.tasks[0].dueDate, '2026-09-19');

    assert.equal(ctx.boardGoals.length, 1);
    assert.deepEqual(Object.keys(ctx.boardGoals[0]).sort(), ['title', 'type']);
    assert.equal(ctx.boardGoals[0].title, 'Prepare for Midterm');

    // No schedule/study-subject/class/board ids, no user_id, anywhere in the context.
    const serialized = JSON.stringify(ctx);
    assert.ok(!serialized.includes('schedule-1'));
    assert.ok(!serialized.includes('user-1'));
    assert.ok(!serialized.includes('"id"'));
  });

  check('missing schedule/subjects/classes/boardGoals degrade to safe empty defaults, not a crash', () => {
    const ctx = buildAdvisorContext({});
    assert.equal(ctx.availableWindow.wakeTime, null);
    assert.equal(ctx.preferredStudyPeriod, 'none');
    assert.deepEqual(ctx.classes, []);
    assert.deepEqual(ctx.tasks, []);
    assert.deepEqual(ctx.boardGoals, []);
  });

  check('a task with no scheduled blocks yet has completed:null ("not started"), not false', () => {
    const ctx = buildAdvisorContext({
      studySubjects: [{ id: 's1', name: 'Physics', minutes_requested: 30, priority: 'medium' }],
      scheduleItems: [],
    });
    assert.equal(ctx.tasks[0].completed, null);
  });
  check('a task whose every scheduled block is completed reports completed:true', () => {
    const ctx = buildAdvisorContext({
      studySubjects: [{ id: 's1', name: 'Physics', minutes_requested: 30, priority: 'medium' }],
      scheduleItems: [
        { sourceSubjectId: 's1', completed: true },
        { sourceSubjectId: 's1', completed: true },
      ],
    });
    assert.equal(ctx.tasks[0].completed, true);
  });
  check('a task with a mix of completed/unfinished blocks reports completed:false', () => {
    const ctx = buildAdvisorContext({
      studySubjects: [{ id: 's1', name: 'Physics', minutes_requested: 30, priority: 'medium' }],
      scheduleItems: [
        { sourceSubjectId: 's1', completed: true },
        { sourceSubjectId: 's1', completed: false },
      ],
    });
    assert.equal(ctx.tasks[0].completed, false);
  });

  check('lists are capped so the payload sent to the AI can never grow unbounded', () => {
    const manySubjects = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, name: `Task ${i}`, minutes_requested: 30, priority: 'medium' }));
    const ctx = buildAdvisorContext({ studySubjects: manySubjects });
    assert.ok(ctx.tasks.length <= 30);
  });

  check('an invalid/missing priority defaults to "medium"', () => {
    const ctx = buildAdvisorContext({ studySubjects: [{ id: 's1', name: 'x', minutes_requested: 10, priority: 'urgent' }] });
    assert.equal(ctx.tasks[0].priority, 'medium');
  });
});

// ---------------------------------------------------------------------------
scenario('B. Structured AI response validation (validateAdvisorResponse)', () => {
  check('a well-formed response with a message and suggestions is accepted', () => {
    const result = validateAdvisorResponse({
      message: 'Your CS assignment should be your first priority.',
      suggestions: [{ title: 'Finish CS assignment', minutes: 90, priority: 'high', dueDate: '2026-09-18', reason: 'Due tomorrow' }],
    });
    assert.equal(result.valid, true);
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].title, 'Finish CS assignment');
    assert.equal(result.suggestions[0].minutes, 90);
    assert.equal(result.suggestions[0].priority, 'high');
    assert.equal(result.suggestions[0].dueDate, '2026-09-18');
    assert.equal(result.suggestions[0].reason, 'Due tomorrow');
  });

  check('a message-only response with an empty suggestions array is still valid (a chat answer needs no action)', () => {
    const result = validateAdvisorResponse({ message: "You're all caught up for today!", suggestions: [] });
    assert.equal(result.valid, true);
    assert.equal(result.suggestions.length, 0);
  });
  check('a message-only response with suggestions entirely omitted is also valid', () => {
    const result = validateAdvisorResponse({ message: 'Take a break, nothing is due soon.' });
    assert.equal(result.valid, true);
    assert.deepEqual(result.suggestions, []);
  });

  check('rejects a completely empty response (no message, no suggestions)', () => {
    const result = validateAdvisorResponse({});
    assert.equal(result.valid, false);
    assert.equal(result.error, 'empty');
  });
  check('rejects a response with only whitespace as the message and no suggestions', () => {
    const result = validateAdvisorResponse({ message: '   ', suggestions: [] });
    assert.equal(result.valid, false);
    assert.equal(result.error, 'empty');
  });
});

// ---------------------------------------------------------------------------
scenario('C. Malformed provider responses rejected', () => {
  check('rejects a non-object response (null, string, number, array)', () => {
    assert.equal(validateAdvisorResponse(null).valid, false);
    assert.equal(validateAdvisorResponse('a string').valid, false);
    assert.equal(validateAdvisorResponse(42).valid, false);
    assert.equal(validateAdvisorResponse([]).valid, false);
  });
  check('rejects an explicit {error} response from the Edge Function, passing the code through', () => {
    const result = validateAdvisorResponse({ error: 'rate_limited' });
    assert.equal(result.valid, false);
    assert.equal(result.error, 'rate_limited');
  });
  check('rejects a response where suggestions is present but not an array', () => {
    assert.equal(validateAdvisorResponse({ message: 'hi', suggestions: 'Finish CS assignment' }).valid, false);
    assert.equal(validateAdvisorResponse({ message: 'hi', suggestions: { title: 'x' } }).valid, false);
  });
});

// ---------------------------------------------------------------------------
scenario('D. Invalid individual suggestions are dropped, not the whole response', () => {
  check('a suggestion missing a title is dropped', () => {
    const result = validateAdvisorResponse({ message: 'ok', suggestions: [{ minutes: 30 }] });
    assert.equal(result.valid, true);
    assert.equal(result.suggestions.length, 0);
  });
  check('a suggestion missing minutes, or with zero/negative minutes, is dropped', () => {
    const result = validateAdvisorResponse({
      message: 'ok',
      suggestions: [{ title: 'x' }, { title: 'y', minutes: 0 }, { title: 'z', minutes: -10 }],
    });
    assert.equal(result.suggestions.length, 0);
  });
  check('a non-object entry in the suggestions array is dropped', () => {
    const result = validateAdvisorResponse({ message: 'ok', suggestions: ['just a string', 42, null] });
    assert.equal(result.suggestions.length, 0);
  });
  check('one valid suggestion survives alongside several invalid ones', () => {
    const result = validateAdvisorResponse({
      message: 'ok',
      suggestions: [{ title: '' }, { title: 'Real task', minutes: 45 }, { minutes: 30 }],
    });
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].title, 'Real task');
  });
  check('an invalid priority falls back to "medium"; an invalid/malformed due date becomes null', () => {
    const result = validateAdvisorResponse({
      message: 'ok',
      suggestions: [{ title: 'x', minutes: 30, priority: 'urgent', dueDate: 'not-a-date' }],
    });
    assert.equal(result.suggestions[0].priority, 'medium');
    assert.equal(result.suggestions[0].dueDate, null);
  });
  check('a well-formed YYYY-MM-DD due date passes through', () => {
    const result = validateAdvisorResponse({ message: 'ok', suggestions: [{ title: 'x', minutes: 30, dueDate: '2026-12-01' }] });
    assert.equal(result.suggestions[0].dueDate, '2026-12-01');
  });
  check('an oversized suggestion list is capped, not rejected outright', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `Task ${i}`, minutes: 30 }));
    const result = validateAdvisorResponse({ message: 'ok', suggestions: many });
    assert.ok(result.suggestions.length <= 10);
  });
});

// ---------------------------------------------------------------------------
scenario('E. Suggestion -> Planner mapping (mapSuggestionToStudyTaskFields)', () => {
  check('title/minutes/priority/dueDate/reason map onto the exact existing study-task field shape', () => {
    const fields = mapSuggestionToStudyTaskFields({
      title: 'Finish CS assignment',
      minutes: 90,
      priority: 'high',
      dueDate: '2026-09-18',
      reason: 'Due tomorrow',
    });
    assert.equal(fields.name, 'Finish CS assignment');
    assert.equal(fields.minutes_requested, 90);
    assert.equal(fields.priority, 'high');
    assert.equal(fields.due_date, '2026-09-18');
    assert.equal(fields.notes, 'Due tomorrow');
  });
  check('the mapped fields pass the existing isStudyTaskFieldsValid check', () => {
    const fields = mapSuggestionToStudyTaskFields({ title: 'Review limits', minutes: 60, priority: 'medium', dueDate: null, reason: '' });
    assert.equal(isStudyTaskFieldsValid(fields), true);
  });
  check('a suggestion with no usable minutes maps to invalid fields (caught before any Planner write)', () => {
    const fields = mapSuggestionToStudyTaskFields({ title: 'x', minutes: null });
    assert.equal(isStudyTaskFieldsValid(fields), false);
  });
  check('reason becomes notes; a missing reason becomes an empty string, not null/undefined', () => {
    assert.equal(mapSuggestionToStudyTaskFields({ title: 'x', minutes: 30 }).notes, '');
  });
});

// ---------------------------------------------------------------------------
scenario('F. Suggestion -> Board mapping (mapSuggestionToBoardNodeTitle)', () => {
  check('the suggestion title becomes the Board node title', () => {
    assert.equal(mapSuggestionToBoardNodeTitle({ title: 'Finish CS assignment' }), 'Finish CS assignment');
  });
  check('a missing/blank title maps to an empty string, never null/undefined (caller treats this as invalid)', () => {
    assert.equal(mapSuggestionToBoardNodeTitle({}), '');
    assert.equal(mapSuggestionToBoardNodeTitle(null), '');
  });
  check('only the title is used — minutes/priority/dueDate/reason are not part of a Board node', () => {
    const title = mapSuggestionToBoardNodeTitle({ title: 'Review limits', minutes: 999, priority: 'high', dueDate: '2099-01-01', reason: 'x' });
    assert.equal(title, 'Review limits');
  });
});

// ---------------------------------------------------------------------------
scenario('G. Selected suggestions only (selectSuggestions)', () => {
  const suggestions = [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }];

  check('only the selected indexes are returned, in their original order', () => {
    assert.deepEqual(selectSuggestions(suggestions, [0, 2]).map((s) => s.title), ['A', 'C']);
  });
  check('an empty selection returns nothing', () => {
    assert.deepEqual(selectSuggestions(suggestions, []), []);
  });
  check('an out-of-range index is silently ignored rather than throwing', () => {
    assert.deepEqual(selectSuggestions(suggestions, [1, 99]).map((s) => s.title), ['B']);
  });
  check('duplicate indexes do not duplicate the result', () => {
    assert.deepEqual(selectSuggestions(suggestions, [0, 0, 0]).map((s) => s.title), ['A']);
  });
});

// ---------------------------------------------------------------------------
scenario('H. Error code -> user-facing message key (advisorErrorMessageKey)', () => {
  check('known failure codes map to their specific message', () => {
    assert.equal(advisorErrorMessageKey('network_error'), 'advisor.networkError');
    assert.equal(advisorErrorMessageKey('rate_limited'), 'advisor.rateLimited');
    assert.equal(advisorErrorMessageKey('provider_error'), 'advisor.providerError');
  });
  check('every other/unknown code collapses to the generic message, never leaking an internal code', () => {
    assert.equal(advisorErrorMessageKey('unauthorized'), 'advisor.genericError');
    assert.equal(advisorErrorMessageKey('not_configured'), 'advisor.genericError');
    assert.equal(advisorErrorMessageKey('malformed'), 'advisor.genericError');
    assert.equal(advisorErrorMessageKey('empty'), 'advisor.genericError');
    assert.equal(advisorErrorMessageKey(undefined), 'advisor.genericError');
  });
});

// ---------------------------------------------------------------------------
// Mocked-provider end-to-end scenarios: each of these stands in for what
// advisorClient.requestAdvisorReply() would have resolved to for a given
// network/provider condition, WITHOUT ever importing that file or making a
// real call — the explicit "mock the provider boundary" requirement. A
// malformed or failed mock response must never reach a Planner/Board
// mapping function.
scenario('I. Mocked provider responses never produce an action payload unless valid', () => {
  function simulateFlow(mockResult) {
    if (!mockResult.ok) {
      return { blocked: true, reason: advisorErrorMessageKey(mockResult.error) };
    }
    const validated = validateAdvisorResponse(mockResult.data);
    if (!validated.valid) {
      return { blocked: true, reason: advisorErrorMessageKey(validated.error) };
    }
    return {
      blocked: false,
      message: validated.message,
      plannerFields: validated.suggestions.map(mapSuggestionToStudyTaskFields),
      boardTitles: validated.suggestions.map(mapSuggestionToBoardNodeTitle),
    };
  }

  check('a successful, well-formed mock response produces mappable Planner and Board data', () => {
    const outcome = simulateFlow({
      ok: true,
      data: { message: 'Here is a plan.', suggestions: [{ title: 'Review limits', minutes: 60, priority: 'high', dueDate: null, reason: 'Exam soon' }] },
    });
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.plannerFields.length, 1);
    assert.equal(outcome.plannerFields[0].name, 'Review limits');
    assert.equal(outcome.boardTitles[0], 'Review limits');
  });
  check('a network failure mock is blocked before any mapping happens', () => {
    const outcome = simulateFlow({ ok: false, error: 'network_error' });
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.reason, 'advisor.networkError');
  });
  check('a rate-limit mock is blocked with the rate-limit message', () => {
    const outcome = simulateFlow({ ok: false, error: 'rate_limited' });
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.reason, 'advisor.rateLimited');
  });
  check('a mock that "succeeded" at the network level but returned invalid JSON/shape is still blocked', () => {
    const outcome = simulateFlow({ ok: true, data: 'not even an object' });
    assert.equal(outcome.blocked, true);
  });
  check('a mock with a completely empty response (no message, no suggestions) is blocked', () => {
    const outcome = simulateFlow({ ok: true, data: {} });
    assert.equal(outcome.blocked, true);
  });
  check('a mock with only garbage suggestions still produces the text message (partial success)', () => {
    const outcome = simulateFlow({ ok: true, data: { message: 'Nothing concrete to suggest right now.', suggestions: [{}, { minutes: 10 }] } });
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.plannerFields.length, 0);
    assert.equal(outcome.message, 'Nothing concrete to suggest right now.');
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
