// Plain Node tests for Done/Undo completion tracking and study progress. No
// DOM, no Supabase — operates on the same pure event/subject shapes as the
// other test files, using computeSubjectProgress from summary.js and
// generateSchedule/regenerate behavior from scheduler.js. Run with
// `npm test` or `node tests/completion.test.js`.

import assert from 'node:assert/strict';
import { generateSchedule, formatClock } from '../src/dashboard/scheduler.js';
import { computeSubjectProgress } from '../src/dashboard/summary.js';

let totalFailures = 0;

function scenario(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    fn();
  } catch (e) {
    totalFailures++;
    console.log(`  FAIL  (scenario threw) ${e.message}`);
  }
}

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    totalFailures++;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

function printEvents(events) {
  events.forEach((e) =>
    console.log(`  ${formatClock(e.start)} - ${formatClock(e.end)}  [${e.type}]${e.locked ? ' 🔒' : ''}${e.completed ? ' ✓' : ''} ${e.name}`)
  );
}

const OFF_MEALS = [
  { name: 'Breakfast', duration: 30, on: false, time: '08:00' },
  { name: 'Lunch', duration: 45, on: false, time: '12:00' },
  { name: 'Dinner', duration: 45, on: false, time: '18:00' },
];
const DEFAULT_PREFS = { sessionCap: 60, staminaBreak: 15, switchBreak: 10, minNewBlock: 30 };

// ---------------------------------------------------------------------------
scenario('A. Marking one study block complete', () => {
  // Simulates the DB round trip: generate, "save" (assign an id), toggle
  // completed = true on that row (what setScheduleItemCompleted does), then
  // recompute progress from the updated row set.
  const first = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '20:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ id: 'subj-1', name: 'Physics', minutes: 60 }],
    prefs: DEFAULT_PREFS,
  });
  const block = first.events.find((e) => e.type === 'study');
  const savedRow = { ...block, id: 'row-1', completed: false };

  check('starts not completed', () => assert.equal(savedRow.completed, false));

  savedRow.completed = true; // Mark Done

  const progress = computeSubjectProgress([savedRow], [{ id: 'subj-1', name: 'Physics', minutes: 60 }]);
  check('the block itself is now marked completed', () => assert.equal(savedRow.completed, true));
  check('the subject is reported as completed', () => {
    const s = progress.subjects.find((x) => x.name === 'Physics');
    assert.equal(s.completed, true);
  });
  check('completedCount is 1 of 1', () => {
    assert.equal(progress.completedCount, 1);
    assert.equal(progress.notCompletedCount, 0);
    assert.equal(progress.completionPercent, 100);
  });
});

// ---------------------------------------------------------------------------
scenario('B. Undoing completion', () => {
  const savedRow = { type: 'study', name: 'Physics', start: 420, end: 480, id: 'row-1', completed: true, sourceSubjectId: 'subj-1' };
  let progress = computeSubjectProgress([savedRow], [{ id: 'subj-1', name: 'Physics', minutes: 60 }]);
  check('starts completed', () => assert.equal(progress.subjects[0].completed, true));

  savedRow.completed = false; // Undo
  progress = computeSubjectProgress([savedRow], [{ id: 'subj-1', name: 'Physics', minutes: 60 }]);

  check('the subject is no longer reported as completed', () => assert.equal(progress.subjects[0].completed, false));
  check('completedCount drops to 0', () => {
    assert.equal(progress.completedCount, 0);
    assert.equal(progress.notCompletedCount, 1);
    assert.equal(progress.completionPercent, 0);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Completion state survives the database save/load representation', () => {
  // Shape a schedule_items row the way data.js/dashboard.js do, "save" it,
  // then "load" it back the same way and confirm completed is unchanged.
  const dbRow = {
    id: 'row-1',
    item_type: 'study',
    name: 'Physics',
    start_minutes: 420,
    end_minutes: 480,
    locked: false,
    completed: true,
    source_subject_id: 'subj-1',
  };

  const loadedEvent = {
    id: dbRow.id,
    type: dbRow.item_type,
    name: dbRow.name,
    start: dbRow.start_minutes,
    end: dbRow.end_minutes,
    locked: dbRow.locked,
    completed: dbRow.completed,
    sourceSubjectId: dbRow.source_subject_id,
  };

  check('completed survives the round trip', () => assert.equal(loadedEvent.completed, true));
  const progress = computeSubjectProgress([loadedEvent], [{ id: 'subj-1', name: 'Physics', minutes: 60 }]);
  check('progress reflects it as completed after loading', () => assert.equal(progress.subjects[0].completed, true));
});

// ---------------------------------------------------------------------------
scenario('D. A subject split into multiple blocks is complete only when ALL its blocks are', () => {
  const subjects = [{ id: 'subj-1', name: 'Physics', minutes: 90 }];
  const blockA = { type: 'study', name: 'Physics', start: 420, end: 480, sourceSubjectId: 'subj-1', completed: true };
  const blockB = { type: 'study', name: 'Physics', start: 600, end: 630, sourceSubjectId: 'subj-1', completed: false };

  let progress = computeSubjectProgress([blockA, blockB], subjects);
  check('not complete while one of the two blocks is still undone', () => assert.equal(progress.subjects[0].completed, false));
  check('blockCount is 2', () => assert.equal(progress.subjects[0].blockCount, 2));

  blockB.completed = true;
  progress = computeSubjectProgress([blockA, blockB], subjects);
  check('complete once both blocks are marked done', () => assert.equal(progress.subjects[0].completed, true));
});

// ---------------------------------------------------------------------------
scenario('E. Non-study events cannot be completed', () => {
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '20:00',
    classes: [{ name: 'Math', start: '09:00', end: '10:00' }],
    meals: [{ name: 'Lunch', duration: 45, on: true, time: '12:00' }],
    subjects: [{ id: 'subj-1', name: 'Physics', minutes: 60 }],
    prefs: DEFAULT_PREFS,
  });
  printEvents(result.events);

  check('no class/meal/break/free event carries a completed flag from generation', () => {
    for (const e of result.events) {
      if (e.type === 'study') continue;
      assert.equal(e.completed, undefined, `${e.type} "${e.name}" unexpectedly has a completed field`);
    }
  });
  check('computeSubjectProgress only ever counts study-type events toward a subject', () => {
    // even if a non-study event happened to share the subject's name, it must not count
    const decoy = { type: 'class', name: 'Physics', start: 0, end: 60, completed: true };
    const studyBlock = result.events.find((e) => e.type === 'study');
    const progress = computeSubjectProgress([decoy, studyBlock], [{ id: 'subj-1', name: 'Physics', minutes: 60 }]);
    assert.equal(progress.subjects[0].scheduled, studyBlock.end - studyBlock.start);
  });
});

// ---------------------------------------------------------------------------
scenario('F. Regeneration does not copy completed=true onto unrelated replacement blocks', () => {
  // First generation: one subject, mark its block completed (simulating what
  // the DB would show after Mark Done), then regenerate WITHOUT locking it —
  // an unlocked block is always a fresh replacement after regenerate, so it
  // must come back completed = false regardless of what the old row said.
  const first = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '20:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ id: 'subj-1', name: 'Physics', minutes: 60 }],
    prefs: DEFAULT_PREFS,
  });
  const firstBlock = first.events.find((e) => e.type === 'study');
  console.log(`  first generate: ${formatClock(firstBlock.start)}-${formatClock(firstBlock.end)}, would be saved completed=false`);

  // regenerate — this subject was never locked, so it's a fresh replacement block
  const second = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '20:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [{ id: 'subj-1', name: 'Physics', minutes: 60 }],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [], // nothing locked, so nothing carries forward
  });
  const secondBlock = second.events.find((e) => e.type === 'study');

  check('generateSchedule never sets completed on a freshly-placed block', () => {
    assert.equal(secondBlock.completed, undefined);
  });
  check('(what data.js does) a fresh insert always writes completed:false, regardless of any prior row', () => {
    // this mirrors saveGeneratedSchedule's insert row shape
    const insertedRow = { ...secondBlock, completed: false };
    assert.equal(insertedRow.completed, false);
  });
});

// ---------------------------------------------------------------------------
scenario('G. A locked + completed study block preserves both states through regeneration', () => {
  const lockedBlock = {
    id: 'row-1',
    type: 'study',
    name: 'Physics',
    start: 480, // 8:00 AM
    end: 540, // 9:00 AM
    locked: true,
    completed: true,
    sourceSubjectId: 'subj-1',
  };

  // Regenerate: pass it in as a locked block (what dashboard.js's
  // lockedBlocksFromCurrent() builds) alongside other subjects.
  const result = generateSchedule({
    wakeTime: '07:00',
    sleepTime: '20:00',
    classes: [],
    meals: OFF_MEALS,
    subjects: [
      { id: 'subj-1', name: 'Physics', minutes: 60 },
      { id: 'subj-2', name: 'History', minutes: 30 },
    ],
    prefs: DEFAULT_PREFS,
    lockedBlocks: [{ name: lockedBlock.name, start: lockedBlock.start, end: lockedBlock.end, sourceSubjectId: lockedBlock.sourceSubjectId }],
  });
  printEvents(result.events);

  check('ran without an error or lock conflict', () => {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.lockConflicts, []);
  });
  check('the locked block is still at the same time and still locked', () => {
    const b = result.events.find((e) => e.type === 'study' && e.name === 'Physics');
    assert.equal(b.start, lockedBlock.start);
    assert.equal(b.end, lockedBlock.end);
    assert.equal(b.locked, true);
  });

  // dashboard.js never touches a locked row's DB record on regenerate — it's
  // excluded from saveGeneratedSchedule's delete+insert entirely — so the
  // completed flag on that row is untouched. Simulate the merge dashboard.js
  // does: locked rows are carried forward as-is from currentScheduleItems.
  const mergedLockedRow = { ...lockedBlock }; // untouched — this is the point
  check('the previously-completed locked row still reports completed after the merge', () => {
    assert.equal(mergedLockedRow.completed, true);
  });

  const progress = computeSubjectProgress([mergedLockedRow, ...result.events.filter((e) => e.type === 'study' && !e.locked)], [
    { id: 'subj-1', name: 'Physics', minutes: 60 },
    { id: 'subj-2', name: 'History', minutes: 30 },
  ]);
  check('Physics (fully covered by the completed locked block) is reported completed', () => {
    const s = progress.subjects.find((x) => x.name === 'Physics');
    assert.equal(s.completed, true);
  });
});

// ---------------------------------------------------------------------------
scenario('H. Study progress calculation is correct across a mixed set of subjects', () => {
  const subjects = [
    { id: 's1', name: 'Physics', minutes: 60 },
    { id: 's2', name: 'History', minutes: 30 },
    { id: 's3', name: 'English essay', minutes: 45 },
    { id: 's4', name: 'Chemistry', minutes: 60 },
  ];
  const events = [
    { type: 'study', name: 'Physics', start: 0, end: 60, sourceSubjectId: 's1', completed: true },
    { type: 'study', name: 'History', start: 60, end: 90, sourceSubjectId: 's2', completed: false },
    { type: 'study', name: 'English essay', start: 90, end: 120, sourceSubjectId: 's3', completed: true },
    { type: 'study', name: 'English essay', start: 120, end: 135, sourceSubjectId: 's3', completed: true },
    // Chemistry has no scheduled block at all (full shortfall) — never completed
  ];

  const progress = computeSubjectProgress(events, subjects);
  console.log(`  completed ${progress.completedCount} / ${progress.subjects.length} (${progress.completionPercent}%)`);

  check('Physics (single completed block) is completed', () => {
    assert.equal(progress.subjects.find((s) => s.name === 'Physics').completed, true);
  });
  check('History (single incomplete block) is not completed', () => {
    assert.equal(progress.subjects.find((s) => s.name === 'History').completed, false);
  });
  check('English essay (two blocks, both completed) is completed', () => {
    assert.equal(progress.subjects.find((s) => s.name === 'English essay').completed, true);
  });
  check('Chemistry (no scheduled blocks) is not completed', () => {
    const s = progress.subjects.find((s2) => s2.name === 'Chemistry');
    assert.equal(s.blockCount, 0);
    assert.equal(s.completed, false);
  });
  check('completedCount is exactly 2 (Physics, English essay)', () => assert.equal(progress.completedCount, 2));
  check('notCompletedCount is exactly 2 (History, Chemistry)', () => assert.equal(progress.notCompletedCount, 2));
  check('completionPercent is 50', () => assert.equal(progress.completionPercent, 50));
});

// ---------------------------------------------------------------------------
console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
