// Tests for V2-G: the shared status system (src/shared/statusModel.js),
// that every view renders statuses through it, deadline de-duplication,
// and count-aware translations. Plain Node, no DOM.
// Run with `npm test` or `node tests/status-system.test.js`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STATUS_KEYS,
  STATUS_ICONS,
  statusLabelKey,
  deriveBlockStatus,
  deriveTaskStatus,
  combineTaskStatuses,
  countStatuses,
  countBlockStatuses,
  statusBadgeHtml,
} from '../src/shared/statusModel.js';
import { computeDayStatusCounts, aggregateWeekView } from '../src/week/weekModel.js';
import { aggregateScheduleHistory } from '../src/dashboard/history.js';
import { dedupeDeadlineRows, computeUpcomingDeadlines, computeOverdueWorkload } from '../src/analytics/analyticsModel.js';
import { buildAgenda } from '../src/calendar/agendaModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
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

const raw = (extra = {}) => ({ item_type: 'study', start_minutes: 600, end_minutes: 660, completed: false, completed_minutes: 0, carried_over_minutes: 0, missed: false, ...extra });
const camel = (extra = {}) => ({ type: 'study', start: 600, end: 660, completed: false, completedMinutes: 0, carriedOverMinutes: 0, missed: false, ...extra });

// ---------------------------------------------------------------------------
scenario('A. The six statuses', () => {
  check('exactly the six spec statuses, each with an icon and label key', () => {
    assert.deepEqual(STATUS_KEYS, ['planned', 'in_progress', 'done', 'partial', 'missed', 'carried_over']);
    STATUS_KEYS.forEach((k) => {
      assert.ok(STATUS_ICONS[k]);
      assert.equal(statusLabelKey(k), `status.${k}`);
    });
    assert.equal(statusLabelKey('nonsense'), 'status.planned');
  });
  check('every status has a label in en, zh and ja', () => {
    const i18n = src('src/shared/i18n.js');
    STATUS_KEYS.forEach((k) => assert.equal((i18n.match(new RegExp(`'status\\.${k}':`, 'g')) || []).length, 3, k));
  });
  check('every status has light + dark colors and a badge class', () => {
    const css = src('src/styles/main.css');
    STATUS_KEYS.forEach((k) => assert.match(css, new RegExp(`\\.status-${k}\\s*\\{`)));
    ['planned', 'progress', 'done', 'partial', 'missed', 'carried'].forEach((k) => {
      assert.equal((css.match(new RegExp(`--status-${k}-fg:`, 'g')) || []).length, 3, k); // light, dark media, dark attr
    });
  });
});

// ---------------------------------------------------------------------------
scenario('B. Block status rules (raw and camelCase shapes agree)', () => {
  const cases = [
    [{}, 'planned'],
    [{ completed: true }, 'done'],
    [{ completed_minutes: 60, completedMinutes: 60 }, 'done'],
    [{ completed_minutes: 20, completedMinutes: 20 }, 'partial'],
    [{ missed: true }, 'missed'],
    [{ missed: true, completed_minutes: 20, completedMinutes: 20 }, 'missed'],
    [{ missed: true, carried_over_minutes: 60, carriedOverMinutes: 60 }, 'carried_over'],
    [{ completed: true, missed: true }, 'done'],
  ];
  cases.forEach(([extra, expected]) => {
    check(`${JSON.stringify(extra)} -> ${expected}`, () => {
      const rawExtra = Object.fromEntries(Object.entries(extra).filter(([k]) => !/[A-Z]/.test(k)));
      const camelExtra = Object.fromEntries(Object.entries(extra).filter(([k]) => !k.includes('_')));
      assert.equal(deriveBlockStatus(raw(rawExtra)), expected);
      assert.equal(deriveBlockStatus(camel(camelExtra)), expected);
    });
  });
  check('In Progress only for today and only while the block runs', () => {
    assert.equal(deriveBlockStatus(camel(), { isToday: true, nowMinutes: 630 }), 'in_progress');
    assert.equal(deriveBlockStatus(camel(), { isToday: true, nowMinutes: 660 }), 'planned');
    assert.equal(deriveBlockStatus(camel(), { isToday: false, nowMinutes: 630 }), 'planned');
    assert.equal(deriveBlockStatus(camel({ completedMinutes: 10 }), { isToday: true, nowMinutes: 630 }), 'partial');
  });
  check('non-study items have no status', () => {
    assert.equal(deriveBlockStatus({ ...camel(), type: 'class' }), null);
    assert.equal(deriveBlockStatus(null), null);
  });
});

// ---------------------------------------------------------------------------
scenario('C. Task status from its blocks', () => {
  check('no blocks -> planned; all done -> done', () => {
    assert.equal(deriveTaskStatus([]), 'planned');
    assert.equal(deriveTaskStatus([camel({ completed: true }), camel({ completed: true })]), 'done');
  });
  check('most pressing wins: missed > in_progress > carried_over > partial', () => {
    assert.equal(combineTaskStatuses(['done', 'missed', 'in_progress']), 'missed');
    assert.equal(combineTaskStatuses(['done', 'in_progress', 'carried_over']), 'in_progress');
    assert.equal(combineTaskStatuses(['planned', 'carried_over']), 'carried_over');
    assert.equal(combineTaskStatuses(['done', 'planned']), 'partial');
    assert.equal(combineTaskStatuses(['planned', null]), 'planned');
  });
  check('counts', () => {
    assert.deepEqual(countStatuses(['done', 'done', 'missed', 'bogus']), { planned: 0, in_progress: 0, done: 2, partial: 0, missed: 1, carried_over: 0 });
    assert.equal(countBlockStatuses([camel({ completed: true }), { type: 'break' }]).done, 1);
  });
});

// ---------------------------------------------------------------------------
scenario('D. Every view uses the shared status system', () => {
  const views = {
    'Home + Insights': 'src/analytics/analytics.js',
    Planner: 'src/dashboard/dashboard.js',
    Week: 'src/week/week.js',
    Board: 'src/board/board.js',
    Calendar: 'src/calendar/agenda.js',
    History: 'src/dashboard/history.js',
  };
  Object.entries(views).forEach(([name, file]) => {
    check(`${name} imports statusModel.js`, () => assert.match(src(file), /from '\.\.\/shared\/statusModel\.js'/));
  });
  check('Board model derives linked status through statusModel', () => {
    assert.match(src('src/board/boardModel.js'), /combineTaskStatuses/);
  });
  check('legacy one-off status markup is gone', () => {
    const all = ['src/dashboard/dashboard.js', 'src/board/board.js', 'src/calendar/agenda.js', 'src/analytics/analytics.js'].map(src).join('\n');
    assert.doesNotMatch(all, /tl-badge-missed|board-status-\$\{|agenda-tag-done|study\.doneChip|board\.status\.\$\{/);
    assert.doesNotMatch(src('src/dashboard/dashboard.js'), /nameHtml = `✓/);
  });
  check('badge markup: icon is decorative, label carries the meaning', () => {
    const html = statusBadgeHtml('missed', 'Missed', { count: 2 });
    assert.match(html, /class="status-badge status-missed"/);
    assert.match(html, /aria-hidden="true">!</);
    assert.match(html, /<span class="status-label">2 Missed<\/span>/);
    assert.doesNotMatch(statusBadgeHtml('done', '<b>x</b>'), /<b>/);
  });
});

// ---------------------------------------------------------------------------
scenario('E. Status counts in Week, History and Calendar', () => {
  const schedules = [{ id: 'a', for_date: '2026-10-05' }, { id: 'b', for_date: '2026-10-06' }];
  const items = [
    { ...raw({ completed: true }), schedule_id: 'a' },
    { ...raw({ missed: true }), schedule_id: 'a' },
    { ...raw(), schedule_id: 'b' },
    { schedule_id: 'b', item_type: 'class', start_minutes: 0, end_minutes: 60 },
  ];
  check('week: per-day counts, In Progress only on today', () => {
    const counts = computeDayStatusCounts({ weekDates: ['2026-10-05', '2026-10-06'], schedules, items, todayDateStr: '2026-10-06', nowMinutes: 630 });
    assert.equal(counts.get('2026-10-05').done, 1);
    assert.equal(counts.get('2026-10-05').missed, 1);
    assert.equal(counts.get('2026-10-06').in_progress, 1);
  });
  check('history: per-day statusCounts', () => {
    const h = aggregateScheduleHistory(schedules, [], [], items);
    assert.equal(h.find((x) => x.id === 'a').statusCounts.done, 1);
    assert.equal(h.find((x) => x.id === 'a').statusCounts.missed, 1);
    assert.equal(h.find((x) => x.id === 'b').statusCounts.planned, 1);
  });
  check('calendar: study entries carry the shared status', () => {
    const agenda = buildAgenda({ dates: ['2026-10-05'], schedules, classes: [], items: items.map((i) => ({ ...i, name: 'X' })) });
    assert.deepEqual(agenda[0].entries.map((e) => e.status).sort(), ['done', 'missed']);
  });
});

// ---------------------------------------------------------------------------
scenario('F. Per-day copies of one task are one deadline', () => {
  const today = '2026-10-06';
  const rows = [
    { id: '1', name: 'Calculus', due_date: '2026-10-08', minutes_requested: 90 },
    { id: '2', name: 'calculus ', due_date: '2026-10-08', minutes_requested: 120 },
    { id: '3', name: 'Calculus', due_date: '2026-10-09', minutes_requested: 60 },
    { id: '4', name: 'Biology', due_date: '2026-10-08', minutes_requested: 30 },
  ];
  check('dedupe keeps one row per name + due date, largest request', () => {
    const d = dedupeDeadlineRows(rows);
    assert.equal(d.length, 3);
    assert.equal(d.find((r) => r.due_date === '2026-10-08' && r.name.trim().toLowerCase() === 'calculus').minutes_requested, 120);
  });
  check('upcoming list is deduped (never summed)', () => {
    const up = computeUpcomingDeadlines(rows, today, 10);
    assert.equal(up.length, 3);
    assert.equal(up.filter((u) => u.title.trim().toLowerCase() === 'calculus' && u.dueDate === '2026-10-08')[0].remainingMinutes, 120);
  });
  check('week deadlines: one chip per task per day', () => {
    const days = aggregateWeekView({ weekDates: ['2026-10-08'], schedules: [], classes: [], items: [], dueSubjects: rows.map((r) => ({ ...r, priority: r.id === '2' ? 'high' : 'low' })) });
    assert.deepEqual(days[0].deadlines.map((d) => d.name.trim().toLowerCase()).sort(), ['biology', 'calculus']);
    assert.equal(days[0].deadlines.find((d) => d.name.trim().toLowerCase() === 'calculus').priority, 'high');
  });
  check('overdue workload counts a copied task once', () => {
    const o = computeOverdueWorkload(
      [{ id: 'x', name: 'Essay', due_date: '2026-10-01', minutes_requested: 60 }, { id: 'y', name: 'Essay', due_date: '2026-10-01', minutes_requested: 60 }],
      [],
      today
    );
    assert.equal(o.count, 1);
    assert.equal(o.totalMinutes, 60);
  });
  check('deadline reminders use the same de-duplication', () => {
    assert.match(src('src/notifications/notifications.js'), /dedupeDeadlineRows\(subjects\)/);
  });
});

// ---------------------------------------------------------------------------
scenario('G. Count-aware translations', () => {
  const i18n = src('src/shared/i18n.js');
  // tCount singulars are `${base}One` keys whose plural `${base}` exists.
  // (Older pairs like why.overdueOne / why.overdueMany are separate keys
  // with no bare base, translated in every language — not tCount's.)
  const keysIn = (text) => new Set([...text.matchAll(/^ {2}'([\w.]+)':/gm)].map((m) => m[1]));
  const zhStart = i18n.indexOf('\nconst zh = {');
  const enKeys = keysIn(i18n.slice(0, zhStart));
  const singularBases = [...enKeys].filter((k) => k.endsWith('One') && enKeys.has(k.slice(0, -3))).map((k) => k.slice(0, -3));
  check('tCount exists; the history/insights counts have English singulars', () => {
    assert.match(i18n, /export function tCount\(key, n\)/);
    ['history.classCount', 'history.subjectCount', 'insights.acrossBlocks'].forEach((k) => assert.ok(singularBases.includes(k), k));
  });
  check('tCount singulars are English-only (zh/ja do not inflect for number)', () => {
    const otherKeys = keysIn(i18n.slice(zhStart));
    singularBases.forEach((base) => assert.equal(otherKeys.has(`${base}One`), false, base));
  });
});

console.log('\n------------------------');
if (totalFailures > 0) {
  console.log(`${totalFailures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('All checks passed');
}
