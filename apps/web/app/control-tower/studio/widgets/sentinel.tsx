'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// Anomaly Radar: the live findings of the PACT Sentinel rules engine (GET /api/sentinel/scan).
// Works with no model at all: the rules are deterministic. When the PACT Sentinel agent runs, it
// writes its briefing headline and the rule to focus on into this widget's format
// (format.style.headline / format.style.focus), so the dashboard keeps what the agent found.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type CSSProperties } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { crossFilterPact, ctxOf, Pill, usd } from './common';

export interface SentinelAnomaly {
  id: string;
  rule: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  metric: { label: string; value: number; baseline: number | null; unit: 'usd' | 'pct' | 'count' | 'hours' };
  pactIds: string[];
  amount: number | null;
  chart: { title: string; widgetType: string; instructions: string } | null;
}
export interface SentinelScan {
  asOf: string;
  status: 'clear' | 'warning' | 'critical';
  scanned: { pacts: number; milestones: number; verdicts: number; payments: number };
  rules: { id: string; label: string; triggered: number }[];
  anomalies: SentinelAnomaly[];
}

export async function fetchScan(apiUrl: string, signal?: AbortSignal): Promise<SentinelScan> {
  const res = await fetch(`${apiUrl}/api/sentinel/scan`, { signal });
  if (!res.ok) throw new Error(`Sentinel scan failed: HTTP ${res.status}`);
  return res.json();
}

const SEV = {
  critical: { c: 'var(--pact-refund)', tone: 'refund' as const, label: 'Critical' },
  warning: { c: 'var(--pact-held)', tone: 'held' as const, label: 'Warning' },
  info: { c: 'var(--pact-navy)', tone: 'navy' as const, label: 'Info' },
};
const fmt = (v: number, unit: SentinelAnomaly['metric']['unit']) => (unit === 'usd' ? usd(v) : unit === 'pct' ? `${Math.round(v * 100)}%` : unit === 'hours' ? `${v} h` : String(v));

function Compare({ m, color }: { m: SentinelAnomaly['metric']; color: string }) {
  if (m.baseline == null) return null;
  const max = Math.max(m.value, m.baseline, 1e-9);
  return (
    <div className="pw-sn-compare" aria-label={`${m.label}: ${fmt(m.value, m.unit)} against a baseline of ${fmt(m.baseline, m.unit)}`}>
      <span className="pw-note">{m.label}</span>
      <div className="pw-sn-bar">
        <motion.span initial={{ width: 0 }} animate={{ width: `${(m.value / max) * 100}%` }} transition={{ duration: 0.7 }} style={{ background: color }} />
      </div>
      <b className="pw-mono">{fmt(m.value, m.unit)}</b>
      <span className="pw-note">baseline</span>
      <div className="pw-sn-bar">
        <motion.span initial={{ width: 0 }} animate={{ width: `${(m.baseline / max) * 100}%` }} transition={{ duration: 0.7 }} style={{ background: 'var(--pact-void)' }} />
      </div>
      <span className="pw-mono pw-muted">{fmt(m.baseline, m.unit)}</span>
    </div>
  );
}

function RadarMark({ status }: { status: SentinelScan['status'] }) {
  const c = status === 'critical' ? 'var(--pact-refund)' : status === 'warning' ? 'var(--pact-held)' : 'var(--pact-released)';
  return (
    <span className="pw-sn-mark" style={{ '--c': c } as CSSProperties} aria-hidden>
      <svg viewBox="0 0 40 40" width="40" height="40">
        <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeOpacity=".25" />
        <circle cx="20" cy="20" r="11" fill="none" stroke="currentColor" strokeOpacity=".25" />
        <circle cx="20" cy="20" r="3" fill="currentColor" />
      </svg>
      <span className="pw-sn-sweep" />
    </span>
  );
}

export function AnomalyRadarWidget(params: AgWidgetParams<any>) {
  const ctx = ctxOf(params);
  const style = (params.format as any)?.style ?? {};
  const [scan, setScan] = useState<SentinelScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asOf = ctx?.asOf;
  useEffect(() => {
    if (!ctx) return;
    const ac = new AbortController();
    fetchScan(ctx.apiUrl, ac.signal)
      .then((s) => (setScan(s), setError(null)))
      .catch((e) => !ac.signal.aborted && setError(String(e.message ?? e)));
    return () => ac.abort();
    // Re-scan whenever the live feed refreshes the ledger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf]);

  if (error)
    return (
      <div className="pw">
        <div className="pw-note" style={{ color: 'var(--pact-refund)' }}>
          {error}
        </div>
      </div>
    );
  if (!scan) return <div className="pw" />;
  const focus = style.focus as string | undefined;
  const list = [...scan.anomalies].sort((a, b) => Number(b.rule === focus) - Number(a.rule === focus));
  const critical = scan.anomalies.filter((a) => a.severity === 'critical').length;
  return (
    <div className="pw pw-sentinel">
      <div className="pw-sn-head">
        <RadarMark status={scan.status} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pw-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="pw-display" style={{ fontSize: 20, lineHeight: 1.15 }}>
              {scan.anomalies.length ? `${scan.anomalies.length} finding${scan.anomalies.length === 1 ? '' : 's'}` : 'All clear'}
            </span>
            {critical > 0 && (
              <Pill tone="refund" dot>
                {critical} critical
              </Pill>
            )}
          </div>
          <div className="pw-note pw-truncate">
            {scan.rules.length} rules over {scan.scanned.pacts} pacts · {scan.scanned.verdicts} AI decisions · {scan.scanned.payments} PayPal operations
          </div>
        </div>
      </div>

      {style.headline && (
        <div className="pw-sn-brief">
          <span className="pw-eyebrow">Sentinel briefing</span>
          <div>{style.headline}</div>
        </div>
      )}

      <div className="pw-sn-list">
        <AnimatePresence initial={false}>
          {list.map((a, i) => {
            const s = SEV[a.severity];
            return (
              <motion.article
                key={a.id}
                className="pw-sn-item"
                data-focus={a.rule === focus}
                style={{ '--c': s.c } as CSSProperties}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                <div className="pw-row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <Pill tone={s.tone} dot>
                    {s.label}
                  </Pill>
                  <div className="pw-sn-title">{a.title}</div>
                  {a.amount != null && <span className="pw-display pw-sn-amount">{usd(a.amount)}</span>}
                </div>
                <p className="pw-sn-detail">{a.detail}</p>
                <Compare m={a.metric} color={s.c} />
                {a.pactIds.length > 0 && (
                  <div className="pw-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <button className="pw-btn" style={{ height: 24 }} onClick={() => crossFilterPact(params, a.pactIds[0])} title="Filter every widget on this page to the first affected pact">
                      Filter page
                    </button>
                    <button className="pw-btn" data-variant="link" style={{ height: 24 }} onClick={() => ctx.openPact(a.pactIds[0])}>
                      Open pact room →
                    </button>
                    {a.pactIds.length > 1 && <span className="pw-note">+{a.pactIds.length - 1} more pact(s)</span>}
                  </div>
                )}
              </motion.article>
            );
          })}
        </AnimatePresence>
        {!list.length && <div className="pw-sn-clear">Every rule passed on the current ledger. The radar re-scans on every live update.</div>}
      </div>

      <div className="pw-sn-rules" aria-label="Rules checked">
        {scan.rules.map((r) => (
          <span key={r.id} className="pw-sn-rule" data-hit={r.triggered > 0} title={r.label}>
            {r.triggered > 0 ? `● ${r.triggered}` : '✓'} {r.label}
          </span>
        ))}
      </div>
    </div>
  );
}
