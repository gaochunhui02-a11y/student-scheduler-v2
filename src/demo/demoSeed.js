// Sample data for Demo Mode. Everything is generated relative to "today"
// so every page (Dashboard, Courses, Grades, Exams, Semester, Week,
// Calendar, Insights, Board) has something realistic to show whenever a
// visitor opens the demo. Deterministic for a given date: same ids, same
// numbers.
//
// This data only ever lives inside the in-memory demo client
// (memoryClient.js) — it is never sent to Supabase.

import { todayStr, addDays, dayOfWeek, startOfWeek, dateRange } from '../shared/dates.js';

export const DEMO_USER_ID = '00000000-0000-4000-8000-00000000d3e0';
export const DEMO_EMAIL = 'demo@student-scheduler.app';

function makeIds() {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
}

const COURSE_DEFS = [
  { key: 'math', name: 'Calculus II', code: 'MATH 152', instructor: 'Dr. Ana Ruiz', color: '#3b6fe0', location: 'Hall B 204', target: 90, credits: 4 },
  { key: 'cs', name: 'Intro to Computer Science', code: 'CS 101', instructor: 'Prof. Sam Okafor', color: '#0f9488', location: 'Engineering 110', target: 92, credits: 4 },
  { key: 'chem', name: 'General Chemistry', code: 'CHEM 110', instructor: 'Dr. Lee Park', color: '#c27c0a', location: 'Science Center 3', target: 85, credits: 4 },
  { key: 'hist', name: 'Modern World History', code: 'HIST 210', instructor: 'Prof. Iris Novak', color: '#d9466b', location: 'Humanities 12', target: 88, credits: 3 },
  { key: 'bio', name: 'Cell Biology', code: 'BIO 120', instructor: 'Dr. Priya Shah', color: '#2f9e57', location: 'Life Sciences 140', target: null, credits: 3 },
];

// Weekly meetings (0 = Sunday).
const MEETINGS = {
  math: { days: [1, 3, 5], start: '09:00', end: '09:50', label: 'Calculus II lecture' },
  cs: { days: [2, 4], start: '10:30', end: '11:45', label: 'CS 101 lecture' },
  chem: { days: [1, 3], start: '13:00', end: '14:15', label: 'Chemistry lecture' },
  hist: { days: [2, 4], start: '14:00', end: '15:15', label: 'History seminar' },
  bio: { days: [5], start: '13:00', end: '15:00', label: 'Biology lab' },
};

function clockMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function buildDemoSeed(now = new Date()) {
  const id = makeIds();
  const U = DEMO_USER_ID;
  const today = todayStr(now);
  const ts = now.toISOString();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const db = {
    profiles: [{ id: U, name: 'Jordan', created_at: ts, updated_at: ts, onboarding_completed_at: ts, preferences: { maxDailyStudyMinutes: 240 } }],
    schedules: [], classes: [], study_subjects: [], schedule_items: [], study_subject_subtasks: [],
    class_series: [], class_series_exceptions: [], boards: [], board_nodes: [], board_edges: [],
    spaces: [], projects: [], project_milestones: [], semesters: [], courses: [], grade_categories: [], grade_items: [], exams: [], exam_topics: [],
    task_dependencies: [], task_recurrence_rules: [], resources: [], focus_sessions: [],
  };

  // ---------------- semester ----------------
  const semStart = startOfWeek(addDays(today, -49));
  const semEnd = addDays(semStart, 16 * 7 - 3); // 16 weeks, ending on a Friday
  const breakStart = addDays(semStart, 10 * 7 + 2);
  const semester = {
    id: id(), user_id: U, name: 'Fall 2026', start_date: semStart, end_date: semEnd, is_current: true,
    breaks: [{ name: 'Mid-semester break', start_date: breakStart, end_date: addDays(breakStart, 4) }],
    created_at: ts, updated_at: ts,
  };
  db.semesters.push(semester);
  db.semesters.push({
    id: id(), user_id: U, name: 'Spring 2026', start_date: addDays(semStart, -7 * 30), end_date: addDays(semStart, -7 * 14), is_current: false, breaks: [], created_at: ts, updated_at: ts,
  });

  // ---------------- spaces (V4) ----------------
  const schoolSpace = { id: id(), user_id: U, name: 'School', icon: 'school', color: '#3b6fe0', archived: false, sort_order: 0, created_at: ts, updated_at: ts };
  db.spaces.push(schoolSpace);
  const personalSpace = { id: id(), user_id: U, name: 'Personal', icon: 'home', color: '#d9466b', archived: false, sort_order: 1, created_at: ts, updated_at: ts };
  db.spaces.push(personalSpace);

  // ---------------- courses + weekly classes ----------------
  const course = {};
  COURSE_DEFS.forEach((c, i) => {
    const row = {
      id: id(), user_id: U, semester_id: semester.id, name: c.name, code: c.code, instructor: c.instructor, color: c.color,
      location: c.location, notes: '', target_grade: c.target, credits: c.credits, archived: false, sort_order: i, created_at: ts, updated_at: ts, space_id: schoolSpace.id,
    };
    db.courses.push(row);
    course[c.key] = row;
    const m = MEETINGS[c.key];
    db.class_series.push({
      id: id(), user_id: U, name: m.label, days_of_week: m.days, start_time: m.start, end_time: m.end,
      start_date: semStart, end_date: semEnd, course_id: row.id, created_at: ts, updated_at: ts,
    });
  });
  // A cancelled lecture last week, so exceptions show up too.
  const mathSeries = db.class_series[0];
  const lastWeekWed = addDays(startOfWeek(today), -5);
  db.class_series_exceptions.push({ id: id(), series_id: mathSeries.id, user_id: U, exception_date: lastWeekWed, action: 'skip', override_name: null, override_start_time: null, override_end_time: null, created_at: ts });

  function meetingsOn(date) {
    if (date === lastWeekWed) return COURSE_DEFS.filter((c) => c.key !== 'math' && MEETINGS[c.key].days.includes(dayOfWeek(date)));
    return COURSE_DEFS.filter((c) => MEETINGS[c.key].days.includes(dayOfWeek(date)));
  }

  // ---------------- days: schedules, tasks, generated blocks ----------------
  const scheduleByDate = {};
  function sched(date) {
    if (scheduleByDate[date]) return scheduleByDate[date];
    const s = {
      id: id(), user_id: U, for_date: date, wake_time: '07:00:00', sleep_time: '23:00:00', breakfast_on: true, breakfast_time: '08:00:00',
      lunch_on: true, lunch_time: '12:15:00', dinner_on: true, dinner_time: '18:30:00', session_cap_minutes: 60, stamina_break_minutes: 15,
      switch_break_minutes: 10, min_block_minutes: 30, preferred_study_period: 'none', earliest_study_time: null, latest_study_time: null,
      max_daily_study_minutes: 240, created_at: ts, updated_at: ts,
    };
    db.schedules.push(s);
    scheduleByDate[date] = s;
    return s;
  }
  function task(date, name, minutes, extra = {}) {
    const s = sched(date);
    const row = {
      id: id(), schedule_id: s.id, user_id: U, name, minutes_requested: minutes, priority: 'medium', due_date: null, notes: '', tags: [],
      origin_subject_id: null, sort_order: db.study_subjects.filter((x) => x.schedule_id === s.id).length, course_id: null, actual_minutes: null,
      completed_at: null, dependency_override: false, exam_topic_id: null, recurrence_rule_id: null, recurrence_date: null, ...extra,
    };
    db.study_subjects.push(row);
    return row;
  }
  function block(date, type, name, start, end, extra = {}) {
    const s = sched(date);
    const row = {
      id: id(), schedule_id: s.id, user_id: U, item_type: type, name, start_minutes: start, end_minutes: end,
      sort_order: db.schedule_items.filter((x) => x.schedule_id === s.id).length, locked: false, completed: false, completed_minutes: 0,
      missed: false, carried_over_minutes: 0, source_subject_id: null, ...extra,
    };
    db.schedule_items.push(row);
    return row;
  }
  // First start >= `from` where `minutes` fits without touching any block
  // already on that day (classes, meals, other study) — keeps the demo
  // free of fake conflicts whatever weekday "today" happens to be.
  function freeSlot(date, from, minutes, extraBusy = []) {
    const s = sched(date);
    const busy = db.schedule_items
      .filter((b) => b.schedule_id === s.id && b.item_type !== 'free')
      .map((b) => [b.start_minutes, b.end_minutes])
      .concat(extraBusy)
      .sort((a, b) => a[0] - b[0]);
    let start = from;
    for (let guard = 0; guard < 50; guard += 1) {
      const clash = busy.find(([bs, be]) => start < be + 5 && start + minutes > bs - 5);
      if (!clash) return start;
      start = clash[1] + 10;
    }
    return start;
  }
  function dayFrame(date) {
    meetingsOn(date).forEach((c) => {
      const m = MEETINGS[c.key];
      block(date, 'class', m.label, clockMin(m.start), clockMin(m.end));
    });
    block(date, 'meal', 'Breakfast', 480, 510);
    block(date, 'meal', 'Lunch', 735, 780);
    block(date, 'meal', 'Dinner', 1110, 1155);
  }

  // Past two weeks: realistic mix of done / partial / missed study, with
  // focus sessions logged for the finished ones (feeds estimate accuracy).
  const pastPlan = [
    // [offset, courseKey, name, minutes, outcome, actual]
    [-14, 'math', 'Problem set 3', 90, 'done', 95],
    [-13, 'cs', 'Lab 4: loops', 60, 'done', 75],
    [-13, 'chem', 'Stoichiometry practice', 60, 'done', 55],
    [-12, 'hist', 'Reading: Chapter 6', 45, 'done', 50],
    [-12, 'math', 'Quiz 2 review', 60, 'done', 60],
    [-11, 'cs', 'Lab 5: functions', 60, 'done', 70],
    [-11, 'bio', 'Lab prep: microscopy', 45, 'missed', 0],
    [-10, 'math', 'Problem set 4', 90, 'done', 85],
    [-9, 'cs', 'Project 2: research APIs', 90, 'done', 110],
    [-9, 'chem', 'Lab report 2', 120, 'partial', 70],
    [-8, 'hist', 'Reading: Chapter 7', 45, 'done', 40],
    [-7, 'math', 'Midterm 1 corrections', 45, 'done', 50],
    [-6, 'cs', 'Lab 6: lists', 60, 'done', 72],
    [-6, 'bio', 'Cell cycle notes', 60, 'done', 65],
    [-5, 'math', 'Problem set 5 (part 1)', 60, 'done', 58],
    [-5, 'cs', 'Project 2: outline design', 60, 'done', 70],
    [-4, 'chem', 'Equilibrium practice', 60, 'missed', 0],
    [-4, 'hist', 'Reading: Chapter 8', 45, 'done', 45],
    [-3, 'cs', 'Lab 7: dictionaries', 60, 'done', 68],
    [-3, 'math', 'Series warm-up', 45, 'done', 40],
    [-2, 'bio', 'Membrane transport review', 60, 'partial', 30],
    [-2, 'math', 'Problem set 5 (part 2)', 60, 'done', 66],
    [-1, 'chem', 'Titration pre-lab', 45, 'done', 50],
    [-1, 'cs', 'Lab 8: recursion', 60, 'done', 74],
  ];
  const pastTaskByName = {};
  const dayCursor = {};
  pastPlan.forEach(([offset, key, name, minutes, outcome, actual]) => {
    const date = addDays(today, offset);
    if (!scheduleByDate[date]) dayFrame(date);
    const start = freeSlot(date, dayCursor[date] || (dayOfWeek(date) % 2 ? 960 : 930), minutes);
    const end = start + minutes;
    dayCursor[date] = end + 20;
    const tk = task(date, name, minutes, {
      course_id: course[key].id,
      due_date: date,
      priority: minutes >= 90 ? 'high' : 'medium',
      completed_at: outcome === 'done' ? `${date}T${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}:00` : null,
      actual_minutes: outcome === 'done' ? actual : null,
      tags: name.startsWith('Reading') ? ['Reading'] : name.startsWith('Lab') ? ['Lab'] : ['Homework'],
    });
    pastTaskByName[name] = tk;
    const blk = block(date, 'study', name, start, end, {
      source_subject_id: tk.id,
      completed: outcome === 'done',
      completed_minutes: outcome === 'done' ? minutes : outcome === 'partial' ? actual : 0,
      missed: outcome === 'missed',
    });
    if (actual > 0) {
      const startedAt = new Date(`${date}T00:00:00`);
      startedAt.setMinutes(start);
      const endedAt = new Date(startedAt.getTime() + actual * 60000);
      db.focus_sessions.push({
        id: id(), user_id: U, schedule_item_id: blk.id, task_id: tk.id, course_id: course[key].id,
        started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(), planned_minutes: minutes, actual_minutes: actual,
        outcome: outcome === 'done' ? (actual < minutes ? 'finished_early' : 'completed') : 'stopped',
        notes: name.includes('Lab') ? 'Got stuck on an edge case for a while.' : '', created_at: endedAt.toISOString(),
      });
    }
  });
  // One past task carried over to today.
  const carried = db.schedule_items.find((b) => b.name === 'Lab report 2');
  if (carried) carried.carried_over_minutes = 50;

  // ---------------- today ----------------
  const morning = nowMin >= 8 * 60 && nowMin <= 20 * 60;
  const t0 = morning ? nowMin : 15 * 60; // anchor blocks around "now" in the daytime
  dayFrame(today);
  const todaySchedule = sched(today);
  todaySchedule.updated_at = new Date(now.getTime() + 1000).toISOString(); // Planner opens on today

  const draft = task(today, 'Project 2: draft implementation', 120, { course_id: course.cs.id, due_date: addDays(today, 2), priority: 'high', tags: ['Project'] });
  const hw = task(today, 'Problem set 6', 90, { course_id: course.math.id, due_date: addDays(today, 3), priority: 'high', tags: ['Homework'] });
  const labRest = task(today, 'Lab report 2 (finish)', 50, { course_id: course.chem.id, due_date: addDays(today, 1), priority: 'high', tags: ['Lab'], origin_subject_id: pastTaskByName['Lab report 2'] ? pastTaskByName['Lab report 2'].id : null });
  db.study_subject_subtasks.push(
    { id: id(), subject_id: draft.id, user_id: U, title: 'Parse the API response', completed: true, sort_order: 0, created_at: ts, updated_at: ts },
    { id: id(), subject_id: draft.id, user_id: U, title: 'Write the caching layer', completed: false, sort_order: 1, created_at: ts, updated_at: ts },
    { id: id(), subject_id: draft.id, user_id: U, title: 'Handle errors', completed: false, sort_order: 2, created_at: ts, updated_at: ts },
  );
  // Two one-off events on today's planner (an imported appointment and
  // office hours), placed where they don't collide with lectures.
  const officeStart = freeSlot(today, 10 * 60, 30);
  const dentistStart = freeSlot(today, 17 * 60, 30);
  db.classes.push({ id: id(), schedule_id: todaySchedule.id, user_id: U, name: 'Calculus office hours', start_time: `${String(Math.floor(officeStart / 60)).padStart(2, '0')}:${String(officeStart % 60).padStart(2, '0')}:00`, end_time: `${String(Math.floor((officeStart + 30) / 60)).padStart(2, '0')}:${String((officeStart + 30) % 60).padStart(2, '0')}:00`, sort_order: 0, source: 'manual', course_id: course.math.id });
  block(today, 'class', 'Calculus office hours', officeStart, officeStart + 30);
  db.classes.push({ id: id(), schedule_id: todaySchedule.id, user_id: U, name: 'Dentist appointment', start_time: `${String(Math.floor(dentistStart / 60)).padStart(2, '0')}:${String(dentistStart % 60).padStart(2, '0')}:00`, end_time: `${String(Math.floor((dentistStart + 30) / 60)).padStart(2, '0')}:${String((dentistStart + 30) % 60).padStart(2, '0')}:00`, sort_order: 1, source: 'imported', course_id: null });
  block(today, 'class', 'Dentist appointment', dentistStart, dentistStart + 30);

  // A finished block early in the day, one block spanning "now" (In
  // Progress), then planned work — each dropped into the next free gap.
  const doneStart = freeSlot(today, 7 * 60, 50);
  block(today, 'study', 'Lab report 2 (finish)', doneStart, doneStart + 50, { source_subject_id: labRest.id, completed: true, completed_minutes: 50 });
  const nowStart = freeSlot(today, Math.max(doneStart + 60, t0 - 25), 60);
  block(today, 'study', 'Project 2: draft implementation', nowStart, nowStart + 60, { source_subject_id: draft.id, locked: true });
  block(today, 'break', 'Break', nowStart + 60, nowStart + 75);
  const draft2 = freeSlot(today, nowStart + 75, 60);
  block(today, 'study', 'Project 2: draft implementation', draft2, draft2 + 60, { source_subject_id: draft.id });
  const hwStart = freeSlot(today, draft2 + 70, 90);
  block(today, 'study', 'Problem set 6', hwStart, hwStart + 90, { source_subject_id: hw.id });

  // ---------------- the coming week (one deliberately overloaded day) ----------------
  const revise = task(addDays(today, 3), 'Project 2: revise + test', 90, { course_id: course.cs.id, due_date: addDays(today, 4), priority: 'high', tags: ['Project'] });
  const submit = task(addDays(today, 4), 'Project 2: submit', 30, { course_id: course.cs.id, due_date: addDays(today, 5), priority: 'medium', tags: ['Project'] });
  const essayOutline = task(addDays(today, 1), 'Essay: outline', 60, { course_id: course.hist.id, due_date: addDays(today, 6), tags: ['Essay'] });
  const essayDraft = task(addDays(today, 5), 'Essay: first draft', 150, { course_id: course.hist.id, due_date: addDays(today, 10), priority: 'high', tags: ['Essay'] });
  const bioRead = task(addDays(today, 1), 'Reading: mitochondria', 45, { course_id: course.bio.id, due_date: addDays(today, 2), tags: ['Reading'] });
  const chemSet = task(addDays(today, 3), 'Equilibrium problem set', 120, { course_id: course.chem.id, due_date: addDays(today, 4), priority: 'high', tags: ['Homework'] });
  const mathReview = task(addDays(today, 3), 'Midterm 2: practice exam', 120, { course_id: course.math.id, due_date: addDays(today, 8), priority: 'high', tags: ['Exam'] });

  [1, 2, 3, 4, 5].forEach((offset) => {
    if (!scheduleByDate[addDays(today, offset)]) dayFrame(addDays(today, offset));
    else if (!db.schedule_items.some((b) => b.schedule_id === scheduleByDate[addDays(today, offset)].id)) dayFrame(addDays(today, offset));
  });
  const place = (offset, tk, from) => {
    const date = addDays(today, offset);
    const start = freeSlot(date, from, tk.minutes_requested);
    block(date, 'study', tk.name, start, start + tk.minutes_requested, { source_subject_id: tk.id });
  };
  place(1, essayOutline, 15 * 60 + 30);
  place(1, bioRead, 16 * 60 + 40);
  // +3: overloaded on purpose (5h 30m of study against a 4h daily max)
  place(3, revise, 15 * 60 + 30);
  place(3, chemSet, 17 * 60);
  place(3, mathReview, 19 * 60 + 15);
  place(4, submit, 16 * 60);
  place(5, essayDraft, 15 * 60 + 30);

  // Dependency chain: research -> outline -> draft -> revise -> submit
  const research = pastTaskByName['Project 2: research APIs'];
  const outline = pastTaskByName['Project 2: outline design'];
  [[outline, research], [draft, outline], [revise, draft], [submit, revise], [essayDraft, essayOutline]].forEach(([tk, dep]) => {
    if (tk && dep) db.task_dependencies.push({ id: id(), user_id: U, task_id: tk.id, depends_on_id: dep.id, created_at: ts });
  });

  // Weekly recurring reading for History (Tue + Thu), with this week's
  // occurrences already generated (recurrence_date guards duplicates).
  const rule = {
    id: id(), user_id: U, course_id: course.hist.id, name: 'Weekly reading — HIST 210', minutes: 45, priority: 'medium', tags: ['Reading'],
    days_of_week: [2, 4], start_date: semStart, end_date: semEnd, due_offset_days: 0, active: true, created_at: ts, updated_at: ts,
  };
  db.task_recurrence_rules.push(rule);
  dateRange(today, addDays(today, 6)).filter((d) => rule.days_of_week.includes(dayOfWeek(d))).forEach((d) => {
    task(d, rule.name, rule.minutes, { course_id: rule.course_id, due_date: d, tags: rule.tags, recurrence_rule_id: rule.id, recurrence_date: d });
  });

  // ---------------- grades ----------------
  function category(courseKey, name, weight, sort) {
    const row = { id: id(), user_id: U, course_id: course[courseKey].id, name, weight, sort_order: sort, created_at: ts, updated_at: ts };
    db.grade_categories.push(row);
    return row;
  }
  function graded(courseKey, cat, name, earned, possible, dueOffset, extra = {}) {
    db.grade_items.push({
      id: id(), user_id: U, course_id: course[courseKey].id, category_id: cat.id, name, earned_points: earned, possible_points: possible,
      due_date: addDays(today, dueOffset), counts: true, notes: '', sort_order: db.grade_items.length, created_at: ts, updated_at: ts, ...extra,
    });
  }
  const mExams = category('math', 'Exams', 50, 0);
  const mHw = category('math', 'Homework', 25, 1);
  const mQuiz = category('math', 'Quizzes', 15, 2);
  category('math', 'Participation', 10, 3);
  graded('math', mExams, 'Midterm 1', 82, 100, -9);
  graded('math', mExams, 'Midterm 2', null, 100, 9);
  graded('math', mExams, 'Final exam', null, 150, 66);
  [[18, -35], [19, -28], [17, -21], [19, -14], [18.5, -7], [null, 3]].forEach(([e, d], i) => graded('math', mHw, `Problem set ${i + 1}`, e, 20, d));
  graded('math', mQuiz, 'Quiz 1', 9, 10, -30);
  graded('math', mQuiz, 'Quiz 2', 8, 10, -12);
  graded('math', mQuiz, 'Practice quiz', 6, 10, -16, { counts: false, notes: 'Ungraded practice' });

  const cProj = category('cs', 'Projects', 40, 0);
  const cExam = category('cs', 'Exams', 35, 1);
  const cLab = category('cs', 'Labs', 25, 2);
  graded('cs', cProj, 'Project 1', 46, 50, -20);
  graded('cs', cProj, 'Project 2', null, 50, 5);
  graded('cs', cExam, 'Midterm', 88, 100, -12);
  graded('cs', cExam, 'Final exam', null, 100, 66);
  [10, 9, 10, 8, 10, 9, 10].forEach((e, i) => graded('cs', cLab, `Lab ${i + 2}`, e, 10, -42 + i * 6));

  const chExam = category('chem', 'Exams', 60, 0);
  const chLab = category('chem', 'Lab reports', 30, 1);
  const chHw = category('chem', 'Homework', 10, 2);
  graded('chem', chExam, 'Exam 1', 74, 100, -18);
  graded('chem', chExam, 'Exam 2', null, 100, 16);
  graded('chem', chLab, 'Lab report 1', 27, 30, -25);
  graded('chem', chLab, 'Lab report 2', null, 30, 1);
  graded('chem', chHw, 'Problem set 1', 9, 10, -30);
  graded('chem', chHw, 'Problem set 2', 8, 10, -16);

  const hEssay = category('hist', 'Essays', 50, 0);
  const hPart = category('hist', 'Participation', 20, 1);
  const hFinal = category('hist', 'Final exam', 30, 2);
  graded('hist', hEssay, 'Essay 1', 44, 50, -15);
  graded('hist', hEssay, 'Essay 2', null, 50, 10);
  graded('hist', hPart, 'Participation (so far)', 18, 20, -1);
  graded('hist', hFinal, 'Final exam', null, 100, 64);
  // BIO 120 deliberately has no grade setup, to show that empty state.

  // ---------------- exams + revision topics ----------------
  function exam(courseKey, name, offset, extra = {}) {
    const row = {
      id: id(), user_id: U, course_id: course[courseKey].id, name, exam_date: addDays(today, offset), start_time: '09:00:00', duration_minutes: 90,
      location: course[courseKey].location, weight: null, notes: '', created_at: ts, updated_at: ts, ...extra,
    };
    db.exams.push(row);
    return row;
  }
  function topic(ex, name, difficulty, confidence, estimated, completed, sort) {
    db.exam_topics.push({
      id: id(), user_id: U, exam_id: ex.id, name, difficulty, confidence, estimated_minutes: estimated, completed_minutes: completed,
      status: completed >= estimated ? 'done' : completed > 0 ? 'in_progress' : 'not_started', sort_order: sort, created_at: ts, updated_at: ts,
    });
  }
  const mid2 = exam('math', 'Midterm 2', 9, { weight: 20, notes: 'Covers chapters 7–9. Calculator allowed.' });
  topic(mid2, 'Integration by parts', 3, 2, 120, 30, 0);
  topic(mid2, 'Trigonometric substitution', 3, 2, 90, 0, 1);
  topic(mid2, 'Partial fractions', 2, 3, 90, 45, 2);
  topic(mid2, 'Improper integrals', 2, 4, 60, 60, 3);
  topic(mid2, 'Intro to sequences & series', 3, 1, 120, 0, 4);
  const chem2 = exam('chem', 'Exam 2', 16, { weight: 30, start_time: '13:00:00', duration_minutes: 75 });
  topic(chem2, 'Chemical equilibrium', 3, 2, 120, 0, 0);
  topic(chem2, 'Acids and bases', 2, 3, 90, 20, 1);
  topic(chem2, 'Buffers', 3, 2, 90, 0, 2);
  topic(chem2, 'Titration curves', 2, 3, 60, 0, 3);
  const csMid = exam('cs', 'Midterm', -12, { weight: 17.5, start_time: '10:30:00' });
  topic(csMid, 'Loops and conditionals', 1, 5, 60, 60, 0);
  topic(csMid, 'Functions', 2, 4, 60, 60, 1);
  exam('hist', 'Final exam', 64, { weight: 30, duration_minutes: 120, start_time: '14:00:00' });

  // ---------------- boards ----------------
  const board = { id: id(), user_id: U, title: 'CS 101 · Project 2', course_id: course.cs.id, created_at: ts, updated_at: ts };
  db.boards.push(board);
  const node = (b, type, title, x, y, extra = {}) => {
    const row = {
      id: id(), board_id: b.id, user_id: U, node_type: type, title, x_position: x, y_position: y, color: null, linked_study_subject_id: null,
      status: 'planned', due_date: null, estimated_minutes: null, course_id: null, created_at: ts, updated_at: ts, ...extra,
    };
    db.board_nodes.push(row);
    return row;
  };
  const edge = (b, from, to) => db.board_edges.push({ id: id(), board_id: b.id, user_id: U, source_node_id: from.id, target_node_id: to.id, relationship: 'parent', created_at: ts });
  const goal = node(board, 'goal', 'Ship Project 2: weather dashboard', 60, 40, { due_date: addDays(today, 5) });
  const nResearch = node(board, 'task', 'Research APIs', 60, 220, { status: 'done', estimated_minutes: 90, linked_study_subject_id: research ? research.id : null });
  const nOutline = node(board, 'task', 'Outline design', 300, 220, { status: 'done', estimated_minutes: 60, linked_study_subject_id: outline ? outline.id : null });
  const nDraft = node(board, 'task', 'Draft implementation', 540, 220, { status: 'in_progress', estimated_minutes: 120, due_date: addDays(today, 2), linked_study_subject_id: draft.id });
  const nRevise = node(board, 'task', 'Revise + test', 780, 220, { estimated_minutes: 90, due_date: addDays(today, 4), linked_study_subject_id: revise.id });
  const nDemo = node(board, 'milestone', 'Submit + demo', 1020, 220, { due_date: addDays(today, 5) });
  node(board, 'note', 'Use the free tier of the weather API — 60 calls/min limit.', 300, 400);
  [nResearch, nOutline, nDraft, nRevise, nDemo].forEach((n) => edge(board, goal, n));

  const board2 = { id: id(), user_id: U, title: 'Calculus II · Midterm 2 prep', course_id: course.math.id, created_at: ts, updated_at: ts };
  db.boards.push(board2);
  const g2 = node(board2, 'goal', 'Score 90%+ on Midterm 2', 60, 40, { due_date: mid2.exam_date });
  const s2 = node(board2, 'subject', 'Calculus II', 60, 200, { course_id: course.math.id });
  edge(board2, g2, s2);
  ['Integration techniques', 'Series', 'Practice exam'].forEach((title, i) => edge(board2, s2, node(board2, 'task', title, 300 + i * 240, 200, { estimated_minutes: 90, status: i === 0 ? 'in_progress' : 'planned' })));

  // ---------------- resources ----------------
  const res = (courseRow, title, url, kind, taskId = null) => db.resources.push({
    id: id(), user_id: U, course_id: courseRow ? courseRow.id : null, task_id: taskId, title, url, kind, notes: '', created_at: ts, updated_at: ts,
  });
  res(course.math, 'Course syllabus', 'https://example.edu/math152/syllabus.pdf', 'syllabus');
  res(course.math, 'Lecture recordings', 'https://example.edu/math152/lectures', 'lecture');
  res(course.math, 'Paul’s Online Notes — Integration', 'https://tutorial.math.lamar.edu/Classes/CalcII/IntegrationTechniquesIntro.aspx', 'reference');
  res(course.cs, 'Project 2 brief', 'https://example.edu/cs101/project2', 'document');
  res(course.cs, 'Python docs', 'https://docs.python.org/3/', 'reference');
  res(null, 'Open-Meteo API docs', 'https://open-meteo.com/en/docs', 'reference', draft.id);
  res(course.chem, 'Lab manual', 'https://example.edu/chem110/lab-manual.pdf', 'document');
  res(course.hist, 'Essay rubric', 'https://example.edu/hist210/essay-rubric', 'document');

  // ---------------- projects (V4-B) ----------------
  const projectBase = { user_id: U, description: '', priority: 'medium', start_date: null, due_date: null, estimated_minutes: null, progress_mode: 'auto', manual_progress: null, completed_at: null, created_at: ts, updated_at: ts };
  const portfolio = { ...projectBase, id: id(), space_id: personalSpace.id, title: 'Portfolio Website', description: 'A small site showing three projects, for internship applications.', status: 'active', priority: 'high', start_date: addDays(today, -14), due_date: addDays(today, 30), sort_order: 0 };
  const internships = { ...projectBase, id: id(), space_id: null, title: 'Apply for summer internships', status: 'planned', start_date: addDays(today, 7), due_date: addDays(today, 60), sort_order: 1 };
  const oldProject = { ...projectBase, id: id(), space_id: personalSpace.id, title: 'Blog redesign', status: 'completed', completed_at: ts, sort_order: 2 };
  db.projects.push(portfolio, internships, oldProject);
  const msBase = { user_id: U, description: '', completed_at: null, created_at: ts, updated_at: ts };
  const msDesign = { ...msBase, id: id(), project_id: portfolio.id, title: 'Design approved', due_date: addDays(today, -3), status: 'done', completed_at: ts, sort_order: 0 };
  const msPrototype = { ...msBase, id: id(), project_id: portfolio.id, title: 'Prototype', due_date: addDays(today, 18), status: 'open', sort_order: 1 };
  const msLaunch = { ...msBase, id: id(), project_id: portfolio.id, title: 'Launch', due_date: addDays(today, 30), status: 'open', sort_order: 2 };
  db.project_milestones.push(msDesign, msPrototype, msLaunch);
  const ptask = (date, name, minutes, extra) => task(date, name, minutes, { space_id: null, project_id: portfolio.id, project_milestone_id: null, due_time: null, start_time: null, status_override: null, project_sort: 0, ...extra });
  ptask(addDays(today, -6), 'Sketch homepage layout', 45, { completed_at: ts, actual_minutes: 50, project_milestone_id: msDesign.id, project_sort: 10 });
  ptask(today, 'Build homepage', 90, { due_date: addDays(today, 4), priority: 'high', project_milestone_id: msPrototype.id, project_sort: 20, tags: ['coding'] });
  ptask(addDays(today, 2), 'Write three case studies', 120, { due_date: addDays(today, 12), project_milestone_id: msPrototype.id, project_sort: 30 });
  ptask(addDays(today, 5), 'Choose hosting and deploy', 60, { due_date: addDays(today, 28), due_time: '18:00:00', project_milestone_id: msLaunch.id, project_sort: 40 });
  task(addDays(today, 7), 'Update résumé', 45, { project_id: internships.id, due_date: addDays(today, 14), project_sort: 10 });

  return db;
}
