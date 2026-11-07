// The built-in "PACT Control Tower" report: four pages, laid out on Studio's 24-column canvas.
// Mixes PACT's custom widgets with Studio's own (KPI values, a column chart, a list filter).
import type { AgReportState } from 'ag-studio';

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number) => ({ xTrack, yTrack, xSpan, ySpan });
const title = (text: string, subtitle?: string) => ({
  title: { enabled: true, text },
  ...(subtitle && { subtitle: { enabled: true, text: subtitle } }),
});
const custom = (type: string, t: string, subtitle?: string, style?: Record<string, unknown>) => ({ type, dataMapping: {}, format: { ...title(t, subtitle), ...(style && { style }) } });
const kpi = (text: string, id: string, aggregation: 'sum' | 'count' | 'avg' = 'sum') => ({
  type: 'value',
  dataMapping: { value: [{ id, aggregation }] },
  format: { title: { enabled: true, text } },
});

export const PAGE_TITLES: Record<string, string> = {
  overview: 'Overview',
  verdicts: 'Verdicts & audit',
  reputation: 'Reputation',
  reconciliation: 'PayPal reconciliation',
};

export const initialReport = (): AgReportState =>
  ({
    selectedPageId: 'overview',
    panels: { filters: { collapsed: true }, data: { collapsed: true }, edit: { collapsed: true } },
    pages: [
      {
        id: 'overview',
        widgets: {
          vault: custom('pact-escrow-vault', 'Escrow Vault', 'Money PayPal is holding for PACT right now'),
          gauges: custom('pact-rate-gauges', 'Dispute & refund rates'),
          verdict: custom('pact-verdict-card', 'Latest decision', 'Explained, auditable, appealable'),
          timeline: custom('pact-milestone-timeline', 'Milestone timeline', 'Click a pact in the ledger to drill through'),
          ledger: custom('pact-ledger', 'Pact ledger'),
          flow: custom('pact-money-flow', 'Money flow', 'Buyers → escrow → sellers, refunds, voids'),
        },
        widgetLayout: {
          vault: at(0, 0, 9, 14),
          gauges: at(9, 0, 7, 14),
          verdict: at(16, 0, 8, 14),
          timeline: at(0, 14, 24, 15),
          ledger: at(0, 29, 14, 17),
          flow: at(14, 29, 10, 17),
        },
      },
      {
        id: 'verdicts',
        widgets: {
          'kpi-verdicts': kpi('AI & human decisions', 'verdicts.id', 'count'),
          'kpi-confidence': kpi('Mean confidence', 'verdicts.confidence', 'avg'),
          'kpi-precheck': kpi('Pre-check failures', 'verdicts.precheckFailures'),
          'by-status': {
            type: 'column-chart-stacked',
            dataMapping: { categoryKey: [{ id: 'verdicts.kind' }], valueKey: [{ id: 'verdicts.id', aggregation: 'count' }], seriesKey: [{ id: 'verdicts.status' }] },
            format: title('Decisions by agent and outcome'),
          },
          'status-filter': { type: 'list-filter', dataMapping: { value: [{ id: 'verdicts.status' }] }, format: title('Outcome') },
          refused: custom('pact-verdict-card', 'Refusals', 'Every refusal can be appealed to a human', { focus: 'refused' }),
          list: custom('pact-refused-list', 'Refused milestones this week'),
        },
        widgetLayout: {
          'kpi-verdicts': at(0, 0, 6, 7),
          'kpi-confidence': at(6, 0, 6, 7),
          'kpi-precheck': at(12, 0, 6, 7),
          'status-filter': at(18, 0, 6, 7),
          'by-status': at(0, 7, 12, 16),
          refused: at(12, 7, 12, 16),
          list: at(0, 23, 24, 16),
        },
      },
      {
        id: 'reputation',
        widgets: {
          board: custom('pact-reputation-leaderboard', 'Reputation leaderboard', 'Completion 40% · on-time 25% · no-dispute 20% · no-refund 15%'),
          'score-chart': {
            type: 'bar-chart-grouped',
            dataMapping: { categoryKey: [{ id: 'reputation.name' }], valueKey: [{ id: 'reputation.score', aggregation: 'avg' }] },
            format: title('Score by party'),
          },
        },
        widgetLayout: { board: at(0, 0, 15, 27), 'score-chart': at(15, 0, 9, 27) },
      },
      {
        id: 'reconciliation',
        widgets: {
          recon: custom('pact-reconciliation', 'PayPal reconciliation', 'Transaction Search + balances vs. the PACT ledger'),
          ops: {
            type: 'column-chart-grouped',
            dataMapping: { categoryKey: [{ id: 'payments.kind' }], valueKey: [{ id: 'payments.amount', aggregation: 'sum' }] },
            format: title('PayPal operations recorded by PACT'),
          },
        },
        widgetLayout: { recon: at(0, 0, 16, 26), ops: at(16, 0, 8, 26) },
      },
    ],
  }) as unknown as AgReportState;
