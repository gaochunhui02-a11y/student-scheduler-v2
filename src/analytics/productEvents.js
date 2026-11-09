// Product events I/O (V5-D). See productEventsModel.js for the rules.
// Consent lives on this device (localStorage); events go to the student's
// own rows in public.product_events (0027) and can be deleted from
// Settings → Privacy. Failures are silent — analytics must never break or
// slow the app.

import { supabase } from '../lib/supabaseClient.js';
import { has } from '../shared/capabilities.js';
import { app } from '../app/context.js';
import { todayStr } from '../shared/dates.js';
import { APP_VERSION } from '../app/version.js';
import { EVENT_NAMES, sanitizeProps, canRecord, shouldAskConsent, onceKey } from './productEventsModel.js';

const CONSENT_KEY = 'student-scheduler-analytics-consent';
const ONCE_PREFIX = 'student-scheduler-events-once:';
const PENDING_KEY = 'student-scheduler-pending-events';

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode etc. — just don't record */ }
}

export function browserOptOut() {
  try {
    return navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
  } catch {
    return false;
  }
}

export function getConsent() {
  const v = read(CONSENT_KEY);
  return v === 'granted' || v === 'denied' ? v : null;
}

export function setConsent(value) {
  write(CONSENT_KEY, value === 'granted' ? 'granted' : 'denied');
  if (value !== 'granted') write(PENDING_KEY, null);
  else flushPending();
}

export function needsConsentPrompt() {
  return shouldAskConsent({ consent: getConsent(), optOutSignal: browserOptOut(), isDemo: Boolean(app().isDemo), available: has('productEvents') });
}

/**
 * Records an event (or does nothing). Never throws.
 * @param {string} name   one of EVENT_NAMES
 * @param {object} [props]
 */
export async function track(name, props = {}) {
  try {
    if (!EVENT_NAMES.includes(name)) return;
    const userId = app().userId;
    if (!canRecord({ consent: getConsent(), isDemo: Boolean(app().isDemo), signedIn: Boolean(userId), available: has('productEvents') })) return;
    const once = onceKey(name, todayStr());
    if (once) {
      const key = `${ONCE_PREFIX}${userId}:${once}`;
      if (read(key)) return;
      write(key, '1');
    }
    await supabase.from('product_events').insert({ user_id: userId, name, props: sanitizeProps(props), app_version: APP_VERSION.slice(0, 32) });
  } catch {
    /* never surface analytics errors */
  }
}

/**
 * Before an account exists (sign-up page) nothing can be stored remotely.
 * Remember the step on this device; it is sent only if the student later
 * opts in, and discarded otherwise.
 */
export function rememberPending(name) {
  if (!['signup_started', 'signup_completed'].includes(name)) return;
  try {
    const list = JSON.parse(read(PENDING_KEY) || '[]');
    if (!list.includes(name)) list.push(name);
    write(PENDING_KEY, JSON.stringify(list.slice(0, 4)));
  } catch { /* ignore */ }
}

export async function flushPending() {
  let list = [];
  try { list = JSON.parse(read(PENDING_KEY) || '[]'); } catch { list = []; }
  if (!list.length || getConsent() !== 'granted' || !app().userId) return;
  write(PENDING_KEY, null);
  for (const name of list) {
    // eslint-disable-next-line no-await-in-loop
    await track(name);
  }
}

/** Settings → Privacy: delete every event this account recorded. */
export async function deleteMyEvents() {
  if (!has('productEvents')) return 0;
  const { error, count } = await supabase.from('product_events').delete({ count: 'exact' }).eq('user_id', app().userId);
  if (error) throw error;
  return count || 0;
}
