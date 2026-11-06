// npm run seed — fills the database with a few weeks of SEEDED history so the Control Tower and the
// reputation leaderboard have something to show. Honest labelling:
//   - every seeded pact uses the SIMULATED PayPal adapter (paymentMode "simulated")
//   - every seeded verdict has model "seed-fixture (not an AI call)"
//   - evidence is small generated text files, never the demo photos (so the demo's
//     "evidence reused in another pact" pre-check is not triggered)
// Usage: npm run seed [-- --reset]   (--reset deletes data/pact.db first)
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { z } from 'zod';
import type { Contract } from '@pact/core';
import { databasePath, getConfig, openDb, repoRoot } from '@pact/db';
import { LlmClient, type StructuredRequest, type StructuredResult } from '@pact/llm';
import { SimulatedGateway } from '@pact/paypal';
import { createContext } from '../apps/api/src/context';
import { PactService } from '../apps/api/src/services/pacts';

if (process.argv.includes('--reset')) {
  const p = databasePath();
  for (const f of [p, `${p}-wal`, `${p}-shm`, resolve(repoRoot, 'data', 'simulated-paypal.json')]) if (existsSync(f)) rmSync(f);
  console.log('Database reset.');
}

const SEED_MODEL = 'seed-fixture (not an AI call)';

/** Answers every role from the queue: these are fixtures, not model outputs. */
class SeedAnswers extends LlmClient {
  queue: unknown[] = [];
  constructor() {
    super({ mode: 'replay', apiKey: '', baseUrl: 'x', model: SEED_MODEL, reasoningEffort: 'low', cacheDir: resolve(repoRoot, 'data', 'seed-unused-cache') });
  }
  async structured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    const value = req.role === 'verifier.describe' ? { summary: 'Seed evidence (text file).', objects: [], visibleText: [], dates: [], quality: { legible: true, issues: [] } } : this.queue.shift();
    const usage = { role: req.role, model: SEED_MODEL, mode: 'replay' as const, cacheHit: true, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0, latencyMs: 0 };
    return { value: req.schema.parse(value), usage, model: SEED_MODEL, mode: 'replay', cacheKey: 'seed' };
  }
}

const approved = (ids: string[]) => ({ status: 'approved', confidence: 0.9, criteria: ids.map((criterionId) => ({ criterionId, passed: true, confidence: 0.9, reasoning: 'Seed fixture.' })), reasoning: 'Seeded approval (fixture).', missing: [] });
const rejected = { status: 'rejected', confidence: 0.92, criteria: [{ criterionId: 'c1', passed: false, confidence: 0.92, reasoning: 'Seed fixture.' }], reasoning: 'Seeded rejection (fixture): evidence did not match the criteria.', missing: [] };

const day = 24 * 3600 * 1000;
// Spread the history over the past ~7 weeks; every timestamp stays in the past.
let clock = Date.now() - 50 * day;
const sim = new SimulatedGateway({ now: () => new Date(clock), statePath: resolve(repoRoot, 'data', 'simulated-paypal.json') });
const llm = new SeedAnswers();
const ctx = createContext({ db: openDb(), gateway: sim, simulated: sim, llm, now: () => new Date(clock), config: { ...getConfig() } });
const pacts = new PactService(ctx);

const contract = (title: string, total: number, deadline: string, split: number[], sellerName: string, buyerName: string): Contract => ({
  title,
  description: `${title} (seeded history).`,
  buyer: { name: buyerName, email: null },
  seller: { name: sellerName, email: null },
  currency: 'USD',
  totalAmount: total,
  deadline,
  milestones: split.map((percent, i) => ({
    id: `m${i + 1}`,
    title: i === split.length - 1 ? 'Delivery' : `Stage ${i + 1}`,
    percent,
    criteria: [{ id: 'c1', text: i === split.length - 1 ? 'Delivery confirmed' : 'Stage completed as described' }],
    evidenceTypes: ['document', 'tracking'],
    deadline: null,
  })),
  subcontractors: [],
  disputePolicy: { windowHours: 72, resolution: 'ai_arbiter_with_human_appeal', notes: null },
});

type Plan = { seller: string; buyer: string; title: string; total: number; split: number[]; outcomes: ('ok' | 'reject_then_ok' | 'dispute_refund' | 'dispute_partial' | 'late')[]; cancel?: boolean };

const plans: Plan[] = [
  { seller: 'Kofi Textiles', buyer: 'Cafe Lumiere', title: '30 linen aprons', total: 360, split: [40, 60], outcomes: ['ok', 'ok'] },
  { seller: 'Kofi Textiles', buyer: 'Ada (buyer agent)', title: '12 embroidered napkins', total: 96, split: [100], outcomes: ['ok'] },
  { seller: 'Atlas Code Studio', buyer: 'Ada (buyer agent)', title: 'Inventory script + tests', total: 800, split: [30, 70], outcomes: ['ok', 'reject_then_ok'] },
  { seller: 'Nia Crafts', buyer: 'Bea (buyer)', title: '40 plain notebooks', total: 240, split: [50, 50], outcomes: ['ok', 'dispute_partial'] },
  { seller: 'Lumen Prints', buyer: 'Cafe Lumiere', title: '200 menu cards', total: 180, split: [100], outcomes: ['dispute_refund'] },
  { seller: 'Kofi Textiles', buyer: 'Bea (buyer)', title: '25 tote bags', total: 275, split: [30, 70], outcomes: ['ok', 'ok'] },
  { seller: 'Atlas Code Studio', buyer: 'Cafe Lumiere', title: 'Booking widget', total: 1200, split: [20, 30, 50], outcomes: ['ok', 'ok', 'late'], cancel: true },
  { seller: 'Lumen Prints', buyer: 'Bea (buyer)', title: '50 posters', total: 150, split: [100], outcomes: ['reject_then_ok'], cancel: false },
  { seller: 'Nia Crafts', buyer: 'Ada (buyer agent)', title: '10 ceramic bowls', total: 220, split: [100], outcomes: ['ok'] },
  { seller: 'Lumen Prints', buyer: 'Ada (buyer agent)', title: '300 flyers', total: 90, split: [50, 50], outcomes: ['ok'], cancel: true },
];

let n = 0;
const note = (pactId: string, mid: string) => Buffer.from(`Seed delivery note #${++n} for ${pactId}/${mid}\nGenerated fixture, not a real document.\n`);

for (const plan of plans) {
  clock = Math.min(clock + 3 * day, Date.now() - 2 * day);
  const deadline = new Date(clock + 6 * day).toISOString().slice(0, 10);
  const p = pacts.create({ contract: contract(plan.title, plan.total, deadline, plan.split, plan.seller, plan.buyer), sourceText: null, buyer: { name: plan.buyer }, seller: { name: plan.seller }, actor: 'seed' });
  pacts.propose(p.id, 'seed');
  pacts.accept(p.id, 'seed');
  await pacts.fund(p.id, 'seed');
  pacts.approveSimulated(p.id, 'seed');
  await pacts.confirmFunding(p.id, 'seed');
  for (const [i, outcome] of plan.outcomes.entries()) {
    const mid = `m${i + 1}`;
    clock += (outcome === 'late' ? 8 : 0.6) * day;
    if (outcome === 'reject_then_ok') {
      await pacts.submitEvidence(p.id, mid, { filename: 'note.md', bytes: note(p.id, mid), type: 'document' }, 'seed');
      llm.queue.push(rejected);
      await pacts.verifyMilestone(p.id, mid, 'seed');
      clock += 0.4 * day;
    }
    await pacts.submitEvidence(p.id, mid, { filename: 'note.md', bytes: note(p.id, mid), type: 'document' }, 'seed');
    if (outcome === 'dispute_refund' || outcome === 'dispute_partial') {
      llm.queue.push(rejected);
      await pacts.verifyMilestone(p.id, mid, 'seed');
      pacts.openDispute(p.id, mid, 'seller', 'Seeded dispute statement.', 'seed');
      llm.queue.push(
        outcome === 'dispute_refund'
          ? { decision: 'refund', releasePercent: 0, reasoning: 'Seeded arbiter decision (fixture).', citedEvidence: [], confidence: 0.85 }
          : { decision: 'partial', releasePercent: 60, reasoning: 'Seeded arbiter decision (fixture).', citedEvidence: [], confidence: 0.8 },
      );
      await pacts.arbitrate(p.id, mid, 'seed');
    } else {
      llm.queue.push(approved(['c1']));
      await pacts.verifyMilestone(p.id, mid, 'seed');
    }
    // A pre-check rejection (e.g. late evidence) consumes no fixture answer: drop leftovers.
    llm.queue.length = 0;
  }
  if (plan.cancel) await pacts.cancel(p.id, 'seed', 'Buyer cancelled (seeded)');
  const v = pacts.view(p.id);
  console.log(`seeded ${v.status.padEnd(10)} ${plan.title.padEnd(26)} ${plan.seller}`);
}
console.log(`\nSeeded ${plans.length} pacts (SIMULATED payments, fixture verdicts). Start the app with npm run dev.`);
