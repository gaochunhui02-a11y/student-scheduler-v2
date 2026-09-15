// Calendar Import/Export client controller (Phase 12) — owns the Settings
// area's Export/Import cards and the import preview modal. Completely
// isolated from src/dashboard/dashboard.js: it never imports data.js
// directly, and dashboard.js only ever calls initCalendarSection(userId,
// hostApi); it never reaches into this module's internals. Same bridge
// pattern as board.js/advisor.js/analytics.js/notifications.js.
//
// SECURITY: an imported .ics file is untrusted input. Its text is parsed
// entirely by the pure, regex/string-only parser in calendarModel.js (no
// eval, no dynamic code execution of any kind), and every value pulled out
// of it (title, dates) is inserted into the DOM via textContent only,
// never innerHTML, exactly like every other feature in this app handles
// user-provided/external content. Nothing from the file is sent to the AI
// Advisor or AI Breakdown. Nothing is written to Supabase until the user
// has previewed the parsed events and explicitly clicked "Import
// Selected" — there is no path from a parsed file straight to
// boardData/insertClass-style writes.

import { t } from '../shared/i18n.js';
import {
  DEFAULT_EXPORT_EVENT_TYPES,
  exportDaysToIcs,
  parseIcsCalendar,
  selectImportEvents,
  mapImportEventToClassFields,
  groupSelectedEventsByDate,
  importErrorMessageKey,
} from './calendarModel.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB — generous for a calendar file, defensive against an absurd upload

function downloadIcsFile(filename, icsText) {
  const blob = new Blob([icsText], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function isFileApiSupported() {
  return typeof window !== 'undefined' && 'File' in window && 'Blob' in window && typeof File.prototype.text === 'function';
}

export function initCalendarSection(userId, hostApi = {}) {
  const exportTodayBtn = document.getElementById('exportTodayBtn');
  const exportRangeBtn = document.getElementById('exportRangeBtn');
  const exportRangeStartInput = document.getElementById('exportRangeStart');
  const exportRangeEndInput = document.getElementById('exportRangeEnd');
  const exportStatusEl = document.getElementById('calendarExportStatus');
  const exportTypeInputs = {
    class: document.getElementById('exportTypeClass'),
    study: document.getElementById('exportTypeStudy'),
    meal: document.getElementById('exportTypeMeal'),
    break: document.getElementById('exportTypeBreak'),
  };

  const importBtn = document.getElementById('importCalendarBtn');
  const importFileInput = document.getElementById('calendarFileInput');
  const importStatusEl = document.getElementById('calendarImportStatus');

  const hasUi = Boolean(exportTodayBtn || exportRangeBtn || importBtn);
  if (!hasUi) return null;

  if (!isFileApiSupported() && importBtn) {
    importBtn.disabled = true;
    if (importStatusEl) {
      importStatusEl.textContent = t('calendar.importUnsupported');
      importStatusEl.hidden = false;
    }
  }

  function showExportStatus(message) {
    if (!exportStatusEl) return;
    exportStatusEl.textContent = message;
    exportStatusEl.hidden = false;
  }
  function showImportStatus(message) {
    if (!importStatusEl) return;
    importStatusEl.textContent = message;
    importStatusEl.hidden = false;
  }

  function selectedExportEventTypes() {
    const selected = Object.keys(exportTypeInputs).filter((type) => exportTypeInputs[type] && exportTypeInputs[type].checked);
    return selected.length > 0 ? selected : DEFAULT_EXPORT_EVENT_TYPES;
  }

  function exportOptions() {
    return {
      eventTypes: selectedExportEventTypes(),
      typeLabels: {
        class: t('calendar.typeClasses'),
        study: t('calendar.typeStudy'),
        meal: t('calendar.typeMeals'),
        break: t('calendar.typeBreaks'),
      },
      generatedByText: t('calendar.generatedBy'),
    };
  }

  if (exportTodayBtn) {
    exportTodayBtn.addEventListener('click', async () => {
      if (typeof hostApi.getTodayExportData !== 'function') return;
      try {
        const day = await hostApi.getTodayExportData();
        const { ics, eventCount } = exportDaysToIcs([day], exportOptions());
        if (eventCount === 0) {
          showExportStatus(t('calendar.exportNoEvents'));
          return;
        }
        downloadIcsFile(`schedule-${day.dateStr}.ics`, ics);
        showExportStatus(t('calendar.exportSuccess'));
      } catch (err) {
        console.error('Could not export today’s schedule:', err);
        showExportStatus(t('calendar.exportFailed'));
      }
    });
  }

  if (exportRangeBtn) {
    exportRangeBtn.addEventListener('click', async () => {
      const start = exportRangeStartInput ? exportRangeStartInput.value : '';
      const end = exportRangeEndInput ? exportRangeEndInput.value : '';
      if (!start || !end || start > end) {
        showExportStatus(t('calendar.exportInvalidRange'));
        return;
      }
      if (typeof hostApi.getRangeExportData !== 'function') return;
      try {
        const days = await hostApi.getRangeExportData(start, end);
        const { ics, eventCount } = exportDaysToIcs(days, exportOptions());
        if (eventCount === 0) {
          showExportStatus(t('calendar.exportNoEvents'));
          return;
        }
        downloadIcsFile(`schedule-${start}-to-${end}.ics`, ics);
        showExportStatus(t('calendar.exportSuccess'));
      } catch (err) {
        console.error('Could not export the date range:', err);
        showExportStatus(t('calendar.exportFailed'));
      }
    });
  }

  // ---------------- import preview modal ----------------

  let previewModal = null;
  let parsedEvents = [];

  function buildPreviewModal() {
    const overlay = document.createElement('div');
    overlay.className = 'board-modal-overlay';
    overlay.hidden = true;

    const modal = document.createElement('div');
    modal.className = 'board-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const heading = document.createElement('h3');
    heading.className = 'board-modal-title';
    heading.dataset.i18n = 'calendar.importPreviewTitle';
    heading.textContent = t('calendar.importPreviewTitle');

    const warningEl = document.createElement('p');
    warningEl.className = 'hint board-modal-error';
    warningEl.hidden = true;

    const list = document.createElement('div');
    list.className = 'board-breakdown-list calendar-import-list';

    const actions = document.createElement('div');
    actions.className = 'board-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.dataset.i18n = 'board.cancel';
    cancelBtn.textContent = t('board.cancel');

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn-primary';
    confirmBtn.dataset.i18n = 'calendar.importSelected';
    confirmBtn.textContent = t('calendar.importSelected');

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    modal.appendChild(heading);
    modal.appendChild(warningEl);
    modal.appendChild(list);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    // Appended to <body>, same reasoning as every other modal in this app:
    // no ancestor with a CSS transform, so position:fixed behaves
    // predictably regardless of which view/scroll position is active.
    document.body.appendChild(overlay);

    cancelBtn.addEventListener('click', closePreviewModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePreviewModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) closePreviewModal();
    });

    confirmBtn.addEventListener('click', async () => {
      const checkedIndexes = Array.from(list.querySelectorAll('input[type="checkbox"]'))
        .filter((cb) => cb.checked)
        .map((cb) => Number(cb.dataset.index));
      if (checkedIndexes.length === 0) return;

      const chosen = selectImportEvents(parsedEvents, checkedIndexes);
      const grouped = groupSelectedEventsByDate(chosen);

      confirmBtn.disabled = true;
      try {
        if (typeof hostApi.importClassesForDates !== 'function') throw new Error('not_available');
        let importedCount = 0;
        for (const [dateStr, events] of Object.entries(grouped)) {
          const fields = events.map(mapImportEventToClassFields);
          // eslint-disable-next-line no-await-in-loop
          await hostApi.importClassesForDates(dateStr, fields);
          importedCount += fields.length;
        }
        closePreviewModal();
        showImportStatus(`${t('calendar.calendarImported')} (${importedCount})`);
      } catch (err) {
        console.error('Could not import calendar events:', err);
        warningEl.textContent = t('calendar.importGenericError');
        warningEl.hidden = false;
      } finally {
        confirmBtn.disabled = false;
      }
    });

    return { overlay, warningEl, list };
  }

  function closePreviewModal() {
    if (previewModal) previewModal.overlay.hidden = true;
    parsedEvents = [];
  }

  function renderPreviewList(events) {
    previewModal.list.innerHTML = '';
    events.forEach((event, i) => {
      const row = document.createElement('label');
      row.className = 'board-breakdown-item calendar-import-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.index = String(i);

      const info = document.createElement('span');
      info.className = 'calendar-import-item-info';

      const titleEl = document.createElement('span');
      titleEl.className = 'calendar-import-item-title';
      titleEl.textContent = event.title || t('calendar.untitledEvent'); // user/file content — never markup, never the static dictionary

      const metaEl = document.createElement('span');
      metaEl.className = 'calendar-import-item-meta';
      if (event.allDay) {
        metaEl.textContent = `${event.dateStr} · ${t('calendar.allDayEvent')}`;
      } else {
        const pad2 = (n) => String(n).padStart(2, '0');
        const fmt = (m) => `${pad2(Math.floor((m % 1440) / 60))}:${pad2(m % 60)}`;
        metaEl.textContent = `${event.dateStr} · ${fmt(event.startMinutes)}–${fmt(event.endMinutes)}`;
      }

      info.appendChild(titleEl);
      info.appendChild(metaEl);
      row.appendChild(cb);
      row.appendChild(info);
      previewModal.list.appendChild(row);
    });
  }

  function openPreviewModal(parsed) {
    if (!previewModal) previewModal = buildPreviewModal();
    parsedEvents = parsed.events;
    renderPreviewList(parsedEvents);

    if (parsed.skippedRecurringCount > 0) {
      previewModal.warningEl.textContent = `${t('calendar.unsupportedRecurringEvent')} (${parsed.skippedRecurringCount})`;
      previewModal.warningEl.hidden = false;
    } else {
      previewModal.warningEl.hidden = true;
    }

    previewModal.overlay.hidden = false;
  }

  if (importBtn && importFileInput) {
    importBtn.addEventListener('click', () => importFileInput.click());
    importFileInput.addEventListener('change', async () => {
      const file = importFileInput.files && importFileInput.files[0];
      importFileInput.value = ''; // allow re-selecting the same file later
      if (!file) return;

      if (file.size > MAX_FILE_BYTES) {
        showImportStatus(t('calendar.importFileTooLarge'));
        return;
      }

      let text;
      try {
        text = await file.text();
      } catch (err) {
        console.error('Could not read the selected file:', err);
        showImportStatus(t('calendar.importGenericError'));
        return;
      }

      const parsed = parseIcsCalendar(text);
      if (!parsed.valid) {
        // "No valid events" can specifically mean "every event in the file
        // was a recurring one this phase doesn't support" — say so when
        // that's why, rather than just a bare generic message.
        const message =
          parsed.error === 'no_events' && parsed.skippedRecurringCount > 0
            ? `${t(importErrorMessageKey(parsed.error))} (${t('calendar.unsupportedRecurringEvent')}: ${parsed.skippedRecurringCount})`
            : t(importErrorMessageKey(parsed.error));
        showImportStatus(message);
        return;
      }
      if (importStatusEl) importStatusEl.hidden = true;
      openPreviewModal(parsed);
    });
  }

  return {};
}
