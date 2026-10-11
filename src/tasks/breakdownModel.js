// Assignment breakdown (V4-G), pure and deterministic — no AI.
//
// Splits a big piece of work into named steps with a share of the time and
// a staggered "be done by" date between today and the due date, from a
// small set of templates students actually use. The student previews and
// can untick steps before anything is created. The LAST step is the task
// itself (it keeps its own due date), so total time is conserved.

import { addDays, diffDays } from '../shared/dates.js';

// shares sum to 1; step keys are translated in the UI (breakdown.step_<key>)
export const BREAKDOWN_TEMPLATES = {
  essay: [['research', 0.2], ['outline', 0.1], ['draft', 0.35], ['revise', 0.2], ['finalize', 0.15]],
  lab: [['prelab', 0.15], ['data', 0.25], ['analysis', 0.25], ['writeup', 0.25], ['finalize', 0.1]],
  problems: [['review', 0.15], ['firstHalf', 0.35], ['secondHalf', 0.35], ['check', 0.15]],
  presentation: [['research', 0.25], ['slides', 0.35], ['rehearse', 0.25], ['finalize', 0.15]],
  project: [['plan', 0.15], ['build', 0.45], ['test', 0.2], ['finalize', 0.2]],
  exam: [['summarize', 0.3], ['practice', 0.4], ['weakSpots', 0.2], ['finalReview', 0.1]],
  reading: [['firstHalf', 0.45], ['secondHalf', 0.45], ['notes', 0.1]],
};
export const TEMPLATE_IDS = Object.keys(BREAKDOWN_TEMPLATES);

const roundTo5 = (n) => Math.max(5, Math.round(n / 5) * 5);

/**
 * Suggests a template from the task name (English + common zh/ja words).
 */
export function suggestTemplate(name = '') {
  const s = String(name).toLowerCase();
  if (/\blab\b|实验|実験/.test(s)) return 'lab';
  if (/essay|paper|report|论文|作文|レポート|小論文/.test(s)) return 'essay';
  if (/problem|exercise|homework|pset|习题|作业|問題|宿題/.test(s)) return 'problems';
  if (/presentation|slides|talk|pitch|演讲|汇报|発表|プレゼン/.test(s)) return 'presentation';
  if (/exam|midterm|final|quiz|test|考试|期中|期末|試験|テスト/.test(s)) return 'exam';
  if (/read|chapter|阅读|章|読/.test(s)) return 'reading';
  return 'project';
}

/**
 * @param {object} p
 * @param {number} p.totalMinutes   time the task asks for
 * @param {string|null} p.dueDate
 * @param {string} p.today
 * @param {string} p.template       key of BREAKDOWN_TEMPLATES
 * @returns {Array<{ key, minutes, dueDate|null, isLast }>}
 */
export function buildBreakdown({ totalMinutes, dueDate = null, today, template = 'project' }) {
  const steps = BREAKDOWN_TEMPLATES[template] || BREAKDOWN_TEMPLATES.project;
  const total = Math.max(steps.length * 5, Math.round(Number(totalMinutes) || 0));
  const minutes = steps.map(([, share]) => roundTo5(total * share));
  // Put rounding drift on the biggest step so the total is exact.
  const drift = total - minutes.reduce((s, m) => s + m, 0);
  const big = minutes.indexOf(Math.max(...minutes));
  minutes[big] = Math.max(5, minutes[big] + drift);
  const span = dueDate && dueDate >= today ? diffDays(today, dueDate) : null;
  let cumulative = 0;
  return steps.map(([key, share], i) => {
    cumulative += share;
    const isLast = i === steps.length - 1;
    let date = null;
    if (span !== null) date = isLast ? dueDate : addDays(today, Math.max(0, Math.min(span, Math.round(span * cumulative) - (span >= steps.length ? 1 : 0))));
    return { key, minutes: minutes[i], dueDate: date, isLast };
  });
}

/** Can the original task become the last step (no study done on it yet)? */
export function canReuseOriginal(group) {
  return Boolean(group) && !group.done && (group.completedMinutes || 0) === 0 && (group.blocks || []).length === 0 && (group.rows || []).length <= 1;
}
