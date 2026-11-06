# Reputation score

Implemented in [`packages/core/src/reputation.ts`](../packages/core/src/reputation.ts), computed from PACT's own ledger in [`apps/api/src/services/reputation.ts`](../apps/api/src/services/reputation.ts).

## Inputs (per party, as seller; buyers fall back to the pacts they took part in)

| Symbol | Meaning |
|---|---|
| `P` | pacts that reached a terminal state (completed, closed, cancelled, expired) |
| `Pc` | of those, completed or closed |
| `M` | milestones that reached a settled state (released, partially released, refunded) — voided milestones are excluded because nobody delivered or failed them |
| `Mo` | settled milestones released on or before their deadline |
| `D` | milestones that went to a dispute |
| `R` | milestones settled with a refund or a partial refund |

## Bayesian smoothing

Each rate uses a Beta prior, i.e. it starts from pseudo-observations:

```
rate = (k + a) / (n + a + b)
```

| Rate | k / n | Prior Beta(a, b) | Prior mean |
|---|---|---|---|
| completion | Pc / P | (4, 1) | 0.80 |
| on-time | Mo / M | (4, 1) | 0.80 |
| dispute | D / M | (1, 9) | 0.10 |
| refund | R / M | (1, 9) | 0.10 |

A brand-new account therefore scores the prior (about **83.5 / 100**) — not 0 (which would punish newcomers, a real problem for small sellers starting out) and not 100 (which would let one lucky pact look perfect). Each real observation moves the rate; after ~20 milestones the history dominates the prior.

## Score

```
score = 100 × ( 0.40 × completion
              + 0.25 × on-time
              + 0.20 × (1 − dispute)
              + 0.15 × (1 − refund) )
```

Confidence (how much of the score comes from real history) = `M / (M + 5)`.

Tiers: `new` (< 3 settled milestones), `at_risk` (< 60), `emerging` (< 75), `trusted` (< 88), `excellent` (≥ 88).

## Worked examples (from the unit tests)

| History | Score |
|---|---|
| nothing | 83.5 (`new`) |
| 1 pact, 1 milestone, on time | < 90 — one pact is not enough to look excellent |
| 20 pacts completed, 39/40 milestones on time, no disputes | > 90 (`excellent`) |
| 10/20 completed, 20/40 on time, 15 disputes, 10 refunds | < 60 (`at_risk`) |

A score snapshot is stored whenever a pact settles, which feeds the sparkline in the Control Tower's Reputation Leaderboard.

## Limits

- Scores are only as honest as the identities behind them: PACT's demo has no identity verification, so a party could start over under a new name (the prior then gives them 83.5, not more).
- Disputes count against the seller whatever the outcome; a future version could weight them by the Arbiter's decision.
