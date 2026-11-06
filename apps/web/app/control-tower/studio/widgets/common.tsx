'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// Shared plumbing for PACT's custom AG Studio widgets. Widgets read fields straight from the report
// schema (no data mapping needed), so page filters and cross-filters still apply, and they stay
// current through `onDataUpdated` as the live SSE feed replaces Studio's data.
import { useEffect, useRef, useState } from 'react';
import type { AgWidgetParams } from 'ag-studio';

export interface TowerContext {
  apiUrl: string;
  asOf: string;
  paymentMode: 'sandbox' | 'simulated';
  llmMode: 'live' | 'replay';
  audit: { ok: boolean; count: number; headHash: string; verifiedAt: string };
  reconciliation: { asOf: string; caveat: string; balances: Record<string, unknown>[]; errors: string[]; pending: number } | null;
  openPact: (pactId: string, milestoneId?: string) => void;
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
      .getData({ kind: 'flat', fields, limit: { count: opts.limit ?? 1000 } } as any, { onDataUpdated: apply, ...(opts.crossFilter && { crossFilter: opts.crossFilter }) } as any)
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

export const W = {
  root: { height: '100%', width: '100%', fontFamily: 'var(--pact-font)', color: 'var(--pact-ink)', display: 'flex', flexDirection: 'column' as const, gap: 10, overflow: 'hidden' },
  eyebrow: { fontSize: 10.5, letterSpacing: '0.16em', textTransform: 'uppercase' as const, color: 'var(--pact-muted)', fontWeight: 600 },
  display: { fontFamily: 'var(--pact-display)' },
  mono: { fontFamily: 'var(--pact-mono)', fontSize: 12 },
};
