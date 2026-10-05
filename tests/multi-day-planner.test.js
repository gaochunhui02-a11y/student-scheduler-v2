// Tests for Phase 13 (Smart Multi-Day Planning). Two kinds of coverage,
// matching the approach established in tests/copy-schedule.test.js:
//
// 1. Real unit tests against the actual pure modules: scheduler.js's
//    computeDayCapacity (the shared availability logic) and
//    multiDayPlanner.js's classifyGroupRows / buildCandidateDates /
//    allocateAcrossDays (the deterministic day-allocation logic).
//
// 2. A simulated multi-date data layer (FakeStore, same shape as the one in
//    copy-schedule.test.js) whose preview/accept flow mirrors
//    src/dashboard/multiDayPlan.js exactly, calling the SAME real pure
//    functions above — only the Supabase reads/writes around them are
//    simulated.

import assert from 'node:assert/strict';
import { computeDayCapacity } from '../src/dashboard/scheduler.js';
import { classifyGroupRows, buildCandidateDates, allocateAcrossDays } from '../src/dashboard/multiDayPlanner.js';

let totalFailures = 0;

async function scenario(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
  } catch (e) {
    totalFailures++;
    console.log(`  FAIL  (scenario threw) ${e.message}`);
  }
}

async function check(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    totalFailures++;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Part 1: computeDayCapacity (scheduler.js) — the shared availability logic
// ---------------------------------------------------------------------------

await scenario('computeDayCapacity on a plain day with no classes/meals', async () => {
  const result = computeDayCapacity({
    wakeTime: '08:00',
    sleepTime: '10:00', // 120 minutes awake
    classes: [],
    meals: [],
    prefs: { sessionCap: 60, staminaBreak: 15 },
  });
  await check('120 min packs as 60 + 15-break + 45 = 105 min of actual study', () => {
    assert.equal(result.capacityMinutes, 105);
  });
});

await scenario('computeDayCapacity subtracts a class from the available span', async () => {
  const result = computeDayCapacity({
    wakeTime: '08:00',
    sleepTime: '10:00',
    classes: [{ name: 'Math', start: '08:30', end: '09:00' }], // splits the 120-min day into a 30-min gap and a 60-min gap
    meals: [],
    prefs: { sessionCap: 60, staminaBreak: 15 },
  });
  await check('the 30-min class itself is excluded, the two remaining gaps (30 + 60) both fit within the session cap', () => {
    assert.equal(result.capacityMinutes, 90);
  });
});

await scenario('computeDayCapacity respects the earliest/latest study-time window', async () => {
  const result = computeDayCapacity({
    wakeTime: '07:00',
    sleepTime: '22:00',
    classes: [],
    meals: [],
    prefs: { sessionCap: 60, staminaBreak: 15, earliestStudyTime: '09:00', latestStudyTime: '10:00' },
  });
  await check('only the 1-hour window counts, not the full wake-to-sleep span', () => {
    assert.equal(result.capacityMinutes, 60);
  });
});

await scenario('computeDayCapacity treats a locked study block as occupied, same as a class', async () => {
  const result = computeDayCapacity({
    wakeTime: '08:00',
    sleepTime: '10:00',
    classes: [],
    meals: [],
    prefs: { sessionCap: 60, staminaBreak: 15 },
    lockedBlocks: [{ name: 'Physics (locked)', start: 8 * 60, end: 8 * 60 + 90 }],
  });
  await check('90 min already locked out of 120 leaves only a 30-min gap', () => {
    assert.equal(result.capacityMinutes, 30);
  });
});

await scenario('computeDayCapacity surfaces the same day-bounds error generateSchedule would', async () => {
  const result = computeDayCapacity({
    wakeTime: '09:00',
    sleepTime: '09:30', // under an hour awake
    classes: [],
    meals: [],
    prefs: { sessionCap: 60, staminaBreak: 15 },
  });
  await check('capacity is 0 and an error is reported, not a crash', () => {
    assert.equal(result.capacityMinutes, 0);
    assert.ok(typeof result.error === 'string');
  });
});

await scenario('computeDayCapacity respects a maxDailyStudyMinutes cap (V2-B)', async () => {
  const uncapped = computeDayCapacity({
    wakeTime: '08:00',
    sleepTime: '10:00', // 120 min awake -> 105 min of packable study, same as the plain-day scenario above
    classes: [],
    meals: [],
    prefs: { sessionCap: 60, staminaBreak: 15 },
  });
  const capped = computeDayCapacity({
    wakeTime: '08:00',
    sleepTime: '10:00',
    classes: [],
    meals: [],
    prefs: { sessionCap: 60, staminaBreak: 15, maxDailyStudyMinutes: 40 },
  });
  await check('with no cap set, capacity is unchanged from the plain-day case', () => assert.equal(uncapped.capacityMinutes, 105));
  await check('a cap tighter than the physical capacity wins', () => assert.equal(capped.capacityMinutes, 40));
});

await scenario('computeDayCapacity counts already-locked study minutes toward the cap', async () => {
  const result = computeDayCapacity({
    wakeTime: '08:00',
    sleepTime: '10:00',
    classes: [],
    meals: [],
    prefs: { sessionCap: 60, staminaBreak: 15, maxDailyStudyMinutes: 50 },
    lockedBlocks: [{ name: 'Already locked', start: 8 * 60, end: 8 * 60 + 30 }], // 30 min already locked
  });
  await check('only 20 of the 50-minute cap remains after the 30 already locked', () => assert.equal(result.capacityMinutes, 20));
});

await scenario('computeDayCapacity never lets a cap grant MORE than physically fits', async () => {
  const result = computeDayCapacity({
    wakeTime: '08:00',
    sleepTime: '09:00', // only 60 min awake at all (the shortest day resolveDayBounds allows)
    classes: [],
    meals: [],
    prefs: { sessionCap: 60, staminaBreak: 15, maxDailyStudyMinutes: 500 },
  });
  await check('a generous cap does not manufacture capacity that is not physically there', () => assert.equal(result.capacityMinutes, 60));
});

// ---------------------------------------------------------------------------
// Part 2: classifyGroupRows / buildCandidateDates / allocateAcrossDays
// (multiDayPlanner.js) — deterministic day-by-day allocation
// ---------------------------------------------------------------------------

await scenario('classifyGroupRows separates locked/completed rows from open ones', async () => {
  const rows = [
    { id: 'chunk-locked', minutes_requested: 40 },
    { id: 'chunk-completed', minutes_requested: 30 },
    { id: 'chunk-open-1', minutes_requested: 20 },
    { id: 'chunk-open-2', minutes_requested: 25 },
  ];
  const items = [
    { source_subject_id: 'chunk-locked', locked: true, completed: false },
    { source_subject_id: 'chunk-completed', locked: false, completed: true },
    { source_subject_id: 'chunk-open-1', locked: false, completed: false },
  ];
  const { frozen, open, frozenMinutes, openMinutes } = classifyGroupRows(rows, items);

  await check('the locked and completed rows are frozen', () => {
    assert.deepEqual(frozen.map((r) => r.id).sort(), ['chunk-completed', 'chunk-locked']);
  });
  await check('rows with no locked/completed item (including one never generated) are open', () => {
    assert.deepEqual(open.map((r) => r.id).sort(), ['chunk-open-1', 'chunk-open-2']);
  });
  await check('minute totals match each bucket', () => {
    assert.equal(frozenMinutes, 70);
    assert.equal(openMinutes, 45);
  });
});

await scenario('buildCandidateDates never includes a date after the due date', async () => {
  const dates = buildCandidateDates('2026-09-17', '2026-09-25', '2026-09-20', []);
  await check('the last candidate date is the due date itself, nothing after it', () => {
    assert.equal(dates[dates.length - 1], '2026-09-20');
    assert.ok(!dates.includes('2026-09-21'));
  });
  await check('every date from start through the due date is present', () => {
    assert.deepEqual(dates, ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']);
  });
});

await scenario('buildCandidateDates excludes dates already committed to a frozen chunk', async () => {
  const dates = buildCandidateDates('2026-09-17', '2026-09-20', null, ['2026-09-18']);
  await check('the excluded date is missing, the rest remain', () => {
    assert.deepEqual(dates, ['2026-09-17', '2026-09-19', '2026-09-20']);
  });
});

await scenario('buildCandidateDates with no due date runs through the full end date', async () => {
  const dates = buildCandidateDates('2026-09-17', '2026-09-19', null, []);
  await check('all three dates are candidates', () => {
    assert.deepEqual(dates, ['2026-09-17', '2026-09-18', '2026-09-19']);
  });
});

await scenario('allocateAcrossDays spreads minutes evenly across days with equal capacity', async () => {
  const { segments, unscheduledMinutes } = allocateAcrossDays({
    remainingMinutes: 90,
    candidateDates: ['2026-09-17', '2026-09-18', '2026-09-19'],
    capacityByDate: { '2026-09-17': 60, '2026-09-18': 60, '2026-09-19': 60 },
    minBlockMinutes: 10,
  });
  await check('nothing is left unscheduled', () => assert.equal(unscheduledMinutes, 0));
  await check('the 90 minutes are spread roughly evenly, not dumped on day one', () => {
    const byDate = Object.fromEntries(segments.map((s) => [s.date, s.minutes]));
    assert.equal(byDate['2026-09-17'] + byDate['2026-09-18'] + byDate['2026-09-19'], 90);
    for (const s of segments) assert.ok(s.minutes <= 60, `${s.date} got more than its capacity`);
    // an even 30/30/30 split is the expected round-robin result here
    assert.deepEqual(Object.values(byDate).sort(), [30, 30, 30]);
  });
});

await scenario('allocateAcrossDays never exceeds a date\'s own capacity', async () => {
  const { segments } = allocateAcrossDays({
    remainingMinutes: 100,
    candidateDates: ['2026-09-17', '2026-09-18'],
    capacityByDate: { '2026-09-17': 20, '2026-09-18': 200 },
    minBlockMinutes: 5,
  });
  await check('the tight day never gets more than its capacity', () => {
    const tight = segments.find((s) => s.date === '2026-09-17');
    assert.ok(tight.minutes <= 20);
  });
  await check('the overflow lands on the roomier day', () => {
    const roomy = segments.find((s) => s.date === '2026-09-18');
    assert.equal(roomy.minutes, 100 - segments.find((s) => s.date === '2026-09-17').minutes);
  });
});

await scenario('allocateAcrossDays reports a clear shortfall when total capacity is insufficient', async () => {
  const { segments, unscheduledMinutes } = allocateAcrossDays({
    remainingMinutes: 150,
    candidateDates: ['2026-09-17', '2026-09-18'],
    capacityByDate: { '2026-09-17': 40, '2026-09-18': 40 },
    minBlockMinutes: 10,
  });
  await check('every bit of available capacity is used', () => {
    assert.equal(segments.reduce((sum, s) => sum + s.minutes, 0), 80);
  });
  await check('the remaining 70 minutes are clearly reported as unscheduled', () => {
    assert.equal(unscheduledMinutes, 70);
  });
});

await scenario('allocateAcrossDays with zero candidate dates leaves everything unscheduled', async () => {
  const { segments, unscheduledMinutes } = allocateAcrossDays({
    remainingMinutes: 60,
    candidateDates: [],
    capacityByDate: {},
    minBlockMinutes: 10,
  });
  await check('no segments were created', () => assert.equal(segments.length, 0));
  await check('the full amount is reported unscheduled', () => assert.equal(unscheduledMinutes, 60));
});

await scenario('allocateAcrossDays folds a too-small sliver back into unscheduled once a real segment exists', async () => {
  const { segments, unscheduledMinutes } = allocateAcrossDays({
    remainingMinutes: 65,
    candidateDates: ['2026-09-17', '2026-09-18'],
    capacityByDate: { '2026-09-17': 60, '2026-09-18': 5 },
    minBlockMinutes: 15,
  });
  await check('the 5-minute sliver on day two is dropped, not scheduled', () => {
    assert.ok(!segments.some((s) => s.date === '2026-09-18'));
  });
  await check('it is reported as unscheduled rather than silently lost', () => {
    assert.equal(unscheduledMinutes, 5);
  });
});

await scenario('allocateAcrossDays keeps a sliver when it is the only minutes left at all', async () => {
  const { segments, unscheduledMinutes } = allocateAcrossDays({
    remainingMinutes: 5,
    candidateDates: ['2026-09-17'],
    capacityByDate: { '2026-09-17': 60 },
    minBlockMinutes: 15,
  });
  await check('the tiny remainder is still scheduled rather than thrown away entirely', () => {
    assert.deepEqual(segments, [{ date: '2026-09-17', minutes: 5 }]);
    assert.equal(unscheduledMinutes, 0);
  });
});

await scenario('allocateAcrossDays is deterministic given identical input', async () => {
  const input = {
    remainingMinutes: 137,
    candidateDates: ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'],
    capacityByDate: { '2026-09-17': 50, '2026-09-18': 30, '2026-09-19': 90, '2026-09-20': 20 },
    minBlockMinutes: 10,
  };
  const a = allocateAcrossDays(input);
  const b = allocateAcrossDays(input);
  await check('two runs over the same input produce the exact same allocation', () => {
    assert.deepEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// Part 3: simulated end-to-end preview/accept/re-plan, mirroring
// src/dashboard/multiDayPlan.js exactly but against an in-memory store
// ---------------------------------------------------------------------------

const SCHEDULE_DEFAULTS = {
  wake_time: '07:00:00',
  sleep_time: '22:30:00',
  breakfast_on: false,
  lunch_on: false,
  dinner_on: false,
  session_cap_minutes: 60,
  stamina_break_minutes: 15,
  min_block_minutes: 15,
  earliest_study_time: null,
  latest_study_time: null,
};

class FakeStore {
  constructor() {
    this.schedules = [];
    this.subjects = [];
    this.items = [];
    this._next = 1;
  }
  newId(prefix) {
    return `${prefix}-${this._next++}`;
  }

  async getOrCreateScheduleForDate(userId, forDate) {
    let existing = this.schedules.find((s) => s.user_id === userId && s.for_date === forDate);
    if (!existing) {
      existing = { id: this.newId('sch'), user_id: userId, for_date: forDate, ...SCHEDULE_DEFAULTS };
      this.schedules.push(existing);
    }
    return { ...existing };
  }

  async listGroupSubjectRows(userId, rootId) {
    return this.subjects
      .filter((s) => s.user_id === userId && (s.id === rootId || s.origin_subject_id === rootId))
      .map((s) => ({ ...s, for_date: this.schedules.find((sc) => sc.id === s.schedule_id)?.for_date || null }));
  }
  async listScheduleItemsBySourceSubjectIds(ids) {
    return this.items.filter((i) => ids.includes(i.source_subject_id)).map((i) => ({ ...i }));
  }
  async deleteStudySubjects(ids) {
    this.subjects = this.subjects.filter((s) => !ids.includes(s.id));
  }
  async insertStudySubject(scheduleId, userId, fields) {
    const row = { id: this.newId('subj'), schedule_id: scheduleId, user_id: userId, origin_subject_id: null, ...fields };
    this.subjects.push(row);
    return { ...row };
  }
  async updateStudySubject(id, fields) {
    Object.assign(
      this.subjects.find((s) => s.id === id),
      fields
    );
  }

  // Mirrors buildMultiDayPreview in src/dashboard/multiDayPlan.js — every
  // date in range gets a flat capacity (no classes/meals in these tests,
  // since computeDayCapacity itself is already covered in Part 1) minus
  // whatever OTHER subjects already sit on that date.
  async buildPreview(userId, subjectRow, startDate, endDate, flatCapacity) {
    const rootId = subjectRow.origin_subject_id || subjectRow.id;
    const groupRows = await this.listGroupSubjectRows(userId, rootId);
    const rootRow = groupRows.find((r) => r.id === rootId);
    const siblings = groupRows.filter((r) => r.id !== rootId);
    const items = await this.listScheduleItemsBySourceSubjectIds(groupRows.map((r) => r.id));

    const { frozen, open } = classifyGroupRows(siblings, items);
    const openSiblingsMinutes = open.reduce((sum, r) => sum + r.minutes_requested, 0);
    const frozenDates = frozen.map((r) => r.for_date).filter(Boolean);
    const groupIds = groupRows.map((r) => r.id);

    const candidateDates = buildCandidateDates(startDate, endDate, rootRow.due_date, [rootRow.for_date, ...frozenDates]);
    const capacityByDate = {};
    for (const date of candidateDates) {
      const sched = this.schedules.find((s) => s.for_date === date);
      const otherMinutes = sched
        ? this.subjects.filter((s) => s.schedule_id === sched.id && !groupIds.includes(s.id)).reduce((sum, s) => sum + s.minutes_requested, 0)
        : 0;
      capacityByDate[date] = Math.max(0, flatCapacity - otherMinutes);
    }

    return {
      rootId,
      rootDate: rootRow.for_date,
      rootCurrentMinutes: rootRow.minutes_requested,
      name: rootRow.name,
      priority: rootRow.priority,
      dueDate: rootRow.due_date,
      notes: rootRow.notes || '',
      minBlockMinutes: 15,
      frozen: frozen.map((r) => ({ date: r.for_date, minutes: r.minutes_requested })),
      openSiblingIds: open.map((r) => r.id),
      planTotalMinutes: rootRow.minutes_requested + openSiblingsMinutes,
      candidateDates,
      capacityByDate,
    };
  }

  // Mirrors acceptMultiDayPlan exactly: never deletes the root, only its
  // open siblings; creates fresh chunk rows for the accepted segments.
  async accept(userId, preview, keepOnRootDateMinutes, segments) {
    if (keepOnRootDateMinutes !== preview.rootCurrentMinutes) {
      await this.updateStudySubject(preview.rootId, { minutes_requested: keepOnRootDateMinutes });
    }
    await this.deleteStudySubjects(preview.openSiblingIds);

    const created = [];
    for (const seg of segments.filter((s) => s.minutes > 0)) {
      const destSchedule = await this.getOrCreateScheduleForDate(userId, seg.date);
      const row = await this.insertStudySubject(destSchedule.id, userId, {
        name: preview.name,
        minutes_requested: seg.minutes,
        priority: preview.priority,
        due_date: preview.dueDate,
        notes: preview.notes,
        origin_subject_id: preview.rootId,
      });
      created.push(row);
    }
    return created;
  }
}

await scenario('Simulated: a first-time plan spreads a single-day task across the week, respecting the due date', async () => {
  const store = new FakeStore();
  const src = await store.getOrCreateScheduleForDate('u1', '2026-09-17');
  const root = await store.insertStudySubject(src.id, 'u1', {
    name: 'History essay',
    minutes_requested: 180,
    priority: 'high',
    due_date: '2026-09-20',
    notes: '',
  });

  const preview = await store.buildPreview('u1', root, '2026-09-18', '2026-09-25', 60);
  await check('candidate dates stop at the due date, excluding the root\'s own date', () => {
    assert.deepEqual(preview.candidateDates, ['2026-09-18', '2026-09-19', '2026-09-20']);
  });

  // student decides to keep 60 on the original day and spread the rest (120) across the window
  const allocation = allocateAcrossDays({
    remainingMinutes: 180 - 60,
    candidateDates: preview.candidateDates,
    capacityByDate: preview.capacityByDate,
    minBlockMinutes: preview.minBlockMinutes,
  });
  await check('the 120 remaining minutes fit within the 3 available days (60/day capacity)', () => {
    assert.equal(allocation.unscheduledMinutes, 0);
    assert.equal(allocation.segments.reduce((sum, s) => sum + s.minutes, 0), 120);
  });

  await store.accept('u1', preview, 60, allocation.segments);

  await check('the root row keeps its own id and now holds only 60 minutes', () => {
    const rootAfter = store.subjects.find((s) => s.id === root.id);
    assert.equal(rootAfter.minutes_requested, 60);
  });
  await check('every new chunk links back to the root via origin_subject_id', () => {
    const chunks = store.subjects.filter((s) => s.id !== root.id);
    assert.ok(chunks.length > 0);
    for (const c of chunks) assert.equal(c.origin_subject_id, root.id);
  });
  await check('no chunk was placed after the due date', () => {
    for (const c of store.subjects.filter((s) => s.id !== root.id)) {
      const sched = store.schedules.find((sc) => sc.id === c.schedule_id);
      assert.ok(sched.for_date <= '2026-09-20', `${sched.for_date} is after the due date`);
    }
  });
});

await scenario('Simulated: re-planning only touches unfinished (open) chunks, never a locked/completed one', async () => {
  const store = new FakeStore();
  const src = await store.getOrCreateScheduleForDate('u1', '2026-09-17');
  const root = await store.insertStudySubject(src.id, 'u1', {
    name: 'Chemistry review',
    minutes_requested: 60,
    priority: 'medium',
    due_date: '2026-09-22',
    notes: '',
  });

  // a first plan already ran: one chunk got locked (committed), one is still open
  const lockedSchedule = await store.getOrCreateScheduleForDate('u1', '2026-09-18');
  const lockedChunk = await store.insertStudySubject(lockedSchedule.id, 'u1', {
    name: 'Chemistry review',
    minutes_requested: 45,
    priority: 'medium',
    due_date: '2026-09-22',
    notes: '',
    origin_subject_id: root.id,
  });
  store.items.push({ source_subject_id: lockedChunk.id, locked: true, completed: false });

  const openSchedule = await store.getOrCreateScheduleForDate('u1', '2026-09-19');
  const openChunk = await store.insertStudySubject(openSchedule.id, 'u1', {
    name: 'Chemistry review',
    minutes_requested: 30,
    priority: 'medium',
    due_date: '2026-09-22',
    notes: '',
    origin_subject_id: root.id,
  });

  const preview = await store.buildPreview('u1', root, '2026-09-18', '2026-09-22', 60);
  await check('the locked chunk\'s date is excluded from re-planning candidates', () => {
    assert.ok(!preview.candidateDates.includes('2026-09-18'));
  });
  await check('only the open chunk is queued for deletion/replacement', () => {
    assert.deepEqual(preview.openSiblingIds, [openChunk.id]);
  });

  const allocation = allocateAcrossDays({
    remainingMinutes: 30, // the open chunk's own 30 minutes, re-spread
    candidateDates: preview.candidateDates,
    capacityByDate: preview.capacityByDate,
    minBlockMinutes: preview.minBlockMinutes,
  });
  await store.accept('u1', preview, preview.rootCurrentMinutes, allocation.segments);

  await check('the locked chunk still exists, completely untouched', () => {
    const stillThere = store.subjects.find((s) => s.id === lockedChunk.id);
    assert.ok(stillThere);
    assert.equal(stillThere.minutes_requested, 45);
  });
  await check('the old open chunk row is gone', () => {
    assert.ok(!store.subjects.some((s) => s.id === openChunk.id));
  });
  await check('the root row was never deleted', () => {
    assert.ok(store.subjects.some((s) => s.id === root.id));
  });
});

// ---------------------------------------------------------------------------
console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
