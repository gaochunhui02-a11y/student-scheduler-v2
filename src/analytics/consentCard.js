// One-time, non-blocking question (V5-D): "Help improve Student Scheduler?"
// Shown at most once per device, after onboarding, never in the demo and
// never to a browser sending Do Not Track / Global Privacy Control. Both
// answers are equally easy; the choice can be changed in Settings → Privacy.

import { t } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { needsConsentPrompt, setConsent, track } from './productEvents.js';

export function maybeAskConsent({ delay = 4000 } = {}) {
  if (!needsConsentPrompt() || document.querySelector('.consent-card')) return;
  setTimeout(() => {
    if (!needsConsentPrompt() || document.body.classList.contains('onboarding-open') || document.body.classList.contains('tour-open')) return;
    const yes = h('button', { type: 'button', class: 'btn btn--primary btn--sm' }, t('consent.yes'));
    const no = h('button', { type: 'button', class: 'btn btn--secondary btn--sm' }, t('consent.no'));
    const card = h('section', { class: 'consent-card', role: 'region', 'aria-labelledby': 'consentTitle' },
      h('p', { class: 'consent-title', id: 'consentTitle' }, t('consent.title')),
      h('p', { class: 'consent-body' }, t('consent.body'), ' ', h('a', { href: '/privacy.html#analytics', target: '_blank', rel: 'noopener' }, t('consent.details'))),
      h('div', { class: 'consent-actions' }, no, yes));
    const close = (value) => {
      setConsent(value);
      card.remove();
      if (value === 'granted') track('session_start');
    };
    yes.addEventListener('click', () => close('granted'));
    no.addEventListener('click', () => close('denied'));
    document.body.appendChild(card);
  }, delay);
}
