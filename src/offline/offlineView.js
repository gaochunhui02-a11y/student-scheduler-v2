// Read-only Dashboard shown from the offline snapshot (V3-P).

import { t } from '../shared/i18n.js';
import { html, raw, safeColor } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button } from '../ui/components.js';
import { fmtClock, fmtDate, fmtDateLong, fmtDue, fmtMinutes } from '../ui/format.js';

// Local date + clock time in the app language (never the browser locale).
function savedAtLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${fmtDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)} ${fmtClock(d.getHours() * 60 + d.getMinutes())}`;
}

export function offlineSnapshotView(s, { today, retryAction }) {
  const courseById = new Map(s.courses.map((c) => [c.id, c]));
  const dot = (id) => {
    const c = courseById.get(id);
    return c ? html`<span class="course-dot" style="--c:${safeColor(c.color)}" aria-hidden="true"></span>` : '';
  };
  const stale = s.date !== today;
  return html`<div class="offline-snapshot">
    <div class="notice notice--warning" role="status">
      ${raw(icon('offline'))}
      <div style="flex:1">
        <p class="notice-title">${t('offline.snapshotTitle')}</p>
        <p>${t('offline.snapshotBody').replace('{time}', savedAtLabel(s.savedAt))}</p>
        ${stale ? html`<p>${t('offline.snapshotOld').replace('{date}', fmtDateLong(s.date))}</p>` : ''}
      </div>
      ${button(t('common.retry'), { size: 'sm', action: retryAction })}
    </div>
    <section>
      <h3>${stale ? fmtDateLong(s.date) : t('offline.today')}</h3>
      ${s.timeline.length ? html`<ul>${s.timeline.map((e) => html`<li>
        <span>${dot(e.courseId)} ${e.title}${e.completed ? html` <span class="muted">· ${t('offline.done')}</span>` : ''}</span>
        <span class="muted">${fmtClock(e.start)}–${fmtClock(e.end)}</span>
      </li>`)}</ul>` : html`<p class="hint">${t('offline.nothingToday')}</p>`}
    </section>
    <section>
      <h3>${t('offline.openTasks')}</h3>
      ${s.tasks.length ? html`<ul>${s.tasks.map((g) => html`<li>
        <span>${dot(g.courseId)} ${g.name}</span>
        <span class="muted">${g.dueDate ? fmtDue(g.dueDate, today) : ''}${g.remainingMinutes ? ` · ${fmtMinutes(g.remainingMinutes)}` : ''}</span>
      </li>`)}</ul>` : html`<p class="hint">${t('offline.noTasks')}</p>`}
    </section>
    ${s.exams.length ? html`<section>
      <h3>${t('offline.exams')}</h3>
      <ul>${s.exams.map((x) => html`<li><span>${dot(x.courseId)} ${x.name}</span><span class="muted">${fmtDate(x.date)}</span></li>`)}</ul>
    </section>` : ''}
  </div>`;
}
