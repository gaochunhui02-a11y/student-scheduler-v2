# Student Scheduler V2

A daily study/class planner with real accounts (Supabase Auth) and a real
database (Supabase Postgres). Plain HTML/CSS/JS, no frontend framework —
one `.html` file per page, served locally by Vite. You describe your day
(wake/sleep time, classes, meals, what you need to study and how urgently),
click **Generate Schedule**, and it builds a realistic timeline around your
fixed commitments — then keeps it in sync with Supabase as you lock blocks,
mark things done, or come back on a different day.

## Status

All planned phases are complete and covered by the automated test suite
(see [Testing](#testing)). This has been verified with `npm test` and
`npm run build`, but **not yet exercised against a live Supabase project or
in a browser** — see [What's not verified yet](#whats-not-verified-yet).

## Features

- **Real accounts** — sign up, log in, log out, forgot/reset password, all
  via Supabase Auth. Passwords are never touched by this app's own code.
- **Per-date schedules** — every calendar date you plan for is its own
  independent row: its own wake/sleep time, meals, classes, study subjects,
  study preferences, and generated schedule. Navigate with **Previous /
  Next day** or the date picker; nothing about one date ever leaks into
  another.
- **Classes & study subjects** — classes are fixed time blocks; study
  subjects have a name, requested minutes, **priority** (low/medium/high),
  an optional **due date**, and optional **notes**.
- **Study preferences** — preferred study time of day (morning/afternoon/
  evening/none), maximum study session length, break length, minimum study
  block, and an earliest/latest study-time window, all per date.
- **Generate / Regenerate Schedule** — the algorithm (`src/dashboard/scheduler.js`,
  pure JS with no DOM/Supabase dependency) places classes, meals, and study
  blocks around each other. It considers priority and due date (higher
  priority and earlier deadlines get first claim on the best time), honors
  the preferred-study-time as a soft preference, respects the earliest/
  latest study window as a hard boundary, keeps study sessions continuous
  instead of fragmenting them unnecessarily, and correctly handles a
  bedtime after midnight. **Regenerate** re-runs this while leaving locked
  study blocks exactly where they are and recalculating everything else
  around them.
- **Lock / Unlock** — pin a generated study block in place so Regenerate
  will never move it (and won't let anything else overlap it either).
- **Mark Done / Undo** — track completion per study block; a subject counts
  as done only once every one of its scheduled blocks is.
- **Manual adjustment** — move an unlocked study block to a different start
  time by hand, validated against every rule Generate itself follows
  (wake/bedtime, the study-time window, class/meal/other-study-block
  overlaps) before it's allowed to save.
- **Daily Summary** — class/study/meal/break/free/awake/sleep time and
  study-completion progress, computed directly from the generated timeline.
- **Insufficient-time warning** — if requested study time doesn't fit, the
  app says so explicitly (requested vs. scheduled vs. unscheduled, per
  affected subject) instead of silently cramming in unrealistic blocks.
- **History** — every date with at least one class, subject, or study block
  is listed with its class/subject counts and completion %; click one to
  open it.
- **Copy to another day** — copy one date's planning inputs (day settings,
  meals, classes, subjects, study preferences) to a different date. Never
  copies the generated schedule, lock state, or completion state, and asks
  for confirmation before overwriting a destination that already has data.

## Tech stack

- **Frontend**: plain HTML/CSS/JavaScript (ES modules), no framework
- **Build tool**: [Vite](https://vitejs.dev/) — multi-page app, one entry
  point per `.html` file (see `vite.config.js`)
- **Backend**: [Supabase](https://supabase.com/) — Postgres database, Auth,
  and Row Level Security; no custom server of any kind
- **Tests**: plain Node scripts (`node:assert/strict`), no test framework
  dependency — see [Testing](#testing)

## 1. Create your Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project (free
   tier is enough).
2. Wait for it to finish provisioning.
3. In the dashboard, go to **Project Settings -> API Keys** and copy:
   - **Project URL**
   - **publishable** key (NOT the **secret** key — never use that one here)

## 2. Configure this project (environment variables)

1. Copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
2. Fill in the two variables in `.env`:
   - `VITE_SUPABASE_URL` — your project's URL
   - `VITE_SUPABASE_PUBLISHABLE_KEY` — the **publishable** key (never the
     secret/service-role key — see [Security notes](#security-notes))
3. `.env` is git-ignored; it will never be committed. `.env.example` (with
   placeholder values only) is the one that's tracked.

## 3. Set up the database

The schema was built up across two SQL files — run both, in order, once
each, the first time you set up a project:

1. In the Supabase dashboard, open **SQL Editor -> New query**.
2. Paste in the entire contents of [`supabase/schema.sql`](./supabase/schema.sql)
   and click **Run**. This creates the `profiles`, `schedules`, `classes`,
   `study_subjects`, and `schedule_items` tables, turns on Row Level
   Security on all of them, and adds a trigger that automatically creates a
   `profiles` row whenever someone signs up.
3. Open another **New query**, paste in the entire contents of
   [`supabase/migrations/0001_priority_deadline_preferences_lock.sql`](./supabase/migrations/0001_priority_deadline_preferences_lock.sql),
   and click **Run**. This adds priority/due date/notes to `study_subjects`;
   preferred study period and earliest/latest study time to `schedules`;
   and locked/completed/source_subject_id to `schedule_items`. See that
   file's own comments for exactly what it adds and why — it's safe to run
   even against a database that already has real rows in it.

See [Database structure](#database-structure) below for what each table is
for. If any future change needs a schema change, it'll be a new file under
`supabase/migrations/` rather than an edit to `schema.sql` or migration
`0001` — treat both as historical record of what's already been applied.

## 4. Configure Auth email links (needed for password reset)

In the Supabase dashboard, go to **Authentication -> URL Configuration**:

- **Site URL**: `http://localhost:5173` (Vite's default dev port)
- **Redirect URLs**: add `http://localhost:5173/reset-password.html`

When you eventually deploy this somewhere public, add that URL too (e.g.
`https://your-site.com/reset-password.html`) — you can list more than one.

## 5. Install and run locally

```
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`).

## Testing

The scheduling algorithm and everything derived from it live in pure JS
modules under `src/dashboard/` with **no DOM and no Supabase calls** —
`scheduler.js`, `summary.js`, `copySchedule.js`, `dateUtils.js`, and
`history.js` — so they run and test independently of the browser or a live
database. `tests/` has one plain Node script per area (no test-framework
dependency, just `node:assert/strict`):

| file | covers |
|---|---|
| `scheduler.test.js` | core generation: continuity, overnight bedtime, minimum-block handling, insufficient time, priority/deadline ordering, preferred study period, earliest/latest study window |
| `summary.test.js` | Daily Summary and shortfall-warning calculations against the actual generated timeline |
| `lock-regenerate.test.js` | Lock/Unlock + Regenerate: locked blocks surviving regeneration, conflict detection, subject-minute accounting around a lock |
| `completion.test.js` | Mark Done/Undo and per-subject completion progress |
| `history-navigation.test.js` | date arithmetic, History list aggregation, and per-date data isolation (see note below) |
| `copy-schedule.test.js` | what "Copy to another day" does and doesn't copy, fresh ids, unchanged due dates, existing-destination confirmation |
| `manual-edit.test.js` | manual start-time editing and its validation rules, including an overnight edit |

Some of these (`data.js`'s Supabase-backed functions can't be imported by a
plain Node script — they require a live Vite/Supabase environment) are
tested via a small in-memory simulation of the same query shape, built on
top of the *real* pure logic those functions call internally. Each such
file says so at the top.

```
npm test
```

Before shipping a change to any of the pure modules above, run `npm test`
and confirm it still passes.

## Building for production

```
npm run build
```

Outputs a static site to `dist/` (not committed — see `.gitignore`).

## Database structure

**`profiles`** — one row per user, created automatically on sign-up via a
database trigger (never inserted by the app itself).
| column | meaning |
|---|---|
| `id` | same as the user's Supabase Auth ID |
| `name` | the name entered at sign-up |

**`schedules`** — one row per user per planned date (`for_date` is unique
per user — this is what makes per-date isolation and "get or create for
this date" work).
| column | meaning |
|---|---|
| `user_id` | owner |
| `for_date` | the date this plan is for |
| `wake_time` / `sleep_time` | day boundaries (bedtime can be past midnight) |
| `breakfast_on/time`, `lunch_on/time`, `dinner_on/time` | meal settings |
| `session_cap_minutes`, `stamina_break_minutes`, `switch_break_minutes`, `min_block_minutes` | scheduling preferences |
| `preferred_study_period` | `none` / `morning` / `afternoon` / `evening` *(migration 0001)* |
| `earliest_study_time` / `latest_study_time` | study-only time window, separate from wake/sleep *(migration 0001)* |

**`classes`** and **`study_subjects`** — the inputs for one schedule (each
row points at a `schedule_id`). `study_subjects` additionally has
`priority` (`low`/`medium`/`high`), `due_date`, and `notes` *(migration 0001)*.

**`schedule_items`** — the generated output for one schedule: every class,
meal, study block, break, and free-time block, with its type, name, and
start/end time in minutes since the start of the day. Also `locked` and
`completed` (study blocks only) and `source_subject_id` (links a study
block back to the `study_subjects` row it was generated for) *(migration 0001)*.

Every table has `user_id` and Row Level Security policies that only allow a
user to read/insert/update/delete rows where `user_id = auth.uid()` — so one
account can never see another account's data, enforced by the database
itself (not just by the app's UI). No custom RPC/stored procedure is used
anywhere, so this same RLS guarantee applies uniformly to every read and
write the app makes, including multi-step ones like Copy to another day.

## Security notes

- Passwords are never handled by this app's own code or database — Supabase
  Auth manages them entirely (hashing, storage, reset flow).
- The **secret**/**service-role** key is never used here, anywhere — only
  the **publishable** key, which is safe to ship to the browser because RLS
  policies still apply to every request it makes. If you ever add a feature
  that seems to need the secret key, it almost certainly needs a server-side
  component instead; this app intentionally has none.
- `.env` is git-ignored; only `.env.example` (with placeholder values) is
  committed. `.gitignore` also excludes `node_modules/`, the `dist/` build
  output, `*.log` files, and `.DS_Store`.
- This project is a git repository with every phase of its build history
  committed. No secret/service-role key or other credential has ever been
  committed — verified by searching the full git history for `.env` and for
  service-role/secret-key patterns.

## What's not verified yet

Everything above has been checked with the automated test suite and a
production build, but not against a live Supabase project or in an actual
browser session — that would need someone with real Supabase credentials
and a browser to click through the app once end-to-end (create a class,
generate a schedule, lock a block, regenerate, mark something done, switch
dates, copy a day, refresh the page) and confirm it looks and behaves as
expected.
