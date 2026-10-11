// Focus timer dialog (V4-I): start a focused session on any task — or on
// nothing — from Today, the task editor or the command palette. Uses the
// side drawer (focus is trapped and returned), updates once a second with a
// timestamp-based clock, announces 10 / 5 / 1 minutes left politely to
// screen readers, and on finishing records a focus session (history,
// Insights, Weekly review) and can add the time to the task's "time spent".

import { t } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { openDrawer } from '../ui/drawer.js';
import { toast } from '../ui/toast.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { supabase } from '../lib/supabaseClient.js';
import { invalidateTasks } from '../academics/academicsData.js';
import { emitChange } from '../app/context.js';
import { recordFocusSession } from './focusHistory.js';
import { PRESETS, clampMinutes, startTimer, pauseTimer, resumeTimer, remaining, formatClock, finishTimer, shouldAnnounce } from './focusTimerModel.js';

let active = null; // one timer at a time

/**
 * @param {{ task?: { id: string, name: string, actualMinutes?: number|null, remainingMinutes?: number } }} [opts]
 */
export function openFocusTimer({ task = null } = {}) {
  if (active) { active.api.panel.querySelector('[data-role="clock"]')?.focus(); return; }
  const originalTitle = document.title;
  const restoreTitle = () => { document.title = originalTitle; };
  let state = null;
  let interval = null;
  let lastMs = null;
  const suggested = task && task.remainingMinutes ? clampMinutes(Math.min(50, task.remainingMinutes)) : 25;

  const api = openDrawer({
    title: t('focusTimer.title'),
    subtitle: task ? task.name : t('focusTimer.noTask'),
    size: 'narrow',
    onClose: () => {
      if (state && state.status !== 'done') {
        // Closing mid-session asks first (the drawer stays open on "No").
        if (!window.confirm(t('focusTimer.confirmClose'))) return false;
        finish(false, { silent: true });
      }
      clearInterval(interval);
      restoreTitle();
      active = null;
      return true;
    },
    render: () => {},
    actions: [],
  });
  active = { api };
  paintSetup();

  function paintSetup(body = api.body) {
    body.innerHTML = '';
    body.appendChild(h('p', { class: 'hint' }, t('focusTimer.intro')));
    const group = h('div', { class: 'seg', role: 'group', 'aria-label': t('focusTimer.length') });
    let chosen = suggested;
    const input = h('input', { type: 'number', id: 'ft-minutes', min: '1', max: '180', step: '5', inputmode: 'numeric', value: String(chosen) });
    PRESETS.forEach((m) => {
      const b = h('button', { type: 'button', 'aria-pressed': m === chosen ? 'true' : 'false' }, t('focusTimer.minutes').replace('{n}', String(m)));
      b.addEventListener('click', () => {
        chosen = m;
        input.value = String(m);
        group.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      });
      group.appendChild(b);
    });
    input.addEventListener('input', () => group.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false')));
    body.appendChild(group);
    body.appendChild(h('div', { class: 'field ft-custom' }, h('label', { for: 'ft-minutes' }, t('focusTimer.custom')), input));
    api.setActions([
      { label: t('common.cancel'), onClick: (a) => a.close() },
      { label: t('focusTimer.start'), variant: 'primary', onClick: () => start(clampMinutes(input.value)) },
    ]);
  }

  function paintRunning() {
    const body = api.body;
    body.innerHTML = '';
    const left = remaining(state, Date.now());
    body.appendChild(h('div', { class: 'ft-clock-wrap' },
      h('span', { class: 'ft-clock tabular', 'data-role': 'clock', tabindex: '-1', role: 'timer', 'aria-label': t('focusTimer.timeLeft') }, formatClock(left.ms)),
      h('span', { class: 'ft-status muted', 'data-role': 'status' }, state.status === 'paused' ? t('focusTimer.paused') : t('focusTimer.focusing'))));
    body.appendChild(h('p', { class: 'sr-only', 'aria-live': 'polite', 'data-role': 'announce' }));
    const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': t('focusTimer.progress') }, h('span', {}));
    body.appendChild(bar);
    tick();
    api.setActions([
      { label: t('focusTimer.stop'), variant: 'secondary', start: true, onClick: () => finish(false) },
      { label: state.status === 'paused' ? t('focusTimer.resume') : t('focusTimer.pause'), onClick: () => { state = state.status === 'paused' ? resumeTimer(state, Date.now()) : pauseTimer(state, Date.now()); paintRunning(); } },
      { label: t('focusTimer.finish'), variant: 'primary', onClick: () => finish(true) },
    ]);
  }

  function tick() {
    if (!state) return;
    const now = Date.now();
    const left = remaining(state, now);
    const clock = api.body.querySelector('[data-role="clock"]');
    if (clock) clock.textContent = formatClock(left.ms);
    const pct = Math.round((1 - left.ms / (state.plannedMinutes * 60000)) * 100);
    const bar = api.body.querySelector('.bar');
    if (bar) { bar.setAttribute('aria-valuenow', String(pct)); bar.firstChild.style.width = `${pct}%`; }
    const mark = lastMs !== null ? shouldAnnounce(lastMs, left.ms) : null;
    if (mark) {
      const live = api.body.querySelector('[data-role="announce"]');
      if (live) live.textContent = t('focusTimer.minutesLeft').replace('{n}', String(mark / 60000));
    }
    lastMs = left.ms;
    document.title = `${formatClock(left.ms)} · ${t('focusTimer.title')}`;
    if (left.done && state.status === 'running') finish(true, { natural: true });
  }

  function start(minutes) {
    state = startTimer(minutes, Date.now());
    lastMs = null;
    paintRunning();
    api.body.querySelector('[data-role="clock"]')?.focus();
    interval = setInterval(tick, 1000);
  }

  async function finish(early, { natural = false, silent = false } = {}) {
    if (!state || state.status === 'done') return;
    clearInterval(interval);
    const endedAt = Date.now();
    const result = finishTimer(state, endedAt, { early });
    const startedAt = state.startedAt;
    state = { ...state, status: 'done' };
    restoreTitle();
    try {
      await recordFocusSession(app().userId, { item: { id: null, sourceSubjectId: task ? task.id : null }, plannedMinutes: result.plannedMinutes, actualMinutes: result.minutes, outcome: result.outcome, startedAt, endedAt });
    } catch (err) {
      console.error('Could not record the focus session', err);
    }
    if (silent) return;
    if (natural) {
      try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) new Notification(t('focusTimer.doneTitle'), { body: task ? task.name : '', icon: '/icons/icon-192.png' }); } catch { /* optional */ }
    }
    paintDone(result);
  }

  function paintDone(result) {
    const body = api.body;
    body.innerHTML = '';
    body.appendChild(h('p', { class: 'ft-done-title', tabindex: '-1' }, result.minutes ? t('focusTimer.doneBody').replace('{n}', String(result.minutes)) : t('focusTimer.tooShort')));
    const canLog = task && result.minutes >= 1 && has('taskExtensions');
    let logBox = null;
    if (canLog) {
      logBox = h('input', { type: 'checkbox', id: 'ft-log' });
      logBox.checked = true;
      body.appendChild(h('div', { class: 'checkbox-row' }, logBox, h('label', { for: 'ft-log' }, t('focusTimer.addToTask').replace('{n}', String(result.minutes)))));
    }
    body.querySelector('.ft-done-title').focus();
    api.setActions([
      { label: t('focusTimer.again'), onClick: () => { state = null; paintSetup(); } },
      {
        label: t('common.done'),
        variant: 'primary',
        onClick: async (a) => {
          if (logBox && logBox.checked) {
            try {
              const { data } = await supabase.from('study_subjects').select('actual_minutes').eq('id', task.id).maybeSingle();
              const next = Math.min(10000, (Number(data && data.actual_minutes) || 0) + result.minutes);
              const { error } = await supabase.from('study_subjects').update({ actual_minutes: next }).eq('id', task.id);
              if (error) throw error;
              invalidateTasks();
              emitChange('tasks');
              toast(t('focusTimer.logged').replace('{n}', String(result.minutes)), { kind: 'success' });
            } catch (err) {
              console.error(err);
              toast(t('v3.saveError'), { kind: 'error' });
            }
          }
          state = null;
          a.close(true);
          active = null;
        },
      },
    ]);
  }

}

/** Is a focus timer open right now? */
export function focusTimerOpen() {
  return Boolean(active);
}
