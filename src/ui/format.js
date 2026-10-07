// Locale-aware display formatting for V3 views. Dates are "YYYY-MM-DD"
// local calendar dates; they are turned into Date objects at LOCAL noon so
// no timezone offset can ever display them as the neighbouring day.

import { t, getLocale } from '../shared/i18n.js';
import { diffDays, todayStr } from '../shared/dates.js';

function noon(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
}

export function fmtDate(dateStr, opts = { month: 'short', day: 'numeric' }) {
  if (!dateStr) return '';
  return noon(dateStr).toLocaleDateString(getLocale(), opts);
}
export function fmtDateLong(dateStr) {
  return fmtDate(dateStr, { weekday: 'long', month: 'long', day: 'numeric' });
}
export function fmtDateWithYear(dateStr) {
  return fmtDate(dateStr, { month: 'short', day: 'numeric', year: 'numeric' });
}
export function fmtWeekday(dateStr, style = 'short') {
  return fmtDate(dateStr, { weekday: style });
}
export function fmtMonthYear(dateStr) {
  return fmtDate(dateStr, { month: 'long', year: 'numeric' });
}

// minutes since midnight -> locale clock ("9:30 AM" / "09:30")
export function fmtClock(minutes) {
  if (!Number.isFinite(minutes)) return '';
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
  return d.toLocaleTimeString(getLocale(), { hour: 'numeric', minute: '2-digit' });
}
export function fmtClockStr(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  return fmtClock(h * 60 + m);
}

// 135 -> "2h 15m", 45 -> "45m", 0 -> "0m" (unit letters translated)
export function fmtMinutes(total) {
  const n = Math.max(0, Math.round(Number(total) || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  const hu = t('units.hShort');
  const mu = t('units.mShort');
  if (h === 0) return `${m}${mu}`;
  if (m === 0) return `${h}${hu}`;
  return `${h}${hu} ${m}${mu}`;
}

// "Today" / "Tomorrow" / "Yesterday" / "in 3 days" / "2 days ago"
export function fmtRelativeDay(dateStr, today = todayStr()) {
  if (!dateStr) return '';
  const n = diffDays(today, dateStr);
  if (n === 0) return t('time.today');
  if (n === 1) return t('time.tomorrow');
  if (n === -1) return t('time.yesterday');
  if (n > 1) return t('time.inDays').replace('{n}', String(n));
  return t('time.daysAgo').replace('{n}', String(-n));
}

// Compact "Due …" text: relative within a week, otherwise the date.
export function fmtDue(dateStr, today = todayStr()) {
  if (!dateStr) return '';
  const n = diffDays(today, dateStr);
  if (Math.abs(n) <= 6) return fmtRelativeDay(dateStr, today);
  return fmtDate(dateStr);
}

export function fmtPercent(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(digits));
  return `${rounded.toLocaleString(getLocale(), { maximumFractionDigits: digits })}%`;
}

export function fmtNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  return Number(value.toFixed(digits)).toLocaleString(getLocale(), { maximumFractionDigits: digits });
}
