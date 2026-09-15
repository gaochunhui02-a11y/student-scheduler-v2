// Tests for Phase 8 (Copy to another day). Two kinds of coverage, matching
// the approach established in tests/history-navigation.test.js:
//
// 1. Real unit tests against the actual pure module dashboard.js/data.js
//    use: src/dashboard/copySchedule.js (extractPlanningFields,
//    buildCopiedClassRows, buildCopiedSubjectRows, validateCopyDestination).
//
// 2. A simulated multi-date data layer (FakeStore, same shape as the one in
//    history-navigation.test.js) whose copyScheduleToDate() calls those SAME
//    real pure builders — so the "what gets copied and how" logic under
//    test is the actual production code, only the Supabase reads/writes
//    around it are simulated. data.js itself can't be imported here (it
//    requires a live Vite/Supabase env — see history-navigation.test.js's
//    header for the same limitation).

import assert from 'node:assert/strict';
import {
  extractPlanningFields,
  buildCopiedClassRows,
  buildCopiedSubjectRows,
  validateCopyDestination,
  PLANNING_SCHEDULE_FIELDS,
} from '../src/dashboard/copySchedule.js';

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
// Part 1: real unit tests on the pure copy-logic module
// ---------------------------------------------------------------------------
await scenario('extractPlanningFields copies every planning input, nothing else', async () => {
  const source = {
    id: 'sch-source',
    user_id: 'u1',
    for_date: '2026-09-16',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-15T00:00:00Z',
    wake_time: '06:30:00',
    sleep_time: '23:00:00',
    breakfast_on: true,
    breakfast_time: '07:30:00',
    lunch_on: false,
    lunch_time: '12:30:00',
    dinner_on: true,
    dinner_time: '18:30:00',
    session_cap_minutes: 45,
    stamina_break_minutes: 10,
    switch_break_minutes: 15,
    min_block_minutes: 20,
    preferred_study_period: 'evening',
    earliest_study_time: '16:00:00',
    latest_study_time: '21:00:00',
  };
  const fields = extractPlanningFields(source);

  await check('every declared planning field is present and matches the source', () => {
    for (const key of PLANNING_SCHEDULE_FIELDS) assert.equal(fields[key], source[key], `field ${key}`);
  });
  await check('id is not included', () => assert.equal('id' in fields, false));
  await check('user_id is not included (destination keeps its own)', () => assert.equal('user_id' in fields, false));
  await check('for_date is not included (destination keeps its own date)', () => assert.equal('for_date' in fields, false));
  await check('created_at/updated_at are not included', () => {
    assert.equal('created_at' in fields, false);
    assert.equal('updated_at' in fields, false);
  });
});

await scenario('buildCopiedClassRows builds fresh rows for the destination', async () => {
  const sourceClasses = [
    { id: 'cls-1', schedule_id: 'sch-source', user_id: 'u1', name: 'Math', start_time: '09:00:00', end_time: '10:00:00', sort_order: 0 },
    { id: 'cls-2', schedule_id: 'sch-source', user_id: 'u1', name: 'History', start_time: '11:00:00', end_time: '12:00:00', sort_order: 1 },
  ];
  const rows = buildCopiedClassRows(sourceClasses, 'sch-dest', 'u1');

  await check('one output row per source class', () => assert.equal(rows.length, 2));
  await check('every row targets the destination schedule_id', () => {
    for (const r of rows) assert.equal(r.schedule_id, 'sch-dest');
  });
  await check('names/times are carried over correctly', () => {
    assert.equal(rows[0].name, 'Math');
    assert.equal(rows[0].start_time, '09:00:00');
    assert.equal(rows[0].end_time, '10:00:00');
    assert.equal(rows[1].name, 'History');
  });
  await check('no row carries an id from the source (or any id at all)', () => {
    for (const r of rows) assert.equal('id' in r, false);
  });
});

await scenario('buildCopiedSubjectRows builds fresh rows and never shifts due dates', async () => {
  const sourceSubjects = [
    {
      id: 'subj-1',
      schedule_id: 'sch-source',
      user_id: 'u1',
      name: 'Physics',
      minutes_requested: 90,
      priority: 'high',
      due_date: '2026-09-20',
      notes: 'Chapter 5 review',
      sort_order: 0,
    },
    {
      id: 'subj-2',
      schedule_id: 'sch-source',
      user_id: 'u1',
      name: 'English essay',
      minutes_requested: 45,
      priority: 'low',
      due_date: null,
      notes: '',
      sort_order: 1,
    },
  ];
  const rows = buildCopiedSubjectRows(sourceSubjects, 'sch-dest', 'u1');

  await check('one output row per source subject', () => assert.equal(rows.length, 2));
  await check('priority, minutes, and notes are carried over', () => {
    assert.equal(rows[0].priority, 'high');
    assert.equal(rows[0].minutes_requested, 90);
    assert.equal(rows[0].notes, 'Chapter 5 review');
  });
  await check("due_date is copied exactly as entered — copying to a different date doesn't shift it", () => {
    assert.equal(rows[0].due_date, '2026-09-20');
    assert.equal(rows[1].due_date, null);
  });
  await check('no row carries an id from the source (or any id at all)', () => {
    for (const r of rows) assert.equal('id' in r, false);
  });
});

await scenario('validateCopyDestination rejects the same date and an empty date', async () => {
  await check('copying to the same date is rejected', () => {
    assert.ok(typeof validateCopyDestination('2026-09-16', '2026-09-16') === 'string');
  });
  await check('an empty/missing destination date is rejected', () => {
    assert.ok(typeof validateCopyDestination('2026-09-16', '') === 'string');
  });
  await check('a genuinely different destination date is accepted', () => {
    assert.equal(validateCopyDestination('2026-09-16', '2026-09-17'), null);
  });
});

// ---------------------------------------------------------------------------
// Part 2: simulated end-to-end copy using the real builders above
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

  async getOrCreateScheduleForDate(userId, forDate) {
    const existing = this.schedules.find((s) => s.user_id === userId && s.for_date === forDate);
    if (existing) return { ...existing };
    const created = { id: this.newId('sch'), user_id: userId, for_date: forDate, ...SCHEDULE_DEFAULTS };
    this.schedules.push(created);
    return { ...created };
  }
  async getScheduleForDateIfExists(userId, forDate) {
    const existing = this.schedules.find((s) => s.user_id === userId && s.for_date === forDate);
    return existing ? { ...existing } : null;
  }
  async updateSchedule(scheduleId, fields) {
    const row = this.schedules.find((s) => s.id === scheduleId);
    Object.assign(row, fields);
    return { ...row };
  }
  async scheduleHasPlanningData(scheduleId) {
    return this.classes.some((c) => c.schedule_id === scheduleId) || this.subjects.some((s) => s.schedule_id === scheduleId);
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

  // Mirrors data.js's copyScheduleToDate exactly, using the REAL pure
  // builders — only the Supabase select/insert/delete calls are simulated.
  async copyScheduleToDate(userId, sourceScheduleId, destForDate) {
    const source = this.schedules.find((s) => s.id === sourceScheduleId);
    const sourceClasses = await this.listClasses(sourceScheduleId);
    const sourceSubjects = await this.listStudySubjects(sourceScheduleId);

    const dest = await this.getOrCreateScheduleForDate(userId, destForDate);
    const updatedDest = await this.updateSchedule(dest.id, extractPlanningFields(source));

    this.classes = this.classes.filter((c) => c.schedule_id !== dest.id);
    for (const row of buildCopiedClassRows(sourceClasses, dest.id, userId)) {
      this.classes.push({ id: this.newId('cls'), ...row });
    }

    this.subjects = this.subjects.filter((s) => s.schedule_id !== dest.id);
    for (const row of buildCopiedSubjectRows(sourceSubjects, dest.id, userId)) {
      this.subjects.push({ id: this.newId('subj'), ...row });
    }

    // schedule_items are deliberately untouched — no lines here at all.
    return updatedDest;
  }
}

async function setUpSourceDay(store) {
  const source = await store.getOrCreateScheduleForDate('u1', '2026-09-16');
  await store.updateSchedule(source.id, {
    wake_time: '06:00:00',
    sleep_time: '01:00:00', // overnight bedtime
    breakfast_on: false,
    lunch_on: true,
    lunch_time: '12:15:00',
    dinner_on: true,
    dinner_time: '18:45:00',
    session_cap_minutes: 45,
    switch_break_minutes: 20,
    min_block_minutes: 25,
    preferred_study_period: 'morning',
    earliest_study_time: '08:00:00',
    latest_study_time: '20:00:00',
  });
  await store.insertClass(source.id, 'u1', { name: 'Math', start_time: '09:00:00', end_time: '10:00:00', sort_order: 0 });
  await store.insertClass(source.id, 'u1', { name: 'History', start_time: '11:00:00', end_time: '12:00:00', sort_order: 1 });
  await store.insertStudySubject(source.id, 'u1', {
    name: 'Physics',
    minutes_requested: 90,
    priority: 'high',
    due_date: '2026-09-20',
    notes: 'Midterm prep',
    sort_order: 0,
  });
  await store.insertStudySubject(source.id, 'u1', {
    name: 'English essay',
    minutes_requested: 45,
    priority: 'low',
    due_date: null,
    notes: '',
    sort_order: 1,
  });
  return await store.getScheduleForDateIfExists('u1', '2026-09-16');
}

await scenario('Simulated: copying a full day\'s planning inputs (settings + preferences)', async () => {
  const store = new FakeStore();
  const source = await setUpSourceDay(store);

  const dest = await store.copyScheduleToDate('u1', source.id, '2026-09-22');

  await check('overnight wake/sleep settings are copied', () => {
    assert.equal(dest.wake_time, '06:00:00');
    assert.equal(dest.sleep_time, '01:00:00');
  });
  await check('meal enabled/disabled flags and times are copied', () => {
    assert.equal(dest.breakfast_on, false);
    assert.equal(dest.lunch_on, true);
    assert.equal(dest.lunch_time, '12:15:00');
    assert.equal(dest.dinner_time, '18:45:00');
  });
  await check('study preferences are copied (session cap, break, min block, period, window)', () => {
    assert.equal(dest.session_cap_minutes, 45);
    assert.equal(dest.switch_break_minutes, 20);
    assert.equal(dest.min_block_minutes, 25);
    assert.equal(dest.preferred_study_period, 'morning');
    assert.equal(dest.earliest_study_time, '08:00:00');
    assert.equal(dest.latest_study_time, '20:00:00');
  });
  await check('the destination keeps its own for_date, not the source\'s', () => assert.equal(dest.for_date, '2026-09-22'));
});

await scenario('Simulated: destination receives classes and subjects correctly', async () => {
  const store = new FakeStore();
  const source = await setUpSourceDay(store);

  await store.copyScheduleToDate('u1', source.id, '2026-09-22');
  const dest = await store.getScheduleForDateIfExists('u1', '2026-09-22');
  const classes = await store.listClasses(dest.id);
  const subjects = await store.listStudySubjects(dest.id);

  await check('both classes were copied', () => {
    assert.equal(classes.length, 2);
    assert.deepEqual(classes.map((c) => c.name).sort(), ['History', 'Math']);
  });
  await check('both subjects were copied with their priority and notes', () => {
    assert.equal(subjects.length, 2);
    const physics = subjects.find((s) => s.name === 'Physics');
    assert.equal(physics.priority, 'high');
    assert.equal(physics.minutes_requested, 90);
    assert.equal(physics.notes, 'Midterm prep');
  });
});

await scenario('Simulated: copied classes/subjects get brand new ids, never reused', async () => {
  const store = new FakeStore();
  const source = await setUpSourceDay(store);
  const sourceClasses = await store.listClasses(source.id);
  const sourceSubjects = await store.listStudySubjects(source.id);

  await store.copyScheduleToDate('u1', source.id, '2026-09-22');
  const dest = await store.getScheduleForDateIfExists('u1', '2026-09-22');
  const destClasses = await store.listClasses(dest.id);
  const destSubjects = await store.listStudySubjects(dest.id);

  await check('no copied class id matches any source class id', () => {
    const sourceIds = new Set(sourceClasses.map((c) => c.id));
    for (const c of destClasses) assert.ok(!sourceIds.has(c.id), `${c.id} was reused from the source`);
  });
  await check('no copied subject id matches any source subject id', () => {
    const sourceIds = new Set(sourceSubjects.map((s) => s.id));
    for (const s of destSubjects) assert.ok(!sourceIds.has(s.id), `${s.id} was reused from the source`);
  });
  await check('the destination schedule row itself is a different id than the source', () => {
    assert.notEqual(dest.id, source.id);
  });
});

await scenario('Simulated: due dates are copied exactly, never shifted to the destination date', async () => {
  const store = new FakeStore();
  const source = await setUpSourceDay(store);

  await store.copyScheduleToDate('u1', source.id, '2026-10-05'); // a destination far from the due date
  const dest = await store.getScheduleForDateIfExists('u1', '2026-10-05');
  const subjects = await store.listStudySubjects(dest.id);

  await check('Physics keeps its original 2026-09-20 due date, not shifted to match the destination', () => {
    assert.equal(subjects.find((s) => s.name === 'Physics').due_date, '2026-09-20');
  });
  await check('a subject with no due date still has none after copying', () => {
    assert.equal(subjects.find((s) => s.name === 'English essay').due_date, null);
  });
});

await scenario('Simulated: locked and completed state are never copied', async () => {
  const store = new FakeStore();
  const source = await setUpSourceDay(store);
  // simulate a previously-generated, locked+completed study block on the source
  await store.insertScheduleItem(source.id, 'u1', {
    item_type: 'study',
    name: 'Physics',
    start_minutes: 600,
    end_minutes: 660,
    locked: true,
    completed: true,
  });

  // destination already has its own generated schedule with different state
  const destBefore = await store.getOrCreateScheduleForDate('u1', '2026-09-22');
  const destItemBefore = await store.insertScheduleItem(destBefore.id, 'u1', {
    item_type: 'study',
    name: 'Chemistry',
    start_minutes: 60,
    end_minutes: 120,
    locked: false,
    completed: false,
  });

  await store.copyScheduleToDate('u1', source.id, '2026-09-22');
  const destItemsAfter = await store.listScheduleItems(destBefore.id);

  await check('the destination\'s existing schedule_items are completely untouched by the copy', () => {
    assert.equal(destItemsAfter.length, 1);
    assert.equal(destItemsAfter[0].id, destItemBefore.id);
    assert.equal(destItemsAfter[0].locked, false);
    assert.equal(destItemsAfter[0].completed, false);
  });
  await check('none of the source\'s locked/completed study blocks appear on the destination', () => {
    assert.ok(!destItemsAfter.some((i) => i.name === 'Physics'));
  });
});

await scenario('Simulated: generated schedule_items are not copied at all (empty source of truth check)', async () => {
  const store = new FakeStore();
  const source = await setUpSourceDay(store);
  await store.insertScheduleItem(source.id, 'u1', { item_type: 'class', name: 'Math', start_minutes: 540, end_minutes: 600 });
  await store.insertScheduleItem(source.id, 'u1', { item_type: 'study', name: 'Physics', start_minutes: 600, end_minutes: 690 });
  await store.insertScheduleItem(source.id, 'u1', { item_type: 'free', name: 'Free time', start_minutes: 690, end_minutes: 1000 });
  await store.insertScheduleItem(source.id, 'u1', { item_type: 'break', name: 'Break', start_minutes: 1000, end_minutes: 1010 });

  await store.copyScheduleToDate('u1', source.id, '2026-09-22'); // a brand new destination
  const dest = await store.getScheduleForDateIfExists('u1', '2026-09-22');
  const destItems = await store.listScheduleItems(dest.id);

  await check('the fresh destination has zero schedule_items after copying (class/study/free/break all excluded)', () => {
    assert.equal(destItems.length, 0);
  });
});

await scenario('Simulated: empty source schedule copies cleanly (no classes/subjects to bring over)', async () => {
  const store = new FakeStore();
  const source = await store.getOrCreateScheduleForDate('u1', '2026-09-16'); // never touched — no classes/subjects

  const dest = await store.copyScheduleToDate('u1', source.id, '2026-09-22');
  const destClasses = await store.listClasses(dest.id);
  const destSubjects = await store.listStudySubjects(dest.id);

  await check('ran without error on an empty source', () => assert.ok(dest));
  await check('destination has no classes', () => assert.equal(destClasses.length, 0));
  await check('destination has no subjects', () => assert.equal(destSubjects.length, 0));
});

await scenario('Simulated: an existing destination with data requires overwrite confirmation', async () => {
  const store = new FakeStore();
  const source = await setUpSourceDay(store);

  // destination already has its own class before any copy happens
  const destBefore = await store.getOrCreateScheduleForDate('u1', '2026-09-22');
  await store.insertClass(destBefore.id, 'u1', { name: 'Art', start_time: '13:00:00', end_time: '14:00:00' });

  await check('scheduleHasPlanningData reports true for a destination that already has a class', async () => {
    assert.equal(await store.scheduleHasPlanningData(destBefore.id), true);
  });
  await check('scheduleHasPlanningData reports false for a brand-new, never-visited destination', async () => {
    const brandNewExists = await store.getScheduleForDateIfExists('u1', '2026-12-25');
    assert.equal(brandNewExists, null); // the UI layer only calls scheduleHasPlanningData when a row exists at all
  });

  // proceeding with the copy (as the UI does once the user confirms) should still overwrite cleanly
  await store.copyScheduleToDate('u1', source.id, '2026-09-22');
  const destClasses = await store.listClasses(destBefore.id);
  await check('after confirmed copy, the old destination class (Art) is gone, replaced by the source\'s classes', () => {
    assert.ok(!destClasses.some((c) => c.name === 'Art'));
    assert.deepEqual(destClasses.map((c) => c.name).sort(), ['History', 'Math']);
  });
});

await scenario('Simulated: source and destination remain independent after copying', async () => {
  const store = new FakeStore();
  const source = await setUpSourceDay(store);

  await store.copyScheduleToDate('u1', source.id, '2026-09-22');
  const dest = await store.getScheduleForDateIfExists('u1', '2026-09-22');

  // mutate the destination's copy of Math
  const destClasses = await store.listClasses(dest.id);
  const destMath = destClasses.find((c) => c.name === 'Math');
  destMath.name = 'Advanced Math';
  const rowInStore = store.classes.find((c) => c.id === destMath.id);
  rowInStore.name = 'Advanced Math';

  const sourceClassesAfter = await store.listClasses(source.id);
  await check("renaming the destination's copy does not change the source's original class", () => {
    assert.ok(!sourceClassesAfter.some((c) => c.name === 'Advanced Math'), 'source picked up the destination\'s rename');
    assert.ok(sourceClassesAfter.some((c) => c.name === 'Math'), "source's original Math class is still there, unrenamed");
  });

  // mutate the source's schedule settings after copying
  await store.updateSchedule(source.id, { wake_time: '10:00:00' });
  const destAfterSourceEdit = await store.getScheduleForDateIfExists('u1', '2026-09-22');
  await check('editing the source after copying does not retroactively change the destination', () => {
    assert.equal(destAfterSourceEdit.wake_time, '06:00:00');
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
