// One task row, shared by the Tasks page, course pages and the Dashboard.

import { t } from '../shared/i18n.js';
import { has } from '../shared/capabilities.js';
import { todayStr, diffDays } from '../shared/dates.js';
import { html, raw, safeColor } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { badge } from '../ui/components.js';
import { fmtDue, fmtMinutes, fmtClockStr, fmtDate } from '../ui/format.js';
import { statusBadgeHtml, statusLabelKey } from '../shared/statusModel.js';
import { tagLabel } from './taskEditorSections.js';

export function taskStatusBadge(group, blockedInfo = null) {
  if (!group.done && blockedInfo && blockedInfo.blocked) return badge(t('tasks.statusBlocked'), 'warning');
  // V4-B explicit statuses (only set by the student; V3 tasks never have them)
  if (!group.done && group.statusOverride === 'deferred') return badge(t('tasks.status_deferred'), 'outline');
  if (!group.done && group.statusOverride === 'in_progress' && group.status === 'unscheduled') return badge(t('tasks.status_in_progress'), 'accent');
  // V4-B.1: "Unscheduled" = no planned day (backlog); a planned day without
  // a timed block yet shows that day instead of V3's ambiguous "Not scheduled".
  if (group.status === 'unscheduled') {
    if (!group.scheduledDate && group.firstDate == null) return badge(t('tasks.statusBacklog'), 'outline');
    const day = group.scheduledDate || group.firstDate;
    return badge(t('tasks.statusPlannedOn').replace('{date}', fmtDate(day)), 'outline');
  }
  return raw(statusBadgeHtml(group.status, t(statusLabelKey(group.status)), { compact: true }));
}

/**
 * @param {object} group      task group (taskModel)
 * @param {object} [opts]
 * @param {object} [opts.course]
 * @param {boolean} [opts.showCourse]
 * @param {object} [opts.blockedInfo]  from dependencyModel.computeBlockedState
 * @param {string} [opts.today]
 */
export function taskRowHtml(group, { course = null, showCourse = false, project = null, blockedInfo = null, today = todayStr() } = {}) {
  const dueText = group.dueDate ? `${fmtDue(group.dueDate, today)}${group.dueTime ? ` ${fmtClockStr(group.dueTime)}` : ''}` : '';
  const soon = group.dueDate && !group.done && diffDays(today, group.dueDate) <= 2;
  const dueClass = group.overdue ? 'badge--danger' : soon ? 'badge--warning' : 'badge--outline';
  const waiting = blockedInfo && (blockedInfo.blocked || blockedInfo.overridden) && blockedInfo.waitingOn.length ? blockedInfo.waitingOn : null;
  return html`<div class="list-row task-row${group.done ? ' is-done' : ''}${blockedInfo && blockedInfo.blocked ? ' is-blocked' : ''}" data-task-id="${group.id}">
    ${has('taskExtensions') ? html`<button type="button" class="task-check${group.done ? ' is-checked' : ''}" data-action="toggle-done" aria-pressed="${group.done ? 'true' : 'false'}" aria-label="${group.done ? t('tasks.markNotDone') : t('tasks.markDone')}: ${group.name}">${raw(icon('check'))}</button>` : ''}
    <button type="button" class="list-row-main task-open" data-action="open-task">
      <span class="list-row-title">${group.name}</span>
      <span class="list-row-meta">
        ${project ? html`<span class="task-project">${raw(icon('briefcase'))}${project.title}</span>` : ''}
        ${showCourse && course ? html`<span class="course-chip" style="--c:${safeColor(course.color)}"><span class="course-dot"></span>${course.code || course.name}</span>` : ''}
        ${group.remainingMinutes > 0 ? html`<span>${t('tasks.leftShort').replace('{time}', fmtMinutes(group.remainingMinutes))}</span>` : ''}
        ${waiting ? html`<span class="task-waiting">${raw(icon('branch'))}${t('deps.waitingOn').replace('{name}', waiting.map((w) => w.name).join(', '))}${blockedInfo.overridden ? ` · ${t('deps.overriddenShort')}` : ''}</span>` : ''}
        ${group.recurrenceRuleId ? html`<span class="task-repeat" title="${t('recur.repeats')}">${raw(icon('repeat'))}</span>` : ''}
        ${group.tags.slice(0, 2).map((tag) => html`<span class="muted">#${tagLabel(tag)}</span>`)}
      </span>
    </button>
    <span class="list-row-side">
      ${dueText ? html`<span class="badge ${dueClass}">${group.overdue ? t('tasks.overdueShort') : dueText}</span>` : ''}
      ${taskStatusBadge(group, blockedInfo)}
    </span>
  </div>`;
}
