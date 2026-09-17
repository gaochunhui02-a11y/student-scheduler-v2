// Plain Node tests for the Checkpoint E Quick (Study) Planning Templates
// (src/dashboard/quickTemplates.js). No DOM, no Supabase, no AI. Run with
// `npm test` or `node tests/quick-templates.test.js`.

import assert from 'node:assert/strict';
import {
  SCHEDULE_PREF_FIELDS,
  QUICK_TEMPLATES,
  getQuickTemplate,
  isSupportedPrefField,
  buildTemplatePreview,
  buildTemplatePrefsPatch,
} from '../src/dashboard/quickTemplates.js';

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

// ---------------------------------------------------------------------------
scenario('A. Every template only ever uses supported schedule preference fields', () => {
  check('there are at least the 5 required templates', () => {
    assert.ok(QUICK_TEMPLATES.length >= 5);
    ['examWeek', 'catchUpDay', 'busyDay', 'lightStudyDay', 'projectWork'].forEach((key) => {
      assert.ok(QUICK_TEMPLATES.some((t) => t.key === key), `missing template: ${key}`);
    });
  });

  QUICK_TEMPLATES.forEach((template) => {
    check(`"${template.key}": every field it sets is in SCHEDULE_PREF_FIELDS`, () => {
      Object.keys(template.prefs).forEach((field) => {
        assert.equal(isSupportedPrefField(field), true, `${field} is not a supported/allow-listed field`);
      });
    });
    check(`"${template.key}": touches at least one field (a real, non-trivial template)`, () => {
      assert.ok(Object.keys(template.prefs).length > 0);
    });
    check(`"${template.key}": has a name key and a description key`, () => {
      assert.equal(typeof template.nameKey, 'string');
      assert.equal(typeof template.descriptionKey, 'string');
    });
  });

  check('getQuickTemplate looks up by key', () => {
    assert.equal(getQuickTemplate('busyDay').key, 'busyDay');
  });
  check('getQuickTemplate returns null for an unknown key rather than throwing', () => {
    assert.equal(getQuickTemplate('does-not-exist'), null);
  });

  check('SCHEDULE_PREF_FIELDS never includes anything the scheduler does not already understand (day settings, task fields excluded)', () => {
    ['wake_time', 'sleep_time', 'priority', 'due_date', 'minutes_requested', 'for_date'].forEach((forbidden) => {
      assert.equal(SCHEDULE_PREF_FIELDS.includes(forbidden), false);
    });
  });
});

// ---------------------------------------------------------------------------
scenario('B. buildTemplatePreview reflects only REAL changes', () => {
  const examWeek = getQuickTemplate('examWeek'); // { session_cap_minutes: 90, switch_break_minutes: 5 }

  check('a field that actually differs shows up with its from/to values', () => {
    const preview = buildTemplatePreview(examWeek, { session_cap_minutes: 45, switch_break_minutes: 15 });
    assert.equal(preview.length, 2);
    const cap = preview.find((c) => c.field === 'session_cap_minutes');
    assert.deepEqual(cap, { field: 'session_cap_minutes', from: 45, to: 90 });
  });

  check('a field already at the template\'s target value is omitted — no no-op line in the preview', () => {
    const preview = buildTemplatePreview(examWeek, { session_cap_minutes: 90, switch_break_minutes: 15 });
    assert.equal(preview.length, 1);
    assert.equal(preview[0].field, 'switch_break_minutes');
  });

  check('applying an already-fully-matching schedule previews as no changes at all', () => {
    const preview = buildTemplatePreview(examWeek, { session_cap_minutes: 90, switch_break_minutes: 5 });
    assert.deepEqual(preview, []);
  });

  check('undefined/missing current fields are treated as null, not as a crash', () => {
    const preview = buildTemplatePreview(examWeek, {});
    assert.equal(preview.length, 2);
    assert.equal(preview[0].from, null);
  });

  check('a template that clears a field to null previews that as a real change from a set value', () => {
    const catchUpDay = getQuickTemplate('catchUpDay'); // clears earliest/latest study time
    const preview = buildTemplatePreview(catchUpDay, { earliest_study_time: '08:00', latest_study_time: '22:00' });
    assert.equal(preview.length, 2);
    assert.deepEqual(
      preview.find((c) => c.field === 'earliest_study_time'),
      { field: 'earliest_study_time', from: '08:00', to: null }
    );
  });

  check('a null template returns an empty preview rather than throwing', () => {
    assert.deepEqual(buildTemplatePreview(null, { session_cap_minutes: 30 }), []);
  });

  check('preview never includes an unrelated field the schedule happens to have', () => {
    const preview = buildTemplatePreview(examWeek, { session_cap_minutes: 45, wake_time: '07:00', preferred_study_period: 'morning' });
    assert.ok(!preview.some((c) => c.field === 'wake_time' || c.field === 'preferred_study_period'));
  });
});

// ---------------------------------------------------------------------------
scenario('C. buildTemplatePrefsPatch — the exact, deterministic write payload', () => {
  check('the patch contains exactly the template\'s own fields, nothing more, nothing less', () => {
    const patch = buildTemplatePrefsPatch(getQuickTemplate('projectWork'));
    assert.deepEqual(patch, { session_cap_minutes: 120, min_block_minutes: 60 });
  });

  check('applying is deterministic — the same template always produces the same patch', () => {
    const a = buildTemplatePrefsPatch(getQuickTemplate('lightStudyDay'));
    const b = buildTemplatePrefsPatch(getQuickTemplate('lightStudyDay'));
    assert.deepEqual(a, b);
  });

  check('the patch is independent of whatever the current schedule looks like (applying never reads current state)', () => {
    const patch = buildTemplatePrefsPatch(getQuickTemplate('busyDay'));
    assert.deepEqual(patch, { session_cap_minutes: 25, min_block_minutes: 15 });
  });

  check('applying one template never mutates unrelated fields — every OTHER supported field is simply absent from the patch', () => {
    const patch = buildTemplatePrefsPatch(getQuickTemplate('examWeek'));
    const untouched = SCHEDULE_PREF_FIELDS.filter((f) => !(f in getQuickTemplate('examWeek').prefs));
    untouched.forEach((field) => assert.equal(field in patch, false, `${field} must not appear in Exam Week's patch`));
  });

  check('a null template patches to an empty object rather than throwing', () => {
    assert.deepEqual(buildTemplatePrefsPatch(null), {});
  });

  check('every real template produces a patch matching its own preview\'s "to" values exactly', () => {
    QUICK_TEMPLATES.forEach((template) => {
      const patch = buildTemplatePrefsPatch(template);
      const preview = buildTemplatePreview(template, {});
      preview.forEach((change) => {
        assert.equal(patch[change.field], change.to, `${template.key}.${change.field}`);
      });
    });
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
