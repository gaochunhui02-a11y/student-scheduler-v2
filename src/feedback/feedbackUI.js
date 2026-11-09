// "Send feedback" (V5-D): bug / confusing / idea + a message, optionally
// with the name of the page it's about. Saved to public.feedback (0027) as
// the student's own row. Nothing else is attached — no screenshots, no
// task data, no device fingerprint.

import { t } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { openDrawer } from '../ui/drawer.js';
import { toast } from '../ui/toast.js';
import { app } from '../app/context.js';
import { has } from '../shared/capabilities.js';
import { supabase } from '../lib/supabaseClient.js';
import { APP_VERSION } from '../app/version.js';
import { track } from '../analytics/productEvents.js';

const KINDS = ['bug', 'confusing', 'idea', 'other'];
const PAGE_OF = { todayView: 'today', plannerForm: 'planner', tasksView: 'tasks', coursesView: 'courses', projectsView: 'projects', goalsView: 'goals', routinesView: 'routines', calendarView: 'calendar', weekView: 'week', boardView: 'board', insightsView: 'insights', analyticsView: 'home', settingsView: 'settings', examsView: 'exams', gradesView: 'grades', semesterView: 'semester', notesView: 'notes', reviewView: 'review', historyView: 'history' };

export function feedbackPage(viewId) {
  return PAGE_OF[viewId] || 'other';
}

export function openFeedback() {
  const ctx = app();
  const page = feedbackPage(ctx.currentView ? ctx.currentView() : null);
  let kind = 'idea';
  const canSend = has('feedback') && !ctx.isDemo;
  openDrawer({
    title: t('feedback.title'),
    subtitle: t('feedback.sub'),
    size: 'narrow',
    render: (body, api) => {
      if (ctx.isDemo) body.appendChild(h('p', { class: 'notice notice--info' }, t('feedback.demo')));
      else if (!has('feedback')) body.appendChild(h('p', { class: 'notice notice--info' }, t('feedback.unavailable')));
      const group = h('div', { class: 'feedback-kinds', role: 'radiogroup', 'aria-label': t('feedback.kindLabel') });
      KINDS.forEach((k) => {
        const id = `fbKind-${k}`;
        const r = h('input', { type: 'radio', name: 'fbKind', id, value: k });
        r.checked = k === kind;
        r.addEventListener('change', () => { kind = k; });
        group.appendChild(h('label', { for: id, class: 'feedback-kind' }, r, h('span', {}, t(`feedback.kind_${k}`))));
      });
      const msg = h('textarea', { id: 'fbMessage', class: 'v3-input', rows: '6', maxlength: '4000', placeholder: t('feedback.placeholder') });
      const withPage = h('input', { type: 'checkbox', id: 'fbPage' });
      withPage.checked = true;
      const err = h('p', { class: 'field-error', role: 'alert' });
      body.append(group,
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'fbMessage' }, t('feedback.messageLabel')), msg),
        h('div', { class: 'checkbox-row' }, withPage, h('label', { for: 'fbPage' }, t('feedback.includePage').replace('{page}', t(`feedback.page_${page}`)))),
        h('p', { class: 'field-hint' }, t('feedback.privacy')),
        err);
      api.setActions([
        { label: t('common.cancel'), onClick: (a) => a.close() },
        {
          label: t('feedback.send'),
          variant: 'primary',
          onClick: async (a) => {
            const text = msg.value.trim();
            if (!text) { err.textContent = t('feedback.empty'); msg.focus(); return; }
            if (!canSend) { err.textContent = ctx.isDemo ? t('feedback.demo') : t('feedback.unavailable'); return; }
            a.setBusy(true);
            const { error } = await supabase.from('feedback').insert({
              user_id: ctx.userId,
              kind,
              message: text.slice(0, 4000),
              page: withPage.checked ? page : '',
              app_version: APP_VERSION.slice(0, 32),
            });
            if (error) {
              a.setBusy(false);
              err.textContent = t('feedback.failed');
              return;
            }
            track('feedback_sent', { kind });
            a.close(true);
            toast(t('feedback.thanks'), { kind: 'success' });
          },
        },
      ]);
      if (!canSend) api.panel.querySelector('.drawer-foot .btn--primary')?.setAttribute('disabled', '');
      msg.focus();
    },
  });
}
