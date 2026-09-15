// AI Student Advisor client controller — owns all #advisorView DOM and the
// current session's chat state. Completely isolated from
// src/dashboard/dashboard.js: no scheduling or Board state is read or
// written here directly, and dashboard.js only ever calls
// initAdvisorSection(userId, hostApi) and the returned onShow(); it never
// reaches into this module's internals.
//
// Bridges to existing data (both via the small `hostApi` object dashboard.js
// passes in, the same pattern src/board/board.js already uses for its own
// Planner bridge):
//   - hostApi.getPlannerContext() / getBoardContext() build the sanitized
//     context sent to the AI (see advisorModel.buildAdvisorContext).
//   - hostApi.createStudyTaskFromAdvisor(fields) routes through the EXISTING
//     insertStudySubject + addStudyRow code path — no second Planner-task
//     system.
//   - hostApi.addBoardNodeFromAdvisor(title) routes through
//     boardSection.addNodeFromExternal, which itself just calls the
//     EXISTING boardData.createNode — no second Board-node system.
//
// Nothing the AI returns is ever used to create a study task or Board node
// until the user explicitly clicks an action for that specific suggestion
// (or checks it and clicks the bulk "Add selected"). There is no path from
// a raw AI response straight to a database mutation — every action calls
// through hostApi exactly like a normal user-initiated create.

import { t } from '../shared/i18n.js';
import {
  buildAdvisorContext,
  validateAdvisorResponse,
  mapSuggestionToStudyTaskFields,
  isStudyTaskFieldsValid,
  mapSuggestionToBoardNodeTitle,
  selectSuggestions,
  advisorErrorMessageKey,
} from './advisorModel.js';
import { requestAdvisorReply } from './advisorClient.js';

const STATUS_DURATION_MS = 3000;

export function initAdvisorSection(userId, hostApi = {}) {
  const advisorView = document.getElementById('advisorView');
  if (!advisorView) return null;

  const messagesEl = document.getElementById('advisorMessages');
  const emptyState = document.getElementById('advisorEmptyState');
  const statusEl = document.getElementById('advisorStatus');
  const chipsEl = document.getElementById('advisorPromptChips');
  const inputEl = document.getElementById('advisorInput');
  const sendBtn = document.getElementById('advisorSendBtn');

  let sending = false;
  let statusTimeout = null;
  let focused = false;

  function showStatus(message) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.hidden = false;
    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
      statusEl.hidden = true;
    }, STATUS_DURATION_MS);
  }

  function scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Every message (user, assistant, or error) is inserted as plain text
  // via textContent, never innerHTML/markup — this is untrusted content
  // (either the user's own typed text or AI output) and is never run
  // through the static [data-i18n] dictionary.
  function appendMessage({ role, text, suggestions }) {
    if (emptyState) emptyState.hidden = true;
    const bubble = document.createElement('div');
    bubble.className = `advisor-message advisor-message-${role}`;

    const textEl = document.createElement('p');
    textEl.className = 'advisor-message-text';
    textEl.textContent = text;
    bubble.appendChild(textEl);

    if (Array.isArray(suggestions) && suggestions.length > 0) {
      bubble.appendChild(buildSuggestionsList(suggestions));
    }

    messagesEl.appendChild(bubble);
    scrollToBottom();
    return bubble;
  }

  async function addSuggestionToPlanner(suggestion) {
    const fields = mapSuggestionToStudyTaskFields(suggestion);
    if (!isStudyTaskFieldsValid(fields)) throw new Error('invalid_fields');
    if (typeof hostApi.createStudyTaskFromAdvisor !== 'function') throw new Error('not_available');
    await hostApi.createStudyTaskFromAdvisor(fields);
  }

  async function addSuggestionToBoard(suggestion) {
    const title = mapSuggestionToBoardNodeTitle(suggestion);
    if (!title) throw new Error('invalid_fields');
    if (typeof hostApi.addBoardNodeFromAdvisor !== 'function') throw new Error('not_available');
    await hostApi.addBoardNodeFromAdvisor(title);
  }

  function buildSuggestionsList(suggestions) {
    const list = document.createElement('div');
    list.className = 'advisor-suggestions';

    function markAdded(button, checkbox) {
      button.disabled = true;
      button.dataset.i18n = 'advisor.added';
      button.textContent = t('advisor.added');
      checkbox.disabled = true;
      checkbox.checked = false;
    }

    suggestions.forEach((suggestion, index) => {
      const card = document.createElement('div');
      card.className = 'advisor-suggestion-card';

      const top = document.createElement('div');
      top.className = 'advisor-suggestion-top';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.className = 'advisor-suggestion-check';
      checkbox.dataset.index = String(index);
      checkbox.setAttribute('aria-label', suggestion.title);

      const titleEl = document.createElement('span');
      titleEl.className = 'advisor-suggestion-title';
      titleEl.textContent = suggestion.title;

      const priorityEl = document.createElement('span');
      priorityEl.className = `advisor-suggestion-priority priority-${suggestion.priority}`;
      const priorityKey = `board.priority${suggestion.priority.charAt(0).toUpperCase()}${suggestion.priority.slice(1)}`;
      priorityEl.dataset.i18n = priorityKey;
      priorityEl.textContent = t(priorityKey);

      top.appendChild(checkbox);
      top.appendChild(titleEl);
      top.appendChild(priorityEl);

      const meta = document.createElement('div');
      meta.className = 'advisor-suggestion-meta';
      meta.textContent = suggestion.dueDate ? `${suggestion.minutes} min · ${suggestion.dueDate}` : `${suggestion.minutes} min`;

      card.appendChild(top);
      card.appendChild(meta);

      if (suggestion.reason) {
        const reasonEl = document.createElement('p');
        reasonEl.className = 'advisor-suggestion-reason';
        const label = document.createElement('span');
        label.className = 'advisor-suggestion-reason-label';
        label.dataset.i18n = 'advisor.suggestedBecause';
        label.textContent = t('advisor.suggestedBecause');
        reasonEl.appendChild(label);
        reasonEl.appendChild(document.createTextNode(` ${suggestion.reason}`));
        card.appendChild(reasonEl);
      }

      const actions = document.createElement('div');
      actions.className = 'advisor-suggestion-actions';

      const addPlannerBtn = document.createElement('button');
      addPlannerBtn.type = 'button';
      addPlannerBtn.className = 'board-node-link-btn board-node-link-btn-primary';
      addPlannerBtn.dataset.i18n = 'advisor.addToPlanner';
      addPlannerBtn.textContent = t('advisor.addToPlanner');

      const addBoardBtn = document.createElement('button');
      addBoardBtn.type = 'button';
      addBoardBtn.className = 'board-node-link-btn';
      addBoardBtn.dataset.i18n = 'advisor.addToBoard';
      addBoardBtn.textContent = t('advisor.addToBoard');

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'board-node-link-btn';
      dismissBtn.dataset.i18n = 'advisor.dismiss';
      dismissBtn.textContent = t('advisor.dismiss');

      addPlannerBtn.addEventListener('click', async () => {
        addPlannerBtn.disabled = true;
        try {
          await addSuggestionToPlanner(suggestion);
          markAdded(addPlannerBtn, checkbox);
          showStatus(t('advisor.addedToPlanner'));
        } catch (err) {
          console.error('Could not add suggestion to Planner:', err);
          addPlannerBtn.disabled = false;
          showStatus(t('advisor.actionFailed'));
        }
      });

      addBoardBtn.addEventListener('click', async () => {
        addBoardBtn.disabled = true;
        try {
          await addSuggestionToBoard(suggestion);
          markAdded(addBoardBtn, checkbox);
          showStatus(t('advisor.addedToBoard'));
        } catch (err) {
          addBoardBtn.disabled = false;
          if (err && err.message === 'no_active_board') {
            showStatus(t('advisor.noActiveBoard'));
          } else {
            console.error('Could not add suggestion to Board:', err);
            showStatus(t('advisor.actionFailed'));
          }
        }
      });

      dismissBtn.addEventListener('click', () => {
        card.remove();
      });

      actions.appendChild(addPlannerBtn);
      actions.appendChild(addBoardBtn);
      actions.appendChild(dismissBtn);
      card.appendChild(actions);

      list.appendChild(card);
    });

    // Bulk action: every currently-checked, not-yet-added, not-dismissed
    // suggestion is added to the Planner in one go. Uses the same
    // selectSuggestions() pure function a single-suggestion action's
    // index-based selection would use, so "selected suggestions only" is
    // one tested code path either way.
    const bulkBtn = document.createElement('button');
    bulkBtn.type = 'button';
    bulkBtn.className = 'btn-secondary advisor-add-selected-btn';
    bulkBtn.dataset.i18n = 'advisor.addSelected';
    bulkBtn.textContent = t('advisor.addSelected');
    bulkBtn.addEventListener('click', async () => {
      const cards = Array.from(list.querySelectorAll('.advisor-suggestion-card'));
      const selectedIndexes = cards
        .filter((card) => card.isConnected)
        .map((card) => card.querySelector('.advisor-suggestion-check'))
        .filter((cb) => cb && cb.checked && !cb.disabled)
        .map((cb) => Number(cb.dataset.index));
      const chosen = selectSuggestions(suggestions, selectedIndexes);
      if (chosen.length === 0) return;

      bulkBtn.disabled = true;
      try {
        for (const suggestion of chosen) {
          await addSuggestionToPlanner(suggestion);
        }
        cards.forEach((card) => {
          const cb = card.querySelector('.advisor-suggestion-check');
          if (cb && cb.checked && !cb.disabled) {
            const plannerBtn = card.querySelector('.advisor-suggestion-actions button:first-child');
            if (plannerBtn) markAdded(plannerBtn, cb);
          }
        });
        showStatus(t('advisor.addedToPlanner'));
      } catch (err) {
        console.error('Could not add selected suggestions:', err);
        showStatus(t('advisor.actionFailed'));
      } finally {
        bulkBtn.disabled = false;
      }
    });

    list.appendChild(bulkBtn);
    return list;
  }

  async function buildContextFromHost() {
    const plannerContext = typeof hostApi.getPlannerContext === 'function' ? await hostApi.getPlannerContext() : null;
    const boardGoals = typeof hostApi.getBoardContext === 'function' ? hostApi.getBoardContext() : [];
    return buildAdvisorContext({
      currentDate: new Date().toISOString().slice(0, 10),
      schedule: plannerContext ? plannerContext.schedule : null,
      studySubjects: plannerContext ? plannerContext.studySubjects : [],
      classes: plannerContext ? plannerContext.classes : [],
      scheduleItems: plannerContext ? plannerContext.scheduleItems : [],
      boardGoals,
    });
  }

  async function sendMessage(rawText) {
    const text = (rawText || '').trim();
    if (!text || sending) return;
    sending = true;
    if (sendBtn) sendBtn.disabled = true;
    if (inputEl) inputEl.value = '';

    appendMessage({ role: 'user', text });
    const thinkingBubble = appendMessage({ role: 'assistant', text: t('advisor.thinking') });
    thinkingBubble.classList.add('advisor-message-thinking');

    let context = {};
    try {
      context = await buildContextFromHost();
    } catch (err) {
      console.error('Could not build Advisor context:', err);
    }

    const result = await requestAdvisorReply({ message: text, context });
    thinkingBubble.remove();

    if (!result.ok) {
      appendMessage({ role: 'error', text: t(advisorErrorMessageKey(result.error)) });
      sending = false;
      if (sendBtn) sendBtn.disabled = false;
      return;
    }

    const validated = validateAdvisorResponse(result.data);
    if (!validated.valid) {
      appendMessage({ role: 'error', text: t(advisorErrorMessageKey(validated.error)) });
      sending = false;
      if (sendBtn) sendBtn.disabled = false;
      return;
    }

    const bubbleText = validated.message || t('advisor.suggestionsFallbackMessage');
    appendMessage({ role: 'assistant', text: bubbleText, suggestions: validated.suggestions });
    sending = false;
    if (sendBtn) sendBtn.disabled = false;
  }

  if (sendBtn) sendBtn.addEventListener('click', () => sendMessage(inputEl ? inputEl.value : ''));
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputEl.value);
      }
    });
  }
  if (chipsEl) {
    chipsEl.querySelectorAll('.advisor-chip').forEach((chip) => {
      chip.addEventListener('click', () => sendMessage(chip.textContent));
    });
  }

  function onShow() {
    // No network fetch needed at tab-open time — context is built fresh
    // from current Planner/Board state on every message send, not cached
    // from when the tab was first opened. Just focus the input once.
    if (!focused && inputEl) {
      inputEl.focus();
      focused = true;
    }
  }

  return { onShow };
}
