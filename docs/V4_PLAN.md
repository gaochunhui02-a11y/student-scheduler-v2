# Student Scheduler V4 — "Productivity OS" plan

Branch `v4-productivity-os`, cut from `v3.0.0` (`307e9dc`, = `master`).
Nothing here touches `master`, the `v3.0.0` tag, production or a hosted
database. Migrations are files only; the owner applies them after review.

## 1. V3 audit (what exists and how V4 builds on it)

**App shape.** One `dashboard.html` with a section per page, a hash router
(`src/app/router.js`: `#/home`, `#/courses/<id>:<tab>`, `#/tasks`, …),
a shared context bus (`src/app/context.js`), a cached data store
(`src/app/store.js`), the V3 UI kit (`src/ui/*`), and a capability probe
(`src/shared/capabilities.js`) that lets the app run — as V2 — on a database
missing newer migrations. V4 keeps all of this.

**Database (0001–0017, 21 tables).** V2 core: `profiles`, `schedules`
(one per planned day), `classes`, `study_subjects` (tasks), `schedule_items`
(generated blocks), `study_subject_subtasks`, `boards`, `board_nodes`,
`board_edges`, `class_series`, `class_series_exceptions`. V3: `semesters`,
`courses`, `grade_categories`, `grade_items`, `exams`, `exam_topics`,
`task_recurrence_rules`, `task_dependencies`, `resources`, `focus_sessions`,
plus `profiles.preferences` (jsonb). Every table has `user_id` + RLS
(select/insert/update/delete own); every V3 cross-table reference has the
`v3_assert_owned_ref` ownership trigger.

**Tasks.** A task is a `study_subjects` row that lives on a day's schedule
(`schedule_id` NOT NULL = "plan date"); multi-day work is a root row plus
chunk rows (`origin_subject_id`). `src/tasks/taskModel.js#buildTaskGroups`
turns rows + blocks into task groups; status is *derived* from blocks
(planned / in progress / done / partial / missed / carried over /
unscheduled). The Planner, Generate, Carry Over, multi-day planning,
dependencies, recurrence, the Tasks page, course pages and Quick Add all
read this one table.

**Extend, don't duplicate.**
| V4 need | Extend | New |
|---|---|---|
| Universal tasks | `study_subjects` (+ `space_id`, `project_id`, `goal_id`, `due_time`, `effort`, `status_override`) | — |
| Projects | Board stays the visual canvas; a project can link a board | `projects`, `project_milestones` |
| Goals | — | `goals`, `goal_milestones`, `goal_progress_log` |
| Routines | recurrence model from `task_recurrence_rules` | `routines`, `routine_completions` |
| Spaces | `courses`, `study_subjects`, `boards` get nullable `space_id` | `spaces` |
| Workspace mode, modules, dashboard layout, energy, notification prefs | `profiles.preferences` jsonb (0017) | — |
| Attendance | course/class series | `attendance_records` |
| Notes | — | `notes` |
| Resources | `resources` (+ `project_id`, `goal_id`, `exam_id`, `space_id`, `tags`, `favorite`, wider `kind`) | — |
| Grade / final calculators | `gradeModel` already computes both | UI only |
| Exam study plan | V3 revision planner | UI + planner hooks |
| Today, Weekly review, matrix, planned vs actual | existing data + `focus_sessions` | pure models + UI |

## 2. Proposed migrations (V4)

| File | Checkpoint | Adds |
|---|---|---|
| `0018_spaces.sql` | A | `spaces`; nullable `space_id` on `courses`, `study_subjects`, `boards`; ownership triggers |
| `0019_projects.sql` | B | `projects`, `project_milestones`; nullable `project_id`, `project_milestone_id` on `study_subjects`; `boards.project_id` |
| `0020_task_fields.sql` | B | `study_subjects.due_time`, `start_time`, `status_override` (in_progress/deferred), `project_sort`; nullable/defaulted only (effort moves to V4-E) |
| `0021_unscheduled_tasks.sql` | B.1 | `study_subjects.schedule_id` nullable (unscheduled/backlog), `planned_by`, backlog index, schedule ownership trigger |
| `0022_goals.sql` | C | `goals`, `goal_milestones`, `goal_progress_log`; nullable `goal_id` on `study_subjects`, `projects` |
| `0023_routines.sql` | C | `routines`, `routine_completions` (unique per routine+date) |
| `0024_attendance.sql` | G | `attendance_records` (unique per course + day + start minute) |
| `0025_notes.sql` | H | `notes` (one optional parent per kind, ownership-checked) |
| `0026_resources_v4.sql` | H | resource links to project/goal/exam/space, `tags`, `favorite`, wider `kind` check |
| ~~`0027_share_links.sql`~~ | — | read-only share links — **deferred to V4.1** (see V4-I) |

Rules, enforced by `tests/migrations-v3.test.js` (extended to 0018+) and the
PGlite database test: additive, idempotent, RLS + four own-row policies on
every new table, ownership triggers on every reference to a user-owned row,
CHECK constraints, intentional cascades, no drops/renames/updates of data.
Workspace mode, enabled modules, sidebar and dashboard layout, energy and
notification preferences live in `profiles.preferences` — no migration.

## 3. Navigation

A module registry (`src/workspace/modules.js`) describes every page:
section, icon, which modes enable it by default, and whether it is built
yet. The sidebar is rendered from it: only enabled, built modules are shown,
grouped as

```
Home        Home · Today*
Plan        Planner · Week · Calendar · Semester
Work        Tasks · Projects* · Goals* · Routines*
Academics   Courses · Exams · Grades
Organize    Board · Notes*
Review      History · Insights
            Customize…  (→ Settings › Workspace)
```
`*` arrives in later checkpoints. Hidden modules keep working through
links, the command palette and search — they just aren't in the rail.
Mobile bottom navigation is unchanged (Home · Today · + · Tasks · More).

Default modules per mode (only built ones are shown):

| Mode | Default modules |
|---|---|
| School | Home, Today, Planner, Week, Calendar, Semester, Tasks, Courses, Exams, Grades, Board, Insights |
| Work | Home, Today, Planner, Week, Calendar, Tasks, Projects, Goals, Board, Insights |
| Personal | Home, Today, Planner, Calendar, Tasks, Goals, Routines, Insights |
| Self-study | Home, Today, Planner, Week, Calendar, Tasks, Goals, Routines, Exams, Board, Insights |
| Multiple areas | everything |

## 4. Existing V3 users

- **No data is rewritten.** 0018 only adds a table and nullable columns.
- **Nothing disappears.** A profile without a saved workspace mode is a
  *legacy* account and keeps the full V3 navigation. Picking a mode in
  Settings › Workspace is opt-in; modules can be turned back on any time.
- **Spaces are optional.** Items without a space show under *All spaces*
  and *No space*. Settings offers a one-click, previewed, reversible
  "Put my courses in a School space" — never applied automatically.
- **Order of rollout.** Apply 0018+ before deploying V4. V4 also runs on a
  V3 database (spaces/projects/… show "needs a database update"), and V3
  keeps working on a V4 database because it never reads the new columns.

## 5. Compatibility risks

1. **Rollback after V4 writes.** If V4 is rolled back to V3, V3 ignores
   spaces/projects/goals and their links; the underlying tasks, courses and
   boards stay intact and visible. No V4 migration makes a V3 query fail.
2. **Tasks without a day.** V3 requires every task to sit on a schedule.
   V4-B keeps that (an "unscheduled" task is planned on its due date or
   today) instead of making `schedule_id` nullable, which V3 code could not
   read safely after a rollback.
3. **Derived vs stored status.** Task status stays derived from blocks;
   V4 adds only an explicit *deferred* override, so the V3 Planner and V4
   agree on every existing task.
4. **Preferences in jsonb.** Unknown keys are ignored by V3; V4 validates
   and clamps every key it reads.
5. **Bundle size.** New pages are loaded lazily where that is low-risk;
   growth will be reported per checkpoint.

## 6. Status

### V4-A — Foundation (done)
- `0018_spaces.sql`: `spaces` + nullable `space_id` on `courses`,
  `study_subjects`, `boards` (ON DELETE SET NULL, ownership triggers, RLS).
- Workspace modes (School / Work / Personal / Self-study / Multiple areas)
  stored in `profiles.preferences.workspace`; module registry
  (`src/workspace/modules.js`); sidebar regrouped and filtered; accounts
  without a saved mode keep the full V3 navigation.
- Spaces: create / rename / icon / colour / archive / restore in
  Settings › Workspace; default space; sidebar switcher (All / a space /
  No space) filtering Tasks and Courses with a visible "Showing: …" note;
  Space field in the course and task editors (a task follows its course's
  space unless it has its own); previewed "put my courses in a space".
- Onboarding starts with "What do you want to use this for?"; Work /
  Personal / Self-study skip the course and timetable steps; the first space
  is created only for accounts that have none.
- Command palette: switch space, show all spaces, customize sidebar.
- Backup/restore includes spaces (same-name spaces are reused).
- Settings › Workspace tab; About lists the two new database features.

### V4-B — Projects + universal tasks (done)

**Migrations (files only — not applied anywhere):**
- `0019_projects.sql` — `projects` (title, description, space, status
  planned/active/on_hold/completed/archived, priority, start/due dates,
  estimated minutes, progress mode auto/manual + manual value, sort order,
  completed_at) and `project_milestones` (project, title, description, due
  date, status open/done, completed_at, sort order); RLS with select/insert/
  update/delete-own on both; nullable `study_subjects.project_id` and
  `project_milestone_id`; ownership triggers (space → project → milestone →
  task); `v4_task_milestone_matches` keeps a task's milestone inside the
  task's own project (and clears it when the task leaves its project).
- `0020_task_fields.sql` — `study_subjects.due_time`, `start_time`,
  `status_override` ('in_progress' | 'deferred'), `project_sort` (default 0).

**Deletion behaviour (deliberate):**
- Deleting a project keeps its tasks: `project_id` is ON DELETE SET NULL,
  so tasks, their blocks, history and focus time stay; they simply leave
  the project. The app's confirmation says so and recommends Archive.
- A project's milestones are deleted with it (CASCADE) — they hold no work.
- Deleting a milestone only clears `project_milestone_id` on its tasks.
- Archive (status = archived) is the normal way to put a project away.

**Compatibility decisions:**
- One task system. A project task is an ordinary `study_subjects` row with a
  `project_id`; it appears in Tasks, the Planner, Week, Calendar, the
  Dashboard and search with no duplication. Neither course nor project is
  required.
- *(Superseded by V4-B.1 below.)* Tasks still live on a planned day (`schedule_id` NOT NULL) — "optional
  scheduled date" means the editor defaults to today; nothing in V3 had to
  change, and a rollback to V3 still reads every V4 task.
- Status: To Do / In Progress / Done / Missed / Deferred. Done is still
  `completed_at`; To Do / In Progress / Missed are still derived from blocks
  exactly as in V3; only In Progress (for tasks without blocks) and Deferred
  can be set explicitly. Every V3 task has a NULL override → identical status.
- Description: the existing `notes` field is the task's description/notes
  (one field, labelled Notes) rather than adding a second free-text column.
- Start time: saving a task with a start time pins a locked study block at
  that time on its planned day (shared code with Quick Add's study block),
  only if the task has no block that day and nothing overlaps; otherwise the
  task saves and the toast explains why no block was pinned.
- Space: a task's effective space is its own, else its project's, else its
  course's.
- Legacy (never chose a mode) accounts keep exactly the V3 sidebar; Projects
  is off for them and for School mode until switched on (it is still
  reachable from Quick Add, the palette and search). Work and Multiple areas
  show it by default.
- Progress: one number. Automatic = completed tasks + completed milestones,
  each counted once, over all of them; Completed projects show 100%; manual
  mode shows the student's percentage and keeps the counts as counts.

**Known limitations (V4-B):**
- Project task order uses Move up / Move down buttons, not drag and drop.
- Changing a task's start time later does not move a block already pinned.
- Missed is derived from missed blocks only; a passed due date shows as
  Overdue, not Missed.
- Projects have a description; linking notes and resources to projects is
  part of V4-H (0024/0025).
- Project lists load all of a user's projects, milestones and project tasks
  (single-user scale; no pagination).
- Demo mode can now simulate missing V4 tables *and* columns
  (`?premigration=v4|v3`) — still not a substitute for the real database.

### V4-B.1 — True unscheduled (backlog) tasks (done)

Supersedes the V4-B decision "tasks still live on a planned day".

**Date concepts (kept separate, `src/tasks/taskDates.js`):** due date (must
be finished by) · scheduled date (the day the student plans to work on it;
the task's `schedule_id`) · start time (optional time on the scheduled day).
Any combination is valid. Overdue depends only on the due date.

**Migration `0021_unscheduled_tasks.sql` (file only, not applied):**
- `study_subjects.schedule_id` DROP NOT NULL — NULL = unscheduled. Only a
  relaxation: every existing row keeps its schedule; every insert that was
  valid before is still valid. The FK and its cascade are unchanged.
- `study_subjects.planned_by` ('user' | 'planner', NULL for existing and
  unscheduled tasks) — who gave the task its day.
- Partial index for the backlog query (`user_id where schedule_id is null`).
- Ownership trigger on `schedule_id` (closes a V2 gap: a task could
  reference another user's schedule id). RLS unchanged (user_id-based).
- The migration safety test now allowlists exactly this one
  `drop not null`; any other relaxation fails the test.

**Behaviour:**
- New tasks (task editor, Quick Add, project "Add task", course page, Home)
  start unscheduled; the editor shows "Scheduled date (optional)" next to
  the due date with a Today button. Callers that pass a day (Planner, exam
  revision plan, recurring tasks, board) are unchanged.
- Clearing a scheduled task's date returns it to the backlog (its existing
  blocks stay on that day, as with a move).
- A start time requires a scheduled date: the editor refuses and focuses the
  date field; today is never filled in. Pinning only happens with a date.
- Creating a task never creates a block.
- Tasks page: new "Unscheduled" view with a count notice and "Plan my
  backlog"; rows say "Unscheduled" (no day) or "Planned Oct 21" (day, no
  session yet) instead of V3's ambiguous "Not scheduled".
- Planner: "Add from backlog" pulls chosen tasks onto the day being planned
  (planned_by = user). "Plan my backlog" (`src/planner/backlogPlanner.js`)
  assigns days deterministically — earliest deadline first, then priority,
  size, name — into each day's free capacity (daily limit minus planned study
  and exam prep, from the workload forecast) over the next 14 days, before
  each due date; too big for any day → the roomiest day, marked "Tight"; no
  room → stays unscheduled and is listed. A preview is shown; nothing moves
  until the student confirms (planned_by = planner). Sessions are then built
  by the Planner's normal Generate on that day.
- Today page (V4-D) contract: `splitForDay()` returns tasks scheduled on the
  day and, separately, tasks only due that day; an unscheduled task is never
  a "today" task.
- Without 0021 the app behaves exactly as V3: a day is required (defaults to
  today), the Unscheduled view and backlog actions are hidden.
- Backup: unscheduled tasks restore unscheduled; a task whose day was skipped
  (conflict) is still dropped with that day; restoring onto a database
  without 0021 leaves backlog tasks out and reports them as skipped.

**Known limitations (V4-B.1):**
- "Plan my backlog" assigns whole tasks to single days; a task larger than a
  day's room is marked Tight (V2 multi-day planning can still spread it).
- Plan my backlog looks 14 days ahead.
- Unscheduling a task leaves any already-generated blocks on their day.
- Rolling back to V3 after creating backlog tasks: V3 shows them without a
  planned date and can edit them, but cannot create new ones.

### V4-C — Goals + routines (done)

**Migrations (files only — not applied anywhere):**
- `0022_goals.sql` — `goals` (title, why/description, space, status
  active/on_hold/achieved/archived, start/target dates, progress mode
  auto/numeric/manual, start/target value, unit, aggregate sum/latest,
  manual %, sort order, achieved_at), `goal_milestones` (goal, title, due
  date, open/done), `goal_progress_log` (check-ins: day, value, note);
  RLS with four own-row policies on all three; nullable
  `study_subjects.goal_id` and `projects.goal_id`; ownership triggers on
  every reference (space → goal → milestone/check-in/task/project).
  CHECKs: a numeric goal needs a target different from its start; values
  within ±1e9; dates in order; manual % 0–100.
- `0023_routines.sql` — `routines` (title, notes, space, goal, frequency
  daily/days/weekly_count, days_of_week jsonb array, weekly target 1–7, time
  of day, optional minutes, start/end date, paused + paused_at, archived)
  and `routine_completions` (routine, day, done/skipped, note) with a
  **unique (routine, day)** index; RLS + ownership triggers.

**Deletion behaviour (deliberate):**
- Deleting a goal keeps its linked tasks, projects and routines (`goal_id`
  ON DELETE SET NULL); its milestones and check-ins go with it (CASCADE).
  The confirmation says so and recommends Archive.
- Deleting a routine deletes its completion history (CASCADE); the
  confirmation recommends Pause or Archive instead.

**Behaviour:**
- Goals page (`#/goals`, `#/goals/<id>`): status views, search, space
  filter, cards with one progress number and a pace badge. Goal page:
  progress ring, pace line, linked projects (link / unlink / new project),
  linked tasks (add task with the goal preselected), milestones, check-ins
  (numeric goals) and the routines that serve it.
- Progress — one number per goal: *auto* = done tasks + done milestones +
  each linked project's own progress fraction, over all of them (Achieved
  shows 100%); *numeric* = check-ins from start to target (sum adds each
  check-in, latest uses the newest; falling targets like 76 → 70 kg work);
  *manual* = the student's %.
- Pace (deterministic): with both dates, compares progress with the
  straight line from start to target date — Ahead / On track / Behind
  (> 10 points behind) / Past target date.
- Routines page (`#/routines`): today's routines to tick or skip (unticked
  first, by time of day; N-per-week routines hide once the week's target is
  met), then every routine with its schedule, a 14-day strip, current and
  best streak and a 30-day completion rate. Ready-made examples on the empty
  page.
- Streaks: days (daily/days) or weeks (N per week). Skipped days neither
  count nor break; today never breaks a streak. Pausing records paused_at;
  resuming records the paused routine days as skipped, so a pause never
  breaks a streak.
- Routines never create tasks or blocks — the Planner, Tasks, Generate and
  Carry Over are unchanged. `routineMinutesOn()` is ready for V4-E capacity.
- Task and project editors get a Goal field (task: up front when opened
  from a goal, otherwise under More options).
- Quick Add (G / R), command palette (new / open / search goals and
  routines), backup/restore (all five tables, links remapped; left out on a
  database without 0022/0023), Demo Mode seed, `?premigration=v4c`.
- Modules: Goals is on for Work, Personal, Self-study, Multiple; Routines
  for Personal, Self-study, Multiple. Legacy (V3) and School accounts opt in
  via Settings › Workspace (still reachable from Quick Add, palette, search).

**Known limitations (V4-C):**
- A project serves at most one goal; a task links to one goal.
- Routine completions are per day only (no "twice a day" routines).
- Routines don't reserve planner time yet (V4-E adaptive planner).
- Pause history keeps only the current pause; the skipped back-fill is
  capped at 120 days.
- Goal pace ignores weekends and breaks (straight calendar line).

### V4-D — Today + customizable dashboard (done)

**No migration.** The dashboard layout lives in `profiles.preferences.dashboard`
(0017, merged with the other keys; a per-device copy is used without 0017).

**Today page (`#/today`, `src/today/*`):**
- Quick capture: "Read chapter 4 45m" adds a task planned for today (a
  trailing 45m / 1h / 1.5h / 1h30 sets the time needed; default 30 min).
- *Start here*: up to three suggested tasks with the reason shown —
  overdue (oldest first) → due today → high priority planned today →
  other planned today. Tasks blocked by a dependency are never suggested.
  Deterministic and never stored.
- *Planned today* (scheduled on today, incl. later parts of multi-day
  tasks), *Due today* (due today but planned elsewhere or unscheduled —
  never mixed with planned), *Overdue*, each with a one-click
  **Do today** (plans the task on today; Undo restores its old day or the
  backlog).
- *Schedule*: today's classes, study sessions, imported events and exams
  with past / now / next states and study progress; *Routines* checklist.
- Sidebar "Today" (Home section) and the mobile bottom-bar Today tab open
  this page when the Today module is on; otherwise (legacy V3 accounts) the
  tab still opens today's Planner as before.

**Customizable dashboard (`src/home/dashboardLayout.js`):**
- Eleven widgets: Now & next, Top three, Today's progress, Due soon,
  Routines today, This week's deadlines, Exams, Workload this week, Active
  projects, Goals, Courses & semester.
- Defaults per workspace mode (School / Work / Personal / Self-study /
  Multiple). A legacy account that never customized sees exactly the V3
  dashboard (same cards, order and section headings).
- "Customize" drawer: checkbox per widget + Move up / Move down buttons
  (keyboard and screen-reader friendly, no drag), Reset to default, Save.
  Saving the default removes the stored key.
- Widgets whose feature is missing (database not migrated) or whose module
  is off are skipped; their data is only loaded when they are switched on.

**Known limitations (V4-D):**
- "Start here" is a suggestion; it can't be pinned or reordered by hand.
- Widgets have fixed sizes (no resizing); order is per account, not per
  device.
- Quick capture understands only a trailing duration (no dates/priority
  parsing).

### V4-E — Adaptive planner (done)

**No migration.** Energy preferences live in `profiles.preferences.energy`.

**Catch up on missed work (`src/planner/catchUp*.js`)** — confirm-first:
- Finds open tasks with time left that were planned on a past day
  (*missed*) or are past due and planned nowhere (*overdue*), and have no
  part planned today or later. Deferred tasks are left alone.
- Preview drawer: untick anything, choose "Start from Today / Tomorrow"
  (tomorrow by default after 19:00), see each task's proposed day, Tight /
  After its due date flags, and minutes kept in locked sessions. Nothing is
  written until "Move N tasks".
- Day choice = the "Plan my backlog" rules (earliest due first; first day
  before the due date with room; else the roomiest day, Tight; else left
  for the student) over the next 14 days' free capacity.
- Exact minute accounting, same as the Planner's Carry Over: a task with
  no blocks just moves; a task with past blocks keeps them (history stays
  true) and gets one carry-forward part on the new day holding the
  unfinished, unlocked block minutes (recorded as `carried_over_minutes`,
  block marked missed) plus any minutes a past part asked for but never got
  a block (that part is trimmed to what was blocked). Locked blocks are
  never touched. Re-running Catch up never offers the same minutes twice.
- Entry points: a banner on Today ("N tasks need a new day") and the
  command palette ("Catch up on missed work").

**Energy & capacity (Settings › Planner):**
- Peak focus time → the preferred study period of newly created days
  (existing days are never changed).
- Lighter weekdays with a % of the daily limit → lower capacity in the
  workload forecast (with a reason), Plan my backlog and Catch up.
- Optional "count routine time against my daily study limit" (off by
  default); routine minutes always appear as a forecast reason.
- Fixed a V3 bug found here: `invalidate('prefs:')` never cleared the
  `prefs:*` cache, so a new daily study limit only applied after a minute.

**Known limitations (V4-E):**
- Catch up assigns whole tasks to single days (no splitting across days);
  sessions are built by the Planner's Generate on that day.
- Peak time doesn't yet order hard vs easy tasks inside a day.
- Tasks whose only past part is older than ~60 days aren't seen by Catch up.

### V4-F — Productivity intelligence (done)

**No migration.** Weekly reflections live in `profiles.preferences.reviews`
(newest 26 weeks, 1000 characters per answer).

**Weekly review (`#/review`, `#/review/<monday>`, `src/review/*`):**
- Tiles: studied vs planned (follow-through %), focus time and sessions,
  tasks done / slipped, routine days kept.
- Planned vs actual per day (planned blocks, completed minutes incl.
  partial, focused minutes from focus sessions) as accessible bars (each
  day has a text label) — "no rate" instead of 0% when nothing was planned.
- Where the time went: planned vs done per course or per project.
- Wins (tasks completed that week, project + goal milestones, goals
  achieved), Slipped (due that week, still open) with Catch up, goal
  check-ins (change or latest value), routines, and — for the current week
  — next week's deadlines, exams and heavy days from the forecast.
- Reflection: What went well / What got in the way / One focus for next
  week; Save draft or Save & mark reviewed (first reviewed time kept).
  Previous weeks can be browsed and reviewed.
- Today shows "Your weekly review is ready" Friday–Sunday until the week
  is marked reviewed (only when the Weekly review module is on — it is in
  every mode's defaults; legacy accounts opt in).

**Priority matrix (Tasks › Matrix):**
- Open tasks of the current filters in Do now / Plan / Keep it short /
  Later. Urgent = overdue or due within 2 days; Important = high priority —
  both from existing fields, explained above the matrix.
- "Important" / "Less important" moves a task between rows by changing its
  priority (high ↔ medium), with Undo; columns follow the due date.
- The List / Matrix choice is remembered per device.

**Known limitations (V4-F):**
- Planned vs actual counts generated study blocks only (tasks placed on a
  day but never generated count as unplanned).
- The matrix's urgency window (2 days) is fixed.
- Reflections are private notes in preferences; they are not part of the
  JSON backup yet.

### V4-G — Academic tools (done)

**Migration (file only — not applied):** `0024_attendance.sql` —
`attendance_records` (course, optional recurring class, day, start minute,
status present / late / absent / excused, note) with a **unique (course,
day, start minute)** index, RLS (four own-row policies), ownership triggers
on course and recurring class. Deleting a course deletes its attendance
(CASCADE); deleting a recurring class keeps its records (series → NULL).

**Attendance (`src/attendance/*`):**
- A session = one meeting of a course (course, day, start time), from its
  recurring classes (skips removed, moved times applied) and one-off
  classes — so it works however the class was entered.
- Course › Attendance tab: every held session of the term (semester start →
  today, else the last 10 weeks), Present / Late / Absent / Excused buttons
  (press again to clear), rate, counts, "You can miss N more classes and
  stay at 80% or above", and a confirmed "Mark N unmarked as present".
- Rate = (present + late) / (marked − excused); unmarked sessions are listed,
  never counted as absences. On track ≥ 90%, Watch it ≥ 80%, else Below 80%
  (80% is a hint, never enforced).
- Course Overview card, rate badge on Courses cards, and quick Present /
  Absent buttons on today's classes in Today's schedule.

**Break it down (`src/tasks/breakdown*.js`):** from the task editor
(More options) for open tasks. Seven templates (essay, lab report, problem
set, presentation, project, exam prep, reading) suggested from the task
name (en/zh/ja); each step gets a share of the time (exact total, 5-minute
rounding) and a staggered "done by" date up to the due date. Two outputs:
- *Separate tasks* (unscheduled, ready for Plan my backlog; same course /
  project / goal / space / tags) — only when no study has been done on the
  task yet; the task itself becomes the final step, so total time is
  unchanged.
- *A checklist inside the task* (existing subtasks) — always available.

**Already in V3 and kept:** grade "what do I need" calculators (remaining
work, a specific item, a final exam with a custom weight), course progress
on the course Overview, exam revision plans added to the Planner.

**Known limitations (V4-G):**
- The 80% attendance threshold is a fixed hint, not a per-course setting.
- Attendance for classes without a course can't be tracked.
- Breakdown templates are fixed (no custom templates yet).

### V4-H — Notes, links everywhere, templates, demo (done)

**Migrations (files only — not applied):**
- `0025_notes.sql` — `notes` (title, body ≤ 50 000 chars, tags, pinned,
  archived, optional space, course, project, goal, exam and task links),
  RLS, ownership triggers on every link. Deleting what a note links to
  NEVER deletes the note (all links ON DELETE SET NULL).
- `0026_resources_v4.sql` — `resources` gets project / goal / exam links
  (CASCADE, like course / task), `space_id` (SET NULL, never a parent),
  `in_library` (a general link that belongs to nothing), `favorite`, `tags`.
  Two reviewed widenings: `resources_kind_check` (+ video, article, tool,
  book, other) and `resources_has_parent` (+ the new parents or in_library);
  every existing row stays valid. The migration test now rejects any other
  dropped constraint and requires drops to be re-added in the same file.

**Notes (`#/notes`, `#/notes/<id>`):** list (search, All / Pinned /
Archived, linked-item chips, checklist counts) + editor with autosave
("Saving… / Saved"), Write / Preview, link to a course / project / goal /
exam, tags, pin, archive, delete (confirmed), and templates (lecture,
meeting, reading, weekly plan). The preview is a small Markdown subset
(headings, lists, checklists, quotes, bold / italic / code, http(s) links)
rendered by `src/notes/noteMarkdown.js`: everything is escaped first, only
our own tags are emitted, links open with rel="noopener noreferrer";
covered by adversarial XSS tests. Checklist items can be ticked in the
preview (mouse or keyboard).

**Library (`#/notes/library`):** every saved link in one place — course,
task, project, goal, exam or "My library" — with search, kind, belongs-to
and starred filters, add / edit / star / remove. Project and goal pages
show Notes + Links cards; courses get a Notes tab (their Resources tab
stays).

**Project templates:** "Start from" in the new-project editor — Research
paper, Internship / job applications, Portfolio website, Plan an event —
creates milestones and unscheduled tasks with due dates stretched to the
project's dates (or the template's default length).

**Demo:** the demo account now uses the Multiple areas workspace (every
V4 page visible) and includes notes, starred and general library links.
Demo Mode's `?premigration=` switch now simulates each V4 level
(`v4`, `v4c`, `v4g`, `v4h`).

**Known limitations (V4-H):** no rich-text editor (Markdown subset only),
no note attachments / images (links only), the library isn't filtered by
the space switcher, note templates are fixed.

### V4-I — Search, focus, reminders, export, privacy, offline (done)

**No migration.** (Read-only share links — planned as optional `0027` —
are deferred to V4.1: they need token design, a public read path and their
own security review, which doesn't fit "only if it stays small".)

- **Search & palette:** goals, routines and notes are searchable (note
  text included); scope prefixes `>` commands · `t:` tasks · `p:` projects
  · `g:` goals · `n:` notes · `c:` courses · `r:` routines · `e:` exams;
  new commands: Start a focus timer, Plan my backlog, Customize dashboard,
  Catch up, Open Library, and "Mark done: <routine>" for routines due today.
- **Focus timer:** focus on any task (Today's "Start here", the task
  editor) or on nothing (palette). 15 / 25 / 50 min or custom, pause /
  resume / stop / finish; timestamp-based clock (no drift), screen-reader
  announcements at 10 / 5 / 1 minutes left, tab title shows the time.
  Every session ≥ 1 minute is saved to focus history (Insights, Weekly
  review) and can add its minutes to the task's time spent.
- **Reminders (opt-in, Settings › Notifications):** routines still unticked
  (morning 8:00, afternoon 13:00, evening 19:00, any time 18:00) and the
  weekly review (Friday 17:00, until reviewed); each sent once per device.
- **Export as files (Settings › Data):** tasks.csv, notes.md, routine log,
  attendance and goal check-ins — CSV cells starting with = + - @ are
  prefixed with ' (no formula injection). The JSON backup stays the
  complete, restorable copy.
- **Privacy (new Settings tab):** what's stored in the account vs this
  device, no AI / no tracking / private by default, a switch to stop keeping
  the offline copy (deleting it at once), and "Clear this device's app data"
  (filters, layouts, reminder settings, offline copy — never account data or
  the sign-in).
- **Offline:** the read-only snapshot (v2) now includes today's routines
  and is shown by the Today page as well as Home when the app opens without
  a connection. Notes are never stored offline. Fixed in passing: the focus
  dialog's first paint ran before its drawer existed (caught in QA).

**Known limitations (V4-I):** reminders only fire while the app is open
(no push server); the focus timer isn't shared across tabs; Account
deletion still has to be requested (no self-service delete in this
version); exports don't include boards (the JSON backup does).

### V4-J — Full QA, docs, beta prep (done)

**QA (Demo Mode in headless Chrome, `../student-scheduler-qa-harness`):**
- Runtime sweep — 19 pages × 6 database levels (all migrations,
  `?premigration=v4h`, `v4g`, `v4c`, `v4` = V3 database, `v3` = V2
  database): 0 console errors, every page renders or shows its "needs a
  database update" notice.
- Accessibility — axe WCAG 2.1 A/AA on 20 pages (incl. Planner and
  Library) in light and dark: 0 violations; plus the drawers and dialogs
  added in V4-C…I (each checked when built).
- Mobile — every page at phone width (headless minimum 500 px) in English,
  Chinese and Japanese: no horizontal overflow, no errors.
- V3-account regression — an account that never chose a mode sees exactly
  the V3 navigation (12 pages), the three-section V3 Home and the mobile
  Today tab opening the Planner.
- Feature flows verified against the stored data at each checkpoint
  (goals, routines, Today, customization, catch-up accounting, energy,
  review, matrix, attendance, breakdown, notes, library, templates, focus
  timer, exports, offline).

**Automated tests:** `npm test` 1778 checks / 0 failures (60 files);
PGlite database test 271 / 0 (all 26 migrations, idempotent re-run, RLS,
ownership triggers, CHECKs, cascades as two users); production build passes.

**Bundle:** JS 448 kB gzip (V3: 261 kB). Largest parts: the dashboard
chunk (192 kB), all three languages' strings (130 kB), the Supabase client
(71 kB). Loading only the active language's strings (~-85 kB) is the
obvious next step; not done in beta to avoid changing the i18n boot path.

**Release:** `package.json` / `APP_VERSION` are `4.0.0-beta.1`. The
`v4.0.0-beta.1` tag is NOT created — by the V4 rules it is tagged only
after Vercel Preview testing on a staging database (README › V4 migrations
› Preview checklist). Nothing was merged to `master`, nothing deployed, no
migration applied.

**Deferred to V4.1:** read-only share links; per-course attendance
threshold; custom templates (breakdown, notes, projects); splitting a
catch-up task across days; reordering "Start here"; rich-text notes and
attachments; push reminders while the app is closed; self-service account
deletion; lazy-loaded language files.
