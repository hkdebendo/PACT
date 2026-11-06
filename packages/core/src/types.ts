// API view models shared by the API server, the web app, the MCP server and the agents.
import type { Contract, EvidenceDescription, EvidenceType, MilestoneStatus, PactStatus, VerifierVerdict, ArbiterDecision } from './schemas';
import type { ReputationScore } from './reputation';

export type PaymentMode = 'sandbox' | 'simulated';
export type LlmMode = 'live' | 'replay';

export interface PartyView {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  email: string | null;
}

export interface EvidenceView {
  id: string;
  milestoneId: string;
  type: EvidenceType;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  url: string; // API path to download
  note: string | null;
  description: EvidenceDescription | null;
  createdAt: string;
}

export interface VerdictView {
  id: string;
  pactId: string;
  milestoneId: string;
  kind: 'verifier' | 'arbiter' | 'human';
  status: string; // approved | rejected | needs_more | release | partial | refund
  confidence: number;
  reasoning: string;
  verifier: VerifierVerdict | null;
  arbiter: ArbiterDecision | null;
  precheckFailures: string[];
  evidenceIds: string[];
  model: string | null;
  llmMode: LlmMode | null;
  appealStatus: 'none' | 'requested' | 'upheld' | 'overturned';
  appealNote: string | null;
  createdAt: string;
}

export interface MilestoneView {
  id: string;
  title: string;
  percent: number;
  amountMinor: number;
  capturedMinor: number;
  refundedMinor: number;
  status: MilestoneStatus;
  attempts: number;
  deadline: string;
  criteria: { id: string; text: string }[];
  evidenceTypes: EvidenceType[];
  evidence: EvidenceView[];
  verdicts: VerdictView[];
  releasedAt: string | null;
}

export interface PaymentView {
  id: string;
  kind: 'order' | 'authorization' | 'capture' | 'void' | 'refund' | 'reauthorization' | 'payout';
  paypalId: string | null;
  milestoneId: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  mode: PaymentMode;
  createdAt: string;
}

export interface PactView {
  id: string;
  status: PactStatus;
  title: string;
  description: string;
  sourceText: string | null;
  currency: string;
  totalMinor: number;
  heldMinor: number; // authorized and not yet captured or voided
  releasedMinor: number; // captured to the seller (net of refunds)
  refundedMinor: number;
  voidedMinor: number;
  deadline: string;
  buyer: PartyView;
  seller: PartyView;
  contract: Contract;
  milestones: MilestoneView[];
  payments: PaymentView[];
  paymentMode: PaymentMode;
  approvalUrl: string | null;
  orderId: string | null;
  authorizationId: string | null;
  authorizationExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReputationView extends ReputationScore {
  party: PartyView;
  history: { date: string; score: number }[];
}

/** Server-Sent Event payloads on GET /api/events. */
export type PactEventMessage =
  | { type: 'pact.updated'; pactId: string; status: PactStatus; at: string }
  | { type: 'audit.appended'; seq: number; hash: string; entryType: string; pactId: string | null; at: string }
  | { type: 'verdict.created'; pactId: string; milestoneId: string; verdictId: string; status: string; at: string }
  | { type: 'payment.updated'; pactId: string; kind: string; amountMinor: number; at: string };
