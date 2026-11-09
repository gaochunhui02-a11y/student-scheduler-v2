# Known issues and limitations (V5 beta)

## Product

* **Onboarding replay ignores existing work.** When an account that already has a schedule replays onboarding, the "Your first plan" preview uses the daily amount as each day's free time. It doesn't subtract work already planned. New accounts aren't affected. Workaround: run *Plan my deadlines* afterwards, which uses real capacity.
* **One part per task per day.** The smart planner splits work by day, not into timed sessions. Sessions are still built when a day is generated in the Planner, as in V4.
* **Plans don't re-flow automatically.** Catch up and Plan my deadlines run when you open them. Nothing re-plans in the background, by design: every change is previewed.
* **The Free plan's 14-day look-ahead** applies only when billing is enabled. Today everyone is on the beta with the full horizon (120 days).

## Imports

* Scanned/photo PDFs aren't supported. Text PDFs work by copy and paste; built-in PDF reading is planned (`docs/V5_IMPORTS_AND_SYNC.md`).
* Multi-column syllabus layouts can paste in a scrambled order. The review table still catches it, but expect more rows to fix.
* `.ics` files skip repeating events, like the existing Calendar import.
* CSV imports go into one course. A "course" column is ignored (multi-course bulk import is planned for Pro).
* Estimates for imported assignments are defaults by type (e.g. 2 h). They're marked as starting points.

## Calendar

* No live Google/Outlook sync. Only `.ics` import and export.

## Analytics

* Usage counts are opt-in, so totals undercount. Visitor-level funnels (landing → sign-up) need the optional cookieless page analytics.
* Sign-up steps are kept on the device and sent only if the person later opts in.

## Billing

* Not connected to Stripe; billing is off. Nothing about payments has been tested end-to-end. See `docs/BILLING.md`.
* Pro limits are enforced in the browser, which is acceptable for deterministic client features. Future server-cost features must check `subscriptions` server-side.

## Technical

* The main dashboard bundle is still large (about 500 kB+ minified; the V2 `dashboard.js`). V5 modules are lazy-loaded where possible.
* Headless QA can't go narrower than about 500 px. Real phones still need checking.
* Legal pages are drafts and must be reviewed before launch.
* The V2-era optional AI Edge Functions (`ai-advisor`, `board-ai-breakdown`) still exist and require an OpenAI key if deployed. V5 adds no AI.
