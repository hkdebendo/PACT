'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// Money widgets: Escrow Vault, Dispute & Refund gauges, Money Flow (Sankey).
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { ctxOf, usd, useTableRows, W } from './common';

function Counter({ value, color, size = 30 }: { value: number; color: string; size?: number }) {
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => usd(Math.round(v * 100) / 100));
  useEffect(() => {
    const c = animate(mv, value, { duration: 0.9, ease: [0.2, 0.8, 0.2, 1] });
    return c.stop;
  }, [mv, value]);
  return <motion.span style={{ ...W.display, fontSize: size, color, lineHeight: 1 }}>{text}</motion.span>;
}

// --- 1. Escrow Vault ---------------------------------------------------------------------

export function EscrowVaultWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'pacts', ['held', 'released', 'refunded', 'voided', 'status']);
  const ctx = ctxOf(params);
  const t = useMemo(() => {
    const s = { held: 0, released: 0, refunded: 0, voided: 0, active: 0 };
    for (const r of rows ?? []) {
      s.held += r.held ?? 0;
      s.released += r.released ?? 0;
      s.refunded += r.refunded ?? 0;
      s.voided += r.voided ?? 0;
      if (['funded', 'in_progress', 'disputed'].includes(r.status)) s.active++;
    }
    return s;
  }, [rows]);
  const total = Math.max(1, t.held + t.released + t.refunded + t.voided);
  const parts = [
    { k: 'Held by PayPal', v: t.held, c: 'var(--pact-held)' },
    { k: 'Released', v: t.released, c: 'var(--pact-released)' },
    { k: 'Refunded', v: t.refunded, c: 'var(--pact-refund)' },
    { k: 'Voided', v: t.voided, c: 'var(--pact-void)' },
  ];
  return (
    <div style={{ ...W.root, gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={W.eyebrow}>In escrow now</div>
          <Counter value={t.held} color="var(--pact-held)" size={40} />
          <div style={{ fontSize: 12, color: 'var(--pact-muted)', marginTop: 6 }}>{t.active} active pact{t.active === 1 ? '' : 's'} · authorized, not charged</div>
        </div>
        <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, background: ctx?.paymentMode === 'sandbox' ? 'var(--pact-released-soft)' : 'var(--pact-held-soft)', color: ctx?.paymentMode === 'sandbox' ? 'var(--pact-released)' : 'var(--pact-held)', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {ctx?.paymentMode === 'sandbox' ? 'PayPal sandbox' : 'SIMULATED PayPal'}
        </span>
      </div>
      <div style={{ display: 'flex', height: 14, borderRadius: 999, overflow: 'hidden', background: 'var(--pact-paper-2)' }} role="img" aria-label="Escrow split">
        {parts.map((p) => (
          <motion.div key={p.k} initial={false} animate={{ width: `${(p.v / total) * 100}%` }} transition={{ type: 'spring', stiffness: 110, damping: 20 }} style={{ background: p.c }} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10 }}>
        {parts.slice(1).map((p) => (
          <div key={p.k} style={{ borderTop: `2px solid ${p.c}`, paddingTop: 6 }}>
            <div style={{ fontSize: 11.5, color: 'var(--pact-muted)' }}>{p.k}</div>
            <Counter value={p.v} color="var(--pact-ink)" size={20} />
          </div>
        ))}
      </div>
    </div>
  );
}

// --- 6. Dispute & refund gauges ------------------------------------------------------------

function Gauge({ value, label, color, hint }: { value: number; label: string; color: string; hint: string }) {
  const r = 38;
  const c = Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 0 }} title={hint}>
      <svg viewBox="0 0 100 58" style={{ width: '100%', maxWidth: 170 }} aria-label={`${label} ${Math.round(v * 100)}%`} role="img">
        <path d="M12 50 A38 38 0 0 1 88 50" fill="none" stroke="var(--pact-paper-2)" strokeWidth="9" strokeLinecap="round" />
        <motion.path d="M12 50 A38 38 0 0 1 88 50" fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - v) }} transition={{ duration: 1 }} />
        <text x="50" y="47" textAnchor="middle" style={{ ...W.display, fontSize: 19, fill: 'var(--pact-ink)' }}>
          {Math.round(v * 100)}%
        </text>
      </svg>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 2 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--pact-muted)', textAlign: 'center' }}>{hint}</div>
    </div>
  );
}

export function RateGaugesWidget(params: AgWidgetParams<any>) {
  const ms = useTableRows(params, 'milestones', ['status', 'key']);
  const vds = useTableRows(params, 'verdicts', ['kind', 'milestoneKey', 'refused']);
  const { dispute, refund, settled, refusedShare } = useMemo(() => {
    const settledMs = (ms ?? []).filter((m) => ['released', 'partially_released', 'refunded'].includes(m.status));
    const disputed = new Set((vds ?? []).filter((v) => v.kind === 'arbiter').map((v) => v.milestoneKey));
    const all = vds ?? [];
    return {
      settled: settledMs.length,
      dispute: settledMs.length ? disputed.size / settledMs.length : 0,
      refund: settledMs.length ? settledMs.filter((m) => m.status !== 'released').length / settledMs.length : 0,
      refusedShare: all.length ? all.filter((v) => v.refused).length / all.length : 0,
    };
  }, [ms, vds]);
  return (
    <div style={{ ...W.root, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Gauge value={dispute} label="Dispute rate" color="var(--pact-refund)" hint={`of ${settled} settled milestones went to the Arbiter`} />
      <Gauge value={refund} label="Refund rate" color="var(--pact-held)" hint="settled with a full or partial refund" />
      <Gauge value={refusedShare} label="Refused by AI" color="var(--pact-navy)" hint="of all verdicts were rejections or refunds" />
    </div>
  );
}

// --- 5. Money Flow (Sankey, drawn in SVG) ---------------------------------------------------
// AG Charts' Sankey series is an AG Charts Enterprise feature that needs its own licence in a
// custom widget, so PACT draws its own: three columns (payers → escrow → destinations).

export function MoneyFlowWidget(params: AgWidgetParams<any>) {
  const rows = useTableRows(params, 'flows', ['source', 'target', 'value'], { crossFilter: 'none' });
  const [hover, setHover] = useState<string | null>(null);
  const layout = useMemo(() => {
    const flows = (rows ?? []).filter((r) => r.value > 0);
    if (!flows.length) return null;
    const W_ = 640;
    const H_ = 300;
    const pad = 22;
    const nodeW = 14;
    const sources = [...new Set(flows.map((f) => f.source))].filter((s) => !flows.some((f) => f.target === s));
    const middles = [...new Set(flows.map((f) => f.source))].filter((s) => !sources.includes(s));
    const targets = [...new Set(flows.map((f) => f.target))].filter((t) => !middles.includes(t));
    const cols = [sources, middles.length ? middles : [], targets].filter((c) => c.length);
    const nodeValue = (n: string) => Math.max(flows.filter((f) => f.target === n).reduce((a, f) => a + f.value, 0), flows.filter((f) => f.source === n).reduce((a, f) => a + f.value, 0));
    const maxCol = Math.max(...cols.map((c) => c.reduce((a, n) => a + nodeValue(n), 0)));
    const gap = 14;
    const scale = (H_ - pad * 2 - gap * (Math.max(...cols.map((c) => c.length)) - 1)) / maxCol;
    const nodes: Record<string, { x: number; y: number; h: number; col: number; out: number; in: number; value: number }> = {};
    cols.forEach((c, ci) => {
      const total = c.reduce((a, n) => a + nodeValue(n), 0) * scale + gap * (c.length - 1);
      let y = (H_ - total) / 2;
      const x = cols.length === 1 ? pad : pad + (ci * (W_ - pad * 2 - nodeW)) / (cols.length - 1);
      for (const n of c) {
        const h = Math.max(3, nodeValue(n) * scale);
        nodes[n] = { x, y, h, col: ci, out: 0, in: 0, value: nodeValue(n) };
        y += h + gap;
      }
    });
    const links = flows.map((f) => {
      const s = nodes[f.source];
      const t = nodes[f.target];
      const w = Math.max(1.5, f.value * scale);
      const y0 = s.y + s.out + w / 2;
      const y1 = t.y + t.in + w / 2;
      s.out += w;
      t.in += w;
      const x0 = s.x + nodeW;
      const x1 = t.x;
      const mx = (x0 + x1) / 2;
      return { id: `${f.source}→${f.target}`, f, w, d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}` };
    });
    return { W_, H_, nodes, links, nodeW };
  }, [rows]);
  if (!layout) return <div style={W.root} />;
  const color = (t: string) => (/Refund/.test(t) ? 'var(--pact-refund)' : /Void/.test(t) ? 'var(--pact-void)' : /held/i.test(t) ? 'var(--pact-held)' : /Subcontract/.test(t) ? 'var(--pact-chart-5)' : /Seller/.test(t) ? 'var(--pact-released)' : 'var(--pact-navy)');
  return (
    <div style={W.root}>
      <svg viewBox={`0 0 ${layout.W_} ${layout.H_}`} style={{ width: '100%', height: '100%' }} role="img" aria-label="Money flow from buyers through escrow">
        {layout.links.map((l, i) => (
          <motion.path
            key={l.id}
            d={l.d}
            fill="none"
            stroke={color(l.f.target)}
            strokeOpacity={hover && hover !== l.id ? 0.12 : 0.38}
            strokeWidth={l.w}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, delay: i * 0.08 }}
            onMouseEnter={() => setHover(l.id)}
            onMouseLeave={() => setHover(null)}
          >
            <title>{`${l.f.source} → ${l.f.target}: ${usd(l.f.value)}`}</title>
          </motion.path>
        ))}
        {Object.entries(layout.nodes).map(([name, n]) => {
          const lastCol = Math.max(...Object.values(layout.nodes).map((x) => x.col));
          // First column: label to the right; last column: label to the left; middle: above the bar.
          const pos =
            n.col === 0
              ? { x: n.x + layout.nodeW + 8, y: n.y + n.h / 2, anchor: 'start' as const, dy: '0.35em' }
              : n.col === lastCol
                ? { x: n.x - 8, y: n.y + n.h / 2, anchor: 'end' as const, dy: '0.35em' }
                : { x: n.x + layout.nodeW / 2, y: Math.max(12, n.y - 6), anchor: 'middle' as const, dy: '0' };
          return (
            <g key={name}>
              <rect x={n.x} y={n.y} width={layout.nodeW} height={n.h} rx={3} fill={color(name)} />
              <text x={pos.x} y={pos.y} dy={pos.dy} textAnchor={pos.anchor} style={{ fontSize: 12, fill: 'var(--pact-ink)', fontFamily: 'var(--pact-font)', paintOrder: 'stroke', stroke: 'var(--pact-surface)', strokeWidth: 3 }}>
                {name} · {usd(n.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
