// Estimate accuracy (V3-K), pure and deterministic. Compares how long
// finished tasks were ESTIMATED to take with how long they ACTUALLY took,
// using only real timing data:
//   * the task's own "actual time spent" field (actual_minutes), or
//   * the sum of its Focus Mode sessions (focus_sessions.actual_minutes)
// Block completion alone is NOT used — marking a block Done says nothing
// about how long it really took.
//
// A statement is only made when there are at least MIN_SAMPLES finished,
// timed tasks for that course (and overall) — never from one or two.

export const MIN_SAMPLES = 5;
const ACCURATE_RATIO = 0.1; // within ±10% reads as "accurate"

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {object} p
 * @param {Array} p.groups    task groups (taskModel) — uses id, rowIds, done, requestedMinutes, actualMinutes, courseId, name
 * @param {Array} p.sessions  focus_sessions rows (task_id, actual_minutes)
 * @param {number} [p.minSamples]
 * @returns {{ samples:Array, byCourse:Array<{courseId, n, ratio, medianError, enough, verdict}>, overall:{n, ratio, medianError, enough, verdict} }}
 */
export function computeEstimateAccuracy({ groups = [], sessions = [], minSamples = MIN_SAMPLES }) {
  const focusedByRow = new Map();
  sessions.forEach((s) => {
    if (!s.task_id) return;
    focusedByRow.set(s.task_id, (focusedByRow.get(s.task_id) || 0) + (Number(s.actual_minutes) || 0));
  });
  const samples = groups
    .filter((g) => g.done && g.requestedMinutes > 0)
    .map((g) => {
      const focused = g.rowIds.reduce((sum, id) => sum + (focusedByRow.get(id) || 0), 0);
      const actual = Number.isFinite(g.actualMinutes) && g.actualMinutes > 0 ? g.actualMinutes : focused > 0 ? focused : null;
      return actual === null ? null : { id: g.id, name: g.name, courseId: g.courseId || null, estimate: g.requestedMinutes, actual, ratio: actual / g.requestedMinutes, error: actual - g.requestedMinutes };
    })
    .filter(Boolean);

  function summarize(list) {
    const n = list.length;
    const enough = n >= minSamples;
    const totalEst = list.reduce((s, x) => s + x.estimate, 0);
    const totalAct = list.reduce((s, x) => s + x.actual, 0);
    const ratio = totalEst > 0 ? totalAct / totalEst : null;
    const medianError = median(list.map((x) => Math.abs(x.error)));
    let verdict = 'not_enough';
    if (enough && ratio !== null) {
      if (ratio > 1 + ACCURATE_RATIO) verdict = 'under'; // tasks take longer than estimated
      else if (ratio < 1 - ACCURATE_RATIO) verdict = 'over'; // tasks take less time than estimated
      else verdict = 'accurate';
    }
    return { n, ratio, medianError, enough, verdict, percent: ratio === null ? null : Math.round(Math.abs(ratio - 1) * 100) };
  }

  const courseIds = [...new Set(samples.map((x) => x.courseId))];
  const byCourse = courseIds
    .map((courseId) => ({ courseId, ...summarize(samples.filter((x) => x.courseId === courseId)) }))
    .sort((a, b) => b.n - a.n || String(a.courseId).localeCompare(String(b.courseId)));
  return { samples, byCourse, overall: summarize(samples), minSamples };
}

// The statement for one summary as { key, params } (null when there isn't
// enough data — the UI says so instead of guessing).
export function estimateStatement(summary, courseLabel) {
  if (!summary || !summary.enough) return null;
  const params = { course: courseLabel, pct: summary.percent, min: Math.max(1, Math.round(summary.medianError || 0)), n: summary.n };
  if (summary.verdict === 'under') return { key: courseLabel ? 'insights3.estUnderCourse' : 'insights3.estUnder', params };
  if (summary.verdict === 'over') return { key: courseLabel ? 'insights3.estOverCourse' : 'insights3.estOver', params };
  return { key: courseLabel ? 'insights3.estAccurateCourse' : 'insights3.estAccurate', params };
}
