import { describe, expect, it } from 'vitest';
import type { PactView } from '@pact/core';
import { RULES, scanLedger } from '../src/services/sentinel';

const NOW = new Date('2026-11-10T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 36e5).toISOString();

let n = 0;
type MsOpts = { status?: string; amount?: number; captured?: number; verdicts?: { kind?: string; status: string; confidence: number; at?: number; appeal?: string }[] };
const milestone = (o: MsOpts = {}) => ({
  id: `m${++n}`,
  title: `Milestone ${n}`,
  percent: 100,
  amountMinor: o.amount ?? 10000,
  capturedMinor: o.captured ?? (o.status === 'released' ? (o.amount ?? 10000) : 0),
  refundedMinor: 0,
  status: o.status ?? 'released',
  attempts: 1,
  deadline: '2026-11-20',
  criteria: [],
  evidenceTypes: ['photo'],
  evidence: [],
  verdicts: (o.verdicts ?? []).map((v, i) => ({
    id: `vd_${n}_${i}`,
    pactId: 'p',
    milestoneId: `m${n}`,
    kind: v.kind ?? 'verifier',
    status: v.status,
    confidence: v.confidence,
    reasoning: 'Because.',
    verifier: null,
    arbiter: null,
    precheckFailures: [],
    evidenceIds: [],
    model: 'muse-spark-1.3',
    llmMode: 'replay',
    appealStatus: v.appeal ?? 'none',
    appealNote: null,
    createdAt: hoursAgo(v.at ?? 30),
  })),
});
type PactOpts = { seller?: string; status?: string; held?: number; authExpiresInH?: number; milestones?: ReturnType<typeof milestone>[]; payments?: { kind: string; status: string; amount: number; at: number }[]; disputes?: number };
const pact = (o: PactOpts = {}) =>
  ({
    id: `pact_${++n}`,
    title: `Pact ${n}`,
    status: o.status ?? 'completed',
    totalMinor: 10000,
    heldMinor: o.held ?? 0,
    releasedMinor: 0,
    refundedMinor: 0,
    voidedMinor: 0,
    seller: { id: o.seller ?? 'seller_a', name: o.seller ?? 'Seller A', kind: 'human', email: null },
    buyer: { id: 'buyer', name: 'Buyer', kind: 'human', email: null },
    milestones: o.milestones ?? [milestone()],
    payments: (o.payments ?? []).map((x, i) => ({ id: `pay_${n}_${i}`, kind: x.kind, paypalId: null, milestoneId: null, amountMinor: x.amount, currency: 'USD', status: x.status, mode: 'simulated', createdAt: hoursAgo(x.at) })),
    disputes: Array.from({ length: o.disputes ?? 0 }, (_, i) => ({ id: `d${i}`, milestoneId: 'm', openedBy: 'buyer', buyerStatement: '', sellerStatement: null, status: 'open', verdictId: null, createdAt: hoursAgo(2), resolvedAt: null })),
    authorizationExpiresAt: o.authExpiresInH == null ? null : new Date(NOW.getTime() + o.authExpiresInH * 36e5).toISOString(),
    createdAt: hoursAgo(100),
    updatedAt: hoursAgo(50),
  }) as unknown as PactView;

describe('Sentinel rules', () => {
  it('reports a clean ledger as clear and lists every rule it checked', () => {
    const scan = scanLedger({ now: NOW, pacts: [pact(), pact({ seller: 'seller_b' })] });
    expect(scan.status).toBe('clear');
    expect(scan.anomalies).toEqual([]);
    expect(scan.rules.map((r) => r.id)).toEqual(Object.keys(RULES));
    expect(scan.scanned).toMatchObject({ pacts: 2, milestones: 2 });
  });

  it('flags a refund spike against the 7-day average, ignoring automatic voids', () => {
    const quiet = scanLedger({ now: NOW, pacts: [pact({ payments: [{ kind: 'void', status: 'AUTO_VOIDED_BY_FINAL_CAPTURE', amount: 90000, at: 2 }] })] });
    expect(quiet.anomalies).toEqual([]);
    const spike = scanLedger({
      now: NOW,
      pacts: [pact({ payments: [{ kind: 'refund', status: 'COMPLETED', amount: 12000, at: 3 }] }), pact({ payments: [{ kind: 'void', status: 'VOIDED', amount: 8000, at: 5 }] })],
    });
    const a = spike.anomalies.find((x) => x.rule === 'refund_velocity')!;
    expect(a).toBeDefined();
    expect(a.metric.value).toBe(200);
    expect(a.metric.baseline).toBeCloseTo(200 / 7, 1);
    expect(a.pactIds).toHaveLength(2);
    expect(a.chart?.instructions).toMatch(/payments\.amount/);
  });

  it('does not call it a spike when the last 24 h are in line with the week', () => {
    const steady = Array.from({ length: 7 }, (_, d) => pact({ payments: [{ kind: 'refund', status: 'COMPLETED', amount: 6000, at: d * 24 + 2 }] }));
    expect(scanLedger({ now: NOW, pacts: steady }).anomalies.filter((a) => a.rule === 'refund_velocity')).toEqual([]);
  });

  it('flags a seller whose settled milestones are refunded far more often than the platform', () => {
    const pacts = [
      pact({ seller: 'risky', milestones: [milestone({ status: 'refunded' }), milestone({ status: 'partially_released' })] }),
      ...Array.from({ length: 6 }, () => pact({ seller: 'good' })),
    ];
    const a = scanLedger({ now: NOW, pacts }).anomalies.find((x) => x.rule === 'seller_refund_concentration')!;
    expect(a.severity).toBe('critical');
    expect(a.metric.value).toBe(1);
    expect(a.metric.baseline).toBeCloseTo(2 / 8);
  });

  it('flags held funds whose PayPal authorization is about to expire', () => {
    const scan = scanLedger({ now: NOW, pacts: [pact({ status: 'in_progress', held: 31500, authExpiresInH: 10, milestones: [milestone({ status: 'pending' })] })] });
    const a = scan.anomalies.find((x) => x.rule === 'authorization_expiring')!;
    expect(a.severity).toBe('critical');
    expect(a.amount).toBe(315);
    expect(scan.status).toBe('critical');
  });

  it('flags money released on a low-confidence decision and unresolved rejections', () => {
    const scan = scanLedger({
      now: NOW,
      pacts: [
        pact({ milestones: [milestone({ status: 'released', verdicts: [{ status: 'approved', confidence: 0.55 }] })] }),
        pact({ status: 'in_progress', milestones: [milestone({ status: 'rejected', verdicts: [{ status: 'rejected', confidence: 0.97 }] })] }),
      ],
    });
    expect(scan.anomalies.map((a) => a.rule).sort()).toEqual(['low_confidence_release', 'repeat_rejections']);
    expect(scan.anomalies.find((a) => a.rule === 'low_confidence_release')!.severity).toBe('warning');
  });

  it('orders findings by severity, then by money at stake', () => {
    const scan = scanLedger({
      now: NOW,
      pacts: [pact({ disputes: 1 }), pact({ payments: [{ kind: 'capture', status: 'DECLINED', amount: 5000, at: 1 }] })],
    });
    expect(scan.anomalies.map((a) => a.severity)).toEqual(['critical', 'warning']);
  });
});
