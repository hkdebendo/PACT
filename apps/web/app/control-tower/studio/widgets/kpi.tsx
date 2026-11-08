'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// KPI Tile: one PACT metric with its growth sparkline and the change over the last 24 hours.
// The metric is picked in the widget's own form (Studio edit mode) or by the AI agents through the
// widget's format, and it follows the page's filters and cross-filters like any Studio widget.
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { ctxOf, cumulative, ms, Pill, Spark, usd, useTableRows, type Row } from './common';

export const KPI_METRICS = {
  released: 'Released to sellers',
  held: 'Held in escrow',
  active: 'Active pacts',
  decisions: 'AI & human decisions',
  confidence: 'Mean AI confidence',
  refused: 'Refusal rate',
  precheck: 'Pre-check catches',
  chain: 'Audit chain',
} as const;
export type KpiMetric = keyof typeof KPI_METRICS;

const I = (d: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);
const ICON: Record<KpiMetric, ReactNode> = {
  released: I(<><path d="M7 17L17 7" /><path d="M8 7h9v9" /></>),
  held: I(<><rect x="3" y="5" width="18" height="15" rx="2.5" /><circle cx="12" cy="12.5" r="3" /><path d="M12 9.5V8" /></>),
  active: I(<><path d="M4 12h3l2.5-6 5 12L17 12h3" /></>),
  decisions: I(<><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></>),
  confidence: I(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></>),
  refused: I(<><circle cx="12" cy="12" r="8.5" /><path d="M8.5 8.5l7 7" /></>),
  precheck: I(<><path d="M4 6h16M4 12h10M4 18h7" /><path d="M16 16l2 2 4-4" /></>),
  chain: I(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>),
};
const COLOR: Record<KpiMetric, string> = {
  released: 'var(--pact-released)',
  held: 'var(--pact-held)',
  active: 'var(--pact-navy)',
  decisions: 'var(--pact-chart-5)',
  confidence: 'var(--pact-chart-7)',
  refused: 'var(--pact-refund)',
  precheck: 'var(--pact-chart-6)',
  chain: 'var(--pact-released)',
};

const DAY = 864e5;
const pctText = (v: number) => `${Math.round(v * 100)}%`;

export function KpiTileWidget(params: AgWidgetParams<any>) {
  const metric: KpiMetric = ((params.format as any)?.style?.metric as KpiMetric) in KPI_METRICS ? (params.format as any).style.metric : 'released';
  const ctx = ctxOf(params);
  const pacts = useTableRows(params, 'pacts', ['status', 'held', 'released', 'createdAt']);
  const payments = useTableRows(params, 'payments', ['kind', 'amount', 'createdAt']);
  const verdicts = useTableRows(params, 'verdicts', ['confidence', 'refused', 'precheckFailures', 'createdAt']);
  const end = ms(ctx?.asOf) || 0;

  const k = useMemo(() => {
    const P = pacts ?? [];
    const pay = payments ?? [];
    const V = verdicts ?? [];
    const ev = (rows: Row[], value: (r: Row) => number) => rows.map((r) => ({ at: ms(r.createdAt), value: value(r) })).filter((e) => e.at > 0);
    const lastDay = (events: { at: number; value: number }[]) => events.filter((e) => e.at >= end - DAY).reduce((a, e) => a + e.value, 0);
    switch (metric) {
      case 'released': {
        const e = ev(pay, (r) => (r.kind === 'capture' ? r.amount : r.kind === 'refund' ? -r.amount : 0));
        const d = lastDay(e);
        return { value: usd(P.reduce((a, r) => a + (r.released ?? 0), 0)), spark: cumulative(e, end), foot: 'captured from PayPal authorizations', delta: d ? `${d > 0 ? '+' : '−'}${usd(Math.abs(d))} 24h` : null };
      }
      case 'held': {
        const active = P.filter((r) => r.held > 0).length;
        return { value: usd(P.reduce((a, r) => a + (r.held ?? 0), 0)), spark: cumulative(ev(pay, (r) => (r.kind === 'authorization' ? r.amount : 0)), end), foot: `${active} authorization${active === 1 ? '' : 's'} open · not charged`, delta: null };
      }
      case 'active': {
        const n = P.filter((r) => ['funded', 'in_progress', 'disputed'].includes(r.status)).length;
        const e = ev(P, () => 1);
        const d = lastDay(e);
        return { value: String(n), spark: cumulative(e, end), foot: `of ${P.length} pacts on the ledger`, delta: d ? `+${d} new 24h` : null };
      }
      case 'decisions': {
        const e = ev(V, () => 1);
        const refused = V.filter((r) => r.refused).length;
        const d = lastDay(e);
        return { value: String(V.length), spark: cumulative(e, end), foot: `${refused} refusal${refused === 1 ? '' : 's'} · every one appealable`, delta: d ? `+${d} 24h` : null };
      }
      case 'confidence': {
        const mean = V.length ? V.reduce((a, r) => a + (r.confidence ?? 0), 0) / V.length : 0;
        // Running mean over time: does the verifier get more or less certain?
        const sorted = [...V].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
        let s = 0;
        const run = sorted.map((r, i) => (s += r.confidence ?? 0) / (i + 1));
        const step = Math.max(1, Math.floor(run.length / 18));
        return { value: pctText(mean), spark: run.filter((_, i) => i % step === 0 || i === run.length - 1), foot: `across ${V.length} decisions`, delta: null };
      }
      case 'refused': {
        const refused = V.filter((r) => r.refused).length;
        return { value: pctText(V.length ? refused / V.length : 0), spark: cumulative(ev(V, (r) => (r.refused ? 1 : 0)), end), foot: `${refused} of ${V.length} AI decisions`, delta: null };
      }
      case 'precheck': {
        const e = ev(V, (r) => r.precheckFailures ?? 0);
        return { value: String(e.reduce((a, x) => a + x.value, 0)), spark: cumulative(e, end), foot: 'caught by deterministic checks before the AI', delta: null };
      }
      case 'chain':
        return { value: String(ctx?.audit.count ?? 0), spark: [], foot: `head ${ctx?.audit.headHash.slice(0, 10) ?? '—'}`, delta: null, ok: ctx?.audit.ok };
    }
  }, [metric, pacts, payments, verdicts, end, ctx]);

  const color = COLOR[metric];
  return (
    <div className="pw pw-kpi" style={{ '--kpi-color': color } as CSSProperties}>
      <div className="pw-kpi-head">
        <span className="pw-kpi-icon">{ICON[metric]}</span>
        <span className="pw-eyebrow pw-truncate" style={{ flex: 1 }}>
          {KPI_METRICS[metric]}
        </span>
        {k.delta && <Pill tone="released">{k.delta}</Pill>}
        {metric === 'chain' && (
          <Pill tone={k.ok ? 'released' : 'refund'} dot>
            {k.ok ? 'verified' : 'BROKEN'}
          </Pill>
        )}
      </div>
      <div className="pw-kpi-body">
        <span className="pw-kpi-value pw-display">{k.value}</span>
        {k.spark.length > 1 && <Spark points={k.spark} color={color} label={`${KPI_METRICS[metric]} trend`} />}
      </div>
      <div className="pw-kpi-foot">
        <span className={metric === 'chain' ? 'pw-mono pw-truncate' : 'pw-truncate'}>{metric === 'chain' ? `SHA-256 entries · ${k.foot}` : k.foot}</span>
      </div>
    </div>
  );
}
