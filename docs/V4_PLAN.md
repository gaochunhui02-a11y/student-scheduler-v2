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
| `0020_task_fields.sql` | B | `study_subjects.due_time`, `effort` (light/normal/deep), `status_override` (deferred/…); nullable/defaulted only |
| `0021_goals.sql` | C | `goals`, `goal_milestones`, `goal_progress_log`; nullable `goal_id` on `study_subjects`, `projects` |
| `0022_routines.sql` | C | `routines`, `routine_completions` (unique per routine+date) |
| `0023_attendance.sql` | G | `attendance_records` (unique per course/series + date) |
| `0024_notes.sql` | H | `notes` (one optional parent per kind, ownership-checked) |
| `0025_resources_v4.sql` | H | resource links to project/goal/exam/space, `tags`, `favorite`, wider `kind` check |
| `0026_share_links.sql` | I (optional) | read-only share links with random tokens — **only if it stays small; otherwise V4.1** |

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

### V4-A — Foundation (done, awaiting review)
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
