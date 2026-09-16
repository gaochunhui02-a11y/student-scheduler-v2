# Student Scheduler V2

A full-stack daily study/class planner with real accounts (Supabase Auth), a
real database (Supabase Postgres + Row Level Security), a deterministic
scheduling algorithm, a visual planning Board, an AI study advisor, and a
Dashboard/Analytics view — built as plain HTML/CSS/JavaScript (ES modules),
no frontend framework. You describe your day (wake/sleep time, classes,
meals, what you need to study and how urgently), click **Generate
Schedule**, and it builds a realistic timeline around your fixed
commitments — then keeps it in sync with Supabase as you lock blocks, mark
things done or partially done, miss a session and carry the rest forward,
plan a big task across several days, or come back on a different date.

## Screenshots

> Add screenshots here before sharing this project — a quick way is to run
> the app locally (see [Local setup](#local-setup) below), sign in, and
> capture each view.

| View | Screenshot |
|---|---|
| Planner (day view + generated schedule) | _add screenshot_ |
| Visual Board | _add screenshot_ |
| AI Advisor | _add screenshot_ |
| Dashboard / Analytics | _add screenshot_ |
| Dark mode | _add screenshot_ |

## Features

**Accounts & security**
- Sign up, log in, log out, forgot/reset password — all via Supabase Auth.
  This app's own code never touches a password.
- Every table has Row Level Security scoped to `auth.uid() = user_id`, so
  one account can never read or write another account's data, enforced by
  the database itself, not just the UI.

**Planner & daily scheduling**
- **Per-date schedules** — every calendar date is its own independent row
  (wake/sleep time, meals, classes, study subjects, preferences, generated
  schedule). Navigate with Previous/Next or the date picker.
- **Classes & study subjects** — classes are fixed time blocks; study
  subjects have a name, requested minutes, priority (low/medium/high), an
  optional due date, and notes.
- **Study preferences** — preferred time of day, max session length, break
  length, minimum study block, and an earliest/latest study-time window.
- **Generate / Regenerate** — a pure, deterministic algorithm
  (`src/dashboard/scheduler.js`) places classes, meals, and study blocks
  around each other, honoring priority/due date ordering, the preferred
  time of day as a soft preference, the study window as a hard boundary,
  and an overnight (past-midnight) bedtime. Regenerate leaves locked blocks
  exactly where they are.
- **Lock / Unlock** a study block so Regenerate never moves it.
- **Done / Undo** and **Partial Completion** — record exactly how many
  minutes of a block you actually completed, separate from how many were
  planned; a partial block is never misreported as fully done.
- **Missed + Auto Carry Over** — flag a block as missed (a permanent audit
  record) and preview a plan to carry its remaining minutes to a future
  date before confirming anything; nothing moves without an explicit
  Accept. Respects the task's due date unless you explicitly extend it, and
  never re-carries minutes that were already carried or completed.
- **Manual Edit** — move an unlocked block to a new start time, validated
  against every rule Generate itself follows.
- **Smart Multi-Day Planning** — spread a study task's minutes across
  several days ahead of its due date, respecting each day's real remaining
  capacity (classes, meals, locked blocks, other tasks); preview and adjust
  per-day minutes before accepting.
- **Daily Summary** and an explicit **insufficient-time warning** (requested
  vs. scheduled vs. unscheduled, per subject) instead of silently cramming.
- **Copy to another day** and **History** (every touched date, with counts
  and completion %, one click to reopen).
- **Calendar Import/Export (.ics)** — export today or a date range to a
  standard calendar file; import an `.ics` file as fixed events, previewed
  before anything is saved.

**Visual Board**
- Multiple boards per user; a pan/zoom canvas of draggable nodes (Goal /
  Subject / Task / Note) connected by edges.
- Search, duplicate, collapse/expand, auto-arrange, fit-to-board.
- Convert a Board node directly into a Planner study task.
- **AI Breakdown** — ask AI to split a Board node into smaller subtasks
  (via a secure server-side Edge Function — see [Security notes](#security-notes)).

**AI Student Advisor**
- A chat-style advisor that answers study-planning questions and can
  suggest concrete tasks with a title/minutes/priority/due date — you
  review and explicitly confirm before anything is added to the Planner or
  Board. The AI never creates or modifies anything on its own.

**Dashboard / Analytics**
- This-week planned vs. completed minutes, completion rate, per-subject
  breakdown (now partial-completion-aware), upcoming deadlines with a
  deterministic (non-AI) risk classification, and a productivity-period
  insight — all computed from the same rows the Planner already writes, no
  duplicate data store.

**Notifications & PWA**
- Optional browser notifications for an upcoming study block or a
  due-today/due-tomorrow task (a block flagged Missed is excluded).
- Installable as a Progressive Web App, with an offline indicator.

**Other**
- **Translations** — English / Simplified Chinese / Japanese, switchable
  anywhere in the app; the choice persists and now also applies to the
  sign-up/login/password pages.
- **Dark mode**, following the OS preference or an explicit per-viewer
  toggle.

## Tech stack

- **Frontend**: plain HTML/CSS/JavaScript (ES modules), no framework
- **Build tool**: [Vite](https://vitejs.dev/) — a multi-page app, one entry
  point per `.html` file (see `vite.config.js`)
- **Backend**: [Supabase](https://supabase.com/) — Postgres, Auth, Row
  Level Security, and two Edge Functions (Deno) for the AI features; no
  custom server of any kind
- **AI provider**: OpenAI (`gpt-4o-mini`), called only from the two Edge
  Functions, never from the browser
- **Tests**: plain Node scripts (`node:assert/strict`), no test-framework
  dependency

## Local setup

### 1. Prerequisites

- Node.js 18+ and npm
- A free [Supabase](https://supabase.com) account
- (Optional, for AI features) an [OpenAI](https://platform.openai.com) API
  key and the [Supabase CLI](https://supabase.com/docs/guides/cli)

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

Fill in the two variables in `.env`:

| Variable | Where to find it |
|---|---|
| `VITE_SUPABASE_URL` | Project Settings -> API Keys -> Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Project Settings -> API Keys -> publishable key |

`.env` is git-ignored and will never be committed — see
[Security notes](#security-notes). Never put the secret/service-role key
here or anywhere in this project's frontend code.

### 5. Set up the database

Run each of these once, **in order**, in the Supabase dashboard's
**SQL Editor -> New query** (paste the whole file, click Run):

1. [`supabase/schema.sql`](./supabase/schema.sql) — creates `profiles`,
   `schedules`, `classes`, `study_subjects`, `schedule_items`, enables RLS
   on all of them, and adds the sign-up trigger that creates a `profiles`
   row.
2. [`supabase/migrations/0001_priority_deadline_preferences_lock.sql`](./supabase/migrations/0001_priority_deadline_preferences_lock.sql)
   — priority/due date/notes on study subjects; preferred study period and
   earliest/latest study time; lock/completed/source-subject linking on
   generated blocks.
3. [`supabase/migrations/0002_boards.sql`](./supabase/migrations/0002_boards.sql)
   — the Visual Board data model (`boards`, `board_nodes`, `board_edges`),
   fully independent of the scheduler.
4. [`supabase/migrations/0003_multi_day_planning.sql`](./supabase/migrations/0003_multi_day_planning.sql)
   — adds `study_subjects.origin_subject_id`, linking a task's per-date
   chunks back to the original row for Smart Multi-Day Planning.
5. [`supabase/migrations/0004_missed_carry_over.sql`](./supabase/migrations/0004_missed_carry_over.sql)
   — adds `completed_minutes`, `missed`, and `carried_over_minutes` to
   generated blocks for partial completion and Carry Over.

Every file is idempotent (`if not exists` / guarded policy creation), so
re-running one against a database that already has it applied is safe. See
[Database structure](#database-structure) for what each table is for.

### 6. Configure Auth email links

In the Supabase dashboard, go to **Authentication -> URL Configuration**:

- **Site URL**: `http://localhost:5173`
- **Redirect URLs**: add `http://localhost:5173/reset-password.html`

When you deploy publicly, add that deployed URL's `/reset-password.html`
here too — you can list more than one.

### 7. (Optional) Set up the AI features

The AI Advisor and AI Breakdown features run entirely in two Supabase Edge
Functions under [`supabase/functions/`](./supabase/functions/) — the
frontend never talks to OpenAI directly and never sees the key. Skip this
step if you don't need AI features; the rest of the app works without it
(the AI-only buttons will show a "service unavailable" message).

```
# one-time login/link, if you haven't already
supabase login
supabase link --project-ref YOUR-PROJECT-REF

# set the shared secret both functions read
supabase secrets set OPENAI_API_KEY=sk-...your-key...

# deploy both functions
supabase functions deploy ai-advisor
supabase functions deploy board-ai-breakdown
```

Both functions require a real, authenticated Supabase session on every
request (checked server-side) so the key can never be used as an open
proxy, even though the key itself is never exposed either way.

### 8. Run it

```
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Development commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server |
| `npm test` | Run the full automated test suite (see [Testing](#testing)) |
| `npm run build` | Production build to `dist/` (not committed) |
| `npm run preview` | Serve the production build locally, to sanity-check it before deploying |

## Testing

The scheduling algorithm and everything derived from it live in pure JS
modules with **no DOM and no Supabase calls**, so they run and test
independently of a browser or a live database:

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
| `ai-breakdown.test.js` | AI Breakdown request/response validation (the AI trust boundary) |
| `advisor.test.js` | AI Advisor context building and response validation (the AI trust boundary) |
| `analytics.test.js` | weekly totals, completion rate, subject breakdown, deadline risk, productivity period |
| `notifications.test.js` | reminder eligibility/timing, permission-state classification |
| `calendar.test.js` | `.ics` parsing/generation, import validation and size limits |
| `multi-day-planner.test.js` | day-capacity math and the multi-day allocation algorithm |
| `carry-over.test.js` | partial completion, missed blocks, carry-over allocation, no double-counting, due-date edge cases |

Anything that needs Supabase (`data.js`'s functions) is tested via a small
in-memory simulation of the same query shape, built on top of the *real*
pure logic those functions call internally — each such test file says so
at the top.

```
npm test
```

Run this (and `npm run build`) before shipping any change.

## Database structure

**`profiles`** — one row per user, created automatically on sign-up via a
database trigger.

**`schedules`** — one row per user per planned date (`for_date` is unique
per user). Holds wake/sleep time, meal settings, session/break/min-block
preferences, preferred study period, and the earliest/latest study window.

**`classes`** and **`study_subjects`** — the inputs for one schedule.
`study_subjects` additionally carries `priority`, `due_date`, `notes`, and
`origin_subject_id` (self-referencing — links a Smart Multi-Day Planning
chunk back to the task it was split from; null for an ordinary task).

**`schedule_items`** — the generated output: every class, meal, study
block, break, and free-time block, with its type, name, and start/end time
in minutes since the start of the day. Study blocks additionally carry
`locked`, `completed`, `completed_minutes` (partial completion),
`missed`, `carried_over_minutes` (audit trail — how much of this block has
already been carried forward, so it's never double-carried), and
`source_subject_id` (which `study_subjects` row it was generated for).

**`boards`**, **`board_nodes`**, **`board_edges`** — the Visual Board,
fully independent of the scheduler. `board_nodes.linked_study_subject_id`
is the one intentional bridge: a nullable link set when a node is
converted into a Planner study task.

Every table has `user_id` and RLS policies scoped to
`auth.uid() = user_id` — enforced by Postgres itself, not just the app.

## Demo workflow

A short flow to show off the app end-to-end:

1. Sign up, then land on the Planner for tomorrow.
2. Add a class or two, and one study task (e.g. "Calculus", 90 minutes,
   high priority, due in a few days).
3. Click **Generate Schedule** — see the class, the study block, and free
   time laid out around your wake/sleep time.
4. Log 40 minutes of **Partial Completion** on the study block, then click
   **Carry Over** to preview moving the remaining 50 minutes to a later
   day before the due date, and confirm it.
5. Switch to the **Board**, create a node for a bigger goal (e.g. "Midterm
   prep"), add a couple of child task nodes, connect them.
6. Convert one Board node into a Planner study task.
7. Open the **AI Advisor** and ask "What should I study today?" — review
   its suggestion and explicitly add it to the Planner.
8. Open **Dashboard / Analytics** to see this week's planned vs. completed
   time and the upcoming-deadline risk list.
9. Toggle dark mode and switch the language (EN / 简体中文 / 日本語) from
   the sidebar to see the whole app re-render translated.

## Deployment readiness

This app is a **static, multi-page site** (Vite outputs plain `.html` +
hashed assets, no server-side rendering, no client-side router) that talks
only to Supabase — so it deploys cleanly to any static host. Recommended,
in order of simplicity for this project: **Vercel**, **Netlify**, or
**Cloudflare Pages**. All three:

- Build command: `npm run build`
- Output directory: `dist`
- Environment variables to set on the host: `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY` (same values as your local `.env`)
- No rewrite/redirect rules are required — every page is a real `.html`
  file Vite already emits (`index.html`, `login.html`, `signup.html`,
  `forgot-password.html`, `reset-password.html`, `dashboard.html`), so
  there's no SPA fallback-routing to configure.

Before/after deploying, also:

- Add the deployed domain's `/reset-password.html` to Supabase
  **Authentication -> URL Configuration -> Redirect URLs**, and update
  **Site URL** if this becomes the primary deployment.
- Deploy the two Edge Functions (`supabase functions deploy ai-advisor` /
  `board-ai-breakdown`) and set `OPENAI_API_KEY` via `supabase secrets set`
  if you want the AI features live — this is independent of where the
  frontend itself is hosted.
- The PWA manifest's `start_url`/`scope` are both `/`, which works
  correctly as long as the app is deployed at the domain root (not a
  subpath); if you deploy under a subpath, update
  `public/manifest.webmanifest` accordingly.
- Run `npm run build && npm run preview` locally first to sanity-check the
  production build before pushing it live.

This project has **not** been deployed automatically as part of this
phase — deploying is a deliberate, explicit action for you to take
whenever you're ready.

## Security notes

- Passwords are never handled by this app's own code or database —
  Supabase Auth manages them entirely.
- Only the **publishable** Supabase key is ever used in frontend code — it
  is safe to ship to the browser because every RLS policy still applies to
  every request it makes. The **secret**/**service-role** key is never
  used anywhere in this project.
- The AI provider key (`OPENAI_API_KEY`) lives only in Supabase Edge
  Function secrets (Deno server-side environment) — never in a Vite env
  var (those are all exposed to the client), never committed. Both AI
  Edge Functions additionally require a real, authenticated Supabase
  session before calling the provider, so the key can't be used as an
  open proxy even by someone with just the project's public anon key.
- Every AI response is validated (shape, length caps, allowed enum values)
  before it is ever rendered or used — and even then, nothing is created
  or modified until the student explicitly clicks to confirm a specific
  suggestion. There is no path from a raw AI response straight into the
  database.
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
  to another day or Smart Multi-Day Planning.

## Known limitations

- The AI Advisor and AI Breakdown features require the two Supabase Edge
  Functions to be deployed with a valid `OPENAI_API_KEY` secret — without
  that, the buttons remain visible but show a "service unavailable"
  message rather than being hidden.
- Browser notifications only fire while the app is open in a tab; they
  cannot wake the device or fire when the tab/app is fully closed (a
  documented limitation shown to the user in the Notifications settings).
- Translations cover all static UI chrome and every dynamically-rendered
  Phase 9+ feature panel (Board, Advisor, Analytics, Notifications,
  Calendar, Multi-Day Planning, Carry Over, and now the auth pages);
  a handful of the original Planner timeline's inline action labels (e.g.
  the schedule block's own Lock/Edit/Save/Cancel buttons, predating the
  translation system) are still English-only — a cosmetic gap, not a
  functional one.
- This has been verified with the full automated test suite and a
  production build, but not against a live Supabase project inside an
  actual browser session in this environment — see the
  [Demo workflow](#demo-workflow) above for the exact click-through to
  verify manually once you have real Supabase credentials configured.
- Deadline risk on the Dashboard uses each subject's full requested
  minutes as "remaining" (a subject can span multiple days' rows); it's a
  documented simplification, not an attempt to reconstruct exact
  partial-completion history across every one of a subject's blocks.

## Future improvements

- Extend translation coverage to the remaining untranslated inline
  Planner timeline action labels noted above.
- A recurring-events model for classes (currently entered per date).
- Server-side (rather than tab-only) push notifications.
- Exporting/importing a full Board as a template.
- Optional support for an alternate AI provider via the same Edge
  Function boundary (no frontend change would be needed).
