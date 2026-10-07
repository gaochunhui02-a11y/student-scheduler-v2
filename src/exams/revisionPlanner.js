// Deterministic revision planner (V3-D). No AI, no randomness: the same
// inputs always give the same plan, and every decision has a reason a
// student can read.
//
// How it works, day by day from `today` up to each exam:
//   * capacity(day) = max daily study − study already planned that day −
//     revision already assigned that day (never below 0); a blocked day has
//     0 capacity.
//   * among topics whose exam is still ahead and that still need time, pick
//     the most urgent one:
//         urgency = (remaining minutes ÷ days left before its exam)
//                   × weakness factor × difficulty factor
//     (a weak, hard topic with an exam in 2 days beats a confident one with
//      an exam in 3 weeks). Ties: earlier exam, then topic order, then id.
//   * give it one session (sessionMinutes, or what's left / what fits),
//     at most one session per topic per day while other topics can use the
//     time (spacing), then repeat until the day is full.
// Minutes a topic still needs that can't fit before its exam are reported
// in `unplaced` with the reason — never silently dropped.

import { addDays, diffDays, dateRange } from '../shared/dates.js';

export const WEAKNESS_FACTOR = { 1: 1.6, 2: 1.3, 3: 1.0, 4: 0.8, 5: 0.6 };
export const DIFFICULTY_FACTOR = { 1: 0.85, 2: 1.0, 3: 1.25 };

export function topicRemainingMinutes(topic, extraCompleted = 0) {
  if (!topic || topic.status === 'done') return 0;
  const est = Math.max(0, Number(topic.estimated_minutes) || 0);
  const done = Math.max(0, Number(topic.completed_minutes) || 0) + Math.max(0, extraCompleted || 0);
  return Math.max(0, est - done);
}

function priority(topicState, daysLeft) {
  const weak = WEAKNESS_FACTOR[topicState.confidence] ?? 1;
  const diff = DIFFICULTY_FACTOR[topicState.difficulty] ?? 1;
  return (topicState.remaining / Math.max(1, daysLeft)) * weak * diff;
}

/**
 * @param {object} p
 * @param {string} p.today                     YYYY-MM-DD
 * @param {Array}  p.exams                     [{id, name, exam_date}]
 * @param {Array}  p.topics                    [{id, exam_id, name, difficulty, confidence, estimated_minutes, completed_minutes, status, sort_order}]
 * @param {number} [p.dailyMaxMinutes=240]     the student's max study per day
 * @param {Object} [p.existingLoadByDate={}]   study minutes already planned per date
 * @param {Object} [p.extraCompletedByTopic={}] minutes logged via linked Planner tasks
 * @param {string[]} [p.blockedDates=[]]       days with no revision (e.g. "I can't study Friday")
 * @param {number} [p.sessionMinutes=45]
 * @param {number} [p.minSessionMinutes=20]
 * @param {boolean} [p.includeToday=true]
 */
export function planRevision({
  today,
  exams = [],
  topics = [],
  dailyMaxMinutes = 240,
  existingLoadByDate = {},
  extraCompletedByTopic = {},
  blockedDates = [],
  sessionMinutes = 45,
  minSessionMinutes = 20,
  includeToday = true,
}) {
  const start = includeToday ? today : addDays(today, 1);
  const upcoming = exams.filter((e) => e.exam_date && e.exam_date > today);
  const examById = new Map(upcoming.map((e) => [e.id, e]));
  const blocked = new Set(blockedDates);
  const states = topics
    .filter((tp) => examById.has(tp.exam_id))
    .map((tp) => ({
      id: tp.id,
      examId: tp.exam_id,
      examDate: examById.get(tp.exam_id).exam_date,
      name: tp.name,
      sortOrder: tp.sort_order ?? 0,
      difficulty: tp.difficulty ?? 2,
      confidence: tp.confidence ?? 3,
      needed: topicRemainingMinutes(tp, extraCompletedByTopic[tp.id] || 0),
      remaining: topicRemainingMinutes(tp, extraCompletedByTopic[tp.id] || 0),
    }))
    .filter((s) => s.needed > 0);

  const sessions = [];
  const assignedByDate = {};
  const capacityByDate = {};
  const lastExam = upcoming.reduce((max, e) => (e.exam_date > max ? e.exam_date : max), start);
  const days = dateRange(start, addDays(lastExam, -1));

  days.forEach((day) => {
    const base = blocked.has(day) ? 0 : Math.max(0, dailyMaxMinutes - (existingLoadByDate[day] || 0));
    capacityByDate[day] = base;
    let free = base;
    const usedToday = new Set();
    let guard = 0;
    while (free >= Math.min(minSessionMinutes, 15) && guard < 50) {
      guard += 1;
      const candidates = states.filter((s) => s.remaining > 0 && s.examDate > day);
      if (!candidates.length) break;
      // Prefer topics not yet studied today (spacing); fall back if needed.
      const fresh = candidates.filter((s) => !usedToday.has(s.id));
      const pool = fresh.length ? fresh : candidates;
      pool.sort((a, b) => {
        const pa = priority(a, diffDays(day, a.examDate));
        const pb = priority(b, diffDays(day, b.examDate));
        if (Math.abs(pb - pa) > 1e-9) return pb - pa;
        if (a.examDate !== b.examDate) return a.examDate.localeCompare(b.examDate);
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return String(a.id).localeCompare(String(b.id));
      });
      const pick = pool[0];
      let minutes = Math.min(sessionMinutes, pick.remaining, free);
      // Don't leave a sliver: a session shorter than the minimum only when
      // it finishes the topic.
      if (minutes < minSessionMinutes && minutes < pick.remaining) break;
      minutes = Math.round(minutes);
      if (minutes <= 0) break;
      const last = sessions[sessions.length - 1];
      if (last && last.date === day && last.topicId === pick.id) last.minutes += minutes;
      else sessions.push({ date: day, examId: pick.examId, topicId: pick.id, topicName: pick.name, minutes });
      pick.remaining -= minutes;
      free -= minutes;
      usedToday.add(pick.id);
      assignedByDate[day] = (assignedByDate[day] || 0) + minutes;
    }
  });

  const unplaced = states.filter((s) => s.remaining > 0).map((s) => ({
    topicId: s.id,
    examId: s.examId,
    topicName: s.name,
    minutes: s.remaining,
    reason: diffDays(start, s.examDate) <= 0 ? 'no_days_left' : 'not_enough_time',
  }));

  const perExam = {};
  upcoming.forEach((e) => {
    const ts = states.filter((s) => s.examId === e.id);
    const needed = ts.reduce((sum, s) => sum + s.needed, 0);
    const missing = ts.reduce((sum, s) => sum + s.remaining, 0);
    perExam[e.id] = { needed, planned: needed - missing, unplaced: missing, fits: missing === 0 };
  });

  return { sessions, unplaced, perExam, assignedByDate, capacityByDate };
}

// ---------------------------------------------------------------------------
// Exam helpers
// ---------------------------------------------------------------------------

export function examCountdown(exam, today) {
  if (!exam || !exam.exam_date) return null;
  return diffDays(today, exam.exam_date);
}

/**
 * Revision progress for one exam: minutes done / estimated across topics.
 * Done topics count fully. Returns readiness:
 *   'ready'     every topic done or fully revised
 *   'on_track'  the plan fits before the exam
 *   'behind'    remaining revision can't fit before the exam
 *   'no_topics' nothing to revise listed yet
 *   'past'      the exam date has passed
 */
export function examProgress(exam, topics = [], { today, plan = null, extraCompletedByTopic = {} } = {}) {
  const list = topics.filter((tp) => tp.exam_id === exam.id);
  const estimated = list.reduce((s, tp) => s + Math.max(0, Number(tp.estimated_minutes) || 0), 0);
  const completed = list.reduce((s, tp) => {
    const est = Math.max(0, Number(tp.estimated_minutes) || 0);
    if (tp.status === 'done') return s + est;
    return s + Math.min(est, Math.max(0, Number(tp.completed_minutes) || 0) + (extraCompletedByTopic[tp.id] || 0));
  }, 0);
  const remainingTopics = list.filter((tp) => topicRemainingMinutes(tp, extraCompletedByTopic[tp.id] || 0) > 0).length;
  let readiness;
  if (today && exam.exam_date < today) readiness = 'past';
  else if (!list.length) readiness = 'no_topics';
  else if (remainingTopics === 0) readiness = 'ready';
  else if (plan && plan.perExam[exam.id] && !plan.perExam[exam.id].fits) readiness = 'behind';
  else readiness = 'on_track';
  return { estimated, completed, fraction: estimated ? completed / estimated : 0, topicCount: list.length, remainingTopics, readiness };
}

export function validateExamFields(input = {}) {
  const errors = {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) errors.name = 'exams.errName';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.exam_date || '')) errors.exam_date = 'exams.errDate';
  const weight = input.weight === '' || input.weight === null || input.weight === undefined ? null : Number(input.weight);
  if (weight !== null && (!Number.isFinite(weight) || weight < 0 || weight > 100)) errors.weight = 'exams.errWeight';
  const duration = input.duration_minutes === '' || input.duration_minutes === null || input.duration_minutes === undefined ? null : Number(input.duration_minutes);
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0 || duration > 720)) errors.duration_minutes = 'exams.errDuration';
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    fields: {
      name,
      exam_date: input.exam_date,
      start_time: input.start_time || null,
      duration_minutes: duration === null ? null : Math.round(duration),
      location: typeof input.location === 'string' && input.location.trim() ? input.location.trim().slice(0, 120) : null,
      weight,
      notes: typeof input.notes === 'string' ? input.notes.slice(0, 5000) : '',
      course_id: input.course_id || null,
    },
  };
}

export function validateTopicFields(input = {}) {
  const errors = {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) errors.name = 'exams.errTopicName';
  const est = Number(input.estimated_minutes);
  if (!Number.isFinite(est) || est <= 0 || est > 6000) errors.estimated_minutes = 'exams.errEstimate';
  const done = input.completed_minutes === '' || input.completed_minutes === undefined ? 0 : Number(input.completed_minutes);
  if (!Number.isFinite(done) || done < 0 || done > 20000) errors.completed_minutes = 'exams.errCompleted';
  const clampInt = (v, lo, hi, fallback) => {
    const n = Number(v);
    if (v === '' || v === null || v === undefined || !Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  const difficulty = clampInt(input.difficulty, 1, 3, 2);
  const confidence = clampInt(input.confidence, 1, 5, 3);
  const estimated = Number.isFinite(est) ? Math.round(est) : 60;
  const completed = Number.isFinite(done) ? Math.round(done) : 0;
  let status = ['not_started', 'in_progress', 'done'].includes(input.status) ? input.status : null;
  if (!status) status = completed >= estimated ? 'done' : completed > 0 ? 'in_progress' : 'not_started';
  return { ok: Object.keys(errors).length === 0, errors, fields: { name, difficulty, confidence, estimated_minutes: estimated, completed_minutes: completed, status } };
}

// Status after logging more revision minutes on a topic.
export function topicStatusAfterLog(topic, addMinutes) {
  const completed = Math.max(0, (Number(topic.completed_minutes) || 0) + addMinutes);
  const est = Number(topic.estimated_minutes) || 0;
  return { completed_minutes: completed, status: completed >= est ? 'done' : completed > 0 ? 'in_progress' : 'not_started' };
}
