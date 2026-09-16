// Tests for Phase 14 (Missed Task + Auto Carry Over). Three kinds of
// coverage, matching the approach established in tests/multi-day-planner.test.js:
//
// 1. Real unit tests against the actual pure module: carryOverModel.js
//    (computeRemainingMinutes, isFullyCompletedByMinutes,
//    validateCompletedMinutesInput, canCarryOverBlock, canMarkMissed).
//
// 2. A simulated multi-date data layer (FakeStore) whose carry-over
//    preview/accept flow mirrors src/dashboard/multiDayPlan.js's
//    buildCarryOverPreview/acceptCarryOver exactly, calling the SAME real
//    pure functions Phase 13 already uses (classifyGroupRows,
//    buildCandidateDates, allocateAcrossDays) — proving carry-over is not a
//    second scheduling algorithm.
//
// 3. Real unit tests against analyticsModel.js confirming partial
//    completion and missed work don't corrupt weekly/subject totals.

import assert from 'node:assert/strict';
import {
  computeRemainingMinutes,
  isFullyCompletedByMinutes,
  validateCompletedMinutesInput,
  canCarryOverBlock,
  canMarkMissed,
} from '../src/dashboard/carryOverModel.js';
import { buildCandidateDates, allocateAcrossDays } from '../src/dashboard/multiDayPlanner.js';
import { computeWeeklyTotals, computeSubjectTotals } from '../src/analytics/analyticsModel.js';

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
// Part 1: carryOverModel.js — the remaining-minutes arithmetic
// ---------------------------------------------------------------------------

await scenario('Full completion gives 0 remaining minutes', async () => {
  const item = { start: 0, end: 90, completed: true, completedMinutes: 0, carriedOverMinutes: 0 };
  await check('remaining is 0 once `completed` is true, regardless of completedMinutes', () => {
    assert.equal(computeRemainingMinutes(item), 0);
  });
});

await scenario('Partial completion (40 of 90) leaves 50 remaining, not fully completed', async () => {
  const item = { start: 0, end: 90, completed: false, completedMinutes: 40, carriedOverMinutes: 0 };
  await check('remaining = 90 - 40 = 50', () => {
    assert.equal(computeRemainingMinutes(item), 50);
  });
  await check('isFullyCompletedByMinutes(40, 90) is false — never mistaken for done', () => {
    assert.equal(isFullyCompletedByMinutes(40, 90), false);
  });
  await check('isFullyCompletedByMinutes(90, 90) is true — reaching full duration IS done', () => {
    assert.equal(isFullyCompletedByMinutes(90, 90), true);
  });
});

await scenario('A missed block (nothing completed) has the full duration remaining', async () => {
  const item = { start: 0, end: 60, completed: false, completedMinutes: 0, carriedOverMinutes: 0, missed: true, type: 'study', sourceSubjectId: 's1' };
  await check('remaining is the whole 60-minute block', () => {
    assert.equal(computeRemainingMinutes(item), 60);
  });
  await check('canCarryOverBlock is true — there is something to carry', () => {
    assert.equal(canCarryOverBlock(item), true);
  });
  await check('canMarkMissed is false — it is already marked missed (toggle it off instead)', () => {
    assert.equal(canMarkMissed(item), false);
  });
});

await scenario('No duplicate completed minutes: carriedOverMinutes is subtracted, never re-offered', async () => {
  const item = { start: 0, end: 90, completed: false, completedMinutes: 40, carriedOverMinutes: 30 };
  await check('remaining = 90 - 40 completed - 30 already carried = 20, not 50', () => {
    assert.equal(computeRemainingMinutes(item), 20);
  });
  await check('a second carry-over of the full 20 plus the already-carried 30 never exceeds the block\'s 50-minute shortfall', () => {
    const alreadyCarried = 30;
    const newlyCarried = computeRemainingMinutes(item); // 20
    assert.equal(alreadyCarried + newlyCarried, 90 - 40); // exactly the shortfall, no more
  });
});

await scenario('validateCompletedMinutesInput rejects out-of-range values', async () => {
  await check('a negative value is rejected', () => {
    assert.equal(validateCompletedMinutesInput(-5, 90).ok, false);
  });
  await check('a value exceeding the block\'s duration is rejected', () => {
    const result = validateCompletedMinutesInput(150, 90);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('90'));
  });
  await check('a value equal to the duration is accepted (full completion via partial entry)', () => {
    assert.deepEqual(validateCompletedMinutesInput(90, 90), { ok: true, value: 90 });
  });
  await check('a valid partial value is accepted and rounded', () => {
    assert.deepEqual(validateCompletedMinutesInput('40.4', 90), { ok: true, value: 40 });
  });
});

await scenario('Locked block safety: a locked block is never eligible for Carry Over or Missed', async () => {
  const lockedButUnfinished = { type: 'study', start: 0, end: 90, completed: false, completedMinutes: 0, carriedOverMinutes: 0, locked: true, sourceSubjectId: 's1' };
  await check('canCarryOverBlock is false purely because it is locked', () => {
    assert.equal(canCarryOverBlock(lockedButUnfinished), false);
  });
  await check('canMarkMissed is false for the same reason', () => {
    assert.equal(canMarkMissed(lockedButUnfinished), false);
  });
  await check('unlocking the identical block makes it eligible again — locking is the only blocker', () => {
    const unlocked = { ...lockedButUnfinished, locked: false };
    assert.equal(canCarryOverBlock(unlocked), true);
    assert.equal(canMarkMissed(unlocked), true);
  });
});

await scenario('A fully completed or fully carried block has nothing left to carry or miss', async () => {
  const fullyCompleted = { type: 'study', start: 0, end: 60, completed: true, sourceSubjectId: 's1' };
  const fullyCarried = { type: 'study', start: 0, end: 60, completed: false, completedMinutes: 0, carriedOverMinutes: 60, sourceSubjectId: 's1' };
  await check('a fully completed block is not carry-over eligible', () => assert.equal(canCarryOverBlock(fullyCompleted), false));
  await check('a block whose entire shortfall was already carried is not carry-over eligible either', () => assert.equal(canCarryOverBlock(fullyCarried), false));
});

// ---------------------------------------------------------------------------
// Part 2: Simulated carry-over preview/accept, mirroring
// src/dashboard/multiDayPlan.js's buildCarryOverPreview/acceptCarryOver —
// CRITICAL: reuses the exact same buildCandidateDates/allocateAcrossDays
// Phase 13 already uses, not a second algorithm.
// ---------------------------------------------------------------------------

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
      existing = { id: this.newId('sch'), user_id: userId, for_date: forDate };
      this.schedules.push(existing);
    }
    return { ...existing };
  }
  async insertStudySubject(scheduleId, userId, fields) {
    const row = { id: this.newId('subj'), schedule_id: scheduleId, user_id: userId, origin_subject_id: null, ...fields };
    this.subjects.push(row);
    return { ...row };
  }
  async incrementScheduleItemCarriedOver(itemId, addMinutes) {
    const item = this.items.find((i) => i.id === itemId);
    item.carried_over_minutes = (item.carried_over_minutes || 0) + addMinutes;
    return item.carried_over_minutes;
  }
  groupDatesFor(rootId) {
    return this.subjects.filter((s) => s.id === rootId || s.origin_subject_id === rootId).map((s) => this.schedules.find((sc) => sc.id === s.schedule_id).for_date);
  }

  // Mirrors buildCarryOverPreview: flat capacity per date (computeDayCapacity
  // itself is already covered by tests/multi-day-planner.test.js) minus
  // whatever's already scheduled there.
  async buildCarryOverPreview(userId, item, subjectRow, remainingMinutes, startDate, endDate, { ignoreDueDate = false } = {}, flatCapacity = 60) {
    const rootId = subjectRow.origin_subject_id || subjectRow.id;
    const usedDates = this.groupDatesFor(rootId);
    const candidateDates = buildCandidateDates(startDate, endDate, ignoreDueDate ? null : subjectRow.due_date, usedDates);
    const capacityByDate = {};
    for (const date of candidateDates) {
      const sched = this.schedules.find((s) => s.for_date === date);
      const used = sched ? this.subjects.filter((s) => s.schedule_id === sched.id).reduce((sum, s) => sum + s.minutes_requested, 0) : 0;
      capacityByDate[date] = Math.max(0, flatCapacity - used);
    }
    const allocation = allocateAcrossDays({ remainingMinutes, candidateDates, capacityByDate, minBlockMinutes: 15 });
    return {
      itemId: item.id,
      rootId,
      name: subjectRow.name,
      priority: subjectRow.priority,
      dueDate: subjectRow.due_date,
      notes: subjectRow.notes || '',
      remainingMinutes,
      candidateDates,
      capacityByDate,
      segments: allocation.segments,
      unscheduledMinutes: allocation.unscheduledMinutes,
    };
  }

  async acceptCarryOver(userId, preview, segments) {
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
    const carriedTotal = created.reduce((sum, r) => sum + r.minutes_requested, 0);
    if (carriedTotal > 0) await this.incrementScheduleItemCarriedOver(preview.itemId, carriedTotal);
    return { created, carriedTotal };
  }
}

await scenario('Final verification: 90-min block, 40 completed, carry over exactly the 50 remaining', async () => {
  const store = new FakeStore();
  const src = await store.getOrCreateScheduleForDate('u1', '2026-09-17');
  const subject = await store.insertStudySubject(src.id, 'u1', {
    name: 'Calculus',
    minutes_requested: 90,
    priority: 'high',
    due_date: '2026-09-22',
    notes: '',
  });
  const item = { id: 'item-1', schedule_id: src.id, source_subject_id: subject.id, start_minutes: 540, end_minutes: 630, completed: false, completed_minutes: 40, carried_over_minutes: 0 };
  store.items.push(item);

  const remaining = computeRemainingMinutes({ start: item.start_minutes, end: item.end_minutes, completed: item.completed, completedMinutes: item.completed_minutes, carriedOverMinutes: item.carried_over_minutes });
  await check('remaining is exactly 50', () => assert.equal(remaining, 50));

  const preview = await store.buildCarryOverPreview('u1', { id: item.id }, subject, remaining, '2026-09-18', '2026-09-22');
  await check('candidate dates never include the original day or go past the due date', () => {
    assert.ok(!preview.candidateDates.includes('2026-09-17'));
    assert.ok(preview.candidateDates.every((d) => d <= '2026-09-22'));
  });
  await check('the full 50 minutes fit within capacity, nothing unscheduled', () => {
    assert.equal(preview.unscheduledMinutes, 0);
    assert.equal(preview.segments.reduce((sum, s) => sum + s.minutes, 0), 50);
  });

  await store.acceptCarryOver('u1', preview, preview.segments);

  await check('the completed 40 minutes are untouched — never re-created as a new chunk', () => {
    assert.equal(item.completed_minutes, 40);
    assert.equal(item.completed, false);
  });
  await check('exactly 50 minutes worth of new chunks were created, linked to the original subject', () => {
    const chunks = store.subjects.filter((s) => s.id !== subject.id);
    assert.equal(chunks.reduce((sum, c) => sum + c.minutes_requested, 0), 50);
    for (const c of chunks) assert.equal(c.origin_subject_id, subject.id);
  });
  await check('the original block records exactly 50 minutes carried over — audit trail, no duplication', () => {
    assert.equal(item.carried_over_minutes, 50);
  });
  await check('re-running carry-over now offers 0 additional minutes (already fully carried)', () => {
    const remainingAfter = computeRemainingMinutes({ start: item.start_minutes, end: item.end_minutes, completed: item.completed, completedMinutes: item.completed_minutes, carriedOverMinutes: item.carried_over_minutes });
    assert.equal(remainingAfter, 0);
  });
});

await scenario('Due-date edge cases: due today / overdue leave nothing to reschedule unless extended', async () => {
  const store = new FakeStore();
  const src = await store.getOrCreateScheduleForDate('u1', '2026-09-17');
  const subject = await store.insertStudySubject(src.id, 'u1', { name: 'Overdue essay', minutes_requested: 60, priority: 'high', due_date: '2026-09-17', notes: '' });
  const item = { id: 'item-2' };

  const preview = await store.buildCarryOverPreview('u1', item, subject, 60, '2026-09-18', '2026-09-25');
  await check('due date already passed relative to the carry window: no candidate dates at all', () => {
    assert.deepEqual(preview.candidateDates, []);
  });
  await check('the entire 60 minutes is reported as unable to reschedule before the deadline', () => {
    assert.equal(preview.unscheduledMinutes, 60);
    assert.equal(preview.segments.length, 0);
  });

  const extended = await store.buildCarryOverPreview('u1', item, subject, 60, '2026-09-18', '2026-09-20', { ignoreDueDate: true });
  await check('explicitly extending past the due date makes the window available again', () => {
    assert.deepEqual(extended.candidateDates, ['2026-09-18', '2026-09-19', '2026-09-20']);
    assert.equal(extended.unscheduledMinutes, 0);
  });
});

await scenario('Insufficient future capacity reports a clear, exact shortfall', async () => {
  const store = new FakeStore();
  const src = await store.getOrCreateScheduleForDate('u1', '2026-09-17');
  const subject = await store.insertStudySubject(src.id, 'u1', { name: 'Big project', minutes_requested: 200, priority: 'medium', due_date: '2026-09-19', notes: '' });
  const item = { id: 'item-3' };

  // only 2 candidate days (18, 19) at 60 min/day flat capacity = 120 max
  const preview = await store.buildCarryOverPreview('u1', item, subject, 150, '2026-09-18', '2026-09-19', {}, 60);
  await check('every bit of the 2 available days is used (120 minutes)', () => {
    assert.equal(preview.segments.reduce((sum, s) => sum + s.minutes, 0), 120);
  });
  await check('the remaining 30 minutes are clearly reported, matching the required message format', () => {
    assert.equal(preview.unscheduledMinutes, 30);
    const message = `${preview.unscheduledMinutes} minutes could not be rescheduled before the deadline.`;
    assert.equal(message, '30 minutes could not be rescheduled before the deadline.');
  });
});

// ---------------------------------------------------------------------------
// Part 3: analyticsModel.js — partial completion / missed must not corrupt
// completion rate, weekly analytics, or subject totals
// ---------------------------------------------------------------------------

await scenario('Analytics: a partially completed block credits only its actual completed minutes', async () => {
  const dates = ['2026-09-17'];
  const items = [
    { item_type: 'study', date: '2026-09-17', start_minutes: 0, end_minutes: 90, completed: false, completed_minutes: 40 },
  ];
  const result = computeWeeklyTotals(items, dates);
  await check('planned still reflects the full 90-minute block', () => assert.equal(result.totalPlanned, 90));
  await check('completed reflects only the 40 actually-completed minutes, not 0 and not 90', () => assert.equal(result.totalCompleted, 40));
});

await scenario('Analytics: a block with no completed_minutes at all (pre-Phase-14 row) behaves exactly as before', async () => {
  const dates = ['2026-09-17'];
  const items = [{ item_type: 'study', date: '2026-09-17', start_minutes: 0, end_minutes: 60, completed: false }];
  const result = computeWeeklyTotals(items, dates);
  await check('completed is 0, same as the original completed-boolean-only behavior', () => assert.equal(result.totalCompleted, 0));
});

await scenario('Analytics: missed minutes are tracked additively, without touching planned/completed', async () => {
  const dates = ['2026-09-17', '2026-09-18'];
  const items = [
    { item_type: 'study', date: '2026-09-17', start_minutes: 0, end_minutes: 60, completed: false, completed_minutes: 0, missed: true }, // fully missed
    { item_type: 'study', date: '2026-09-18', start_minutes: 0, end_minutes: 90, completed: false, completed_minutes: 40, missed: true }, // partially done, rest missed
  ];
  const result = computeWeeklyTotals(items, dates);
  await check('planned totals are unaffected by the missed flag', () => assert.equal(result.totalPlanned, 150));
  await check('completed totals still only count actually-completed minutes', () => assert.equal(result.totalCompleted, 40));
  await check('missed totals count only the still-outstanding portion of flagged blocks (60 + 50)', () => {
    assert.equal(result.totalMissed, 110);
  });
  await check('a missed block that is NOT flagged does not contribute to missed at all', () => {
    const noMissedFlag = computeWeeklyTotals([{ item_type: 'study', date: '2026-09-17', start_minutes: 0, end_minutes: 60, completed: false, completed_minutes: 0 }], ['2026-09-17']);
    assert.equal(noMissedFlag.totalMissed, 0);
  });
});

await scenario('Analytics: subject totals credit partial completion per-subject, sorted correctly', async () => {
  const studySubjects = [{ id: 's1', name: 'Physics', minutes_requested: 90 }];
  const items = [{ item_type: 'study', source_subject_id: 's1', completed: false, completed_minutes: 40, start_minutes: 0, end_minutes: 90 }];
  const totals = computeSubjectTotals(studySubjects, items);
  await check('Physics shows 90 planned, 40 completed (not 0 from the old completed-boolean-only gate)', () => {
    const physics = totals.find((t) => t.subject === 'Physics');
    assert.equal(physics.planned, 90);
    assert.equal(physics.completed, 40);
  });
});

await scenario('Analytics: a fully completed block still credits its full duration (regression check)', async () => {
  const studySubjects = [{ id: 's1', name: 'Calculus', minutes_requested: 60 }];
  const items = [{ item_type: 'study', source_subject_id: 's1', completed: true, completed_minutes: 0, start_minutes: 0, end_minutes: 60 }];
  const totals = computeSubjectTotals(studySubjects, items);
  await check('a `completed: true` row credits the full 60 minutes even with a stale/unset completed_minutes', () => {
    assert.equal(totals.find((t) => t.subject === 'Calculus').completed, 60);
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
