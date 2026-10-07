// "Plan my backlog" (V4-B.1), pure and deterministic — no AI.
//
// Gives each unscheduled task a day in the coming horizon, using each day's
// free study capacity (daily limit minus what is already planned there,
// from the workload forecast). It only assigns a DAY; the Planner's normal
// Generate then builds the sessions on that day, exactly as for any task.
//
// Order: earliest due date first (undated last), then priority, then larger
// tasks first, then name — so the same backlog always gives the same plan.
// For each task:
//   1. the earliest day (≤ its due date) with enough free time for all of it
//   2. otherwise the day before its due date with the most free time ("tight")
//   3. otherwise it stays unscheduled ("unplaced"), and the student decides.
// Overdue tasks may use any day from today on.

const PRIORITY = { high: 0, medium: 1, low: 2 };

/**
 * @param {object} p
 * @param {Array<{id, name, minutes, dueDate?, priority?}>} p.tasks   unscheduled, not done
 * @param {Array<{date, free}>} p.days    in date order, free = minutes available
 * @param {string} p.today
 * @returns {{ assignments: Array<{taskId, name, date, minutes, tight}>, unplaced: Array<{taskId, name, reason}> }}
 */
export function planBacklog({ tasks = [], days = [], today }) {
  const free = new Map(days.filter((d) => d.date >= today).map((d) => [d.date, Math.max(0, Math.round(d.free || 0))]));
  const dates = [...free.keys()].sort();
  const order = tasks
    .filter((tk) => tk && Number(tk.minutes) > 0)
    .slice()
    .sort((a, b) => String(a.dueDate || '9999-99-99').localeCompare(String(b.dueDate || '9999-99-99'))
      || (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1)
      || Number(b.minutes) - Number(a.minutes)
      || String(a.name).localeCompare(String(b.name)));
  const assignments = [];
  const unplaced = [];
  order.forEach((tk) => {
    const minutes = Math.round(Number(tk.minutes));
    const overdue = tk.dueDate && tk.dueDate < today;
    const candidates = dates.filter((d) => overdue || !tk.dueDate || d <= tk.dueDate);
    if (!candidates.length) {
      unplaced.push({ taskId: tk.id, name: tk.name, reason: 'no_days' });
      return;
    }
    let date = candidates.find((d) => free.get(d) >= minutes);
    let tight = false;
    if (!date) {
      const best = candidates.reduce((acc, d) => (free.get(d) > free.get(acc) ? d : acc), candidates[0]);
      if (free.get(best) <= 0) {
        unplaced.push({ taskId: tk.id, name: tk.name, reason: 'no_room' });
        return;
      }
      date = best;
      tight = true;
    }
    free.set(date, Math.max(0, free.get(date) - minutes));
    assignments.push({ taskId: tk.id, name: tk.name, date, minutes, tight });
  });
  return { assignments, unplaced };
}

/** Free minutes per day from workload forecast days (backlog itself is not counted as taken). */
export function freeDaysFromForecast(forecastDays = []) {
  return forecastDays.map((d) => ({
    date: d.date,
    free: d.blocked ? 0 : Math.max(0, (d.capacity || 0) - (d.studyMinutes || 0) - (d.examPrepMinutes || 0)),
  }));
}
