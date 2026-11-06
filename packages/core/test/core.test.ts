import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  applyPactEvent,
  chainNext,
  computeReputation,
  Contract,
  canonicalJson,
  initialPactState,
  InvalidTransitionError,
  ParseResult,
  splitByPercent,
  toMajorString,
  fromMajorString,
  validateContract,
  verifyChain,
  VerifierVerdict,
  type AuditEntry,
  type PactEvent,
  type PersistedPactState,
} from '../src/index';

const run = (events: PactEvent[], s = initialPactState(['m1', 'm2'])): PersistedPactState =>
  events.reduce(applyPactEvent, s);

const funded: PactEvent[] = [{ type: 'PROPOSE' }, { type: 'ACCEPT' }, { type: 'FUNDED' }];

describe('pact state machine', () => {
  it('runs the happy path to completed and closed', () => {
    const s = run([
      ...funded,
      { type: 'SUBMIT_EVIDENCE', milestoneId: 'm1' },
      { type: 'VERDICT', milestoneId: 'm1', status: 'approved' },
      { type: 'RELEASE', milestoneId: 'm1' },
      { type: 'SUBMIT_EVIDENCE', milestoneId: 'm2' },
      { type: 'VERDICT', milestoneId: 'm2', status: 'approved' },
      { type: 'RELEASE', milestoneId: 'm2' },
    ]);
    expect(s.status).toBe('completed');
    expect(s.context.milestones.m1.status).toBe('released');
    expect(run([{ type: 'CLOSE' }], s).status).toBe('closed');
  });

  it('lets a rejected milestone be resubmitted', () => {
    const s = run([
      ...funded,
      { type: 'SUBMIT_EVIDENCE', milestoneId: 'm1' },
      { type: 'VERDICT', milestoneId: 'm1', status: 'rejected' },
      { type: 'SUBMIT_EVIDENCE', milestoneId: 'm1' },
    ]);
    expect(s.status).toBe('in_progress');
    expect(s.context.milestones.m1).toMatchObject({ status: 'evidence_submitted', attempts: 2 });
  });

  it('refuses funding before the seller accepts', () => {
    expect(() => run([{ type: 'PROPOSE' }, { type: 'FUNDED' }])).toThrow(/seller has not accepted/);
  });

  it('fails loudly on invalid transitions', () => {
    expect(() => run([...funded, { type: 'RELEASE', milestoneId: 'm1' }])).toThrow(InvalidTransitionError);
    expect(() => run([{ type: 'SUBMIT_EVIDENCE', milestoneId: 'm1' }])).toThrow(/not allowed in pact state "draft"/);
    expect(() => run([...funded, { type: 'SUBMIT_EVIDENCE', milestoneId: 'nope' }])).toThrow(InvalidTransitionError);
  });

  it('handles disputes and resolution', () => {
    let s = run([
      ...funded,
      { type: 'SUBMIT_EVIDENCE', milestoneId: 'm1' },
      { type: 'VERDICT', milestoneId: 'm1', status: 'rejected' },
      { type: 'OPEN_DISPUTE', milestoneId: 'm1' },
    ]);
    expect(s.status).toBe('disputed');
    s = run([{ type: 'RESOLVE', milestoneId: 'm1', outcome: 'partial' }], s);
    expect(s.status).toBe('in_progress');
    expect(s.context.milestones.m1.status).toBe('partially_released');
  });

  it('allows a refund dispute on a released milestone after completion', () => {
    let s = run(
      [
        ...funded,
        { type: 'SUBMIT_EVIDENCE', milestoneId: 'm1' },
        { type: 'VERDICT', milestoneId: 'm1', status: 'approved' },
        { type: 'RELEASE', milestoneId: 'm1' },
      ],
      initialPactState(['m1']),
    );
    expect(s.status).toBe('completed');
    s = run([{ type: 'OPEN_DISPUTE', milestoneId: 'm1' }], s);
    expect(s.status).toBe('disputed');
    expect(s.context.milestones.m1.wasReleased).toBe(true);
    s = run([{ type: 'RESOLVE', milestoneId: 'm1', outcome: 'refund' }], s);
    expect(s.status).toBe('completed');
    expect(s.context.milestones.m1.status).toBe('refunded');
  });

  it('voids open milestones on cancel', () => {
    const s = run([
      ...funded,
      { type: 'SUBMIT_EVIDENCE', milestoneId: 'm1' },
      { type: 'VERDICT', milestoneId: 'm1', status: 'approved' },
      { type: 'RELEASE', milestoneId: 'm1' },
      { type: 'CANCEL' },
    ]);
    expect(s.status).toBe('cancelled');
    expect(s.context.milestones.m1.status).toBe('released');
    expect(s.context.milestones.m2.status).toBe('voided');
  });
});

describe('audit hash chain', () => {
  const build = (n: number) => {
    const out: AuditEntry[] = [];
    for (let i = 0; i < n; i++)
      out.push(chainNext(out.at(-1) ?? null, { pactId: 'p1', actor: 'system', type: 't', data: { i, z: { b: 1, a: 2 } } }, `2026-11-06T00:00:0${i}Z`));
    return out;
  };

  it('verifies an intact chain', () => {
    const r = verifyChain(build(5));
    expect(r).toMatchObject({ ok: true, count: 5, brokenAt: null });
  });

  it('detects tampered content, reordering and deletion', () => {
    const tampered = build(5);
    tampered[2] = { ...tampered[2], data: { i: 99 } };
    expect(verifyChain(tampered)).toMatchObject({ ok: false, brokenAt: 3 });

    const swapped = build(4);
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    expect(verifyChain(swapped).ok).toBe(false);

    const deleted = build(4);
    deleted.splice(1, 1);
    expect(verifyChain(deleted).ok).toBe(false);
  });

  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
});

describe('reputation', () => {
  const zero = { pactsTotal: 0, pactsCompleted: 0, milestonesTotal: 0, milestonesOnTime: 0, disputesTotal: 0, refundsTotal: 0 };

  it('starts a new account at the prior, not at 0 or 100', () => {
    const r = computeReputation(zero);
    expect(r.score).toBeGreaterThan(70);
    expect(r.score).toBeLessThan(90);
    expect(r.tier).toBe('new');
    expect(r.confidence).toBe(0);
  });

  it('rewards a long clean history and penalises disputes and refunds', () => {
    const good = computeReputation({ ...zero, pactsTotal: 20, pactsCompleted: 20, milestonesTotal: 40, milestonesOnTime: 39 });
    const bad = computeReputation({ ...zero, pactsTotal: 20, pactsCompleted: 6, milestonesTotal: 40, milestonesOnTime: 12, disputesTotal: 18, refundsTotal: 14 });
    expect(good.score).toBeGreaterThan(90);
    expect(good.tier).toBe('excellent');
    expect(bad.score).toBeLessThan(60);
    expect(bad.tier).toBe('at_risk');
  });

  it('does not over-rate one lucky pact', () => {
    const one = computeReputation({ ...zero, pactsTotal: 1, pactsCompleted: 1, milestonesTotal: 1, milestonesOnTime: 1 });
    expect(one.score).toBeLessThan(90);
  });
});

describe('money', () => {
  it('splits exactly', () => {
    expect(splitByPercent(45000, [30, 70])).toEqual([13500, 31500]);
    expect(splitByPercent(1000, [33, 33, 34]).reduce((a, b) => a + b)).toBe(1000);
    expect(splitByPercent(1001, [50, 50])).toEqual([500, 501]);
  });
  it('formats PayPal amounts', () => {
    expect(toMajorString(13500)).toBe('135.00');
    expect(toMajorString(5)).toBe('0.05');
    expect(fromMajorString('12.3')).toBe(1230);
    expect(() => fromMajorString('1.234')).toThrow();
  });
});

describe('schemas', () => {
  const contract: Contract = {
    title: '50 embroidered t-shirts',
    description: 'Fifty plain t-shirts with embroidery, delivered before Friday.',
    buyer: { name: 'Buyer', email: null },
    seller: { name: 'Seller', email: null },
    currency: 'USD',
    totalAmount: 450,
    deadline: '2026-11-13',
    milestones: [
      { id: 'm1', title: 'Production', percent: 30, criteria: [{ id: 'c1', text: 't-shirts produced' }], evidenceTypes: ['photo'], deadline: null },
      { id: 'm2', title: 'Delivery', percent: 70, criteria: [{ id: 'c1', text: 'delivered' }], evidenceTypes: ['tracking'], deadline: '2026-11-13' },
    ],
    subcontractors: [],
    disputePolicy: { windowHours: 72, resolution: 'ai_arbiter_with_human_appeal', notes: null },
  };

  it('accepts a valid contract and reports business-rule problems', () => {
    expect(Contract.parse(contract)).toBeTruthy();
    expect(validateContract(contract)).toEqual([]);
    const bad = { ...contract, milestones: [{ ...contract.milestones[0], percent: 50 }, contract.milestones[1]] };
    expect(validateContract(bad)[0]).toMatch(/sum to 120%/);
  });

  it('LLM output schemas compile to the strict JSON-schema subset', () => {
    for (const schema of [ParseResult, VerifierVerdict]) {
      const json = JSON.stringify(z.toJSONSchema(schema));
      expect(json).not.toMatch(/"oneOf"|"allOf"/);
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const n = node as Record<string, unknown>;
        if (n.type === 'object' && n.properties) {
          expect(Object.keys(n.properties as object).sort()).toEqual([...((n.required as string[]) ?? [])].sort());
        }
        Object.values(n).forEach(walk);
      };
      walk(JSON.parse(json));
    }
  });
});
