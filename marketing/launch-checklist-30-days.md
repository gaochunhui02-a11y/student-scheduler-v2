# 30-day launch checklist

Nothing here is automated. The owner does each step.

## Week 0: before anyone outside sees it
- [ ] Apply migrations 0018–0028 to a **staging** Supabase project and run the app against it (see README → V5 deployment)
- [ ] Vercel **Preview** of `v5-commercial-upgrade`: sign up, onboarding, import, plan, catch-up, export
- [ ] Test on a real iPhone and a real Android phone (Safari and Chrome)
- [ ] Legal review of `privacy.html` / `terms.html`; add operator name, contact, age rule
- [ ] Decide on landing-page analytics (Plausible or none) and update the privacy notice to match
- [ ] Set up a support address for feedback replies

## Week 1: founding users (10–20 people)
- [ ] Day 1: send personal invites (`founding-user-invite.md`) to people you know
- [ ] Day 2–3: watch the feedback inbox daily (`docs/ANALYTICS.md` → feedback query)
- [ ] Day 3: fix the top setup blocker
- [ ] Day 5: first 3 interviews (`interview-questions.md`)
- [ ] Day 7: review the funnel (onboarding → first schedule → replanning) among consenting users

## Week 2: fix what hurts
- [ ] Ship fixes for the top 3 problems found in interviews
- [ ] Improve syllabus parsing for the real formats people pasted (with permission, collect anonymised examples)
- [ ] 3 more interviews; ask "what would make you open it daily?"
- [ ] Record the demo video (`demo-script.md`)

## Week 3: a slightly wider circle
- [ ] Post in 1–2 student communities that allow it (`community-outreach.md`), disclosed as the maker
- [ ] Reply to every comment within 24 h
- [ ] Track: sign-ups (auth.users), onboarding completion, first schedule, week-2 return
- [ ] Decide whether Pro interest is strong enough to set up Stripe (see `docs/BILLING.md`)

## Week 4: decide
- [ ] Write a 1-page review: retention, top requests, top complaints
- [ ] If people use it weekly: prepare billing in Stripe **test mode** end-to-end, then ask the owner for launch approval
- [ ] If not: pick the one workflow people do use, and double down before charging anything
- [ ] Thank founding users and tell them what changed because of them

**Rule:** build something students want to use every day before trying to charge them.
