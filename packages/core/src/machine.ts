// The pact state machine (XState v5).
//
// Pact level:    draft → proposed → (accepted) → funded → in_progress ⇄ disputed → completed → closed
//                with cancelled / expired reachable from any open state.
// Milestone level (kept in context, one record per milestone, guarded by MILESTONE_TRANSITIONS):
//   pending → evidence_submitted → approved → released
//                                → rejected → evidence_submitted (resubmit) | disputed
//                                → needs_more → evidence_submitted
//   approved | rejected | evidence_submitted | released → disputed → released | partially_released | refunded
//   any non-terminal → voided (cancel / expiry)
//
// Every event goes through `applyPactEvent`, which throws InvalidTransitionError when the machine
// would ignore it, so the service layer can fail loudly and audit-log the attempt.
import { assign, setup, transition, type SnapshotFrom } from 'xstate';
import { TERMINAL_MILESTONE, type MilestoneStatus, type PactStatus, type VerdictStatus } from './schemas';

export type ResolveOutcome = 'release' | 'partial' | 'refund';

export type PactEvent =
  | { type: 'PROPOSE' }
  | { type: 'ACCEPT' }
  | { type: 'FUNDED' }
  | { type: 'START' }
  | { type: 'SUBMIT_EVIDENCE'; milestoneId: string }
  | { type: 'VERDICT'; milestoneId: string; status: VerdictStatus }
  | { type: 'RELEASE'; milestoneId: string }
  | { type: 'OPEN_DISPUTE'; milestoneId: string }
  | { type: 'RESOLVE'; milestoneId: string; outcome: ResolveOutcome }
  | { type: 'CANCEL' }
  | { type: 'EXPIRE' }
  | { type: 'CLOSE' };

export interface MilestoneState {
  status: MilestoneStatus;
  attempts: number; // evidence submissions
  wasReleased: boolean; // funds were captured before a dispute (refund path rather than void path)
}

export interface PactMachineContext {
  order: string[];
  milestones: Record<string, MilestoneState>;
  sellerAccepted: boolean;
}

type MilestoneEvent = Extract<PactEvent, { milestoneId: string }>;

/** Next milestone status for an event, or null when the transition is not allowed. */
export function nextMilestoneStatus(m: MilestoneState, e: MilestoneEvent): MilestoneStatus | null {
  switch (e.type) {
    case 'SUBMIT_EVIDENCE':
      return ['pending', 'rejected', 'needs_more'].includes(m.status) ? 'evidence_submitted' : null;
    case 'VERDICT':
      if (m.status !== 'evidence_submitted') return null;
      return e.status === 'approved' ? 'approved' : e.status === 'rejected' ? 'rejected' : 'needs_more';
    case 'RELEASE':
      return m.status === 'approved' ? 'released' : null;
    case 'OPEN_DISPUTE':
      return ['evidence_submitted', 'approved', 'rejected', 'needs_more', 'released'].includes(m.status)
        ? 'disputed'
        : null;
    case 'RESOLVE':
      if (m.status !== 'disputed') return null;
      return e.outcome === 'release' ? 'released' : e.outcome === 'partial' ? 'partially_released' : 'refunded';
  }
}

const milestoneOf = (ctx: PactMachineContext, e: PactEvent): MilestoneState | undefined =>
  'milestoneId' in e ? ctx.milestones[e.milestoneId] : undefined;

const canMilestone = ({ context, event }: { context: PactMachineContext; event: PactEvent }) => {
  const m = milestoneOf(context, event);
  return !!m && nextMilestoneStatus(m, event as MilestoneEvent) !== null;
};

export const allTerminal = (ctx: PactMachineContext) =>
  ctx.order.every((id) => TERMINAL_MILESTONE.includes(ctx.milestones[id].status));
const anyDisputed = (ctx: PactMachineContext) => ctx.order.some((id) => ctx.milestones[id].status === 'disputed');

export const pactMachine = setup({
  types: {
    context: {} as PactMachineContext,
    events: {} as PactEvent,
    input: {} as { milestoneIds: string[] },
  },
  guards: {
    canMilestone,
    sellerAccepted: ({ context }) => context.sellerAccepted,
    allTerminal: ({ context }) => allTerminal(context),
    anyDisputed: ({ context }) => anyDisputed(context),
    noneDisputed: ({ context }) => !anyDisputed(context),
    disputeOnReleased: ({ context, event }) =>
      event.type === 'OPEN_DISPUTE' && context.milestones[event.milestoneId]?.status === 'released',
  },
  actions: {
    applyMilestone: assign(({ context, event }) => {
      const id = (event as MilestoneEvent).milestoneId;
      const m = context.milestones[id];
      const status = nextMilestoneStatus(m, event as MilestoneEvent)!;
      return {
        milestones: {
          ...context.milestones,
          [id]: {
            status,
            attempts: m.attempts + (event.type === 'SUBMIT_EVIDENCE' ? 1 : 0),
            wasReleased: m.wasReleased || status === 'released',
          },
        },
      };
    }),
    voidOpen: assign(({ context }) => ({
      milestones: Object.fromEntries(
        context.order.map((id) => {
          const m = context.milestones[id];
          return [id, TERMINAL_MILESTONE.includes(m.status) ? m : { ...m, status: 'voided' as const }];
        }),
      ),
    })),
    accept: assign({ sellerAccepted: true }),
  },
}).createMachine({
  id: 'pact',
  initial: 'draft',
  context: ({ input }) => ({
    order: input.milestoneIds,
    milestones: Object.fromEntries(
      input.milestoneIds.map((id) => [id, { status: 'pending' as const, attempts: 0, wasReleased: false }]),
    ),
    sellerAccepted: false,
  }),
  states: {
    draft: { on: { PROPOSE: 'proposed', CANCEL: { target: 'cancelled', actions: 'voidOpen' } } },
    proposed: {
      on: {
        ACCEPT: { actions: 'accept' },
        FUNDED: { target: 'funded', guard: 'sellerAccepted' },
        CANCEL: { target: 'cancelled', actions: 'voidOpen' },
      },
    },
    funded: {
      on: {
        START: 'in_progress',
        SUBMIT_EVIDENCE: { target: 'in_progress', guard: 'canMilestone', actions: 'applyMilestone' },
        CANCEL: { target: 'cancelled', actions: 'voidOpen' },
        EXPIRE: { target: 'expired', actions: 'voidOpen' },
      },
    },
    in_progress: {
      always: { target: 'completed', guard: 'allTerminal' },
      on: {
        SUBMIT_EVIDENCE: { guard: 'canMilestone', actions: 'applyMilestone' },
        VERDICT: { guard: 'canMilestone', actions: 'applyMilestone' },
        RELEASE: { guard: 'canMilestone', actions: 'applyMilestone', target: 'in_progress', reenter: true },
        OPEN_DISPUTE: { guard: 'canMilestone', actions: 'applyMilestone', target: 'disputed' },
        CANCEL: { target: 'cancelled', actions: 'voidOpen' },
        EXPIRE: { target: 'expired', actions: 'voidOpen' },
      },
    },
    disputed: {
      always: { target: 'in_progress', guard: 'noneDisputed' },
      on: {
        SUBMIT_EVIDENCE: { guard: 'canMilestone', actions: 'applyMilestone' },
        VERDICT: { guard: 'canMilestone', actions: 'applyMilestone' },
        RELEASE: { guard: 'canMilestone', actions: 'applyMilestone' },
        OPEN_DISPUTE: { guard: 'canMilestone', actions: 'applyMilestone' },
        RESOLVE: { guard: 'canMilestone', actions: 'applyMilestone', target: 'disputed', reenter: true },
      },
    },
    completed: {
      on: {
        // A buyer may still dispute a released milestone (refund path) until the pact is closed.
        OPEN_DISPUTE: { guard: 'disputeOnReleased', actions: 'applyMilestone', target: 'disputed' },
        CLOSE: 'closed',
      },
    },
    closed: { type: 'final' },
    cancelled: { type: 'final' },
    expired: { type: 'final' },
  },
});

export type PactSnapshot = SnapshotFrom<typeof pactMachine>;

export interface PersistedPactState {
  status: PactStatus;
  context: PactMachineContext;
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: PersistedPactState,
    public readonly event: PactEvent,
    detail?: string,
  ) {
    const m = 'milestoneId' in event ? ` (milestone ${event.milestoneId}: ${from.context.milestones[event.milestoneId]?.status ?? 'unknown'})` : '';
    super(`Invalid transition: ${event.type} is not allowed in pact state "${from.status}"${m}${detail ? `: ${detail}` : ''}`);
    this.name = 'InvalidTransitionError';
  }
}

export function initialPactState(milestoneIds: string[]): PersistedPactState {
  return { status: 'draft', context: buildContext(milestoneIds) };
}

function buildContext(milestoneIds: string[]): PactMachineContext {
  return {
    order: milestoneIds,
    milestones: Object.fromEntries(milestoneIds.map((id) => [id, { status: 'pending' as const, attempts: 0, wasReleased: false }])),
    sellerAccepted: false,
  };
}

export const restore = (s: PersistedPactState): PactSnapshot =>
  pactMachine.resolveState({ value: s.status, context: s.context });

export function canApply(s: PersistedPactState, event: PactEvent): boolean {
  return restore(s).can(event);
}

/** Pure transition. Throws InvalidTransitionError if the machine would not handle the event. */
export function applyPactEvent(s: PersistedPactState, event: PactEvent): PersistedPactState {
  const snap = restore(s);
  if (!snap.can(event)) {
    if (event.type === 'FUNDED' && !s.context.sellerAccepted) throw new InvalidTransitionError(s, event, 'the seller has not accepted');
    throw new InvalidTransitionError(s, event);
  }
  const [next] = transition(pactMachine, snap, event);
  return { status: next.value as PactStatus, context: next.context };
}
