# Product analytics (V5-D)

Privacy-first, first-party, **opt-in**. See `src/analytics/` and migration
`0027_product_events.sql`.

## What is collected

| Event | When | Props |
|---|---|---|
| `session_start` | dashboard opened (max once per day per device) | — |
| `signup_started` / `signup_completed` | sign-up page (kept on the device, sent only after the user opts in) | — |
| `onboarding_completed` / `onboarding_skipped` | onboarding finished | — |
| `first_schedule_generated` | first plan built (onboarding or Planner Generate), once per device per account | `source`, `tasks` |
| `plan_applied` / `catchup_applied` | smart plan applied | `tasks`, `days` |
| `import_completed` | syllabus/CSV/.ics import saved | `source`, `tasks`, `exams`, `meetings` |
| `tour_completed` | a product guide finished | `tour` |
| `pro_interest` | "Notify me / Upgrade" interest on the Plan page | `interval` |
| `upgrade_started`, `subscription_started` | billing (when enabled) | `interval` |
| `feedback_sent` | feedback sent | `kind` |

Never collected: task, course or note text, email, names, IP-derived location,
device fingerprints. Names are allow-listed in the database CHECK and in
`productEventsModel.EVENT_NAMES` (a test keeps them identical); props are
sanitised to small integers and fixed labels and capped at 512 bytes.

**Consent:** nothing is recorded until the user clicks "Share usage counts"
(one-time card after onboarding, or Settings → Privacy). Browsers sending Do
Not Track / Global Privacy Control are never asked. Users can turn it off and
delete their events at any time. The demo never records.

**Visitor-level metrics** (landing page views, landing → sign-up clicks)
can't be measured by an opt-in, account-based system. The landing page can
load cookieless Plausible analytics if the owner sets
`VITE_PLAUSIBLE_DOMAIN` (off by default, skipped under DNT/GPC). Decide on
this together with the privacy notice.

## Queries (run in the Supabase SQL editor as the owner)

Opt-in data undercounts: treat these as trends among consenting users, not
absolute totals. For total sign-ups use `auth.users`.

```sql
-- Total sign-ups per week (all users, from auth — no consent needed)
select date_trunc('week', created_at) as week, count(*) from auth.users group by 1 order by 1 desc;

-- Activation funnel among consenting users, last 30 days
with u as (
  select user_id,
    bool_or(name = 'onboarding_completed') as onboarded,
    bool_or(name = 'first_schedule_generated') as scheduled,
    bool_or(name in ('plan_applied', 'catchup_applied')) as replanned
  from public.product_events
  where created_at > now() - interval '30 days'
  group by user_id)
select count(*) as users, count(*) filter (where onboarded) as onboarded,
  count(*) filter (where scheduled) as first_schedule, count(*) filter (where replanned) as used_replanning
from u;

-- Weekly active users (consenting)
select date_trunc('week', created_at) as week, count(distinct user_id) as wau
from public.product_events where name = 'session_start' group by 1 order by 1 desc;

-- Returning users: active this week and in an earlier week
with w as (select user_id, date_trunc('week', created_at) wk from public.product_events where name = 'session_start' group by 1, 2)
select wk, count(*) filter (where exists (select 1 from w w2 where w2.user_id = w.user_id and w2.wk < w.wk)) as returning, count(*) as active
from w group by wk order by wk desc;

-- Pro interest and (when billing is on) subscriptions
select name, props->>'interval' as interval, count(*) from public.product_events
where name in ('pro_interest', 'upgrade_started', 'subscription_started') group by 1, 2 order by 1;

-- Feedback inbox
select created_at, kind, page, message from public.feedback order by created_at desc limit 100;
```
