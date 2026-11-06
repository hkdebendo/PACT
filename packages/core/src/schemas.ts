// Domain schemas (Zod). Shapes used as LLM structured outputs keep every property required and use
// `nullable()` for optional values, so they compile to the strict JSON-schema subset that Meta's
// Model API (and OpenAI strict mode) accept: root object, additionalProperties false, no oneOf/allOf.
import { z } from 'zod';

export const EVIDENCE_TYPES = ['photo', 'document', 'code', 'tracking'] as const;
export const EvidenceType = z.enum(EVIDENCE_TYPES);
export type EvidenceType = z.infer<typeof EvidenceType>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const Criterion = z.object({
  id: z.string().describe('Short id, unique inside the milestone, e.g. "c1"'),
  text: z.string().describe('One objectively checkable condition, e.g. "50 t-shirts are visible or counted"'),
});
export type Criterion = z.infer<typeof Criterion>;

export const Milestone = z.object({
  id: z.string().describe('Short id, e.g. "m1"'),
  title: z.string(),
  percent: z.number().int().min(1).max(100).describe('Share of the total released when this milestone is approved'),
  criteria: z.array(Criterion).min(1),
  evidenceTypes: z.array(EvidenceType).min(1).describe('Evidence the seller may submit for this milestone'),
  deadline: isoDate.nullable().describe('YYYY-MM-DD, or null to use the contract deadline'),
});
export type Milestone = z.infer<typeof Milestone>;

export const Party = z.object({
  name: z.string(),
  email: z.string().nullable(),
});

export const Subcontractor = z.object({
  name: z.string(),
  email: z.string().nullable().describe('PayPal email that receives the payout'),
  milestoneId: z.string(),
  percentOfMilestone: z.number().int().min(1).max(100),
});
export type Subcontractor = z.infer<typeof Subcontractor>;

export const DisputePolicy = z.object({
  windowHours: z.number().int().min(1).max(720).describe('Hours after a verdict during which either party may dispute'),
  resolution: z.enum(['ai_arbiter_with_human_appeal']),
  notes: z.string().nullable(),
});

export const Contract = z.object({
  title: z.string(),
  description: z.string().describe('One or two sentences restating the deal'),
  buyer: Party,
  seller: Party,
  currency: z.string().regex(/^[A-Z]{3}$/),
  totalAmount: z.number().positive().describe('Total in major units, e.g. 450.00'),
  deadline: isoDate,
  milestones: z.array(Milestone).min(1).max(10),
  subcontractors: z.array(Subcontractor),
  disputePolicy: DisputePolicy,
});
export type Contract = z.infer<typeof Contract>;

/** Output of the Contract Parser role. */
export const ParseResult = z.object({
  status: z.enum(['ok', 'needs_clarification']),
  questions: z.array(z.string()).describe('Specific clarification questions; empty when status is ok'),
  assumptions: z.array(z.string()).describe('Defaults the parser applied (e.g. currency); empty if none'),
  contract: Contract.nullable(),
});
export type ParseResult = z.infer<typeof ParseResult>;

/** Business rules that JSON Schema cannot express. Returns human-readable problems. */
export function validateContract(c: Contract): string[] {
  const problems: string[] = [];
  const sum = c.milestones.reduce((s, m) => s + m.percent, 0);
  if (sum !== 100) problems.push(`Milestone percentages sum to ${sum}%, expected 100%.`);
  const ids = new Set<string>();
  for (const m of c.milestones) {
    if (ids.has(m.id)) problems.push(`Duplicate milestone id "${m.id}".`);
    ids.add(m.id);
    const cids = new Set(m.criteria.map((x) => x.id));
    if (cids.size !== m.criteria.length) problems.push(`Milestone "${m.id}" has duplicate criterion ids.`);
    if (m.deadline && m.deadline > c.deadline) problems.push(`Milestone "${m.id}" deadline is after the contract deadline.`);
  }
  for (const s of c.subcontractors) {
    if (!ids.has(s.milestoneId)) problems.push(`Subcontractor "${s.name}" references unknown milestone "${s.milestoneId}".`);
  }
  if (Math.abs(c.totalAmount * 100 - Math.round(c.totalAmount * 100)) > 1e-6)
    problems.push('Total amount has more than two decimals.');
  return problems;
}

// --- Verifier ---------------------------------------------------------------------------

/** Verifier step 1: a factual description of one piece of evidence, produced WITHOUT the criteria. */
export const EvidenceDescription = z.object({
  summary: z.string().describe('One factual sentence describing what the evidence shows'),
  objects: z.array(
    z.object({
      name: z.string(),
      count: z.number().int().nullable().describe('Exact count if countable, else null'),
      attributes: z.array(z.string()).describe('Colours, materials, markings, condition'),
    }),
  ),
  visibleText: z.array(z.string()).describe('Verbatim text visible in the evidence'),
  dates: z.array(z.string()).describe('Dates visible in the evidence, verbatim'),
  quality: z.object({
    legible: z.boolean(),
    issues: z.array(z.string()).describe('Blur, cropping, glare, possible editing; empty if none'),
  }),
});
export type EvidenceDescription = z.infer<typeof EvidenceDescription>;

export const VERDICT_STATUSES = ['approved', 'rejected', 'needs_more'] as const;
export const VerdictStatus = z.enum(VERDICT_STATUSES);
export type VerdictStatus = z.infer<typeof VerdictStatus>;

/** Verifier step 2: description compared with the milestone criteria. */
export const VerifierVerdict = z.object({
  status: VerdictStatus,
  confidence: z.number().min(0).max(1),
  criteria: z.array(
    z.object({
      criterionId: z.string(),
      passed: z.boolean(),
      confidence: z.number().min(0).max(1),
      reasoning: z.string().describe('Cite the specific facts from the description'),
    }),
  ),
  reasoning: z.string().describe('Two to four sentences a non-expert can follow'),
  missing: z.array(z.string()).describe('What further evidence would settle any open criterion'),
});
export type VerifierVerdict = z.infer<typeof VerifierVerdict>;

// --- Arbiter ----------------------------------------------------------------------------

export const ARBITER_DECISIONS = ['release', 'partial', 'refund'] as const;
export const ArbiterDecision = z.object({
  decision: z.enum(ARBITER_DECISIONS),
  releasePercent: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('Percent of THIS milestone amount paid to the seller: 100 for release, 0 for refund'),
  reasoning: z.string(),
  citedEvidence: z.array(z.object({ evidenceId: z.string(), why: z.string() })),
  confidence: z.number().min(0).max(1),
});
export type ArbiterDecision = z.infer<typeof ArbiterDecision>;

// --- Pact & milestone state -------------------------------------------------------------

export const PACT_STATUSES = [
  'draft',
  'proposed',
  'funded',
  'in_progress',
  'disputed',
  'completed',
  'closed',
  'cancelled',
  'expired',
] as const;
export type PactStatus = (typeof PACT_STATUSES)[number];

export const MILESTONE_STATUSES = [
  'pending',
  'evidence_submitted',
  'approved',
  'rejected',
  'needs_more',
  'released',
  'disputed',
  'partially_released',
  'refunded',
  'voided',
] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const TERMINAL_MILESTONE: readonly MilestoneStatus[] = ['released', 'partially_released', 'refunded', 'voided'];
