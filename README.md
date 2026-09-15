# Student Scheduler V2

A daily study/class scheduler with real accounts (Supabase Auth) and a real
database (Supabase Postgres), rebuilt from the original single-file Tomorrow
Scheduler. Plain HTML/CSS/JS, no frontend framework — one `.html` file per
page, served locally by Vite.

> Status: project scaffold, database schema, auth pages, and the dashboard
> (day settings, classes, study subjects, and schedule generation) are all
> built and wired to Supabase. The scheduling algorithm (`src/dashboard/scheduler.js`)
> is pure JS with its own Node test — see [Testing](#testing) below. Not yet
> done: manual verification against a live Supabase project, and any
> in-browser end-to-end testing.

## 1. Create your Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project (free
   tier is enough).
2. Wait for it to finish provisioning.
3. In the dashboard, go to **Project Settings -> API Keys** and copy:
   - **Project URL**
   - **publishable** key (NOT the **secret** key — never use that one here)

## 2. Configure this project

1. Copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
2. Paste your Project URL and publishable key into `.env`.
3. `.env` is already listed in `.gitignore` — it will never be committed.

## 3. Set up the database

1. In the Supabase dashboard, open **SQL Editor -> New query**.
2. Paste in the entire contents of [`supabase/schema.sql`](./supabase/schema.sql).
3. Click **Run**.

This creates the `profiles`, `schedules`, `classes`, `study_subjects`, and
`schedule_items` tables, turns on Row Level Security on all of them, and adds
a trigger that automatically creates a `profiles` row whenever someone signs
up. See [Database structure](#database-structure) below for details.

## 4. Configure Auth email links (needed for password reset)

In the Supabase dashboard, go to **Authentication -> URL Configuration**:

- **Site URL**: `http://localhost:5173` (Vite's default dev port)
- **Redirect URLs**: add `http://localhost:5173/reset-password.html`

When you eventually deploy this somewhere public, add that URL too (e.g.
`https://your-site.com/reset-password.html`) — you can list more than one.

## 5. Install and run

```
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`).

## Testing

`src/dashboard/scheduler.js` is the scheduling algorithm — pure JS, no DOM
and no Supabase calls, so it runs and tests independently of the rest of the
app. There's a plain Node test (no framework/dependency needed) that checks
it against a realistic day (two classes, three meals, two study subjects,
an after-midnight bedtime) and asserts: fixed-length study blocks stay
continuous, nothing overlaps a class or meal, nothing is scheduled past
bedtime, and the full generated schedule has zero overlaps anywhere.

```
npm test
```

Before shipping a change to `scheduler.js`, run `npm test` and confirm it
still passes.

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

**`schedules`** — one row per planned day.
| column | meaning |
|---|---|
| `user_id` | owner |
| `for_date` | the date this plan is for |
| `wake_time` / `sleep_time` | day boundaries (bedtime can be past midnight) |
| `breakfast_on/time`, `lunch_on/time`, `dinner_on/time` | meal settings |
| `session_cap_minutes`, `stamina_break_minutes`, `switch_break_minutes`, `min_block_minutes` | scheduling preferences |

**`classes`** and **`study_subjects`** — the inputs for one schedule (each
row points at a `schedule_id`).

**`schedule_items`** — the generated output for one schedule: every class,
meal, study block, break, and free-time block with its type, name, and
start/end time in minutes since the start of the day.

Every table has `user_id` and Row Level Security policies that only allow a
user to read/insert/update/delete rows where `user_id = auth.uid()` — so one
account can never see another account's data, enforced by the database
itself (not just by the app's UI).

## Security notes

- Passwords are never handled by this app's own code or database — Supabase
  Auth manages them entirely (hashing, storage, reset flow).
- The `secret` key is never used here — only the `publishable` key, which is
  safe to ship to the browser because RLS policies still apply to it.
- `.env` is git-ignored; only `.env.example` (with placeholder values) is
  committed.
- This project is a git repository. `.gitignore` excludes `.env`, `node_modules/`,
  `dist/`, `*.log`, and `.DS_Store` — no local or sensitive files are tracked.
