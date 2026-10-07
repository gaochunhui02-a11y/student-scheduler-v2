// What-if planning (V3-G), pure. A scenario is a set of hypothetical
// changes applied to a COPY of the forecast inputs — real data is never
// touched until the student chooses Apply (and only for scenarios that
// don't make anything worse; see isScenarioSafe).
//
//   blockedDates   "What if I can't study Friday?"
//   dailyMax       "What if my max study time is 3 hours a day?"
//   taskExtra      "What if my CS project takes 2 more hours?"  [{taskId, minutes}]
//   examMoves      "What if the exam moves?"                     [{examId, newDate}]

import { buildWorkloadForecast, summarizeForecast, deadlineRisks } from './workloadModel.js';

export function emptyScenario() {
  return { blockedDates: [], dailyMax: null, taskExtra: [], examMoves: [] };
}

export function scenarioIsEmpty(s) {
  return !s || (!s.blockedDates.length && !s.dailyMax && !s.taskExtra.length && !s.examMoves.length);
}

// Applies a scenario to forecast inputs (returns a new object).
export function applyScenarioToInputs(input, scenario) {
  const extra = new Map((scenario.taskExtra || []).filter((x) => x.taskId && x.minutes).map((x) => [x.taskId, Number(x.minutes)]));
  const moves = new Map((scenario.examMoves || []).filter((x) => x.examId && x.newDate).map((x) => [x.examId, x.newDate]));
  return {
    ...input,
    blockedDates: [...new Set([...(input.blockedDates || []), ...(scenario.blockedDates || [])])],
    dailyMaxOverride: scenario.dailyMax ? Number(scenario.dailyMax) : input.dailyMaxOverride || null,
    groups: (input.groups || []).map((g) => (extra.has(g.id)
      ? { ...g, requestedMinutes: g.requestedMinutes + extra.get(g.id), remainingMinutes: Math.max(0, g.remainingMinutes + extra.get(g.id)), done: g.done && extra.get(g.id) <= 0 }
      : g)),
    exams: (input.exams || []).map((e) => (moves.has(e.id) ? { ...e, exam_date: moves.get(e.id) } : e)),
  };
}

/**
 * Original vs scenario, side by side.
 * @returns {{ before, after, beforeDays, afterDays, risksBefore, risksAfter, newRisks, resolvedRisks, changedDays, safe }}
 */
export function compareScenario(input, scenario) {
  const beforeDays = buildWorkloadForecast(input);
  const scenarioInput = applyScenarioToInputs(input, scenario);
  const afterDays = buildWorkloadForecast(scenarioInput);
  const risksBefore = deadlineRisks(beforeDays, input.groups || [], input.today);
  const risksAfter = deadlineRisks(afterDays, scenarioInput.groups || [], input.today);
  const beforeIds = new Set(risksBefore.map((r) => r.id));
  const afterIds = new Set(risksAfter.map((r) => r.id));
  const changedDays = afterDays
    .map((d, i) => ({ date: d.date, before: beforeDays[i], after: d }))
    .filter((x) => x.before.level !== x.after.level || Math.abs(x.before.studyLoad - x.after.studyLoad) >= 5);
  const before = summarizeForecast(beforeDays);
  const after = summarizeForecast(afterDays);
  const newRisks = risksAfter.filter((r) => !beforeIds.has(r.id));
  return {
    before,
    after,
    beforeDays,
    afterDays,
    risksBefore,
    risksAfter,
    newRisks,
    resolvedRisks: risksBefore.filter((r) => !afterIds.has(r.id)),
    changedDays,
    safe: isScenarioSafe({ newRisks, before, after }),
  };
}

// Safe to apply when it doesn't put any new deadline at risk and doesn't
// add overloaded days. (A scenario can still be explored when unsafe; it
// just can't be applied with one click.)
export function isScenarioSafe({ newRisks, before, after }) {
  return newRisks.length === 0 && after.overloadedDays <= before.overloadedDays;
}
