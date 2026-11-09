// Deadline planner (V5), pure and deterministic — no AI, no DOM, no I/O.
//
// Spreads the remaining work of tasks across days before their due dates,
// using each day's free study capacity (daily target minus what is already
// planned or locked there — the caller computes it from real data, e.g. the
// workload forecast). It extends "Plan my backlog" (backlogPlanner.js) by
// SPLITTING a task over several days when it doesn't fit in one, which is
// what a multi-week assignment needs. It only proposes; nothing is written.
//
// Rules (each one is asserted in tests/deadline-planner.test.js):
//   * Order: earliest due date first (undated last), then priority, then
//     larger tasks, then name — earliest-deadline-first is what keeps the
//     most deadlines feasible.
//   * Each task fills the earliest days with room, strictly BEFORE its due
//     date; the due date itself is used only if that is not enough
//     ("tight"). Overdue tasks may use any day from the start date ("late").
//   * Parts are at least `minChunk` minutes (unless less work remains), so
//     the plan never produces 5-minute fragments.
//   * A day never receives more than its free capacity. What doesn't fit is
//     reported as `shortBy` — never dropped silently, never duplicated:
//     planned + shortBy === minutes for every task.
//   * Every number in an explanation comes from the inputs.

const PRIORITY = { high: 0, medium: 1, low: 2 };

function prevDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * @param {object} p
 * @param {Array<{id, name, minutes, dueDate?, priority?}>} p.tasks  remaining minutes per task
 * @param {Array<{date, free}>} p.days   free minutes per day (any order)
 * @param {string} p.start               first day that may be used (YYYY-MM-DD)
 * @param {number} [p.minChunk=30]
 * @returns {{
 *   assignments: Array<{taskId, name, date, minutes, tight, late, dayFree}>,
 *   tasks: Array<{taskId, name, minutes, dueDate, planned, shortBy, parts, freeBeforeDue, firstDate, lastDate, tight, late}>,
 *   freeLeft: Map<string, number>,
 * }}
 */
export function planDeadlines({ tasks = [], days = [], start, minChunk = 30 }) {
  const free = new Map();
  days.filter((d) => d && d.date >= start).forEach((d) => free.set(d.date, Math.max(0, Math.round(Number(d.free) || 0))));
  const dates = [...free.keys()].sort();
  const originalFree = new Map(free);
  const order = tasks
    .filter((tk) => tk && Math.round(Number(tk.minutes)) > 0)
    .slice()
    .sort((a, b) => String(a.dueDate || '9999-99-99').localeCompare(String(b.dueDate || '9999-99-99'))
      || (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1)
      || Number(b.minutes) - Number(a.minutes)
      || String(a.name).localeCompare(String(b.name))
      || String(a.id).localeCompare(String(b.id)));

  const assignments = [];
  const summaries = [];
  order.forEach((tk) => {
    const minutes = Math.round(Number(tk.minutes));
    const due = tk.dueDate || null;
    const late = Boolean(due && due < start);
    // Days strictly before the due date (any day when undated or already late).
    const before = dates.filter((d) => late || !due || d <= prevDay(due));
    const dueDay = !late && due && free.has(due) ? [due] : [];
    const freeBeforeDue = before.reduce((s, d) => s + (originalFree.get(d) || 0), 0);
    let left = minutes;
    const parts = [];
    const add = (d, m, tight, dayFree) => {
      const same = parts.find((x) => x.date === d);
      if (same) same.minutes += m;
      else parts.push({ taskId: tk.id, name: tk.name, date: d, minutes: m, tight, late, dayFree });
      free.set(d, (free.get(d) || 0) - m);
      left -= m;
    };
    // strict: parts of at least minChunk, and no remainder under minChunk
    // left for later days. The relaxed pass then places whatever is still
    // left in any room at all, so avoiding fragments never costs coverage.
    const take = (list, tight, strict) => {
      for (const d of list) {
        if (left <= 0) break;
        const room = free.get(d) || 0;
        const need = strict ? Math.min(minChunk, left) : 1;
        if (room < need) continue;
        let m = Math.min(room, left);
        const rest = left - m;
        if (strict && rest > 0 && rest < minChunk && m - (minChunk - rest) >= minChunk) m -= minChunk - rest;
        add(d, m, tight, room);
      }
    };
    take(before, false, true);
    if (left > 0) take(before, false, false);
    if (left > 0 && dueDay.length) take(dueDay, true, true);
    if (left > 0 && dueDay.length) take(dueDay, true, false);
    parts.sort((a, b) => a.date.localeCompare(b.date));
    assignments.push(...parts);
    summaries.push({
      taskId: tk.id,
      name: tk.name,
      minutes,
      dueDate: due,
      planned: minutes - left,
      shortBy: left,
      parts: parts.length,
      freeBeforeDue,
      firstDate: parts.length ? parts[0].date : null,
      lastDate: parts.length ? parts[parts.length - 1].date : null,
      tight: parts.some((p) => p.tight),
      late,
    });
  });
  assignments.sort((a, b) => a.date.localeCompare(b.date) || String(a.name).localeCompare(String(b.name)));
  return { assignments, tasks: summaries, freeLeft: free };
}

/** Assignments grouped by day, in date order: [{ date, minutes, items }]. */
export function groupByDay(assignments = []) {
  const map = new Map();
  assignments.forEach((a) => {
    if (!map.has(a.date)) map.set(a.date, { date: a.date, minutes: 0, items: [] });
    const day = map.get(a.date);
    day.minutes += a.minutes;
    day.items.push(a);
  });
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Plain facts that explain a task's plan, for UI copy. Never invents
 * anything: every value is taken from the plan summary.
 * @returns {Array<{ key: string, params: object }>}
 *   keys: 'dueIn' | 'remaining' | 'split' | 'tight' | 'short' | 'late' | 'fits'
 */
export function explainTask(summary) {
  if (!summary) return [];
  const facts = [];
  if (summary.dueDate) facts.push({ key: summary.late ? 'late' : 'dueIn', params: { date: summary.dueDate } });
  facts.push({ key: 'remaining', params: { minutes: summary.minutes } });
  if (summary.parts > 1) facts.push({ key: 'split', params: { parts: summary.parts, first: summary.firstDate, last: summary.lastDate } });
  if (summary.shortBy > 0) facts.push({ key: 'short', params: { minutes: summary.shortBy, free: summary.freeBeforeDue } });
  else if (summary.tight) facts.push({ key: 'tight', params: { date: summary.dueDate } });
  else if (summary.dueDate && !summary.late) facts.push({ key: 'fits', params: { free: summary.freeBeforeDue } });
  return facts;
}

/** Uniform free days (onboarding: no history yet, just the daily target). */
export function uniformDays(start, count, minutesPerDay, { skipWeekdays = [] } = {}) {
  const out = [];
  const [y, m, d] = start.split('-').map(Number);
  for (let i = 0; i < count; i += 1) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const date = dt.toISOString().slice(0, 10);
    out.push({ date, free: skipWeekdays.includes(dt.getUTCDay()) ? 0 : minutesPerDay });
  }
  return out;
}

/**
 * The plan as it will be saved when work doesn't fit: each task's shortfall
 * is added to its last planned day (or `fallbackDate` when nothing fit), so
 * the full estimate is kept and the overflow is visible ("over by") instead
 * of silently dropped.
 * @returns {Array<assignment & { overBy: number }>}
 */
export function withShortfall(plan, fallbackDate) {
  const out = plan.assignments.map((a) => ({ ...a, overBy: 0 }));
  plan.tasks.forEach((s) => {
    if (s.shortBy <= 0) return;
    const parts = out.filter((a) => a.taskId === s.taskId);
    const last = parts[parts.length - 1];
    if (last) {
      last.minutes += s.shortBy;
      last.overBy = s.shortBy;
    } else {
      out.push({ taskId: s.taskId, name: s.name, date: fallbackDate, minutes: s.shortBy, tight: true, late: s.late, dayFree: 0, overBy: s.shortBy });
    }
  });
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.name).localeCompare(String(b.name)));
}
