# Changelog

## 5.0.0-beta.1: V5 "Commercial upgrade" (branch `v5-commercial-upgrade`, unreleased)

Built on 4.0.0-beta.1. Not merged into `master`, not deployed, not tagged.

### Added
- Onboarding:
  - deadlines with due dates and a realistic daily amount
  - a "Your first plan" preview
  - a multi-day plan saved on Build
  - lands on Today with its guide
- Product tours for 11 pages, plus a Help center (`?`) and per-page guide offers (once each).
- Smart plan ("Plan my deadlines") and a rebuilt Catch up:
  - splits work before each due date within real free time
  - explanations built from your own numbers
  - shortfall warnings
  - preview before Apply
- Today:
  - "What should I do next?" hero card, with progress and free time left today
  - "Coming up" deadlines with how much is still unplanned
- Usual day: new days start with your usual hours and daily limit.
- Syllabus import (paste / CSV / .ics):
  - editable review table
  - ambiguous fields must be confirmed
  - duplicates and past items start unticked
  - weekly classes are created from the syllabus
- Public landing page with real screenshots; privacy and terms drafts; guided demo.
- Opt-in product analytics (migration 0027), Settings → Privacy controls, Send feedback.
- Free / Student Pro entitlements:
  - Settings → Plan
  - Stripe Checkout, Customer Portal and webhook Edge Functions (migration 0028)
  - billing off by default
- Docs: `docs/V5_PRODUCT_PLAN.md`, `BILLING.md`, `ANALYTICS.md`, `V5_IMPORTS_AND_SYNC.md`, `RELEASE_V5.md`, `KNOWN_ISSUES.md`.
- `marketing/` launch kit (drafts).

### Fixed
- User-entered task and routine names were inserted unescaped into some button attributes (7 places). They are now escaped, and a test scans the code for the pattern.
- The attendance badge on course cards showed raw SVG markup.
- Weekly review: the day labels for future days failed contrast in dark mode.

### Changed
- `index.html` is now the landing page. Signed-in visitors are still redirected to the app.
- PWA `start_url` is now `/dashboard.html`.
- The privacy text now describes opt-in usage counts instead of "no analytics".
- `openCatchUp` uses the smart planner; the V4 drawer is kept as `openCatchUpV4`.

## 4.0.0-beta.1: V4 "Productivity OS"
See the V4 section of `README.md` and `docs/V4_PLAN.md`.
