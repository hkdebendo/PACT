// Deterministic evidence pre-checks, run before any model sees the evidence. A failure here
// rejects the milestone without spending tokens and is reported to the Verifier step 2 as a fact.
import type { EvidenceType, Milestone } from '@pact/core/browser';
import { IMAGE_MIMES, TEXT_MIMES } from './roles';

export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

export interface PrecheckEvidence {
  id: string;
  type: EvidenceType;
  mime: string;
  size: number;
  sha256: string;
  createdAt: string; // ISO
}

export interface PrecheckContext {
  milestone: Milestone;
  milestoneDeadline: string; // YYYY-MM-DD, resolved from the contract when the milestone has none
  /** For each evidence hash, the other pacts that already used it. */
  reusedIn: Record<string, string[]>;
  now: Date;
}

export function runPrechecks(evidence: PrecheckEvidence[], ctx: PrecheckContext): string[] {
  const failures: string[] = [];
  if (!evidence.length) failures.push('No evidence submitted.');
  for (const e of evidence) {
    if (!ctx.milestone.evidenceTypes.includes(e.type))
      failures.push(`Evidence ${e.id} is "${e.type}", but this milestone accepts ${ctx.milestone.evidenceTypes.join(', ')}.`);
    if (![...IMAGE_MIMES, ...TEXT_MIMES].includes(e.mime)) failures.push(`Evidence ${e.id} has unsupported file type ${e.mime}.`);
    if (e.type === 'photo' && !IMAGE_MIMES.includes(e.mime)) failures.push(`Evidence ${e.id} is declared a photo but is ${e.mime}.`);
    if (e.size <= 0) failures.push(`Evidence ${e.id} is empty.`);
    if (e.size > MAX_EVIDENCE_BYTES) failures.push(`Evidence ${e.id} exceeds ${MAX_EVIDENCE_BYTES / 1024 / 1024} MB.`);
    const reused = ctx.reusedIn[e.sha256] ?? [];
    if (reused.length) failures.push(`Evidence ${e.id} is byte-identical to evidence already used in pact(s) ${reused.join(', ')}.`);
  }
  // Deadline: evidence must be submitted by the end of the deadline day (UTC).
  const late = evidence.filter((e) => e.createdAt.slice(0, 10) > ctx.milestoneDeadline);
  if (late.length) failures.push(`Evidence ${late.map((e) => e.id).join(', ')} was submitted after the milestone deadline ${ctx.milestoneDeadline}.`);
  return failures;
}
