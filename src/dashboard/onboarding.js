// First-run onboarding dialog (V2-F). Owns only its own DOM. It never saves
// anything itself: "Build my first plan" hands the cleaned answers
// (onboardingModel.js's buildOnboardingPlan) to host.applyPlan, which
// fills the real Planner inputs so their existing save handlers persist
// them, then generates. Skip/finish call host.markComplete.

import { icon } from '../ui/icons.js';
import {
  onboardingStepsV4,
  PURPOSES,
  buildOnboardingAcademics,
  defaultOnboardingAnswersV3,
  STUDY_PERIODS,
  SESSION_LENGTHS,
  validateOnboardingStep,
  buildOnboardingPlan,
  canBuildPlan,
  defaultOnboardingAnswers,
} from './onboardingModel.js';

// @param {object} host
// @param {(key:string) => string} host.t
// @param {(plan:object) => Promise<void>} host.applyPlan
// @param {() => Promise<void>|void} host.markComplete
// @param {() => boolean} [host.isV3]   courses feature available (V3 steps)
// @param {() => string} [host.today]   YYYY-MM-DD
// V3: applyPlan(plan, academics) also receives buildOnboardingAcademics().
export function initOnboarding(host) {
  const { t } = host;
  let overlay = null;
  let stepIndex = 0;
  let answers = defaultOnboardingAnswers();
  let STEPS = onboardingStepsV4();
  let v3 = false;
  const WEEKDAY_KEYS = ['recurring.daySun', 'recurring.dayMon', 'recurring.dayTue', 'recurring.dayWed', 'recurring.dayThu', 'recurring.dayFri', 'recurring.daySat'];
  let busy = false;
  let returnFocusTo = null;

  const PERIOD_KEYS = { none: 'prefs.periodNone', morning: 'prefs.periodMorning', afternoon: 'prefs.periodAfternoon', evening: 'prefs.periodEvening' };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function build() {
    overlay = el('div', 'onboarding-overlay');
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboardingTitle">
        <div class="onboarding-top">
          <ol class="onboarding-steps" aria-hidden="true"></ol>
          <button type="button" class="onboarding-skip"></button>
        </div>
        <p class="onboarding-eyebrow"></p>
        <h2 class="onboarding-title" id="onboardingTitle"></h2>
        <p class="onboarding-lead"></p>
        <div class="onboarding-body"></div>
        <p class="onboarding-error hint-error" role="alert"></p>
        <div class="onboarding-actions">
          <button type="button" class="btn-secondary onboarding-back"></button>
          <button type="button" class="btn-primary onboarding-next"></button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.onboarding-skip').addEventListener('click', () => finish({ build: false }));
    overlay.querySelector('.onboarding-back').addEventListener('click', () => {
      if (busy || stepIndex === 0) return;
      readStep();
      stepIndex -= 1;
      render();
    });
    overlay.querySelector('.onboarding-next').addEventListener('click', next);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !busy) finish({ build: false });
    });
  }

  const q = (sel) => overlay.querySelector(sel);
  const generalPurpose = () => answers.purpose === 'work' || answers.purpose === 'personal';

  function readStep() {
    const step = STEPS[stepIndex];
    const body = q('.onboarding-body');
    const courseOf = (row) => { const sel = row.querySelector('.onb-course'); return sel ? sel.value : ''; };
    if (step === 'purpose') {
      const picked = body.querySelector('input[name="onbPurpose"]:checked');
      answers.purpose = picked ? picked.value : null;
    } else if (step === 'courses') {
      answers.semester = { name: body.querySelector('.onb-sem-name').value, start: body.querySelector('.onb-sem-start').value, end: body.querySelector('.onb-sem-end').value };
      answers.courses = Array.from(body.querySelectorAll('.onb-row-course')).map((row) => ({
        name: row.querySelector('.onb-name').value,
        code: row.querySelector('.onb-code').value,
      }));
    } else if (step === 'tasks') {
      answers.tasks = Array.from(body.querySelectorAll('.onb-row')).map((row) => ({
        name: row.querySelector('.onb-name').value,
        minutes: row.querySelector('.onb-minutes').value,
        course: courseOf(row),
      }));
    } else if (step === 'day') {
      answers.day = { wake: body.querySelector('.onb-wake').value, sleep: body.querySelector('.onb-sleep').value };
    } else if (step === 'classes') {
      answers.classes = Array.from(body.querySelectorAll('.onb-row')).map((row) => {
        const weekly = row.querySelector('.onb-weekly');
        const weekday = row.querySelector('.onb-weekday');
        return {
          name: row.querySelector('.onb-name').value,
          start: row.querySelector('.onb-start').value,
          end: row.querySelector('.onb-end').value,
          weekly: weekly ? weekly.checked : false,
          weekday: weekday ? Number(weekday.value) : undefined,
          course: courseOf(row),
        };
      });
    } else if (step === 'style') {
      const period = body.querySelector('input[name="onbPeriod"]:checked');
      const session = body.querySelector('input[name="onbSession"]:checked');
      answers.style = { period: period ? period.value : 'none', sessionMinutes: session ? Number(session.value) : 45 };
    }
  }

  function labeled(labelText, input) {
    const label = el('label', 'onb-field');
    label.appendChild(el('span', 'onb-field-label', labelText));
    label.appendChild(input);
    return label;
  }

  function input(type, className, value, attrs = {}) {
    const node = el('input', className);
    node.type = type;
    node.value = value ?? '';
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  }

  function select(className, options, current) {
    const node = el('select', className);
    options.forEach(([value, label]) => {
      const opt = el('option', null, label);
      opt.value = String(value);
      if (String(value) === String(current ?? '')) opt.selected = true;
      node.appendChild(opt);
    });
    return node;
  }

  // Courses typed in the first step, offered on the class and task rows.
  function courseSelect(current) {
    const named = (answers.courses || []).map((c, i) => [i, (c.name || '').trim()]).filter(([, name]) => name);
    if (!v3 || named.length === 0) return null;
    return labeled(t('onboarding.course'), select('onb-course', [['', t('onboarding.noCourse')], ...named], current));
  }

  function choiceGroup(name, options, current, labelFor) {
    const group = el('div', 'onb-choices');
    group.setAttribute('role', 'radiogroup');
    options.forEach((value) => {
      const label = el('label', 'onb-choice');
      const radio = input('radio', '', String(value), { name });
      radio.checked = String(value) === String(current);
      label.appendChild(radio);
      label.appendChild(el('span', null, labelFor(value)));
      group.appendChild(label);
    });
    return group;
  }

  function renderBody(step) {
    const body = q('.onboarding-body');
    body.innerHTML = '';
    if (step === 'purpose') {
      const PURPOSE_ICON = { school: 'school', work: 'briefcase', personal: 'home', selfstudy: 'book', multiple: 'sliders' };
      const group = el('div', 'ws-modes onb-purpose');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-labelledby', 'onboardingTitle');
      PURPOSES.forEach((p) => {
        const label = el('label', `ws-mode${answers.purpose === p ? ' is-on' : ''}`);
        const radio = input('radio', '', p, { name: 'onbPurpose' });
        radio.checked = answers.purpose === p;
        radio.addEventListener('change', () => group.querySelectorAll('.ws-mode').forEach((l) => l.classList.toggle('is-on', l.contains(radio))));
        const ic = el('span', 'ws-mode-icon');
        ic.setAttribute('aria-hidden', 'true');
        ic.innerHTML = icon(PURPOSE_ICON[p]);
        const text = el('span', 'ws-mode-text');
        text.appendChild(el('strong', null, t(`workspace.mode_${p}`)));
        text.appendChild(el('span', null, t(`workspace.mode_${p}Hint`)));
        label.append(radio, ic, text);
        group.appendChild(label);
      });
      body.appendChild(group);
      body.appendChild(el('p', 'hint', t('onboarding.purposeChangeLater')));
    } else if (step === 'courses') {
      const sem = el('div', 'onb-row onb-row-sem');
      sem.appendChild(labeled(t('onboarding.semesterName'), input('text', 'onb-sem-name', answers.semester.name, { placeholder: t('onboarding.semesterExample'), maxlength: '120' })));
      sem.appendChild(labeled(t('onboarding.semesterStart'), input('date', 'onb-sem-start', answers.semester.start)));
      sem.appendChild(labeled(t('onboarding.semesterEnd'), input('date', 'onb-sem-end', answers.semester.end)));
      body.appendChild(sem);
      body.appendChild(el('p', 'onb-field-label onb-spaced', t('onboarding.coursesQuestion')));
      answers.courses.forEach((c, i) => {
        const row = el('div', 'onb-row onb-row-course');
        row.appendChild(labeled(t('onboarding.courseName'), input('text', 'onb-name', c.name, { placeholder: t(`onboarding.courseExample${i + 1}`), maxlength: '120' })));
        row.appendChild(labeled(t('onboarding.courseCode'), input('text', 'onb-code', c.code, { placeholder: t(`onboarding.codeExample${i + 1}`), maxlength: '32' })));
        body.appendChild(row);
      });
    } else if (step === 'tasks') {
      answers.tasks.forEach((task, i) => {
        const row = el('div', v3 ? 'onb-row onb-row-task3' : 'onb-row');
        // Work / Personal setups get non-academic examples.
        const exampleKey = generalPurpose() ? `onboarding.taskGeneralExample${i + 1}` : `onboarding.taskExample${i + 1}`;
        row.appendChild(labeled(t('onboarding.taskName'), input('text', 'onb-name', task.name, { placeholder: t(exampleKey), maxlength: '80' })));
        row.appendChild(labeled(t('onboarding.minutes'), input('number', 'onb-minutes', task.minutes, { min: '15', max: '600', step: '15', inputmode: 'numeric' })));
        const cs = courseSelect(task.course);
        if (cs) row.appendChild(cs);
        body.appendChild(row);
      });
    } else if (step === 'day') {
      const row = el('div', 'onb-row onb-row-2');
      row.appendChild(labeled(t('onboarding.wake'), input('time', 'onb-wake', answers.day.wake)));
      row.appendChild(labeled(t('onboarding.sleep'), input('time', 'onb-sleep', answers.day.sleep)));
      body.appendChild(row);
    } else if (step === 'classes') {
      answers.classes.forEach((c) => {
        const row = el('div', v3 ? 'onb-row onb-row-class3' : 'onb-row onb-row-class');
        row.appendChild(labeled(t('onboarding.className'), input('text', 'onb-name', c.name, { placeholder: t('onboarding.classExample'), maxlength: '80' })));
        if (v3) row.appendChild(labeled(t('onboarding.weekday'), select('onb-weekday', WEEKDAY_KEYS.map((k, i) => [i, t(k)]), c.weekday)));
        row.appendChild(labeled(t('onboarding.start'), input('time', 'onb-start', c.start)));
        row.appendChild(labeled(t('onboarding.end'), input('time', 'onb-end', c.end)));
        if (v3) {
          const cs = courseSelect(c.course);
          if (cs) row.appendChild(cs);
          const weekly = el('label', 'onb-check');
          const box = input('checkbox', 'onb-weekly', '');
          box.checked = c.weekly !== false;
          // A one-off class is today's; the weekday only matters for weekly ones.
          const daySelect = row.querySelector('.onb-weekday');
          daySelect.disabled = !box.checked;
          box.addEventListener('change', () => { daySelect.disabled = !box.checked; });
          weekly.appendChild(box);
          weekly.appendChild(el('span', null, t('onboarding.everyWeek')));
          row.appendChild(weekly);
        }
        body.appendChild(row);
      });
      body.appendChild(el('p', 'hint', t(v3 ? 'onboarding.classesWeeklyHint' : 'onboarding.classesRecurringHint')));
    } else if (step === 'style') {
      body.appendChild(el('p', 'onb-field-label', t('onboarding.periodQuestion')));
      body.appendChild(choiceGroup('onbPeriod', STUDY_PERIODS, answers.style.period, (v) => t(PERIOD_KEYS[v])));
      body.appendChild(el('p', 'onb-field-label onb-spaced', t('onboarding.sessionQuestion')));
      body.appendChild(choiceGroup('onbSession', SESSION_LENGTHS, answers.style.sessionMinutes, (v) => t('onboarding.sessionMinutes').replace('{n}', v)));
    }
  }

  function render() {
    const step = STEPS[stepIndex];
    const isLast = stepIndex === STEPS.length - 1;
    const steps = q('.onboarding-steps');
    steps.innerHTML = STEPS.map((_, i) => `<li class="${i < stepIndex ? 'done' : i === stepIndex ? 'current' : ''}"></li>`).join('');
    q('.onboarding-skip').textContent = t('onboarding.skip');
    q('.onboarding-eyebrow').textContent = t('onboarding.stepOf').replace('{n}', stepIndex + 1).replace('{total}', STEPS.length);
    // V3 rewords the classes step (a weekly timetable, not just today).
    // V3 rewords the classes step; V4 Work / Personal setups reword the tasks step.
    const copyKey = v3 && step === 'classes' ? 'classes3' : step === 'tasks' && generalPurpose() ? 'tasksGeneral' : step;
    q('.onboarding-title').textContent = t(`onboarding.${copyKey}Title`);
    q('.onboarding-lead').textContent = t(`onboarding.${copyKey}Lead`);
    q('.onboarding-error').textContent = '';
    renderBody(step);
    const back = q('.onboarding-back');
    back.textContent = t('onboarding.back');
    back.hidden = stepIndex === 0;
    const nextBtn = q('.onboarding-next');
    if (isLast) {
      readStep();
      const plan = buildOnboardingPlan(answers);
      nextBtn.textContent = canBuildPlan(plan) ? t('onboarding.build') : t('onboarding.finish');
    } else {
      nextBtn.textContent = t('onboarding.next');
    }
    nextBtn.disabled = busy;
    back.disabled = busy;
    const first = q('.onboarding-body input, .onboarding-body select');
    if (first) first.focus();
  }

  // Point at the exact field(s) an error is about.
  const FIELD_SELECTORS = { name: '.onb-name', minutes: '.onb-minutes', time: '.onb-start, .onb-end', wake: '.onb-wake', sleep: '.onb-sleep', purpose: 'input[name="onbPurpose"]', semName: '.onb-sem-name', semDates: '.onb-sem-start, .onb-sem-end', weekday: '.onb-weekday' };
  function markInvalid(errors) {
    const body = q('.onboarding-body');
    const rows = body.querySelectorAll(STEPS[stepIndex] === 'courses' ? '.onb-row-course' : '.onb-row');
    let first = null;
    errors.forEach((err) => {
      const scope = Number.isInteger(err.index) ? rows[err.index] : body;
      const selector = FIELD_SELECTORS[err.field];
      if (!scope || !selector) return;
      scope.querySelectorAll(selector).forEach((node) => {
        node.setAttribute('aria-invalid', 'true');
        if (!first) first = node;
      });
    });
    if (first) first.focus();
  }

  async function next() {
    if (busy) return;
    readStep();
    const step = STEPS[stepIndex];
    const result = validateOnboardingStep(step, answers);
    q('.onboarding-body').querySelectorAll('[aria-invalid]').forEach((node) => node.removeAttribute('aria-invalid'));
    if (!result.ok) {
      q('.onboarding-error').textContent = t(result.errors[0].key);
      markInvalid(result.errors);
      return;
    }
    if (step === 'purpose') STEPS = onboardingStepsV4({ courses: v3, purpose: answers.purpose });
    if (stepIndex < STEPS.length - 1) {
      stepIndex += 1;
      render();
      return;
    }
    await finish({ build: true });
  }

  async function finish({ build }) {
    if (busy) return;
    busy = true;
    const nextBtn = q('.onboarding-next');
    nextBtn.disabled = true;
    try {
      // V4: save the chosen purpose (workspace mode) first — also on Skip
      // once it has been answered.
      if (answers.purpose && typeof host.applyPurpose === 'function') await host.applyPurpose(answers.purpose);
      if (build) {
        const plan = buildOnboardingPlan(answers);
        const academics = v3 ? buildOnboardingAcademics(answers, { today: host.today() }) : null;
        nextBtn.textContent = t('onboarding.building');
        const hasAcademics = academics && (academics.semester || academics.courses.length || academics.weeklyClasses.length);
        if (plan.day || plan.classes.length || plan.tasks.length || hasAcademics) await host.applyPlan(plan, academics);
      }
      await host.markComplete();
      close();
    } catch (err) {
      console.error('Onboarding could not finish:', err);
      busy = false;
      render();
      q('.onboarding-error').textContent = t('onboarding.errSave');
    } finally {
      busy = false;
    }
  }

  function open() {
    if (!overlay) build();
    stepIndex = 0;
    v3 = Boolean(host.isV3 && host.isV3());
    STEPS = onboardingStepsV4({ courses: v3, purpose: null });
    answers = v3 ? defaultOnboardingAnswersV3(host.today()) : defaultOnboardingAnswers();
    answers.purpose = null;
    returnFocusTo = document.activeElement;
    overlay.hidden = false;
    document.body.classList.add('onboarding-open');
    render();
  }

  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove('onboarding-open');
    if (returnFocusTo && typeof returnFocusTo.focus === 'function') returnFocusTo.focus();
  }

  return { open, close };
}
