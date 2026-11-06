// The Muse roles: Contract Parser, two-step Verifier and Arbiter. Each one has its own prompt,
// Zod output schema and post-processing policy, and returns the model id + mode used so verdicts
// can say exactly which model and whether the answer was replayed.
import {
  ArbiterDecision,
  EvidenceDescription,
  ParseResult,
  validateContract,
  VerifierVerdict,
  type Contract,
  type Milestone,
} from '@pact/core/browser';
import type { ContentPart, LlmClient, StructuredResult } from './client';
import { ARBITER_PROMPT, DESCRIBE_PROMPT, JUDGE_PROMPT, PARSER_PROMPT } from './prompts';

// --- Contract Parser ---------------------------------------------------------------------

export interface ParseInput {
  text: string;
  today: string; // YYYY-MM-DD (fixed in the demo so replays are deterministic)
  buyerName?: string;
  sellerName?: string;
}

export async function parseContract(llm: LlmClient, input: ParseInput): Promise<StructuredResult<ParseResult> & { problems: string[] }> {
  const r = await llm.structured({
    role: 'parser',
    schema: ParseResult,
    schemaName: 'pact_contract_parse',
    reasoningEffort: 'medium',
    messages: [
      { role: 'system', content: PARSER_PROMPT },
      {
        role: 'user',
        content: [
          `TODAY: ${input.today}`,
          input.buyerName ? `BUYER: ${input.buyerName}` : null,
          input.sellerName ? `SELLER: ${input.sellerName}` : null,
          `DEAL:\n${input.text}`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });
  const problems = r.value.status === 'ok' && r.value.contract ? validateContract(r.value.contract) : [];
  if (r.value.status === 'ok' && !r.value.contract) problems.push('Parser returned status ok without a contract.');
  return { ...r, problems };
}

// --- Verifier ------------------------------------------------------------------------------

export interface EvidenceInput {
  id: string;
  type: string; // photo | document | code | tracking
  mime: string;
  filename: string;
  sha256: string;
  bytes: Buffer;
  note: string | null;
}

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const TEXT_MIMES = ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/x-typescript', 'text/javascript', 'text/x-python', 'text/html'];
const MAX_TEXT_CHARS = 20_000;

/** Step 1: describe one piece of evidence without seeing the criteria. */
export async function describeEvidence(llm: LlmClient, e: EvidenceInput, pactId?: string) {
  const header = `Evidence ${e.id}: type=${e.type}, file=${e.filename}, mime=${e.mime}.${e.note ? ` Submitter note (a claim, not a fact): "${e.note}"` : ''}`;
  const parts: ContentPart[] = [{ type: 'text', text: header }];
  if (IMAGE_MIMES.includes(e.mime)) {
    parts.push({ type: 'image', mime: e.mime, data: e.bytes, sha256: e.sha256 });
  } else {
    const text = e.bytes.toString('utf8');
    parts.push({ type: 'text', text: `CONTENT (${Math.min(text.length, MAX_TEXT_CHARS)} of ${text.length} chars):\n${text.slice(0, MAX_TEXT_CHARS)}` });
  }
  return llm.structured({
    role: 'verifier.describe',
    schema: EvidenceDescription,
    schemaName: 'pact_evidence_description',
    reasoningEffort: 'low',
    pactId,
    messages: [
      { role: 'system', content: DESCRIBE_PROMPT },
      { role: 'user', content: parts },
    ],
  });
}

export const APPROVAL_CONFIDENCE = 0.75;
export const REJECTION_CONFIDENCE = 0.7;

/**
 * Deterministic policy applied on top of the model's verdict, so a low-confidence or inconsistent
 * answer can never silently approve a release:
 * - approved requires every criterion passed AND confidence ≥ APPROVAL_CONFIDENCE AND no pre-check failure
 * - rejected requires a failed criterion with confidence ≥ REJECTION_CONFIDENCE
 * - anything else becomes needs_more
 */
export function applyVerdictPolicy(v: VerifierVerdict, milestone: Milestone, precheckFailures: string[]): VerifierVerdict & { policyNotes: string[] } {
  const notes: string[] = [];
  const byId = new Map(v.criteria.map((c) => [c.criterionId, c]));
  const missing = milestone.criteria.filter((c) => !byId.has(c.id));
  const allPassed = missing.length === 0 && milestone.criteria.every((c) => byId.get(c.id)!.passed);
  const confidentFail = v.criteria.some((c) => !c.passed && c.confidence >= REJECTION_CONFIDENCE);
  let status = v.status;
  if (precheckFailures.length) {
    status = 'rejected';
    notes.push(`Deterministic pre-checks failed: ${precheckFailures.join('; ')}`);
  } else if (v.status === 'approved' && (!allPassed || v.confidence < APPROVAL_CONFIDENCE)) {
    status = 'needs_more';
    notes.push(
      !allPassed
        ? `Model said approved but ${missing.length ? `criteria ${missing.map((c) => c.id).join(', ')} were not assessed` : 'not every criterion passed'}; downgraded to needs_more.`
        : `Model confidence ${v.confidence.toFixed(2)} is below the ${APPROVAL_CONFIDENCE} approval threshold; downgraded to needs_more.`,
    );
  } else if (v.status === 'rejected' && !confidentFail) {
    status = 'needs_more';
    notes.push('Model said rejected without a confidently failed criterion; downgraded to needs_more.');
  }
  return { ...v, status, policyNotes: notes };
}

/** Step 2: compare the descriptions with the criteria. */
export async function judgeMilestone(
  llm: LlmClient,
  input: {
    contract: Contract;
    milestone: Milestone;
    descriptions: { evidenceId: string; type: string; description: EvidenceDescription }[];
    precheckFailures: string[];
    pactId?: string;
  },
) {
  const m = input.milestone;
  const r = await llm.structured({
    role: 'verifier.judge',
    schema: VerifierVerdict,
    schemaName: 'pact_verifier_verdict',
    reasoningEffort: 'high',
    pactId: input.pactId,
    messages: [
      { role: 'system', content: JUDGE_PROMPT },
      {
        role: 'user',
        content: JSON.stringify(
          {
            deal: { title: input.contract.title, description: input.contract.description },
            milestone: { id: m.id, title: m.title, criteria: m.criteria, acceptedEvidence: m.evidenceTypes },
            precheckFailures: input.precheckFailures,
            evidenceDescriptions: input.descriptions,
          },
          null,
          1,
        ),
      },
    ],
  });
  return { ...r, value: applyVerdictPolicy(r.value, m, input.precheckFailures) };
}

// --- Arbiter -------------------------------------------------------------------------------

export async function arbitrate(
  llm: LlmClient,
  input: {
    contract: Contract;
    milestone: Milestone;
    evidence: { evidenceId: string; type: string; description: EvidenceDescription | null; note: string | null }[];
    verifierHistory: { status: string; confidence: number; reasoning: string; at: string }[];
    buyerStatement: string | null;
    sellerStatement: string | null;
    pactId?: string;
  },
) {
  const r = await llm.structured({
    role: 'arbiter',
    schema: ArbiterDecision,
    schemaName: 'pact_arbiter_decision',
    reasoningEffort: 'high',
    pactId: input.pactId,
    messages: [
      { role: 'system', content: ARBITER_PROMPT },
      { role: 'user', content: JSON.stringify(input, null, 1) },
    ],
  });
  // Keep decision and percent consistent whatever the model wrote.
  const v = r.value;
  const releasePercent = v.decision === 'release' ? 100 : v.decision === 'refund' ? 0 : Math.min(99, Math.max(1, v.releasePercent));
  const known = new Set(input.evidence.map((e) => e.evidenceId));
  return { ...r, value: { ...v, releasePercent, citedEvidence: v.citedEvidence.filter((c) => known.has(c.evidenceId)) } };
}
