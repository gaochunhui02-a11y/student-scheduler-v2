// App-wide keyboard shortcuts (V3-Q). Deliberately few, so they're
// memorable:
//   Ctrl/⌘ K    command palette (search everything)   — handled in dashboard.js
//   /           search (opens the palette)
//   N           Quick Add
//   ?           this list
//   G then H/T/P/W/C/E   go to Home / Tasks / Planner / Week / Calendar / Exams
// Single-key shortcuts never fire while typing in a field or while a
// drawer / dialog is open.

import { isTypingTarget } from './commandPalette.js';

export const SHORTCUTS = [
  { keys: ['Ctrl/⌘', 'K'], labelKey: 'kbd.palette' },
  { keys: ['/'], labelKey: 'kbd.search' },
  { keys: ['N'], labelKey: 'kbd.quickAdd' },
  { keys: ['?'], labelKey: 'kbd.help' },
  { keys: ['G', 'H'], labelKey: 'kbd.goHome', then: true },
  { keys: ['G', 'T'], labelKey: 'kbd.goTasks', then: true },
  { keys: ['G', 'P'], labelKey: 'kbd.goPlanner', then: true },
  { keys: ['G', 'W'], labelKey: 'kbd.goWeek', then: true },
  { keys: ['G', 'C'], labelKey: 'kbd.goCalendar', then: true },
  { keys: ['G', 'E'], labelKey: 'kbd.goExams', then: true },
  { keys: ['Esc'], labelKey: 'kbd.close' },
];

const GO = { h: 'analyticsView', t: 'tasksView', p: 'plannerForm', w: 'weekView', c: 'calendarView', e: 'examsView' };

// Pure decision function (tested): what should this key do, given whether
// the previous key was the "G" prefix?
export function resolveShortcut({ key, ctrl = false, meta = false, alt = false, typing = false, overlayOpen = false, pendingG = false }) {
  if (ctrl || meta || alt || typing || overlayOpen) return { action: null };
  const k = String(key || '').toLowerCase();
  if (pendingG) return GO[k] ? { action: 'go', view: GO[k] } : { action: null };
  if (k === 'g') return { action: 'prefix' };
  if (k === 'n') return { action: 'quickAdd' };
  if (k === '/') return { action: 'search' };
  if (key === '?') return { action: 'help' };
  return { action: null };
}

export function installShortcuts({ onQuickAdd, onSearch, onHelp, onGo }) {
  let pendingG = false;
  let timer = null;
  document.addEventListener('keydown', (e) => {
    const overlayOpen = Boolean(document.querySelector('.drawer, .palette-overlay:not([hidden]), .focus-overlay:not([hidden]), .onboarding-overlay:not([hidden])'));
    const r = resolveShortcut({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, typing: isTypingTarget(e.target), overlayOpen, pendingG });
    if (r.action === 'prefix') {
      pendingG = true;
      clearTimeout(timer);
      timer = setTimeout(() => { pendingG = false; }, 1200);
      return;
    }
    pendingG = false;
    if (!r.action) return;
    e.preventDefault();
    if (r.action === 'quickAdd') onQuickAdd();
    else if (r.action === 'search') onSearch();
    else if (r.action === 'help') onHelp();
    else if (r.action === 'go') onGo(r.view);
  });
}
