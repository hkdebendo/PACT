'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// Pact widgets: Milestone Timeline, Verdict Card, Pact Ledger (drill-through), Reputation
// Leaderboard (AG Grid + sparklines) and PayPal Reconciliation (AG Grid).
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { studioGridTheme } from 'ag-studio';
import { AllCommunityModule, ModuleRegistry, type ColDef, type ICellRendererParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { STATUS_COLOR, crossFilterPact, ctxOf, usd, useTableRows, W, type Row } from './common';

ModuleRegistry.registerModules([AllCommunityModule]);

const pill = (bg: string, fg: string) => ({ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, fontWeight: 600, whiteSpace: 'nowrap' as const });
const TONE: Record<string, [string, string]> = {
  approved: ['var(--pact-released-soft)', 'var(--pact-released)'],
  release: ['var(--pact-released-soft)', 'var(--pact-released)'],
  released: ['var(--pact-released-soft)', 'var(--pact-released)'],
  completed: ['var(--pact-released-soft)', 'var(--pact-released)'],
  rejected: ['var(--pact-refund-soft)', 'var(--pact-refund)'],
  refund: ['var(--pact-refund-soft)', 'var(--pact-refund)'],
  refunded: ['var(--pact-refund-soft)', 'var(--pact-refund)'],
  disputed: ['var(--pact-refund-soft)', 'var(--pact-refund)'],
  needs_more: ['var(--pact-held-soft)', 'var(--pact-held)'],
  partial: ['var(--pact-held-soft)', 'var(--pact-held)'],
  funded: ['var(--pact-held-soft)', 'var(--pact-held)'],
  in_progress: ['var(--pact-held-soft)', 'var(--pact-held)'],
};
const tone = (s: string) => TONE[s] ?? ['var(--pact-paper-2)', 'var(--pact-ink-2)'];
const nice = (s: string) => String(s ?? '').replace(/_/g, ' ');

// --- 2. Milestone Timeline -----------------------------------------------------------------

export function MilestoneTimelineWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'milestones', ['pactId', 'pactTitle', 'milestoneId', 'position', 'title', 'percent', 'amount', 'status', 'lastVerdict', 'lastConfidence', 'thumbnailUrl', 'attempts', 'seller']);
  const ctx = ctxOf(params);
  const pacts = useMemo(() => {
    const by = new Map<string, Row[]>();
    for (const r of rows ?? []) by.set(r.pactId, [...(by.get(r.pactId) ?? []), r]);
    return [...by.entries()].map(([id, ms]) => ({ id, title: ms[0].pactTitle, seller: ms[0].seller, ms: ms.sort((a, b) => a.position - b.position) }));
  }, [rows]);
  // With a cross-filter there is one pact; otherwise show the most recent ones.
  const shown = pacts.slice(-Math.max(1, Math.min(3, pacts.length))).reverse();
  return (
    <div style={{ ...W.root, overflowY: 'auto', gap: 18 }}>
      {shown.map((p) => (
        <div key={p.id}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
            <span style={{ ...W.display, fontSize: 17 }}>{p.title}</span>
            <span style={{ fontSize: 12, color: 'var(--pact-muted)' }}>· {p.seller}</span>
            <button onClick={() => ctx.openPact(p.id)} style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--pact-navy)', textDecoration: 'underline', background: 'none', border: 0, cursor: 'pointer' }}>
              Open pact room →
            </button>
          </div>
          <ol style={{ display: 'flex', gap: 0, listStyle: 'none', margin: 0, padding: 0 }}>
            {p.ms.map((m, i) => (
              <li key={m.milestoneId} style={{ flex: m.percent, minWidth: 120, position: 'relative' }}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <motion.button
                    layout
                    onClick={() => ctx.openPact(p.id, m.milestoneId)}
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 18, delay: i * 0.06 }}
                    title={`${m.title}: ${nice(m.status)}`}
                    style={{ width: 30, height: 30, borderRadius: 999, border: `2px solid ${STATUS_COLOR[m.status] ?? 'var(--pact-line)'}`, background: ['released', 'approved'].includes(m.status) ? STATUS_COLOR[m.status] : 'var(--pact-surface)', color: ['released', 'approved'].includes(m.status) ? '#fff' : STATUS_COLOR[m.status], fontWeight: 700, fontSize: 13, cursor: 'pointer', flexShrink: 0 }}
                  >
                    {m.status === 'released' ? '✓' : m.status === 'rejected' ? '✗' : m.status === 'refunded' ? '↺' : i + 1}
                  </motion.button>
                  {i < p.ms.length - 1 && <div style={{ flex: 1, height: 2, background: ['released', 'partially_released'].includes(m.status) ? STATUS_COLOR[m.status] : 'var(--pact-line)', margin: '0 6px' }} />}
                </div>
                <div style={{ marginTop: 8, paddingRight: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{m.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--pact-muted)' }}>
                    {m.percent}% · {usd(m.amount)}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    <span style={pill(...tone(m.status))}>{nice(m.status)}</span>
                    {m.lastConfidence != null && <span style={{ ...W.mono, color: 'var(--pact-muted)' }}>conf {Math.round(m.lastConfidence * 100)}%</span>}
                    {m.attempts > 1 && <span style={{ fontSize: 11, color: 'var(--pact-muted)' }}>{m.attempts} tries</span>}
                  </div>
                  {m.thumbnailUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`${ctx.apiUrl}${m.thumbnailUrl}`} alt={`Latest evidence for ${m.title}`} style={{ marginTop: 8, width: 84, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--pact-line)' }} />
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

// --- 3. Verdict Card -------------------------------------------------------------------------

export function VerdictCardWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'verdicts', ['id', 'pactId', 'pactTitle', 'milestoneTitle', 'milestoneKey', 'kind', 'status', 'confidence', 'reasoning', 'model', 'llmMode', 'appealStatus', 'createdAt', 'precheckFailures']);
  const ctx = ctxOf(params);
  const focus = (params.format as any)?.style?.focus ?? 'latest';
  const list = useMemo(() => {
    const sorted = [...(rows ?? [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return focus === 'refused' ? sorted.filter((r) => ['rejected', 'refund'].includes(r.status)) : sorted;
  }, [rows, focus]);
  const [i, setI] = useState(0);
  const v = list[Math.min(i, list.length - 1)];
  const [busy, setBusy] = useState(false);
  if (!v) return <div style={W.root} />;
  const [bg, fg] = tone(v.status);
  return (
    <div style={{ ...W.root, gap: 10 }}>
      <AnimatePresence mode="wait">
        <motion.div key={v.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={pill(bg, fg)}>{nice(v.status)}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{v.kind === 'verifier' ? 'AI Verifier' : v.kind === 'arbiter' ? 'AI Arbiter' : 'Human reviewer'}</span>
            <span style={{ ...W.mono, color: 'var(--pact-muted)' }}>conf {Math.round(v.confidence * 100)}%</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--pact-muted)' }}>
              {v.model}
              {v.llmMode === 'replay' ? ' · recorded' : ''}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--pact-muted)' }}>
            {v.pactTitle} → <b style={{ color: 'var(--pact-ink-2)' }}>{v.milestoneTitle}</b> · {new Date(v.createdAt).toLocaleString()}
          </div>
          <p style={{ ...W.display, fontSize: 15.5, lineHeight: 1.45, margin: 0, overflow: 'auto', flex: 1 }}>“{v.reasoning}”</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={pill(ctx.audit.ok ? 'var(--pact-released-soft)' : 'var(--pact-refund-soft)', ctx.audit.ok ? 'var(--pact-released)' : 'var(--pact-refund)')} title={`${ctx.audit.count} entries, head ${ctx.audit.headHash}`}>
              {ctx.audit.ok ? '✓ chain verified' : '✗ chain broken'} <span style={{ fontFamily: 'var(--pact-mono)', opacity: 0.7 }}>{ctx.audit.headHash.slice(0, 8)}</span>
            </span>
            {v.appealStatus !== 'none' ? (
              <span style={pill('var(--pact-navy)', 'var(--pact-paper)')}>appeal {v.appealStatus}</span>
            ) : (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await ctx.appeal(v.id).finally(() => setBusy(false));
                }}
                style={{ fontSize: 12, padding: '4px 12px', borderRadius: 999, border: '1px solid var(--pact-line)', background: 'var(--pact-surface)', color: 'var(--pact-ink)', cursor: 'pointer' }}
              >
                {busy ? 'Sending…' : 'Appeal to a human'}
              </button>
            )}
            <button onClick={() => ctx.openPact(v.pactId, String(v.milestoneKey).split(':')[1])} style={{ fontSize: 12, background: 'none', border: 0, color: 'var(--pact-navy)', textDecoration: 'underline', cursor: 'pointer' }}>
              Evidence →
            </button>
            {list.length > 1 && (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--pact-muted)' }}>
                <button aria-label="Newer verdict" onClick={() => setI((x) => Math.max(0, x - 1))} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--pact-ink-2)' }}>
                  ‹
                </button>
                {Math.min(i, list.length - 1) + 1}/{list.length}
                <button aria-label="Older verdict" onClick={() => setI((x) => Math.min(list.length - 1, x + 1))} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--pact-ink-2)' }}>
                  ›
                </button>
              </span>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// --- Pact Ledger: grid with drill-through ----------------------------------------------------

const StatusCell = (p: ICellRendererParams) => {
  const [bg, fg] = tone(p.value);
  return <span style={pill(bg, fg)}>{nice(p.value)}</span>;
};
const ProgressCell = (p: ICellRendererParams) => {
  const r = p.data as Row;
  const pct = r.total ? (r.released / r.total) * 100 : 0;
  const held = r.total ? (r.held / r.total) * 100 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
      <div style={{ display: 'flex', width: 90, height: 6, borderRadius: 99, overflow: 'hidden', background: 'var(--pact-paper-2)' }}>
        <div style={{ width: `${pct}%`, background: 'var(--pact-released)' }} />
        <div style={{ width: `${held}%`, background: 'var(--pact-held)' }} />
      </div>
    </div>
  );
};

export function PactLedgerWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'pacts', ['id', 'title', 'status', 'buyer', 'seller', 'total', 'held', 'released', 'refunded', 'paymentMode', 'createdAt'], { crossFilter: 'none' });
  const ctx = ctxOf(params);
  const [selected, setSelected] = useState<string | null>(null);
  const cols = useMemo<ColDef[]>(
    () => [
      { field: 'title', headerName: 'Pact', flex: 2, minWidth: 160 },
      { field: 'status', headerName: 'Status', cellRenderer: StatusCell, width: 120 },
      { field: 'seller', headerName: 'Seller', flex: 1, minWidth: 110 },
      { field: 'total', headerName: 'Total', valueFormatter: (p) => usd(p.value), width: 90, type: 'rightAligned' },
      { headerName: 'Released / held', cellRenderer: ProgressCell, width: 130, sortable: false },
      { field: 'paymentMode', headerName: 'PayPal', width: 100, valueFormatter: (p) => (p.value === 'sandbox' ? 'sandbox' : 'SIMULATED') },
      { field: 'createdAt', headerName: 'Created', width: 110, valueFormatter: (p) => new Date(p.value).toLocaleDateString(), sort: 'desc' },
    ],
    [],
  );
  return (
    <div style={{ ...W.root, gap: 6 }}>
      <div style={{ fontSize: 11.5, color: 'var(--pact-muted)' }}>
        Click a row to drill through: every widget on this page filters to that pact. Double-click opens the pact room.
        {selected && (
          <button onClick={() => (setSelected(null), crossFilterPact(params, null))} style={{ marginLeft: 8, border: 0, background: 'none', color: 'var(--pact-navy)', textDecoration: 'underline', cursor: 'pointer' }}>
            Clear
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <AgGridReact
          theme={studioGridTheme}
          rowData={rows ?? []}
          columnDefs={cols}
          getRowId={(p) => p.data.id}
          rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
          onRowClicked={(e) => {
            const id = e.data?.id;
            if (!id) return;
            const next = selected === id ? null : id;
            setSelected(next);
            crossFilterPact(params, next);
          }}
          onRowDoubleClicked={(e) => e.data && ctx.openPact(e.data.id)}
          rowHeight={40}
        />
      </div>
    </div>
  );
}

// --- 4. Reputation Leaderboard -----------------------------------------------------------------

const Sparkline = (p: ICellRendererParams) => {
  const pts = String(p.value ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (pts.length < 2) return <span style={{ fontSize: 11, color: 'var(--pact-muted)' }}>new</span>;
  const min = Math.min(...pts) - 2;
  const max = Math.max(...pts) + 2;
  const w = 90;
  const h = 26;
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * w).toFixed(1)},${(h - ((v - min) / (max - min)) * h).toFixed(1)}`).join(' ');
  const up = pts.at(-1)! >= pts[0];
  return (
    <svg width={w} height={h} style={{ verticalAlign: 'middle' }} aria-label={`trend ${up ? 'up' : 'down'}`}>
      <path d={path} fill="none" stroke={up ? 'var(--pact-released)' : 'var(--pact-refund)'} strokeWidth="1.8" />
      <circle cx={w} cy={h - ((pts.at(-1)! - min) / (max - min)) * h} r="2.5" fill={up ? 'var(--pact-released)' : 'var(--pact-refund)'} />
    </svg>
  );
};
const ScoreCell = (p: ICellRendererParams) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: '100%' }}>
    <span style={{ fontFamily: 'var(--pact-display)', fontSize: 17, width: 34 }}>{Number(p.value).toFixed(0)}</span>
    <div style={{ width: 70, height: 5, borderRadius: 99, background: 'var(--pact-paper-2)', overflow: 'hidden' }}>
      <div style={{ width: `${p.value}%`, height: '100%', background: p.value >= 88 ? 'var(--pact-released)' : p.value >= 75 ? 'var(--pact-navy)' : p.value >= 60 ? 'var(--pact-held)' : 'var(--pact-refund)' }} />
    </div>
  </div>
);
const pct = (p: { value: number }) => `${Math.round((p.value ?? 0) * 100)}%`;

export function ReputationLeaderboardWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'reputation', ['name', 'kind', 'score', 'tier', 'completionRate', 'onTimeRate', 'disputeRate', 'refundRate', 'confidence', 'milestones', 'trend']);
  const cols = useMemo<ColDef[]>(
    () => [
      { headerName: '#', valueGetter: (p) => (p.node?.rowIndex ?? 0) + 1, width: 52, sortable: false },
      { field: 'name', headerName: 'Party', flex: 1.4, minWidth: 140 },
      { field: 'score', headerName: 'Score', cellRenderer: ScoreCell, width: 140, sort: 'desc' },
      { field: 'trend', headerName: 'Trend', cellRenderer: Sparkline, width: 110, sortable: false },
      { field: 'tier', headerName: 'Tier', cellRenderer: StatusCell, width: 105 },
      { field: 'completionRate', headerName: 'Completion', valueFormatter: pct, width: 105 },
      { field: 'onTimeRate', headerName: 'On time', valueFormatter: pct, width: 90 },
      { field: 'disputeRate', headerName: 'Disputes', valueFormatter: pct, width: 90 },
      { field: 'confidence', headerName: 'Confidence', valueFormatter: pct, width: 100, headerTooltip: 'Share of the score backed by real history rather than the prior' },
    ],
    [],
  );
  return (
    <div style={{ ...W.root, gap: 6 }}>
      <div style={{ fontSize: 11.5, color: 'var(--pact-muted)' }}>Bayesian-smoothed: new parties start at the prior (~80) instead of 0 or 100. See docs/REPUTATION.md.</div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <AgGridReact theme={studioGridTheme} rowData={(rows ?? []).filter((r) => r.kind !== undefined)} columnDefs={cols} rowHeight={42} tooltipShowDelay={300} />
      </div>
    </div>
  );
}

// --- 7. PayPal Reconciliation ------------------------------------------------------------------

export function ReconciliationWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'paypalTransactions', ['id', 'date', 'eventCode', 'status', 'amount', 'counterparty', 'note', 'pactId', 'pactKind', 'matched'], { crossFilter: 'none' });
  const ctx = ctxOf(params);
  const rec = ctx.reconciliation;
  const cols = useMemo<ColDef[]>(
    () => [
      { field: 'date', headerName: 'Date', width: 160, valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : ''), sort: 'desc' },
      { field: 'id', headerName: 'PayPal transaction', flex: 1, minWidth: 150, cellStyle: { fontFamily: 'var(--pact-mono)', fontSize: 12 } },
      { field: 'eventCode', headerName: 'T-code', width: 80 },
      { field: 'amount', headerName: 'Amount', width: 100, valueFormatter: (p) => usd(p.value), type: 'rightAligned' },
      { field: 'note', headerName: 'Note', flex: 1, minWidth: 140 },
      { field: 'matched', headerName: 'PACT match', width: 120, cellRenderer: (p: ICellRendererParams) => <span style={pill(...(p.value ? tone('released') : tone('needs_more')))}>{p.value ? `✓ ${p.data.pactKind}` : 'unmatched'}</span> },
    ],
    [],
  );
  return (
    <div style={{ ...W.root, gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
        <span style={{ fontSize: 12 }}>
          As of <b>{rec ? new Date(rec.asOf).toLocaleString() : '—'}</b>
        </span>
        {rec?.balances.map((b: any) => (
          <span key={b.currency} style={{ fontSize: 12 }}>
            Balance <b>{usd(b.total)}</b> {b.currency}
          </span>
        ))}
        {rec && rec.pending > 0 && <span style={pill(...tone('needs_more'))}>{rec.pending} PACT operation(s) not yet in Transaction Search</span>}
        <span style={pill(ctx.paymentMode === 'sandbox' ? 'var(--pact-released-soft)' : 'var(--pact-held-soft)', ctx.paymentMode === 'sandbox' ? 'var(--pact-released)' : 'var(--pact-held)')}>{ctx.paymentMode === 'sandbox' ? 'PayPal sandbox' : 'SIMULATED ledger'}</span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--pact-muted)' }}>{rec?.caveat}</div>
      {rec?.errors.map((e) => (
        <div key={e} style={{ fontSize: 12, color: 'var(--pact-refund)' }}>
          {e}
        </div>
      ))}
      <div style={{ flex: 1, minHeight: 0 }}>
        <AgGridReact theme={studioGridTheme} rowData={(rows ?? []).filter((r) => r.id !== '—')} columnDefs={cols} rowHeight={36} />
      </div>
    </div>
  );
}

// --- Refused milestones (added live by the PACT Auditor) ---------------------------------------

export function RefusedListWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'verdicts', ['id', 'pactId', 'pactTitle', 'milestoneTitle', 'milestoneKey', 'kind', 'status', 'confidence', 'reasoning', 'appealStatus', 'createdAt']);
  const ctx = ctxOf(params);
  const since = Date.now() - 7 * 864e5;
  const refused = (rows ?? []).filter((r) => ['rejected', 'refund'].includes(r.status) && new Date(r.createdAt).getTime() >= since);
  const cols = useMemo<ColDef[]>(
    () => [
      { field: 'createdAt', headerName: 'When', width: 150, valueFormatter: (p) => new Date(p.value).toLocaleString(), sort: 'desc' },
      { field: 'pactTitle', headerName: 'Pact', flex: 1, minWidth: 140 },
      { field: 'milestoneTitle', headerName: 'Milestone', width: 120 },
      { field: 'kind', headerName: 'By', width: 90, valueFormatter: (p) => (p.value === 'verifier' ? 'Verifier' : p.value === 'arbiter' ? 'Arbiter' : 'Human') },
      { field: 'confidence', headerName: 'Conf.', width: 75, valueFormatter: (p) => `${Math.round(p.value * 100)}%` },
      { field: 'reasoning', headerName: 'Why', flex: 2.5, minWidth: 240, tooltipField: 'reasoning', wrapText: true, autoHeight: true, cellStyle: { lineHeight: '1.35', paddingTop: 6, paddingBottom: 6 } },
      { field: 'appealStatus', headerName: 'Appeal', width: 95 },
    ],
    [],
  );
  return (
    <div style={{ ...W.root, gap: 6 }}>
      <div style={{ fontSize: 11.5, color: 'var(--pact-muted)' }}>
        {refused.length} refusal{refused.length === 1 ? '' : 's'} in the last 7 days · double-click a row to open its evidence
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <AgGridReact theme={studioGridTheme} rowData={refused} columnDefs={cols} onRowDoubleClicked={(e) => e.data && ctx.openPact(e.data.pactId, String(e.data.milestoneKey).split(':')[1])} tooltipShowDelay={200} />
      </div>
    </div>
  );
}
