// Reputation per party, computed from PACT's own ledger (see docs/REPUTATION.md for the formula).
import { computeReputation, TERMINAL_MILESTONE, type MilestoneStatus, type ReputationInputs, type ReputationView } from '@pact/core';
import { asc, eq, tables } from '@pact/db';
import type { AppContext } from '../context';
import { partyView } from './views';

const TERMINAL_PACT = ['completed', 'closed', 'cancelled', 'expired'];

export function reputationInputs(ctx: AppContext, partyId: string): ReputationInputs {
  const pacts = ctx.db.select().from(tables.pacts).all().filter((p) => p.sellerId === partyId || p.buyerId === partyId);
  const asSeller = pacts.filter((p) => p.sellerId === partyId);
  const ids = new Set(asSeller.map((p) => p.id));
  const ms = ctx.db.select().from(tables.milestones).all().filter((m) => ids.has(m.pactId));
  const terminalMs = ms.filter((m) => TERMINAL_MILESTONE.includes(m.status as MilestoneStatus) && m.status !== 'voided');
  const disputes = ctx.db.select().from(tables.disputes).all().filter((d) => ids.has(d.pactId));
  // Buyers are rated on completion and on disputes they opened that went against them.
  const terminalPacts = (asSeller.length ? asSeller : pacts).filter((p) => TERMINAL_PACT.includes(p.status));
  return {
    pactsTotal: terminalPacts.length,
    pactsCompleted: terminalPacts.filter((p) => p.status === 'completed' || p.status === 'closed').length,
    milestonesTotal: terminalMs.length,
    milestonesOnTime: terminalMs.filter((m) => m.releasedAt && m.releasedAt.slice(0, 10) <= m.deadline).length,
    disputesTotal: disputes.length,
    refundsTotal: terminalMs.filter((m) => m.status === 'refunded' || m.status === 'partially_released').length,
  };
}

export function getReputation(ctx: AppContext, partyId: string): ReputationView {
  const party = ctx.db.select().from(tables.parties).where(eq(tables.parties.id, partyId)).get();
  if (!party) throw new Error(`Party ${partyId} not found`);
  const history = ctx.db
    .select()
    .from(tables.reputationSnapshots)
    .where(eq(tables.reputationSnapshots.partyId, partyId))
    .orderBy(asc(tables.reputationSnapshots.at))
    .all()
    .map((s) => ({ date: s.at, score: s.score }));
  return { ...computeReputation(reputationInputs(ctx, partyId)), party: partyView(party), history };
}

export function snapshotReputation(ctx: AppContext, partyId: string) {
  const r = computeReputation(reputationInputs(ctx, partyId));
  ctx.db
    .insert(tables.reputationSnapshots)
    .values({ partyId, at: ctx.now().toISOString(), score: r.score })
    .onConflictDoNothing()
    .run();
  return r;
}

export function leaderboard(ctx: AppContext): ReputationView[] {
  return ctx.db
    .select()
    .from(tables.parties)
    .all()
    .map((p) => getReputation(ctx, p.id))
    .sort((a, b) => b.score - a.score);
}
