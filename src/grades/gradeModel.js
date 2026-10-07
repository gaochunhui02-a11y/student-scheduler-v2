// Pure grade math (V3-C). No DOM, no Supabase — every number shown on the
// Grades pages comes from these functions and is unit tested in
// tests/grades.test.js.
//
// Vocabulary (all percentages are 0–100; "share" values are 0–1 fractions
// of the whole course):
//   * category share  = category weight / total weight (weights are scaled
//                       to 100% if they don't add up to exactly 100)
//   * completed share = how much of the course has been graded so far. A
//                       category counts in proportion to the points graded
//                       in it (100 of 350 exam points graded -> 2/7 of the
//                       exam weight is complete). A category with no items
//                       yet is entirely remaining.
//   * secured share   = course points already earned (the floor: your final
//                       grade if you scored 0 on everything left).
//   * CURRENT grade   = weighted average of each category's average on its
//                       graded items, over categories that have grades —
//                       the standard way an LMS reports "grade so far".
//   * PROJECTED grade = final grade if you keep your current average on all
//                       remaining work.
//   * REQUIRED score  = average you need on remaining work to hit a target.
// Ungraded items (earned_points null) are never treated as zero. Items with
// counts = false (practice/optional) are ignored entirely.

const EPS = 1e-9;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {{ categories: Array<{id,name,weight}>, items: Array<{id,category_id,earned_points,possible_points,counts}> }} input
 */
export function computeCourseGrade({ categories = [], items = [] } = {}) {
  const counting = items.filter((i) => i.counts !== false && (num(i.possible_points) || 0) > 0);
  const useCategories = categories.length > 0;
  const categoryIds = new Set(categories.map((c) => c.id));
  const buckets = useCategories
    ? categories.map((c) => ({ id: c.id, name: c.name, weight: Math.max(0, num(c.weight) || 0), items: counting.filter((i) => i.category_id === c.id) }))
    : [{ id: null, name: null, weight: 100, items: counting }];
  const uncategorized = useCategories ? counting.filter((i) => !i.category_id || !categoryIds.has(i.category_id)) : [];
  const totalWeight = buckets.reduce((s, b) => s + b.weight, 0);
  const warnings = [];
  if (useCategories && Math.abs(totalWeight - 100) > 0.01 && totalWeight > 0) warnings.push({ key: 'grades.warnWeightsSum', params: { total: Math.round(totalWeight * 100) / 100 } });
  if (uncategorized.length) warnings.push({ key: 'grades.warnUncategorized', params: { n: uncategorized.length } });

  if (totalWeight <= EPS) {
    return {
      hasWeights: false, categories: [], totalWeight: 0, completedShare: 0, remainingShare: 1, securedShare: 0,
      current: null, projected: null, minFinal: null, maxFinal: null, gradedCount: 0, pendingCount: 0, warnings,
    };
  }

  let completedShare = 0;
  let securedShare = 0;
  let gradedWeightSum = 0;
  let weightedPctSum = 0;
  let gradedCount = 0;
  let pendingCount = 0;
  const out = buckets.map((b) => {
    const share = b.weight / totalWeight;
    const graded = b.items.filter((i) => num(i.earned_points) !== null);
    const pending = b.items.filter((i) => num(i.earned_points) === null);
    const gradedPossible = graded.reduce((s, i) => s + num(i.possible_points), 0);
    const earned = graded.reduce((s, i) => s + num(i.earned_points), 0);
    const pendingPossible = pending.reduce((s, i) => s + num(i.possible_points), 0);
    const totalPossible = gradedPossible + pendingPossible;
    const pct = gradedPossible > 0 ? (earned / gradedPossible) * 100 : null;
    const bucketCompleted = totalPossible > 0 ? share * (gradedPossible / totalPossible) : 0;
    const bucketSecured = totalPossible > 0 ? share * (earned / totalPossible) : 0;
    completedShare += bucketCompleted;
    securedShare += bucketSecured;
    if (pct !== null) {
      gradedWeightSum += share;
      weightedPctSum += share * pct;
    }
    gradedCount += graded.length;
    pendingCount += pending.length;
    return {
      id: b.id, name: b.name, weight: b.weight, share, pct, earned, gradedPossible, pendingPossible, totalPossible,
      gradedCount: graded.length, pendingCount: pending.length, completedShare: bucketCompleted, hasItems: b.items.length > 0,
    };
  });

  const current = gradedWeightSum > EPS ? weightedPctSum / gradedWeightSum : null;
  const remainingShare = Math.max(0, 1 - completedShare);
  // Projection: each remaining item scores its own category's average; a
  // category with nothing graded yet scores the overall current average.
  let projected = null;
  if (current !== null) {
    projected = out.reduce((s, c) => s + c.share * (c.pct !== null ? c.pct : current), 0);
  }
  return {
    hasWeights: true,
    categories: out,
    totalWeight,
    completedShare: clamp01(completedShare),
    remainingShare: clamp01(remainingShare),
    securedShare,
    current,
    projected,
    minFinal: securedShare * 100,
    maxFinal: (securedShare + remainingShare) * 100,
    gradedCount,
    pendingCount,
    warnings,
  };
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

/**
 * Share of the whole course that one pending item is worth.
 */
export function itemShare(item, summary) {
  if (!item || !summary || !summary.hasWeights) return 0;
  const cat = summary.categories.find((c) => c.id === (summary.categories.length === 1 && summary.categories[0].id === null ? null : item.category_id));
  if (!cat || cat.totalPossible <= 0) return 0;
  return cat.share * ((num(item.possible_points) || 0) / cat.totalPossible);
}

function classify(required) {
  if (required <= EPS) return 'secured';
  if (required > 100 + EPS) return 'out_of_reach';
  return 'needed';
}

/**
 * Average score needed on ALL remaining work to finish at `target`.
 * @returns {{status:'no_data'|'complete'|'secured'|'needed'|'out_of_reach', required:number|null, finalIfComplete?:number}}
 */
export function requiredOnRemaining(summary, target) {
  const t = num(target);
  if (!summary || !summary.hasWeights || t === null) return { status: 'no_data', required: null };
  if (summary.remainingShare <= EPS) {
    const final = summary.securedShare * 100;
    return { status: 'complete', required: null, finalIfComplete: final, met: final + EPS >= t };
  }
  const required = (t - summary.securedShare * 100) / summary.remainingShare;
  return { status: classify(required), required };
}

/**
 * Score needed on ONE upcoming piece of work worth `share` of the course
 * (e.g. a 30% final), assuming every other remaining item is scored at
 * your current average. Falls back to requiredOnRemaining when nothing is
 * graded yet (there is no average to assume).
 */
export function requiredOnItem(summary, target, share) {
  const t = num(target);
  const w = num(share);
  if (!summary || !summary.hasWeights || t === null || w === null || w <= EPS) return { status: 'no_data', required: null };
  if (summary.current === null) return { ...requiredOnRemaining(summary, t), assumption: 'uniform' };
  const weight = Math.min(w, summary.remainingShare);
  if (weight <= EPS) return { status: 'no_data', required: null };
  const others = Math.max(0, summary.remainingShare - weight);
  const required = (t - summary.securedShare * 100 - (summary.current * others)) / weight;
  return { status: classify(required), required, assumption: others > EPS ? 'others_at_current' : 'only_item', othersShare: others, itemShare: weight };
}

// Classic single-number calculator used when a course has no item-level
// data: "current grade C over the graded portion, final worth W%".
export function requiredFinalSimple({ current, target, finalWeight }) {
  const c = num(current);
  const t = num(target);
  const w = num(finalWeight);
  if (c === null || t === null || w === null || w <= 0 || w > 100) return { status: 'no_data', required: null };
  const share = w / 100;
  const required = (t - c * (1 - share)) / share;
  return { status: classify(required), required };
}

// Course-list status for a grade vs its target.
export function gradeStatus(summary, target) {
  const t = num(target);
  if (!summary || summary.current === null) return 'no_grades';
  if (t === null) return 'no_target';
  const req = requiredOnRemaining(summary, t);
  if (req.status === 'complete') return req.met ? 'on_track' : 'below_target';
  if (req.status === 'secured') return 'secured';
  if (req.status === 'out_of_reach') return 'out_of_reach';
  return summary.current + EPS >= t ? 'on_track' : 'below_target';
}

export function validateCategoryFields(input = {}) {
  const errors = {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
  if (!name) errors.name = 'grades.errCategoryName';
  const weight = num(input.weight);
  if (weight === null || weight < 0 || weight > 100) errors.weight = 'grades.errWeightRange';
  return { ok: Object.keys(errors).length === 0, errors, fields: { name, weight: weight === null ? 0 : Math.round(weight * 1000) / 1000 } };
}

export function validateGradeItemFields(input = {}) {
  const errors = {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) errors.name = 'grades.errItemName';
  const possible = num(input.possible_points);
  if (possible === null || possible <= 0 || possible > 100000) errors.possible_points = 'grades.errPossible';
  const earned = num(input.earned_points);
  if (earned !== null && (earned < 0 || (possible !== null && earned > possible * 2))) errors.earned_points = 'grades.errEarned';
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    fields: {
      name,
      possible_points: possible,
      earned_points: earned,
      category_id: input.category_id || null,
      due_date: input.due_date || null,
      counts: input.counts !== false,
      notes: typeof input.notes === 'string' ? input.notes.slice(0, 2000) : '',
    },
  };
}

// Quick-start category presets students can pick instead of typing.
export const CATEGORY_PRESETS = [
  { key: 'exams', weight: 40, nameKey: 'grades.presetExams' },
  { key: 'homework', weight: 25, nameKey: 'grades.presetHomework' },
  { key: 'projects', weight: 25, nameKey: 'grades.presetProjects' },
  { key: 'participation', weight: 10, nameKey: 'grades.presetParticipation' },
];
