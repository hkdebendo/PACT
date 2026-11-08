'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// PACT's custom widget catalogue for AG Studio. Registered through createWidgets (ag-studio-react)
// under a "PACT" menu group, ahead of Studio's own widgets, so users and the AI agents can add them.
import { createWidgets } from 'ag-studio-react';
import { KPI_METRICS, KpiTileWidget } from './kpi';
import { AnomalyRadarWidget } from './sentinel';
import { EscrowVaultWidget, MoneyFlowWidget, RateGaugesWidget } from './money';
import { MilestoneTimelineWidget, PactLedgerWidget, ReconciliationWidget, RefusedListWidget, ReputationLeaderboardWidget, VerdictCardWidget } from './pacts';

const icon = (path: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const ICONS = {
  vault: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5V7M15.5 12H17"/>'),
  timeline: icon('<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 12h3M14 12h3"/>'),
  verdict: icon('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  leaderboard: icon('<path d="M8 21V11M12 21V5M16 21v-7"/>'),
  flow: icon('<path d="M3 6c7 0 7 6 18 6M3 18c7 0 7-6 18-6"/>'),
  gauge: icon('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-5"/>'),
  ledger: icon('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  reconcile: icon('<path d="M4 7h11l-3-3M20 17H9l3 3"/>'),
  refused: icon('<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8"/>'),
  radar: icon('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  kpi: icon('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 15l3-3 2.5 2L17 9"/>'),
};

/** Adds a select to the widget's Format section of Studio's edit panel. */
const withSelect = (id: string, label: string, defaultValue: string, options: { value: string; label: string }[]) => (params: any) => {
  const form = params.createDefaults({ dataMappingItems: [] });
  form.items?.[1]?.items?.push({ type: 'select', id, label, defaultValue, options });
  return form;
};

const noMapping = (params: any) => params.createDefaults({ dataMappingItems: [] });

const def = (id: string, label: string, comp: any, ico: string, description: string, size: [number, number], min: [number, number], form = noMapping) => ({
  id,
  label,
  icon: ico,
  form,
  comp,
  defaultSize: { width: size[0], height: size[1] },
  minSize: { width: min[0], height: min[1] },
  ai: { description },
});

export const PACT_WIDGET_IDS = [
  'pact-kpi',
  'pact-sentinel-radar',
  'pact-escrow-vault',
  'pact-milestone-timeline',
  'pact-verdict-card',
  'pact-reputation-leaderboard',
  'pact-money-flow',
  'pact-rate-gauges',
  'pact-ledger',
  'pact-reconciliation',
  'pact-refused-list',
] as const;

export const buildWidgets = () => (defaults: any) =>
  createWidgets({
    additionalTypes: [
      def(
        'pact-kpi',
        'KPI Tile',
        KpiTileWidget,
        ICONS.kpi,
        `One PACT metric as a large number with its growth sparkline and the change over the last 24 hours. Set format.style.metric to one of: ${Object.keys(KPI_METRICS).join(', ')}.`,
        [300, 150],
        [200, 120],
        withSelect('format.style.metric', 'Metric', 'released', Object.entries(KPI_METRICS).map(([value, label]) => ({ value, label }))),
      ),
      def(
        'pact-sentinel-radar',
        'Anomaly Radar',
        AnomalyRadarWidget,
        ICONS.radar,
        "Live findings of the PACT Sentinel rules engine (refund spikes, seller refund concentration, repeated rejections, low-confidence releases, expiring PayPal authorizations, failed operations, open disputes, pending appeals, stalled funding): severity, metric vs baseline, money at stake and the affected pacts. format.style.focus = a rule id to pin first; format.style.headline = a one-line briefing.",
        [620, 520],
        [340, 300],
      ),
      def('pact-escrow-vault', 'Escrow Vault', EscrowVaultWidget, ICONS.vault, 'Totals of money held by PayPal (authorized, not charged), released to sellers, refunded and voided, with animated transitions.', [520, 260], [300, 200]),
      def('pact-milestone-timeline', 'Milestone Timeline', MilestoneTimelineWidget, ICONS.timeline, "Per pact, its milestones as steps coloured by state, with the latest evidence thumbnail and verifier confidence. Follows the page's cross-filter (one pact) or shows the most recent pacts.", [900, 300], [420, 200]),
      def('pact-verdict-card', 'Verdict Card', VerdictCardWidget, ICONS.verdict, 'The latest AI Verifier / Arbiter / human decision with its reasoning, confidence, model, audit-chain status and an "Appeal to a human" action.', [520, 300], [320, 220], withSelect('format.style.focus', 'Show', 'latest', [
        { value: 'latest', label: 'Latest decisions' },
        { value: 'refused', label: 'Refusals only' },
      ])),
      def('pact-reputation-leaderboard', 'Reputation Leaderboard', ReputationLeaderboardWidget, ICONS.leaderboard, 'Grid of parties ranked by Bayesian-smoothed reputation score, with sparkline trend, tier and completion / on-time / dispute rates.', [900, 340], [420, 220]),
      def('pact-money-flow', 'Money Flow', MoneyFlowWidget, ICONS.flow, 'Sankey diagram of escrowed money: buyers → PayPal authorization → sellers, subcontractor payouts, refunds, voided and still held.', [700, 340], [360, 240]),
      def('pact-rate-gauges', 'Dispute & Refund Gauges', RateGaugesWidget, ICONS.gauge, 'Three gauges: dispute rate, refund rate and share of AI verdicts that were refusals.', [520, 220], [320, 160]),
      def('pact-ledger', 'Pact Ledger', PactLedgerWidget, ICONS.ledger, 'Grid of all pacts. Clicking a row cross-filters the page to that pact (drill-through); double-click opens the pact room.', [900, 320], [420, 200]),
      def('pact-reconciliation', 'PayPal Reconciliation', ReconciliationWidget, ICONS.reconcile, "PayPal Transaction Search rows matched against PACT's ledger, with balances, an as-of timestamp and the 3-hour Transaction Search caveat.", [900, 360], [420, 240]),
      def('pact-refused-list', 'Refused Milestones', RefusedListWidget, ICONS.refused, 'Every Verifier rejection and Arbiter refund in the last 7 days with the reasoning, confidence and appeal status.', [900, 300], [420, 200]),
    ],
    menu: [{ label: 'PACT', widgetIds: [...PACT_WIDGET_IDS] }, ...(defaults?.menu ?? [])],
  } as any);
