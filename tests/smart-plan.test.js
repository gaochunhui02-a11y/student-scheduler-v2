// V5-B smart plan: catch-up + unscheduled work through the deadline planner,
// row operations that never delete or duplicate work, deadline coverage.
// Run: node tests/smart-plan.test.js

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTaskGroups } from '../src/tasks/taskModel.js';
import { collectCatchUp } from '../src/planner/catchUpModel.js';
import { collectPlanItems, proposeSmartPlan, piecesFor, distributePieces, deadlineCoverage } from '../src/planner/smartPlanModel.js';
import { pickNext } from '../src/today/todayModel.js';
import { normalizeUsualDay } from '../src/planner/usualDayModel.js';
import { entitlementsFor, FEATURES, yearlySavingsPercent, PAST_DUE_GRACE_DAYS } from '../src/billing/plans.js';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

const TODAY = '2026-11-11'; // Wednesday
const D = (n) => new Date(Date.UTC(2026, 10, 11 + n)).toISOString().slice(0, 10);
const sid = (date) => (date ? `s-${date}` : null);
const row = (id, date, minutes, extra = {}) => ({ id, schedule_id: sid(date), for_date: date, name: id, minutes_requested: minutes, priority: 'medium', due_date: null, origin_subject_id: null, completed_at: null, ...extra });
const block = (id, rowId, date, start, end, extra = {}) => ({ id, schedule_id: sid(date), source_subject_id: rowId, item_type: 'study', start_minutes: start, end_minutes: end, completed: false, completed_minutes: 0, carried_over_minutes: 0, missed: false, locked: false, ...extra });
const days = (n, free) => Array.from({ length: n }, (_, i) => ({ date: D(i), free }));

// Applies ops the way smartPlanData.applySmartPlan does, on plain arrays.
function simulateApply(rows, blocks, proposal) {
  const { item, parts } = proposal;
  const out = rows.map((r) => ({ ...r }));
  const outBlocks = blocks.map((b) => ({ ...b }));
  const ops = distributePieces(piecesFor(item), parts);
  let n = 0;
  ops.forEach((o) => {
    if (o.op === 'move') Object.assign(out.find((r) => r.id === o.rowId), { for_date: o.date, schedule_id: sid(o.date), minutes_requested: o.minutes });
    else out.push(row(`${item.group.id}-new${(n += 1)}`, o.date, o.minutes, { origin_subject_id: item.group.root.id, due_date: item.group.root.due_date, name: item.group.name }));
  });
  if (item.portion.kind === 'carry') {
    item.portion.blockCarries.forEach((c) => { const b = outBlocks.find((x) => x.id === c.blockId); b.carried_over_minutes += c.minutes; b.missed = true; });
    item.portion.rowTrims.forEach((tr) => { out.find((r) => r.id === tr.rowId).minutes_requested = Math.max(1, tr.minutes); });
  }
  return { rows: out, blocks: outBlocks, ops };
}

console.log('\n=== what gets planned ===');
const rows = [
  row('missed', D(-2), 120, { due_date: D(3) }),
  row('partial', D(-1), 120, { due_date: D(4) }),
  row('backlog', null, 200, { due_date: D(5) }),
  row('backlogNoDue', null, 45),
  row('future', D(1), 60, { due_date: D(2) }),
  row('done', D(-1), 30, { completed_at: '2026-11-10T09:00:00Z' }),
  row('deferred', null, 30, { status_override: 'deferred' }),
  row('lockedPast', D(-1), 60),
];
const blocks = [
  block('bp', 'partial', D(-1), 540, 600, { completed_minutes: 30 }),
  block('bl', 'lockedPast', D(-1), 600, 660, { locked: true }),
];
const groups = buildTaskGroups(rows, blocks, { today: TODAY });
const byId = (id) => groups.find((g) => g.id === id);

check('collects missed, overdue and (optionally) unscheduled work — nothing else', () => {
  const ids = collectPlanItems(groups, TODAY).map((x) => `${x.group.id}:${x.reason}`).sort();
  assert.deepEqual(ids, ['backlog:unscheduled', 'backlogNoDue:unscheduled', 'missed:missed', 'partial:missed']);
  const catchOnly = collectPlanItems(groups, TODAY, { includeUnscheduled: false }).map((x) => x.group.id).sort();
  assert.deepEqual(catchOnly, collectCatchUp(groups, TODAY).map((x) => x.group.id).sort());
});

check('proposal: split across days before the due date; facts carry the real numbers', () => {
  const items = collectPlanItems(groups, TODAY);
  const { proposals, totals } = proposeSmartPlan(items, days(10, 120), TODAY);
  const backlog = proposals.find((p) => p.summary.taskId === 'backlog');
  assert.ok(backlog.parts.length >= 2);
  assert.ok(backlog.parts.every((p) => p.date < D(5)));
  assert.equal(backlog.parts.reduce((s, p) => s + p.minutes, 0), 200);
  assert.deepEqual(backlog.facts.map((f) => f.key), ['dueIn', 'remaining', 'split', 'fits']);
  assert.equal(totals.minutes, items.reduce((s, x) => s + x.portion.minutes, 0));
  assert.equal(totals.short, 0);
});

check('not enough time: shortfall reported, full minutes still planned (on the last day)', () => {
  const items = collectPlanItems(groups, TODAY).filter((x) => x.group.id === 'backlog');
  const { proposals, totals } = proposeSmartPlan(items, days(10, 30), TODAY);
  const p = proposals[0];
  assert.equal(totals.short, p.summary.shortBy);
  assert.ok(p.summary.shortBy > 0);
  assert.equal(p.parts.reduce((s, x) => s + x.minutes, 0), 200);
  assert.equal(p.parts[p.parts.length - 1].overBy, p.summary.shortBy);
  assert.equal(p.facts.find((f) => f.key === 'short').params.free, 150); // 5 days × 30 before the due date
});

console.log('\n=== row operations ===');
check('distributePieces: first segment moves the row, the rest are linked inserts; minutes exact', () => {
  const ops = distributePieces([{ rowId: 'a', minutes: 200 }], [{ date: D(0), minutes: 120 }, { date: D(1), minutes: 80 }]);
  assert.deepEqual(ops, [{ op: 'move', rowId: 'a', date: D(0), minutes: 120 }, { op: 'insert', date: D(1), minutes: 80 }]);
  const two = distributePieces([{ rowId: 'a', minutes: 30 }, { rowId: null, minutes: 90 }], [{ date: D(0), minutes: 60 }, { date: D(1), minutes: 60 }]);
  assert.deepEqual(two, [{ op: 'move', rowId: 'a', date: D(0), minutes: 30 }, { op: 'insert', date: D(0), minutes: 30 }, { op: 'insert', date: D(1), minutes: 60 }]);
  // more work than parts: kept on the last day, never lost
  const over = distributePieces([{ rowId: 'a', minutes: 100 }], [{ date: D(0), minutes: 60 }]);
  assert.equal(over.reduce((s, o) => s + o.minutes, 0), 100);
  assert.deepEqual(distributePieces([{ rowId: 'a', minutes: 50 }], []), []);
  assert.equal(distributePieces([], [{ date: D(0), minutes: 10 }]).length, 0);
});

check('apply never deletes rows, never duplicates minutes, never touches locked blocks', () => {
  const items = collectPlanItems(groups, TODAY);
  const { proposals } = proposeSmartPlan(items, days(10, 120), TODAY);
  let r = rows;
  let b = blocks;
  proposals.forEach((p) => {
    const g = buildTaskGroups(r, b, { today: TODAY }).find((x) => x.id === p.item.group.id);
    const before = { requested: g.requestedMinutes, completed: g.completedMinutes, remaining: g.remainingMinutes };
    const res = simulateApply(r, b, { ...p, item: { ...p.item, group: g } });
    r = res.rows;
    b = res.blocks;
    // every original row id still exists
    rows.forEach((x) => assert.ok(r.some((y) => y.id === x.id), `row ${x.id} kept`));
    const after = buildTaskGroups(r, b, { today: TODAY }).find((x) => x.id === g.id);
    assert.deepEqual({ requested: after.requestedMinutes, completed: after.completedMinutes, remaining: after.remainingMinutes }, before, g.id);
  });
  // locked block untouched
  assert.deepEqual(b.find((x) => x.id === 'bl'), blocks.find((x) => x.id === 'bl'));
  // and a second pass finds nothing left to plan (except the untouched locked-only task)
  const again = collectPlanItems(buildTaskGroups(r, b, { today: TODAY }), TODAY).map((x) => x.group.id);
  assert.deepEqual(again, []);
});

check('carry: partly done task keeps its history and gets its remaining time ahead', () => {
  const g = byId('partial');
  const item = collectPlanItems(groups, TODAY).find((x) => x.group.id === 'partial');
  assert.equal(item.portion.kind, 'carry');
  const { proposals } = proposeSmartPlan([item], days(5, 60), TODAY);
  const res = simulateApply(rows, blocks, proposals[0]);
  const after = buildTaskGroups(res.rows, res.blocks, { today: TODAY }).find((x) => x.id === 'partial');
  assert.equal(after.completedMinutes, g.completedMinutes);
  assert.equal(after.remainingMinutes, g.remainingMinutes);
  assert.ok(res.rows.find((x) => x.id === 'partial').for_date === D(-1), 'past part stays on its day');
  assert.ok(res.ops.every((o) => o.op === 'insert'));
});

console.log('\n=== deadline coverage (Today) ===');
check('coverage: remaining vs. planned before the due date, from real rows', () => {
  const cov = deadlineCoverage(groups, TODAY, D(7));
  const byTask = Object.fromEntries(cov.map((c) => [c.group.id, c]));
  assert.deepEqual([byTask.future.remaining, byTask.future.plannedAhead, byTask.future.unplanned], [60, 60, 0]);
  assert.deepEqual([byTask.backlog.remaining, byTask.backlog.plannedAhead, byTask.backlog.unplanned], [200, 0, 200]);
  assert.ok(!byTask.done && !byTask.backlogNoDue);
  assert.deepEqual(cov.map((c) => c.dueDate), cov.map((c) => c.dueDate).slice().sort());
});

console.log('\n=== Today: what next ===');
const ev = (title, kind, start, end, extra = {}) => ({ title, kind, start, end, completed: false, ...extra });
const topTask = [{ group: { id: 'g1', name: 'Essay' }, reason: 'overdue' }];
check('a session happening now wins; up-next is what follows it', () => {
  const r = pickNext({ events: [ev('Study A', 'study', 600, 660), ev('Chem', 'class', 700, 760)], top: topTask, now: 620 });
  assert.equal(r.kind, 'now');
  assert.equal(r.event.title, 'Study A');
  assert.equal(r.upNext.title, 'Chem');
});
check('a session starting soon beats a task; a far one yields to the task (with "then")', () => {
  assert.equal(pickNext({ events: [ev('Study B', 'study', 640, 700)], top: topTask, now: 620 }).kind, 'next');
  const far = pickNext({ events: [ev('Study B', 'study', 800, 860)], top: topTask, now: 620 });
  assert.equal(far.kind, 'task');
  assert.equal(far.group.name, 'Essay');
  assert.equal(far.then.title, 'Study B');
  assert.equal(pickNext({ events: [ev('Study B', 'study', 800, 860)], top: [], now: 620 }).kind, 'next');
});
check('completed and past sessions are ignored; nothing left → clear', () => {
  const r = pickNext({ events: [ev('Done', 'study', 640, 700, { completed: true }), ev('Past', 'study', 500, 560)], top: [], now: 620 });
  assert.equal(r.kind, 'clear');
  assert.equal(r.upNext, null);
});

console.log('\n=== plans & entitlements ===');
const NOW = new Date('2026-11-11T12:00:00Z');
check('billing off (default): everyone gets every feature as the beta plan', () => {
  const e = entitlementsFor(null, { now: NOW });
  assert.deepEqual([e.plan, e.source], ['pro', 'beta']);
});
check('billing on: free without a subscription; Pro only from an active/trialing pro row', () => {
  assert.equal(entitlementsFor(null, { now: NOW, billingEnabled: true }).plan, 'free');
  assert.equal(entitlementsFor({ plan: 'pro', status: 'active', current_period_end: '2026-12-01T00:00:00Z' }, { now: NOW, billingEnabled: true }).plan, 'pro');
  assert.equal(entitlementsFor({ plan: 'pro', status: 'trialing', current_period_end: '2026-11-20T00:00:00Z' }, { now: NOW, billingEnabled: true }).plan, 'pro');
  assert.equal(entitlementsFor({ plan: 'free', status: 'active' }, { now: NOW, billingEnabled: true }).plan, 'free');
  ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'bogus'].forEach((status) => {
    assert.equal(entitlementsFor({ plan: 'pro', status, current_period_end: '2026-12-01T00:00:00Z' }, { now: NOW, billingEnabled: true }).plan, 'free', status);
  });
});
check('past_due keeps Pro only within the grace window; a stale "active" period expires', () => {
  const end = '2026-11-08T00:00:00Z';
  assert.equal(entitlementsFor({ plan: 'pro', status: 'past_due', current_period_end: end }, { now: NOW, billingEnabled: true }).source, 'grace');
  const later = new Date(Date.parse(end) + (PAST_DUE_GRACE_DAYS + 1) * 86400000);
  assert.equal(entitlementsFor({ plan: 'pro', status: 'past_due', current_period_end: end }, { now: later, billingEnabled: true }).plan, 'free');
  assert.equal(entitlementsFor({ plan: 'pro', status: 'active', current_period_end: '2026-09-01T00:00:00Z' }, { now: NOW, billingEnabled: true }).plan, 'free');
});
check('Free is a real product: basic planning on, horizon two weeks; Pro never claims calendar sync', () => {
  assert.equal(FEATURES.free.planHorizonDays, 14);
  assert.ok(FEATURES.pro.planHorizonDays > FEATURES.free.planHorizonDays);
  assert.equal(FEATURES.pro.calendarSync, false);
  assert.equal(yearlySavingsPercent(), 39);
});

console.log('\n=== usual day ===');
check('normalizeUsualDay keeps only valid fields (new days never get junk)', () => {
  assert.deepEqual(normalizeUsualDay({ wake_time: '08:00:00', sleep_time: '23:30', max_daily_study_minutes: 180, session_cap_minutes: 45, preferred_study_period: 'evening', extra: 1 }),
    { wake_time: '08:00', sleep_time: '23:30', max_daily_study_minutes: 180, session_cap_minutes: 45, preferred_study_period: 'evening' });
  assert.deepEqual(normalizeUsualDay({ wake_time: '25:00', sleep_time: 'late', max_daily_study_minutes: 5, session_cap_minutes: 9999, preferred_study_period: 'none' }), {});
  assert.deepEqual(normalizeUsualDay(null), {});
});

console.log('\n=== security: raw button attributes ===');
check('no user-entered name/title is interpolated unescaped into button attrs', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []));
  const offenders = [];
  walk(join(here, '..', 'src')).forEach((file) => {
    const src = readFileSync(file, 'utf8');
    (src.match(/attrs: `[^`]*`/g) || []).forEach((m) => {
      const bad = (m.match(/\$\{[^}]*\}/g) || []).filter((x) => /\.(name|title|label|notes|description)\b/.test(x) && !/escapeHtml\(/.test(x));
      if (bad.length) offenders.push(`${file.split(/[\\/]src[\\/]/)[1]}: ${bad.join(', ')}`);
    });
  });
  assert.deepEqual(offenders, []);
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
