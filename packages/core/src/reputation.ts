// Reputation score with Bayesian (Beta-prior) smoothing. Formula documented in docs/REPUTATION.md.
//
// Each rate r = (k + a) / (n + a + b), where k = favourable outcomes, n = trials, and Beta(a, b) is a
// prior worth a + b pseudo-observations. A new account starts at the prior mean instead of 0% or
// 100%, and real history outweighs the prior as n grows.

export interface ReputationInputs {
  pactsTotal: number; // pacts that reached a terminal state (completed/closed/cancelled/expired)
  pactsCompleted: number;
  milestonesTotal: number; // milestones that reached a terminal state
  milestonesOnTime: number; // terminal milestones whose release happened before their deadline
  disputesTotal: number; // milestones that were disputed
  refundsTotal: number; // milestones resolved as refund or partial refund
}

export interface Prior {
  a: number;
  b: number;
}

export const PRIORS = {
  completion: { a: 4, b: 1 }, // mean 0.80
  onTime: { a: 4, b: 1 }, // mean 0.80
  dispute: { a: 1, b: 9 }, // mean 0.10
  refund: { a: 1, b: 9 }, // mean 0.10
} as const satisfies Record<string, Prior>;

export const WEIGHTS = { completion: 0.4, onTime: 0.25, noDispute: 0.2, noRefund: 0.15 } as const;

export const smoothed = (k: number, n: number, p: Prior): number => (k + p.a) / (n + p.a + p.b);

export interface ReputationScore {
  score: number; // 0..100
  completionRate: number;
  onTimeRate: number;
  disputeRate: number;
  refundRate: number;
  confidence: number; // 0..1: how much of the score comes from real history rather than the prior
  tier: 'new' | 'emerging' | 'trusted' | 'excellent' | 'at_risk';
  raw: ReputationInputs;
}

export function computeReputation(x: ReputationInputs): ReputationScore {
  const completionRate = smoothed(x.pactsCompleted, x.pactsTotal, PRIORS.completion);
  const onTimeRate = smoothed(x.milestonesOnTime, x.milestonesTotal, PRIORS.onTime);
  const disputeRate = smoothed(x.disputesTotal, x.milestonesTotal, PRIORS.dispute);
  const refundRate = smoothed(x.refundsTotal, x.milestonesTotal, PRIORS.refund);
  const score =
    100 *
    (WEIGHTS.completion * completionRate +
      WEIGHTS.onTime * onTimeRate +
      WEIGHTS.noDispute * (1 - disputeRate) +
      WEIGHTS.noRefund * (1 - refundRate));
  const strength = PRIORS.onTime.a + PRIORS.onTime.b;
  const confidence = x.milestonesTotal / (x.milestonesTotal + strength);
  const rounded = Math.round(score * 10) / 10;
  const tier =
    x.milestonesTotal < 3
      ? 'new'
      : rounded < 60
        ? 'at_risk'
        : rounded < 75
          ? 'emerging'
          : rounded < 88
            ? 'trusted'
            : 'excellent';
  return { score: rounded, completionRate, onTimeRate, disputeRate, refundRate, confidence, tier, raw: x };
}
