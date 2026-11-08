'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// Pact widgets: Milestone Timeline, Verdict Card, Pact Ledger (drill-through), Reputation
// Leaderboard (AG Grid + sparklines), PayPal Reconciliation (AG Grid) and Refused Milestones.
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState, type CSSProperties } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { AllCommunityModule, ModuleRegistry, type ColDef, type ICellRendererParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { pactGridTheme } from '../theme';
import { STATUS_COLOR, crossFilterPact, ctxOf, ms, nice, Pill, toneOf, usd, useTableRows, type Row } from './common';

ModuleRegistry.registerModules([AllCommunityModule]);

const defaultColDef: ColDef = { suppressMovable: true };

const AGENT: Record<string, string> = { verifier: 'AI Verifier', arbiter: 'AI Arbiter', human: 'Human reviewer' };
const fmtDate = (v: unknown) => (v ? new Date(v as string).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const fmtDay = (v: unknown) => (v ? new Date(v as string).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const initials = (name: string) =>
  String(name ?? '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
const AVATAR = ['var(--pact-navy)', 'var(--pact-chart-7)', 'var(--pact-chart-6)', 'var(--pact-held)', 'var(--pact-chart-10)', 'var(--pact-released)'];
const avatarColor = (name: string) => AVATAR[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR.length];

// --- 2. Milestone Timeline -----------------------------------------------------------------

export function MilestoneTimelineWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'milestones', ['pactId', 'pactTitle', 'milestoneId', 'position', 'title', 'percent', 'amount', 'status', 'lastVerdict', 'lastConfidence', 'thumbnailUrl', 'attempts', 'seller']);
  const pactRows = useTableRows(params, 'pacts', ['id', 'createdAt', 'status', 'total', 'buyer']);
  const ctx = ctxOf(params);
  const pacts = useMemo(() => {
    const by = new Map<string, Row[]>();
    for (const r of rows ?? []) by.set(r.pactId, [...(by.get(r.pactId) ?? []), r]);
    const info = new Map((pactRows ?? []).map((p) => [p.id, p]));
    // Live pacts first (funded / in progress / disputed), then the most recent.
    const live = (id: string) => ['funded', 'in_progress', 'disputed'].includes(info.get(id)?.status);
    return [...by.entries()]
      .map(([id, list]) => ({ id, title: list[0].pactTitle, seller: list[0].seller, info: info.get(id), ms: [...list].sort((a, b) => a.position - b.position) }))
      .sort((a, b) => Number(live(b.id)) - Number(live(a.id)) || ms(b.info?.createdAt) - ms(a.info?.createdAt));
  }, [rows, pactRows]);
  // With a cross-filter there is one pact; otherwise the most relevant ones (scroll for more).
  const shown = pacts.slice(0, 6);
  return (
    <div className="pw pw-timeline">
      {shown.map((p) => (
        <section key={p.id} className="pw-tl-pact" aria-label={p.title}>
          <div className="pw-tl-meta">
            <div className="pw-tl-title pw-display">{p.title}</div>
            <div className="pw-note pw-truncate">
              {p.info?.buyer ? `${p.info.buyer} → ` : ''}
              {p.seller}
            </div>
            <div className="pw-row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {p.info?.status && (
                <Pill tone={toneOf(p.info.status)} dot>
                  {nice(p.info.status)}
                </Pill>
              )}
              {p.info?.total != null && <span className="pw-display" style={{ fontSize: 15 }}>{usd(p.info.total)}</span>}
            </div>
            <button className="pw-btn" data-variant="link" style={{ alignSelf: 'flex-start', height: 22 }} onClick={() => ctx.openPact(p.id)}>
              Open pact room →
            </button>
          </div>
          <ol className="pw-tl-steps">
            {p.ms.map((m, i) => {
              const c = STATUS_COLOR[m.status] ?? 'var(--pact-line)';
              const filled = ['released', 'approved'].includes(m.status);
              const lineDone = ['released', 'partially_released'].includes(m.status);
              return (
                <li key={m.milestoneId} className="pw-tl-step" style={{ flexGrow: Math.max(1, m.percent) } as CSSProperties}>
                  <div className="pw-tl-node">
                    <motion.button
                      className="pw-tl-dot"
                      data-filled={filled}
                      style={{ '--c': c } as CSSProperties}
                      onClick={() => ctx.openPact(p.id, m.milestoneId)}
                      initial={{ scale: 0.6, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 260, damping: 18, delay: i * 0.06 }}
                      title={`${m.title}: ${nice(m.status)} (open in the pact room)`}
                      aria-label={`${m.title}: ${nice(m.status)}`}
                    >
                      {m.status === 'released' ? '✓' : m.status === 'rejected' ? '✕' : m.status === 'refunded' ? '↺' : m.status === 'partially_released' ? '½' : i + 1}
                    </motion.button>
                    {i < p.ms.length - 1 && <div className="pw-tl-line" style={lineDone ? { background: c } : undefined} />}
                  </div>
                  <div className="pw-tl-card">
                    <div className="pw-tl-card-text">
                      <div className="pw-truncate" style={{ fontWeight: 600 }} title={m.title}>
                        {m.title}
                      </div>
                      <div className="pw-note">
                        {m.percent}% · {usd(m.amount)}
                        {m.attempts > 1 ? ` · ${m.attempts} tries` : ''}
                      </div>
                      <div className="pw-row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                        <Pill tone={toneOf(m.status)}>{nice(m.status)}</Pill>
                        {m.lastConfidence != null && <span className="pw-mono pw-muted">{Math.round(m.lastConfidence * 100)}%</span>}
                      </div>
                    </div>
                    {m.thumbnailUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="pw-tl-thumb" src={`${ctx.apiUrl}${m.thumbnailUrl}`} alt={`Latest evidence for ${m.title}`} />
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
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
    const sorted = [...(rows ?? [])].sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    return focus === 'refused' ? sorted.filter((r) => ['rejected', 'refund'].includes(r.status)) : sorted;
  }, [rows, focus]);
  const [i, setI] = useState(0);
  const idx = Math.min(i, list.length - 1);
  const v = list[idx];
  const [busy, setBusy] = useState(false);
  if (!v) return <div className="pw" />;
  const tone = toneOf(v.status);
  const conf = Math.round(v.confidence * 100);
  return (
    <div className="pw pw-verdict">
      <AnimatePresence mode="wait">
        <motion.div key={v.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }} style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
          <div className="pw-row" style={{ flexWrap: 'wrap', rowGap: 6 }}>
            <Pill tone={tone} dot>
              {nice(v.status)}
            </Pill>
            <span style={{ fontWeight: 600 }}>{AGENT[v.kind] ?? v.kind}</span>
            <span className="pw-conf" title="Model confidence">
              <span className="pw-meter" style={{ color: conf >= 85 ? 'var(--pact-released)' : conf >= 65 ? 'var(--pact-held)' : 'var(--pact-refund)' }}>
                <span style={{ width: `${conf}%` }} />
              </span>
              {conf}%
            </span>
            <span className="pw-spacer" />
            <span className="pw-mono pw-muted pw-hide-narrow">
              {v.model}
              {v.llmMode === 'replay' ? ' · recorded' : ''}
            </span>
          </div>
          <div className="pw-verdict-context pw-truncate" title={`${v.pactTitle} → ${v.milestoneTitle}`}>
            {v.pactTitle} → <b>{v.milestoneTitle}</b> · {fmtDate(v.createdAt)}
          </div>
          <blockquote className="pw-quote" style={{ '--quote': tone === 'refund' ? 'var(--pact-refund)' : tone === 'released' ? 'var(--pact-released)' : 'var(--pact-held)' } as CSSProperties}>
            {v.reasoning}
          </blockquote>
          <div className="pw-verdict-foot">
            <Pill tone={ctx.audit.ok ? 'released' : 'refund'} title={`${ctx.audit.count} entries, head ${ctx.audit.headHash}`}>
              {ctx.audit.ok ? '✓ Chain verified' : '✕ Chain broken'}
            </Pill>
            {v.appealStatus !== 'none' ? (
              <Pill tone="navy">appeal {nice(v.appealStatus)}</Pill>
            ) : (
              <button
                className="pw-btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await ctx.appeal(v.id).finally(() => setBusy(false));
                }}
              >
                {busy ? 'Sending…' : 'Appeal to a human'}
              </button>
            )}
            <button className="pw-btn" data-variant="link" onClick={() => ctx.openPact(v.pactId, String(v.milestoneKey).split(':')[1])}>
              Evidence →
            </button>
            {list.length > 1 && (
              <span className="pw-pager">
                <button className="pw-btn pw-icon-btn" aria-label="Newer decision" disabled={idx === 0} onClick={() => setI(Math.max(0, idx - 1))}>
                  ‹
                </button>
                <span style={{ minWidth: 38, textAlign: 'center' }}>
                  {idx + 1} / {list.length}
                </span>
                <button className="pw-btn pw-icon-btn" aria-label="Older decision" disabled={idx >= list.length - 1} onClick={() => setI(Math.min(list.length - 1, idx + 1))}>
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

// --- Grid cells --------------------------------------------------------------------------------

const StatusCell = (p: ICellRendererParams) => (
  <span className="pw-cell">
    <Pill tone={toneOf(p.value)} dot>
      {nice(p.value)}
    </Pill>
  </span>
);
const PartyCell = (p: ICellRendererParams) => (
  <span className="pw-cell">
    <span className="pw-avatar" style={{ '--c': avatarColor(p.value) } as CSSProperties} aria-hidden>
      {initials(p.value)}
    </span>
    <span className="pw-truncate">{p.value}</span>
  </span>
);
const ProgressCell = (p: ICellRendererParams) => {
  const r = p.data as Row;
  const rel = r.total ? (r.released / r.total) * 100 : 0;
  const held = r.total ? (r.held / r.total) * 100 : 0;
  return (
    <span className="pw-cell" title={`${usd(r.released)} released · ${usd(r.held)} held`}>
      <span style={{ display: 'flex', flex: 1, maxWidth: 110, height: 6, borderRadius: 99, overflow: 'hidden', background: 'var(--pact-paper-2)', gap: 1 }}>
        <span style={{ width: `${rel}%`, background: 'var(--pact-released)' }} />
        <span style={{ width: `${held}%`, background: 'var(--pact-held)' }} />
      </span>
      <span className="pw-mono pw-muted" style={{ width: 34, textAlign: 'right' }}>
        {Math.round(rel)}%
      </span>
    </span>
  );
};
const ModeCell = (p: ICellRendererParams) => (
  <span className="pw-cell">
    <Pill tone={p.value === 'sandbox' ? 'released' : 'held'}>{p.value === 'sandbox' ? 'sandbox' : 'SIMULATED'}</Pill>
  </span>
);

// --- Pact Ledger: grid with drill-through ----------------------------------------------------

export function PactLedgerWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'pacts', ['id', 'title', 'status', 'buyer', 'seller', 'total', 'held', 'released', 'refunded', 'paymentMode', 'createdAt'], { crossFilter: 'none' });
  const ctx = ctxOf(params);
  const [selected, setSelected] = useState<string | null>(null);
  const cols = useMemo<ColDef[]>(
    () => [
      { field: 'title', headerName: 'Pact', flex: 2, minWidth: 170, cellStyle: { fontWeight: 600 } },
      { field: 'status', headerName: 'Status', cellRenderer: StatusCell, width: 140 },
      { field: 'seller', headerName: 'Seller', cellRenderer: PartyCell, flex: 1.3, minWidth: 150 },
      { field: 'total', headerName: 'Total', valueFormatter: (p) => usd(p.value), width: 96, type: 'rightAligned', cellClass: 'pw-num' },
      { headerName: 'Released', cellRenderer: ProgressCell, width: 160, sortable: false },
      { field: 'paymentMode', headerName: 'PayPal', cellRenderer: ModeCell, width: 118 },
      { field: 'createdAt', headerName: 'Created', width: 124, valueFormatter: (p) => fmtDay(p.value), sort: 'desc' },
    ],
    [],
  );
  return (
    <div className="pw pw-flush">
      <div className="pw-intro">
        <span className="pw-note">Click a row to filter the whole page to that pact. Double-click opens its pact room.</span>
        {selected && (
          <button className="pw-btn" style={{ height: 24 }} onClick={() => (setSelected(null), crossFilterPact(params, null))}>
            Clear filter ✕
          </button>
        )}
      </div>
      <div className="pw-gridwrap">
        <AgGridReact
          theme={pactGridTheme}
          defaultColDef={defaultColDef}
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
          rowHeight={44}
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
  if (pts.length < 2)
    return (
      <span className="pw-cell">
        <span className="pw-note">no history yet</span>
      </span>
    );
  const min = Math.min(...pts) - 2;
  const max = Math.max(...pts) + 2;
  const w = 76;
  const h = 24;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * w, h - ((v - min) / (max - min)) * h]);
  const path = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const up = pts.at(-1)! >= pts[0];
  const c = up ? 'var(--pact-released)' : 'var(--pact-refund)';
  return (
    <span className="pw-cell">
      <svg width={w} height={h} style={{ overflow: 'visible' }} aria-label={`trend ${up ? 'up' : 'down'}`}>
        <path d={`${path} L${w},${h} L0,${h} Z`} fill={c} opacity="0.1" />
        <path d={path} fill="none" stroke={c} strokeWidth="1.8" strokeLinejoin="round" />
        <circle cx={xy.at(-1)![0]} cy={xy.at(-1)![1]} r="2.6" fill={c} />
      </svg>
      <span className="pw-mono" style={{ color: c }}>
        {up ? '▲' : '▼'} {Math.abs(pts.at(-1)! - pts[0]).toFixed(0)}
      </span>
    </span>
  );
};
const scoreColor = (v: number) => (v >= 88 ? 'var(--pact-released)' : v >= 75 ? 'var(--pact-navy)' : v >= 60 ? 'var(--pact-held)' : 'var(--pact-refund)');
const ScoreCell = (p: ICellRendererParams) => (
  <span className="pw-cell" title={`Score ${Number(p.value).toFixed(1)} · ${Math.round((p.data?.confidence ?? 0) * 100)}% backed by real history (the rest is the prior)`}>
    <span className="pw-display" style={{ fontSize: 18, width: 30 }}>
      {Number(p.value).toFixed(0)}
    </span>
    <span className="pw-meter" style={{ width: 64, color: scoreColor(p.value) }}>
      <span style={{ width: `${p.value}%` }} />
    </span>
  </span>
);
const RankCell = (p: ICellRendererParams) => {
  const n = (p.node?.rowIndex ?? 0) + 1;
  return (
    <span className="pw-cell">
      <span className="pw-rank" data-top={n === 1}>
        {n === 1 ? '★' : n}
      </span>
    </span>
  );
};
const pct = (p: { value: number }) => `${Math.round((p.value ?? 0) * 100)}%`;

export function ReputationLeaderboardWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'reputation', ['name', 'kind', 'score', 'tier', 'completionRate', 'onTimeRate', 'disputeRate', 'refundRate', 'confidence', 'milestones', 'trend']);
  const cols = useMemo<ColDef[]>(
    () => [
      { headerName: '#', cellRenderer: RankCell, width: 56, sortable: false },
      { field: 'name', headerName: 'Party', cellRenderer: PartyCell, flex: 1.4, minWidth: 150 },
      { field: 'score', headerName: 'Score', cellRenderer: ScoreCell, width: 120, sort: 'desc', headerTooltip: 'Hover a score to see how much of it is backed by real history' },
      { field: 'trend', headerName: 'Trend', cellRenderer: Sparkline, width: 136, sortable: false },
      { field: 'tier', headerName: 'Tier', cellRenderer: StatusCell, width: 110 },
      { field: 'completionRate', headerName: 'Completion', valueFormatter: pct, width: 114, type: 'rightAligned' },
      { field: 'onTimeRate', headerName: 'On time', valueFormatter: pct, width: 90, type: 'rightAligned' },
      { field: 'disputeRate', headerName: 'Disputes', valueFormatter: pct, flex: 0.6, minWidth: 92, type: 'rightAligned' },
    ],
    [],
  );
  return (
    <div className="pw pw-flush">
      <div className="pw-intro">
        <span className="pw-note">Bayesian-smoothed: a new party starts at the prior (83.5), not at 0 or 100, and moves as real milestones settle.</span>
      </div>
      <div className="pw-gridwrap">
        <AgGridReact theme={pactGridTheme} defaultColDef={defaultColDef} rowData={(rows ?? []).filter((r) => r.kind !== undefined)} columnDefs={cols} rowHeight={48} tooltipShowDelay={300} />
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
      { field: 'date', headerName: 'Date', width: 150, valueFormatter: (p) => fmtDate(p.value), sort: 'desc' },
      { field: 'id', headerName: 'PayPal transaction', flex: 1, minWidth: 170, cellClass: 'pw-mono' },
      { field: 'eventCode', headerName: 'T-code', width: 88 },
      { field: 'amount', headerName: 'Amount', width: 100, valueFormatter: (p) => usd(p.value), type: 'rightAligned' },
      { field: 'note', headerName: 'Note', flex: 1.3, minWidth: 160, tooltip: (p: any) => p.data?.note },
      {
        field: 'matched',
        headerName: 'PACT match',
        width: 130,
        cellRenderer: (p: ICellRendererParams) => (
          <span className="pw-cell">
            <Pill tone={p.value ? 'released' : 'held'}>{p.value ? `✓ ${p.data.pactKind}` : 'unmatched'}</Pill>
          </span>
        ),
      },
    ],
    [],
  );
  const sandbox = ctx.paymentMode === 'sandbox';
  return (
    <div className="pw pw-flush">
      <div className="pw-intro" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div className="pw-row" style={{ flexWrap: 'wrap', gap: '8px 16px' }}>
          {rec?.balances.map((b: any) => (
            <span key={b.currency} className="pw-row" style={{ gap: 6 }}>
              <span className="pw-eyebrow">Balance</span>
              <span className="pw-display" style={{ fontSize: 20 }}>
                {usd(b.total)}
              </span>
              <span className="pw-note">{b.currency}</span>
            </span>
          ))}
          <span className="pw-note">as of {rec ? fmtDate(rec.asOf) : '—'}</span>
          <span className="pw-spacer" />
          {rec && rec.pending > 0 && <Pill tone="held">{rec.pending} not yet in Transaction Search</Pill>}
          <Pill tone={sandbox ? 'released' : 'held'} dot>
            {sandbox ? 'PayPal sandbox' : 'SIMULATED ledger'}
          </Pill>
        </div>
        {rec?.caveat && <div className="pw-note">{rec.caveat}</div>}
        {rec?.errors.map((e) => (
          <div key={e} className="pw-note" style={{ color: 'var(--pact-refund)' }}>
            {e}
          </div>
        ))}
      </div>
      <div className="pw-gridwrap">
        <AgGridReact theme={pactGridTheme} defaultColDef={defaultColDef} rowData={(rows ?? []).filter((r) => r.id !== '—')} columnDefs={cols} rowHeight={42} tooltipShowDelay={300} />
      </div>
    </div>
  );
}

// --- Refused milestones (added live by the PACT Auditor) ---------------------------------------

const ReasonCell = (p: ICellRendererParams) => <span className="pw-wrap-cell">{p.value}</span>;

export function RefusedListWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'verdicts', ['id', 'pactId', 'pactTitle', 'milestoneTitle', 'milestoneKey', 'kind', 'status', 'confidence', 'reasoning', 'appealStatus', 'createdAt']);
  const ctx = ctxOf(params);
  const [since] = useState(() => Date.now() - 7 * 864e5);
  const refused = (rows ?? []).filter((r) => ['rejected', 'refund'].includes(r.status) && ms(r.createdAt) >= since);
  const cols = useMemo<ColDef[]>(
    () => [
      { field: 'createdAt', headerName: 'When', width: 132, valueFormatter: (p) => fmtDate(p.value), sort: 'desc' },
      { field: 'pactTitle', headerName: 'Pact', flex: 1, minWidth: 160, cellStyle: { fontWeight: 600 } },
      { field: 'milestoneTitle', headerName: 'Milestone', flex: 0.9, minWidth: 140 },
      { field: 'kind', headerName: 'By', width: 120, valueFormatter: (p) => AGENT[p.value] ?? p.value },
      { field: 'confidence', headerName: 'Conf.', width: 80, valueFormatter: (p) => `${Math.round(p.value * 100)}%`, type: 'rightAligned' },
      { field: 'reasoning', headerName: 'Why', flex: 2.6, minWidth: 260, cellRenderer: ReasonCell, tooltip: (p: any) => p.data?.reasoning },
      { field: 'appealStatus', headerName: 'Appeal', width: 110, cellRenderer: (p: ICellRendererParams) => (p.value === 'none' ? <span className="pw-cell pw-note">none</span> : StatusCell(p)) },
    ],
    [],
  );
  return (
    <div className="pw pw-flush">
      <div className="pw-intro">
        <Pill tone="refund" dot>
          {refused.length} refusal{refused.length === 1 ? '' : 's'} · last 7 days
        </Pill>
        <span className="pw-note">Double-click a row to open its evidence. Every refusal can be appealed to a human.</span>
      </div>
      <div className="pw-gridwrap">
        <AgGridReact theme={pactGridTheme} defaultColDef={defaultColDef} rowData={refused} columnDefs={cols} rowHeight={60} onRowDoubleClicked={(e) => e.data && ctx.openPact(e.data.pactId, String(e.data.milestoneKey).split(':')[1])} tooltipShowDelay={200} />
      </div>
    </div>
  );
}
