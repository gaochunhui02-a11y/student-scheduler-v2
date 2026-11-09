// Settings → Plan (V5-E). Shows the current plan honestly:
//   * billing off (default): "Founding beta — every feature is included";
//     Pro is described, priced as "planned", and the only action is
//     "Tell me when Pro launches" (records interest, no payment).
//   * billing on + Free: Upgrade (monthly / yearly) → Stripe Checkout, with
//     the renewal and cancellation terms shown next to the button.
//   * Pro: renewal date or end date, past-due warning, Manage subscription
//     (Stripe portal: payment method, plan switch, cancel).

import { t } from '../shared/i18n.js';
import { h } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { app } from '../app/context.js';
import { fmtDateLong } from '../ui/format.js';
import { PLANS, FEATURES, yearlySavingsPercent } from './plans.js';
import { currentEntitlements, billingEnabled } from './entitlements.js';
import { loadSubscription, canCheckout, startCheckout, openBillingPortal } from './billingData.js';
import { track } from '../analytics/productEvents.js';

const INTEREST_KEY = 'student-scheduler-pro-interest';

function fill(key, params = {}) {
  let text = t(key);
  Object.entries(params).forEach(([k, v]) => { text = text.split(`{${k}}`).join(String(v)); });
  return text;
}
const money = (n) => `$${n.toFixed(2).replace(/\.00$/, '')}`;

export async function renderPlan(root) {
  if (!root) return;
  root.innerHTML = '';
  root.appendChild(h('h2', {}, t('plan.title')));
  const sub = await loadSubscription().catch(() => null);
  const ent = currentEntitlements();

  // ---- current plan ----
  const status = h('div', { class: 'plan-current' });
  if (ent.source === 'beta') {
    status.append(h('span', { class: 'badge badge--accent' }, t('plan.betaBadge')), h('p', {}, t('plan.betaBody')));
  } else if (ent.plan === 'pro') {
    const end = sub && sub.current_period_end ? fmtDateLong(sub.current_period_end.slice(0, 10)) : '';
    status.append(h('span', { class: 'badge badge--success' }, t('plan.proBadge')));
    if (ent.source === 'grace') status.append(h('p', { class: 'notice notice--warning', role: 'alert' }, t('plan.pastDue')));
    else if (sub && sub.cancel_at_period_end) status.append(h('p', {}, fill('plan.endsOn', { date: end })));
    else if (end) status.append(h('p', {}, fill('plan.renewsOn', { date: end, interval: t(sub.price_interval === 'year' ? 'plan.perYear' : 'plan.perMonth') })));
  } else {
    status.append(h('span', { class: 'badge badge--outline' }, t('plan.freeBadge')), h('p', {}, t('plan.freeBody')));
    if (sub && sub.status === 'canceled') status.append(h('p', { class: 'hint' }, t('plan.canceledNote')));
  }
  root.appendChild(status);

  // ---- comparison ----
  const rows = [
    ['plan.rowCore', true, true],
    ['plan.rowSchedule', true, true],
    ['plan.rowImport', true, true],
    ['plan.rowExport', true, true],
    ['plan.rowHorizon', fill('plan.days', { n: FEATURES.free.planHorizonDays }), t('plan.wholeSemester')],
    ['plan.rowForecast', fill('plan.days', { n: FEATURES.free.forecastDays }), t('plan.wholeSemester')],
    ['plan.rowBulk', false, true],
    ['plan.rowInsights', t('plan.basic'), t('plan.advanced')],
    ['plan.rowSync', false, t('plan.planned')],
  ];
  const cell = (v) => (v === true ? h('td', { class: 'plan-yes' }, h('span', { 'aria-hidden': 'true' }, '✓'), h('span', { class: 'sr-only' }, t('plan.included'))) : v === false ? h('td', { class: 'plan-no' }, h('span', { 'aria-hidden': 'true' }, '—'), h('span', { class: 'sr-only' }, t('plan.notIncluded'))) : h('td', {}, v));
  const table = h('table', { class: 'plan-table' },
    h('caption', { class: 'sr-only' }, t('plan.compare')),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, ''), h('th', { scope: 'col' }, t('plan.free')), h('th', { scope: 'col' }, t('plan.pro')))),
    h('tbody', {}, ...rows.map(([k, f, p]) => h('tr', {}, h('th', { scope: 'row' }, t(k)), cell(f), cell(p)))));
  root.appendChild(table);

  // ---- price + action ----
  const pro = PLANS.pro;
  const priceLine = fill('plan.price', { month: money(pro.priceMonthly), year: money(pro.priceYearly), save: yearlySavingsPercent() });
  const box = h('div', { class: 'plan-action' }, h('p', { class: 'plan-price' }, priceLine));
  if (ent.plan === 'pro' && ent.source !== 'beta') {
    const manage = h('button', { type: 'button', class: 'btn btn--secondary' }, h('span', {}, t('plan.manage')));
    manage.addEventListener('click', async () => {
      manage.disabled = true;
      try { await openBillingPortal(); } catch { manage.disabled = false; toast(t('plan.portalError'), { kind: 'error' }); }
    });
    box.append(manage, h('p', { class: 'hint' }, t('plan.manageHint')));
  } else if (canCheckout()) {
    const buy = (interval) => {
      const b = h('button', { type: 'button', class: `btn ${interval === 'year' ? 'btn--primary' : 'btn--secondary'}` }, h('span', {}, interval === 'year' ? fill('plan.upgradeYear', { price: money(pro.priceYearly) }) : fill('plan.upgradeMonth', { price: money(pro.priceMonthly) })));
      b.addEventListener('click', async () => {
        b.disabled = true;
        track('upgrade_started', { interval });
        try {
          await startCheckout(interval);
        } catch (err) {
          b.disabled = false;
          toast(err.code === 'already_subscribed' ? t('plan.already') : err.code === 'billing_not_configured' ? t('plan.notConfigured') : t('plan.checkoutError'), { kind: 'error' });
        }
      });
      return b;
    };
    box.append(h('div', { class: 'plan-buttons' }, buy('month'), buy('year')), h('p', { class: 'hint' }, t('plan.disclosure')));
  } else {
    // Billing is not live: no purchase button, only honest interest.
    const asked = (() => { try { return localStorage.getItem(INTEREST_KEY) === '1'; } catch { return false; } })();
    const notify = h('button', { type: 'button', class: 'btn btn--secondary', disabled: asked ? '' : null }, h('span', {}, asked ? t('plan.interestSaved') : t('plan.notifyMe')));
    notify.addEventListener('click', () => {
      try { localStorage.setItem(INTEREST_KEY, '1'); } catch { /* device only */ }
      track('pro_interest', { source: 'settings' });
      notify.disabled = true;
      notify.querySelector('span').textContent = t('plan.interestSaved');
      toast(t('plan.interestToast'), { kind: 'success' });
    });
    box.append(h('p', { class: 'hint' }, t(billingEnabled() ? 'plan.notAvailableHere' : 'plan.comingSoon')), notify);
  }
  root.appendChild(box);
  if (app().isDemo) root.appendChild(h('p', { class: 'hint' }, t('plan.demoNote')));
}

/** ?billing=success|cancel after Stripe Checkout. */
export async function handleBillingReturn() {
  const params = new URLSearchParams(location.search);
  const result = params.get('billing');
  if (!result) return;
  params.delete('billing');
  history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`);
  if (result === 'cancel') { toast(t('plan.checkoutCanceled')); return; }
  if (result !== 'success') return;
  toast(t('plan.checkoutThanks'), { kind: 'success' });
  const { waitForPro } = await import('./billingData.js');
  const sub = await waitForPro();
  if (sub) {
    track('subscription_started', { interval: sub.price_interval === 'year' ? 'year' : 'month' });
    toast(t('plan.nowPro'), { kind: 'success' });
  } else toast(t('plan.pending'));
  renderPlan(document.getElementById('settingsPanel-plan'));
}
