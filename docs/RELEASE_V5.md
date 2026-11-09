# V5 release preparation (`5.0.0-beta.1`, not tagged)

## Verification done on the branch (2026-11-10)

| Check | Result | How |
|---|---|---|
| Unit / model tests | `npm test` exit 0: 1885+ passes, 0 failures, 67 files | Node |
| Database migrations 0001–0028 on real Postgres | 298/298 (RLS isolation, ownership, constraints, cascades, self-granted Pro blocked) | `tests/db/migrations-pglite.mjs` (PGlite, Postgres 17) |
| Production build | OK; no Stripe/service-role secret patterns in `dist/` | `npm run build` + grep |
| Webhook signatures | Interoperable both ways with the official `stripe` SDK | one-off script (not committed) |
| Runtime errors, all 19 pages + V5 flows | 0 at DB levels current, v5 (no 0027+), v3, and in zh-dark | headless Chrome, demo data |
| Accessibility (axe, WCAG 2.1 A/AA) | 0 violations on 19 pages + smart plan, import, plan, help, tour, light and dark | headless Chrome + axe-core |
| Onboarding → multi-day plan, import → save, smart plan → apply | Verified by reading back the saved rows | headless Chrome, demo data |
| Mobile layout | Checked at 500 px (the narrowest headless Chrome allows) | screenshots |

## NOT verified (needs the owner)

* A real Supabase project. Migrations 0018–0028 have not been applied anywhere hosted.
* A Vercel Preview deployment.
* Real phones and tablets, Safari/iOS, and screen readers. Only axe and keyboard steps were run.
* Stripe in any mode. Edge Functions have not been deployed or run under Deno.
* Email confirmation and sign-up against a live Auth project.

## Preview smoke test (owner)

1. Staging DB with 0001–0028; Preview deploy with billing unset.
2. Sign up a new account and complete onboarding with 2 deadlines (one 3+ days out). Today should open with its guide, and Tasks should show the work split across days before the due dates.
3. Skip onboarding on a second account: nothing breaks, and Help → Replay setup works.
4. Courses → Import syllabus: paste a real syllabus, confirm the flagged rows, import, then Plan my deadlines → Apply.
5. Leave a planned task undone until the next day. Today should show "need a new day"; Catch up's explanation should reference real free time.
6. Lock a session and run Catch up: the locked session doesn't move.
7. Settings → Privacy: turn usage counts on, use the app, then delete them. Check `product_events` as the owner.
8. Send feedback and check that the `feedback` row appears.
9. Settings → Plan shows "Founding beta" with no purchase button.
10. Use the landing page logged out and logged in (logged in, it should redirect). Try the guided demo.
11. Repeat in zh / ja, in dark mode, and on a real phone.
12. Export a backup and restore it into a third account.

Only after this passes: tag `v5.0.0-beta.1` on the branch (the owner's decision).
Merging to `master` and deploying to production are separate approvals.
