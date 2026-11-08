'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// Shared plumbing for PACT's custom AG Studio widgets. Widgets read fields straight from the report
// schema (no data mapping needed), so page filters and cross-filters still apply, and they stay
// current through `onDataUpdated` as the live SSE feed replaces Studio's data.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AgWidgetParams } from 'ag-studio';

export interface TowerContext {
  apiUrl: string;
  asOf: string;
  paymentMode: 'sandbox' | 'simulated';
  llmMode: 'live' | 'replay';
  audit: { ok: boolean; count: number; headHash: string; verifiedAt: string };
  reconciliation: { asOf: string; caveat: string; balances: Record<string, unknown>[]; errors: string[]; pending: number } | null;
  openPact: (pactId: string, milestoneId?: string, opts?: { newTab?: boolean }) => void;
  appeal: (verdictId: string) => Promise<void>;
}

export type Row = Record<string, any>;

/**
 * Rows of one table with the given fields (short names, e.g. ['title', 'status'] on 'milestones').
 * Results are keyed by short name. `crossFilter: 'none'` opts the widget out of cross-filtering.
 */
export function useTableRows(params: AgWidgetParams<any>, table: string, names: string[], opts: { crossFilter?: 'none'; limit?: number } = {}) {
  const { widgetApi } = params;
  const [rows, setRows] = useState<Row[] | null>(null);
  const loaded = useRef(false);
  const namesKey = names.join(',');

  useEffect(() => {
    let cancelled = false;
    const schemaFields = widgetApi.getSchema().flatMap((t: any) => t.fields) as any[];
    const fields = names.map((n) => schemaFields.find((f) => f.key === `${table}.${n}`)).filter(Boolean);
    if (fields.length !== names.length) {
      widgetApi.setDisplayState('noData');
      return;
    }
    const toRows = (response: any): Row[] =>
      (response?.results?.rows ?? []).map((r: Row) => Object.fromEntries(fields.map((f: any) => [f.key.slice(table.length + 1), r[f.key]])));
    const apply = (response: any) => {
      if (cancelled || response?.replaced) return;
      const next = toRows(response);
      loaded.current = true;
      setRows(next);
      widgetApi.setDisplayState(next.length ? 'displayed' : 'noData');
    };
    widgetApi.setDisplayState('loading', { prominent: !loaded.current });
    widgetApi
      .getData({ kind: 'flat', fields, limit: { count: opts.limit ?? 1000 } } as any, { queryId: `${table}:${namesKey}`, onDataUpdated: apply, ...(opts.crossFilter && { crossFilter: opts.crossFilter }) } as any)
      .then(apply)
      .catch(() => !cancelled && widgetApi.setDisplayState('noData'));
    return () => {
      cancelled = true;
    };
    // `params` changes on every schema/state change Studio hands the widget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, table, namesKey]);

  return rows;
}

export const ctxOf = (params: AgWidgetParams<any>) => params.context as TowerContext;

export function fieldOf(params: AgWidgetParams<any>, key: string): any {
  return params.widgetApi.getSchema().flatMap((t: any) => t.fields).find((f: any) => f.key === key);
}

/** Cross-filter the whole page to one pact: Studio's own drill-through mechanism. */
export function crossFilterPact(params: AgWidgetParams<any>, pactId: string | null) {
  const field = fieldOf(params, 'pacts.id');
  if (!field) return;
  if (!pactId) (params.widgetApi as any).resetCrossFilter?.();
  else (params.widgetApi as any).toggleCrossFilter({ type: 'multiValue', values: [{ field, value: pactId }], group: 0 });
}

/** Studio may hand dates back as strings, numbers or Date objects: compare as epoch ms. */
export const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(String(v ?? '')) || 0);

export const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n || 0);

export const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--pact-line)',
  evidence_submitted: 'var(--pact-navy)',
  approved: 'var(--pact-released)',
  rejected: 'var(--pact-refund)',
  needs_more: 'var(--pact-held)',
  released: 'var(--pact-released)',
  disputed: 'var(--pact-refund)',
  partially_released: 'var(--pact-held)',
  refunded: 'var(--pact-refund)',
  voided: 'var(--pact-void)',
};

export type PillTone = 'released' | 'held' | 'refund' | 'navy' | 'void' | 'neutral';
const PILL_TONE: Record<string, PillTone> = {
  approved: 'released',
  release: 'released',
  released: 'released',
  completed: 'released',
  closed: 'released',
  excellent: 'released',
  rejected: 'refund',
  refund: 'refund',
  refunded: 'refund',
  disputed: 'refund',
  needs_more: 'held',
  partial: 'held',
  partially_released: 'held',
  funded: 'held',
  in_progress: 'held',
  trusted: 'navy',
  evidence_submitted: 'navy',
  voided: 'void',
  cancelled: 'void',
  expired: 'void',
};
export const toneOf = (status: string): PillTone => PILL_TONE[status] ?? 'neutral';
export const nice = (s: unknown) => String(s ?? '').replace(/_/g, ' ');

export function Pill({ tone = 'neutral', dot, children, title }: { tone?: PillTone; dot?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className="pw-pill" data-tone={tone} title={title}>
      {dot && <span className="pw-dot" aria-hidden />}
      {children}
    </span>
  );
}

/** Size of an element, for widgets that lay out SVG in real pixels (no scaled-down text). */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ width: Math.round(e.contentRect.width), height: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Smooth area sparkline (monotone-ish cubic through the points), drawn to its box. */
export function Spark({ points, color, height = 38, label }: { points: number[]; color: string; height?: number; label?: string }) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const id = `sp${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const d = (() => {
    if (points.length < 2 || !width) return null;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const xy = points.map((v, i) => [(i / (points.length - 1)) * width, 3 + (1 - (v - min) / span) * (height - 6)] as const);
    let line = `M${xy[0][0].toFixed(1)},${xy[0][1].toFixed(1)}`;
    for (let i = 1; i < xy.length; i++) {
      const [x0, y0] = xy[i - 1];
      const [x1, y1] = xy[i];
      const mx = (x0 + x1) / 2;
      line += ` C${mx.toFixed(1)},${y0.toFixed(1)} ${mx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    return { line, area: `${line} L${width},${height} L0,${height} Z`, last: xy[xy.length - 1] };
  })();
  return (
    <div ref={ref} className="pw-kpi-spark" style={{ height }} role="img" aria-label={label}>
      {d && (
        <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.28" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={d.area} fill={`url(#${id})`} />
          <path d={d.line} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
          <circle cx={d.last[0]} cy={d.last[1]} r="3" fill={color} stroke="var(--pact-surface)" strokeWidth="1.5" />
        </svg>
      )}
    </div>
  );
}

/**
 * Cumulative series over `buckets` equal time slices, from the first event to `end`: the shape of
 * how a total grew, which reads well even when activity is bursty.
 */
export function cumulative(events: { at: number; value: number }[], end: number, buckets = 18): number[] {
  if (!events.length) return [];
  const start = Math.min(...events.map((e) => e.at));
  const span = Math.max(1, end - start);
  const out = new Array(buckets).fill(0);
  for (const e of events) out[Math.min(buckets - 1, Math.floor(((e.at - start) / span) * buckets))] += e.value;
  for (let i = 1; i < buckets; i++) out[i] += out[i - 1];
  return [0, ...out];
}

export const W = {
  root: { height: '100%', width: '100%', fontFamily: 'var(--pact-font)', color: 'var(--pact-ink)', display: 'flex', flexDirection: 'column' as const, gap: 10, overflow: 'hidden' },
  eyebrow: { fontSize: 10.5, letterSpacing: '0.16em', textTransform: 'uppercase' as const, color: 'var(--pact-muted)', fontWeight: 600 },
  display: { fontFamily: 'var(--pact-display)' },
  mono: { fontFamily: 'var(--pact-mono)', fontSize: 12 },
};
