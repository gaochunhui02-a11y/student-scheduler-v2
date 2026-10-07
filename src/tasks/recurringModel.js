// Recurring academic tasks (V3-H), pure: "weekly reading every Tuesday",
// "lab prep every Thursday". A rule never creates anything by itself — the
// caller asks planGeneration() which occurrences in a window still need a
// task, and the database's unique (rule, occurrence date) index guarantees
// a second run can't create duplicates even if two tabs race.

import { addDays, dateRange, dayOfWeek, isValidDateStr, diffDays } from '../shared/dates.js';

export const DEFAULT_HORIZON_DAYS = 14;

export function validateRuleFields(input = {}) {
  const errors = {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : '';
  if (!name) errors.name = 'recur.errName';
  const days = [...new Set((Array.isArray(input.days_of_week) ? input.days_of_week : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!days.length) errors.days_of_week = 'recur.errDays';
  const minutes = Number(input.minutes);
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) errors.minutes = 'recur.errMinutes';
  if (!isValidDateStr(input.start_date)) errors.start_date = 'recur.errStart';
  if (!isValidDateStr(input.end_date)) errors.end_date = 'recur.errEnd';
  else if (isValidDateStr(input.start_date) && (input.end_date < input.start_date || diffDays(input.start_date, input.end_date) > 400)) errors.end_date = 'recur.errEndOrder';
  const offset = Number(input.due_offset_days ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 30) errors.due_offset_days = 'recur.errOffset';
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    fields: {
      name,
      days_of_week: days,
      minutes: Number.isFinite(minutes) ? Math.round(minutes) : 60,
      start_date: input.start_date,
      end_date: input.end_date,
      due_offset_days: Number.isInteger(offset) ? offset : 0,
      priority: ['low', 'medium', 'high'].includes(input.priority) ? input.priority : 'medium',
      course_id: input.course_id || null,
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 8) : [],
      active: input.active !== false,
    },
  };
}

// Occurrence dates of a rule inside [from, to] (inclusive).
export function occurrencesInRange(rule, from, to) {
  if (!rule || !rule.active || !isValidDateStr(rule.start_date) || !isValidDateStr(rule.end_date)) return [];
  const start = from > rule.start_date ? from : rule.start_date;
  const end = to < rule.end_date ? to : rule.end_date;
  if (end < start) return [];
  const days = new Set((rule.days_of_week || []).map(Number));
  return dateRange(start, end).filter((d) => days.has(dayOfWeek(d)));
}

/**
 * Tasks to create so every occurrence in [today, today + horizon] exists.
 * @param {Array} rules
 * @param {Array} existingRows study_subjects rows with recurrence_rule_id + recurrence_date
 * @returns {Array<{ruleId, occurrenceDate, planDate, dueDate, fields}>}
 */
export function planGeneration(rules = [], existingRows = [], today, horizonDays = DEFAULT_HORIZON_DAYS) {
  const have = new Set(existingRows.filter((r) => r.recurrence_rule_id).map((r) => `${r.recurrence_rule_id}|${r.recurrence_date}`));
  const to = addDays(today, horizonDays);
  const out = [];
  rules.forEach((rule) => {
    occurrencesInRange(rule, today, to).forEach((date) => {
      if (have.has(`${rule.id}|${date}`)) return;
      have.add(`${rule.id}|${date}`);
      out.push({
        ruleId: rule.id,
        occurrenceDate: date,
        planDate: date,
        dueDate: addDays(date, rule.due_offset_days || 0),
        fields: {
          name: rule.name,
          minutes_requested: rule.minutes,
          priority: rule.priority || 'medium',
          tags: Array.isArray(rule.tags) ? rule.tags : [],
          course_id: rule.course_id || null,
          due_date: addDays(date, rule.due_offset_days || 0),
          recurrence_rule_id: rule.id,
          recurrence_date: date,
        },
      });
    });
  });
  return out.sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate) || String(a.ruleId).localeCompare(String(b.ruleId)));
}

export function describeRuleDays(rule, weekdayLabel) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.filter((d) => (rule.days_of_week || []).map(Number).includes(d)).map(weekdayLabel).join(', ');
}
