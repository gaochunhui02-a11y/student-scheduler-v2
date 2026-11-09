# Student Scheduler V5 — Commercial Upgrade plan

> **Promise:** "Your semester, planned automatically — and fixed when life changes."

Branch `v5-commercial-upgrade`, cut from `v4-productivity-os` at `b5c5ad2`
(V4-J). `master` (= `v3.0.0`, `307e9dc`) is a strict ancestor of that commit
and is never modified, merged into, or force-pushed. Nothing is deployed to
production and no production setting changes. Migrations are files only; the
owner applies them after review.

---

## 0. Audit (2026-11-09)

### 0.1 Branches

| Branch | Head | Notes |
|---|---|---|
| `master` | `307e9dc` (`v3.0.0`) | Stable production (V3). Ancestor of V4. |
| `v4-productivity-os` | `b5c5ad2` | V4 complete (A–J), 11 commits ahead of master, 0 behind. Not tagged, not deployed; migrations 0018–0026 not applied anywhere. |
| `v5-commercial-upgrade` | from `b5c5ad2` | This work. |

`master..v4` diff is purely additive: new modules (`src/today`, `src/projects`,
`src/goals`, `src/routines`, `src/review`, `src/attendance`, `src/notes`,
`src/focus`, `src/workspace`, …), migrations 0018–0026, tests, README/plan.

### 0.2 Baseline verification (run, not assumed)

* `npm test` — all 60 test files pass (V4-J reported 1778 assertions).
* `npm run build` — succeeds (one >500 kB chunk warning: the V2 dashboard bundle).
* PGlite migration test (`tests/db/migrations-pglite.mjs`) — passed 271/271 at V4-J; re-run each milestone.

### 0.3 Architecture (unchanged in V5)

Vanilla JS + Vite multi-page build (`index`, `login`, `signup`, password pages,
`dashboard`), Supabase Auth + Postgres with RLS on every table, Vercel static
hosting. One `dashboard.html` with a section per page, a hash router, a
context bus, a cached store, a small UI kit (`src/ui`), a capability probe so
the app degrades on a database missing newer migrations, an in-memory demo
client (`?demo=1`) that never creates a real Supabase client, and en/zh/ja
dictionaries with a parity audit test.

### 0.4 Feature inventory (V4)

| Area | State | Notes |
|---|---|---|
| Planner (day generation, lock, manual edit, conflicts) | Complete | V2 core, extended in V3/V4 |
| Multi-day planning, carry over | Complete | `multiDayPlanner`, `carryOverModel` |
| Backlog planning ("Plan my backlog") | Complete | `planner/backlogPlanner.js` — reused by V5 |
| Catch up on missed work | Complete, confirm-first | `planner/catchUp*` — V5 adds per-task explanations from real data |
| Workload forecast, risks, rebalance, what-if | Complete | `src/workload/*` |
| Priority reasons ("why this task") | Complete | `smartPriority.buildReasonFacts` |
| Today page | Complete | V5 reshapes it around "What should I do next?" |
| Courses, semesters, grades, exams, revision, attendance | Complete | |
| Tasks (universal, deps, recurrence, matrix, breakdown) | Complete | |
| Projects, goals, routines, notes, resources, templates | Complete | |
| Calendar (month/week/agenda), `.ics` import/export | Complete | Google Calendar intentionally not enabled (`calendar/providers.js`) |
| Focus timer, insights, weekly review | Complete | |
| Onboarding | Partial for V5 goals | Collects purpose/courses/classes/tasks/day/style but plans **today only**, no due dates, no daily target, no tour afterwards |
| Product tours | Missing | |
| Syllabus / CSV import | Missing | `.ics` import exists |
| Landing page | Missing | `index.html` only redirects |
| Plans / billing / analytics / feedback | Missing | |

Known V4 issues carried in (from V4 README "Known limitations"): bundle size
(448 kB gz), lazy i18n deferred, share links deferred, nothing yet tested on a
hosted Supabase or a Vercel Preview.

### 0.5 Secret audit

Scanned every commit on every branch for Supabase JWTs, Stripe keys
(`sk_live`/`sk_test`/`whsec_`), AWS keys, GitHub tokens, Anthropic/OpenAI-style
keys and `.env` files. **No credential was ever committed.** The only matches
are prose mentions of "service_role" in comments; `.env.example` has always
contained placeholders and `.env` is git-ignored. **No rotation is required.**
(The Supabase *publishable* key is designed to be public; RLS is the boundary.)

---

## 1. Principles for V5

1. **Connect, don't rebuild.** The scheduling engine already exists; V5's
   value is a guided path from setup → plan → recovery, plus explanations.
2. **Preview before every bulk change.** Catch-up, semester planning and
   import never write until the user confirms a preview; locked blocks never move.
3. **No invented data.** Explanations quote the user's own numbers; the
   importer never guesses a date — ambiguous rows are flagged.
4. **Free is a real product.** Pro adds automation depth, never basic task
   completion. While billing is off (default), everyone gets everything.
5. **Billing is honest.** No buy button unless checkout is configured; Stripe
   test mode only; secrets live server-side only.
6. **Privacy by default.** Product analytics are first-party, PII-free,
   opt-in, and respect Do-Not-Track / Global Privacy Control.

## 2. Milestones

### A — Audit, plan, onboarding, product tours, interface

* This document.
* **Onboarding V5** (`src/dashboard/onboarding*.js`): purpose → courses →
  weekly classes → **deadlines** (name, estimate, due date, course) →
  **availability** (day window + realistic daily work target) → study style →
  **plan preview** (which day each deadline lands on, warnings when time is
  short) → build. Deadlines are spread across days with the existing
  `planBacklog`; today's part goes through the Planner's normal Generate.
  Every non-essential step stays skippable. Finishing lands on **Today** and
  offers the Today tour.
* **Product tours** (`src/tour/*`): spotlight overlay on real elements,
  Back/Next/Skip/Done, keyboard (←/→/Esc), focus management, reduced motion,
  dark mode, en/zh/ja, mobile layout, missing/hidden targets skipped safely.
  Tours: Today, Planner, Tasks, Courses, Projects, Goals, Routines, Calendar,
  Focus, Board, Analytics. Completion stored in `profiles.preferences.tours`
  (0017, no migration) with a localStorage mirror; a `?` Help button in the
  top of every page restarts the current page's guide.
* Interface: shared tokens already exist (`styles/tokens.css`); V5 adds
  components only through those tokens.

### B — Smart Semester Planner, catch-up, Today

* **Semester Planner** drawer/page: all upcoming deadlines with remaining
  work, total work vs. available time per week, "Plan everything" →
  *preview* (per task: day, minutes, why) → apply. Built on
  `collectCatchUp`/`planBacklog`/`buildWorkloadForecast`; locked blocks and
  fixed events are capacity, never moved.
* **Catch-up explanations**: a pure `explainPlacement()` that produces
  "Due Thursday · 3 h left · Wednesday has 2 h free" facts from the forecast
  numbers; warning when the total free time before the deadline is less than
  the remaining work ("short by 1 h").
* **Today = "What should I do next?"**: one hero card (the next scheduled
  block or the top task, with the reason and Start focus), progress, missed
  work needing attention (one-click catch-up preview), upcoming deadlines
  (7 days), free time left today, Quick Add. Secondary cards stay below.

### C — Imports and data quality

* `src/import/`: `syllabusParser.js` (deterministic text parsing — date
  formats incl. "Sep 14", "9/14", "2026-09-14", "14 Sept", weekday + time
  meeting patterns, keyword classification exam/quiz/assignment/project/
  reading), `csvImport.js` (header mapping), `.ics` via the existing calendar
  parser. **Confirmation table**: every row editable, ambiguous fields
  flagged "Needs confirmation" and blocked until confirmed, duplicate rows
  (same course + normalised title + date, in the file or already saved)
  unticked by default. Nothing is saved before "Import".
* **PDF**: investigated — reliable text extraction needs `pdfjs-dist`
  (~1 MB, lazy-loadable, no network). Recommended for V5.1 behind a lazy
  import; scanned PDFs need OCR/AI and are out of scope (see §5).
* **Google Calendar**: documented controlled milestone (OAuth client,
  read-only import first, then one-way export; two-way sync only after a
  conflict model is designed and tested). Not promised in UI.

### D — Landing page, demo, analytics, feedback, marketing

* `index.html` becomes a public landing page (signed-in users still
  redirect to the app). Truthful previews built from real UI components,
  Free vs Pro table, pricing ("Pro is coming — join the waitlist" while
  billing is off), FAQ, privacy & terms pages (drafts marked for legal review).
* **Demo story**: the demo seed gains a busy week with a missed task so the
  demo shows the catch-up preview; a guided demo banner walks through it.
  Demo stays on the in-memory client.
* **Analytics** (`src/analytics/productEvents.js` + migration): allow-listed
  event names only (signup_started, signup_completed, onboarding_completed,
  first_schedule_generated, pro_interest, …), no free text, no email,
  random install id, opt-in consent, DNT/GPC respected, insert-only RLS.
* **Feedback**: in-app "Send feedback" (bug / confusing / idea + text),
  stored in a `feedback` table (insert-own, select-own).
* `marketing/` folder with the copy and checklists requested (nothing sent).

### E — Plans, entitlements, Stripe (test mode)

* Migration `subscriptions` (one row per user, **select-own only**; writes
  only by the service role from the webhook) + `stripe_events` (event id
  primary key → idempotency; no client access at all).
* `src/billing/plans.js` (pure): plan catalogue, `entitlementsFor(sub)`,
  feature → plan map, grace handling for `past_due`, expiry.
* Supabase Edge Functions (Deno): `billing-checkout`, `billing-portal`,
  `stripe-webhook` (raw-body signature verification via
  `constructEventAsync`, idempotent upsert, ignores unknown events).
* Frontend: Plan & Billing tab in Settings, pricing page, upgrade flow that
  is **disabled** unless `VITE_BILLING_ENABLED=true` and the functions
  respond; clear renewal/cancellation disclosure.

### F — QA, docs, release prep

Full test suite, PGlite migrations + RLS probes, production build, headless
browser QA of the new flows (light/dark, en/zh/ja, 500 px width), axe,
README/CHANGELOG/known issues/deployment instructions.

## 3. Migrations (proposed, files only)

| File | Milestone | Adds |
|---|---|---|
| `0027_product_events.sql` | D | `product_events` (insert-own, no update/delete, select-own), `feedback` (insert/select own), name allow-list CHECK |
| `0028_subscriptions.sql` | E | `subscriptions` (select-own; no client writes), `stripe_events` (RLS on, no policies → service role only) |

Rules as in V3/V4: additive, idempotent, RLS on every table, CHECKs,
indexes, no drops or data rewrites; covered by `tests/migrations-v3.test.js`
and the PGlite test.

## 4. Free vs Pro (proposal to test)

| Capability | Free | Student Pro |
|---|---|---|
| Courses, tasks, calendar, routines, goals, projects, focus | ✓ | ✓ |
| Manual planning + day schedule generation | ✓ | ✓ |
| Catch-up preview (missed work → new days) | ✓ (tasks one at a time / next 7 days) | ✓ full horizon, all at once |
| Semester Planner (plan every deadline) | 7-day horizon | Full semester |
| Syllabus paste / CSV / .ics import | ✓ (one course at a time) | ✓ bulk, multiple courses |
| Workload forecast & what-if | 2 weeks | Full semester |
| Planning insights | Basic | Advanced |
| Export / backup | ✓ | ✓ |

Pricing to test: **$3.99 / month**, **$29 / year**. While billing is not
configured every account is treated as Pro ("Founding beta"), and the UI
says so honestly.

**Enforcement note:** the planning features are deterministic code running in
the browser, so for client-side features the entitlement check is a product
gate, not a security boundary. That is acceptable (no data or cost is
exposed); anything that costs money server-side (future calendar sync, PDF/AI
recognition) must check the `subscriptions` row in the Edge Function.

## 5. Risks and dependencies

| Risk | Mitigation |
|---|---|
| Migrations 0018–0026 (V4) and V5's 0027–0028 untested on hosted Supabase | PGlite test + staging project before production; documented order |
| Stripe needs a business account, products, keys, webhook secret | Code + tests with fixtures; nothing claims end-to-end billing works |
| Syllabus formats vary wildly | Deterministic parser + mandatory confirmation; ambiguous fields flagged |
| PDF/scanned syllabi | Text PDFs via lazy pdf.js later; OCR/AI optional future (cost: per-page API fees, privacy review) |
| Privacy law (GDPR/CCPA/COPPA — students may be minors) | Opt-in analytics, no PII, data export/deletion, terms require 13+ (16+ EU); legal review before launch |
| Bundle size | New modules lazy-loaded where they are not on the first screen |
| Headless browser can't go below ~500 px | Mobile layouts checked at 500 px + CSS review; real-device testing listed as manual |

## 6. Acceptance criteria

* A new user can go from sign-up to a multi-day plan for real deadlines in
  about three minutes, skipping anything optional.
* Every page with a guide can start it from `?`; tours survive missing
  elements, work by keyboard, honour reduced motion, and read in en/zh/ja.
* Missed work produces a preview with explanations derived from stored data;
  nothing applies without confirmation; locked items never move; no task is
  deleted or duplicated (asserted by tests).
* Imports show an editable table; no row with an unconfirmed ambiguous field
  can be saved; duplicates are detected.
* Billing code never ships a secret to the browser; webhook rejects bad
  signatures and is idempotent (tests); purchase UI hidden unless configured.
* All existing tests, new tests, PGlite and build pass at every milestone.

## 7. Progress log

* A 7410487 · B c36e6e5 · C 2c2f5e6 · D 98dc914 · E 53f0a98 · F release prep (docs/RELEASE_V5.md, KNOWN_ISSUES.md, CHANGELOG.md).
