// Tests for Phase 7 (date navigation + history). Two kinds of coverage here:
//
// 1. Real unit tests against the actual pure modules dashboard.js uses:
//    src/dashboard/dateUtils.js (Prev/Next/date-picker arithmetic) and
//    src/dashboard/history.js (the History list's per-date aggregation).
//
// 2. A simulated multi-date data layer (FakeStore below) exercising the same
//    query SHAPE data.js's Supabase functions use (scope everything by
//    schedule_id; one schedule row per user+for_date; fresh rows get only
//    table defaults) to verify the per-date isolation design: switching
//    dates, creating a fresh schedule, no leakage between dates, and that
//    locked/completed state and generated items round-trip correctly.
//    data.js itself can't be imported here — it pulls in supabaseClient.js,
//    which requires a live Vite env and throws immediately under plain
//    Node — so this validates the contract data.js is built to, the same
//    approach lock-regenerate.test.js's "database save/load representation"
//    test (K) already uses for the same reason.

import assert from 'node:assert/strict';
import { tomorrowDateStr, addDaysToDateStr } from '../src/dashboard/dateUtils.js';
import { aggregateScheduleHistory } from '../src/dashboard/history.js';

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
// Part 1: real date-arithmetic tests
// ---------------------------------------------------------------------------
await scenario('Date arithmetic: addDaysToDateStr / tomorrowDateStr', async () => {
  await check('adding 1 day moves to the next date', () => assert.equal(addDaysToDateStr('2026-09-16', 1), '2026-09-17'));
  await check('subtracting 1 day moves to the previous date', () => assert.equal(addDaysToDateStr('2026-09-16', -1), '2026-09-15'));
  await check('crosses a month boundary forward', () => assert.equal(addDaysToDateStr('2026-09-30', 1), '2026-10-01'));
  await check('crosses a month boundary backward', () => assert.equal(addDaysToDateStr('2026-10-01', -1), '2026-09-30'));
  await check('crosses a year boundary', () => assert.equal(addDaysToDateStr('2026-12-31', 1), '2027-01-01'));
  await check('handles a leap-day February correctly', () => assert.equal(addDaysToDateStr('2028-02-28', 1), '2028-02-29'));
  await check('tomorrowDateStr(base) is base + 1 day', () => {
    assert.equal(tomorrowDateStr(new Date('2026-09-16T00:00:00')), '2026-09-17');
  });
});

// ---------------------------------------------------------------------------
// Part 2: real history-aggregation tests
// ---------------------------------------------------------------------------
await scenario('History aggregation: contains the expected saved dates with correct stats', async () => {
  const schedules = [
    { id: 'sch-a', for_date: '2026-09-16' },
    { id: 'sch-b', for_date: '2026-09-17' },
    { id: 'sch-c', for_date: '2026-09-18' }, // touched but nothing in it
  ];
  const classes = [
    { schedule_id: 'sch-a' },
    { schedule_id: 'sch-a' },
  ];
  const subjects = [
    { schedule_id: 'sch-a' },
    { schedule_id: 'sch-b' },
  ];
  const items = [
    { schedule_id: 'sch-a', item_type: 'study', completed: true },
    { schedule_id: 'sch-a', item_type: 'study', completed: false },
    { schedule_id: 'sch-a', item_type: 'class', completed: false }, // not a study item — must not count
    { schedule_id: 'sch-b', item_type: 'study', completed: true },
  ];

  const history = aggregateScheduleHistory(schedules, classes, subjects, items);

  await check('all three saved dates are present', () => {
    assert.equal(history.length, 3);
    assert.deepEqual(
      history.map((h) => h.forDate).sort(),
      ['2026-09-16', '2026-09-17', '2026-09-18']
    );
  });
  await check('sch-a has 2 classes, 1 subject, 50% study completion', () => {
    const a = history.find((h) => h.id === 'sch-a');
    assert.equal(a.classCount, 2);
    assert.equal(a.subjectCount, 1);
    assert.equal(a.studyBlockCount, 2);
    assert.equal(a.completedBlockCount, 1);
    assert.equal(a.completionPercent, 50);
  });
  await check('sch-b has 0 classes, 1 subject, 100% study completion', () => {
    const b = history.find((h) => h.id === 'sch-b');
    assert.equal(b.classCount, 0);
    assert.equal(b.subjectCount, 1);
    assert.equal(b.completionPercent, 100);
  });
  await check('sch-c (empty) has zero counts and 0% (not NaN) completion', () => {
    const c = history.find((h) => h.id === 'sch-c');
    assert.equal(c.classCount, 0);
    assert.equal(c.subjectCount, 0);
    assert.equal(c.studyBlockCount, 0);
    assert.equal(c.completionPercent, 0);
  });
  await check('non-study items (class/meal/break/free) never count toward study completion', () => {
    const a = history.find((h) => h.id === 'sch-a');
    assert.equal(a.studyBlockCount, 2); // not 3 — the 'class' item_type row is excluded
  });
});

// ---------------------------------------------------------------------------
// Part 3: simulated per-date isolation (see file header for why this is a
// simulation rather than a direct data.js import)
// ---------------------------------------------------------------------------

const SCHEDULE_DEFAULTS = {
  wake_time: '07:00:00',
  sleep_time: '22:30:00',
  breakfast_on: true,
  breakfast_time: '08:00:00',
  lunch_on: true,
  lunch_time: '12:30:00',
  dinner_on: true,
  dinner_time: '19:00:00',
  session_cap_minutes: 60,
  stamina_break_minutes: 15,
  switch_break_minutes: 10,
  min_block_minutes: 30,
  preferred_study_period: 'none',
  earliest_study_time: null,
  latest_study_time: null,
};

class FakeStore {
  constructor() {
    this.schedules = [];
    this.classes = [];
    this.subjects = [];
    this.items = [];
    this._next = 1;
  }
  newId(prefix) {
    return `${prefix}-${this._next++}`;
  }

  // Mirrors data.js's getOrCreateScheduleForDate: one row per user+for_date
  // (schedules.for_date is unique per user), fresh row gets only defaults.
  async getOrCreateScheduleForDate(userId, forDate) {
    const existing = this.schedules.find((s) => s.user_id === userId && s.for_date === forDate);
    if (existing) return { ...existing };
    const created = { id: this.newId('sch'), user_id: userId, for_date: forDate, ...SCHEDULE_DEFAULTS };
    this.schedules.push(created);
    return { ...created };
  }
  async updateSchedule(scheduleId, fields) {
    const row = this.schedules.find((s) => s.id === scheduleId);
    Object.assign(row, fields);
    return { ...row };
  }

  async listClasses(scheduleId) {
    return this.classes.filter((c) => c.schedule_id === scheduleId).map((c) => ({ ...c }));
  }
  async insertClass(scheduleId, userId, fields) {
    const row = { id: this.newId('cls'), schedule_id: scheduleId, user_id: userId, ...fields };
    this.classes.push(row);
    return { ...row };
  }

  async listStudySubjects(scheduleId) {
    return this.subjects.filter((s) => s.schedule_id === scheduleId).map((s) => ({ ...s }));
  }
  async insertStudySubject(scheduleId, userId, fields) {
    const row = { id: this.newId('subj'), schedule_id: scheduleId, user_id: userId, ...fields };
    this.subjects.push(row);
    return { ...row };
  }

  async listScheduleItems(scheduleId) {
    return this.items.filter((i) => i.schedule_id === scheduleId).map((i) => ({ ...i }));
  }
  async insertScheduleItem(scheduleId, userId, fields) {
    const row = { id: this.newId('item'), schedule_id: scheduleId, user_id: userId, locked: false, completed: false, ...fields };
    this.items.push(row);
    return { ...row };
  }
  async setItemLocked(id, locked) {
    this.items.find((i) => i.id === id).locked = locked;
  }
  async setItemCompleted(id, completed) {
    this.items.find((i) => i.id === id).completed = completed;
  }
}

await scenario('Simulated: navigating from one date to another', async () => {
  const store = new FakeStore();
  const a = await store.getOrCreateScheduleForDate('u1', '2026-09-16');
  const b = await store.getOrCreateScheduleForDate('u1', '2026-09-17');
  await check('the two dates get different schedule rows', () => assert.notEqual(a.id, b.id));
  await check('each row remembers its own for_date', () => {
    assert.equal(a.for_date, '2026-09-16');
    assert.equal(b.for_date, '2026-09-17');
  });
});

await scenario('Simulated: creating a fresh schedule for a new date uses only defaults, never copies', async () => {
  const store = new FakeStore();
  const a = await store.getOrCreateScheduleForDate('u1', '2026-09-16');
  await store.updateSchedule(a.id, { wake_time: '05:30:00', session_cap_minutes: 90 });
  await store.insertClass(a.id, 'u1', { name: 'Math', start_time: '09:00:00', end_time: '10:00:00' });
  await store.insertStudySubject(a.id, 'u1', { name: 'Physics', minutes_requested: 60 });

  const b = await store.getOrCreateScheduleForDate('u1', '2026-09-20'); // a new, never-visited date

  await check("the new date gets the table default wake_time, not date A's customized one", () => {
    assert.equal(b.wake_time, SCHEDULE_DEFAULTS.wake_time);
  });
  await check("the new date gets the table default session cap, not date A's customized one", () => {
    assert.equal(b.session_cap_minutes, SCHEDULE_DEFAULTS.session_cap_minutes);
  });
  await check('the new date has no classes copied over', async () => {
    assert.deepEqual(await store.listClasses(b.id), []);
  });
  await check('the new date has no subjects copied over', async () => {
    assert.deepEqual(await store.listStudySubjects(b.id), []);
  });
});

await scenario('Simulated: data from Date A does not appear on Date B', async () => {
  const store = new FakeStore();
  const a = await store.getOrCreateScheduleForDate('u1', '2026-09-16');
  await store.insertClass(a.id, 'u1', { name: 'Math', start_time: '09:00:00', end_time: '10:00:00' });
  await store.insertStudySubject(a.id, 'u1', { name: 'Physics', minutes_requested: 60 });
  await store.insertScheduleItem(a.id, 'u1', { item_type: 'study', name: 'Physics', start_minutes: 540, end_minutes: 600 });

  const b = await store.getOrCreateScheduleForDate('u1', '2026-09-17');

  await check('date B sees zero classes', async () => assert.equal((await store.listClasses(b.id)).length, 0));
  await check('date B sees zero subjects', async () => assert.equal((await store.listStudySubjects(b.id)).length, 0));
  await check('date B sees zero schedule items', async () => assert.equal((await store.listScheduleItems(b.id)).length, 0));
});

await scenario('Simulated: navigating back to Date A restores all original data', async () => {
  const store = new FakeStore();
  const a = await store.getOrCreateScheduleForDate('u1', '2026-09-16');
  const mathClass = await store.insertClass(a.id, 'u1', { name: 'Math', start_time: '09:00:00', end_time: '10:00:00' });
  const physicsSubject = await store.insertStudySubject(a.id, 'u1', { name: 'Physics', minutes_requested: 60 });

  const b = await store.getOrCreateScheduleForDate('u1', '2026-09-17'); // navigate away to B
  await store.insertClass(b.id, 'u1', { name: 'History', start_time: '11:00:00', end_time: '12:00:00' });

  const aAgain = await store.getOrCreateScheduleForDate('u1', '2026-09-16'); // navigate back to A

  await check('re-fetching date A returns the same schedule row (no duplicate)', () => assert.equal(aAgain.id, a.id));
  await check('date A still has exactly its one original class', async () => {
    const classes = await store.listClasses(a.id);
    assert.equal(classes.length, 1);
    assert.equal(classes[0].id, mathClass.id);
    assert.equal(classes[0].name, 'Math');
  });
  await check('date A still has exactly its one original subject', async () => {
    const subjects = await store.listStudySubjects(a.id);
    assert.equal(subjects.length, 1);
    assert.equal(subjects[0].id, physicsSubject.id);
  });
  await check("date A does not have date B's class", async () => {
    const classes = await store.listClasses(a.id);
    assert.ok(!classes.some((c) => c.name === 'History'));
  });
});

await scenario('Simulated: generated schedule items restore correctly across date switches', async () => {
  const store = new FakeStore();
  const a = await store.getOrCreateScheduleForDate('u1', '2026-09-16');
  await store.insertScheduleItem(a.id, 'u1', { item_type: 'class', name: 'Math', start_minutes: 540, end_minutes: 600 });
  await store.insertScheduleItem(a.id, 'u1', { item_type: 'study', name: 'Physics', start_minutes: 600, end_minutes: 660 });

  await store.getOrCreateScheduleForDate('u1', '2026-09-17'); // away
  const aAgain = await store.getOrCreateScheduleForDate('u1', '2026-09-16'); // back
  const items = await store.listScheduleItems(aAgain.id);

  await check('both schedule items are still there', () => assert.equal(items.length, 2));
  await check('the study item still has its correct name and times', () => {
    const study = items.find((i) => i.item_type === 'study');
    assert.equal(study.name, 'Physics');
    assert.equal(study.start_minutes, 600);
    assert.equal(study.end_minutes, 660);
  });
});

await scenario('Simulated: locked/completed flags survive date switching', async () => {
  const store = new FakeStore();
  const a = await store.getOrCreateScheduleForDate('u1', '2026-09-16');
  const item = await store.insertScheduleItem(a.id, 'u1', { item_type: 'study', name: 'Physics', start_minutes: 600, end_minutes: 660 });
  await store.setItemLocked(item.id, true);
  await store.setItemCompleted(item.id, true);

  await store.getOrCreateScheduleForDate('u1', '2026-09-17'); // away
  await store.getOrCreateScheduleForDate('u1', '2026-09-16'); // back

  const items = await store.listScheduleItems(a.id);
  await check('the item is still locked', () => assert.equal(items[0].locked, true));
  await check('the item is still completed', () => assert.equal(items[0].completed, true));
});

// ---------------------------------------------------------------------------
console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
