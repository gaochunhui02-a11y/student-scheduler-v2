// Help & guides (V5-A). The `?` buttons open a drawer listing every guide
// for the pages this workspace shows (the current page first), plus
// "Replay setup". The first time someone opens a page that has a guide,
// a toast offers it once — never again after that, never during
// onboarding, and never when guide tips are turned off.

import { t } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { openDrawer } from '../ui/drawer.js';
import { toast } from '../ui/toast.js';
import { app } from '../app/context.js';
import { isModuleEnabled } from '../workspace/modules.js';
import { TOUR_IDS, TOUR_ROUTE, TOUR_MODULE, tourForView, markTour, markOffered, shouldOfferTour } from './tourModel.js';
import { startTour, isTourOpen } from './tourUI.js';
import { peekTours, loadTours, saveTours } from './tourData.js';
import { track } from '../analytics/productEvents.js';

let host = {};

function enabledTours() {
  const ws = app().workspace ? app().workspace() : null;
  return TOUR_IDS.filter((id) => isModuleEnabled(ws, TOUR_MODULE[id]));
}

function waitForView(viewId, timeout = 4000) {
  return new Promise((resolve) => {
    const startAt = Date.now();
    const tick = () => {
      const el = document.getElementById(viewId);
      const shown = el && !el.hidden && el.style.display !== 'none';
      // Pages render asynchronously after they become visible.
      if (shown && (viewId === 'plannerForm' || el.children.length)) setTimeout(() => resolve(true), 250);
      else if (Date.now() - startAt > timeout) resolve(false);
      else setTimeout(tick, 60);
    };
    tick();
  });
}

/** Navigates to the tour's page if needed, then runs it and records the outcome. */
export async function runTour(tourId) {
  const userId = app().userId;
  const route = TOUR_ROUTE[tourId];
  const routeView = { today: 'todayView', planner: 'plannerForm', tasks: 'tasksView', courses: 'coursesView', projects: 'projectsView', goals: 'goalsView', routines: 'routinesView', calendar: 'calendarView', boards: 'boardView', insights: 'insightsView' }[route];
  const cur = app().currentView ? app().currentView() : null;
  if (routeView && cur !== routeView) {
    app().navigate(routeView);
    await waitForView(routeView);
  }
  const started = startTour(tourId, {
    onEnd: (status) => {
      if (status === 'done') track('tour_completed', { tour: tourId });
      return saveTours(userId, markTour(peekTours(userId), tourId, status));
    },
  });
  if (!started) toast(t('tour.nothingHere'), { kind: 'info' });
  return started;
}

export function openHelpCenter() {
  const cur = tourForView(app().currentView ? app().currentView() : null);
  const state = peekTours(app().userId);
  const ids = enabledTours();
  const ordered = cur && ids.includes(cur) ? [cur, ...ids.filter((x) => x !== cur)] : ids;
  openDrawer({
    title: t('help.title'),
    subtitle: t('help.sub'),
    size: 'narrow',
    render: (body, api) => {
      const list = h('ul', { class: 'help-guides', 'aria-label': t('help.guidesLabel') });
      ordered.forEach((id) => {
        const status = state.seen[id];
        const btn = h('button', { type: 'button', class: 'help-guide' },
          h('span', { class: 'help-guide-main' },
            h('span', { class: 'help-guide-title' }, t(`tour.name.${id}`)),
            h('span', { class: 'help-guide-meta' }, t(`tour.desc.${id}`))),
          id === cur ? h('span', { class: 'badge badge--accent' }, t('help.thisPage')) : null,
          status === 'done' ? h('span', { class: 'badge badge--outline' }, t('help.seen')) : null);
        btn.addEventListener('click', () => {
          api.close(true);
          runTour(id);
        });
        list.appendChild(h('li', {}, btn));
      });
      body.appendChild(list);
      const extras = h('div', { class: 'help-extras' });
      if (typeof host.replayOnboarding === 'function') {
        const replay = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, t('help.replaySetup'));
        replay.addEventListener('click', () => { api.close(true); host.replayOnboarding(); });
        extras.appendChild(replay);
      }
      if (typeof host.openFeedback === 'function') {
        const fb = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, t('help.feedback'));
        fb.addEventListener('click', () => { api.close(true); host.openFeedback(); });
        extras.appendChild(fb);
      }
      const tips = h('label', { class: 'help-tips' });
      const cb = h('input', { type: 'checkbox' });
      cb.checked = state.tips;
      cb.addEventListener('change', () => saveTours(app().userId, { ...peekTours(app().userId), tips: cb.checked }));
      tips.append(cb, h('span', {}, t('help.tipsToggle')));
      body.append(extras, tips);
    },
    actions: [{ label: t('common.close'), onClick: (a) => a.close() }],
  });
}

function offerFor(viewId) {
  const id = tourForView(viewId);
  if (!id || isTourOpen() || !enabledTours().includes(id)) return;
  const userId = app().userId;
  const onboardingOpen = typeof host.isOnboardingOpen === 'function' && host.isOnboardingOpen();
  if (!shouldOfferTour(peekTours(userId), id, { onboardingOpen })) return;
  saveTours(userId, markOffered(peekTours(userId), id));
  toast(t('tour.offer').replace('{page}', t(`tour.name.${id}`)), {
    kind: 'info',
    timeout: 9000,
    actionLabel: t('tour.offerAction'),
    onAction: () => runTour(id),
  });
}

/**
 * @param {{ isOnboardingOpen?: () => boolean, replayOnboarding?: () => void, openFeedback?: () => void }} opts
 */
export async function initHelpCenter(opts = {}) {
  host = opts;
  await loadTours(app().userId);
  document.querySelectorAll('[data-open-help]').forEach((btn) => {
    btn.hidden = false;
    btn.addEventListener('click', () => openHelpCenter());
  });
  // Wait a moment after a page change so a page that is just passed through
  // (e.g. a redirect) doesn't trigger an offer.
  let timer = 0;
  document.addEventListener('app:view', (e) => {
    clearTimeout(timer);
    const view = e.detail && e.detail.view;
    timer = setTimeout(() => offerFor(view), 1200);
  });
}

/** Called once onboarding has built a plan: show the Today guide right away. */
export function startTodayTourAfterOnboarding() {
  return runTour('today');
}
