// Settings › Planner › "Energy & capacity" (V4-E): peak focus time, lighter
// days and whether routines count against the daily study limit. Saved in
// profiles.preferences.energy; used by the workload forecast, Plan my
// backlog, Catch up, and as the preferred study time of newly created days.

import { t } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { addDays } from '../shared/dates.js';
import { fmtWeekday } from '../ui/format.js';
import { PEAKS } from '../planner/energyModel.js';
import { loadEnergy, saveEnergy } from '../planner/energyData.js';

const SUNDAY = '2026-10-04';

export async function renderEnergy(root) {
  if (!root) return;
  const userId = app().userId;
  let energy;
  try {
    energy = await loadEnergy(userId);
  } catch {
    energy = null;
  }
  root.innerHTML = '';
  root.appendChild(h('h3', { class: 'settings3-subhead', id: 'energyHead' }, t('energy.title')));
  root.appendChild(h('p', { class: 'hint' }, t('energy.hint')));
  const form = h('form', { class: 'energy-form', 'aria-labelledby': 'energyHead', novalidate: true });

  const peak = h('select', { id: 'energyPeak', class: 'input' });
  PEAKS.forEach((p) => peak.appendChild(h('option', { value: p }, t(`energy.peak_${p}`))));
  peak.value = energy ? energy.peak : 'none';
  form.appendChild(h('div', { class: 'field' }, h('label', { for: 'energyPeak' }, t('energy.peakLabel')), peak, h('p', { class: 'field-hint' }, t('energy.peakHint'))));

  const days = new Set(energy ? energy.lightDays : []);
  const dayRow = h('div', { class: 'day-toggle-row', role: 'group', 'aria-labelledby': 'energyDaysLabel' });
  [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
    const b = h('button', { type: 'button', class: 'day-toggle', 'aria-pressed': days.has(d) ? 'true' : 'false', 'data-day': String(d) }, fmtWeekday(addDays(SUNDAY, d), 'short'));
    b.addEventListener('click', () => {
      if (days.has(d)) days.delete(d); else days.add(d);
      b.setAttribute('aria-pressed', days.has(d) ? 'true' : 'false');
    });
    dayRow.appendChild(b);
  });
  form.appendChild(h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'energyDaysLabel' }, t('energy.lightDaysLabel')), dayRow, h('p', { class: 'field-hint' }, t('energy.lightDaysHint'))));

  const pct = h('input', { type: 'number', id: 'energyPct', class: 'input settings3-num', min: '25', max: '100', step: '5', inputmode: 'numeric', value: String(energy ? energy.lightPercent : 60) });
  form.appendChild(h('div', { class: 'field' }, h('label', { for: 'energyPct' }, t('energy.lightPercentLabel')), h('div', { class: 'energy-pct-row' }, pct, h('span', { class: 'muted' }, '%'))));

  const routines = h('input', { type: 'checkbox', id: 'energyRoutines' });
  routines.checked = Boolean(energy && energy.countRoutines);
  form.appendChild(h('div', { class: 'checkbox-row' }, routines, h('label', { for: 'energyRoutines' }, t('energy.countRoutines'))));

  const msg = h('p', { class: 'hint', 'aria-live': 'polite' });
  form.appendChild(h('div', { class: 'settings-btn-row' }, h('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, h('span', {}, t('common.save')))));
  form.appendChild(msg);
  if (!has('preferences')) form.appendChild(h('p', { class: 'hint' }, t('energy.localOnly')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = Number(pct.value);
    if (!Number.isInteger(n) || n < 25 || n > 100) {
      msg.textContent = t('energy.pctInvalid');
      msg.classList.add('hint-error');
      pct.setAttribute('aria-invalid', 'true');
      pct.focus();
      return;
    }
    pct.removeAttribute('aria-invalid');
    msg.classList.remove('hint-error');
    try {
      await saveEnergy(userId, { peak: peak.value, lightDays: [...days], lightPercent: n, countRoutines: routines.checked });
      msg.textContent = t('settings3.saved');
    } catch (err) {
      console.error(err);
      msg.textContent = t('settings3.saveFailed');
      msg.classList.add('hint-error');
    }
  });
  root.appendChild(form);
}
