'use client';
// Building blocks shared by the pact room and the Control Tower widgets.
import { motion } from 'motion/react';
import { useState } from 'react';
import type { PactView, VerdictView } from '@pact/core/browser';
import { api, useLive, type ApiError } from '@/lib/api';
import { Badge, Button, ErrorNote, cx, money } from './ui';

// --- Escrow bar: held / released / refunded / voided, animated ---------------------------

export function EscrowBar({ pact, compact }: { pact: Pick<PactView, 'totalMinor' | 'heldMinor' | 'releasedMinor' | 'refundedMinor' | 'voidedMinor' | 'currency'>; compact?: boolean }) {
  const total = Math.max(1, pact.totalMinor);
  const parts = [
    { k: 'Released to seller', v: pact.releasedMinor, c: 'bg-released', t: 'text-released' },
    { k: 'Held by PayPal', v: pact.heldMinor, c: 'bg-held', t: 'text-held' },
    { k: 'Refunded', v: pact.refundedMinor, c: 'bg-refund', t: 'text-refund' },
    { k: 'Voided (never charged)', v: pact.voidedMinor, c: 'bg-void', t: 'text-void' },
  ];
  const unfunded = Math.max(0, total - parts.reduce((a, p) => a + p.v, 0));
  return (
    <div>
      <div className={cx('flex w-full overflow-hidden rounded-full bg-paper-2', compact ? 'h-2' : 'h-3')} role="img" aria-label={parts.map((p) => `${p.k} ${money(p.v, pact.currency)}`).join(', ')}>
        {parts.map((p) => (
          <motion.div key={p.k} className={p.c} initial={false} animate={{ width: `${(p.v / total) * 100}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
        ))}
        {unfunded > 0 && <div style={{ width: `${(unfunded / total) * 100}%` }} />}
      </div>
      {!compact && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
          {parts.map((p) => (
            <span key={p.k} className="inline-flex items-center gap-2 text-ink-2">
              <span className={cx('size-2 rounded-full', p.c)} />
              {p.k}
              <motion.span key={p.v} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className={cx('hash font-semibold', p.t)}>
                {money(p.v, pact.currency)}
              </motion.span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Audit chain badge --------------------------------------------------------------------

interface ChainStatus {
  ok: boolean;
  count: number;
  headHash: string;
  brokenAt: number | null;
  verifiedAt: string;
}

export function ChainBadge({ className }: { className?: string }) {
  const { data, reload } = useLive<ChainStatus>('/api/audit/verify', (e) => e.type === 'audit.appended');
  if (!data) return <Badge className={className}>verifying chain…</Badge>;
  return (
    <button onClick={reload} title={`Recomputed ${data.count} SHA-256 links at ${new Date(data.verifiedAt).toLocaleTimeString()}. Click to verify again.`} className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap', data.ok ? 'bg-released-soft text-released' : 'bg-refund-soft text-refund', className)}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden>
        {data.ok ? <path d="M5 12l4 4 10-10" /> : <path d="M6 6l12 12M18 6L6 18" />}
      </svg>
      {data.ok ? 'Chain verified' : `Chain broken at #${data.brokenAt}`}
      <span className="hash opacity-70">{data.headHash.slice(0, 8)}</span>
    </button>
  );
}

// --- Confidence meter ---------------------------------------------------------------------

export function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <span className="inline-flex items-center gap-2" title={`Model confidence ${pct}%`}>
      <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-paper-2">
        <motion.span className="absolute inset-y-0 left-0 rounded-full bg-ink-2" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.6 }} />
      </span>
      <span className="hash text-muted">{pct}%</span>
    </span>
  );
}

// --- Verdict card ---------------------------------------------------------------------------

const VERDICT_TONE: Record<string, 'released' | 'refund' | 'held'> = { approved: 'released', release: 'released', rejected: 'refund', refund: 'refund', needs_more: 'held', partial: 'held' };

export function VerdictCard({ verdict, criteria, canAppeal, party, compact }: { verdict: VerdictView; criteria?: { id: string; text: string }[]; canAppeal?: boolean; party?: 'buyer' | 'seller'; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const tone = VERDICT_TONE[verdict.status] ?? 'held';
  const who = verdict.kind === 'verifier' ? 'AI Verifier' : verdict.kind === 'arbiter' ? 'AI Arbiter' : 'Human reviewer';
  const appeal = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('POST', `/api/verdicts/${verdict.id}/appeal`, { party: party ?? 'seller', note: note || 'Please review this decision.' });
      setOpen(false);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.article layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={cx('rounded-xl border bg-surface p-4', tone === 'refund' ? 'border-refund/30' : tone === 'released' ? 'border-released/30' : 'border-held/30')}>
      <header className="flex flex-wrap items-center gap-2">
        <Badge tone={tone} dot>
          {verdict.status.replace('_', ' ')}
        </Badge>
        <span className="text-[13px] font-semibold text-ink">{who}</span>
        <Confidence value={verdict.confidence} />
        <span className="ml-auto text-[12px] text-muted">
          {verdict.model ?? '—'}
          {verdict.llmMode === 'replay' && ' · recorded'}
        </span>
      </header>
      <p className="mt-3 text-[14px] leading-relaxed text-ink">{verdict.reasoning}</p>
      {!compact && verdict.verifier && verdict.verifier.criteria.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {verdict.verifier.criteria.map((c) => (
            <li key={c.criterionId} className="flex gap-2 text-[13px]">
              <span className={cx('mt-0.5 font-bold', c.passed ? 'text-released' : 'text-refund')}>{c.passed ? '✓' : '✗'}</span>
              <span className="text-ink-2">
                <span className="hash mr-1 text-muted">{c.criterionId}</span>
                {criteria?.find((x) => x.id === c.criterionId)?.text && <span className="font-medium text-ink">{criteria.find((x) => x.id === c.criterionId)!.text}. </span>}
                {c.reasoning}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!compact && verdict.arbiter && (
        <div className="mt-3 rounded-lg bg-paper-2 p-3 text-[13px] text-ink-2">
          Seller receives <b className="text-ink">{verdict.arbiter.releasePercent}%</b> of this milestone.
          {verdict.arbiter.citedEvidence.length > 0 && <> Cited: {verdict.arbiter.citedEvidence.map((c) => `${c.evidenceId.slice(0, 9)}… (${c.why})`).join('; ')}</>}
        </div>
      )}
      {verdict.precheckFailures.length > 0 && <div className="mt-3 rounded-lg bg-refund-soft p-3 text-[13px] text-refund">Pre-checks: {verdict.precheckFailures.join(' ')}</div>}
      <footer className="mt-3 flex flex-wrap items-center gap-2">
        <ChainBadge />
        {verdict.appealStatus !== 'none' ? (
          <Badge tone={verdict.appealStatus === 'overturned' ? 'released' : 'navy'}>Appeal {verdict.appealStatus}</Badge>
        ) : (
          canAppeal && (
            <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              Appeal to a human
            </Button>
          )
        )}
        <span className="hash ml-auto text-muted">{verdict.id}</span>
      </footer>
      {open && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why should a human look again?" className="h-9 flex-1 rounded-lg border border-line bg-paper px-3 text-[13px] outline-none focus:border-navy" />
          <Button size="sm" onClick={appeal} loading={busy}>
            Send appeal
          </Button>
        </div>
      )}
      <ErrorNote error={err} />
    </motion.article>
  );
}
