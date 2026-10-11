// Project templates (V4-H), pure. A template is a ready-made set of
// milestones and tasks with offsets in days from the project's start date,
// so "Research paper" or "Internship applications" starts with a sensible
// plan the student can edit. Titles are translated in the UI
// (projTpl.<template>_* keys). Nothing is created until the project is saved.

import { addDays } from '../shared/dates.js';

export const PROJECT_TEMPLATES = {
  researchPaper: {
    days: 42,
    milestones: [['m_topic', 7], ['m_draft', 28], ['m_final', 42]],
    tasks: [['t_question', 60, 3, 0], ['t_sources', 120, 6, 0], ['t_outline', 60, 10, 1], ['t_write', 240, 24, 1], ['t_feedback', 60, 31, 2], ['t_revise', 120, 38, 2], ['t_cite', 45, 41, 2]],
  },
  applications: {
    days: 30,
    milestones: [['m_materials', 10], ['m_sent', 24], ['m_followup', 30]],
    tasks: [['t_list', 60, 2, 0], ['t_resume', 90, 6, 0], ['t_letter', 90, 9, 0], ['t_apply', 180, 20, 1], ['t_track', 30, 24, 1], ['t_follow', 30, 29, 2]],
  },
  portfolio: {
    days: 35,
    milestones: [['m_design', 10], ['m_build', 28], ['m_launch', 35]],
    tasks: [['t_pick', 60, 3, 0], ['t_sketch', 90, 8, 0], ['t_buildHome', 180, 16, 1], ['t_cases', 180, 25, 1], ['t_review', 60, 31, 2], ['t_deploy', 60, 35, 2]],
  },
  event: {
    days: 28,
    milestones: [['m_plan', 7], ['m_book', 14], ['m_day', 28]],
    tasks: [['t_budget', 45, 3, 0], ['t_guests', 45, 6, 0], ['t_venue', 60, 12, 1], ['t_invite', 45, 14, 1], ['t_confirm', 30, 24, 2], ['t_supplies', 60, 26, 2]],
  },
};
export const PROJECT_TEMPLATE_IDS = Object.keys(PROJECT_TEMPLATES);

/**
 * Concrete milestones + tasks for a template from a start date.
 * Dates never go past the project's due date when one is given.
 * @returns {{ milestones: Array<{key, dueDate}>, tasks: Array<{key, minutes, dueDate, milestoneIndex}>, dueDate }}
 */
export function buildFromTemplate(templateId, startDate, dueDate = null) {
  const tpl = PROJECT_TEMPLATES[templateId];
  if (!tpl) return { milestones: [], tasks: [], dueDate };
  const end = dueDate || addDays(startDate, tpl.days);
  // Stretch or compress the template to fit [start, end].
  const span = Math.max(0, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000));
  const at = (offset) => addDays(startDate, Math.min(span, Math.round((offset / tpl.days) * span)));
  return {
    dueDate: end,
    milestones: tpl.milestones.map(([key, offset]) => ({ key, dueDate: at(offset) })),
    tasks: tpl.tasks.map(([key, minutes, offset, m]) => ({ key, minutes, dueDate: at(offset), milestoneIndex: m })),
  };
}
