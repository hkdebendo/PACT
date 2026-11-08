// The built-in "PACT Control Tower" report: four pages, laid out on Studio's 24-column canvas.
// Mixes PACT's custom widgets (KPI tiles, vault, gauges, timeline, grids) with Studio's own (stacked
// column, donut and bar charts, a button filter).
import type { AgReportState } from 'ag-studio';

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number) => ({ xTrack, yTrack, xSpan, ySpan });
const title = (text: string, subtitle?: string) => ({
  title: { enabled: true, text },
  ...(subtitle && { subtitle: { enabled: true, text: subtitle } }),
});
const custom = (type: string, t: string, subtitle?: string, style?: Record<string, unknown>) => ({ type, dataMapping: {}, format: { ...title(t, subtitle), ...(style && { style }) } });
// PACT KPI tile: the widget draws its own label, so Studio's title bar is off.
// Donut charts: legend on the right (no paging in narrow cards) and the total in the ring.
const donutStyle = { theme: { common: { legend: { enabled: true, position: 'right' } } }, custom: { totalLabel: { enabled: true } } };
const tile = (metric: string) => ({ type: 'pact-kpi', dataMapping: {}, format: { title: { enabled: false, text: metric }, style: { metric } } });

export const PAGE_TITLES: Record<string, string> = {
  overview: 'Overview',
  verdicts: 'Verdicts',
  reputation: 'Reputation',
  reconciliation: 'Reconciliation',
  sentinel: 'Sentinel',
};

export const initialReport = (): AgReportState =>
  ({
    selectedPageId: 'overview',
    panels: { filters: { collapsed: true }, data: { collapsed: true }, edit: { collapsed: true } },
    pages: [
      {
        id: 'overview',
        widgets: {
          'kpi-released': tile('released'),
          'kpi-active': tile('active'),
          'kpi-decisions': tile('decisions'),
          'kpi-chain': tile('chain'),
          vault: custom('pact-escrow-vault', 'Escrow Vault', 'Money PayPal is holding for PACT right now'),
          gauges: custom('pact-rate-gauges', 'Dispute & refund rates', 'Settled milestones and AI decisions'),
          verdict: custom('pact-verdict-card', 'Latest decision', 'Explained, auditable, appealable'),
          timeline: custom('pact-milestone-timeline', 'Milestone timeline', 'Live pacts first · click a row in the ledger to drill through'),
          ledger: custom('pact-ledger', 'Pact ledger'),
          flow: custom('pact-money-flow', 'Money flow', 'Buyers → PayPal escrow → sellers, refunds, voids'),
        },
        widgetLayout: {
          'kpi-released': at(0, 0, 6, 8),
          'kpi-active': at(6, 0, 6, 8),
          'kpi-decisions': at(12, 0, 6, 8),
          'kpi-chain': at(18, 0, 6, 8),
          vault: at(0, 8, 8, 16),
          gauges: at(8, 8, 7, 16),
          verdict: at(15, 8, 9, 16),
          timeline: at(0, 24, 24, 17),
          ledger: at(0, 41, 14, 19),
          flow: at(14, 41, 10, 19),
        },
      },
      {
        id: 'verdicts',
        widgets: {
          'kpi-decisions': tile('decisions'),
          'kpi-confidence': tile('confidence'),
          'kpi-refused': tile('refused'),
          'kpi-precheck': tile('precheck'),
          'status-filter': { type: 'button-filter', dataMapping: { value: [{ id: 'verdicts.status' }] }, format: title('Filter by outcome') },
          'by-agent': {
            type: 'column-chart-stacked',
            dataMapping: { categoryKey: [{ id: 'verdicts.kind' }], valueKey: [{ id: 'verdicts.id', aggregation: 'count' }], legendKey: [{ id: 'verdicts.status' }] },
            format: title('Decisions by agent', 'Stacked by outcome'),
          },
          outcomes: {
            type: 'donut-chart',
            dataMapping: { categoryKey: [{ id: 'verdicts.status' }], valueKey: [{ id: 'verdicts.id', aggregation: 'count' }] },
            format: { ...title('Outcome mix', 'All AI and human decisions'), style: donutStyle },
          },
          refused: custom('pact-verdict-card', 'Refusals', 'Every refusal can be appealed to a human', { focus: 'refused' }),
          list: custom('pact-refused-list', 'Refused milestones this week'),
        },
        widgetLayout: {
          'kpi-decisions': at(0, 0, 6, 8),
          'kpi-confidence': at(6, 0, 6, 8),
          'kpi-refused': at(12, 0, 6, 8),
          'kpi-precheck': at(18, 0, 6, 8),
          'status-filter': at(0, 8, 24, 8),
          'by-agent': at(0, 16, 7, 17),
          outcomes: at(7, 16, 8, 17),
          refused: at(15, 16, 9, 17),
          list: at(0, 33, 24, 17),
        },
      },
      {
        id: 'reputation',
        widgets: {
          board: custom('pact-reputation-leaderboard', 'Reputation leaderboard', 'Completion 40% · on-time 25% · no-dispute 20% · no-refund 15%'),
          'score-chart': {
            type: 'bar-chart-grouped',
            dataMapping: { categoryKey: [{ id: 'reputation.name' }], valueKey: [{ id: 'reputation.score', aggregation: 'avg' }] },
            format: title('Score by party', 'Bayesian-smoothed, out of 100'),
          },
        },
        widgetLayout: { board: at(0, 0, 16, 30), 'score-chart': at(16, 0, 8, 30) },
      },
      {
        id: 'reconciliation',
        widgets: {
          'kpi-held': tile('held'),
          'kpi-released': tile('released'),
          recon: custom('pact-reconciliation', 'PayPal reconciliation', 'Transaction Search + balances vs. the PACT ledger'),
          ops: {
            type: 'donut-chart',
            dataMapping: { categoryKey: [{ id: 'payments.kind' }], valueKey: [{ id: 'payments.amount', aggregation: 'sum' }] },
            format: { ...title('PayPal operations by value', 'Recorded by PACT'), style: donutStyle },
          },
        },
        widgetLayout: { recon: at(0, 0, 16, 30), 'kpi-held': at(16, 0, 8, 8), 'kpi-released': at(16, 8, 8, 8), ops: at(16, 16, 8, 14) },
      },
      {
        id: 'sentinel',
        widgets: {
          radar: custom('pact-sentinel-radar', 'Anomaly radar', 'PACT Sentinel · deterministic rules, re-run on every live update'),
          'kpi-refused': tile('refused'),
          'kpi-held': tile('held'),
          'ms-status': {
            type: 'donut-chart',
            dataMapping: { categoryKey: [{ id: 'milestones.status' }], valueKey: [{ id: 'milestones.key', aggregation: 'count' }] },
            format: { ...title('Milestone outcomes', 'Every milestone on the ledger'), style: donutStyle },
          },
        },
        widgetLayout: { radar: at(0, 0, 14, 32), 'kpi-refused': at(14, 0, 5, 8), 'kpi-held': at(19, 0, 5, 8), 'ms-status': at(14, 8, 10, 24) },
      },
    ],
  }) as unknown as AgReportState;
