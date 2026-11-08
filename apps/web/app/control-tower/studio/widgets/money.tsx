'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// Money widgets: Escrow Vault, Dispute & Refund gauges, Money Flow (Sankey).
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { ctxOf, Pill, usd, useSize, useTableRows } from './common';

function Counter({ value, className, style }: { value: number; className?: string; style?: React.CSSProperties }) {
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => usd(Math.round(v * 100) / 100));
  useEffect(() => {
    const c = animate(mv, value, { duration: 0.9, ease: [0.2, 0.8, 0.2, 1] });
    return c.stop;
  }, [mv, value]);
  return (
    <motion.span className={`pw-display ${className ?? ''}`} style={style}>
      {text}
    </motion.span>
  );
}

// --- 1. Escrow Vault ---------------------------------------------------------------------

export function EscrowVaultWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'pacts', ['held', 'released', 'refunded', 'voided', 'status']);
  const ctx = ctxOf(params);
  const t = useMemo(() => {
    const s = { held: 0, released: 0, refunded: 0, voided: 0, active: 0, total: 0 };
    for (const r of rows ?? []) {
      s.held += r.held ?? 0;
      s.released += r.released ?? 0;
      s.refunded += r.refunded ?? 0;
      s.voided += r.voided ?? 0;
      s.total++;
      if (['funded', 'in_progress', 'disputed'].includes(r.status)) s.active++;
    }
    return s;
  }, [rows]);
  const sum = Math.max(1, t.held + t.released + t.refunded + t.voided);
  const parts = [
    { k: 'Held by PayPal', v: t.held, c: 'var(--pact-held)' },
    { k: 'Released', v: t.released, c: 'var(--pact-released)' },
    { k: 'Refunded', v: t.refunded, c: 'var(--pact-refund)' },
    { k: 'Voided', v: t.voided, c: 'var(--pact-void)' },
  ];
  const sandbox = ctx?.paymentMode === 'sandbox';
  return (
    <div className="pw">
      <div className="pw-vault-top">
        <div style={{ minWidth: 0 }}>
          <div className="pw-eyebrow">In escrow now</div>
          <Counter value={t.held} className="pw-vault-amount" style={{ display: 'block' }} />
          <div className="pw-note" style={{ marginTop: 8 }}>
            {t.active} active of {t.total} pact{t.total === 1 ? '' : 's'} · authorized, not charged
          </div>
        </div>
        <Pill tone={sandbox ? 'released' : 'held'} dot>
          {sandbox ? 'PayPal sandbox' : 'SIMULATED PayPal'}
        </Pill>
      </div>
      <div className="pw-split" role="img" aria-label={parts.map((p) => `${p.k} ${usd(p.v)}`).join(', ')}>
        {parts.map((p) =>
          p.v > 0 ? <motion.div key={p.k} initial={false} animate={{ width: `${(p.v / sum) * 100}%` }} transition={{ type: 'spring', stiffness: 110, damping: 20 }} style={{ background: p.c }} title={`${p.k}: ${usd(p.v)}`} /> : null,
        )}
      </div>
      <div className="pw-legend">
        {parts.slice(1).map((p) => (
          <div key={p.k} className="pw-legend-item" style={{ '--c': p.c } as React.CSSProperties}>
            <div className="pw-note">{p.k}</div>
            <Counter value={p.v} />
          </div>
        ))}
      </div>
    </div>
  );
}

// --- 6. Dispute & refund gauges ------------------------------------------------------------

function Gauge({ value, label, color, hint }: { value: number; label: string; color: string; hint: string }) {
  // A 270° ring: easier to read at a glance than a half-dial, and the number sits inside it.
  const r = 42;
  const len = 2 * Math.PI * r * 0.75;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="pw-gauge" title={`${label}: ${Math.round(v * 100)}% ${hint}`}>
      <div className="pw-gauge-ring">
        <svg viewBox="0 0 100 100" role="img" aria-label={`${label} ${Math.round(v * 100)}%`}>
          <g transform="rotate(135 50 50)">
            <circle cx="50" cy="50" r={r} fill="none" stroke="var(--pact-paper-2)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${len} 999`} />
            <motion.circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${len} 999`} initial={{ strokeDashoffset: len }} animate={{ strokeDashoffset: len * (1 - v) }} transition={{ duration: 1, ease: [0.2, 0.8, 0.2, 1] }} />
          </g>
        </svg>
        <span className="pw-gauge-value pw-display">{Math.round(v * 100)}%</span>
      </div>
      <div className="pw-gauge-label">{label}</div>
      <div className="pw-gauge-hint">{hint}</div>
    </div>
  );
}

export function RateGaugesWidget(params: AgWidgetParams<any>) {
  const ms = useTableRows(params, 'milestones', ['status', 'key']);
  const vds = useTableRows(params, 'verdicts', ['kind', 'milestoneKey', 'refused']);
  const { dispute, refund, settled, refusedShare, verdicts } = useMemo(() => {
    const settledMs = (ms ?? []).filter((m) => ['released', 'partially_released', 'refunded'].includes(m.status));
    const disputed = new Set((vds ?? []).filter((v) => v.kind === 'arbiter').map((v) => v.milestoneKey));
    const all = vds ?? [];
    return {
      settled: settledMs.length,
      verdicts: all.length,
      dispute: settledMs.length ? disputed.size / settledMs.length : 0,
      refund: settledMs.length ? settledMs.filter((m) => m.status !== 'released').length / settledMs.length : 0,
      refusedShare: all.length ? all.filter((v) => v.refused).length / all.length : 0,
    };
  }, [ms, vds]);
  return (
    <div className="pw">
      <div className="pw-gauges">
        <Gauge value={dispute} label="Dispute rate" color="var(--pact-refund)" hint={`of ${settled} settled milestones went to the Arbiter`} />
        <Gauge value={refund} label="Refund rate" color="var(--pact-held)" hint="settled with a full or partial refund" />
        <Gauge value={refusedShare} label="Refused by AI" color="var(--pact-navy)" hint={`of ${verdicts} AI decisions were refusals`} />
      </div>
    </div>
  );
}

// --- 5. Money Flow (Sankey, drawn in SVG) ---------------------------------------------------
// AG Charts' Sankey series is an AG Charts Enterprise feature that needs its own licence in a
// custom widget, so PACT draws its own: three columns (payers → escrow → destinations), laid out
// in real pixels from the widget's measured size so labels never get scaled down.

const flowColor = (t: string) =>
  /Refund/.test(t) ? 'var(--pact-refund)' : /Void/.test(t) ? 'var(--pact-void)' : /held/i.test(t) ? 'var(--pact-held)' : /Subcontract/.test(t) ? 'var(--pact-chart-5)' : /Seller/.test(t) ? 'var(--pact-released)' : 'var(--pact-navy)';
const shortName = (n: string) => n.replace(' (PayPal authorization)', '');

export function MoneyFlowWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'flows', ['source', 'target', 'value'], { crossFilter: 'none' });
  const [hover, setHover] = useState<string | null>(null);
  const [ref, { width: W_, height: H_ }] = useSize<HTMLDivElement>();
  const layout = useMemo(() => {
    const flows = (rows ?? []).filter((r) => r.value > 0);
    if (!flows.length || W_ < 50 || H_ < 50) return null;
    const padTop = 30; // room for the escrow label above the middle column
    const padY = 8;
    const nodeW = 10;
    const sources = [...new Set(flows.map((f) => f.source))].filter((s) => !flows.some((f) => f.target === s));
    const middles = [...new Set(flows.map((f) => f.source))].filter((s) => !sources.includes(s));
    const targets = [...new Set(flows.map((f) => f.target))].filter((t) => !middles.includes(t));
    const cols = [sources, middles, targets].filter((c) => c.length);
    const nodeValue = (n: string) => Math.max(flows.filter((f) => f.target === n).reduce((a, f) => a + f.value, 0), flows.filter((f) => f.source === n).reduce((a, f) => a + f.value, 0));
    const gap = 18;
    const maxCount = Math.max(...cols.map((c) => c.length));
    const maxCol = Math.max(...cols.map((c) => c.reduce((a, n) => a + nodeValue(n), 0)));
    const scale = (H_ - padTop - padY - gap * (maxCount - 1)) / maxCol;
    // Room for the labels: sources label to the right, targets to the left, so columns can span the width.
    const nodes: Record<string, { x: number; y: number; h: number; col: number; out: number; in: number; value: number }> = {};
    cols.forEach((c, ci) => {
      const total = c.reduce((a, n) => a + nodeValue(n), 0) * scale + gap * (c.length - 1);
      let y = padTop + (H_ - padTop - padY - total) / 2;
      const x = cols.length === 1 ? 0 : (ci * (W_ - nodeW)) / (cols.length - 1);
      for (const n of c) {
        const h = Math.max(4, nodeValue(n) * scale);
        nodes[n] = { x, y, h, col: ci, out: 0, in: 0, value: nodeValue(n) };
        y += h + gap;
      }
    });
    const links = flows.map((f) => {
      const s = nodes[f.source];
      const t = nodes[f.target];
      const w = Math.max(2, f.value * scale);
      const y0 = s.y + s.out + w / 2;
      const y1 = t.y + t.in + w / 2;
      s.out += w;
      t.in += w;
      const x0 = s.x + nodeW;
      const x1 = t.x;
      const mx = (x0 + x1) / 2;
      return { id: `${f.source}→${f.target}`, f, w, x0, x1, d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}` };
    });
    return { nodes, links, nodeW, lastCol: cols.length - 1 };
  }, [rows, W_, H_]);
  return (
    <div className="pw pw-flow">
      <div ref={ref} className="pw-flow-canvas">
        {layout && (
          <svg role="img" aria-label="Money flow from buyers through PayPal escrow to sellers, refunds and voids">
            <defs>
              {layout.links.map((l, i) => (
                <linearGradient key={l.id} id={`pw-flow-${i}`} gradientUnits="userSpaceOnUse" x1={l.x0} x2={l.x1} y1="0" y2="0">
                  <stop offset="0" stopColor={flowColor(l.f.source)} />
                  <stop offset="1" stopColor={flowColor(l.f.target)} />
                </linearGradient>
              ))}
            </defs>
            {layout.links.map((l, i) => (
              <motion.path
                key={l.id}
                d={l.d}
                fill="none"
                stroke={`url(#pw-flow-${i})`}
                strokeOpacity={hover && hover !== l.id ? 0.1 : 0.32}
                strokeWidth={l.w}
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.9, delay: i * 0.06 }}
                onMouseEnter={() => setHover(l.id)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'default', transition: 'stroke-opacity .15s' }}
              >
                <title>{`${shortName(l.f.source)} → ${shortName(l.f.target)}: ${usd(l.f.value)}`}</title>
              </motion.path>
            ))}
            {Object.entries(layout.nodes).map(([name, n]) => {
              // Sources: label to the right; destinations: to the left; the middle node: above.
              const mid = n.col !== 0 && n.col !== layout.lastCol;
              const right = n.col === 0;
              const x = mid ? n.x + layout.nodeW / 2 : right ? n.x + layout.nodeW + 8 : n.x - 8;
              const y = mid ? n.y - 12 : n.y + n.h / 2 - 7;
              const anchor = mid ? 'middle' : right ? 'start' : 'end';
              return (
                <g key={name}>
                  <rect x={n.x} y={n.y} width={layout.nodeW} height={n.h} rx={3} fill={flowColor(name)} />
                  <text x={x} y={y} textAnchor={anchor} className="pw-flow-label" style={{ paintOrder: 'stroke', stroke: 'var(--pact-surface)', strokeWidth: 4 }}>
                    {shortName(name)}
                    {mid && <tspan className="pw-flow-sub"> · {usd(n.value)}</tspan>}
                  </text>
                  {!mid && (
                  <text x={x} y={y + 14} textAnchor={anchor} className="pw-flow-sub" style={{ paintOrder: 'stroke', stroke: 'var(--pact-surface)', strokeWidth: 4 }}>
                    {usd(n.value)}
                  </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
