# Student Scheduler

A student productivity workspace that combines daily/weekly scheduling,
multi-day planning, a visual project board, analytics, calendar tools, and
deterministic smart recommendations — with real accounts, a real database,
and **no paid AI API required**.

## Overview

Students don't have one problem, they have several at once: fixed classes,
competing deadlines, study time that varies day to day, work that gets
missed or only half-finished, and no easy way to see what actually deserves
attention right now.

This app addresses that directly. You describe a day once (wake/sleep time,
classes, meals, study tasks with priority/minutes/due dates), and a
deterministic scheduling algorithm builds a realistic timeline around your
fixed commitments. From there, the app tracks reality as it happens — lock a
block so it never gets rescheduled, log partial progress instead of an
all-or-nothing "done," carry unfinished work forward instead of losing it,
and spread a big task across several days ahead of its deadline. A separate
visual Board lets you plan a project or exam by breaking it into connected
steps, with one click to turn any step into a real Planner task. On top of
all of that, a transparent scoring engine tells you what to work on next —
using ordinary arithmetic on data you already entered, not a hosted AI
model.

## What's new in V3 (Academic OS) — beta

V3 (`v3-academic-os` branch, version `3.0.0-beta.1`) turns the planner into a
semester-level workspace. Everything from V2 still works, and every V3
feature is **rule-based and runs in the browser — no AI service is called**.

- **Courses & semesters** — a course page per class with its meetings,
  tasks, grades, exams and resources; a semester view with week-by-week
  intensity, breaks and big deadlines.
- **Grades** — weighted categories, current grade per course, and "what do
  I need on the final?" calculators.
- **Exams** — countdowns, topics with confidence, and a deterministic
  revision plan that fits around the days you already have planned.
- **Tasks page** — every task across days, with dependencies (cycle-safe),
  recurring task rules, subtasks, tags and links.
- **Workload forecast, Smart Rebalance and What-if** — see overloaded days
  coming and preview moves before applying them.
- **Planner & Calendar** — edited blocks stay pinned, move a block to
  another day, richer conflict warnings; Month / Week / Agenda calendar with
  drag-and-resize.
- **Focus history & estimate accuracy**, **Insights**, and a rebuilt
  **Dashboard** around "today".
- **Command palette** (Ctrl/⌘ K), **Quick Add** (N) and keyboard shortcuts (?).
- **Settings** — Courses & semester, Keyboard and About sections (About shows
  which database features are available and which migration file a missing
  one needs); full **backup & restore** (restore always adds a copy, never
  overwrites); opt-in exam reminders.
- **Offline read mode** — the last Dashboard snapshot (today, open tasks,
  courses, upcoming exams) is kept on this device per user and shown when
  offline; it is cleared on sign-out.
- **Onboarding** — courses → weekly classes → first tasks → day → study
  style, all optional.
- **Demo Mode** — `dashboard.html?demo=1` (or "Explore the demo" on the login
  page) runs the whole app on sample data held in the browser tab. The real
  Supabase client is never created in demo mode.
- English, 简体中文 and 日本語 throughout; light and dark themes.

V3 runs on a database **without** its migrations too: V3-only pages show a
"needs a database update" note and everything from V2 keeps working.

## What's new in V2

V2 keeps every v1 feature and adds more control without turning the app
into a settings page — the main actions stay visible, advanced options sit
behind tabs, menus, and expandable panels.

- **Navigation** grouped as Home / Plan / Organize / Review / Account, plus
  a **command palette** (Ctrl K / ⌘K) and a **Quick add** button.
- **Week View** — Mon–Sun with classes, study time, deadlines, a workload
  summary, and per-day statuses; click a day to open it in the Planner.
- **Recurring classes** — days of week, time, date range; edit or skip a
  single occurrence. Occurrences are computed, never duplicated.
- **Advanced tasks** — tags (built-in + custom), subtasks, notes, compact
  cards that expand, and filters (All / Today / Upcoming / Overdue /
  Completed + subject / priority / tag + search).
- **Planning options & presets** — daily study cap and presets (Balanced,
  Exam Week, Catch-up, Deep Work, Busy Day, Light Day) with a preview of
  each one's effect before applying.
- **Manual control** — edit a block's start time (with ±15 min nudges) and
  its duration, lock blocks; every edit is checked against your day,
  classes, and other blocks.
- **Schedule conflicts panel** — overlapping classes, classes outside your
  day, study blocks that clash, locked-block conflicts, and not enough time,
  each with one clear action.
- **Focus Mode** — full-screen countdown with pause/resume, complete,
  finish early; logs real time through the existing completion model.
- **Planned vs Actual** — estimated vs planned vs actual time per subject.
- **Home** — Today, Recommended next (with a "Why:" list), Upcoming,
  Weekly Progress, a workload chart that flags heavy days, Quick Actions.
- **Insights** — completion rate, average block length, estimate accuracy,
  overdue work, sessions by status, study time by subject, strongest study
  period. Metrics with too little data say so instead of guessing.
- **Board** — node status, due date, estimate, Milestone type, goal and
  board progress; a node linked to a Planner task shows that task's real
  status (read-only — no sync loops).
- **Calendar page** — a week agenda of classes, recurring classes, imported
  `.ics` events, and study blocks, with All / Classes / Study / External
  filters; import/export live here.
- **History filters** — date range, subject, status; each day shows planned,
  completed, and carried-over minutes.
- **One status system** — Planned / In Progress / Done / Partial / Missed /
  Carried Over, with the same label, icon, and color everywhere.
- **Settings** in tabs (General / Appearance / Planner / Notifications /
  Calendar / Data), granular reminders (starts soon, due today / tomorrow,
  missed session), and **Export my data** (JSON).
- **First-run onboarding** — four short, skippable steps, then "Build my
  first plan". Never shown to existing users.
- **Accessibility & languages** — visible keyboard focus, reduced-motion
  support, labeled icon buttons, WCAG AA contrast; full English, Simplified
  Chinese, and Japanese, including dates and times.

V2 needs migrations 0005–0009 — see
[V2 migrations](#v2-migrations-0005-0009).

## Core Features

**Daily smart scheduling**
- Per-date schedules: wake/sleep time, meals, classes, study subjects, and
  study preferences, each date its own independent row.
- **Generate / Regenerate** — a pure, deterministic algorithm
  (`src/dashboard/scheduler.js`) places classes, meals, and study blocks
  around each other, honoring priority/due-date ordering, a preferred time
  of day as a soft preference, an earliest/latest study window as a hard
  boundary, and an overnight (past-midnight) bedtime.
- **Lock / Unlock** a study block so Regenerate never moves it.
- **Done / Undo** and **Partial Completion** — record exactly how many
  minutes of a block were actually completed, separate from how many were
  planned.
- An explicit **insufficient-time warning** (requested vs. scheduled vs.
  unscheduled minutes, per subject) instead of silently cramming or
  dropping work.

**Priority/deadline-aware planning**
- Study subjects carry priority (low/medium/high), an optional due date,
  and notes; Generate honors both when deciding what gets scheduled first.

**Multi-Day Planning**
- Spread one study task's minutes across several days ahead of its due
  date, respecting each day's real remaining capacity (classes, meals,
  locked blocks, other tasks already there); preview and adjust per-day
  minutes before accepting anything.

**Missed Work + Carry Over**
- Flag a block as **Missed** (a permanent audit record), then preview a
  plan to carry its remaining minutes to a future date before confirming
  anything — nothing moves without an explicit Accept. Respects the task's
  due date unless you explicitly extend it, and never re-carries minutes
  already carried or completed.

**Deterministic Smart Recommendations**
- Home's **Recommended Next** surfaces up to 3 tasks worth prioritizing
  today, each with plain-language reasons ("Due tomorrow", "Missed",
  "Carry over", "Fits today") derived from a transparent, additive scoring
  model (`src/dashboard/smartPriority.js`) — see
  [Smart Planning Without Paid AI](#smart-planning-without-paid-ai) below.
- The Study Tasks panel can sort by that same score (**Recommended**), or
  plainly by due date, priority, or remaining time.
- A small **Smart Insights** strip (tasks due within 3 days, missed minutes
  to recover, unfinished minutes this week) — every number is a real sum
  already computed elsewhere in the app, never an invented trend.
- **Quick Planning Templates** (Exam Week, Catch-up Day, Busy Day, Light
  Study Day, Project Work) apply a deterministic preset to a few existing
  Study Preferences fields (session length, break length, study window),
  with a preview of the exact fields that will change before you apply it.

**Visual Board**
- Multiple boards per account; a pan/zoom canvas of draggable Goal / Subject
  / Task / Note nodes connected by edges.
- Search, duplicate, collapse/expand a branch, Auto Arrange, Fit to Board.
- **Board Templates** — Exam Prep, Essay/Paper, and Project each create a
  new board with a ready-made root node and connected steps, laid out
  automatically.
- **Board → Planner** — convert any node directly into a real Planner study
  task, with a visible "already added" indicator so it's never duplicated.

**Analytics**
- This week's planned vs. completed minutes, completion rate, a
  per-subject breakdown (partial-completion-aware), upcoming deadlines with
  a deterministic risk classification, and a productivity-period insight —
  all computed from the same rows the Planner already writes, no duplicate
  data store.

**Calendar Import/Export**
- Export today or a date range to a standard `.ics` file; import an `.ics`
  file as fixed events, previewed before anything is saved.

**Notifications / PWA**
- Optional browser notifications for an upcoming study block or a
  due-today/due-tomorrow task.
- Installable as a Progressive Web App, with an offline indicator and a
  dedicated Settings page for install/appearance/language.

**Multilingual UI**
- English / Simplified Chinese / Japanese, switchable from the sidebar or
  Settings; the choice persists and applies everywhere, including the
  sign-up/login/password pages and every dynamically-rendered panel.

**Dark Mode**
- Follows the OS preference by default, or set Light/Dark/System
  explicitly from Settings.

### Smart Planning Without Paid AI

Every "smart" feature in this app — Recommended Next, its reasons, the
Recommended sort order, and Smart Insights — is **deterministic and
explainable**, not a call to a hosted AI model. A small, pure scoring
module (`src/dashboard/smartPriority.js`) adds up plain, named factors
already present in your own data:

- **Urgency** — how soon a task is due (overdue scores highest, then
  today/tomorrow/this week, tapering off further out; no due date is
  neutral, never a penalty).
- **Priority** — your own low/medium/high setting on the task.
- **Missed / carried-over state** — a task that was flagged Missed or has
  carried-over minutes gets a boost to resurface it.
- **Remaining workload** — how much is actually left (using logged partial
  completion, not the original planned duration), capped so one huge task
  can't automatically dominate every recommendation.
- **Fit** — whether the remaining work reasonably fits into today's actual
  free time, reusing the same "free" blocks the generated schedule already
  computes.

The same factors drive the short, plain-language reasons shown next to
each recommendation. Every run on the same input produces the same output
— there is no randomness and nothing is sent to a third-party model. See
`tests/smart-priority.test.js` for the exact, tested behavior of every
factor.

## Tech Stack

- **Frontend**: plain HTML/CSS/JavaScript (ES modules) — no framework, no
  client-side router
- **Build tool**: [Vite](https://vitejs.dev/) — a multi-page app, one entry
  point per `.html` file (see `vite.config.js`)
- **Backend**: [Supabase](https://supabase.com/) — Postgres, Auth, and Row
  Level Security; no custom server of any kind
- **PWA**: a hand-written service worker (`public/sw.js`) for an
  installable, offline-capable app shell
- **Tests**: plain Node scripts (`node:assert/strict`), no test-framework
  dependency

## Architecture

- **Frontend** — one plain HTML page per route (`index.html`, `login.html`,
  `signup.html`, `forgot-password.html`, `reset-password.html`,
  `dashboard.html`). `dashboard.html` is itself a single-page app shell:
  Planner, Board, Home/Analytics, and Settings are separate `<section>`s
  that `src/dashboard/dashboard.js` shows/hides — there's no router, no
  page reload between them.
- **Supabase** — the only backend. Every table has Row Level Security
  scoped to `auth.uid() = user_id`, enforced by Postgres itself; the
  frontend only ever holds the public **publishable** key (see
  [Security notes](#security-notes)).
- **Scheduler** (`src/dashboard/scheduler.js`) — the deterministic
  generation algorithm. It is the single source of truth for what a
  generated schedule looks like; nothing else (including Smart Priority)
  re-derives or overrides its output.
- **Smart Priority** (`src/dashboard/smartPriority.js`) and **Quick
  Templates** (`src/dashboard/quickTemplates.js`) — pure, DOM-free,
  Supabase-free modules. Smart Priority only ever *ranks or recommends*
  existing tasks; Quick Templates only ever adjusts a few existing Study
  Preferences fields. Neither one touches the scheduler's own logic.
- **Board** (`src/board/`) — a self-contained feature with its own data
  model (`boards`/`board_nodes`/`board_edges`) and its own pure model
  module (`boardModel.js`); the only bridge to the Planner is the explicit
  "Send to Planner" action.
- **Analytics** (`src/analytics/`) — read-only; it re-reads the same
  `schedules`/`schedule_items`/`study_subjects` rows the Planner already
  writes rather than keeping a second copy of anything.
- **Database / Migrations** — `supabase/schema.sql` first (creates
  `profiles`, `schedules`, `classes`, `study_subjects`, `schedule_items`),
  then `supabase/migrations/0001` through `0009` in order (see
  [Database structure](#database-structure) and
  [V2 migrations](#v2-migrations-0005-0009)). Every file is idempotent, so
  re-running one that's already applied is safe.

## Local Development

### 1. Prerequisites

- Node.js 18+ and npm
- A free [Supabase](https://supabase.com) account

### 2. Install

```
npm install
```

### 3. Create your Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project
   (the free tier is enough).
2. In the dashboard, go to **Project Settings -> API Keys** and copy the
   **Project URL** and the **publishable** key — NOT the **secret** key.

### 4. Configure environment variables

```
cp .env.example .env
```

Fill in these two variables in `.env` (values only — see
[`.env.example`](./.env.example) for where to find them in the Supabase
dashboard):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

`.env` is git-ignored and is never committed. Never put the
secret/service-role key here or anywhere in this project's frontend code.

### 5. Set up the database

Run each of these once, **in order**, in the Supabase dashboard's
**SQL Editor -> New query** (paste the whole file, click Run):

1. [`supabase/schema.sql`](./supabase/schema.sql)
2. [`supabase/migrations/0001_priority_deadline_preferences_lock.sql`](./supabase/migrations/0001_priority_deadline_preferences_lock.sql)
3. [`supabase/migrations/0002_boards.sql`](./supabase/migrations/0002_boards.sql)
4. [`supabase/migrations/0003_multi_day_planning.sql`](./supabase/migrations/0003_multi_day_planning.sql)
5. [`supabase/migrations/0004_missed_carry_over.sql`](./supabase/migrations/0004_missed_carry_over.sql)
6. [`supabase/migrations/0005_task_tags_subtasks.sql`](./supabase/migrations/0005_task_tags_subtasks.sql)
7. [`supabase/migrations/0006_recurring_classes.sql`](./supabase/migrations/0006_recurring_classes.sql)
8. [`supabase/migrations/0007_max_daily_study_minutes.sql`](./supabase/migrations/0007_max_daily_study_minutes.sql)
9. [`supabase/migrations/0008_board_node_status.sql`](./supabase/migrations/0008_board_node_status.sql)
10. [`supabase/migrations/0009_onboarding.sql`](./supabase/migrations/0009_onboarding.sql)
11. **V3 only, after review:** `0010_semesters.sql` → `0011_courses.sql` → `0012_grades.sql` → `0013_exams.sql` → `0014_task_extensions.sql` → `0015_resources.sql` → `0016_focus_sessions.sql` → `0017_profile_preferences.sql` (see [V3 migrations](#v3-migrations-0010-0017))
12. **V4 beta only, after review:** `0018_spaces.sql` (and later V4 files in order) — see [`docs/V4_PLAN.md`](./docs/V4_PLAN.md)

See [Database structure](#database-structure) for what each one adds, and
[V2 migrations](#v2-migrations-0005-0009) for the safety notes on 0005–0009.
`supabase/optional/` is **not** part of setup — see the 0009 notes below.

### 6. Configure Auth email links

In the Supabase dashboard, go to **Authentication -> URL Configuration**:

- **Site URL**: `http://localhost:5173`
- **Redirect URLs**: add `http://localhost:5173/reset-password.html`

When you deploy publicly, add that deployed URL's `/reset-password.html`
here too — you can list more than one.

### 7. Run it

```
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Development commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server (the service worker is skipped in dev — see [Known limitations](#known-limitations)) |
| `npm test` | Run the full automated test suite (see [Testing](#testing)) |
| `npm run build` | Production build to `dist/` (not committed) |
| `npm run preview` | Serve the production build locally, to sanity-check it before deploying |

## Testing

The scheduler, Smart Priority, Quick Templates, and every other piece of
planning/analytics logic live in pure JS modules with **no DOM and no
Supabase calls**, so they run and test independently of a browser or a
live database — 50 test files, 1,497 individual checks, all passing as of
this release.

```
npm test
```

| file | covers |
|---|---|
| `scheduler.test.js` | core generation: continuity, overnight bedtime, minimum-block handling, insufficient time, priority/deadline ordering, preferred study period, earliest/latest study window |
| `summary.test.js` | Daily Summary and shortfall-warning calculations |
| `lock-regenerate.test.js` | Lock/Unlock + Regenerate: locked blocks surviving regeneration, conflict detection |
| `completion.test.js` | Mark Done/Undo and per-subject completion progress |
| `history-navigation.test.js` | date arithmetic, History aggregation, per-date isolation |
| `copy-schedule.test.js` | what "Copy to another day" does and doesn't copy |
| `manual-edit.test.js` | manual start-time editing and its validation rules |
| `board-model.test.js` | Board node/edge validation, Board -> Planner conversion mapping |
| `board-templates.test.js` | Board template structure, edge-curve geometry |
| `analytics.test.js` | weekly totals, completion rate, subject breakdown, deadline risk, productivity period |
| `notifications.test.js` | reminder eligibility/timing, permission-state classification |
| `calendar.test.js` | `.ics` parsing/generation, import validation and size limits |
| `multi-day-planner.test.js` | day-capacity math and the multi-day allocation algorithm |
| `carry-over.test.js` | partial completion, missed blocks, carry-over allocation, no double-counting, due-date edge cases |
| `smart-priority.test.js` | every Smart Priority scoring factor, exclusions, tie-breaks, and reason generation |
| `quick-templates.test.js` | Quick Template field allow-list, preview accuracy, deterministic patches |
| `ai-breakdown.test.js`, `advisor.test.js` | validation logic for the optional/unused AI Edge Function integrations — see [Optional / Future Integrations](#optional--future-integrations) |

Anything that needs Supabase (`data.js`'s functions) is tested via a small
in-memory simulation of the same query shape, built on top of the *real*
pure logic those functions call internally.

Run this (and `npm run build`) before shipping any change.

### Database test (optional, not part of `npm test`)

`tests/db/migrations-pglite.mjs` applies `schema.sql` and every migration to
a throwaway in-memory Postgres 17 (PGlite) with a small Supabase auth shim,
re-applies 0010–0017 to prove they are idempotent, then acts as two users to
check RLS isolation, cross-user ownership triggers, the dependency-cycle
guard, CHECK constraints, unique indexes and delete cascades (93 checks).
It never connects to any real database:

```
npm i --no-save @electric-sql/pglite && node tests/db/migrations-pglite.mjs
```

It is stock Postgres, not Supabase, so a run on a Supabase staging project is
still the final check.

## Screenshots

> Screenshots have not been captured yet. Run the app locally (see
> [Local setup](#local-development) above), sign in, and add real captures
> here before sharing this project. See the recommended shot list and demo
> data suggestions the team put together for this — ask if you need it
> again.

| View | Screenshot |
|---|---|
| Home — populated dashboard | _add screenshot_ |
| Planner — generated full day | _add screenshot_ |
| Planner — partial/missed status | _add screenshot_ |
| Board — connected project nodes | _add screenshot_ |
| Board — template picker | _add screenshot_ |
| Smart Recommendations | _add screenshot_ |
| Insights / Analytics | _add screenshot_ |
| Dark mode | _add screenshot_ |

## Database structure

**`profiles`** — one row per user, created automatically on sign-up via a
database trigger.

**`schedules`** — one row per user per planned date (`for_date` is unique
per user). Holds wake/sleep time, meal settings, session/break/min-block
preferences, preferred study period, and the earliest/latest study window.

**`classes`** and **`study_subjects`** — the inputs for one schedule.
`study_subjects` additionally carries `priority`, `due_date`, `notes`, and
`origin_subject_id` (self-referencing — links a Multi-Day Planning chunk
back to the task it was split from; null for an ordinary task).

**`schedule_items`** — the generated output: every class, meal, study
block, break, and free-time block, with its type, name, and start/end time
in minutes since the start of the day. Study blocks additionally carry
`locked`, `completed`, `completed_minutes` (partial completion), `missed`,
`carried_over_minutes` (audit trail — how much of this block has already
been carried forward, so it's never double-carried), and
`source_subject_id` (which `study_subjects` row it was generated for).

**`boards`**, **`board_nodes`**, **`board_edges`** — the Visual Board,
fully independent of the scheduler. `board_nodes.linked_study_subject_id`
is the one intentional bridge: a nullable link set when a node is
converted into a Planner study task.

**`study_subject_subtasks`** (0005) — checklist items under a study task.
`study_subjects.tags` (0005) holds a task's tags as a JSON array.

**`class_series`** and **`class_series_exceptions`** (0006) — recurring
classes (days of week, time, date range) and per-date skip/edit overrides.
Occurrences are computed on the fly and never written into `classes`, so
loading a date can't create duplicate class rows. `classes.source` (0006)
records whether a class was typed (`manual`) or imported from `.ics`
(`imported`).

Every table has `user_id` and RLS policies scoped to
`auth.uid() = user_id` — enforced by Postgres itself, not just the app.

### V2 migrations 0005-0009

All five are **additive only**: they add tables or nullable/defaulted
columns and never drop, rename, retype, or delete anything. They are safe
to apply while the v1.x app is still deployed — v1 never reads the new
columns, and every new `NOT NULL` column has a default, so v1's inserts
keep working. `tests/migrations-safety.test.js` enforces these rules on
every file.

| File | Adds | Used by |
|---|---|---|
| `0005_task_tags_subtasks.sql` | `study_subjects.tags` (jsonb, default `[]`), table `study_subject_subtasks` | Task tags, subtasks, filters |
| `0006_recurring_classes.sql` | tables `class_series`, `class_series_exceptions`; `classes.source` (default `manual`) | Recurring classes, Calendar's External filter, `.ics` import tagging |
| `0007_max_daily_study_minutes.sql` | `schedules.max_daily_study_minutes` (nullable = no cap) | Planning Options daily study cap |
| `0008_board_node_status.sql` | `board_nodes.status` (default `planned`), `due_date`, `estimated_minutes`; widens the node-type check to allow `milestone` | Board status/due/estimate, Milestone nodes |
| `0009_onboarding.sql` | `profiles.onboarding_completed_at` (nullable, no default) | First-run onboarding remembers finish/skip across devices |

**Deploy order:** apply 0005 → 0009 *before* deploying the V2 frontend.
The V2 app degrades gracefully where it can (recurring-class reads and the
onboarding flag fall back if their columns/tables are missing), but saving
tags/subtasks, recurring classes, the daily cap, Board node details, and
`.ics` imports need their migrations.

**0009 and onboarding.** `0009` only adds the column — it writes to no
existing row. Existing users never see onboarding regardless: it is only
shown when the account has **no** classes or study tasks, the column is
empty, and this browser hasn't recorded a finish/skip. An optional one-time
backfill that marks every pre-existing profile as onboarded lives in
[`supabase/optional/0009b_onboarding_backfill_OPTIONAL.sql`](./supabase/optional/0009b_onboarding_backfill_OPTIONAL.sql).
It is **not required**, is not part of the migration sequence, and writes
to every profile row — only run it after an explicit decision that even
empty pre-existing accounts should skip onboarding.

### V3 migrations 0010-0017

**Not applied anywhere yet.** Run them by hand, in order, after review —
only after 0001–0009. All eight are additive: new tables, nullable or
defaulted columns, indexes, CHECK constraints, triggers and RLS. Nothing is
dropped, renamed, retyped, updated or deleted. `tests/migrations-v3.test.js`
enforces this, plus RLS (owner `user_id`, RLS on, select/insert/update/
delete-own policies) on every new table and an ownership trigger on every
V3 foreign key to a user-owned row (so a row can't point at someone else's
course/exam/task). No storage bucket is created.

| File | Adds | Used by |
|---|---|---|
| `0010_semesters.sql` | table `semesters`; function `v3_assert_owned_ref()` (security invoker ownership guard) | Semester page, current semester |
| `0011_courses.sql` | table `courses`; nullable `course_id` on `study_subjects`, `classes`, `class_series`, `boards`, `board_nodes` (ON DELETE SET NULL) | Courses everywhere |
| `0012_grades.sql` | tables `grade_categories`, `grade_items` | Grades |
| `0013_exams.sql` | tables `exams`, `exam_topics` | Exams, revision planner |
| `0014_task_extensions.sql` | table `task_recurrence_rules`, `task_dependencies` (no-cycle trigger); `study_subjects.completed_at`, `actual_minutes`, `dependency_override` (default false), `exam_topic_id`, `recurrence_rule_id`, `recurrence_date` | Tasks page, dependencies, recurring tasks |
| `0015_resources.sql` | table `resources` (links only, http/https enforced) | Course/task resources |
| `0016_focus_sessions.sql` | table `focus_sessions` | Focus history, estimate accuracy |
| `0017_profile_preferences.sql` | `profiles.preferences` jsonb (default `{}`, must be an object) | Account-wide daily study limit |

**Rollout order:** apply 0010 → 0017 in order, then deploy the V3 frontend.
Deploying V3 first is also safe (features appear as their migrations land);
the V2 (v1.x) frontend never reads any of these tables or columns.

## Deployment

This app is a **static, multi-page site** (Vite outputs plain `.html` +
hashed assets, no server-side rendering, no client-side router) that talks
only to Supabase — so it deploys cleanly to any static host.

- **Build command**: `npm run build`
- **Output directory**: `dist`
- **Environment variables to set on the host**: `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY` (same values as your local `.env`)
- **Routing**: no rewrite/redirect rules are required — every page is a
  real `.html` file Vite already emits, so there's no SPA fallback-routing
  to configure.
- **PWA**: the manifest's `start_url`/`scope` are both `/`, which works
  correctly as long as the app is deployed at the domain root; if deployed
  under a subpath, update `public/manifest.webmanifest` accordingly.

Before/after deploying, also add the deployed domain's
`/reset-password.html` to Supabase's **Authentication -> URL
Configuration -> Redirect URLs**, and update **Site URL** if this becomes
the primary deployment.

This project has no hosting provider configured yet — deploying is a
deliberate, explicit choice for you to make. Reasonable options for a
static Vite build like this one: **Vercel**, **Netlify**, or **Cloudflare
Pages** — any of the three needs only the build command, output directory,
and the two environment variables above.

Run `npm run build && npm run preview` locally first to sanity-check the
production build before pushing it live.

## Security notes

- Passwords are never handled by this app's own code or database —
  Supabase Auth manages them entirely.
- Only the **publishable** Supabase key is ever used in frontend code — it
  is safe to ship to the browser because every RLS policy still applies to
  every request it makes. The **secret**/**service-role** key is never
  used anywhere in this project.
- Imported `.ics` calendar files are size-capped (~2MB), capped at 500
  events, and every imported string is rendered via `textContent`, never
  `innerHTML` — an imported event title can never inject markup.
- `.env` is git-ignored; only `.env.example` (placeholder values) is
  committed. `.gitignore` also excludes `node_modules/`, `dist/`, `*.log`,
  and `.DS_Store`. Verified against the project's full git history: no
  `.env` file and no secret/service-role-shaped key has ever been
  committed.
- Every table has Row Level Security scoped to `auth.uid() = user_id`; no
  custom RPC/stored procedure is used anywhere, so this guarantee applies
  uniformly to every read and write, including multi-step ones like Copy
  to another day or Multi-Day Planning.
- Normal use of the product makes **zero requests to any AI provider** —
  see [Optional / Future Integrations](#optional--future-integrations).

## Known limitations

- The service worker (`public/sw.js`) is intentionally skipped in
  `npm run dev` (see `src/shared/pwa.js`) so local edits never get served
  from a stale cache; it only registers in a production build/deploy.
- Browser notifications only fire while the app is open in a tab; they
  cannot wake the device or fire when the tab/app is fully closed (a
  documented limitation shown to the user in Settings).
- Deadline risk on Home/Analytics uses each subject's full requested
  minutes as "remaining" (a subject can span multiple days' rows); it's a
  documented simplification, not an attempt to reconstruct exact
  partial-completion history across every one of a subject's blocks.
- There is no recurring-classes workflow — a class is entered per date,
  not as a weekly pattern.
- There is no Week View — the Planner is a single day at a time (plus
  Multi-Day Planning for spreading one task across several days).
- The Board is designed and tested for desktop; it remains usable on
  narrower screens but is not a distinct mobile layout.
- This has been verified with the full automated test suite and a
  production build; interactive/browser-based verification (clicking
  through the actual UI) should still be done manually against a real
  Supabase project before considering the app fully verified end to end.

## Optional / Future Integrations

Two Supabase Edge Functions (`supabase/functions/ai-advisor` and
`supabase/functions/board-ai-breakdown`) remain in the repository, along
with the frontend modules that would call them
(`src/advisor/`, `src/board/aiBreakdownClient.js`,
`src/board/aiBreakdownModel.js`). **The current product does not use or
require them** — they are not imported by any active page, no button in
the shipped UI calls them, and normal use of the app makes no request to
OpenAI or any other AI provider. They're kept only as optional,
not-currently-wired-up code for a possible future AI-assisted mode (a
chat-style study advisor, and AI-suggested Board subtasks), each behind
its own server-side Edge Function boundary so a future integration would
never expose a provider key to the browser.

## Future improvements

- A recurring-events model for classes (currently entered per date).
- A Week View alongside the current single-day Planner.
- Server-side (rather than tab-only) push notifications.
- Exporting/importing a full Board as a template.
- Wiring up the preserved optional AI Edge Functions above, if a future
  version wants an AI-assisted mode alongside the deterministic one.
